// Range v2 valley atmosphere (plan §2 "Light, atmosphere", Task 13): mist
// that collects between landforms. Shared by the terrain and forest shaders
// (MIST_GLSL) with an exact JS twin (mistAmount) for tests and CPU queries.
//
// Model. An exponential height layer anchored at the view's valley floor
// (its hydro-flattened water level): density(y) = d0 * exp(-(y - base) / H),
// masked by a 2D noise so it lies in irregular banks rather than a uniform
// sheet or oval stamps. Each of the noise's three octaves drifts on its own
// heading and speed, with a slow sway, so banks thin, merge and re-form as
// they go instead of sliding past as one rigid sheet. The optical depth is integrated along
// the ray from the camera to the shaded point, so a nearer ridge stops the
// ray before the mist behind it: closer objects occlude farther mist by
// construction. Drift is a pure function of heard time (pause holds it,
// seek reconstructs it). Distant atmospheric perspective stays separate
// (the shaders' air term, applied after the mist).
//
// Cloud sea. In quiet passages (CloudSea.js) the layer fills toward a flat
// top between the valley floor and the eye: below the top the density is
// even and the banks close up, so the valley floods with cloud and the
// peaks stand above it. Its colour is read where the view ray meets the
// top, so billows lie on that plane in perspective.

export const MIST_SAMPLES = 6;
export const MIST_NOISE_M = 900;
/** Per-octave drift (m), largest banks first: [vx, vz] m/s of steady wind,
 *  then a sway of [ax, az] m with periods [px, pz] s and phases. Different
 *  headings per octave make the banks change shape while they move. */
export const MIST_DRIFT = Object.freeze([
  Object.freeze({ v: [1.3, 0.6], a: [160, 120], p: [97, 71], ph: [0, 1.1] }),
  Object.freeze({ v: [2.2, -0.5], a: [110, 140], p: [53, 61], ph: [0.4, 2.3] }),
  Object.freeze({ v: [0.4, 2.1], a: [70, 60], p: [37, 29], ph: [1.7, 0.6] }),
]);
/** Cloud sea: density (1/m) when full, its top as a fraction of the way
 *  from the valley floor to the eye, the soft edge of that top (m), and
 *  the size of the billows on it (m). */
export const SEA_DENSITY = 1.5e-3;
export const SEA_TOP_FROM = 0.04;
export const SEA_TOP_TO = 0.65;
export const SEA_TOP_SOFT_BELOW_M = 60;
export const SEA_TOP_SOFT_ABOVE_M = 30;
export const SEA_BILLOW_M = 520;

const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Lattice hash: integer mixing, bit-identical to the GLSL twin. The former
// fract(sin(dot)) hash lost precision at world-scale lattice coordinates and
// lined its values up along diagonals, which the bank threshold drew as
// straight seams across the valley.
function hash21(x, y) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 8) / 16777216;
}
/** Each octave's lattice is turned by its own angle (radians), so no two
 *  share grid lines and none lines up with the terrain's tile axes. */
export const MIST_OCTAVE_ROTATION = Object.freeze([0.35, 0.8, 1.22]);
const ROT = MIST_OCTAVE_ROTATION.map(a => [Math.cos(a), Math.sin(a)]);
const rot = (k, x, y) => [ROT[k][0] * x - ROT[k][1] * y, ROT[k][1] * x + ROT[k][0] * y];
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy), b = hash21(ix + 1, iy), c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** Each octave's drift offset (m) at heard time t: [[x, z] x 3]. The
 *  shaders receive these as uMistDrift, so both sides read one value. */
export function mistDrift(tSec) {
  const t = Number.isFinite(tSec) ? tSec : 0;
  return MIST_DRIFT.map(({ v, a, p, ph }) => [
    v[0] * t + a[0] * Math.sin(t / p[0] + ph[0]),
    v[1] * t + a[1] * Math.sin(t / p[1] + ph[1]),
  ]);
}

/** What an unresolved octave contributes: slightly above the noise's mean
 *  0.5, so the thresholded banks keep their area-average coverage (~0.4)
 *  when distant samples average them out, instead of thinning far haze. */
