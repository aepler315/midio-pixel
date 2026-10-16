import { clamp01 } from '../utils/math.js';
import { Role } from '../core/NoteEvent.js';

// Krumhansl-Schmuckler key profiles — duration-weighted pitch-class
// correlation, the standard tonal-hierarchy model for key finding.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(hist, profile) {
  const n = 12;
  const meanH = hist.reduce((a, b) => a + b, 0) / n;
  const meanP = profile.reduce((a, b) => a + b, 0) / n;
  let num = 0, dh = 0, dp = 0;
  for (let i = 0; i < n; i++) {
    const h = hist[i] - meanH, p = profile[i] - meanP;
    num += h * p; dh += h * h; dp += p * p;
  }
  const denom = Math.sqrt(dh * dp);
  return denom > 1e-9 ? num / denom : 0;
}

/** Krumhansl-Schmuckler key estimate from a duration+velocity weighted
 *  pitch-class histogram. Returns { tonicPc, isMajor, confidence 0..1 }. */
export function estimateKey(histogram) {
  let bestMajor = { pc: 0, corr: -Infinity };
  let bestMinor = { pc: 0, corr: -Infinity };
  for (let pc = 0; pc < 12; pc++) {
    const rot = (profile) => {
      const r = new Array(12);
      for (let i = 0; i < 12; i++) r[i] = profile[(i - pc + 12) % 12];
      return r;
    };
    const cMaj = correlate(histogram, rot(MAJOR_PROFILE));
    const cMin = correlate(histogram, rot(MINOR_PROFILE));
    if (cMaj > bestMajor.corr) bestMajor = { pc, corr: cMaj };
    if (cMin > bestMinor.corr) bestMinor = { pc, corr: cMin };
  }
  const isMajor = bestMajor.corr >= bestMinor.corr;
  const winner = isMajor ? bestMajor : bestMinor;
  const gap = Math.abs(bestMajor.corr - bestMinor.corr);
  // Correlation coefficients rarely exceed ~0.85 for real music; squash to 0..1.
  const confidence = clamp01(0.5 * clamp01(winner.corr / 0.85) + 0.5 * clamp01(gap / 0.3));
  return { tonicPc: winner.pc, isMajor, confidence };
}

/** Authored pitches are certain only for MIDI. Legacy authored fixtures
 * with a GM program remain readable; recording events never qualify. */
export function isAuthoredPitch(e) {
  return Number.isFinite(e?.pitch) && e.channel !== 9 && e.role !== Role.RHYTHM
    && (e.src === 'midi' || (!e.src && Number.isFinite(e.program) && e.program >= 0))
    && (!e.pitchProvenance || e.pitchProvenance === 'authored');
}

export function tonalEvidence(data) {
  const pitched = (data.timeline || []).filter(isAuthoredPitch);
  if (pitched.length >= 4) {
    const hist = new Array(12).fill(0);
    for (const e of pitched) hist[((e.pitch % 12) + 12) % 12] += Math.max(1, e.durMs ?? 90) * Math.max(.05, e.vel ?? .5);
    const key = estimateKey(hist);
    return { tonic: key.tonicPc, mode: key.isMajor ? 'major' : 'minor', confidence: key.confidence, source: 'midi' };
  }
  const a = data.analysis;
  if (Number.isFinite(a?.tonic) && Number.isFinite(a?.tonalConfidence) && a.tonalConfidence >= .3) {
    return { tonic: ((Math.round(a.tonic) % 12) + 12) % 12, mode: a.mode === 'minor' ? 'minor' : 'major', confidence: clamp01(a.tonalConfidence), source: 'audio-chroma' };
  }
  return { tonic: null, mode: null, confidence: .15, source: 'spectral-fallback' };
}
