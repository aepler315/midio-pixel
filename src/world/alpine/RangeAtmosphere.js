// Valley atmosphere shared by the terrain, forest and cast. Ordinary haze
// retains its exact exponential height integral. Quiet passages form shallow
// drifting banks on the real drainage field: they spread from low sources
// upstream instead of raising a camera-relative water plane. Heard time alone
// controls motion, so pause and seek reconstruct the same air.
import { sampleMistFlow } from './MistFlow.js';

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
/** Kept as the legacy density reference; banks amplify the ordinary density
 * locally rather than increasing the whole valley's atmospheric density. */
export const SEA_DENSITY = 1.5e-3;
export const MIST_BANK_GAIN = 7.5;
export const MIST_BANK_HEIGHT_MIN_M = 78;
export const MIST_BANK_HEIGHT_MAX_M = 135;
export const MIST_FLOW_SPEED_MPS = 18;
export const MIST_BANK_SPACING_M = 820;
export const MIST_EMITTER_PATH_M = 7000;

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

// Exact integral of ordinary haze; terrain-relative banks use the same
// bounded ray samples as its existing spatial mask.
function expLayerInt(y, base, H) { return y <= base ? y : base + H * (1 - Math.exp(-(y - base) / H)); }
export function meanLayer(y0, y1, { baseM, heightM }) {
  const dy = y1 - y0;
  return Math.abs(dy) < 1e-3 ? Math.exp(-Math.max(0, (y0 + y1) / 2 - baseM) / heightM)
    : (expLayerInt(y1, baseM, heightM) - expLayerInt(y0, baseM, heightM)) / dy;
}

/** Phase moves toward increasing drainage distance: along the valley uphill. */
export function mistBankPulse(upstreamM, tSec = 0) {
  return .5 + .5 * Math.sin((upstreamM - MIST_FLOW_SPEED_MPS * tSec) / MIST_BANK_SPACING_M * Math.PI * 2);
}

function flowAt(x, z, m, mask) {
  const field = m.flow;
  const f = field ? sampleMistFlow(field, x, z) : {
    groundM: m.baseM ?? 0, valley01: .72, upstreamM: (.12 + .42 * (1 - mask)) * MIST_BANK_SPACING_M, valid01: 1,
  };
  const sink = unit(m.riseSink), base = m.riseBaseM ?? 0;
  return { ...f, groundM: field ? f.groundM - sink * (f.groundM - base) : f.groundM, distanceM: field?.distanceM || MIST_BANK_SPACING_M };
}

function smoothIntegral(lo, hi, x) {
  if (x <= lo) return 0;
  if (x >= hi) return x - (lo + hi) * .5;
  const t = (x - lo) / (hi - lo);
  return (hi - lo) * (t * t * t - .5 * t * t * t * t);
}
function bankHeightMean(y0, y1, ground, top) {
  const h0 = y0 - ground, h1 = y1 - ground;
  if (Math.abs(h1 - h0) < 1e-3) return smoothstep(-48, -12, (h0 + h1) * .5) * (1 - smoothstep(top * .38, top, (h0 + h1) * .5));
  const integral = h => {
    const bounded = Math.min(top, Math.max(-48, h));
    return smoothIntegral(-48, -12, bounded) - smoothIntegral(top * .38, top, bounded);
  };
  return Math.max(0, Math.min(1, (integral(h1) - integral(h0)) / (h1 - h0)));
}
function localBank(p, m, mask, f, y0 = p[1], y1 = p[1]) {
  const fill = unit(m.fill);
  if (!(fill > 0) || !(f.valid01 > 0)) return 0;
  const valley = smoothstep(.18, .7, f.valley01);
  const front = fill * 1.24 - .12;
  const arrival = 1 - smoothstep(front - .12, front + .12, f.upstreamM / Math.max(1, f.distanceM));
  const formation = fill * smoothstep(0, .18, fill) * arrival;
  const pulse = mistBankPulse(f.upstreamM, m.tSec ?? 0);
  const top = MIST_BANK_HEIGHT_MIN_M + (MIST_BANK_HEIGHT_MAX_M - MIST_BANK_HEIGHT_MIN_M) * (.55 * mask + .45 * pulse);
  // The support foot sits below encoded ground so byte precision cannot
  // punch holes in the visible floor. Integrating each segment's height
  // profile also keeps the shallow bank visible at low ray sample counts.
  const height = bankHeightMean(y0, y1, f.groundM, top);
  return f.valid01 * valley * formation * height * (.14 + .86 * mask) * (.68 + .32 * pulse);
}