export const MIST_OCTAVE_MEAN = 0.522;
/** How much of an octave of size `cellM` a sample spaced `spacingM` along
 *  its ray can resolve: banks finer than the spacing fall between samples,
 *  so they are averaged out (MIST_OCTAVE_MEAN) instead of read at random. */
export function octaveDetail(spacingM, cellM) {
  return 1 - smoothstep(0.5, 2.0, spacingM / cellM);
}
function maskAt(x, z, d, spacingM = 0) {
  const M = MIST_NOISE_M;
  const o = (k, scale, ox, oz) => {
    const f = octaveDetail(spacingM, M / scale);
    return f > 0 ? mix(MIST_OCTAVE_MEAN, vnoise(...rot(k, (x + d[k][0]) / M * scale + ox, (z + d[k][1]) / M * scale + oz)), f) : MIST_OCTAVE_MEAN;
  };
  const n = 0.55 * o(0, 1, 0, 0) + 0.3 * o(1, 2.03, 17.1, -5.3) + 0.15 * o(2, 4.1, -3.7, 9.2);
  const t = Math.min(1, Math.max(0, (n - 0.35) / 0.4));
  return t * t * (3 - 2 * t);
}

/** Mist mask (0..1) at world (x, z) and heard time t. */
export function mistMask(x, z, tSec) {
  return maskAt(x, z, mistDrift(tSec));
}

// Antiderivatives (in height) of the two layer profiles, so the layer's
// mean along a straight ray is exact: exp above the valley floor (1 below),
// and the cloud sea's slab, linear across its soft top.
function expLayerInt(y, base, H) { return y <= base ? y : base + H * (1 - Math.exp(-(y - base) / H)); }
function slabInt(y, top) {
  const lo = top - SEA_TOP_SOFT_BELOW_M, hi = top + SEA_TOP_SOFT_ABOVE_M, w = hi - lo;
  if (y <= lo) return y;
  if (y >= hi) return lo + w / 2;
  return lo + (hi * (y - lo) - (y * y - lo * lo) / 2) / w;
}
/** Mean of the layer density (0..1) along heights y0 -> y1. */
export function meanLayer(y0, y1, { baseM, heightM, topM = 1e9, fill = 0 }) {
  const dy = y1 - y0;
  const exp = Math.abs(dy) < 1e-3 ? Math.exp(-Math.max(0, (y0 + y1) / 2 - baseM) / heightM)
    : (expLayerInt(y1, baseM, heightM) - expLayerInt(y0, baseM, heightM)) / dy;
  if (!(fill > 0)) return exp;
  const ym = (y0 + y1) / 2;
  const slab = Math.abs(dy) < 1e-3 ? Math.min(1, Math.max(0, (topM + SEA_TOP_SOFT_ABOVE_M - ym) / (SEA_TOP_SOFT_BELOW_M + SEA_TOP_SOFT_ABOVE_M)))
    : (slabInt(y1, topM) - slabInt(y0, topM)) / dy;
  return mix(exp, slab, fill);
}

/**
 * Mist opacity (0..1) between the camera `cam` and point `p` ([x, y, z] m).
 * The layer is integrated exactly along the ray; the samples only estimate
 * the banks' mean along it, weighted by where the layer is thick. So the
 * haze is a smooth function of the ray (no slices or steps), and fewer
 * samples (the quality ladder) change only the banks' detail.
 * params: { density (1/m at the base; 0 = off), baseM, heightM, tSec }.
 */
export function mistAmount(cam, p, { density = 0, baseM = 0, heightM = 220, tSec = 0, steps = MIST_SAMPLES, topM = 1e9, fill = 0 } = {}) {
  if (!(density > 0)) return 0;
  // A fractional count (the ladder easing between rungs) blends the two
  // neighbouring estimates, so a rung change fades instead of popping.
  const nf = Math.max(1, Math.min(MIST_SAMPLES, Number.isFinite(steps) ? steps : MIST_SAMPLES));
  const n0 = Math.floor(nf), fr = nf - n0;
  const drift = mistDrift(tSec);
  let banks = mistBanks(cam, p, n0, drift, baseM, heightM, topM, fill);
  if (fr > 1e-3) banks = mix(banks, mistBanks(cam, p, n0 + 1, drift, baseM, heightM, topM, fill), fr);
  const L = Math.hypot(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]);
  const od = density * L * meanLayer(cam[1], p[1], { baseM, heightM, topM, fill }) * banks;
  return 1 - Math.exp(-od);
}

