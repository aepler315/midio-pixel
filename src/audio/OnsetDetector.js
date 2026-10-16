// Per-band RMS envelopes, spectral-flux onset detection/classification, and
// BPM/phase estimation (spec §1.2.3-1.2.5). Pure numeric — operates on
// decoded AudioBuffers from the StemSeparator, no DOM/graphics dependency.
import { BANDS, ONSET_WEIGHTS } from './bands.js';
import { clamp } from '../utils/math.js';

const WIN = 1024, HOP = 512;
// How much more like the player's low template than their high template an
// onset must look before the learned split overrides the fixed one. A real
// margin, not a hair: near the boundary the built-in rule is the safer answer.
const PROFILE_DECIDE_MARGIN = 0.12;
const MEDIAN_HALF_WINDOW = 43; // ~+-0.5s at ~86 frames/s
const MIN_ONSET_GAP_MS = 60;
const LOCAL_MAX_WINDOW_MS = 30;

/** RMS envelope of one band-limited AudioBuffer.  Channels are combined in
 *  power, rather than by averaging their signed samples: a stereo widening
 *  treatment can deliberately put a source in opposite phase left/right,
 *  and a signed mono mix would make a very audible band look like silence.
 *  Pulled out of computeBandEnvelopes so a caller processing stems one at a
 *  time (see AudioAdapter's streaming path) can compute each band's envelope
 *  and let the full-length buffer be released before rendering the next,
 *  rather than needing all of them decoded and resident at once purely to
 *  call one function. */
export function bandEnvelope(buf, numFrames) {
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const env = new Float32Array(numFrames);
  for (let n = 0; n < numFrames; n++) {
    const start = n * HOP;
    let sum = 0;
    for (let k = 0; k < WIN; k++) {
      let power = 0;
      for (let c = 0; c < chans.length; c++) {
        const s = chans[c][start + k] || 0;
        power += s * s;
      }
      sum += power / Math.max(1, chans.length);
    }
    env[n] = Math.sqrt(sum / WIN);
  }
  return env;
}

/** bandEnvelope, pausing for the browser whenever `maybeYield` (a
 *  createYielder check) says its time is up: the same arithmetic in the same
 *  order, so the same envelope. For an analysis running while a song plays
 *  (OpeningAnalysis.js), where a band's 0.2s in one piece is a dropped
 *  frame. */
export async function bandEnvelopeAsync(buf, numFrames, maybeYield) {
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const env = new Float32Array(numFrames);
  for (let n = 0; n < numFrames; n++) {
    if ((n & 255) === 0) await maybeYield();
    const start = n * HOP;
    let sum = 0;
    for (let k = 0; k < WIN; k++) {
      let power = 0;
      for (let c = 0; c < chans.length; c++) {
        const s = chans[c][start + k] || 0;
        power += s * s;
      }
      sum += power / Math.max(1, chans.length);
    }
    env[n] = Math.sqrt(sum / WIN);
  }
  return env;
}

/** How many analysis frames a buffer of this length yields, and the frame
 *  rate that follows from it -- the one thing every per-band envelope call
 *  must agree on, whether computed all at once or streamed one band at a
 *  time. */
export function envelopeFrameCount(length, sampleRate) {
  return { numFrames: Math.max(1, Math.floor((length - WIN) / HOP) + 1), rate: sampleRate / HOP };
}

/** Per-band RMS envelope at ~86 frames/s (44.1kHz/512) for every stem at
 *  once. Mixes each down to mono first. */
export function computeBandEnvelopes(stemBuffers) {
  const sampleRate = stemBuffers[0].sampleRate;
  const { numFrames, rate } = envelopeFrameCount(stemBuffers[0].length, sampleRate);
  const raw = stemBuffers.map((buf) => bandEnvelope(buf, numFrames));
  return { rate, numFrames, raw, sampleRate };
}

/** Slow-release running-max AGC normalization (spec §1.2.3): attack instant, release tau=4s. */
export function normalizeBands(raw, rate, tau = 4) {
  const release = Math.exp(-1 / (rate * tau));
  return raw.map((env) => {
    const norm = new Float32Array(env.length);
    let m = 1e-6;
    for (let n = 0; n < env.length; n++) {
      m = Math.max(env[n], m * release);
      norm[n] = env[n] / Math.max(m, 1e-6);
    }
    return norm;
  });
}

