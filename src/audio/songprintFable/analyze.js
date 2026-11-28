// Songprint Fable, aepler315/songprint-fable at ae99887. Midio also retains the source trim offset.
// Audio -> descriptor.
//
// The descriptor is two independent sets of measurements, split by what they
// are invariant to:
//
//   STRUCTURE  what the COMPOSITION fixes: which pitch classes sound, moment
//              by moment, relative to the song's own tonal centre. Built to
//              ignore loudness, tone, instrumentation, tuning and key.
//
//   FLAVOUR    what the RECORDING fixes: tone balance over time, loudness
//              contour, stereo width, tuning, absolute key.
//
// There is no hash and no random number anywhere. Every output is a continuous
// function of the samples, which is the whole point: a hash turns "almost the
// same audio" into "completely different output"; a continuous measurement
// turns it into "almost the same output".
import { createFft, hann, resample, dctMatrix } from './dsp.js';

export const DESCRIPTOR_VERSION = 2;

/** Canonical analysis rate. Everything is resampled to this first. */
export const RATE = 22050;
/** 372 ms window: resolves semitones down to about C3, leans on harmonics below. */
export const WINDOW = 8192;
export const HOP = 2048;
/** One structure/flavour sample per second of music. */
export const SLICE_SECONDS = 1.0;
/** Each slice averages a Hann window this many slices wide. */
const SLICE_SPAN = 3.0;

/** Pitch bands: one per semitone, C2 (65 Hz) .. B6 (1976 Hz). Above that is
 *  mostly cymbals and overtones; below it the FFT cannot separate semitones. */
const MIDI_LO = 36, PITCH_BANDS = 60;
/** Cepstral lifter: pitch-domain DCT coefficients below this are discarded.
 *  They describe the broad spectral envelope -- i.e. the instrument, not the
 *  notes (Mueller & Ewert's CRP idea). */
const LIFTER = 28;
/** Log compression strength for pitch-band energy. */
const GAMMA = 10;
/** How much of the song's average level is added to each frame's own level
 *  before normalising: loud frames become level-free, near-silent frames fade
 *  toward "no tonal content" instead of being amplified into noise. */
const LEVEL_FLOOR = 0.2;

/** Tone bands: log-spaced, 50 Hz .. 8 kHz -- inside what every common lossy
 *  codec keeps, so a re-encode cannot move the colour. */
const TONE_BANDS = 24, TONE_LO = 50, TONE_HI = 8000;

/** Angle of each pitch class on the circle of fifths (C=0, G=1/12 turn, ...). */
export function fifthsAngle(pc) { return (2 * Math.PI * ((7 * pc) % 12)) / 12; }

function mixdown(channels) {
  const n = channels[0].length;
  if (channels.length === 1) return { mono: channels[0], width: 0 };
  const a = channels[0], b = channels[1];
  const mono = new Float32Array(n);
  let mid = 0, side = 0;
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (a[i] + b[i]);
    const s = 0.5 * (a[i] - b[i]);
    mono[i] = m;
    mid += m * m; side += s * s;
  }
  return { mono, width: mid + side > 0 ? side / (mid + side) : 0 };
}

/** Raised-cosine crossfade: a value at fractional position x is shared between
 *  floor(x) and floor(x)+1 with weights that sum to one. */
function splitWeights(x) {
  const i = Math.floor(x);
  const f = x - i;
  const w1 = Math.sin((Math.PI / 2) * f) ** 2;
  return [i, 1 - w1, w1];
}

/**
 * Global tuning offset, in semitones within [-0.5, 0.5).
 *
 * Each spectral peak votes with how far it sits from the nearest equal-
 * tempered pitch, as a unit phasor weighted by its power. The angle of the
 * summed phasor is the tuning. A circular mean has no thresholds to trip over
 * and degrades gracefully: untuned material simply produces a short phasor.
 */
