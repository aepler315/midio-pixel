// Piecewise-linear cumulative tick -> millisecond table (spec §1.1.2).
// Flattens tempo ramps, metric modulations, and rubato-style tempo maps
// into absolute milliseconds once at load time; nothing downstream ever
// sees a tick.
export class TempoMap {
  /**
   * @param {{tick: number, usPerQN: number}[]} events sorted or unsorted tempo events
   * @param {number} ppqn ticks per quarter note
   */
  constructor(events, ppqn) {
    this.ppqn = ppqn;
    const sorted = [...events].sort((a, b) => a.tick - b.tick);
    this.seg = [{ tick: 0, us: 500000, ms: 0 }]; // default 120 BPM until first event
    let last = this.seg[0];
    for (const e of sorted) {
      if (e.tick === last.tick) {
        // Same-tick tempo change: replace, don't create a zero-length segment.
        last.us = e.usPerQN;
        continue;
      }
      const ms = last.ms + ((e.tick - last.tick) * last.us) / (ppqn * 1000);
      last = { tick: e.tick, us: e.usPerQN, ms };
      this.seg.push(last);
    }
  }

  /** Absolute tick -> absolute milliseconds. O(log n). */
  toMs(tick) {
    let lo = 0, hi = this.seg.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.seg[m].tick <= tick) lo = m; else hi = m - 1;
    }
    const s = this.seg[lo];
    return s.ms + ((tick - s.tick) * s.us) / (this.ppqn * 1000);
  }

  /** Inverse lookup, ms -> tick. Used for bar-grid alignment against wall clock. */
  toTick(ms) {
    let lo = 0, hi = this.seg.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.seg[m].ms <= ms) lo = m; else hi = m - 1;
    }
    const s = this.seg[lo];
    return s.tick + ((ms - s.ms) * this.ppqn * 1000) / s.us;
  }

  bpmAt(tick) {
    let lo = 0, hi = this.seg.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.seg[m].tick <= tick) lo = m; else hi = m - 1;
    }
    return 60000000 / this.seg[lo].us;
  }
}

/** SMPTE-mode division: fixed ms/tick, tempo meta events are ignored. */
export class SmpteTempoMap {
  constructor(fps, tpf) {
    this.msPerTick = 1000 / (fps * tpf);
  }
  toMs(tick) { return tick * this.msPerTick; }
  toTick(ms) { return ms / this.msPerTick; }
  bpmAt() { return null; }
}