/**
 * Per-band global loudness reference (95th percentile of the raw, un-AGC'd
 * envelope) -- the "how loud does this band actually get across the whole
 * song" scale that EnergyCurves needs. normalizeBands' running-max AGC
 * deliberately erases this (a quiet intro decays the follower down to its
 * own peak and reads full-scale; a loud chorus does the same and reads no
 * louder), which is exactly right for onset DETECTION (loud and quiet
 * passages must drive the flux detector identically) but wrong for
 * anything that's supposed to answer "how energetic is the song right
 * now" -- CalmDirector, HypeDirector, the section/biome schedule, the
 * mountain groove, etc. all want TRUE relative loudness.
 *
 * A band that's nearly silent all song (say, no content above 8kHz) would
 * otherwise have its noise floor's 95th percentile treated as "loud for
 * this band" and read full-scale on the faintest hiss; floored at 25% of
 * the loudest band's reference so a near-empty band can't claim more
 * relative gain than a quarter of what the song's dominant band earns.
 */
export function globalBandReferences(raw) {
  const p95s = raw.map((env) => {
    if (env.length === 0) return 1e-6;
    let peak = 0;
    for (const value of env) peak = Math.max(peak,value);
    const sorted = Float32Array.from(env.filter(v => v > Math.max(1e-7, peak * 1e-4))).sort();
    if (!sorted.length) return 1e-6;
    const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
    return Math.max(1e-6, sorted[idx]);
  });
  const maxP95 = Math.max(1e-6, ...p95s);
  return p95s.map((v) => Math.max(v, 0.25 * maxP95));
}

function positiveFlux(band) {
  const flux = new Float32Array(band.length);
  for (let i = 1; i < band.length; i++) flux[i] = Math.max(0, band[i] - band[i - 1]);
  return flux;
}

function weightedFluxSum(normBands, weights) {
  const n = normBands[0].length;
  const fluxes = normBands.map(positiveFlux);
  const O = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let b = 0; b < normBands.length; b++) s += weights[b] * fluxes[b][i];
    O[i] = s;
  }
  return O;
}

/**
 * A running median over a window that slides by exactly one element per
 * step, backed by one array kept sorted at all times. Each step removes the
 * value leaving the window and inserts the one entering it, each by binary
 * search + splice (O(log w) to locate, O(w) to shift) -- there is no reason
 * to re-copy and re-sort all ~87 elements of the window from scratch on
 * every one of a song's ~20000 analysis frames, three times over (rhythm
 * onsets plus both pseudo-lanes), which is what medianAdaptiveThreshold did.
 * The window is built incrementally (insert-only) for the first `halfWindow`
 * steps, then becomes slide (remove+insert) once it's full, matching the
 * asymmetric lo/hi clamping medianAdaptiveThreshold applies at both edges.
 */
class SlidingMedian {
  constructor() {
    this.sorted = [];
  }
  _indexOf(v) {
    // First index whose value is >= v (lower_bound) -- exact for insertion;
    // removal additionally trusts this points AT the value being removed,
    // which holds because every value ever inserted is removed at most once,
    // by the exact reference frame that added it.
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  insert(v) {
    this.sorted.splice(this._indexOf(v), 0, v);
  }
  remove(v) {
    this.sorted.splice(this._indexOf(v), 1);
  }
  median() {
    return this.sorted[this.sorted.length >> 1];
  }
}

function medianAdaptiveThreshold(O, halfWindow, onsetThreshold) {
  const delta = 0.02 * onsetThreshold;
  const lambda = 1.6 * onsetThreshold;
  const n = O.length;
  const theta = new Float32Array(n);
  const sm = new SlidingMedian();
  // Seed the very first window ([0, halfWindow]) by insertion.
  for (let k = 0; k <= Math.min(halfWindow, n - 1); k++) sm.insert(O[k]);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow), hi = Math.min(n - 1, i + halfWindow);
    if (i > 0) {
      // The window boundary that just moved past this step, relative to the
      // PREVIOUS i: an element leaves when its lo bound advanced past it, one
      // enters when this step's hi bound reaches a new index.
      const prevLo = Math.max(0, i - 1 - halfWindow);
      if (lo > prevLo) sm.remove(O[prevLo]);
      const prevHi = Math.min(n - 1, i - 1 + halfWindow);
      if (hi > prevHi) sm.insert(O[hi]);
    }
    theta[i] = delta + lambda * sm.median();
  }
  return theta;
}

