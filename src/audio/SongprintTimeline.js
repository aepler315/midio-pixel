// Songprint's heard-time timeline: what the music is doing every two
// seconds, measured once from the final recording. Terrain lays this out as
// distance, so the ground a listener flies over at a moment was built from
// that moment of the song.
//
//   loudness    0..1  RMS level within the recording's own range
//   brightness  0..1  spectral centroid, on one scale shared by all songs
//   tension     0..1  how far the local harmony is from any clear key
//   novelty     0..1  how sharply the music changes at this step
//   major       0..1  local major (1) against minor (0) colour
//
// Plus the recording's key (tonic pitch class, mode, confidence) and its
// dynamic range. Raw samples and amplitudes never enter the descriptor.
export const SONGPRINT_TIMELINE_VERSION = 1;
export const TIMELINE_STEP_MS = 2000;
export const MAX_TIMELINE_STEPS = 601;

const RATE = 11025;
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const clamp01 = x => Math.min(1, Math.max(0, x));
const round3 = x => Math.round(1000 * x) / 1000;

function centred(profile) {
  const mean = profile.reduce((a, b) => a + b) / 12;
  const out = profile.map(v => v - mean), norm = Math.hypot(...out);
  return out.map(v => v / norm);
}
const PROFILES = [centred(MAJOR), centred(MINOR)];

/** Correlation of a 12-bin chroma with each key: [major[12], minor[12]]. */
function keyCorrelations(chroma) {
  const mean = chroma.reduce((a, b) => a + b, 0) / 12;
  const c = chroma.map(v => v - mean), norm = Math.hypot(...c);
  return PROFILES.map(profile => Array.from({ length: 12 }, (_, tonic) => {
    if (!(norm > 1e-9)) return 0;
    let dot = 0;
    for (let p = 0; p < 12; p++) dot += c[p] * profile[(p - tonic + 12) % 12];
    return dot / norm;
  }));
}

function percentile(values, q) {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return 0;
  const at = q * (sorted.length - 1), k = Math.floor(at);
  return sorted[k] + (at - k) * ((sorted[Math.min(k + 1, sorted.length - 1)] ?? sorted[k]) - sorted[k]);
}

function smoothed(values, radius) {
  return values.map((_, i) => {
    let sum = 0, weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      const w = radius + 1 - Math.abs(k);
      sum += w * values[j]; weight += w;
    }
    return sum / weight;
  });
}

/**
 * mono     PCM at 11,025 Hz, heard time from its first sample
 * frames   Songprint chroma rows (12 bins) on its own clock
 * offsetMs, hopMs  that clock: frame f is heard at offsetMs + f * hopMs
 */
