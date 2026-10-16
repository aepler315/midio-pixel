// Paces the double-jump budget to the song's phrase structure: a tap while
// airborne spends one air jump from the current phrase's allowance, and the
// allowance refills on every 4-/8-measure phrase boundary (PhraseTracker).
// The chain is a sequence, not a hover button: each successive air jump in
// a phrase is a little smaller, except the last one — the phrase's flourish
// — which spikes. Never forever: budget spent means feet-first physics
// until the next phrase begins.
export const BUDGET_4BAR = 2;
export const BUDGET_8BAR = 4;
const DECAY_PER_JUMP = 0.85;
const FLOURISH_MUL = 1.35;

export class AirJumpSequencer {
  /** @param {import('../core/PhraseTracker.js').PhraseTracker|null} phrases */
  constructor(phrases) {
    this.phrases = phrases;
    this._phraseKey = -1;
    this.used = 0;
  }

  get budget() {
    return this.phrases && this.phrases.phraseLenBars >= 8 ? BUDGET_8BAR : BUDGET_4BAR;
  }

  /** Air jumps left in the current phrase (rolls the phrase forward first). */
  remainingAt(tMs) {
    this._rollPhrase(tMs);
    return Math.max(0, this.budget - this.used);
  }

  /**
   * Spend one air jump at tMs. Returns {index, boostMul, isFlourish} or
   * null when the phrase's budget is exhausted.
   */
  tryConsume(tMs) {
    this._rollPhrase(tMs);
    if (this.used >= this.budget) return null;
    const index = this.used++;
    const isFlourish = index === this.budget - 1;
    const boostMul = isFlourish ? FLOURISH_MUL : Math.pow(DECAY_PER_JUMP, index);
    return { index, boostMul, isFlourish };
  }

  /** Undo the last consume — the jump controller declined (already landed). */
  refund() {
    this.used = Math.max(0, this.used - 1);
  }

  _rollPhrase(tMs) {
    const key = this.phrases ? this.phrases.infoAt(tMs).phraseIdx : 0;
    if (key !== this._phraseKey) {
      this._phraseKey = key;
      this.used = 0;
    }
  }
}