function pickPeaks(O, theta, rate, minGapMs = MIN_ONSET_GAP_MS, localWindowMs = LOCAL_MAX_WINDOW_MS) {
  const n = O.length;
  const localWin = Math.max(1, Math.round((localWindowMs / 1000) * rate));
  const minGapFrames = (minGapMs / 1000) * rate;
  const onsets = [];
  let lastFrame = -Infinity;
  for (let i = 0; i < n; i++) {
    if (O[i] <= theta[i]) continue;
    let isLocalMax = true;
    for (let k = Math.max(0, i - localWin); k <= Math.min(n - 1, i + localWin); k++) {
      if (O[k] > O[i]) { isLocalMax = false; break; }
    }
    if (!isLocalMax) continue;
    if (i - lastFrame < minGapFrames) continue;
    onsets.push(i);
    lastFrame = i;
  }
  return onsets;
}

/**
 * @param {object|null} [profile] a GrooveFingerprint. Optional and null by
 *   default, so every existing caller classifies exactly as before. When
 *   supplied AND warm, the player's own low/high templates decide the split
 *   instead of the fixed shares.
 *
 * RHYTHM onsets classified into KICK/SNARE/HAT by band-energy dominance
 * (spec §1.2.4). Onset flux/threshold run on the AGC-normalized bands (loud
 * and quiet mixes drive the same detector identically), but "dominance"
 * must be judged on raw energy — per-band AGC deliberately erases each
 * band's absolute loudness, so a share computed from normalized values no
 * longer reflects true energy distribution (a mostly-silent band's noise
 * floor gets amplified to look as "loud" as a genuinely dominant one).
 */
export function detectRhythmOnsets(normBands, rawBands, rate, onsetThreshold = 1, profile = null) {
  const O = weightedFluxSum(normBands, ONSET_WEIGHTS);
  const theta = medianAdaptiveThreshold(O, MEDIAN_HALF_WINDOW, onsetThreshold);
  const frames = pickPeaks(O, theta, rate);

  const values = frames.map((i) => O[i]).sort((a, b) => a - b);
  const p95 = values.length ? Math.max(1e-6, values[Math.min(values.length - 1, Math.floor(0.95 * values.length))]) : 1;

  // The flux-based strength above (O[i]/p95) is deliberately AGC-relative --
  // it answers "how surprising was this onset against its OWN local
  // dynamic range", which is what makes detection work identically in a
  // whisper-quiet intro and a wall-of-sound chorus. But a jump's height and
  // the world's kick-driven flashes should also know the song's TRUE
  // loudness at that instant, or every onset (intro included) reads as a
  // full-strength hit. This blends in true relative loudness: a soft
  // section's kicks still register (never fully silenced -- floor 0.18x)
  // but a hard section's kicks earn their full punch on top.
  //
  // The floor used to sit at 0.5x, which meant a sharp accent inside a
  // genuinely quiet, tense passage (dense but soft orchestral writing --
  // the reported case, an "intense but subtle" section with no loud
  // moments at all) could still land Midio a half-height jump on flux
  // alone, reading as too energetic for music that's deliberately holding
  // back. Lower floor + heavier true-loudness weight keeps loud sections
  // at exactly the same punch (both terms agree there) while genuinely
  // quiet ones stay restrained.
  const refBands = globalBandReferences(rawBands);
  const refGlobalSum = refBands.reduce((a, b) => a + b, 0);

  const onsets = frames.map((i) => {
    let sum = 0;
    const e = new Array(rawBands.length);
    for (let b = 0; b < rawBands.length; b++) { e[b] = rawBands[b][i]; sum += e[b]; }
    const lowShare = sum > 0 ? (e[0] + e[1]) / sum : 0;
    const highShare = sum > 0 ? (e[5] + e[6]) / sum : 0;
    let type, pitch, kick = false;
    // The player's own templates win where they've earned it. `score` returns
    // null until enough roled taps exist, so a cold profile leaves the fixed
    // thresholds below completely untouched -- and even once warm, its say
    // scales with sample count, so nothing lurches mid-song. The fixed rule is
    // one set of numbers for every genre and every listener; what a drum'n'bass
    // track calls a kick and what a folk record does are not the same event.
    const learned = profile ? profile.score(e) : null;
    const margin = learned
      ? (learned.low * learned.lowStrength) - (learned.high * learned.highStrength)
      : 0;
    if (learned && Math.abs(margin) > PROFILE_DECIDE_MARGIN) {
      if (margin > 0) { type = 'KICK'; pitch = 36; kick = true; }
      else { type = 'HAT'; pitch = 42; }
    } else if (lowShare > 0.45) { type = 'KICK'; pitch = 36; kick = true; }
    else if (highShare > 0.40) { type = 'HAT'; pitch = 42; }
    else { type = 'SNARE'; pitch = 38; }
    const trueLoudness = refGlobalSum > 1e-9 ? clamp(sum / refGlobalSum, 0, 1) : 0;
    const vel = clamp((O[i] / p95) * (0.18 + 0.82 * trueLoudness), 0, 1);
    return { frame: i, tMs: (i / rate) * 1000, type, pitch, kick, vel };
  });

  return { O, onsets };
}

