// Pure analysis: musical end of a song for FractureEngine freeze/shatter
// and audio silence. Declared duration often includes silence padding or
// trail-out; the finale should hit on the last impactful notes and the
// late build-up peak, then go quiet — not hang on empty clock time.
import { Role } from './NoteEvent.js';
import { clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

/** Lead before freeze capture so the last hit still lands on-screen. */
export const FINALE_FREEZE_LEAD_MS = 280;
/** Hold after last impact before silence is fully in (ms). */
export const FINALE_SILENCE_TAIL_MS = 120;
/** Window used when scanning for the late build-up peak. */
export const BUILD_PEAK_WINDOW_MS = 1800;

/**
 * Last note onset that should carry the shatter impact — prefer the last
 * kick if it sits near the end of musical activity; otherwise the last note.
 * @param {Array<{tMs?:number,durMs?:number,role?:string,kick?:boolean,vel?:number}>} timeline
 * @param {number} durationMs
 */
export function findLastImpactMs(timeline, durationMs) {
  if (!timeline?.length) return Math.max(0, (durationMs || 0) - FINALE_FREEZE_LEAD_MS);

  let lastNote = -1;
  let lastKick = -1;
  let lastStrong = -1; // high-vel non-kick as backup

  for (const e of timeline) {
    const t = e.tMs || 0;
    // Ignore events past the declared duration (trail garbage / pad).
    if (durationMs > 0 && t > durationMs + 80) continue;
    if (t >= lastNote) lastNote = t;
    if (e.role === Role.RHYTHM && e.kick) {
      if (t >= lastKick) lastKick = t;
    } else if ((e.vel ?? 0.6) >= 0.75 && t >= lastStrong) {
      lastStrong = t;
    }
  }

  if (lastKick >= 0) {
    // Kick is the impact if it's not abandoned early (within 2.5s of last note).
    if (lastNote < 0 || lastNote - lastKick <= 2500) return lastKick;
  }
  if (lastStrong >= 0 && (lastNote < 0 || lastNote - lastStrong <= 1500)) return lastStrong;
  if (lastNote >= 0) return lastNote;
  return Math.max(0, (durationMs || 0) - FINALE_FREEZE_LEAD_MS);
}

/**
 * Late-song build-up peak: densest kick cluster (or energy max) in the
 * final ~40% of the track, before the last impact.
 * @returns {number} ms of peak center
 */
export function findBuildPeakMs(timeline, durationMs, energyCurves = null, lastImpactMs = null) {
  const dur = durationMs > 0 ? durationMs : 0;
  const impact = lastImpactMs != null ? lastImpactMs : findLastImpactMs(timeline, dur);
  const end = impact > 0 ? impact : dur;
  const start = Math.max(0, end - Math.max(8000, dur * 0.4));

  // Prefer densest kick window.
  const kicks = [];
  if (timeline) {
    for (const e of timeline) {
      if (e.role !== Role.RHYTHM || !e.kick) continue;
      const t = e.tMs || 0;
      if (t >= start && t <= end) kicks.push(t);
    }
  }
  kicks.sort((a, b) => a - b);

  let bestKickCenter = -1;
  let bestKickCount = 0;
  if (kicks.length) {
    let j = 0;
    for (let i = 0; i < kicks.length; i++) {
      while (kicks[j] < kicks[i] - BUILD_PEAK_WINDOW_MS) j++;
      const count = i - j + 1;
      if (count > bestKickCount) {
        bestKickCount = count;
        bestKickCenter = (kicks[j] + kicks[i]) / 2;
      }
    }
  }

  // Energy peak sample as a second vote.
  let bestE = -1;
  let bestEAt = start;
  if (energyCurves && typeof energyCurves.globalEnergy === 'function' && end > start) {
    const step = Math.max(40, (end - start) / 80);
    for (let t = start; t <= end; t += step) {
      const e = energyCurves.globalEnergy(t, FLAT_WEIGHTS);
      if (e > bestE) { bestE = e; bestEAt = t; }
    }
  }

  if (bestKickCenter >= 0 && bestKickCount >= 3) {
    // Blend slightly toward energy peak if present.
    if (bestE >= 0) return bestKickCenter * 0.7 + bestEAt * 0.3;
    return bestKickCenter;
  }
  if (bestE >= 0) return bestEAt;
  if (bestKickCenter >= 0) return bestKickCenter;
  // Fallback: 85% of the way to last impact.
  return start + (end - start) * 0.85;
}

/**
 * Full finale schedule for freeze + silence.
 * @returns {{
 *   lastImpactMs: number,
 *   buildPeakMs: number,
 *   freezeAtMs: number,
 *   silenceAtMs: number,
 *   musicalEndMs: number,
 * }}
 */
export function analyzeSongFinale(timeline, durationMs, energyCurves = null, { analyzedThroughMs = null } = {}) {
  const dur = durationMs > 0 ? durationMs : resolveLooseDuration(timeline);
  // A song started on its opening (OpeningAnalysis.js) has a timeline that
  // stops at the opening while the declared duration is the whole song. Its
  // "last impact" is just the last note of the opening, so the finale would
  // freeze, silence the music and end the song ~15s in. Until the whole-song
  // analysis lands, the only honest end is the declared one.
  const partial = analyzedThroughMs != null && dur > 0 && analyzedThroughMs < dur - 1;
  const lastImpactMs = partial
    ? Math.max(0, dur - FINALE_FREEZE_LEAD_MS)
    : findLastImpactMs(timeline, dur);
  const buildPeakMs = findBuildPeakMs(timeline, dur, energyCurves, lastImpactMs);

  // Freeze just after the last impact so the hit is felt, then glass breaks.
  const freezeAtMs = lastImpactMs + 60;
  // Music goes silent as freeze/shatter begins (not after empty padding).
  const silenceAtMs = Math.max(0, freezeAtMs - FINALE_FREEZE_LEAD_MS);
  // Musical end for UI / complete fallback — end of last activity + short tail.
  const musicalEndMs = Math.max(freezeAtMs + FINALE_SILENCE_TAIL_MS, lastImpactMs + FINALE_SILENCE_TAIL_MS);

  return {
    lastImpactMs,
    buildPeakMs,
    freezeAtMs,
    silenceAtMs,
    musicalEndMs,
    // Keep declared duration for systems that still need the full clock,
    // but expose whether we cut early vs the pad.
    declaredDurationMs: dur,
  };
}

function resolveLooseDuration(timeline) {
  if (!timeline?.length) return 0;
  let max = 0;
  for (const e of timeline) {
    const end = (e.tMs || 0) + (e.durMs || 0);
    if (end > max) max = end;
  }
  return max;
}

/** Progress 0..1 of the late build-up (for crack stress boost). */
export function buildPeakProgress(nowMs, buildPeakMs, halfWindowMs = BUILD_PEAK_WINDOW_MS * 0.5) {
  if (!(buildPeakMs > 0)) return 0;
  const d = Math.abs(nowMs - buildPeakMs);
  return clamp01(1 - d / halfWindowMs);
}
