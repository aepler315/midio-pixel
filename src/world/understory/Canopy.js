// Understory's musical envelope.
//
// Growth is slow on purpose. Occupancy comes from the 1.2s energy average
// and the orogeny arc -- the same two numbers that made After Hours' windows
// climb and never rest, spent here as canopy fill rather than brightness.
// Fast detail does not grow the forest; it releases spores.
//
// Phrases that earned a lift open the light shafts. Decorative pacing cuts
// do not. Selected transients burst one colony of motes; the other three
// keep their ambient drift. Clock-driven sway stays as continuity, and is
// already zero under reduced flash via WorldMusic.current.
//
// Pure and causal so a backward seek cannot leave a shaft hanging open.
import { clamp01, lerp } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';

const GROWTH_FLOOR = 0.16;
const GROWTH_CEIL = 0.72;

export { boundaryLift01 };

/**
 * Slow canopy occupancy, 0..1. Quiet songs stay open to the floor;
 * the arc fills in over the song without a kick ever adding a trunk.
 */
export function canopyGrowth({ energy = 0, orogeny = 0 } = {}) {
  const e = clamp01(energy);
  const o = clamp01(orogeny);
  return clamp01(lerp(GROWTH_FLOOR, GROWTH_CEIL, 0.62 * e + 0.38 * o));
}

/**
 * How open the shafts are. Growth is the idle; an earned phrase is the
 * event. Decorative cuts arrive with reveal 0 and do nothing extra.
 */
export function shaftOpen({ growth = 0, reveal = 0, lift = 0 } = {}) {
  return clamp01(0.22 * clamp01(growth) + 0.78 * clamp01(reveal) * clamp01(lift));
}

/** One colony answers the accent; the rest stay at ambient. */
export function sporeBurst(accent = 0, group = 0, colony = 0) {
  const a = clamp01(accent);
  const g = ((group % 4) + 4) % 4;
  const c = ((colony % 4) + 4) % 4;
  return c === g ? a : 0;
}
