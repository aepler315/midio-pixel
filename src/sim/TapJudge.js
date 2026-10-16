// Judges player presses against the note chart and runs the hold-note state
// machine. Pure: no ctx, no audio. Emits one-shot stepEvents each sim step
// (cleared via clearFrameFlags like every other one-shot in the sim) and
// maintains a persistent holdState for the performer/renderer. All times are
// the press's own DOM-captured audio-clock stamp, so judgment precision is
// never quantized to the 8.3ms step grid — only to the 10ms scoring bins.
import { TICK_SCORE, HOLD_BONUS } from './NoteChart.js';

export const JUDGE_WINDOW_MS = 120;
// A press this early can still arm a hold if the button is down when the
// hold's moment arrives (it scores 0 start points) — without this, one
// slightly-early press would make the whole hold unplayable.
export const HOLD_ARM_EARLY_MS = 300;
export const HOLD_END_GRACE_MS = 100; // releasing this close to the end still completes
// Latency calibration lives in LatencyCalibrator now; the DOM handlers
// stamp presses with the live, persisted offset.

/** The 10ms snap: every 10ms of offset costs 10 of the 100 points. */
export function pointsForOffset(offMs) {
  return Math.max(0, 100 - 10 * Math.round(Math.abs(offMs) / 10));
}

export function tierForPoints(pts) {
  if (pts >= 90) return 'perfect';
  if (pts >= 60) return 'great';
  if (pts >= 10) return 'good';
  return 'sour';
}

export class TapJudge {
  constructor(chart = null) {
    this.notes = chart ? chart.notes : [];
    this._consumed = new Array(this.notes.length).fill(false);
    this._missCursor = 0; // playback is linear/seek-free, so this never rewinds
    this.buttonDown = false;
    this._downSinceMs = null;
    this._hold = null; // {note, nextTick}
    /** Persistent, read by MidioPerformer (slide pose) and the renderer. */
    this.holdState = { active: false, chargeU: 0, note: null };
    /** One-shot per sim step:
     * {kind:'hit'|'sour'|'miss'|'holdStart'|'holdTick'|'holdComplete'|'holdChoke',
     *  basePts, tMs, tier?, offsetMs?, tickIdx?, tickCount?, remainingTicks?} */
    this.stepEvents = [];
  }

  /** Discard judgments/holds and silently skip notes before a new segment. */
  seekTo(nowMs) {
    this._consumed.fill(false);
    this._missCursor = 0;
    while (this._missCursor < this.notes.length && this.notes[this._missCursor].tMs <= nowMs) {
      this._consumed[this._missCursor++] = true;
    }
    this.buttonDown = false;
    this._downSinceMs = null;
    this._hold = null;
    this.holdState = { active: false, chargeU: 0, note: null };
    this.clearFrameFlags();
    return this._missCursor;
  }

  clearFrameFlags() {
    this.stepEvents.length = 0;
  }

  /** @returns {{startedHold:boolean, matchedVel:number|null}} startedHold
   *  tells the caller to suppress the physical jump (a hold is a slide). */
  onTapDown(tMs) {
    this.buttonDown = true;
    this._downSinceMs = tMs;
    // Defensive: main.js edge-collapses input sources, so a down during an
    // active hold shouldn't reach us — but if one does, it belongs to the
    // hold and must not relaunch a jump.
    if (this._hold) return { startedHold: true, matchedVel: null };
    // A kickless song judges nothing at all: taps still jump, but mashing
    // shouldn't rain sour feedback when there was never anything to hit.
    if (this.notes.length === 0) return { startedHold: false, matchedVel: null };

    const i = this._match(tMs);
    if (i < 0) {
      this.stepEvents.push({ kind: 'sour', tier: 'sour', basePts: 0, offsetMs: null, tMs });
      return { startedHold: false, matchedVel: null };
    }
    const n = this.notes[i];
    this._consumed[i] = true;
    const offsetMs = tMs - n.tMs;
    const basePts = pointsForOffset(offsetMs);
    const tier = tierForPoints(basePts);
    if (n.type === 'hold') {
      this._startHold(n, tMs);
      this.stepEvents.push({ kind: 'holdStart', tier, basePts, offsetMs, tMs });
      return { startedHold: true, matchedVel: n.vel };
    }
    this.stepEvents.push({ kind: 'hit', tier, basePts, offsetMs, tMs });
    return { startedHold: false, matchedVel: n.vel };
  }