/** r-hat(tau) for an arbitrary lag, used both inside the search window and for harmonic disambiguation. */
function correlationAt(Obar, r0, tau) {
  const n = Obar.length;
  if (tau < 1 || tau >= n) return -1;
  let r = 0;
  for (let i = 0; i + tau < n; i++) r += Obar[i] * Obar[i + tau];
  return r / r0;
}

/**
 * The autocorrelation search must inspect integer frame lags, but the peak
 * itself is almost never exactly on a frame.  Fit a parabola through the
 * winning lag and its neighbours so the beat period remains fractional when
 * the bar grid is walked for minutes. Phase scoring keeps this fractional
 * period too; rounding a comb would introduce a duration-dependent error.
 */
function refineCorrelationPeak(Obar, r0, tau) {
  const left = correlationAt(Obar, r0, tau - 1);
  const center = correlationAt(Obar, r0, tau);
  const right = correlationAt(Obar, r0, tau + 1);
  const denom = left - 2 * center + right;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return tau;
  const delta = clamp(0.5 * (left - right) / denom, -0.5, 0.5);
  return Number.isFinite(delta) ? tau + delta : tau;
}

/** Linear interpolation keeps array addressing separate from musical time. */
function sampleAt(values, frame) {
  const i = Math.floor(frame), fraction = frame - i;
  return (values[i] || 0) * (1 - fraction) + (values[i + 1] || 0) * fraction;
}

/** Fit nearby measured peaks after a fractional comb proposes local phase.
 * The fit stays inside one existing tempo window, preventing whole-song
 * period error from deciding the origin. The period fit needs eight beats.
 */
