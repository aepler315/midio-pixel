// Audio-only musical coordinates for a geographic skyline and its recurring
// landmarks. All features are calculated once from the final recording.
import { clamp01, smoothstep } from '../utils/math.js';
import { MAX_PHRASE_FAMILIES, MAX_PHRASE_OCCURRENCES, SONGPRINT_PHRASE_VERSION, SONGPRINT_VERSION } from './SongprintData.js';
import { reflectFrame, songprintChroma } from './SongprintChroma.js';
import { songprintTimeline } from './SongprintTimeline.js';

export { songprintChroma } from './SongprintChroma.js';

const LAGS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 19, 21,
  24, 27, 31, 35, 40, 45, 51, 58, 66, 75, 85, 96, 109, 124, 141, 160];
const N_PITCH = 12;

function nearestEven(x) {
  const lo = Math.floor(x);
  return x - lo === .5 ? lo + lo % 2 : Math.round(x);
}

/** Native Songprint 3.1 signed harmonic recurrence: 12 pitch shifts × 32
 * physical delays, across the original three contexts and four quantiles. */
function recurrence(frames, shifts) {
  const n = frames.length;
  const mean = new Float64Array(N_PITCH);
  for (const row of frames) for (let p = 0; p < N_PITCH; p++) mean[p] += row[p];
  const z = frames.map(row => {
    const centered = Float64Array.from(row, (x, p) => x - .55 * mean[p] / n);
    const norm = Math.max(.22, Math.hypot(...centered));
    return centered.map(x => x / norm);
  });
  const duration = (n - 1) / 8;
  const scale = Math.min(1, (n - 1) / 480);
  const lagScale = scale + (1 - scale) * smoothstep(20, 28, duration);
  const pairs = new Float64Array(n), scratch = new Float64Array(n);
  return shifts.map(shift => LAGS.map(lag => {
    const delay = Math.max(1, nearestEven(lag * lagScale));
    const count = n - delay;
    for (let t = 0; t < count; t++) {
      let dot = 0;
      for (let p = 0; p < N_PITCH; p++) dot += z[t][p] * z[t + delay][(p + shift) % N_PITCH];
      pairs[t] = dot;
    }
    let pooled = 0;
    const values = scratch.subarray(0, count);
    for (const width of [1, 5, 15]) {
      const half = (width - 1) / 2;
      let sum = 0;
      for (let j = -half; j <= half; j++) sum += pairs[reflectFrame(j, count)];
      for (let t = 0; t < count; t++) {
        values[t] = sum / width;
        sum += pairs[reflectFrame(t + half + 1, count)] - pairs[reflectFrame(t - half, count)];
      }
      values.sort();
      for (const q of [.2, .5, .8, .95]) {
        const position = q * (count - 1), k = Math.floor(position);
        pooled += values[k] + (position - k) * (values[Math.min(k + 1, count - 1)] - values[k]);
      }
    }
    return pooled / 12;
  }));
}

const baselineKernel = Array.from({ length: 25 }, (_, i) => Math.exp(-.5 * ((i - 12) / 3) ** 2));
const kernelWeight = baselineKernel.reduce((a, b) => a + b);

/** Project the signed recurrence field into a west-to-east series of heights.
 * Greater unshifted/fourth/fifth return relative to competing semitones makes
 * a crest; neighboring delay bins share their broad baseline. The 16 positions
 * are pitch/lag features, not sixteen equal portions of playback. */
function terrainSkyline(frames) {
  const [unison, fourth, fifth, semitone, tritone] = recurrence(frames, [0, 5, 7, 1, 6]);
  const intervals = LAGS.map((_, k) => unison[k] + .5 * (fourth[k] + fifth[k]) - semitone[k] - tritone[k]);
  const detail = intervals.map((x, i) => {
    const local = baselineKernel.reduce((sum, weight, j) => sum + weight * intervals[reflectFrame(i + j - 12, intervals.length)], 0);
    return x - local / kernelWeight;
  });
  const heights = Array.from({ length: 16 }, (_, i) => (detail[2 * i] + detail[2 * i + 1]) / 2);
  const center = heights.reduce((a, b) => a + b) / heights.length;
  const scale = Math.max(.015, Math.hypot(...heights.map(x => x - center)) / Math.sqrt(heights.length));
  return heights.map(x => .5 + .5 * Math.tanh((x - center) / scale));
}