/** How far under the cloud sea's top a point at height `y` sits (0..1),
 *  times how full the sea is: the slab profile the layer itself uses. */
export function seaSubmersion(y, { topM = 1e9, fill = 0 } = {}) {
  if (!(fill > 0)) return 0;
  return fill * (1 - smoothstep(topM - SEA_TOP_SOFT_BELOW_M, topM + SEA_TOP_SOFT_ABOVE_M, y));
}

/** How completely an emitter under the cloud sea's top drops out of sight
 *  (0 = it follows the ground under it exactly). At 1 a lantern sunk under
 *  a full sea is gone, while the ground beside it can keep a trace through
 *  the thin near cloud: the lanterns are what the eye looks for. */
export const EMITTER_SUBMERGE = 1;

/**
 * How much of a light at its true position `p` the camera `cam` sees
 * through the valley mist and the cloud sea (0..1): the same mist the
 * terrain under it receives (narrative atmosphere applied again, as the
 * terrain applies it), and EMITTER_SUBMERGE of the sea above it. `m` is the
 * mist as uploaded ({ density, baseM, heightM, tSec, steps, topM, fill,
 * atm }); without one the air is clear.
 */
export function emitterVisibility(cam, p, m) {
  if (!m) return 1;
  const mist = mistAmount(cam, p, m) * (m.atm ?? 1);
  return Math.max(0, (1 - mist) * (1 - EMITTER_SUBMERGE * seaSubmersion(p[1], m)));
}

/** Share of a lantern's light (its pool and its glints) the cloud sea
 *  leaves when the lantern stands at height `sourceY` on the drawn ground:
 *  as much as of the lantern itself, so a sunk lantern lights nothing, above
 *  the top or below it. The JS twin of ACTOR_GLSL's actorShown. */
export function actorLightShown(sourceY, m) {
  return 1 - EMITTER_SUBMERGE * seaSubmersion(sourceY, m || undefined);
}

/** The banks' mean along the ray from `n` samples, weighted by the layer. */
function mistBanks(cam, p, n, drift, baseM, heightM, topM, fill) {
  const dx = p[0] - cam[0], dy = p[1] - cam[1], dz = p[2] - cam[2];
  // Ground distance between samples (they crowd toward the point; the
  // mean spacing is what decides which banks they can resolve).
  const spacing = Math.hypot(dx, dz) / n;
  let wm = 0, ws = 0, mm = 0;
  for (let i = 0; i < n; i++) {
    // Samples crowd toward the shaded point, where rays meet the valley air.
    const s = (i + 0.5) / n;
    const t = 1 - (1 - s) * (1 - s);
    const w = 2 * (1 - s);
    const y = cam[1] + dy * t;
    const x = cam[0] + dx * t, z = cam[2] + dz * t;
    const layer = mix(Math.exp(-Math.max(0, y - baseM) / heightM), 1 - smoothstep(topM - SEA_TOP_SOFT_BELOW_M, topM + SEA_TOP_SOFT_ABOVE_M, y), fill);
    let mask = maskAt(x, z, drift, spacing);
    if (fill > 0) mask = mix(mask, 0.6 + 0.4 * maskAt(x * 0.5, z * 0.5, drift, spacing * 0.5), fill);
    wm += w * layer * mask; ws += w * layer; mm += mask;
  }
  // Where the layer is thin everywhere on the ray, weights vanish: the
  // banks' plain mean then stands in (its contribution is tiny anyway).
  return ws > 1e-6 ? wm / ws : mm / n;
}