function fitLocalPhase(values, tau) {
  let bestFrame = 0, bestScore = 0, totalScore = 0, phases = 0;
  for (let phi = 0; phi < tau; phi += 0.25) {
    let score = 0;
    for (let f = phi; f < values.length; f += tau) score += sampleAt(values, f);
    totalScore += score;
    phases++;
    if (score > bestScore) { bestScore = score; bestFrame = phi; }
  }
  if (bestScore <= 0) return { frame: 0, tau, confidence: 0 };
  const pairs = [], radius = Math.max(1, tau * 0.12);
  for (let beat = 0, f = bestFrame; f < values.length; beat++, f += tau) {
    let peak = -1, energy = 0;
    for (let i = Math.max(0, Math.ceil(f - radius)); i <= Math.min(values.length - 1, Math.floor(f + radius)); i++) {
      if (values[i] > energy) { energy = values[i]; peak = i; }
    }
    if (peak < 0) continue;
    const left = values[peak - 1] || 0, right = values[peak + 1] || 0;
    const denom = left - 2 * energy + right;
    const delta = denom < -1e-12 ? clamp(0.5 * (left - right) / denom, -0.5, 0.5) : 0;
    pairs.push([beat, peak + delta]);
  }
  let frame = bestFrame, fittedTau = tau;
  if (pairs.length >= 8) {
    const meanBeat = pairs.reduce((sum, p) => sum + p[0], 0) / pairs.length;
    const meanFrame = pairs.reduce((sum, p) => sum + p[1], 0) / pairs.length;
    let covariance = 0, variance = 0;
    for (const [beat, measured] of pairs) { covariance += (beat - meanBeat) * (measured - meanFrame); variance += (beat - meanBeat) ** 2; }
    const slope = covariance / variance;
    if (Number.isFinite(slope) && Math.abs(slope - tau) <= tau * 0.12) {
      fittedTau = slope;
      frame = meanFrame - meanBeat * slope;
    }
  }
  const confidence = clamp((bestScore - totalScore / phases) / bestScore, 0, 1)
    * Math.min(1, pairs.length / 8) * Math.min(1, pairs.length / Math.max(1, values.length / tau));
  return { frame, tau: fittedTau, confidence };
}

/** Only accept a nearby anchor with independent local tempo/phase support. */
function reanchorPhase(frame, segment, globalTau, confidenceFloor = 0.25) {
  if (!segment || segment.confidence < confidenceFloor || !(segment.phaseConfidence >= 0.25) || !Number.isFinite(segment.phaseFrame)) return frame;
  const tau = segment.tau || globalTau;
  const measured = segment.phaseFrame + Math.round((frame - segment.phaseFrame) / tau) * tau;
  return Math.abs(measured - frame) <= tau * 0.2 ? measured : frame;
}

