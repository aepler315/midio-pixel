import { clamp01 } from '../utils/math.js';

/**
 * Turn detected rhythm events into a small, serializable description for
 * consumers that need musical activity rather than terrain-derived proxies.
 * `pulseRegularity` only makes a claim when the tempo detector has earned
 * confidence; free-time material keeps its event density but has no invented
 * metrical pulse.
 */
export function summarizeRhythmOnsets(onsets, durationMs, {
  beatPeriodMs = 0,
  confidence = 0,
} = {}) {
  const events = Array.isArray(onsets)
    ? onsets.filter((event) => Number.isFinite(event?.tMs))
    : [];
  const seconds = Math.max(1e-3, (durationMs || 0) / 1000);
  const eventRateHz = events.length / seconds;
  const kicks = events.filter((event) => event.kick);
  const kickShare = events.length ? kicks.length / events.length : 0;
  const tempoConfidence = Number.isFinite(confidence) ? clamp01(confidence) : 0;
  const usableBeat = Number.isFinite(beatPeriodMs) && beatPeriodMs > 0;

  let pulseRegularity = 0;
  if (usableBeat && tempoConfidence > 0 && kicks.length >= 4) {
    const intervals = kicks.slice(1).map((e,i) => e.tMs - kicks[i].tMs).filter(d => d > 0);
    const base = [...intervals].sort((a,b) => a-b)[intervals.length >> 1];
    // Compare local interval ratios, so a 2ms tempo bias never accumulates
    // into four minutes of apparent phase scatter. Multiples/subdivisions
    // share the pulse; a fill can be busy without being metrically irregular.
    const nearestRatio = r => Math.min(...[.25,.5,1,1.5,2,3,4].map(q => Math.abs(r-q)/q));
    const error = intervals.reduce((sum,d) => sum + nearestRatio(d/base), 0) / Math.max(1, intervals.length);
    const meterError = nearestRatio(base / beatPeriodMs);
    pulseRegularity = clamp01(Math.exp(-8 * error - 4 * meterError) * tempoConfidence);
  }

  return {
    eventRateHz,
    eventDensity: clamp01(eventRateHz / 4),
    kickShare,
    pulseRegularity,
    confidence: usableBeat ? tempoConfidence : 0,
  };
}