const PASSAGE_FRAMES = 96; // 12 s of ordered chroma from an independent recording
const STRIDE = 16; // 2 s; timeline keeps the actual sample-hop clock
const SAMPLES = 24; // 0.5 s evidence per step
// Keep the two strongest changing pitch classes per half-second. This is the
// sparse transposition comparison from Songprint's passage matcher; comparing
// two ordered sequences costs four products per step for all twelve keys.
function strongestPitches(patch) {
  const pitches = new Uint8Array(2 * SAMPLES), weights = new Float32Array(2 * SAMPLES);
  for (let t = 0; t < SAMPLES; t++) {
    const k = 2 * t;
    for (let p = 0; p < N_PITCH; p++) {
      const w = patch[N_PITCH * t + p];
      if (w > weights[k]) {
        pitches[k + 1] = pitches[k]; weights[k + 1] = weights[k];
        pitches[k] = p; weights[k] = w;
      } else if (w > weights[k + 1]) {
        pitches[k + 1] = p; weights[k + 1] = w;
      }
    }
  }
  const norm = Math.max(1e-6, Math.hypot(...weights));
  for (let k = 0; k < weights.length; k++) weights[k] /= norm;
  return { pitches, weights };
}

function passageWindows(frames) {
  const windows = [];
  for (let start = 0; start + PASSAGE_FRAMES <= frames.length; start += STRIDE) {
    const patch = new Float64Array(SAMPLES * N_PITCH), mean = new Float64Array(N_PITCH);
    for (let t = 0; t < SAMPLES; t++) {
      for (let p = 0; p < N_PITCH; p++) {
        let value = 0;
        for (let j = 0; j < 4; j++) value += frames[start + 4 * t + j][p] / 4;
        patch[N_PITCH * t + p] = value;
        mean[p] += value / SAMPLES;
      }
    }
    // Pitch-independent temporal motion and degree of change at short lags.
    // Unpitched, static or silent passages contribute no landmark.
    let variance = 0;
    for (let i = 0; i < patch.length; i++) {
      patch[i] -= mean[i % N_PITCH];
      variance += patch[i] ** 2;
    }
    const motion = variance / SAMPLES;
    if (motion < .065) continue;
    // A bounded interval fingerprint independent of absolute key. Folding
    // both directions retains a fourth/fifth relation under inversion.
    const vector = new Float64Array(21);
    let cross = 0;
    for (const lag of [1, 2, 4]) {
      for (let interval = 0; interval <= 6; interval++) {
        let movement = 0;
        for (let t = lag; t < SAMPLES; t++) {
          const a = N_PITCH * (t - lag), b = N_PITCH * t;
          for (let p = 0; p < N_PITCH; p++) movement += patch[a + p] * .5 *
            (patch[b + (p + interval) % N_PITCH] + patch[b + (p + N_PITCH - interval) % N_PITCH]);
        }
        vector[cross++] = movement / (SAMPLES - lag);
      }
    }
    const norm = Math.max(.001, Math.hypot(...vector));
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    windows.push({ frame: start + PASSAGE_FRAMES / 2, vector, motion, ...strongestPitches(patch) });
  }
  return windows;
}

function orderedMatch(a, b, histogram) {
  let best = 0;
  for (let offset = -2; offset <= 2; offset += 2) { // ± half a second of grid phase
    histogram.fill(0);
    for (let t = Math.max(0, -offset); t < Math.min(a.pitches.length, b.pitches.length - offset); t += 2) {
      for (let l = 0; l < 2; l++) {
        const pitch = a.pitches[t + l] + N_PITCH, weight = a.weights[t + l];
        for (let r = t + offset; r <= t + offset + 1; r++) {
          histogram[(pitch - b.pitches[r]) % N_PITCH] += weight * b.weights[r];
        }
      }
    }
    for (let k = 0; k < N_PITCH; k++) best = Math.max(best, histogram[k]);
  }
  return best;
}

function landmarkFor({ vector }) {
  // Contrast octave returns with third/fifth relationships over longer
  // phrase steps. Distinct takes encounter the same continuous coordinate.
  const movement = vector[7] - vector[11] + vector[14] - vector[19];
  return .5 + .5 * Math.tanh(3 * movement);
}

const MIN_FAMILY_MATCH = .48;

