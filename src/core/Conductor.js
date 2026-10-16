// Dispatches the unified NoteEvent timeline to subscribed systems as the
// audio clock advances (spec §0.2 rule 2, §6.1). Observer/EventBus pattern —
// systems never touch the timeline directly.
import { sortNoteEvents } from './NoteEvent.js';

export class Conductor {
  constructor() {
    /** @type {import('./NoteEvent.js').NoteEvent[]} */
    this.timeline = [];
    this.barGrid = [];
    this.durationMs = 0;
    this.cursor = 0;
    /** @type {Map<string, Set<Function>>} role -> listeners, plus '*' for all */
    this.listeners = new Map();
    this.barCursor = 0;
    this.barListeners = new Set();
    /** Anticipation channel (see ChoreoClock.js): each registration keeps
     *  its OWN cursor because different leads reach different depths into
     *  the timeline at the same nowMs. */
    this.aheadRegs = [];
  }

  load({ timeline, barGrid, durationMs, bpm, beatPeriodMs, confidence, freeTime, firstBarMs, localTempo, phaseConfidence, downbeatConfidence, meterConfidence }) {
    this.timeline = sortNoteEvents([...timeline]);
    this.barGrid = barGrid || [];
    this.durationMs = durationMs || 0;
    this.beatMetadata = { bpm, beatPeriodMs, confidence, phaseConfidence, downbeatConfidence, meterConfidence, freeTime, firstBarMs, localTempo: localTempo || [],
      barGrid: this.barGrid, authored: this.timeline.some(e => e.src === 'midi') };
    this.cursor = 0;
    this.barCursor = 0;
    for (const reg of this.aheadRegs) reg.cursor = 0;
  }

  /** Subscribe to events of a given role, or '*' for everything. Returns unsubscribe fn. */
  on(role, fn) {
    if (!this.listeners.has(role)) this.listeners.set(role, new Set());
    this.listeners.get(role).add(fn);
    return () => this.listeners.get(role)?.delete(fn);
  }

  onBar(fn) {
    this.barListeners.add(fn);
    return () => this.barListeners.delete(fn);
  }

  /**
   * Anticipatory subscription: events are delivered `leadMs` BEFORE their
   * tMs (each still carrying its true tMs), so a subscriber can start a
   * move early and land its peak exactly on the note -- the apex-on-beat
   * discipline in ChoreoClock.js. `role` filters like on() ('*' for all).
   * Fires exactly once per event; never skips. Returns unsubscribe fn.
   */
  subscribeAhead(role, leadMs, fn) {
    const reg = { role, leadMs: Math.max(0, leadMs), fn, cursor: 0 };
    // A mid-song registration must not replay the entire past: start at the
    // first event still ahead of the on-time cursor's own frontier.
    reg.cursor = this.cursor;
    this.aheadRegs.push(reg);
    return () => {
      const i = this.aheadRegs.indexOf(reg);
      if (i >= 0) this.aheadRegs.splice(i, 1);
    };
  }

  /** Dispatch every event with tMs <= nowMs that hasn't fired yet. Never skips. */
  dispatchUpTo(nowMs) {
    // Anticipation channel first: at any given call, the ahead listeners
    // must already know about everything the on-time listeners are about
    // to be told (lead >= 0 guarantees the ahead frontier never trails).
    for (const reg of this.aheadRegs) {
      const horizon = nowMs + reg.leadMs;
      while (reg.cursor < this.timeline.length && this.timeline[reg.cursor].tMs <= horizon) {
        const evt = this.timeline[reg.cursor++];
        if (reg.role === '*' || evt.role === reg.role) reg.fn(evt);
      }
    }
    while (this.cursor < this.timeline.length && this.timeline[this.cursor].tMs <= nowMs) {
      const evt = this.timeline[this.cursor++];
      this._emit(evt.role, evt);
      this._emit('*', evt);
    }
    while (this.barCursor < this.barGrid.length && this.barGrid[this.barCursor].ms <= nowMs) {
      const bar = this.barGrid[this.barCursor++];
      for (const fn of this.barListeners) fn(bar);
    }
  }

  _emit(key, evt) {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const fn of set) fn(evt);
  }

  /** Look-ahead peek without consuming — used by TelegraphScanner. */
  peekWindow(nowMs, windowMs) {
    const end = nowMs + windowMs;
    const out = [];
    for (let i = this.cursor; i < this.timeline.length && this.timeline[i].tMs <= end; i++) {
      if (this.timeline[i].tMs >= nowMs) out.push(this.timeline[i]);
    }
    return out;
  }

  reset() {
    this.cursor = 0;
    this.barCursor = 0;
    for (const reg of this.aheadRegs) reg.cursor = 0;
  }

  /**
   * Jump dispatch cursors to `ms` without re-firing past events.
   * Used by the mountain seekbar. Forward seeks skip silently; reverse
   * seeks rewind cursors so future notes still fire once.
   */
  seekTo(ms, { primeAhead = false } = {}) {
    const t = Math.max(0, ms);
    // On-time cursor: first event strictly after t
    let lo = 0, hi = this.timeline.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.timeline[m].tMs <= t) lo = m + 1; else hi = m;
    }
    this.cursor = lo;
    lo = 0; hi = this.barGrid.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.barGrid[m].ms <= t) lo = m + 1; else hi = m;
    }
    this.barCursor = lo;
    for (const reg of this.aheadRegs) {
      const horizon = primeAhead ? t : t + reg.leadMs;
      let a = 0, b = this.timeline.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if (this.timeline[m].tMs <= horizon) a = m + 1; else b = m;
      }
      reg.cursor = a;
    }
  }

  /** Nearest event (already-fired or upcoming) matching predicate, within +/-windowMs of nowMs. */
  nearestEventMs(predicate, nowMs, windowMs) {
    let lo = 0, hi = this.timeline.length - 1, idx = this.timeline.length;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.timeline[m].tMs >= nowMs) { idx = m; hi = m - 1; } else lo = m + 1;
    }
    let best = null, bestDist = Infinity;
    for (let i = idx; i < this.timeline.length && this.timeline[i].tMs <= nowMs + windowMs; i++) {
      const e = this.timeline[i];
      if (!predicate(e)) continue;
      const d = Math.abs(e.tMs - nowMs);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    for (let i = idx - 1; i >= 0 && this.timeline[i].tMs >= nowMs - windowMs; i--) {
      const e = this.timeline[i];
      if (!predicate(e)) continue;
      const d = Math.abs(e.tMs - nowMs);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    return best;
  }
}
