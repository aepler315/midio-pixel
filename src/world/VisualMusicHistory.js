// Immutable indexes reconstruct decorative state without dispatching old cues.
import { Role } from '../core/NoteEvent.js';
function countAt(events, timeMs) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].tMs <= timeMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function lastAt(events, timeMs) { return events[countAt(events, timeMs) - 1] ?? null; }
const kickAmp = (kick) => (kick ? .4 + .6 * kick.vel : 0);
export class VisualMusicHistory {
  constructor(timeline = []) {
    this.rhythm = Object.freeze(timeline.filter(e => e.role === Role.RHYTHM)
      .map(e => Object.freeze({ ...e })).sort((a, b) => a.tMs - b.tMs));
    this.kicks = this.rhythm.filter(e => e.kick);
    this._fronts = new Map();
  }
  /** Up to `count` kicks that start a front, newest first. A kick starts
   *  one only if it lands at least `spacingMs` after the last kick that
   *  did (chosen forward from the start of the song, so a front once
   *  started is never dropped by later kicks). */
  kickFronts(timeMs, count, spacingMs) {
    let fronts = this._fronts.get(spacingMs);
    if (!fronts) {
      fronts = [];
      for (const k of this.kicks) if (!fronts.length || k.tMs - fronts[fronts.length - 1].tMs >= spacingMs) fronts.push(Object.freeze({ tMs: k.tMs, amp: kickAmp(k) }));
      this._fronts.set(spacingMs, fronts);
    }
    const n = countAt(fronts, timeMs);
    return fronts.slice(Math.max(0, n - count), n).reverse();
  }
  sample(timeMs) {
    const kick = lastAt(this.kicks, timeMs);
    return { rhythm: lastAt(this.rhythm, timeMs), kickMs: kick?.tMs ?? -Infinity, kickAmp: kickAmp(kick) };
  }
}