function estimateTuning(signal, fft, win) {
  const re = new Float64Array(WINDOW), im = new Float64Array(WINDOW);
  const binHz = RATE / WINDOW;
  const k0 = Math.ceil(100 / binHz), k1 = Math.floor(2000 / binHz);
  const mag = new Float64Array(k1 + 2);
  let sx = 0, sy = 0;
  const frames = Math.floor((signal.length - WINDOW) / HOP) + 1;
  for (let f = 0; f < frames; f += 4) {
    const off = f * HOP;
    for (let i = 0; i < WINDOW; i++) { re[i] = signal[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = k0 - 1; k <= k1 + 1; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
    for (let k = k0; k <= k1; k++) {
      const b = mag[k];
      if (b <= mag[k - 1] || b < mag[k + 1] || b <= 0) continue;
      const la = Math.log(mag[k - 1] + 1e-30), lb = Math.log(b), lc = Math.log(mag[k + 1] + 1e-30);
      const denom = la - 2 * lb + lc;
      const delta = denom < 0 ? (0.5 * (la - lc)) / denom : 0;
      const pitch = 12 * Math.log2(((k + delta) * binHz) / 440);
      const dev = pitch - Math.round(pitch);
      sx += b * Math.cos(2 * Math.PI * dev);
      sy += b * Math.sin(2 * Math.PI * dev);
    }
  }
  return Math.atan2(sy, sx) / (2 * Math.PI);
}

/**
 * @param {Float32Array[]} channels decoded audio, one array per channel
 * @param {number} sampleRate rate of `channels`
 * @returns descriptor, or null when the audio carries nothing to measure
 */
export function analyze(channels, sampleRate, opts) {
  const prepared = prepare(channels, sampleRate);
  return prepared ? analyzeSignal(prepared.signal, prepared.width, opts) : null;
}

/** Mix to mono and resample to RATE: the part of the work that depends on the
 *  container, done once. */
export function prepare(channels, sampleRate) {
  if (!channels?.length || !channels[0]?.length || !(sampleRate > 0)) return null;
  const { mono, width } = mixdown(channels);
  return { signal: resample(mono, sampleRate, RATE), width };
}

/**
 * Cut silence from both ends, to 10 ms. Encoders add their own padding and
 * rips add lead-in; measuring from the first sound makes the same master
 * start in the same place however it was delivered. The threshold is relative
 * to the song's own level, so it does not move with volume.
 */
function trimSilence(signal) {
  const block = Math.round(RATE / 100);
  const blocks = Math.floor(signal.length / block);
  if (blocks < 1) return null;
  const power = new Float64Array(blocks);
  let mean = 0;
  for (let b = 0; b < blocks; b++) {
    let p = 0;
    for (let i = b * block, e = i + block; i < e; i++) p += signal[i] * signal[i];
    power[b] = p; mean += p / blocks;
  }
  if (!(mean > 0)) return null;
  const gate = mean * 1e-5;
  let first = 0, last = blocks - 1;
  while (first < last && power[first] < gate) first++;
  while (last > first && power[last] < gate) last--;
  return signal.subarray(first * block, (last + 1) * block);
}

/** Descriptor from a mono signal already at RATE. */
export function analyzeSignal(input, width = 0, { lifter = LIFTER } = {}) {
  const signal = trimSilence(input);
  const frames = signal ? Math.floor((signal.length - WINDOW) / HOP) + 1 : 0;
  if (frames < 8) return null;

  const fft = createFft(WINDOW);
  const win = hann(WINDOW);
  const binHz = RATE / WINDOW;
  const tuning = estimateTuning(signal, fft, win);

  // Bin -> pitch band and bin -> tone band maps.
  const kHi = Math.min(WINDOW / 2 - 1, Math.ceil(TONE_HI / binHz) + 1);
  const pIdx = new Int16Array(kHi + 1).fill(-2), pW0 = new Float32Array(kHi + 1), pW1 = new Float32Array(kHi + 1);
  const tIdx = new Int16Array(kHi + 1).fill(-2), tW0 = new Float32Array(kHi + 1), tW1 = new Float32Array(kHi + 1);
  const toneStep = Math.log2(TONE_HI / TONE_LO) / TONE_BANDS;
  for (let k = 1; k <= kHi; k++) {
    const hz = k * binHz;
    const pitch = 69 + 12 * Math.log2(hz / 440) - tuning - MIDI_LO;
    if (pitch > -1 && pitch < PITCH_BANDS) {
      const [i, w0, w1] = splitWeights(pitch);
      pIdx[k] = i; pW0[k] = w0; pW1[k] = w1;
    }
    const tone = Math.log2(hz / TONE_LO) / toneStep - 0.5;
    if (tone > -1 && tone < TONE_BANDS) {
      const [i, w0, w1] = splitWeights(tone);
      tIdx[k] = i; tW0[k] = w0; tW1[k] = w1;
    }
  }

  const pitchE = new Float32Array(frames * PITCH_BANDS);
  const toneE = new Float32Array(frames * TONE_BANDS);
  const framePower = new Float64Array(frames);
  const re = new Float64Array(WINDOW), im = new Float64Array(WINDOW);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < WINDOW; i++) { re[i] = signal[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const pRow = f * PITCH_BANDS, tRow = f * TONE_BANDS;
    let total = 0;
    for (let k = 1; k <= kHi; k++) {
      const e = re[k] * re[k] + im[k] * im[k];
      let i = pIdx[k];
      if (i >= -1) {
        if (i >= 0) pitchE[pRow + i] += e * pW0[k];
        if (i + 1 < PITCH_BANDS) pitchE[pRow + i + 1] += e * pW1[k];
      }
      i = tIdx[k];
      if (i >= -1) {
        if (i >= 0) toneE[tRow + i] += e * tW0[k];
        if (i + 1 < TONE_BANDS) toneE[tRow + i + 1] += e * tW1[k];
        total += e;
      }
    }
    framePower[f] = total;
  }

  let songPower = 0;
  for (let f = 0; f < frames; f++) songPower += framePower[f];
  songPower /= frames;
  if (!(songPower > 0)) return null;
  const first = 0, last = frames - 1;

  // Per-frame pitch-band shape: level-normalised, log-compressed.
  let songPitch = 0;
  const framePitch = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let b = 0; b < PITCH_BANDS; b++) s += pitchE[f * PITCH_BANDS + b];
    framePitch[f] = s / PITCH_BANDS;
    songPitch += framePitch[f];
  }
  songPitch /= frames;
  for (let f = 0; f < frames; f++) {
    const norm = framePitch[f] + LEVEL_FLOOR * songPitch;
    for (let b = 0; b < PITCH_BANDS; b++) {
      const i = f * PITCH_BANDS + b;
      pitchE[i] = Math.log(1 + (GAMMA * pitchE[i]) / norm);
    }
  }

  // Lifter + fold, as one 12 x PITCH_BANDS matrix. Removing the low cepstral
  // coefficients also removes the mean, so every folded vector sums to zero:
  // what is left is "which pitch classes stand out", not "how much sound".
  const dct = dctMatrix(PITCH_BANDS);
  const fold = new Float64Array(12 * PITCH_BANDS);
  for (let b = 0; b < PITCH_BANDS; b++) {
    const pc = (MIDI_LO + b) % 12;
    for (let j = 0; j < PITCH_BANDS; j++) {
      let low = 0;
      for (let n = 0; n < lifter; n++) low += dct[n * PITCH_BANDS + b] * dct[n * PITCH_BANDS + j];
      fold[pc * PITCH_BANDS + j] += (b === j ? 1 : 0) - low;
    }
  }

  // Slices are exactly SLICE_SECONDS long and counted from the first sound.
  // The count is never rounded to fit the duration: rounding is a yes/no
  // decision, and a few milliseconds of encoder padding would flip it and
  // shift every layer. The last slice is simply partial, and says how much.
  const frameSeconds = HOP / RATE;
  const frameOffset = (0.5 * WINDOW) / RATE - 0.5 * frameSeconds;   // frame f is centred at (f + 0.5) * frameSeconds + frameOffset
  const t0 = 0, t1 = signal.length / RATE;
  const dt = SLICE_SECONDS;
  const slices = Math.max(1, Math.ceil(t1 / dt - 1e-9));
  const lastFraction = Math.min(1, Math.max(1e-3, t1 / dt - (slices - 1)));
  const chroma = new Float32Array(slices * 12);
  const tone = new Float32Array(slices * 3);
  const meanPitch = new Float64Array(PITCH_BANDS);
  const meanTone = new Float64Array(TONE_BANDS);
  const toneFloor = songPower * 1e-7 / TONE_BANDS;
  const halfSpan = 0.5 * SLICE_SPAN * dt;
  for (let s = 0; s < slices; s++) {
    const centre = t0 + (s + 0.5) * dt;
    const fa = Math.max(first, Math.ceil((centre - halfSpan - frameOffset) / frameSeconds - 0.5));
    const fb = Math.min(last, Math.floor((centre + halfSpan - frameOffset) / frameSeconds - 0.5));
    meanPitch.fill(0); meanTone.fill(0);
    let wsum = 0, power = 0;
    for (let f = fa; f <= fb; f++) {
      const x = ((f + 0.5) * frameSeconds + frameOffset - centre) / halfSpan;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * x);
      wsum += w;
      for (let b = 0; b < PITCH_BANDS; b++) meanPitch[b] += w * pitchE[f * PITCH_BANDS + b];
      for (let b = 0; b < TONE_BANDS; b++) meanTone[b] += w * toneE[f * TONE_BANDS + b];
      power += w * framePower[f];
    }
    if (wsum > 0) {
      for (let b = 0; b < PITCH_BANDS; b++) meanPitch[b] /= wsum;
      for (let b = 0; b < TONE_BANDS; b++) meanTone[b] /= wsum;
      power /= wsum;
    }
    for (let pc = 0; pc < 12; pc++) {
      let v = 0;
      for (let b = 0; b < PITCH_BANDS; b++) v += fold[pc * PITCH_BANDS + b] * meanPitch[b];
      chroma[s * 12 + pc] = v;
    }
    // Tone: first two cepstral coefficients of the band spectrum in dB.
    // Both are differences between bands, so overall gain cancels exactly.
    let tilt = 0, curve = 0;
    for (let b = 0; b < TONE_BANDS; b++) {
      const db = 10 * Math.log10(meanTone[b] + toneFloor);
      tilt += db * Math.cos((Math.PI * (b + 0.5)) / TONE_BANDS);
      curve += db * Math.cos((2 * Math.PI * (b + 0.5)) / TONE_BANDS);
    }
    tone[s * 3] = (2 * tilt) / TONE_BANDS;
    tone[s * 3 + 1] = (2 * curve) / TONE_BANDS;
    tone[s * 3 + 2] = 10 * Math.log10(power / songPower + 1e-7);
  }

  // One scale for the whole song, so quiet or noisy passages stay small
  // relative to the song's clearest harmony instead of being blown up.
  let sq = 0;
  for (let i = 0; i < chroma.length; i++) sq += chroma[i] * chroma[i];
  const scale = Math.sqrt(sq / chroma.length);
  if (!(scale > 0)) return null;
  for (let i = 0; i < chroma.length; i++) chroma[i] /= scale;

  // Tonal centre: where the song's pitch-class weight sits on the circle of
  // fifths. Transposing a song rotates this angle with it, so turning the
  // print by it makes the geometry independent of key -- without ever
  // deciding what the key is.
  let cx = 0, cy = 0;
  const profile = new Float32Array(12);
  for (let s = 0; s < slices; s++) {
    for (let pc = 0; pc < 12; pc++) {
      const v = chroma[s * 12 + pc];
      if (v > 0) profile[pc] += v / slices;
    }
  }
  for (let pc = 0; pc < 12; pc++) {
    cx += profile[pc] * Math.cos(fifthsAngle(pc));
    cy += profile[pc] * Math.sin(fifthsAngle(pc));
  }
  let psum = 0;
  for (let pc = 0; pc < 12; pc++) psum += profile[pc];

  return {
    version: DESCRIPTOR_VERSION,
    offsetSeconds: (signal.byteOffset - input.byteOffset) / (Float32Array.BYTES_PER_ELEMENT * RATE),
    durationSeconds: t1 - t0,
    slices,
    sliceSeconds: dt,
    lastFraction,     // how much of the final slice the song actually fills
    chroma,           // slices x 12, zero-mean per slice, unit RMS over the song
    tone,             // slices x 3: tilt dB, curve dB, level dB re song mean
    keyAngle: Math.atan2(cy, cx),
    keyStrength: psum > 0 ? Math.hypot(cx, cy) / psum : 0,
    tuningCents: tuning * 100,
    stereoWidth: width,
    profile,
  };
}