  onTapUp(tMs) {
    this.buttonDown = false;
    this._downSinceMs = null;
    if (!this._hold) return;
    const h = this._hold;
    this._payDueTicks(tMs);
    if (tMs >= h.note.endMs - HOLD_END_GRACE_MS) {
      this._finishHold();
    } else {
      this.stepEvents.push({
        kind: 'holdChoke', basePts: 0, tMs,
        remainingTicks: h.note.tickTimesMs.length - h.nextTick,
      });
      this._clearHold();
    }
  }

  update(nowMs) {
    // Late-arm before anything can sweep the hold into a miss.
    if (this.buttonDown && !this._hold && this._downSinceMs !== null) {
      for (let i = this._missCursor; i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.tMs > nowMs) break;
        if (this._consumed[i] || n.type !== 'hold') continue;
        if (this._downSinceMs >= n.tMs - HOLD_ARM_EARLY_MS && this._downSinceMs < n.tMs) {
          this._consumed[i] = true;
          this._startHold(n, n.tMs);
          this.stepEvents.push({
            kind: 'holdStart', tier: null, basePts: 0, offsetMs: this._downSinceMs - n.tMs, tMs: n.tMs,
          });
        }
        break;
      }
    }

    if (this._hold) {
      this._payDueTicks(nowMs);
      const ticks = this._hold.note.tickTimesMs;
      this.holdState.chargeU = ticks.length ? this._hold.nextTick / ticks.length : 1;
      if (nowMs >= this._hold.note.endMs) this._finishHold(); // still held at the end
    }

    while (this._missCursor < this.notes.length &&
           this.notes[this._missCursor].tMs + JUDGE_WINDOW_MS < nowMs) {
      const i = this._missCursor++;
      if (!this._consumed[i]) {
        this._consumed[i] = true;
        this.stepEvents.push({ kind: 'miss', basePts: 0, tMs: this.notes[i].tMs });
      }
    }
  }

  _match(tMs) {
    let best = -1;
    let bestOff = Infinity;
    for (let i = this._missCursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.tMs > tMs + JUDGE_WINDOW_MS) break;
      if (this._consumed[i]) continue;
      const off = Math.abs(tMs - n.tMs);
      if (off <= JUDGE_WINDOW_MS && off < bestOff) { best = i; bestOff = off; }
    }
    return best;
  }

  _startHold(note, pressMs) {
    this._hold = { note, nextTick: 0 };
    // Ticks already past when the press lands are lost, not back-paid.
    while (this._hold.nextTick < note.tickTimesMs.length &&
           note.tickTimesMs[this._hold.nextTick] < pressMs) this._hold.nextTick++;
    this.holdState.active = true;
    this.holdState.note = note;
    this.holdState.chargeU = 0;
  }

  _payDueTicks(nowMs) {
    const h = this._hold;
    const ticks = h.note.tickTimesMs;
    while (h.nextTick < ticks.length && ticks[h.nextTick] <= nowMs) {
      this.stepEvents.push({
        kind: 'holdTick', basePts: TICK_SCORE, tMs: ticks[h.nextTick],
        tickIdx: h.nextTick, tickCount: ticks.length,
      });
      h.nextTick++;
    }
  }

  /** Completion: the grace-window remainder pays out, then the bonus — a
   * perfectly-played hold must always be able to earn its full listed value. */
  _finishHold() {
    const h = this._hold;
    const ticks = h.note.tickTimesMs;
    while (h.nextTick < ticks.length) {
      this.stepEvents.push({
        kind: 'holdTick', basePts: TICK_SCORE, tMs: ticks[h.nextTick],
        tickIdx: h.nextTick, tickCount: ticks.length,
      });
      h.nextTick++;
    }
    this.stepEvents.push({ kind: 'holdComplete', basePts: HOLD_BONUS, tMs: h.note.endMs });
    this._clearHold();
  }

  _clearHold() {
    this._hold = null;
    this.holdState.active = false;
    this.holdState.note = null;
    this.holdState.chargeU = 0;
  }
}