/**
 * Per-view mist parameters from the material rules and frame state.
 * `sea01` is how full the cloud sea is (CloudSea.js); its top rises from
 * just above the valley floor (SEA_TOP_FROM) to SEA_TOP_TO of the way to
 * the eye at `cameraY`, so it wells up out of the valley rather than
 * appearing as a sheet at mid-height, and the camera always looks down on
 * it. Its density blends from the valley mist's toward SEA_DENSITY on the
 * same curve, with no step where the sea takes over.
 */
export function mistParams({ rules = {}, waterLevelM = null, heightRange = [0, 1000], tSec = 0, calm01 = 0, sea01 = 0, cameraY = null } = {}) {
  const wet = Math.max(0, Math.min(1, rules.wetness ?? 0.5));
  const base = Number.isFinite(waterLevelM) ? waterLevelM : heightRange[0] + 0.08 * (heightRange[1] - heightRange[0]);
  const sea = Number.isFinite(cameraY) && cameraY > base ? Math.max(0, Math.min(1, sea01)) : 0;
  // Wet ranges hold valley mist; calm passages let it settle thicker.
  const density = 3.2e-4 * wet * (0.8 + 0.4 * Math.max(0, Math.min(1, calm01)));
  return {
    density: mix(density, Math.max(density, SEA_DENSITY), sea),
    baseM: base,
    heightM: 160 + 160 * wet,
    tSec,
    topM: sea > 0 ? base + (cameraY - base) * (SEA_TOP_FROM + (SEA_TOP_TO - SEA_TOP_FROM) * sea) : 1e9,
    fill: sea,
  };
}

const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
/** The atmosphere with no music: today's mist and shafts exactly. */
export const ATMOSPHERE_NEUTRAL = Object.freeze({ mistDensityMul: 1, mistGlow: 0, shaftGain: 1 });
const ATMOSPHERE_SCRATCH = { mistDensityMul: 1, mistGlow: 0, shaftGain: 1 };
/** The score's hold on the valley air, from the heard effects frame: the
 *  music's energy thins the mist a little and lights it from within, and
 *  lifts the sun's shafts; a section lift adds to both and bass adds weight.
 *  The air leans on the slow channels (energy and bass are trailing
 *  averages); `lift` has a 100 ms attack, so its weight stays small enough
 *  that a section boundary swells the whole valley rather than popping it
 *  (at most about .02 of mist density per 33 ms frame). Pure in the frozen
 *  effects frame, so
 *  seek, pause, display and capture agree. Null or silent music returns the
 *  frozen ATMOSPHERE_NEUTRAL; otherwise one reused object (no per-frame
 *  allocation), valid until the next call. */
export function atmosphereMusic(effects) {
  if (!effects) return ATMOSPHERE_NEUTRAL;
  const lift = unit(effects.lift), bass = unit(effects.bass), energy = unit(effects.energy);
  if (lift < .001 && bass < .001 && energy < .001) return ATMOSPHERE_NEUTRAL;
  ATMOSPHERE_SCRATCH.mistDensityMul = Math.max(.75, 1 - .12 * energy - .06 * lift - .05 * bass);
  ATMOSPHERE_SCRATCH.mistGlow = .02 * lift + .04 * energy;
  ATMOSPHERE_SCRATCH.shaftGain = Math.min(1.4, 1 + .25 * energy + .15 * lift + .1 * bass);
  return ATMOSPHERE_SCRATCH;
}

/** Forward scatter of the key light in mist (Henyey-Greenstein, g = .6),
 *  normalised so isotropic scatter is 0 and looking straight into the
 *  light (cosTheta = 1) is 1; never negative. GLSL twin: MIST_GLSL
 *  mistPhase. cosTheta = dot(view ray from the eye, direction to light). */
export const MIST_SCATTER_G = .6;
export function mistForwardScatter(cosTheta, g = MIST_SCATTER_G) {
  if (!Number.isFinite(cosTheta) || !Number.isFinite(g) || !(g > 0 && g < 1)) return 0;
  const c = Math.max(-1, Math.min(1, cosTheta));
  const hg = (1 - g * g) / (1 + g * g - 2 * g * c) ** 1.5, peak = (1 + g) / ((1 - g) * (1 - g));
  return Math.min(1, Math.max(0, (hg - 1) / (peak - 1)));
}

