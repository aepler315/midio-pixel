// The numeric score and end-of-song stats. Two running totals on purpose:
// `score` is the juicy number (multiplied by the combo multiplier), while
// `timingEarned` vs `maxPossible` is multiplier-free — accuracy can never
// exceed 100% and the grade measures pure timing, which is what the player
// was asked to be judged on.
export class ScoreKeeper {
  constructor(maxPossibleScore = 0) {
    this.maxPossible = maxPossibleScore;
    this.score = 0;
    this.timingEarned = 0;
    this.counts = { perfect: 0, great: 0, good: 0, sour: 0 };
    this.misses = 0;
    this.holdsCompleted = 0;
    this.holdsChoked = 0;
    this.peakStreak = 0;
  }

  /** @param evt a TapJudge stepEvent @param multiplier comboSystem.displayM */
  applyEvent(evt, multiplier = 1) {
    this.score += Math.round(evt.basePts * multiplier);
    this.timingEarned += evt.basePts;
    switch (evt.kind) {
      case 'hit':
      case 'holdStart':
        if (evt.tier) this.counts[evt.tier] += 1; // a late-armed hold (tier null) counts nowhere
        break;
      case 'sour': this.counts.sour += 1; break;
      case 'miss': this.misses += 1; break;
      case 'holdComplete': this.holdsCompleted += 1; break;
      case 'holdChoke': this.holdsChoked += 1; break;
      // holdTick: pure score, no tally
    }
  }

  /** The combo readout lies about "peak" today (it shows the live streak at
   * freeze); this records the real high-water mark. */
  noteStreak(streak) {
    if (streak > this.peakStreak) this.peakStreak = streak;
  }

  /** null when the song had nothing to judge (the UI shows an em dash). */
  get accuracyPct() {
    return this.maxPossible > 0 ? (this.timingEarned / this.maxPossible) * 100 : null;
  }

  get grade() {
    if (this.maxPossible <= 0) return null;
    const a = this.accuracyPct;
    if (a >= 95) return 'S';
    if (a >= 85) return 'A';
    if (a >= 70) return 'B';
    if (a >= 50) return 'C';
    return 'D';
  }
}