/** BPM autocorrelation + harmonic disambiguation + phase/downbeat alignment (spec §1.2.5). */
export function estimateTempo(O, rate, kickFrames) {
  const n = O.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += O[i];
  mean /= n;
  const Obar = new Float32Array(n);
  for (let i = 0; i < n; i++) Obar[i] = O[i] - mean;

  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += Obar[i] * Obar[i];
  r0 = Math.max(r0, 1e-9);

  const tauMin = Math.max(1, Math.round(rate * 60 / 200));
  const tauMax = Math.max(tauMin + 1, Math.round(rate * 60 / 60));

  let bestTau = tauMin, bestScore = -Infinity;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    const rHat = correlationAt(Obar, r0, tau);
    const bpm = (60 * rate) / tau;
    const logRatio = Math.log2(bpm / 120);
    const prior = Math.exp(-(logRatio * logRatio) / (2 * 0.7 * 0.7));
    const score = rHat * prior;
    if (score > bestScore) { bestScore = score; bestTau = tau; }
  }

  // Harmonic candidates still require autocorrelation support. Measured
  // kick intervals select among them without an integer modulo histogram
  // whose phase error grows with recording duration.
  const candidates = [bestTau, Math.round(bestTau / 2), bestTau * 2].filter((t) => t >= 1 && t < n);
  const candidateRHat = new Map(candidates.map((tau) => [tau, correlationAt(Obar, r0, tau)]));
  const bestTauRHat = candidateRHat.get(bestTau);
  let tauFinal = bestTau, bestExplain = -1;
  for (const tau of candidates) {
    if (candidateRHat.get(tau) < bestTauRHat * 0.5) continue;
    const explain = kickGridExplainScore(kickFrames, refineCorrelationPeak(Obar, r0, tau), rate);
    if (explain > bestExplain) { bestExplain = explain; tauFinal = tau; }
  }

  const tauRefined = refineCorrelationPeak(Obar, r0, tauFinal);
  const rHatFinal = correlationAt(Obar, r0, tauFinal);

  // Each bounded window measures fractional phase against actual peaks.
  // Never extrapolate an integer comb through the full recording.
  const weighted = Float32Array.from(O);
  for (const kf of kickFrames) if (kf >= 0 && kf < n) weighted[kf] *= 2;
  const curve = estimateTempoCurve(O, rate, tauRefined, { phaseEvidence: weighted });
  const anchor = curve.find(c => c.confidence >= 0.25 && c.phaseConfidence >= 0.25);
  const phaseConfidence = rHatFinal >= 0.25 && anchor ? anchor.phaseConfidence : 0;
  const phaseTau = anchor?.tau || tauRefined;
  const beatPeriodMs = (phaseTau / rate) * 1000;
  const bpm = 60000 / beatPeriodMs;
  let phiStar = anchor ? ((anchor.phaseFrame % phaseTau) + phaseTau) % phaseTau : 0;
  // Sub-frame fitting can cross the circular boundary even when the
  // opening is silent. Both sides represent frame zero within half a hop.
  if (Math.min(phiStar, phaseTau - phiStar) < 0.5) phiStar = 0;

  const kickOnly = new Float32Array(n);
  for (const kf of kickFrames) if (kf >= 0 && kf < n) kickOnly[kf] = O[kf];
  const scores = { 3: [0, 0, 0], 4: [0, 0, 0, 0] };
  const counts = { 3: [0, 0, 0], 4: [0, 0, 0, 0] };
  let frame = phiStar, beat = 0, segIdx = 0;
  while (frame < n) {
    while (segIdx + 1 < curve.length && curve[segIdx + 1].startFrame <= frame) segIdx++;
    const seg = curve[segIdx];
    if (beat > 0) frame = reanchorPhase(frame, seg, phaseTau);
    if (frame >= n) break;
    const energy = sampleAt(kickOnly, frame);
    for (const meter of [3, 4]) {
      scores[meter][beat % meter] += energy;
      counts[meter][beat % meter]++;
    }
    frame += seg?.confidence >= 0.25 ? seg.tau : phaseTau;
    beat++;
  }
  const pickDownbeat = (meter) => {
    const means = scores[meter].map((s, i) => s / Math.max(1, counts[meter][i]));
    const ranked = means.map((score, phase) => ({ score, phase })).sort((a, b) => b.score - a.score);
    return { mStar: ranked[0].phase, mScore: ranked[0].score,
      confidence: ranked[0].score > 0 ? clamp((ranked[0].score - ranked[1].score) / ranked[0].score, 0, 1) : 0 };
  };
  // Keep the established 4/4 default when accents do not distinguish meter.
  const meter4 = pickDownbeat(4), meter3 = pickDownbeat(3);
  const beatsPerBar = meter3.mScore > meter4.mScore * 1.15 ? 3 : 4;
  const selected = beatsPerBar === 3 ? meter3 : meter4;
  const other = beatsPerBar === 3 ? meter4 : meter3;
  const downbeatConfidence = phaseConfidence * selected.confidence;
  const meterConfidence = selected.mScore > 0
    ? downbeatConfidence * clamp((selected.mScore - other.mScore) / selected.mScore, 0, 1) : 0;
  const downbeatFrame = phiStar + selected.mStar * phaseTau;

  return {
    bpm,
    beatPeriodMs,
    confidence: clamp(rHatFinal, 0, 1),
    phaseConfidence, downbeatConfidence, meterConfidence,
    freeTime: rHatFinal < 0.25,
    beatsPerBar,
    barPeriodMs: beatPeriodMs * beatsPerBar,
    firstBarMs: (downbeatFrame / rate) * 1000,
    tau: phaseTau,
    curve,
  };
}

/**
 * Re-estimate the beat period in a sequence of windows, each restricted to a
 * narrow search range around the globally estimated period -- a bounded
 * "how much did the tempo drift, locally" rather than a fresh global search
 * (which would be free to lock onto an unrelated harmonic in a quiet or
 * sparse window). Each window re-demeans itself rather than reusing the
 * whole-song mean, so a window's own local dynamics decide its own read.
 *
 * @returns {{startFrame: number, tau: number, confidence: number, phaseFrame: number, phaseConfidence: number}[]} one
 *   segment per window, covering [0, O.length). `confidence` is the local
 *   autocorrelation score at that segment's chosen tau, in [0,1] -- a caller
 *   walking the bar grid should fall back to the global tau wherever this is
 *   too low to trust (near-silence, a fill with no clear pulse).
 */