export const MIST_GLSL = /* glsl */`
  uniform float uMistDensity;
  uniform float uMistSteps; // 1..MIST_SAMPLES: the quality ladder's fog sampling
  uniform float uMistBase;
  uniform float uMistHeight;
  uniform float uMistTime;
  uniform vec2 uMistDrift[3]; // mistDrift(heard time): each octave's offset (m)
  uniform vec3 uMistColor;
  uniform float uMistTop;  // the cloud sea's top (m); far above when none
  uniform float uMistFill; // 0..1 how full the cloud sea is
  float mistHash(vec2 p) {
    ivec2 c = ivec2(p);
    uint h = (uint(c.x) * 0x27d4eb2du) ^ (uint(c.y) * 0x165667b1u);
    h = (h ^ (h >> 15u)) * 0x85ebca6bu;
    h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
    return float((h ^ (h >> 16u)) >> 8u) / 16777216.0;
  }
  const mat2 MIST_ROT0 = mat2(${ROT[0][0].toFixed(6)}, ${ROT[0][1].toFixed(6)}, ${(-ROT[0][1]).toFixed(6)}, ${ROT[0][0].toFixed(6)});
  const mat2 MIST_ROT1 = mat2(${ROT[1][0].toFixed(6)}, ${ROT[1][1].toFixed(6)}, ${(-ROT[1][1]).toFixed(6)}, ${ROT[1][0].toFixed(6)});
  const mat2 MIST_ROT2 = mat2(${ROT[2][0].toFixed(6)}, ${ROT[2][1].toFixed(6)}, ${(-ROT[2][1]).toFixed(6)}, ${ROT[2][0].toFixed(6)});
  float mistVnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = mistHash(i), b = mistHash(i + vec2(1.0, 0.0)), c = mistHash(i + vec2(0.0, 1.0)), d = mistHash(i + vec2(1.0, 1.0));
    return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  }
  // Banks finer than the samples' spacing are averaged out (see octaveDetail).
  float mistOctave(float spacing, float scale) { return 1.0 - smoothstep(0.5, 2.0, spacing * scale / ${MIST_NOISE_M.toFixed(1)}); }
  float mistMaskAt(vec2 xz, float spacing) {
    float f0 = mistOctave(spacing, 1.0), f1 = mistOctave(spacing, 2.03), f2 = mistOctave(spacing, 4.1);
    float n = 0.55 * (f0 > 0.0 ? mix(${MIST_OCTAVE_MEAN}, mistVnoise(MIST_ROT0 * ((xz + uMistDrift[0]) / ${MIST_NOISE_M.toFixed(1)})), f0) : ${MIST_OCTAVE_MEAN})
      + 0.3 * (f1 > 0.0 ? mix(${MIST_OCTAVE_MEAN}, mistVnoise(MIST_ROT1 * ((xz + uMistDrift[1]) / ${MIST_NOISE_M.toFixed(1)} * 2.03 + vec2(17.1, -5.3))), f1) : ${MIST_OCTAVE_MEAN})
      + 0.15 * (f2 > 0.0 ? mix(${MIST_OCTAVE_MEAN}, mistVnoise(MIST_ROT2 * ((xz + uMistDrift[2]) / ${MIST_NOISE_M.toFixed(1)} * 4.1 + vec2(-3.7, 9.2))), f2) : ${MIST_OCTAVE_MEAN});
    return smoothstep(0.35, 0.75, n);
  }
  float mistMask(vec2 xz) { return mistMaskAt(xz, 0.0); }
  // Forward scatter toward the light (mistForwardScatter): 0 isotropic,
  // 1 looking into it. The light direction is an argument, not a uniform.
  float mistPhase(vec3 view, vec3 lightDir) {
    float c = clamp(dot(view, lightDir), -1.0, 1.0);
    float g = ${MIST_SCATTER_G.toFixed(2)};
    float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
    float peak = (1.0 + g) / ((1.0 - g) * (1.0 - g));
    return clamp((hg - 1.0) / (peak - 1.0), 0.0, 1.0);
  }
  float mistExpInt(float y) { return y <= uMistBase ? y : uMistBase + uMistHeight * (1.0 - exp(-(y - uMistBase) / uMistHeight)); }
  float mistSlabInt(float y) {
    float lo = uMistTop - ${SEA_TOP_SOFT_BELOW_M.toFixed(1)}, hi = uMistTop + ${SEA_TOP_SOFT_ABOVE_M.toFixed(1)}, w = hi - lo;
    if (y <= lo) return y;
    if (y >= hi) return lo + w * 0.5;
    return lo + (hi * (y - lo) - (y * y - lo * lo) * 0.5) / w;
  }
  // Exact mean of the layer between heights y0 and y1 (see meanLayer).
  float mistMeanLayer(float y0, float y1) {
    float dy = y1 - y0;
    float ym = (y0 + y1) * 0.5;
    bool level = abs(dy) < 1e-3;
    float e = level ? exp(-max(0.0, ym - uMistBase) / uMistHeight) : (mistExpInt(y1) - mistExpInt(y0)) / dy;
    if (uMistFill <= 0.0) return e;
    float slab = level ? clamp((uMistTop + ${SEA_TOP_SOFT_ABOVE_M.toFixed(1)} - ym) / ${(SEA_TOP_SOFT_BELOW_M + SEA_TOP_SOFT_ABOVE_M).toFixed(1)}, 0.0, 1.0)
      : (mistSlabInt(y1) - mistSlabInt(y0)) / dy;
    return mix(e, slab, uMistFill);
  }
  float mistBanks(vec3 cam, vec3 d, float n) {
    float wm = 0.0, ws = 0.0, mm = 0.0;
    float spacing = length(d.xz) / n;
    for (int i = 0; i < ${MIST_SAMPLES}; i++) {
      if (float(i) >= n) break;
      float s = (float(i) + 0.5) / n;
      float t = 1.0 - (1.0 - s) * (1.0 - s);
      float w = 2.0 * (1.0 - s);
      vec3 q = cam + d * t;
      float layer = mix(exp(-max(0.0, q.y - uMistBase) / uMistHeight),
        1.0 - smoothstep(uMistTop - ${SEA_TOP_SOFT_BELOW_M.toFixed(1)}, uMistTop + ${SEA_TOP_SOFT_ABOVE_M.toFixed(1)}, q.y), uMistFill);
      // The cloud sea's wider banks cost a second mask; only pay for it
      // while the sea is up.
      float mask = mistMaskAt(q.xz, spacing);
      if (uMistFill > 0.0) mask = mix(mask, 0.6 + 0.4 * mistMaskAt(q.xz * 0.5, spacing * 0.5), uMistFill);
      wm += w * layer * mask; ws += w * layer; mm += mask;
    }
    return ws > 1e-6 ? wm / ws : mm / n;
  }
  float mistAmount(vec3 cam, vec3 p) {
    if (uMistDensity <= 0.0) return 0.0;
    vec3 d = p - cam;
    // A fractional count (the ladder easing between rungs) blends the two
    // neighbouring estimates; the second pass runs only while easing.
    float nf = clamp(uMistSteps, 1.0, ${MIST_SAMPLES.toFixed(1)});
    float n0 = floor(nf), fr = nf - n0;
    float banks = mistBanks(cam, d, n0);
    if (fr > 1e-3) banks = mix(banks, mistBanks(cam, d, n0 + 1.0), fr);
    float od = uMistDensity * length(d) * mistMeanLayer(cam.y, p.y) * banks;
    return 1.0 - exp(-od);
  }
  // How far under the cloud sea's top height y sits (0..1, before fill);
  // see seaSubmersion. Callers skip it while the sea is empty.
  float mistSubmersion(float y) {
    return 1.0 - smoothstep(uMistTop - ${SEA_TOP_SOFT_BELOW_M.toFixed(1)}, uMistTop + ${SEA_TOP_SOFT_ABOVE_M.toFixed(1)}, y);
  }
  // The mist's colour: under a cloud sea, read where the view ray meets its
  // top, with brighter crowns and shaded troughs.
  vec3 mistColorAt(vec3 cam, vec3 p) {
    // A point above the top is seen without crossing it: plain haze.
    if (uMistFill <= 0.0 || cam.y <= uMistTop || p.y >= uMistTop) return uMistColor;
    vec3 hit = cam + (p - cam) * clamp((cam.y - uMistTop) / (cam.y - p.y), 0.0, 1.0);
    // The billows ride the mist's own octave drifts, so they roll and
    // reshape rather than scroll as one sheet.
    float b = 0.55 * mistVnoise((hit.xz + 1.8 * uMistDrift[0]) / ${SEA_BILLOW_M.toFixed(1)})
      + 0.3 * mistVnoise((hit.xz + 1.8 * uMistDrift[1]) / ${SEA_BILLOW_M.toFixed(1)} * 2.3 + vec2(5.1, 1.7))
      + 0.15 * mistVnoise((hit.xz + 1.8 * uMistDrift[2]) / ${SEA_BILLOW_M.toFixed(1)} * 5.1 + vec2(-2.3, 8.4));
    return uMistColor * mix(1.0, 0.5 + 0.9 * b * b, uMistFill);
  }
`;

