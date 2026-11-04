// The range rises with the song (docs/landscape-rise.md). Everything drawn
// above the eye starts pressed down toward the horizon and stands back up
// as the music plays, to the complete range before the finale.
//
// Why above the eye, and why toward it. A view's terrain package ships only
// the tiles some camera can see at full height (tools/lib/terrain-bake.mjs):
// lowering the near ranges toward the valley floor would uncover land that
// was never shipped, and the sky would show through it. The map here moves
// every point straight down, never below the eye's height, by an amount
// that is concave and increasing in height: anything hidden from the eye at
// full height stays hidden at every stage of the rise (for a point Q on the
// segment eye-P, f(Q) >= the segment eye-f(P) by monotonicity and
// concavity, with f(eye) = eye). The lake, the valley and the mist below
// the eye never move, so the mirror plane, the clip plane and the shore
// stay exact. Seen from the eye it is a vertical squash of the frame above
// the horizon line, with real 3D light on the lowered slopes.
//
// The map, for a point h metres above the eye at horizontal distance r:
//   h' = s*h + (1 - s)*w*r*(1 - exp(-h / (w*r)))
// s is the rise (LAND_RISE_START .. 1). w is the knee: below an elevation of
// about atan(w) the ground keeps its full height, so the lowered flanks
// meet the unlowered ground with no crease along the horizon. h' is
// homogeneous in (r, h), so rays from the eye map to rays: the squash is the
// same at every distance. It rises in h and in r, so the lowest drawn point
// of a box is its bottom at its nearest horizontal distance (risenFloor).
import { clamp01 } from '../../utils/math.js';

/** Relief share above the eye at the song's first beat. Never quite flat
 *  (the painted orogeny's precedent, OrogenyDirector BASELINE_GROWTH). */
export const LAND_RISE_START = 0.1;
/** Tangent of the knee's elevation above the horizon (0.6 degrees, about
 *  12 px of a 720 px frame at the views' 35-40 degree field of view). */
export const LAND_RISE_KNEE = Math.tan(0.6 * Math.PI / 180);
/** Pace in silence, against 1 + energy at full energy: the land keeps
 *  rising through quiet passages and climbs fastest through loud ones. */
export const LAND_RISE_QUIET_PACE = 0.6;
/** Share of the climb spent easing to a stop on the complete range. */
export const LAND_RISE_LANDING = 0.15;
/** The rise completes no earlier than this share of the music. */
export const LAND_RISE_MIN_END = 0.6;
const STEP_MS = 250;

/** GLSL twin of landRiseLift and its Jacobian. Needs DEFORM_GLSL's
 *  uTourEye (xyz: the drawing camera's eye; the lake mirror keeps the main
 *  eye, so the reflection shows the same lowered land). uLandRise is the
 *  sink, 1 - s: zero (every stand-in, preview and dev page) is the
 *  complete range at no cost. */
export const LAND_RISE_GLSL = /* glsl */`
  uniform float uLandRise;
  float riseLift(vec3 p) {
    if (uLandRise <= 0.0) return 0.0;
    float h = p.y - uTourEye.y;
    if (h <= 0.0) return 0.0;
    float wr = ${LAND_RISE_KNEE.toFixed(7)} * max(1.0, length(p.xz - uTourEye.xz));
    return -uLandRise * (h - wr * (1.0 - exp(-h / wr)));
  }
  // Gradient of riseLift at p (x, z across, y up).
  vec3 riseGrad(vec3 p) {
    if (uLandRise <= 0.0) return vec3(0.0);
    float h = p.y - uTourEye.y;
    if (h <= 0.0) return vec3(0.0);
    vec2 d = p.xz - uTourEye.xz;
    float r = max(1.0, length(d));
    float wr = ${LAND_RISE_KNEE.toFixed(7)} * r;
    float t = h / wr, e = exp(-t);
    float dr = length(d) >= 1.0 ? uLandRise * ${LAND_RISE_KNEE.toFixed(7)} * (1.0 - e * (1.0 + t)) / r : 0.0;
    return vec3(dr * d.x, -uLandRise * (1.0 - e), dr * d.y);
  }
  // A normal carried through the rise (inverse transpose of its Jacobian).
  // 1 + g.y is at least the rise itself, never zero.
  vec3 risenNormal(vec3 n, vec3 p) {
    vec3 g = riseGrad(p);
    float invY = 1.0 / (1.0 + g.y);
    return normalize(vec3(n.x - g.x * n.y * invY, n.y * invY, n.z - g.z * n.y * invY));
  }
  // The baked horizon (TerrainOcclusion) holds full-height elevations.
  // Lowering the land by the local stretch k lowers their tangents by k,
  // which is the light's tangent raised by 1/k.
  vec3 stretchedLight(vec3 L, float k) {
    return k < 1.0 ? normalize(vec3(L.x, L.y / max(k, 1e-3), L.z)) : L;
  }
  vec3 risenLight(vec3 L, vec3 p) { return stretchedLight(L, 1.0 + riseGrad(p).y); }
`;

