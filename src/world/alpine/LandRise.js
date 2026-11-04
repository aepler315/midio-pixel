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
// stay exact. (Water above the eye is lowered with its land, by an amount
// that varies with distance, but a surface above the eye is only ever seen
// from below, behind its own shore, and the occlusion argument keeps it
// there.) Seen from the eye it is a vertical squash of the frame above the
// horizon line, with real 3D light on the lowered slopes.
//
// The frame's bottom. A camera pitched up at a summit may not show the
// horizon at all: squashed toward the horizon, its land would leave
// through the bottom of the frame and the shot would hold only sky. So the
// squash pivots at the lowest elevation the frame shows when that is above
// the horizon (risePivot): land at the frame's bottom edge stays there and
// the range is pressed down onto it. Any increasing remap of elevation
// keeps the occlusion argument (rays map to rays, in order along each).
//
// The frame's top. The squash also brings down land that stood above the
// top of the frame, and a package does not ship tiles outside every baked
// frustum. A rail never has land above its frame (every station of every
// view, docs/landscape-rise.md): by continuity, land rising above the top
// would cross it inside a shipped tile first. Shot tours do fly under
// ridges; checked against real elevation, every pixel they can bring down
// lands on a shipped tile (docs/landscape-rise.md, "Coverage").
//
// The map, for a point h metres above the pivot cone (P*r above the eye,
// P the pivot's tangent, 0 when the frame shows the horizon) at horizontal
// distance r:
//   h' = s*h + (1 - s)*w*r*(1 - exp(-h / (w*r)))
// s is the rise (LAND_RISE_START .. 1). w is the knee: below an elevation of
// about atan(w) above the pivot the ground keeps its full height, so the
// lowered flanks meet the unlowered ground with no crease. h' is
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
/** A re-analysis never finishes what is left of the climb faster than
 *  over this long, even when its own climb is (nearly) over already. */
export const LAND_RISE_CATCH_UP_MS = 8000;
const STEP_MS = 250;

/** GLSL twin of landRiseLift and its Jacobian. Needs DEFORM_GLSL's
 *  uTourEye (xyz: the drawing camera's eye; the lake mirror keeps the main
 *  eye, so the reflection shows the same lowered land). uLandRise.x is the
 *  sink, 1 - s: zero (every stand-in, preview and dev page) is the
 *  complete range at no cost. uLandRise.y is the pivot (risePivot). */
export const LAND_RISE_GLSL = /* glsl */`
  uniform vec2 uLandRise;
  float riseLift(vec3 p) {
    if (uLandRise.x <= 0.0) return 0.0;
    float r = max(1.0, length(p.xz - uTourEye.xz));
    float h = p.y - uTourEye.y - uLandRise.y * r;
    if (h <= 0.0) return 0.0;
    float wr = ${LAND_RISE_KNEE.toFixed(7)} * r;
    return -uLandRise.x * (h - wr * (1.0 - exp(-h / wr)));
  }
  // Gradient of riseLift at p (x, z across, y up).
  vec3 riseGrad(vec3 p) {
    if (uLandRise.x <= 0.0) return vec3(0.0);
    vec2 d = p.xz - uTourEye.xz;
    float r = max(1.0, length(d));
    float h = p.y - uTourEye.y - uLandRise.y * r;
    if (h <= 0.0) return vec3(0.0);
    float wr = ${LAND_RISE_KNEE.toFixed(7)} * r;
    float t = h / wr, e = exp(-t);
    float dr = length(d) >= 1.0
      ? uLandRise.x * (${LAND_RISE_KNEE.toFixed(7)} * (1.0 - e * (1.0 + t)) + uLandRise.y * (1.0 - e)) / r : 0.0;
    return vec3(dr * d.x, -uLandRise.x * (1.0 - e), dr * d.y);
  }
  // A normal carried through the rise (inverse transpose of its Jacobian,
  // from the gradient g = riseGrad at the lifted point the vertex shader
  // lowered). 1 + g.y is at least the rise itself, never zero. The
  // complete range returns n untouched, so its pixels are the unrisen ones.
  vec3 gradNormal(vec3 n, vec3 g) {
    if (uLandRise.x <= 0.0) return n;
    float invY = 1.0 / (1.0 + g.y);
    return normalize(vec3(n.x - g.x * n.y * invY, n.y * invY, n.z - g.z * n.y * invY));
  }
  vec3 risenNormal(vec3 n, vec3 p) { return gradNormal(n, riseGrad(p)); }
  // The baked horizon (TerrainOcclusion) holds full-height elevations.
  // Lowering the land by the local stretch k lowers their tangents by k,
  // which is the light's tangent raised by 1/k.
  vec3 stretchedLight(vec3 L, float k) {
    return k < 1.0 ? normalize(vec3(L.x, L.y / max(k, 1e-3), L.z)) : L;
  }
`;

