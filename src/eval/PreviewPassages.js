// Two comparable moments of a song: a quiet stretch and a peak stretch.
// Formerly the world chooser's preview passages; the chooser is gone with the
// Trio, and the world-quality evaluation keeps reading the same two moments.
import { clamp } from '../utils/math.js';

export const PREVIEW_SPAN_MS = 8000;

const EDGE = 0.08;
const STEP_MS = 200;
const WINDOW_MS = 1200;

/**
 * Two timestamps for a song: a quiet stretch and a peak stretch. Falls back
 * to proportional positions when there is no energy curve to read.
 */
export function pickPreviewPassages({ energyCurves = null, durationMs = 0 } = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const span = Math.min(PREVIEW_SPAN_MS, duration);
  if (duration <= 0) {
    return { quietMs: 0, peakMs: 0, durationMs: 0, spanMs: 0 };
  }
  const maxStart = Math.max(0, duration - span);
  let quietMs = clamp(duration * 0.15, 0, maxStart);
  let peakMs = clamp(duration * 0.52, 0, maxStart);

  const sample = energyCurves && typeof energyCurves.globalEnergyNorm === 'function'
    ? (t) => {
      let sum = 0, n = 0;
      for (let i = 0; i < WINDOW_MS / 200; i++) {
        const at = t + i * 200;
        if (at > duration) break;
        const v = energyCurves.globalEnergyNorm(at);
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      return n ? sum / n : 0;
    }
    : null;

  if (sample && duration > span + 1000) {
    const lo = duration * EDGE;
    const hi = Math.max(lo, duration * (1 - EDGE) - span);
    let minE = Infinity, maxE = -Infinity;
    for (let t = lo; t <= hi; t += STEP_MS) {
      const e = sample(t);
      if (e < minE) { minE = e; quietMs = t; }
      if (e > maxE) { maxE = e; peakMs = t; }
    }
    if (Math.abs(peakMs - quietMs) < span * 0.45) {
      const shifted = clamp(quietMs + span, 0, maxStart);
      if (Math.abs(shifted - quietMs) >= span * 0.45) peakMs = shifted;
      else quietMs = clamp(peakMs - span, 0, maxStart);
    }
  }

  return {
    quietMs: Math.round(quietMs),
    peakMs: Math.round(peakMs),
    durationMs: duration,
    spanMs: span,
  };
}