/** CPU twin of riseLift: metres added to a point's height (<= 0) for the
 *  eye `eye` ([x, y, z]) and sink `sink` (1 - rise01). */
export function landRiseLift(x, y, z, eye, sink, knee = LAND_RISE_KNEE) {
  if (!(sink > 0) || !eye) return 0;
  return riseLiftAt(y - eye[1], Math.hypot(x - eye[0], z - eye[2]), sink, knee);
}

function riseLiftAt(h, r, sink, knee) {
  if (!(h > 0)) return 0;
  const wr = knee * Math.max(1, r);
  return -sink * (h - wr * (1 - Math.exp(-h / wr)));
}

/** Drawn height of a point at height `y` and horizontal distance `r` from
 *  the eye, for a rise state from riseFromUniforms. */
export function risenHeight(y, r, rise) {
  if (!rise || !(rise.sink > 0)) return y;
  return y + riseLiftAt(y - rise.eye[1], r, rise.sink, rise.knee ?? LAND_RISE_KNEE);
}

/** Lowest drawn height a box can reach under the rise, from its bottom `y`
 *  and its xz extent [x0, z0]-[x1, z1]: the drawn height rises with both
 *  height and horizontal distance, so the bottom at the nearest point. */
export function risenFloor(y, x0, z0, x1, z1, rise) {
  if (!rise || !(rise.sink > 0)) return y;
  const [ex, , ez] = rise.eye;
  const dx = Math.max(x0 - ex, 0, ex - x1), dz = Math.max(z0 - ez, 0, ez - z1);
  return risenHeight(y, Math.hypot(dx, dz), rise);
}

/** The rise state the shaders read from `uniforms` (uLandRise, uTourEye),
 *  or null when the land stands complete. */
export function riseFromUniforms(u) {
  const sink = u?.uLandRise?.value;
  const eye = u?.uTourEye?.value;
  if (!(sink > 0) || !eye) return null;
  return { sink, eye: [eye.x, eye.y, eye.z], knee: LAND_RISE_KNEE };
}

const landing = (u) => {
  const L = LAND_RISE_LANDING, a = 1 / (1 - L / 2), x = clamp01(u);
  return x <= 1 - L ? a * x : 1 - a * (1 - x) ** 2 / (2 * L);
};

/**
 * The song's rise, a pure function of heard time. Progress is the music's
 * energy integrated from the first beat (LAND_RISE_QUIET_PACE + energy per
 * unit time) and normalised to reach 1 at endMs: `finaleMs` before the
 * cadence (the camera's closing move), no earlier than LAND_RISE_MIN_END of
 * it. The land eases onto the complete range over the last
 * LAND_RISE_LANDING of the climb.
 *
 * `previous` (an earlier compile's riseProgressAt, with freezeThroughMs) is
 * the handoff when a whole-song analysis replaces the opening one: from the
 * frozen moment the new climb continues from where the old one stood, so
 * the land never jumps or sinks.
 */
export function compileLandRise({ read = () => 0, durationMs = 0, cadenceMs = durationMs, finaleMs = 0,
  previous = null, freezeThroughMs = -1 } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  if (!(duration > 0)) return Object.freeze({ endMs: 0, progressAt: () => 1, at: () => 1 });
  const cadence = Number.isFinite(cadenceMs) && cadenceMs > 0 ? Math.min(duration, cadenceMs) : duration;
  const endMs = Math.max(LAND_RISE_MIN_END * cadence, Math.min(cadence, cadence - Math.max(0, finaleMs)));
  const n = Math.max(1, Math.ceil(endMs / STEP_MS));
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + LAND_RISE_QUIET_PACE + clamp01(read((i + 0.5) * endMs / n));
  const own = (timeMs) => {
    const x = clamp01((Number(timeMs) || 0) / endMs) * n, i = Math.min(n - 1, Math.floor(x));
    return (sum[i] + (sum[i + 1] - sum[i]) * (x - i)) / sum[n];
  };
  let progressAt = own;
  if (typeof previous === 'function' && freezeThroughMs >= 0) {
    const from = clamp01(previous(freezeThroughMs)), base = own(freezeThroughMs);
    progressAt = (timeMs) => {
      if (timeMs <= freezeThroughMs) return clamp01(previous(timeMs));
      if (base >= 1 || from >= 1) return 1;
      return clamp01(from + (1 - from) * (own(timeMs) - base) / (1 - base));
    };
  }
  const at = (timeMs) => LAND_RISE_START + (1 - LAND_RISE_START) * landing(progressAt(timeMs));
  return Object.freeze({ endMs, progressAt, at });
}