/** Local formed-bank occupancy at a true world point [x,y,z]. The same
 * value dims a lantern and its pool/glints. No global floor blackout. */
export function mistLocalOccupancy(p, m = {}) {
  if (!(m.fill > 0) || !(m.density > 0)) return 0;
  const q = typeof p === 'number' ? [0, p, 0] : p;
  const mask = maskAt(q[0], q[2], mistDrift(m.tSec ?? 0));
  return localBank(q, m, mask, flowAt(q[0], q[2], m, mask)) * (1 - Math.exp(-m.density * MIST_EMITTER_PATH_M));
}

/** Mist opacity along the view ray. Integer runtime quality endpoints
 * evaluate one spatial mask and one packed field fetch per existing sample. */
export function mistAmount(cam, p, m = {}) {
  const { density = 0, baseM = 0, heightM = 220, tSec = 0, steps = MIST_SAMPLES } = m;
  if (!(density > 0)) return 0;
  const nf = Math.max(1, Math.min(MIST_SAMPLES, Number.isFinite(steps) ? steps : MIST_SAMPLES));
  const n0 = Math.floor(nf), fr = nf - n0, drift = mistDrift(tSec);
  const layer = meanLayer(cam[1], p[1], { baseM, heightM });
  let banks = mistBanks(cam, p, n0, drift, { ...m, baseM, heightM }, layer);
  if (fr > 1e-3) banks = mix(banks, mistBanks(cam, p, n0 + 1, drift, { ...m, baseM, heightM }, layer), fr);
  const L = Math.hypot(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]);
  return 1 - Math.exp(-density * L * banks);
}

/** Legacy name for local bank occupancy; callers now pass the full point. */
export function seaSubmersion(p, m) { return mistLocalOccupancy(p, m); }
export const EMITTER_SUBMERGE = .88;
export function emitterVisibility(cam, p, m) {
  if (!m) return 1;
  const mist = mistAmount(cam, p, m) * (m.atm ?? 1);
  return Math.max(0, (1 - mist) * actorLightShown(p, m));
}
export function actorLightShown(p, m) { return 1 - EMITTER_SUBMERGE * seaSubmersion(p, m || undefined); }

function mistBanks(cam, p, n, drift, m, mean) {
  const dx = p[0] - cam[0], dy = p[1] - cam[1], dz = p[2] - cam[2];
  const spacing = Math.hypot(dx, dz) / n;
  let wm = 0, ws = 0, mm = 0, banks = 0, weights = 0;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const s = (i + .5) / n, t = 1 - (1 - s) * (1 - s), w = 2 * (1 - s);
    const q = [cam[0] + dx * t, cam[1] + dy * t, cam[2] + dz * t];
    const layer = Math.exp(-Math.max(0, q[1] - m.baseM) / m.heightM);
    const mask = maskAt(q[0], q[2], drift, spacing);
    if (m.fill > 0) samples.push({ q, t, w, mask, f: flowAt(q[0], q[2], m, mask) });
    wm += w * layer * mask; ws += w * layer; mm += mask; weights += w;
  }
  // Recover the local floor slope from the same cached field taps. A ray
  // following an uphill floor then stays at its real clearance rather than
  // crossing a new horizontal layer at every quadrature sample.
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    let before = samples[Math.max(0, i - 1)], after = samples[Math.min(n - 1, i + 1)];
    if (!(before.f.valid01 > 0)) before = a;
    if (!(after.f.valid01 > 0)) after = a;
    const slope = after.t > before.t ? (after.f.groundM - before.f.groundM) / (after.t - before.t) : 0;
    const lo = i / n, hi = (i + 1) / n;
    const t0 = 1 - (1 - lo) * (1 - lo), t1 = 1 - (1 - hi) * (1 - hi);
    const y0 = cam[1] + dy * t0 - a.f.groundM - slope * (t0 - a.t);
    const y1 = cam[1] + dy * t1 - a.f.groundM - slope * (t1 - a.t);
    banks += a.w * localBank(a.q, m, a.mask, { ...a.f, groundM: 0 }, y0, y1);
  }
  return mean * (ws > 1e-6 ? wm / ws : mm / n) + MIST_BANK_GAIN * banks / weights;
}

