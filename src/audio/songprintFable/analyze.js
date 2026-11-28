// Adapted from songprint-fable (V:\Development\songprint, project author's repo).
// Deterministic composition/recording descriptor for the fable radial print.
// This is a faithful port of the fable analysis core, with small adaptations for
// Midio's worker/bundle environment.

import { createFft, hann, resample, dctMatrix } from './dsp.js';

export const DESCRIPTOR_VERSION = 1;
export const RATE = 22050;
export const WINDOW = 8192;
export const HOP = 2048;
export const SLICE_SECONDS = 1.0;
const SLICE_SPAN = 3.0;
const MIDI_LO = 36, PITCH_BANDS = 60;
const LIFTER = 28;
const GAMMA = 10;
const LEVEL_FLOOR = 0.2;
const TONE_BANDS = 24, TONE_LO = 50, TONE_HI = 8000;

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

export function prepare(channels, sampleRate) {
  const { mono, width } = mixdown(channels);
  const signal = sampleRate === RATE ? mono : resample(mono, sampleRate, RATE);
  return { signal, width };
}

export function analyze(channels, sampleRate, opts) {
  const prepared = prepare(channels, sampleRate);
  return prepared ? analyzeSignal(prepared.signal, prepared.width, opts) : null;
}

export function analyzeSignal(signal, width, opts = {}) {
  const fft = createFft(WINDOW);
  const win = hann(WINDOW);
  const frameSeconds = HOP / RATE;
  const frames = Math.floor((signal.length - WINDOW) / HOP) + 1;
  if (frames < 4) return null;

  const re = new Float64Array(WINDOW), im = new Float64Array(WINDOW);
  const power = new Float64Array(WINDOW / 2 + 1);
  const framePower = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) { const s = signal[off + i] * win[i]; re[i] = s; im[i] = 0; sum += s * s; }
    framePower[f] = sum;
    fft(re, im);
    for (let k = 0; k <= WINDOW / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  }

  let songPower = 0;
  for (let f = 0; f < frames; f++) songPower += framePower[f];
  songPower /= frames;
  if (!(songPower > 0)) return null;
  const silence = songPower * 1e-6;
  let first = 0, last = frames - 1;
  while (first < frames && framePower[first] < silence) first++;
  while (last > first && framePower[last] < silence) last--;

  const tuning = opts.tuning ?? estimateTuning(signal, fft, win);
  const dt = opts.sliceSeconds ?? SLICE_SECONDS;
  const t0 = first * frameSeconds, t1 = last * frameSeconds + WINDOW / RATE;
  const durationSeconds = Math.max(0, t1 - t0);
  const slices = Math.max(1, Math.ceil(durationSeconds / dt));
  const lastFraction = Math.min(1, Math.max(1e-3, durationSeconds / dt - (slices - 1)));

  const binHz = RATE / WINDOW;
  const fold = new Float64Array(12 * PITCH_BANDS);
  for (let b = 0; b < PITCH_BANDS; b++) {
    const centre = 440 * 2 ** ((MIDI_LO + b - 69 + tuning) / 12);
    const lo = centre * 2 ** (-0.5 / 12), hi = centre * 2 ** (0.5 / 12);
    const k0 = Math.max(1, Math.floor(lo / binHz));
    const k1 = Math.min(WINDOW / 2 - 1, Math.ceil(hi / binHz));
    for (let k = k0; k <= k1; k++) {
      const hz = k * binHz;
      const dist = Math.abs(12 * Math.log2(hz / centre));
      if (dist >= 1) continue;
      fold[((MIDI_LO + b) % 12) * PITCH_BANDS + b] += Math.cos((Math.PI / 2) * dist) ** 2;
    }
  }
  const dct = dctMatrix(PITCH_BANDS);
  const lifter = new Float64Array(PITCH_BANDS * PITCH_BANDS);
  for (let m = LIFTER; m < PITCH_BANDS; m++) {
    for (let i = 0; i < PITCH_BANDS; i++) {
      for (let b = 0; b < PITCH_BANDS; b++) lifter[i * PITCH_BANDS + b] += dct[m * PITCH_BANDS + i] * dct[m * PITCH_BANDS + b];
    }
  }
  const toneEdges = new Float64Array(TONE_BANDS + 1);
  for (let e = 0; e <= TONE_BANDS; e++) toneEdges[e] = TONE_LO * (TONE_HI / TONE_LO) ** (e / TONE_BANDS);
  const toneW = new Float64Array(TONE_BANDS * (WINDOW / 2 + 1));
  for (let b = 0; b < TONE_BANDS; b++) {
    const lo = toneEdges[b], hi = toneEdges[b + 1], mid = Math.sqrt(lo * hi);
    let sum = 0;
    for (let k = 1; k <= WINDOW / 2; k++) {
      const hz = k * binHz;
      const t = hz <= mid ? (hz - lo) / (mid - lo) : (hi - hz) / (hi - mid);
      if (t > 0) { toneW[b * (WINDOW / 2 + 1) + k] = t; sum += t; }
    }
    if (sum > 0) for (let k = 1; k <= WINDOW / 2; k++) toneW[b * (WINDOW / 2 + 1) + k] /= sum;
  }

  const pitchE = new Float64Array(frames * PITCH_BANDS);
  const toneE = new Float64Array(frames * TONE_BANDS);
  const band = new Float64Array(PITCH_BANDS), lift = new Float64Array(PITCH_BANDS);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < WINDOW; i++) { re[i] = signal[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= WINDOW / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    band.fill(0);
    for (let b = 0; b < PITCH_BANDS; b++) {
      const centre = 440 * 2 ** ((MIDI_LO + b - 69 + tuning) / 12);
      const lo = centre * 2 ** (-0.5 / 12), hi = centre * 2 ** (0.5 / 12);
      const k0 = Math.max(1, Math.floor(lo / binHz));
      const k1 = Math.min(WINDOW / 2 - 1, Math.ceil(hi / binHz));
      let e = 0;
      for (let k = k0; k <= k1; k++) {
        const hz = k * binHz;
        const dist = Math.abs(12 * Math.log2(hz / centre));
        if (dist < 1) e += power[k] * Math.cos((Math.PI / 2) * dist) ** 2;
      }
      band[b] = Math.log(1 + GAMMA * e);
    }
    const norm = Math.sqrt(framePower[f] + LEVEL_FLOOR * songPower);
    lift.fill(0);
    for (let i = 0; i < PITCH_BANDS; i++) {
      for (let b = 0; b < PITCH_BANDS; b++) lift[i] += lifter[i * PITCH_BANDS + b] * band[b];
      pitchE[f * PITCH_BANDS + i] = lift[i] / norm;
    }
    for (let b = 0; b < TONE_BANDS; b++) {
      let e = 0;
      const row = b * (WINDOW / 2 + 1);
      for (let k = 1; k <= WINDOW / 2; k++) e += toneW[row + k] * power[k];
      toneE[f * TONE_BANDS + b] = e;
    }
  }

  const chroma = new Float32Array(slices * 12);
  const tone = new Float32Array(slices * 3);
  const meanPitch = new Float64Array(PITCH_BANDS);
  const meanTone = new Float64Array(TONE_BANDS);
  const toneFloor = songPower * 1e-7 / TONE_BANDS;
  const halfSpan = 0.5 * SLICE_SPAN * dt;
  for (let s = 0; s < slices; s++) {
    const centre = t0 + (s + 0.5) * dt;
    const fa = Math.max(first, Math.ceil((centre - halfSpan - (0)) / frameSeconds - 0.5));
    const fb = Math.min(last, Math.floor((centre + halfSpan - (0)) / frameSeconds - 0.5));
    meanPitch.fill(0); meanTone.fill(0);
    let wsum = 0, pwr = 0;
    for (let f = fa; f <= fb; f++) {
      const x = ((f + 0.5) * frameSeconds - centre) / halfSpan;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * x);
      wsum += w;
      for (let b = 0; b < PITCH_BANDS; b++) meanPitch[b] += w * pitchE[f * PITCH_BANDS + b];
      for (let b = 0; b < TONE_BANDS; b++) meanTone[b] += w * toneE[f * TONE_BANDS + b];
      pwr += w * framePower[f];
    }
    if (wsum > 0) {
      for (let b = 0; b < PITCH_BANDS; b++) meanPitch[b] /= wsum;
      for (let b = 0; b < TONE_BANDS; b++) meanTone[b] /= wsum;
      pwr /= wsum;
    }
    for (let pc = 0; pc < 12; pc++) {
      let v = 0;
      for (let b = 0; b < PITCH_BANDS; b++) v += fold[pc * PITCH_BANDS + b] * meanPitch[b];
      chroma[s * 12 + pc] = v;
    }
    let tilt = 0, curve = 0;
    for (let b = 0; b < TONE_BANDS; b++) {
      const db = 10 * Math.log10(meanTone[b] + toneFloor);
      tilt += db * Math.cos((Math.PI * (b + 0.5)) / TONE_BANDS);
      curve += db * Math.cos((2 * Math.PI * (b + 0.5)) / TONE_BANDS);
    }
    tone[s * 3] = (2 * tilt) / TONE_BANDS;
    tone[s * 3 + 1] = (2 * curve) / TONE_BANDS;
    tone[s * 3 + 2] = 10 * Math.log10(pwr / songPower + 1e-7);
  }

  let sq = 0;
  for (let i = 0; i < chroma.length; i++) sq += chroma[i] * chroma[i];
  const scale = Math.sqrt(sq / chroma.length);
  if (!(scale > 0)) return null;
  for (let i = 0; i < chroma.length; i++) chroma[i] /= scale;

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
    durationSeconds: t1 - t0,
    slices,
    sliceSeconds: dt,
    lastFraction,
    chroma,
    tone,
    keyAngle: Math.atan2(cy, cx),
    keyStrength: psum > 0 ? Math.hypot(cx, cy) / psum : 0,
    tuningCents: tuning * 100,
    stereoWidth: width,
  };
}
