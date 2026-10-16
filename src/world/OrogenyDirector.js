// Orogeny: the mountains visibly build across the course of the song,
// peaking at its own energy climax, then gradually subside through the
// rest of the runtime -- geology on a song's timescale. Pure/offline: the
// climax is found once at construction (an energy peak inside the back
// two-fifths of the song, where drops/choruses live), growth(nowMs) is a
// deterministic function of song time, consumed by MountainChoreo's
// orogenyHeightMul to scale the parallax ranges' drawn height.
import { clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const CLIMAX_SEARCH_FROM = 0.60; // fraction of duration the climax search window opens at
const CLIMAX_SEARCH_TO = 0.92;   // ...and closes at (leaves room for the ending arc to read as "falling")
const BASELINE_GROWTH = 0.10;    // never fully flat -- there's always some mountain there
const END_GROWTH = 0.15;         // where it settles by the very end
const SAMPLE_COUNT = 48;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

export class OrogenyDirector {
  /**
   * @param {import('../audio/EnergyCurves.js').EnergyCurves|null} energyCurves
   * @param {number} durationMs
   * @param {Array<{ms:number}>|null} barGrid unused directly, kept for API symmetry with PhraseTracker
   */
  constructor(energyCurves, durationMs = 0, barGrid = null) {
    this.durationMs = durationMs;
    this.climaxMs = findClimaxMs(energyCurves, durationMs);
    this.growth = BASELINE_GROWTH;
  }

  update(nowMs) {
    this.growth = orogenyGrowthAt(nowMs, this.durationMs, this.climaxMs);
  }
}

/** Finds the energy peak inside [CLIMAX_SEARCH_FROM, CLIMAX_SEARCH_TO] of
 *  the song. Falls back to a fixed fraction when there's no energy curve or
 *  no usable duration -- the arc still builds-then-falls, just without a
 *  data-driven peak to aim for. */
export function findClimaxMs(energyCurves, durationMs) {
  const fallback = durationMs > 0 ? durationMs * 0.8 : 0;
  if (!energyCurves || !durationMs || durationMs <= 0) return fallback;
  const from = durationMs * CLIMAX_SEARCH_FROM;
  const to = durationMs * CLIMAX_SEARCH_TO;
  let bestMs = fallback, bestE = -Infinity;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const tMs = from + ((to - from) * i) / (SAMPLE_COUNT - 1);
    const e = energyCurves.globalEnergy(tMs, FLAT_WEIGHTS);
    if (e > bestE) { bestE = e; bestMs = tMs; }
  }
  return bestMs;
}

/** Pure: growth in [0,1] at song time nowMs, given the song's duration and
 *  its chosen climax time. Rises eased from BASELINE_GROWTH to 1.0 across
 *  [0, climaxMs], then eases back down to END_GROWTH across
 *  [climaxMs, durationMs]. Degenerate spans (climax at t=0, or climax at
 *  the very end) still produce a monotone, bounded curve. */
export function orogenyGrowthAt(nowMs, durationMs, climaxMs) {
  if (!(durationMs > 0) || !(climaxMs > 0)) return BASELINE_GROWTH;
  if (nowMs <= 0) return BASELINE_GROWTH;
  if (nowMs < climaxMs) {
    const u = clamp01(nowMs / climaxMs);
    return BASELINE_GROWTH + (1 - BASELINE_GROWTH) * easeInOutCubic(u);
  }
  const fallSpan = durationMs - climaxMs;
  if (fallSpan <= 0) return 1;
  const u = clamp01((nowMs - climaxMs) / fallSpan);
  return 1 - (1 - END_GROWTH) * easeInOutCubic(u);
}
