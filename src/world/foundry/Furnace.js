// The Foundry's musical envelope.
//
// Heat is sustained energy -- the 1.2s average WorldMusic already computes
// -- never a single-frame sample. A single tap of globalEnergyNorm used to
// flash the whole mill at whatever 20ms bin the renderer landed on, which
// is the same aliasing Fathom's bass pressure was written to avoid.
//
// Percussion drives mechanisms, not the pour. Dense hits are aggregated by
// answering only one mill at a time (the current section's operation) and
// only one hammer in that mill (the accent's group). The other mills stay
// at idle embers. Quiet input does not get amplified into activity: below
// a small energy floor the mill is cold iron with a residual glow.
//
// Section cuts that earned a lift become pours -- the ground floods, then
// falls back to the heat envelope. Decorative pacing cuts do not.
//
// Pure and causal: seeking backwards cannot leave a pour hanging.
import { clamp01, lerp } from '../../utils/math.js';
import { boundaryLift01 } from '../WorldMusic.js';

const HEAT_FLOOR = 0.10;
const HEAT_CEIL = 0.62;
const QUIET = 0.08;
const POUR_GAIN = 0.48;

export { boundaryLift01 };

/**
 * Sustained furnace temperature, 0..1. Quiet material stays as low embers.
 * Reduced flash does not dim the heat itself -- the mill is still running
 * -- it only stops the hammers from travelling and the pour from adding.
 */
export function furnaceHeat(energy = 0) {
  const e = clamp01(energy);
  if (e <= QUIET) return lerp(HEAT_FLOOR * 0.35, HEAT_FLOOR, e / QUIET);
  return lerp(HEAT_FLOOR, HEAT_CEIL, (e - QUIET) / (1 - QUIET));
}

/** Heat plus an earned boundary pour. */
export function pourGlow({ heat = 0, reveal = 0, lift = 0, reducedFlash = false } = {}) {
  const bloom = reducedFlash ? 0.35 : 1;
  return clamp01(clamp01(heat) + POUR_GAIN * bloom * clamp01(reveal) * clamp01(lift));
}

/** Which mill is running this section. Stable for a missing index. */
export function operationIndex(sectionIdx) {
  if (!Number.isFinite(sectionIdx) || sectionIdx < 0) return 0;
  return Math.abs(Math.round(sectionIdx)) % 4;
}

/**
 * How hard this hammer drops, 0..1.
 * Other mills: 0. Current mill, other hammers: a residual. Matching
 * mill and group: the accent.
 */
export function machineStroke({ accent = 0, group = 0, operation = 0, machine = 0 } = {}) {
  const a = clamp01(accent);
  const mill = ((machine % 4) + 4) % 4;
  const op = ((operation % 4) + 4) % 4;
  const g = ((group % 4) + 4) % 4;
  if (mill !== op) return 0;
  if (mill !== g) return a * 0.12;
  return a;
}

/** How awake a mill body is, even with no accent. */
export function millActivity(heat = 0, operation = 0, mill = 0) {
  const h = clamp01(heat);
  if ((((mill % 4) + 4) % 4) === (((operation % 4) + 4) % 4)) {
    return clamp01(0.28 + 0.72 * h);
  }
  return clamp01(0.06 + 0.16 * h);
}
