// The playable note chart, built once at load from the kick timeline — the
// tap targets the player is judged against. Two note types:
//   tap  — press within the window, points for how on-time the press is
//   hold — a sustained double-bass roll collapsed into one press-and-hold
//          note; interior kicks become its pay ticks, never individually
//          judgeable
// Tap notes are placed only where the offline jump predictor would actually
// take off (not on every kick): "tap every note on time" then reproduces the
// exact arc schedule ObstacleSpawner placed obstacles against, so a player
// following the chart can always clear what the auto-game could. Kicks the
// predictor ignores (mid-air, halftime ghosts) simply aren't notes.
import { Role } from '../core/NoteEvent.js';
import {
  A, B, GAMMA, scheduledJumpD, nextLandingKickMs, LANDING_QUANT_EPS_MS, RETARGET_FALL_MS, canRetarget,
} from './JumpController.js';

export const HOLD_MAX_GAP_MS = 180; // consecutive kicks this close chain into a roll
export const HOLD_MIN_HITS = 5;
export const HOLD_MIN_SPAN_MS = 450; // a roll must sustain this long to earn a hold note
export const TAP_SCORE = 100;
export const TICK_SCORE = 25;
export const HOLD_BONUS = 150;
// No hold material this close to the end: the fracture freezes the frame at
// durationMs - 300, and a hold must always be completable before that.
export const SONG_END_KEEPOUT_MS = 500;
const DEDUPE_EPS_MS = 5; // layered 35+36 kicks on the same moment collapse to one hit
const HIGH_BPM_HALFTIME = 170;

/**
 * @param {import('../core/NoteEvent.js').NoteEvent[]} timeline full song timeline
 * @param {number} durationMs
 * @returns {{
 *   notes: Array<{type:'tap', tMs:number, vel:number} |
 *                {type:'hold', tMs:number, endMs:number, vel:number, tickTimesMs:number[]}>,
 *   holdSpans: Array<{fromMs:number, toMs:number}>,
 *   maxPossibleScore: number, tapCount: number, holdCount: number,
 * }}
 */
export function buildNoteChart(timeline, durationMs) {
  const raw = [];
  for (const e of timeline) if (e.role === Role.RHYTHM && e.kick) raw.push({ tMs: e.tMs, vel: e.vel });
  if (raw.length === 0) return { notes: [], holdSpans: [], maxPossibleScore: 0, tapCount: 0, holdCount: 0 };

  // Simultaneous layered kicks would double-count a roll's hits (and pay a
  // hold's tick twice); collapse them before clustering.
  const deduped = [];
  for (const k of raw) {
    const last = deduped[deduped.length - 1];
    if (last && k.tMs - last.tMs < DEDUPE_EPS_MS) { last.vel = Math.max(last.vel, k.vel); continue; }
    deduped.push({ tMs: k.tMs, vel: k.vel });
  }

  const holds = clusterHolds(deduped, durationMs);
  // Takeoff replay runs over the RAW kicks: ObstacleSpawner feeds the same
  // raw list to predictJumpArcs, and the halftime rule is parity-sensitive —
  // diverging inputs would desync the two schedules.
  const triggers = replayTakeoffTriggers(raw);

  const taps = [];
  let hi = 0;
  for (const t of triggers) {
    while (hi < holds.length && holds[hi].endMs < t.tMs) hi++;
    const h = holds[hi];
    if (h && t.tMs >= h.tMs && t.tMs <= h.endMs) continue; // consumed by the hold
    taps.push({ type: 'tap', tMs: t.tMs, vel: t.vel });
  }

  const notes = [...taps, ...holds].sort((a, b) => a.tMs - b.tMs);
  const maxPossibleScore = TAP_SCORE * taps.length +
    holds.reduce((s, h) => s + TAP_SCORE + TICK_SCORE * h.tickTimesMs.length + HOLD_BONUS, 0);
  return {
    notes,
    holdSpans: holds.map((h) => ({ fromMs: h.tMs, toMs: h.endMs })),
    maxPossibleScore,
    tapCount: taps.length,
    holdCount: holds.length,
  };
}

/** Greedy roll clustering over the deduped kick list. A run whose late ticks
 * fall inside the song-end keepout keeps only what fits; a run that no longer
 * qualifies after clamping is dropped entirely, its kicks flowing back
 * through ordinary tap selection instead. */