export function estimateTempoCurve(O, rate, globalTau, { windowSec = 20, driftTolerance = 0.12, phaseEvidence = O } = {}) {
  const n = O.length;
  const windowFrames = Math.max(Math.round(globalTau * 8), Math.round(windowSec * rate));
  const tauLo = Math.max(1, Math.round(globalTau * (1 - driftTolerance)));
  const tauHi = Math.max(tauLo + 1, Math.round(globalTau * (1 + driftTolerance)));
  const segments = [];
  for (let start = 0; start < n; start += windowFrames) {
    const end = Math.min(n, start + windowFrames);
    const slice = O.subarray(start, end);
    let mean = 0;
    for (let i = 0; i < slice.length; i++) mean += slice[i];
    mean /= Math.max(1, slice.length);
    const bar = new Float32Array(slice.length);
    for (let i = 0; i < slice.length; i++) bar[i] = slice[i] - mean;
    let r0 = 0;
    for (let i = 0; i < bar.length; i++) r0 += bar[i] * bar[i];
    r0 = Math.max(r0, 1e-9);
    let bestTau = Math.max(1, Math.round(globalTau)), bestScore = -Infinity;
    for (let tau = tauLo; tau <= tauHi && tau < bar.length; tau++) {
      const score = correlationAt(bar, r0, tau);
      if (score > bestScore) { bestScore = score; bestTau = tau; }
    }
    const tau = bestScore > -Infinity ? refineCorrelationPeak(bar, r0, bestTau) : globalTau;
    const phase = fitLocalPhase(phaseEvidence.subarray(start, end), tau);
    const confidence = clamp(bestScore, 0, 1);
    segments.push({ startFrame: start, tau: confidence >= 0.25 && phase.confidence >= 0.25 ? phase.tau : tau,
      confidence, phaseFrame: start + phase.frame, phaseConfidence: confidence >= 0.25 ? phase.confidence : 0 });
  }
  return segments.length ? segments : [{ startFrame: 0, tau: globalTau, confidence: 0 }];
}

/**
 * Walk the bar grid forward from `firstBarMs` using each window's LOCALLY
 * re-estimated beat period (estimateTempoCurve) instead of one period
 * extrapolated across the whole song -- bounding drift error to at most one
 * window's worth instead of letting it accumulate linearly to the end of the
 * track. A 0.4% real-world tempo drift, entirely plausible in a live or
 * acoustic recording, already puts a fixed-period grid half a beat off by
 * the four-minute mark at 120 BPM; StructureAnalyzer's checkerboard kernel
 * and every PAD chord window both trust bar boundaries to be where they say.
 * Falls back to `globalTau` wherever a window's local read is not confident
 * enough to trust (near-silence, a fill with no clear pulse).
 */
export function buildDriftAwareBarGrid(firstBarMs, durationMs, beatsPerBar, rate, curve, globalTau, confidenceFloor = 0.2) {
  const barGrid = [];
  let t = firstBarMs, bar = 0, segIdx = 0;
  const segments = Array.isArray(curve) ? curve : [];
  while (t < durationMs) {
    let frame = (t / 1000) * rate;
    while (segIdx + 1 < segments.length && segments[segIdx + 1].startFrame <= frame) segIdx++;
    const seg = segments[segIdx];
    if (bar > 0) frame = reanchorPhase(frame, seg, globalTau, confidenceFloor);
    t = frame / rate * 1000;
    if (t >= durationMs) break;
    barGrid.push({ tick: bar * beatsPerBar, ms: t, numerator: beatsPerBar, denominator: 4 });
    const tau = seg && seg.confidence >= confidenceFloor ? seg.tau : globalTau;
    t += ((tau / rate) * 1000) * beatsPerBar;
    bar++;
  }
  return barGrid;
}