/** CPU twin of riseLift: metres added to a point's height (<= 0) for the
 *  eye `eye` ([x, y, z]), sink `sink` (1 - rise01) and pivot `pivot`. */
export function landRiseLift(x, y, z, eye, sink, pivot = 0, knee = LAND_RISE_KNEE) {
  if (!(sink > 0) || !eye) return 0;
  return riseLiftAt(y - eye[1], Math.hypot(x - eye[0], z - eye[2]), sink, knee, pivot);
}

function riseLiftAt(h, r, sink, knee, pivot) {
  const rr = Math.max(1, r), above = h - (pivot || 0) * rr;
  if (!(above > 0)) return 0;
  const wr = knee * rr;
  return -sink * (above - wr * (1 - Math.exp(-above / wr)));
}

/** Drawn height of a point at height `y` and horizontal distance `r` from
 *  the eye, for a rise state from riseFromUniforms. */
export function risenHeight(y, r, rise) {
  if (!rise || !(rise.sink > 0)) return y;
  return y + riseLiftAt(y - rise.eye[1], r, rise.sink, rise.knee ?? LAND_RISE_KNEE, rise.pivot);
}

/** The squash's pivot for a camera: the tangent of the lowest elevation
 *  its frame shows, when that is above the horizon, else 0. Above the
 *  horizon the set of directions at least some elevation up is a convex
 *  cone, so over the frame's rectangle elevation is lowest at a corner.
 *  `forward`, `up` and `right` are the camera's world axes ([x, y, z]); the
 *  frame is the full view (fovYDeg, aspect, zoom), whatever part of it a
 *  partition draws, so every part pivots alike. */
export function risePivot(forward, up, right, fovYDeg, aspect, zoom = 1) {
  const tv = Math.tan(fovYDeg * Math.PI / 360) / (zoom > 0 ? zoom : 1), th = tv * aspect;
  let low = Infinity;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const d = [0, 1, 2].map(i => forward[i] + sx * th * right[i] + sy * tv * up[i]);
    const flat = Math.hypot(d[0], d[2]);
    low = Math.min(low, flat > 1e-9 ? d[1] / flat : d[1] > 0 ? Infinity : -Infinity);
  }
  return Number.isFinite(low) && low > 0 ? low : 0;
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

/** A sphere (centre x, y, z) moved and grown to hold everything the rise
 *  draws of it. The drop grows with height and shrinks with horizontal
 *  distance, so every point of the sphere drops between its top's drop at
 *  the nearest distance and its bottom's at the farthest. Below the eye it
 *  is the sphere itself, and above it tends to the sphere as the rise
 *  completes. */
export function risenSphere(x, y, z, radius, rise) {
  if (!rise || !(rise.sink > 0)) return { y, radius };
  const r = Math.hypot(x - rise.eye[0], z - rise.eye[2]);
  const deepest = risenHeight(y + radius, Math.max(0, r - radius), rise) - (y + radius);
  const shallowest = risenHeight(y - radius, r + radius, rise) - (y - radius);
  return { y: y + (deepest + shallowest) / 2, radius: radius + (shallowest - deepest) / 2 };
}

/** The rise state the shaders read from `uniforms` (uLandRise, uTourEye),
 *  or null when the land stands complete. */
export function riseFromUniforms(u) {
  const rise = u?.uLandRise?.value;
  const eye = u?.uTourEye?.value;
  if (!(rise?.x > 0) || !eye) return null;
  return { sink: rise.x, eye: [eye.x, eye.y, eye.z], knee: LAND_RISE_KNEE, pivot: rise.y > 0 ? rise.y : 0 };
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
 * the land never jumps or sinks. What is left never finishes faster than
 * over LAND_RISE_CATCH_UP_MS, so a new climb that is over, or a moment from
 * over, at the handoff does not snap the land to the complete range.
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
      if (from >= 1) return 1;
      const paced = (timeMs - freezeThroughMs) / LAND_RISE_CATCH_UP_MS;
      const k = base >= 1 ? paced : Math.min(paced, (own(timeMs) - base) / (1 - base));
      return clamp01(from + (1 - from) * clamp01(k));
    };
  }
  const at = (timeMs) => LAND_RISE_START + (1 - LAND_RISE_START) * landing(progressAt(timeMs));
  return Object.freeze({ endMs, progressAt, at });
}
