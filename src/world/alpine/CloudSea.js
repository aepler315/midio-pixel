// Cloud sea: in the Range's quiet passages the valley mist thickens into a
// sea of cloud with the peaks standing above it (RangeAtmosphere draws it),
// then drains away when the song lifts. Compiled once per song from its
// energy curve, so any heard time -- forward seek, backward seek, pause --
// reads the same amount.
import { smoothstep } from '../../utils/math.js';

export const SEA_STEP_MS = 100;
/** Song-relative energy (EnergyCurves.globalEnergyNorm) averaged over the
 *  last SEA_WINDOW_MS, long enough that a beat does not read as loud. A
 *  passage is quiet against the song itself: within the lowest
 *  SEA_QUIET_FRAC of the span between its p10 and p90 averages, fading
 *  out by SEA_EDGE_FRAC. */
export const SEA_WINDOW_MS = 3000;
export const SEA_QUIET_FRAC = 0.30;
export const SEA_EDGE_FRAC = 0.45;
/** Below this span the song has no quiet passages to speak of (a wall of
 *  sound, a steady groove, a drone): the valley never fills. A steady
 *  song with one short breakdown has its p10 on the loud level too, so
 *  when p10..p90 is too narrow the floor drops to the SEA_BRIEF_PCT
 *  percentile, where a breakdown of a few percent of the song still lands. */
export const SEA_MIN_SPAN = 0.15;
export const SEA_BRIEF_PCT = 0.01;
/** A passage must stay quiet this long before the cloud starts to rise: a
 *  single soft bar, or a short lull between hits, is not a breakdown. */
export const SEA_HOLD_MS = 4000;
/** Once up, the song must stay loud this long before the cloud drains, so
 *  a fill or a single hit inside a breakdown does not tear it open. */
export const SEA_RELEASE_MS = 4000;
/** The cloud wells up over RISE and drains over FALL: weather, not a cue. */
export const SEA_RISE_MS = 14000;
export const SEA_FALL_MS = 10000;
/** After the valley has drained it stays clear at least this long before
 *  it may fill again, so alternating soft and loud sections do not pump
 *  the cloud in and out. */
export const SEA_REST_MS = 20000;
/** The curve is compiled ahead from the whole song, so it can look forward:
 *  the cloud only starts to rise when the quiet will last at least this
 *  much longer. A lull that is about to end gets no half-risen flicker. */
export const SEA_AHEAD_MS = 6000;
/** The opening belongs to the scene's own arrival. */
export const SEA_OPENING_MS = 8000;

const EMPTY = Object.freeze({ at: () => 0, durationMs: 0 });

/**
 * The cloud-sea curve for a song: { at(timeMs) -> 0..1 }. `energyCurves`
 * needs globalEnergyNorm (or globalEnergy); without one the valley never fills.
 */
export function compileCloudSea({ energyCurves = null, durationMs = 0 } = {}) {
  const read = typeof energyCurves?.globalEnergyNorm === 'function' ? t => energyCurves.globalEnergyNorm(t)
    : typeof energyCurves?.globalEnergy === 'function' ? t => energyCurves.globalEnergy(t) : null;
  if (!read || !(durationMs > 0)) return EMPTY;
  const n = Math.ceil(durationMs / SEA_STEP_MS) + 1;
  const window = Math.max(1, Math.round(SEA_WINDOW_MS / SEA_STEP_MS));
  const hold = Math.round(SEA_HOLD_MS / SEA_STEP_MS);
  const rise = SEA_STEP_MS / SEA_RISE_MS, fall = SEA_STEP_MS / SEA_FALL_MS;
  // Trailing average, then the song's own quiet edge.
  const avg = new Float32Array(n);
  const recent = new Float64Array(window);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, Math.max(0, read(Math.min(i * SEA_STEP_MS, durationMs)) || 0));
    sum += e - recent[i % window];
    recent[i % window] = e;
    avg[i] = sum / Math.min(i + 1, window);
  }
  const sorted = Float32Array.from(avg.subarray(Math.min(n - 1, window))).sort();
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const p90 = pct(0.9);
  let floor = pct(0.1);
  if (p90 - floor < SEA_MIN_SPAN) floor = pct(SEA_BRIEF_PCT);
  const span = p90 - floor;
  if (!(span >= SEA_MIN_SPAN)) return Object.freeze({ at: () => 0, durationMs });
  const lo = floor + SEA_QUIET_FRAC * span, hi = floor + SEA_EDGE_FRAC * span;
  const env = new Float32Array(n);
  const release = Math.round(SEA_RELEASE_MS / SEA_STEP_MS);
  const rest = Math.round(SEA_REST_MS / SEA_STEP_MS);
  const ahead = Math.round(SEA_AHEAD_MS / SEA_STEP_MS);
  // How many more steps each quiet stretch lasts (0 where it is loud).
  const quietLeft = new Int32Array(n + 1);
  for (let i = n - 1; i >= 0; i--) quietLeft[i] = 1 - smoothstep(lo, hi, avg[i]) > 0.5 ? quietLeft[i + 1] + 1 : 0;
  let quietRun = 0, loudRun = 0, level = 0, target = 0, clearedAt = -Infinity;
  for (let i = 0; i < n; i++) {
    const tMs = i * SEA_STEP_MS;
    const quiet = 1 - smoothstep(lo, hi, avg[i]);
    const isQuiet = quiet > 0.5;
    quietRun = isQuiet ? quietRun + 1 : 0;
    loudRun = isQuiet ? 0 : loudRun + 1;
    if (target > 0) {
      // Up: deepen with the passage, never thin inside it; a loud
      // stretch only lets go once it has held for SEA_RELEASE_MS.
      if (isQuiet) target = Math.max(target, quiet);
      else if (loudRun >= release) target = 0;
    } else if (quietRun >= hold && quietLeft[i] >= ahead && tMs >= SEA_OPENING_MS && i - clearedAt >= rest) {
      target = quiet;
    }
    const was = level;
    level += Math.max(-fall, Math.min(rise, target - level));
    if (was > 0 && level <= 0) clearedAt = i;
    env[i] = level;
  }
  return Object.freeze({
    durationMs,
    at(timeMs) {
      if (!(timeMs > 0)) return 0;
      const x = Math.min(n - 1, timeMs / SEA_STEP_MS), i = Math.floor(x), f = x - i;
      const v = env[i] + ((env[Math.min(n - 1, i + 1)] ?? env[i]) - env[i]) * f;
      return v * v * (3 - 2 * v);
    },
  });
}

const cache = new WeakMap();

/** The manager's cloud-sea curve, compiled once per energy curve and length. */
export function cloudSeaFor(mgr) {
  const curves = mgr?.energyCurves;
  if (!curves || typeof curves !== 'object') return EMPTY;
  const hit = cache.get(curves);
  if (hit && hit.durationMs === (mgr.durationMs || 0)) return hit;
  const reveal = compileCloudSea({ energyCurves: curves, durationMs: mgr.durationMs || 0 });
  cache.set(curves, reveal);
  return reveal;
}

/** How full the cloud sea is at this heard time (a diagnostic override wins). */
export function cloudSeaAt(mgr, timeMs) {
  if (Number.isFinite(mgr?.cloudSeaOverride)) return Math.min(1, Math.max(0, mgr.cloudSeaOverride));
  if (mgr?.terrainPreview) return 0;
  return cloudSeaFor(mgr).at(timeMs);
}