function kickGridExplainScore(kickFrames, tau, rate) {
  if (kickFrames.length < 2 || tau < 1) return 0;
  // Adjacent measured intervals avoid the whole-song modulo histogram's
  // integer-period drift. Penalize empty subdivisions, so offbeat hats do
  // not turn a supported beat into a double-time ghost.
  const toleranceFrames = 0.045 * rate;
  let explained = 0;
  for (let i = 1; i < kickFrames.length; i++) {
    const interval = kickFrames[i] - kickFrames[i - 1];
    const multiple = Math.max(1, Math.round(interval / tau));
    if (Math.abs(interval - multiple * tau) <= toleranceFrames) explained += 1 / multiple;
  }
  return explained / (kickFrames.length - 1);
}

/** The mean of a subset of band envelopes -- shared by extractPseudoLane's
 *  onset picking and the adapter's sustain estimation, so both walk the
 *  exact same curve. */
export function mixBandEnvelopes(normBands, bandIndices) {
  const mix = new Float32Array(normBands[0].length);
  for (const b of bandIndices) for (let i = 0; i < mix.length; i++) mix[i] += normBands[b][i] / bandIndices.length;
  return mix;
}

/**
 * MIDI-like note duration from an envelope: walk forward from the onset
 * frame while the energy stays above a fraction of its local peak. Gives
 * audio notes real sustain lengths (feeding the composer strip's icon
 * spans and Midasus's phrasing) instead of one fixed durMs for every note.
 */
export function estimateSustainMs(env, rate, frame, { floorRatio = 0.35, minMs = 120, maxMs = 1600 } = {}) {
  const peakHold = Math.min(env.length - 1, frame + Math.round(rate * 0.08));
  let peak = 0;
  for (let i = frame; i <= peakHold; i++) if (env[i] > peak) peak = env[i];
  if (peak < 1e-6) return minMs;
  const floor = peak * floorRatio;
  let end = frame;
  const maxFrames = Math.round((maxMs / 1000) * rate);
  while (end < env.length - 1 && end - frame < maxFrames && env[end] > floor) end++;
  return clamp(((end - frame) / rate) * 1000, minMs, maxMs);
}

/** Pseudo-melody/bass lanes from sustained band energy (spec §1.2.4 final
 *  paragraph). Each event carries its analysis `frame` so the adapter can
 *  refine pitch/duration against the true spectrum (see PitchTracker) --
 *  the band-centroid pitch here is only the fallback for moments the
 *  spectral tracker finds no tonal content in. */
export function extractPseudoLane(normBands, rate, { bandIndices, pitchLo, pitchHi, role, onsetThreshold = 1, rawBands = null }) {
  const mix = mixBandEnvelopes(normBands, bandIndices);

  const flux = positiveFlux(mix);
  const theta = medianAdaptiveThreshold(flux, MEDIAN_HALF_WINDOW, onsetThreshold);
  const frames = pickPeaks(flux, theta, rate, 120, 40);

  const values = frames.map((i) => flux[i]).sort((a, b) => a - b);
  const p95 = values.length ? Math.max(1e-6, values[Math.min(values.length - 1, Math.floor(0.95 * values.length))]) : 1;

  const refs = rawBands ? globalBandReferences(rawBands) : null;
  const ref = refs ? bandIndices.reduce((sum,b) => sum + refs[b], 0) : 1;
  return frames.map((i) => {
    let num = 0, den = 0;
    for (let k = 0; k < bandIndices.length; k++) {
      const e = normBands[bandIndices[k]][i];
      num += k * e;
      den += e;
    }
    const centroid = den > 0 ? num / den / Math.max(1, bandIndices.length - 1) : 0.5;
    const pitch = Math.round(pitchLo + (pitchHi - pitchLo) * clamp(centroid, 0, 1));
    return { tMs: (i / rate) * 1000, pitch, vel: clamp(flux[i] / p95, 0, 1) * (rawBands ? .18 + .82 * clamp(bandIndices.reduce((sum,b) => sum + rawBands[b][i], 0) / ref, 0, 1) : 1), novelty: clamp(flux[i] / p95, 0, 1), role, frame: i };
  });
}