/** GLSL twin of emitterVisibility for lights placed per vertex (the cast's
 *  site lights and threads). Needs MIST_GLSL, uCameraPos and uNarrative. */
export const EMITTER_GLSL = /* glsl */`
  float emitterSeen(vec3 p) {
    float sub = uMistFill > 0.0 ? uMistFill * mistSubmersion(p.y) : 0.0;
    return max(0.0, (1.0 - mistAmount(uCameraPos, p) * uNarrative.y) * (1.0 - ${EMITTER_SUBMERGE.toFixed(3)} * sub));
  }
`;

/** Seconds the fog's sample count takes to ease across one rung change. */
export const MIST_STEP_EASE_SEC = 1.5;
/** Ease the fog's sample count toward a rung's `target` over heard time.
 *  A held frame (pause) keeps its value; a seek or first frame snaps. */
export function easeMistSteps(current, target, dtSec) {
  if (Number.isFinite(current) && dtSec === 0) return current; // paused: hold
  if (!Number.isFinite(current) || !(dtSec > 0 && dtSec <= 0.5)) return target;
  const step = (MIST_SAMPLES - 1) * dtSec / MIST_STEP_EASE_SEC;
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** Tour fog ceiling clearance: below LO metres of layer the fog is gone,
 *  above HI it is whole, smoothly between (was a hard cut at 40 m). */
export const TOUR_MIST_FADE_LO_M = 40, TOUR_MIST_FADE_HI_M = 160;
export function tourMistFade(topM, baseM) {
  return smoothstep(TOUR_MIST_FADE_LO_M, TOUR_MIST_FADE_HI_M, topM - baseM);
}

/** Tour fog ceiling at heard time `tMs`: 120 m under the lowest eye height
 *  over a window around now (2 s back, 6 s ahead). A sliding window keeps
 *  the ceiling continuous in time; the fixed 8 s tour windows it used to
 *  follow stepped it at every window change. */
export function tourMistCap(poseAt, tMs, durationMs, { backMs = 2000, aheadMs = 6000, stepMs = 500 } = {}) {
  let low = Infinity;
  const from = Math.max(0, tMs - backMs), to = Math.min(durationMs, tMs + aheadMs);
  // Sample on a grid fixed to the timeline plus the window's own ends, so
  // the minimum moves smoothly as the ends slide.
  for (let t = Math.ceil(from / stepMs) * stepMs; t <= to; t += stepMs) low = Math.min(low, poseAt(t).eyeM[1]);
  low = Math.min(low, poseAt(from).eyeM[1], poseAt(to).eyeM[1]);
  return low - 120;
}

/** Local light from an emitter on the rock stage: intensity bounded, and
 *  softened (not removed) with height. */
export function emitterStrength({ airbornePx = 0 } = {}) {
  const lift = Math.min(1, Math.max(0, airbornePx / 160));
  return 0.22 * (1 - 0.6 * lift);
}