/** Formation follows the quiet-passage envelope independently of the camera.
 * The source height and drainage field stay fixed while it moves. */
export function mistParams({ rules = {}, waterLevelM = null, heightRange = [0, 1000], tSec = 0, calm01 = 0, sea01 = 0,
  flow = null, riseSink = 0, riseBaseM = 0 } = {}) {
  const wet = Math.max(0, Math.min(1, rules.wetness ?? .5));
  const base = Number.isFinite(waterLevelM) ? waterLevelM : heightRange[0] + .08 * (heightRange[1] - heightRange[0]);
  return {
    density: 3.2e-4 * wet * (.8 + .4 * unit(calm01)),
    baseM: base - unit(riseSink) * (base - riseBaseM), heightM: 160 + 160 * wet, tSec, fill: unit(sea01), flow, riseSink: unit(riseSink), riseBaseM,
  };
}

const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
/** The atmosphere with no music: today's mist and shafts exactly. */
export const ATMOSPHERE_NEUTRAL = Object.freeze({ mistDensityMul: 1, mistGlow: 0, shaftGain: 1, keyLightGain: 1 });
const ATMOSPHERE_SCRATCH = { ...ATMOSPHERE_NEUTRAL };
/** The score's hold on the valley air, from the heard effects frame: the
 *  gathered phrase energy opens the valley and raises its light; a sustained
 *  climax reveals distant layers. These multi-second controls keep a louder
 *  passage visibly different without making mist pump on every drum. Legacy
 *  callers without them retain the restrained pressure response. Pure in the
 *  frozen effects frame, so
 *  seek, pause, display and capture agree. Null or silent music returns the
 *  frozen ATMOSPHERE_NEUTRAL; otherwise one reused object (no per-frame
 *  allocation), valid until the next call. */
