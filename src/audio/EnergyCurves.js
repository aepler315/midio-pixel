// Continuous per-band energy signal, sampled at a fixed rate across the
// whole song and linearly interpolated at query time. This is the
// continuous counterpart to the discrete NoteEvent timeline — Broshi's
// frequency->anatomy mapping and the Rabid morph (spec §3.2) read raw
// band energy directly rather than discrete notes, and both the real
// audio pipeline (Stage 4) and the MIDI/demo synthesis path (spec's
// "MIDI and audio become indistinguishable downstream" philosophy)
// populate this same shape.
import { clamp, clamp01 } from '../utils/math.js';
import { BANDS, RABID_WEIGHTS } from './bands.js';

// Song-relative calibration (globalEnergyNorm). The raw global energy is an
// ABSOLUTE weighted band mean, so every threshold downstream (CalmDirector's
// 0.25/0.55, HypeDirector's drop delta, Broshi's rabid gate...) was really
// asking "is this track loud?" rather than "is this the loud part OF THIS
// track?". A brickwalled master sat pinned above every gate and a quiet one
// never crossed any. These map the song's own p10..p90 onto a fixed span so
// the same question means the same thing on every song.
const CAL_LO_PCT = 0.10, CAL_HI_PCT = 0.90;
const NORM_LO = 0.15, NORM_HI = 0.85; // headroom: a true peak still reads above p90
// Below this p10..p90 spread the song genuinely has no dynamics (compressed
// wall-of-sound, a drone, a test tone). Stretching THAT to full scale would
// manufacture drops out of noise, so the normalization fades back out toward
// the raw absolute value instead -- a flat song degrades to the old behavior
// rather than hallucinating structure.
export const FLAT_SPREAD_MIN = 0.08;

export class EnergyCurves {
  constructor(durationMs, rateHz = 50) {
    this.rateHz = rateHz;
    this.n = Math.max(2, Math.ceil((durationMs / 1000) * rateHz) + 1);
    this.bands = Array.from({ length: BANDS.length }, () => new Float32Array(this.n));
    /** Lazy per-weight-vector percentile cache, keyed by the weights. Built on
     *  first query and invalidated by setFrame (the builders fill every frame
     *  before anything samples, so in practice it's computed exactly once). */
    this._calCache = new Map();
    // bands: normalized activity; rmsBands: physical filter-bank RMS amplitude.
    this.rmsBands = null;
  }

  _indexAt(tMs) {
    return clamp((tMs / 1000) * this.rateHz, 0, this.n - 1);
  }

  sample(bandIndex, tMs) {
    const idx = this._indexAt(tMs);
    const i0 = Math.floor(idx);
    const i1 = Math.min(this.n - 1, i0 + 1);
    const f = idx - i0;
    const arr = this.bands[bandIndex];
    return arr[i0] * (1 - f) + arr[i1] * f;
  }

  sampleRms(bandIndex, tMs) {
    if (!this.rmsBands) return null;
    const idx = this._indexAt(tMs), lo = Math.floor(idx), hi = Math.min(this.n - 1, lo + 1);
    const f = idx - lo, arr = this.rmsBands[bandIndex];
    return arr[lo] * (1 - f) + arr[hi] * f;
  }

  powerShares(tMs) {
    if (!this.rmsBands) return null;
    const powers = this.rmsBands.map((_, band) => this.sampleRms(band, tMs) ** 2);
    const sum = powers.reduce((a,b) => a+b, 0);
    return powers.map(p => sum > 1e-12 ? p / sum : 0);
  }

  sampleAll(tMs) {
    const out = new Array(BANDS.length);
    for (let b = 0; b < BANDS.length; b++) out[b] = this.sample(b, tMs);
    return out;
  }

  /** Weighted mean across bands — used for Broshi's Rabid gate (spec §3.2.3). */
  globalEnergy(tMs, weights = RABID_WEIGHTS) {
    let sum = 0, wsum = 0;
    for (let b = 0; b < BANDS.length; b++) {
      sum += weights[b] * this.sample(b, tMs);
      wsum += weights[b];
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  /** The song's own p10/p90 of `globalEnergy` under these weights, plus the
   *  spread between them. Computed once per weight vector over every frame
   *  (~12k samples for a 4-minute song) and cached. */
  calibration(weights = RABID_WEIGHTS) {
    const key = weights.join(',');
    const hit = this._calCache.get(key);
    if (hit) return hit;

    let wsum = 0;
    for (let b = 0; b < BANDS.length; b++) wsum += weights[b];
    const vals = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let sum = 0;
      for (let b = 0; b < BANDS.length; b++) sum += weights[b] * this.bands[b][i];
      vals[i] = wsum > 0 ? sum / wsum : 0;
    }
    vals.sort();
    const at = (p) => vals[clamp(Math.round(p * (this.n - 1)), 0, this.n - 1)];
    const lo = at(CAL_LO_PCT);
    const hi = at(CAL_HI_PCT);
    const cal = { lo, hi, spread: Math.max(0, hi - lo) };
    this._calCache.set(key, cal);
    return cal;
  }

  /**
   * Global energy expressed against the song's OWN dynamic range: the track's
   * p10 maps to NORM_LO and its p90 to NORM_HI, so "0.55" means the same
   * musical thing on a whisper-quiet folk record and a mastered-to-ceiling
   * club track. On a song with no real dynamics (see FLAT_SPREAD_MIN) it
   * blends back toward the raw absolute value rather than amplifying noise.
   */
  globalEnergyNorm(tMs, weights = RABID_WEIGHTS) {
    const raw = this.globalEnergy(tMs, weights);
    const { lo, spread } = this.calibration(weights);
    if (spread <= 1e-9) return clamp01(raw);
    const scaled = NORM_LO + ((raw - lo) / spread) * (NORM_HI - NORM_LO);
    if (spread >= FLAT_SPREAD_MIN) return clamp01(scaled);
    // Partially-flat song: fade the stretch in with the spread so there is no
    // discontinuity at the threshold.
    const trust = spread / FLAT_SPREAD_MIN;
    return clamp01(raw + trust * (scaled - raw));
  }

  /** Write a single sample frame — used by both the audio and synthesis builders. */
  setFrame(frameIndex, values) {
    for (let b = 0; b < BANDS.length; b++) this.bands[b][frameIndex] = values[b];
    if (this._calCache.size) this._calCache.clear(); // frames changed; percentiles are stale
  }
}
