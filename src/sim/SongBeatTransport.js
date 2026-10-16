// Source-owned quarter-note transport. Accent spacing never changes meter.
// Piecewise tempo integration is deterministic across pause and seek.
const finite = (x) => Number.isFinite(x);
function indexAt(items, timeMs, key) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid][key] <= timeMs) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}

export class SongBeatTransport {
  constructor({ bpm = 120, beatPeriodMs, confidence, freeTime = false, firstBarMs, barGrid = [], localTempo = [], authored = false } = {}) {
    const period = beatPeriodMs > 0 ? beatPeriodMs : 60000 / (bpm > 0 ? bpm : 120);
    this.confidence = finite(confidence) ? Math.min(1, Math.max(0, confidence)) : authored ? 1 : 0;
    this.freeTime = !!freeTime;
    this.originMs = finite(firstBarMs) ? firstBarMs : barGrid[0]?.ms ?? 0;
    this.meters = barGrid.filter(b => finite(b.ms)).map(b => ({ ...b })).sort((a, b) => a.ms - b.ms);
    const supplied = localTempo.filter(s => finite(s.tMs) && s.tMs >= 0 && s.beatPeriodMs > 0)
      .map(s => ({ ...s, beatPeriodMs: finite(s.confidence) && s.confidence < .2 ? period : s.beatPeriodMs }))
      .sort((a, b) => a.tMs - b.tMs);
    this.segments = [{ tMs: 0, beatPeriodMs: period }];
    for (const s of supplied) {
      if (s.tMs === this.segments.at(-1).tMs) this.segments[this.segments.length - 1] = s;
      else this.segments.push(s);
    }
    let beat = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i], prev = this.segments[i - 1];
      if (prev) beat += (s.tMs - prev.tMs) / prev.beatPeriodMs;
      s.beat = beat;
    }
    this.originBeat = this._beatAt(this.originMs);
  }

  _beatAt(tMs) {
    const s = this.segments[indexAt(this.segments, tMs, 'tMs')];
    return s.beat + (tMs - s.tMs) / s.beatPeriodMs;
  }

  snapshotAt(tMs) {
    const s = this.segments[indexAt(this.segments, tMs, 'tMs')];
    const beat = this._beatAt(tMs) - this.originBeat;
    const meter = this.meters.length ? this.meters[indexAt(this.meters, tMs, 'ms')] : null;
    return Object.freeze({
      timeMs: tMs, periodMs: s.beatPeriodMs, beatIndex: Math.floor(beat),
      phase01: this.freeTime ? 0 : beat - Math.floor(beat),
      anchorMs: s.tMs - (s.beat - this.originBeat) * s.beatPeriodMs,
      confidence: this.freeTime ? 0 : s.confidence ?? this.confidence,
      freeTime: this.freeTime, numerator: meter?.numerator ?? 4, denominator: meter?.denominator ?? 4,
    });
  }
}
