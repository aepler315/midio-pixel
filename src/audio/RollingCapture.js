// The last few seconds of what the microphone heard, as samples.
//
// Recognising a song needs TIME-DOMAIN audio, not the frequency frames the
// live analyser already pulls. That is not a preference: the stored
// fingerprint is built from a 128ms Hann window at 8kHz on a fixed 16ms hop,
// and an AnalyserNode gives 42.7ms windows at the device rate on whatever
// irregular hop requestAnimationFrame happens to produce, with its own
// smoothing applied. Those are different algorithms, so they produce
// different bits, and a fingerprint only means anything when both sides
// computed it the same way.
//
// So the capture path hands raw samples to exactly the same routine that
// fingerprinted the file, and this is the buffer they land in: a ring, so a
// long listen costs a fixed amount of memory rather than growing without
// bound, and so "the last eight seconds" is always available without
// copying the whole session.
//
// Pure and free of Web Audio, so the wrap-around arithmetic -- the only part
// with any real chance of being wrong -- is testable in node.

/**
 * A fixed-length rolling window of the most recent samples.
 *
 * Writes are cheap and allocation-free; `read()` is the one that copies, and
 * only when a match is actually being attempted.
 */
export class RollingCapture {
  /**
   * @param {number} seconds how much history to keep
   * @param {number} sampleRate
   */
  constructor(seconds, sampleRate) {
    this.sampleRate = sampleRate;
    this.capacity = Math.max(1, Math.floor(seconds * sampleRate));
    this.buffer = new Float32Array(this.capacity);
    /** Where the next sample goes. */
    this.write = 0;
    /** Total samples ever written, so `filled` can distinguish a fresh
     *  buffer from a wrapped one. */
    this.written = 0;
  }

  /** How many samples are actually available (never more than capacity). */
  get filled() { return Math.min(this.written, this.capacity); }

  /** Seconds of audio held right now. */
  get seconds() { return this.filled / this.sampleRate; }

  /** Append samples, overwriting the oldest once full. */
  push(chunk) {
    if (!chunk || !chunk.length) return;
    const n = chunk.length;
    // A chunk longer than the whole ring can only leave its own tail behind,
    // so skip straight to that rather than writing the same slots repeatedly.
    const start = n > this.capacity ? n - this.capacity : 0;
    for (let i = start; i < n; i++) {
      this.buffer[this.write] = chunk[i];
      this.write = this.write + 1 === this.capacity ? 0 : this.write + 1;
    }
    this.written += n;
  }

  /**
   * The held samples, oldest first, as one contiguous array.
   *
   * A copy by necessity: the ring wraps, and every consumer (the FFT in the
   * fingerprint) wants a straight run.
   */
  read() {
    const n = this.filled;
    const out = new Float32Array(n);
    if (n === 0) return out;
    // Before the first wrap the data is simply the first `write` slots.
    if (this.written <= this.capacity) {
      out.set(this.buffer.subarray(0, n));
      return out;
    }
    const tail = this.capacity - this.write; // from write..end is the OLDEST
    out.set(this.buffer.subarray(this.write), 0);
    out.set(this.buffer.subarray(0, this.write), tail);
    return out;
  }

  /** Forget everything held, keeping the allocation. */
  reset() {
    this.write = 0;
    this.written = 0;
    this.buffer.fill(0);
  }
}
