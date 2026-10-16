// Groups the bar grid into musical phrases — the 4- or 8-measure units
// songs actually breathe in. The analysis upgrade: rather than assuming
// every song phrases in 4s, the per-bar energy profile is autocorrelated at
// 4- and 8-bar lags, and the song is grouped in 8s when its energy actually
// repeats on the longer cycle (verse/chorus-scale writing). Downstream this
// paces the air-jump sequence (AirJumpSequencer) so double-jump chains
// replenish on phrase boundaries instead of accumulating forever.
export const PHRASE_CHOICES = [4, 8];
const CORR_MARGIN = 0.05; // 8-bar grouping must beat 4-bar by this much

export class PhraseTracker {
  /**
   * @param {Array<{ms:number}>} barGrid downbeat times from the adapter
   * @param {import('../audio/EnergyCurves.js').EnergyCurves|null} energyCurves
   */
  constructor(barGrid, energyCurves = null) {
    this.barMs = (barGrid || []).map((b) => b.ms);
    this.phraseLenBars = choosePhraseLength(this.barMs, energyCurves);
    // Fallback period for bar-less songs (free-time audio): one nominal
    // phrase = phraseLenBars bars of 4 beats at 120 BPM.
    this.fallbackPhraseMs = this.phraseLenBars * 4 * 500;
  }

  /** Phrase coordinates at a song time. Monotone-safe for any tMs. */
  infoAt(tMs) {
    if (this.barMs.length === 0) {
      const phraseIdx = Math.max(0, Math.floor(tMs / this.fallbackPhraseMs));
      return { barIdx: -1, phraseIdx, barInPhrase: 0, phraseLenBars: this.phraseLenBars };
    }
    // Last bar with ms <= tMs (binary search); before the first bar counts as bar 0.
    let lo = 0, hi = this.barMs.length - 1, barIdx = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.barMs[m] <= tMs) { barIdx = m; lo = m + 1; } else hi = m - 1;
    }
    return {
      barIdx,
      phraseIdx: Math.floor(barIdx / this.phraseLenBars),
      barInPhrase: barIdx % this.phraseLenBars,
      phraseLenBars: this.phraseLenBars,
    };
  }
}

/**
 * 4 or 8, from the per-bar energy profile. Needs at least two full 8-bar
 * cycles of material to even consider 8; otherwise 4 is the safe musical
 * default.
 */
export function choosePhraseLength(barMs, energyCurves) {
  if (!energyCurves || barMs.length < 17) return 4;
  const e = perBarEnergy(barMs, energyCurves);
  const c4 = autocorrAtLag(e, 4);
  const c8 = autocorrAtLag(e, 8);
  return c8 > c4 + CORR_MARGIN ? 8 : 4;
}

function perBarEnergy(barMs, energyCurves) {
  const n = barMs.length;
  const out = new Float32Array(n);
  const lastSpan = n > 1 ? barMs[n - 1] - barMs[n - 2] : 2000;
  for (let i = 0; i < n; i++) {
    const from = barMs[i];
    const to = i + 1 < n ? barMs[i + 1] : from + lastSpan;
    let s = 0;
    const K = 4;
    for (let k = 0; k < K; k++) s += energyCurves.globalEnergy(from + ((to - from) * (k + 0.5)) / K);
    out[i] = s / K;
  }
  return out;
}

/** Normalized (Pearson) autocorrelation of x at an integer lag, in [-1, 1]. */
export function autocorrAtLag(x, lag) {
  const n = x.length - lag;
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += x[i]; mb += x[i + lag]; }
  ma /= n; mb /= n;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - ma, b = x[i + lag] - mb;
    num += a * b; va += a * a; vb += b * b;
  }
  const den = Math.sqrt(va * vb);
  return den > 1e-9 ? num / den : 0;
}
