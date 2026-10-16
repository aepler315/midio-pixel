// Wildfire: a 1-D front in world-x space that spreads asymmetrically along
// the prevailing wind (Atmosphere.prevailingAngle(), landed in PR #86 but
// previously unconsumed) -- fast downwind, slow upwind. Real fire
// behavior, and the most legible possible read on which way the wind is
// blowing: the burn visibly races one direction and crawls the other.
//
// Pure geometry only -- FireDirector (src/sim/FireDirector.js) owns the
// stateful strike/update/burn-scar wrapper, BiomeManager draws.
import { clamp01 } from '../utils/math.js';

export const FIRE_DOWNWIND_SPEED_PX_S = 34; // world-space spread rate downwind
export const FIRE_UPWIND_RATIO = 0.22;      // upwind spreads at this fraction of downwind
export const FIRE_MAX_HALF_WIDTH_PX = 2200; // hard cap either direction from the origin
export const FIRE_DURATION_MS = 26000;      // total lifetime: ramp -> hold -> die down
export const FIRE_DIEDOWN_MS = 9000;        // trailing fraction of duration spent dying down
export const FIRE_RAMP_FRAC = 0.15;         // leading fraction of duration spent ramping up

/** The wind's x-axis lean at a given angle (radians, 0 = blowing due +x):
 *  -1..1. This game's wind/fire only ever reads left/right on screen, so
 *  the fire's asymmetry is driven by this single projected component
 *  rather than a full 2-D spread. */
export function windProjection(angle) {
  return Math.cos(angle);
}

/** The front's [x0, x1] extent (world-x, relative to the strike origin) at
 *  ageMs, given the wind's x-lean at strike time. Spreads
 *  FIRE_DOWNWIND_SPEED_PX_S in the leaned direction, a slow
 *  FIRE_UPWIND_RATIO fraction of that against it -- asymmetric on purpose,
 *  the entire visual point of the system. Both capped at
 *  FIRE_MAX_HALF_WIDTH_PX so a very long fire doesn't consume unbounded
 *  world-space. Pure. */
export function fireExtent(ageMs, windProjectionValue) {
  const ageSec = Math.max(0, ageMs) / 1000;
  const downwindDist = Math.min(FIRE_MAX_HALF_WIDTH_PX, FIRE_DOWNWIND_SPEED_PX_S * ageSec);
  const upwindDist = Math.min(FIRE_MAX_HALF_WIDTH_PX, FIRE_DOWNWIND_SPEED_PX_S * FIRE_UPWIND_RATIO * ageSec);
  const leanPositive = windProjectionValue >= 0;
  return {
    x0: -(leanPositive ? upwindDist : downwindDist),
    x1: leanPositive ? downwindDist : upwindDist,
  };
}

/** 0..1 overall intensity envelope across the fire's life: ramps up over
 *  the first FIRE_RAMP_FRAC of duration, holds at full, then dies down
 *  over the trailing FIRE_DIEDOWN_MS. Pure. */
export function fireIntensity01(ageMs) {
  if (!(ageMs >= 0) || ageMs > FIRE_DURATION_MS) return 0;
  const rampMs = FIRE_DURATION_MS * FIRE_RAMP_FRAC;
  if (ageMs < rampMs) return clamp01(ageMs / rampMs);
  const dieStart = FIRE_DURATION_MS - FIRE_DIEDOWN_MS;
  if (ageMs < dieStart) return 1;
  return clamp01(1 - (ageMs - dieStart) / FIRE_DIEDOWN_MS);
}

export function fireActive(ageMs) {
  return ageMs >= 0 && ageMs <= FIRE_DURATION_MS;
}

/** Deterministic per-column flame flicker height multiplier (0.4..1), keyed
 *  on world-x and time so every column has its own phase without any
 *  per-frame RNG -- replaying the same song produces the exact same fire. */
export function flameFlicker(worldX, tSec) {
  const a = Math.sin(worldX * 0.037 + tSec * 6.3);
  const b = Math.sin(worldX * 0.091 - tSec * 9.1 + 1.7);
  return 0.7 + 0.3 * (0.5 * a + 0.5 * b);
}

/** Deterministic smoke-column drift offset (px) at a height fraction
 *  h01 (0 = base, 1 = top of the visible column) and time -- a gentle
 *  sideways sway that grows with height, like real smoke shearing over as
 *  it rises. `windLeanPx` biases the whole column toward the wind. */
export function smokeDrift(h01, tSec, windLeanPx = 0) {
  const sway = 14 * h01 * Math.sin(tSec * 0.6 + h01 * 3.1);
  return sway + windLeanPx * h01;
}
