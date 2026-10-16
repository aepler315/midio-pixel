// Automatic in-game latency calibration. A player who is STEADY in the time
// between beats but always ~30ms late is not sloppy — that's the audio/input
// pipeline's latency, and it should be absorbed, not scored. This watches
// the judged hit offsets flowing out of TapJudge (which are computed AFTER
// the current calibration offset is applied — a closed loop) and, whenever
// a window of taps is tight (low MAD) but biased (median off the deadband),
// shifts the input offset to cancel most of the bias. Jittery windows are
// ignored: that's the player, not the pipeline.
import { clamp } from '../utils/math.js';

export const CAL_WINDOW = 10;      // judged hits per evaluation
export const STEADY_MAD_MS = 22;   // window MAD above this = jitter, don't touch
export const DEADBAND_MS = 12;     // bias below this isn't worth chasing
export const MAX_OFFSET_MS = 120;  // sanity rail on total correction
const CORRECTION_GAIN = 0.7;       // cancel most of the bias, not all — converge, don't oscillate

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class LatencyCalibrator {
  /** @param {number} initialOffsetMs persisted offset from a previous
   *  session / the calibration screen; applied by main.js at stamp time. */
  constructor(initialOffsetMs = 0) {
    this.offsetMs = clamp(initialOffsetMs, -MAX_OFFSET_MS, MAX_OFFSET_MS);
    this._buf = [];
    /** One-shot-ish: set to {byMs, medianMs} whenever an adjustment lands;
     *  consumers may clear it after reacting (HUD toast, persistence). */
    this.lastAdjustment = null;
  }

  /** Feed every judged hit/holdStart offset (ms, + = late). */
  onJudgedHit(offsetMs) {
    if (offsetMs == null || !Number.isFinite(offsetMs)) return;
    this._buf.push(offsetMs);
    if (this._buf.length < CAL_WINDOW) return;
    const med = median(this._buf);
    const mad = median(this._buf.map((x) => Math.abs(x - med)));
    // Evaluated windows never overlap: post-adjustment offsets must not be
    // averaged with pre-adjustment ones, and a jittery window should be
    // judged fresh rather than dragging its outliers along.
    this._buf.length = 0;
    if (mad > STEADY_MAD_MS || Math.abs(med) < DEADBAND_MS) return;
    const by = -med * CORRECTION_GAIN;
    const next = clamp(this.offsetMs + by, -MAX_OFFSET_MS, MAX_OFFSET_MS);
    if (next === this.offsetMs) return;
    this.lastAdjustment = { byMs: next - this.offsetMs, medianMs: med };
    this.offsetMs = next;
  }
}

/**
 * The calibration screen's math: taps against a bare metronome. Robust to
 * a stray tap — trims the most extreme quartile before taking the median.
 * @param {number[]} tapOffsetsMs raw (tap - beat) offsets, + = late
 * @returns {number|null} the INPUT offset to store (negated bias), or null
 *   when there aren't enough taps to trust
 */
export function computeCalibrationOffset(tapOffsetsMs) {
  if (!tapOffsetsMs || tapOffsetsMs.length < 4) return null;
  const med0 = median(tapOffsetsMs);
  const sorted = [...tapOffsetsMs].sort((a, b) => Math.abs(a - med0) - Math.abs(b - med0));
  const kept = sorted.slice(0, Math.max(4, Math.ceil(sorted.length * 0.75)));
  return clamp(-median(kept), -MAX_OFFSET_MS, MAX_OFFSET_MS);
}
