// Frame delivery evidence for device runs (tools/range-device-probe.js).
// A requestAnimationFrame callback is not a frame the listener saw: an FPS
// cap skips draws, a failed presentation shows the previous image, and a
// paused or hidden page is not playback. Each sample says which presented
// frame (generation, frameId) was on screen at that callback, so callback
// cadence and successfully presented frames are summarized separately.
//
// Sample: { wallMs, generation, frameId, presented, paused, hidden, capFps }.
// - A repeated (generation, frameId) is the same frame, not a new one.
// - Pause, hidden and generation boundaries break both interval chains, so
//   resuming never counts the whole gap as one interval.
// - A failed presentation (presented: false while playing) is counted; the
//   frozen picture it causes stays inside the next delivered interval.
// Range render/copy timings elsewhere in the probe are CPU submission and
// copy times, not GPU completion; nothing here measures the GPU either.

/** Bounded interval store: past `max` values it keeps every other sample
 *  and doubles its stride, so a ten-minute run stays small and the kept
 *  values remain spread over the whole run. Count, max and stalls are exact. */
class Intervals {
  constructor(max) { this.max = Math.max(2, max | 0); this.values = []; this.stride = 1; this.seen = 0; this.count = 0; this.sum = 0; this.maxMs = 0; this.stalls = 0; this.truncated = false; }
  push(ms) {
    this.count++; this.sum += ms; this.maxMs = Math.max(this.maxMs, ms); if (ms > 100) this.stalls++;
    if (this.seen++ % this.stride) return;
    this.values.push(ms);
    if (this.values.length >= this.max) {
      this.values = this.values.filter((_, i) => i % 2 === 0);
      this.stride *= 2;
      this.truncated = true;
    }
  }
  summary() {
    if (!this.count) return null;
    const s = [...this.values].sort((a, b) => a - b);
    const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
    return { frames: this.count, intervals: this.values.length, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99),
      maxMs: +this.maxMs.toFixed(2), stallsOver100ms: this.stalls, fps: +(1000 * this.count / this.sum).toFixed(2) };
  }
}

export class FrameDeliveryAggregator {
  constructor({ maxIntervals = 20000 } = {}) {
    this.callbacks = new Intervals(maxIntervals);
    this.delivered = new Intervals(maxIntervals);
    this.deliveredFrames = 0; this.repeatedFrames = 0; this.failedPresentations = 0; this.generationChanges = 0;
    this.excluded = { paused: 0, hidden: 0 };
    this.caps = new Set();
    this._lastCallback = null; this._lastFrame = null; this._generation = undefined;
  }

  _break() { this._lastCallback = null; this._lastFrame = null; }

  push(sample) {
    const { wallMs, generation, frameId, presented, paused, hidden, capFps } = sample;
    if (generation !== this._generation) {
      if (this._generation !== undefined) this.generationChanges++;
      this._generation = generation;
      this._break();
    }
    if (hidden || paused) {
      this.excluded[hidden ? 'hidden' : 'paused']++;
      this._break();
      return;
    }
    if (capFps != null) this.caps.add(Number.isFinite(capFps) ? +(+capFps).toFixed(2) : null);
    if (this._lastCallback != null) this.callbacks.push(wallMs - this._lastCallback);
    this._lastCallback = wallMs;
    if (!presented) { this.failedPresentations++; return; }
    if (this._lastFrame && this._lastFrame.frameId === frameId) { this.repeatedFrames++; return; }
    this.deliveredFrames++;
    if (this._lastFrame) this.delivered.push(wallMs - this._lastFrame.wallMs);
    this._lastFrame = { wallMs, frameId };
  }

  summary() {
    return { callbacks: this.callbacks.summary(), delivered: this.delivered.summary(),
      deliveredFrames: this.deliveredFrames, repeatedFrames: this.repeatedFrames, failedPresentations: this.failedPresentations,
      generationChanges: this.generationChanges, excluded: { ...this.excluded },
      capFps: [...this.caps].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)),
      truncated: this.callbacks.truncated || this.delivered.truncated };
  }
}

/** Pure summary of an ordered sample list. */
export function summarizeFrameDelivery(samples, options) {
  const agg = new FrameDeliveryAggregator(options);
  for (const s of samples || []) agg.push(s);
  return agg.summary();
}
