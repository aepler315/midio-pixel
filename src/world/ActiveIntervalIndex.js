// Immutable interval-end maxima. Callers first exclude future note onsets,
// then enumerate live intervals backwards without walking expired history.
// This keeps floating-point accumulation in the original note order.
/** Upper bound for the original `spanMs - (timeMs - startMs)` residual.
 * Addition/subtraction round differently near a fractional release. Index
 * with a slightly conservative end, then let the original residual decide
 * whether an enumerated note contributes. This margin is at least one ULP
 * of the positive, finite sum; it changes search candidates, never weights. */
export function conservativeIntervalEnd(startMs, spanMs) {
  const end = startMs + spanMs;
  return Number.isFinite(end) ? end + Math.max(Number.MIN_VALUE, Math.abs(end) * Number.EPSILON) : end;
}

export class ActiveIntervalIndex {
  #maxEnd; #leaves; #length;

  constructor(endTimes) {
    this.#length = endTimes.length;
    this.#leaves = 1;
    while (this.#leaves < this.#length) this.#leaves *= 2;
    this.#maxEnd = new Float64Array(this.#leaves * 2).fill(-Infinity);
    // A malformed interval cannot hide other notes in its tree branch.
    // Caller-owned prefix guards retain any legacy malformed-input policy.
    for (let i = 0; i < this.#length; i++) this.#maxEnd[this.#leaves + i] = Number.isNaN(endTimes[i]) ? -Infinity : endTimes[i];
    for (let i = this.#leaves - 1; i > 0; i--) this.#maxEnd[i] = Math.max(this.#maxEnd[i * 2], this.#maxEnd[i * 2 + 1]);
  }

  /** Latest index below `before` whose interval ends strictly after timeMs.
   * The caller's onset upper bound owns start-time inclusion. Queries have
   * no cursor or mutation, so pauses and arbitrary seeks use the same tree. */
  lastBefore(before, timeMs) {
    const limit = Math.min(this.#length, Math.max(0, Math.floor(before)));
    if (!(limit > 0)) return -1;
    return this.#find(1, 0, this.#leaves, limit, timeMs);
  }

  #find(node, start, end, limit, timeMs) {
    if (start >= limit || !(this.#maxEnd[node] > timeMs)) return -1;
    if (end - start === 1) return start;
    const mid = (start + end) / 2;
    const right = this.#find(node * 2 + 1, mid, end, limit, timeMs);
    return right >= 0 ? right : this.#find(node * 2, start, mid, limit, timeMs);
  }
}
