// The range grows from partly built relief to its source elevation with the song.
// Every point shares F(y) = baseM + rise01 * (y - baseM), independently of
// camera direction and distance. Terrain, rivers, forest and cast use the
// same base and progress, including reflected draws.
import { clamp01 } from '../../utils/math.js';

/** Relief share at the song's first beat, skipping the first third of the build. */
export const LAND_RISE_START = 1 / 3;
/** Pace in silence, against 1 + energy at full energy. */
export const LAND_RISE_QUIET_PACE = 0.6;
/** Share of the climb spent easing to a stop on the complete range. */
export const LAND_RISE_LANDING = 0.15;
/** The rise completes no earlier than this share of the music. */
export const LAND_RISE_MIN_END = 0.6;
/** Minimum time to finish the remaining climb after re-analysis. */
export const LAND_RISE_CATCH_UP_MS = 8000;
const STEP_MS = 250;

/** Shared vertical transform. uLandRise holds (1 - rise01, baseM).
 *  A zero sink preserves the source geometry and normals exactly. */
export const LAND_RISE_GLSL = /* glsl */`
  uniform vec2 uLandRise;
  float riseLift(vec3 p) {
    if (uLandRise.x <= 0.0) return 0.0;
    return -uLandRise.x * (p.y - uLandRise.y);
  }
  vec3 riseGrad(vec3 p) {
    if (uLandRise.x <= 0.0) return vec3(0.0);
    return vec3(0.0, -uLandRise.x, 0.0);
  }
  // Inverse-transpose normal, multiplied by the vertical stretch before
  // normalization so even the completely flat transform stays finite.
  vec3 gradNormal(vec3 n, vec3 g) {
    if (uLandRise.x <= 0.0) return n;
    float k = max(0.0, 1.0 + g.y);
    vec3 moved = vec3(k * n.x - g.x * n.y, n.y, k * n.z - g.z * n.y);
    return dot(moved, moved) > 1e-12 ? normalize(moved) : vec3(0.0, 1.0, 0.0);
  }
  vec3 risenNormal(vec3 n, vec3 p) { return gradNormal(n, riseGrad(p)); }
  // The source horizon's tangents contract by the same vertical stretch.
  vec3 stretchedLight(vec3 L, float k) {
    return k < 1.0 ? normalize(vec3(L.x, L.y / max(k, 1e-3), L.z)) : L;
  }
`;

/** Metres added to a point's height. The eye argument preserves callers'
 *  positional API; the shared base determines the vertical transform. */
export function landRiseLift(x, y, z, eye, sink, baseM = 0) {
  return sink > 0 ? -sink * (y - baseM) : 0;
}

/** Drawn height. Horizontal distance preserves the sampling API. */
export function risenHeight(y, r, rise) {
  return rise?.sink > 0 ? y - rise.sink * (y - rise.baseM) : y;
}

/** The affine map is monotone in source height over the supported rise. */
export function risenFloor(y, x0, z0, x1, z1, rise) {
  return risenHeight(y, 0, rise);
}

/** A vertical contraction maps the sphere into an ellipsoid inside a
 *  sphere with the original radius and its vertically transformed centre. */
export function risenSphere(x, y, z, radius, rise) {
  return { y: risenHeight(y, 0, rise), radius };
}

/** Read the exact shared sink and base, including signed base elevations. */
export function riseFromUniforms(u) {
  const rise = u?.uLandRise?.value;
  return rise?.x > 0 ? { sink: rise.x, baseM: rise.y } : null;
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
 *
 * The land starts one-third built (LAND_RISE_START) and the music builds the
 * rest across the whole song. The opening close-up is released on its own
 * clock (OpeningTimeline.openingZoomRelease01), not by an early surge in
 * height. The rise is a pure function of heard time, so the handoff above and
 * every seek agree, and the land reaches exactly 1 at endMs.
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