export function songprintTimeline(mono, frames, { offsetMs = 0, hopMs = 125 } = {}) {
  const stepSamples = Math.round(RATE * TIMELINE_STEP_MS / 1000);
  const steps = Math.min(MAX_TIMELINE_STEPS, Math.floor(mono.length / stepSamples));
  if (steps < 8 || !frames?.length) return null;

  // Level and brightness from the PCM. Brightness uses the first difference:
  // its energy over the signal's estimates the spectral centroid.
  const levelDb = new Float64Array(steps), centroid = new Float64Array(steps), audible = new Uint8Array(steps);
  for (let k = 0; k < steps; k++) {
    let energy = 0, change = 0, previous = mono[k * stepSamples];
    for (let i = k * stepSamples; i < (k + 1) * stepSamples; i++) {
      const v = mono[i];
      energy += v * v;
      change += (v - previous) ** 2;
      previous = v;
    }
    const rms = Math.sqrt(energy / stepSamples);
    levelDb[k] = 20 * Math.log10(Math.max(1e-6, rms));
    audible[k] = rms > 1e-4 ? 1 : 0;
    const ratio = energy > 1e-12 ? change / energy : 0;
    // 2 - 2cos(w) for a sinusoid at angular frequency w.
    centroid[k] = RATE / (2 * Math.PI) * Math.acos(Math.max(-1, Math.min(1, 1 - ratio / 2)));
  }
  const heard = Array.from(levelDb).filter((_, k) => audible[k]);
  if (heard.length < 4) return null;
  const quiet = percentile(heard, .06), loud = percentile(heard, .97);
  const loudness = Array.from(levelDb, (db, k) => audible[k] ? clamp01((db - quiet) / Math.max(6, loud - quiet)) : 0);
  const brightness = Array.from(centroid, (hz, k) => audible[k] ? clamp01(Math.log2(Math.max(1, hz) / 350) / Math.log2(3200 / 350)) : 0);

  // Chroma averaged into each step.
  const stepChroma = Array.from({ length: steps }, () => new Float64Array(12));
  const total = new Float64Array(12);
  for (let f = 0; f < frames.length; f++) {
    const k = Math.floor((offsetMs + f * hopMs) / TIMELINE_STEP_MS);
    if (k < 0 || k >= steps) continue;
    for (let p = 0; p < 12; p++) {
      const v = Math.max(0, frames[f][p]);
      stepChroma[k][p] += v;
      total[p] += v * (.4 + loudness[k]);
    }
  }
  const [majorAll, minorAll] = keyCorrelations(Array.from(total));
  let tonic = 0, major = true, best = -Infinity, second = -Infinity;
  for (let t = 0; t < 12; t++) for (const [isMajor, corr] of [[true, majorAll[t]], [false, minorAll[t]]]) {
    if (corr > best) { second = best; best = corr; tonic = t; major = isMajor; } else if (corr > second) second = corr;
  }

  // Local harmony over ±4 s: ambiguity (no key fits) and major/minor colour.
  const window = 2;
  const tension = [], colour = [];
  for (let k = 0; k < steps; k++) {
    const local = new Float64Array(12);
    for (let j = Math.max(0, k - window); j <= Math.min(steps - 1, k + window); j++)
      for (let p = 0; p < 12; p++) local[p] += stepChroma[j][p];
    const [maj, min] = keyCorrelations(Array.from(local));
    const bestMajor = Math.max(...maj), bestMinor = Math.max(...min);
    tension.push(clamp01((.85 - Math.max(bestMajor, bestMinor)) / .7));
    colour.push(clamp01(.5 + 2.5 * (bestMajor - bestMinor)));
  }

  // Novelty: contrast between the eight seconds before and after a step,
  // in harmony and in level.
  const span = 4, raw = new Float64Array(steps);
  for (let k = 1; k < steps; k++) {
    const before = new Float64Array(12), after = new Float64Array(12);
    let levelBefore = 0, levelAfter = 0, nb = 0, na = 0;
    for (let j = Math.max(0, k - span); j < k; j++) { for (let p = 0; p < 12; p++) before[p] += stepChroma[j][p]; levelBefore += loudness[j]; nb++; }
    for (let j = k; j < Math.min(steps, k + span); j++) { for (let p = 0; p < 12; p++) after[p] += stepChroma[j][p]; levelAfter += loudness[j]; na++; }
    const nB = Math.hypot(...before), nA = Math.hypot(...after);
    let cos = 1;
    if (nB > 1e-9 && nA > 1e-9) { cos = 0; for (let p = 0; p < 12; p++) cos += before[p] * after[p] / (nB * nA); }
    raw[k] = (1 - cos) + .8 * Math.abs(levelAfter / na - levelBefore / nb);
  }
  const top = Math.max(1e-6, percentile(raw, .97));
  const novelty = Array.from(raw, v => clamp01(v / top));

  return {
    version: SONGPRINT_TIMELINE_VERSION, stepMs: TIMELINE_STEP_MS,
    key: { tonic, major, confidence: round3(clamp01((best - second) * 6 + .3 * best)) },
    dynamics: round3(clamp01((loud - quiet) / 30)),
    loudness: loudness.map(round3),
    brightness: smoothed(brightness, 1).map(round3),
    tension: tension.map(round3),
    novelty: novelty.map(round3),
    major: colour.map(round3),
  };
}

const SERIES = ['loudness', 'brightness', 'tension', 'novelty', 'major'];
const unit = v => Number.isFinite(v) && v >= 0 && v <= 1;

/** Validated copy, or null. */
export function copySongprintTimeline(data, durationMs = Infinity) {
  if (data?.version !== SONGPRINT_TIMELINE_VERSION || data.stepMs !== TIMELINE_STEP_MS) return null;
  const n = data.loudness?.length;
  if (!Number.isSafeInteger(n) || n < 8 || n > MAX_TIMELINE_STEPS || (n - 1) * TIMELINE_STEP_MS > Math.ceil(durationMs)) return null;
  const out = { version: SONGPRINT_TIMELINE_VERSION, stepMs: TIMELINE_STEP_MS };
  const key = data.key;
  if (!key || !Number.isInteger(key.tonic) || key.tonic < 0 || key.tonic > 11 || typeof key.major !== 'boolean' || !unit(key.confidence)) return null;
  out.key = { tonic: key.tonic, major: key.major, confidence: key.confidence };
  if (!unit(data.dynamics)) return null;
  out.dynamics = data.dynamics;
  for (const name of SERIES) {
    const values = data[name];
    if (!Array.isArray(values) || values.length !== n || !values.every(unit)) return null;
    out[name] = Array.from(values);
  }
  return out;
}
