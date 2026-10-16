// Draw failures, counted and surfaced instead of silently swallowed.
//
// The frame loop wraps Renderer.draw in a try/catch, and it should: one bad
// frame must not freeze the run. But the catch only ever reached
// console.error, which in practice means nobody sees it -- two whole visual
// effects (the hype echo and the drop-impact pack) threw on every invocation
// for months, taking the rest of each affected frame with them, and the only
// evidence was a console line that the smoke tests had learned to filter out
// by regex.
//
// So: keep catching, but make it impossible to miss. Every failure is
// counted and the tally is shown in the debug readout, and the console
// logging is de-duplicated so a per-frame throw reports its scale instead of
// flooding the console into uselessness (a wall of ten thousand identical
// lines is its own kind of invisible).
//
// Pure: no DOM, no clock of its own. The caller supplies timestamps.

/** Log on the 1st, 2nd, 4th, 8th... occurrence -- a persistent failure
 *  reports about log2(n) times, so it stays legible whether it happened
 *  once or ten thousand times. */
function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

export class DrawErrorLog {
  constructor() {
    /** message -> { count, firstMs, lastMs } */
    this.byMessage = new Map();
    this.total = 0;
  }

  /**
   * Record one failure.
   * @returns {boolean} whether the caller should actually log this one.
   */
  record(err, nowMs = 0) {
    const msg = String((err && err.message) || err || 'unknown');
    this.total++;
    let entry = this.byMessage.get(msg);
    if (!entry) {
      entry = { count: 0, firstMs: nowMs, lastMs: nowMs };
      this.byMessage.set(msg, entry);
    }
    entry.count++;
    entry.lastMs = nowMs;
    return isPowerOfTwo(entry.count);
  }

  /** The worst offender, or null when nothing has failed. */
  get worst() {
    let worst = null;
    for (const [message, e] of this.byMessage) {
      if (!worst || e.count > worst.count) worst = { message, ...e };
    }
    return worst;
  }

  /** One line for the debug readout, or null when the frame loop is healthy. */
  get summary() {
    const w = this.worst;
    if (!w) return null;
    const kinds = this.byMessage.size;
    const head = `${this.total} draw error${this.total === 1 ? '' : 's'}`;
    const detail = `${w.count}x ${w.message.slice(0, 88)}`;
    return kinds > 1 ? `${head} (${kinds} kinds)  ${detail}` : `${head}  ${detail}`;
  }

  reset() {
    this.byMessage.clear();
    this.total = 0;
  }
}