function collectFamilies(windows, links, timeOf) {
  const families = [];
  const count = windows.length;
  const used = new Uint8Array(count);
  while (families.length < MAX_PHRASE_FAMILIES) {
    let strength = 0, first = -1, second = -1;
    for (let i = 0; i < count; i++) {
      if (used[i]) continue;
      for (let j = i + 1; j < count; j++) {
        const match = links[i * count + j];
        if (!used[j] && match > strength) {
          strength = match; first = i; second = j;
        }
      }
    }
    if (first === -1) break;

    // Keep direct matches to the same measured passage. Chaining neighbours
    // by similarity can merge unrelated motifs through intermediate phrases.
    const selected = [{ index: first, strength }, { index: second, strength }];
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const match = links[first * count + i];
      if (!used[i] && match > 0 && i !== second) candidates.push({ index: i, strength: match });
    }
    candidates.sort((a, b) => b.strength - a.strength || a.index - b.index);
    for (const candidate of candidates) {
      if (selected.length >= MAX_PHRASE_OCCURRENCES) break;
      if (selected.every(({ index }) => Math.abs(windows[index].frame - windows[candidate.index].frame) >= PASSAGE_FRAMES)) {
        selected.push(candidate);
      }
    }

    // Suppress overlapping analyses and further direct matches to this
    // passage, including matches beyond the retained occurrence cap.
    for (let i = 0; i < count; i++) {
      if (links[first * count + i] > 0
        || selected.some(({ index }) => Math.abs(windows[i].frame - windows[index].frame) < PASSAGE_FRAMES)) used[i] = 1;
    }
    const occurrences = selected.sort((a, b) => a.index - b.index)
      .map(({ index, strength }) => ({ timeMs: timeOf(windows[index].frame), strength }));
    families.push({ landmark01: landmarkFor(windows[first]), occurrences });
  }
  return { version: SONGPRINT_PHRASE_VERSION, families };
}

function passageEvidence(frames, offsetMs, hopMs, phrases) {
  const windows = passageWindows(frames), count = windows.length;
  const repeat = new Float64Array(count), histogram = new Float64Array(N_PITCH);
  const motionStrength = windows.map(({ motion }) => smoothstep(.065, .32, motion));
  const links = phrases ? new Float32Array(count * count) : null;
  const timeOf = frame => Math.round(offsetMs + frame * hopMs);
  for (let i = 0; i < count; i++) {
    const a = windows[i];
    for (let j = i + 1; j < count; j++) {
      const b = windows[j];
      if (b.frame - a.frame < PASSAGE_FRAMES) continue;
      let similarity = 0;
      for (let k = 0; k < a.vector.length; k++) similarity += a.vector[k] * b.vector[k];
      if (similarity < .75) continue;
      const score = orderedMatch(a, b, histogram);
      repeat[i] = Math.max(repeat[i], score);
      repeat[j] = Math.max(repeat[j], score);
      if (links) {
        const strength = clamp01(score) * Math.min(motionStrength[i], motionStrength[j]);
        if (strength >= MIN_FAMILY_MATCH) links[i * count + j] = links[j * count + i] = strength;
      }
    }
  }
  const passages = [];
  for (let i = 0; i < count; i++) {
    if (repeat[i] < .4) continue;
    passages.push({ timeMs: timeOf(windows[i].frame), landmark01: landmarkFor(windows[i]),
      strength: clamp01(repeat[i]) * motionStrength[i] });
  }
  return { passages, ...(links ? { phraseFamilies: collectFamilies(windows, links, timeOf) } : {}) };
}

export function songprintFromChroma(frames, { offsetMs = 0, hopMs = 125, phrases = true } = {}) {
  if (frames.length < PASSAGE_FRAMES || !Number.isFinite(offsetMs) || !Number.isFinite(hopMs) || !(hopMs > 0)) return null;
  let variation = 0;
  for (let t = 1; t < frames.length; t++) {
    for (let p = 0; p < N_PITCH; p++) variation += (frames[t][p] - frames[t - 1][p]) ** 2;
  }
  if (!(variation / frames.length > .0005)) return null;
  return { version: SONGPRINT_VERSION, skyline: terrainSkyline(frames), ...passageEvidence(frames, offsetMs, hopMs, phrases) };
}

export function analyzeSongprintPCM(mono11025, { phrases = true } = {}) {
  const { frames, offsetMs, hopMs } = songprintChroma(mono11025);
  const print = songprintFromChroma(frames, { offsetMs, hopMs, phrases });
  const timeline = print && songprintTimeline(mono11025, frames, { offsetMs, hopMs });
  return print && timeline ? { ...print, timeline } : print;
}