export function atmosphereMusic(effects) {
  if (!effects) return ATMOSPHERE_NEUTRAL;
  const lift = unit(effects.lift), bass = unit(effects.bass), energy = unit(effects.energy);
  const directed = Number.isFinite(effects.atmosphere);
  const atmosphere = directed ? unit(effects.atmosphere) : 0, expansion = unit(effects.expansion);
  if (Math.max(lift, bass, energy, atmosphere, expansion) < .001) return ATMOSPHERE_NEUTRAL;
  ATMOSPHERE_SCRATCH.mistDensityMul = directed ? Math.max(.46, 1 - .38 * atmosphere - .16 * expansion)
    : Math.max(.75, 1 - .12 * energy - .06 * lift - .05 * bass);
  ATMOSPHERE_SCRATCH.mistGlow = directed ? .1 * atmosphere + .04 * expansion : .02 * lift + .04 * energy;
  ATMOSPHERE_SCRATCH.shaftGain = directed ? 1 + .65 * atmosphere + .35 * expansion
    : Math.min(1.4, 1 + .25 * energy + .15 * lift + .1 * bass);
  ATMOSPHERE_SCRATCH.keyLightGain = 1 + .16 * atmosphere + .12 * expansion;
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
  uniform vec4 uMistLayer; // base (m), height (m), heard time (s), formation
  #define uMistBase uMistLayer.x
  #define uMistHeight uMistLayer.y
  #define uMistTime uMistLayer.z
  #define uMistFill uMistLayer.w
  uniform vec2 uMistDrift[3]; // mistDrift(heard time): each octave's offset (m)
  uniform vec3 uMistColor;
  uniform sampler2D uMistFlow; // ground, valley affinity, upstream distance, validity
  uniform vec2 uMistFlowHeight; // minimum and span (m)
  uniform float uMistFlowDistanceM;
  uniform float uMistFlowOn;
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
  float mistMeanLayer(float y0, float y1) {
    float dy = y1 - y0;
    return abs(dy) < 1e-3 ? exp(-max(0.0, (y0 + y1) * 0.5 - uMistBase) / uMistHeight)
      : (mistExpInt(y1) - mistExpInt(y0)) / dy;
  }
  // One filtered RGBA8 tap, matching sampleMistFlow's texel-centre mapping.
  // DEFORM_GLSL supplies the shared grid bounds and song-rise parameters.
  vec4 mistFlowAt(vec2 xz, float mask) {
    vec4 f;
    if (uMistFlowOn > 0.5) {
      vec2 uv = (xz - uGridOrigin) / uGridExtent;
      vec2 size = vec2(textureSize(uMistFlow, 0));
      f = texture(uMistFlow, clamp(uv, 0.0, 1.0) * (size - 1.0) / size + 0.5 / size);
      f.r = uMistFlowHeight.x + f.r * uMistFlowHeight.y;
      f.r -= uLandRise.x * (f.r - uLandRise.y);
      f.a *= step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    } else {
      f = vec4(uMistBase, 0.72, 0.12 + 0.42 * (1.0 - mask), 1.0);
    }
    return f;
  }
  float mistBankPulse(float upstreamM) {
    return 0.5 + 0.5 * sin((upstreamM - ${MIST_FLOW_SPEED_MPS.toFixed(1)} * uMistTime) / ${MIST_BANK_SPACING_M.toFixed(1)} * 6.28318530718);
  }
  float mistSmoothInt(float lo, float hi, float x) {
    if (x <= lo) return 0.0;
    if (x >= hi) return x - (lo + hi) * 0.5;
    float t = (x - lo) / (hi - lo);
    return (hi - lo) * (t * t * t - 0.5 * t * t * t * t);
  }
  float mistHeightInt(float h, float top) {
    float bounded = clamp(h, -48.0, top);
    return mistSmoothInt(-48.0, -12.0, bounded) - mistSmoothInt(top * 0.38, top, bounded);
  }
  float mistHeightMean(vec2 ys, float ground, float top) {
    vec2 h = ys - ground;
    if (abs(h.y - h.x) < 1e-3) {
      float above = (h.x + h.y) * 0.5;
      return smoothstep(-48.0, -12.0, above) * (1.0 - smoothstep(top * 0.38, top, above));
    }
    return clamp((mistHeightInt(h.y, top) - mistHeightInt(h.x, top)) / (h.y - h.x), 0.0, 1.0);
  }
  float mistLocalBank(float mask, vec4 f, vec2 ys) {
    float front = uMistFill * 1.24 - 0.12;
    float arrival = 1.0 - smoothstep(front - 0.12, front + 0.12, f.b);
    float formation = uMistFill * smoothstep(0.0, 0.18, uMistFill) * arrival;
    float distanceM = uMistFlowOn > 0.5 ? max(1.0, uMistFlowDistanceM) : ${MIST_BANK_SPACING_M.toFixed(1)};
    float pulse = mistBankPulse(f.b * distanceM);
    float top = ${MIST_BANK_HEIGHT_MIN_M.toFixed(1)} + ${(MIST_BANK_HEIGHT_MAX_M - MIST_BANK_HEIGHT_MIN_M).toFixed(1)} * (0.55 * mask + 0.45 * pulse);
    float height = mistHeightMean(ys, f.r, top);
    return f.a * smoothstep(0.18, 0.7, f.g) * formation * height * (0.14 + 0.86 * mask) * (0.68 + 0.32 * pulse);
  }
  float mistBanks(vec3 cam, vec3 d, float n) {
    float wm = 0.0, ws = 0.0, mm = 0.0, banks = 0.0, weights = 0.0;
    float spacing = length(d.xz) / n;
    vec4 flows[${MIST_SAMPLES}];
    float masks[${MIST_SAMPLES}], times[${MIST_SAMPLES}];
    for (int i = 0; i < ${MIST_SAMPLES}; i++) {
      if (float(i) >= n) break;
      float s = (float(i) + 0.5) / n;
      float t = 1.0 - (1.0 - s) * (1.0 - s);
      float w = 2.0 * (1.0 - s);
      vec3 q = cam + d * t;
      float layer = exp(-max(0.0, q.y - uMistBase) / uMistHeight);
      float mask = mistMaskAt(q.xz, spacing);
      if (uMistFill > 0.0) {
        flows[i] = mistFlowAt(q.xz, mask);
        masks[i] = mask; times[i] = t;
      }
      wm += w * layer * mask; ws += w * layer; mm += mask; weights += w;
    }
    // Arithmetic only: reuse the same bounded mask/field taps to follow the
    // sampled ground slope at each ray segment, including steep valley floors.
    if (uMistFill > 0.0) for (int i = 0; i < ${MIST_SAMPLES}; i++) {
      if (float(i) >= n) break;
      int before = max(0, i - 1), after = min(int(n) - 1, i + 1);
      if (flows[before].a <= 0.0) before = i;
      if (flows[after].a <= 0.0) after = i;
      float span = times[after] - times[before];
      float slope = span > 0.0 ? (flows[after].r - flows[before].r) / span : 0.0;
      vec2 edges = vec2(float(i), float(i + 1)) / n;
      vec2 t = 1.0 - (1.0 - edges) * (1.0 - edges);
      vec2 ground = flows[i].r + slope * (t - times[i]);
      vec2 ys = cam.y + d.y * t - ground;
      vec4 f = flows[i]; f.r = 0.0;
      float w = 2.0 * (1.0 - (float(i) + 0.5) / n);
      banks += w * mistLocalBank(masks[i], f, ys);
    }
    return mistMeanLayer(cam.y, cam.y + d.y) * (ws > 1e-6 ? wm / ws : mm / n) + ${MIST_BANK_GAIN.toFixed(1)} * banks / weights;
  }
  float mistAmount(vec3 cam, vec3 p) {
    if (uMistDensity <= 0.0) return 0.0;
    vec3 d = p - cam;
    float nf = clamp(uMistSteps, 1.0, ${MIST_SAMPLES.toFixed(1)});
    float n0 = floor(nf), fr = nf - n0;
    float banks = mistBanks(cam, d, n0);
    if (fr > 1e-3) banks = mix(banks, mistBanks(cam, d, n0 + 1.0), fr);
    float od = uMistDensity * length(d) * banks;
    return 1.0 - exp(-od);
  }
  float mistSubmersion(vec3 p) {
    if (uMistFill <= 0.0 || uMistDensity <= 0.0) return 0.0;
    float mask = mistMaskAt(p.xz, 0.0);
    return mistLocalBank(mask, mistFlowAt(p.xz, mask), vec2(p.y)) * (1.0 - exp(-uMistDensity * ${MIST_EMITTER_PATH_M.toFixed(1)}));
  }
  // Bank shading is volumetric: never project a colour onto a global top.
  vec3 mistColorAt(vec3 cam, vec3 p) { return uMistColor; }

`;

/** GLSL twin of emitterVisibility for lights placed per vertex (the cast's
 *  site lights and threads). Needs MIST_GLSL, uCameraPos and uNarrative. */
export const EMITTER_GLSL = /* glsl */`
  float emitterSeen(vec3 p) {
    float sub = mistSubmersion(p);
    return max(0.0, (1.0 - mistAmount(uCameraPos, p) * uNarrative.y) * (1.0 - ${EMITTER_SUBMERGE.toFixed(3)} * sub));
  }
`;

/** Change sampling only at integer endpoints on an advancing heard frame.
 *  Fractional counts integrate both neighbouring banks. Even on recovery
 *  that temporary cost can reject a rung whose settled cost fits easily.
 *  A held frame (pause) keeps its value; a seek or first frame snaps. */
export function easeMistSteps(current, target, dtSec) {
  if (Number.isFinite(current) && dtSec === 0) return current; // paused: hold
  return target;
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