function clusterHolds(kicks, durationMs) {
  const holds = [];
  const clampMs = durationMs - SONG_END_KEEPOUT_MS;
  let runStart = 0;
  for (let i = 1; i <= kicks.length; i++) {
    const broken = i === kicks.length || kicks[i].tMs - kicks[i - 1].tMs > HOLD_MAX_GAP_MS;
    if (!broken) continue;
    const run = kicks.slice(runStart, i);
    runStart = i;
    if (run.length < HOLD_MIN_HITS) continue;
    const kept = run.filter((k) => k.tMs <= clampMs);
    if (kept.length < HOLD_MIN_HITS) continue;
    if (kept[kept.length - 1].tMs - kept[0].tMs < HOLD_MIN_SPAN_MS) continue;
    holds.push({
      type: 'hold',
      tMs: kept[0].tMs,
      endMs: kept[kept.length - 1].tMs,
      vel: kept[0].vel,
      tickTimesMs: kept.slice(1).map((k) => k.tMs),
    });
  }
  return holds;
}

/** Which kick triggers each predicted takeoff. Kept in lockstep with
 * JumpPlanner.predictJumpArcs (itself in lockstep with JumpController — see
 * test/jumpPlanner.test.js): same EMA, halftime parity, airborne and
 * retarget rules. Duplicated rather than reused because predictJumpArcs
 * reports takeoff times, not triggering kicks — a retarget arc's takeoffMs
 * sits RETARGET_FALL_MS after its kick, and the note must live on the kick. */
function replayTakeoffTriggers(kicks) {
  let beatPeriodMs = 500;
  let lastKickMs = null;
  let kickCount = 0;
  let compressingUntilMs = -Infinity;
  let lastArc = null;
  const triggers = [];
  const kickTimes = kicks.map((k) => k.tMs);

  for (let ki = 0; ki < kicks.length; ki++) {
    const k = kicks[ki];
    if (lastKickMs != null) {
      const interval = k.tMs - lastKickMs;
      if (interval > 120 && interval < 2000) beatPeriodMs = beatPeriodMs * 0.7 + interval * 0.3;
    }
    lastKickMs = k.tMs;
    kickCount++;

    if (k.tMs < compressingUntilMs) continue;

    const bpm = 60000 / beatPeriodMs;
    if (bpm > HIGH_BPM_HALFTIME && kickCount % 2 === 0) continue;

    // Symmetric landing-tie rule (see JumpController.LANDING_QUANT_EPS_MS's
    // doc): a kick within the tolerance of the arc's scheduled touchdown IS
    // the touchdown -- grounded, relaunch ON the kick. Lockstep with
    // JumpPlanner and the live controller's force-land.
    const airborne = lastArc && k.tMs < lastArc.landMs - LANDING_QUANT_EPS_MS;

    if (!airborne) {
      // Land ON the next audible kick when one's in range -- see
      // JumpController.scheduledJumpD/nextLandingKickMs, kept in lockstep
      // with JumpPlanner and the live controller's own cursor walk.
      const nextKickMs = nextLandingKickMs(kickTimes, k.tMs, ki + 1);
      const D = scheduledJumpD(k.tMs, nextKickMs, beatPeriodMs);
      lastArc = { takeoffMs: k.tMs, landMs: k.tMs + D, D };
      triggers.push({ tMs: k.tMs, vel: k.vel });
      continue;
    }

    const u = (k.tMs - lastArc.takeoffMs) / lastArc.D;
    if (u >= A + B) {
      const r = (u - A - B) / GAMMA;
      if (r < 0.3 && canRetarget(k.tMs, lastArc.takeoffMs, lastArc.D)) {
        const compressLandMs = k.tMs + RETARGET_FALL_MS;
        const nextKickMs = nextLandingKickMs(kickTimes, compressLandMs, ki + 1);
        const D = scheduledJumpD(compressLandMs, nextKickMs, beatPeriodMs);
        compressingUntilMs = compressLandMs;
        lastArc = { takeoffMs: compressLandMs, landMs: compressLandMs + D, D };
        triggers.push({ tMs: k.tMs, vel: k.vel });
      }
    }
  }
  return triggers;
}
