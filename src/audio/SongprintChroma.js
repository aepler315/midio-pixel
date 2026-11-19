// Songprint 3.1's locally whitened pitch-class evidence. The time offset
// tracks the leading silence removed for analysis, so cues stay on heard time.
import { fft } from './PitchTracker.js';

const SAMPLE_RATE = 11025;
const FFT_SIZE = 4096;
const HOP = 1378;
const HOP_MS = 1000 * HOP / SAMPLE_RATE;
const PITCHES = 12;
const LOWEST_NOTE = 35;
const NOTE_COUNT = 50;

export function reflectFrame(index, count) {
  const positive = ((index % (2 * count)) + 2 * count) % (2 * count);
  return positive < count ? positive : 2 * count - 1 - positive;
}

const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
const noteBands = Array.from({ length: NOTE_COUNT }, (_, i) => {
  const hz = 440 * 2 ** ((LOWEST_NOTE + i - 69) / 12);
  const halfWidth = Math.max(1.4 * SAMPLE_RATE / FFT_SIZE, .028 * hz);
  return [Math.ceil((hz - halfWidth) * FFT_SIZE / SAMPLE_RATE), Math.floor((hz + halfWidth) * FFT_SIZE / SAMPLE_RATE)];
});
const smoothing = Array.from({ length: 9 }, (_, i) => Math.exp(-.5 * (i - 4) ** 2));
const totalWeight = smoothing.reduce((a, b) => a + b);
const notes = Array.from({ length: NOTE_COUNT }, (_, i) => Array.from({ length: 9 }, (_, k) => reflectFrame(i + k - 4, NOTE_COUNT)));

/** Mono PCM at 11025 Hz. Raw amplitudes and samples never enter the descriptor. */
export function songprintChroma(mono) {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (!(peak > 1e-12)) return { frames: [], offsetMs: 0, hopMs: HOP_MS };
  const floor = .001 * peak;
  let first = 0, end = mono.length;
  while (first < end && Math.abs(mono[first]) <= floor) first++;
  while (end > first && Math.abs(mono[end - 1]) <= floor) end--;

  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  const magnitude = new Float64Array(noteBands.at(-1)[1] + 1), pitches = new Float64Array(NOTE_COUNT);
  const raw = [];
  for (let center = first; center <= end; center += HOP) {
    for (let j = 0; j < FFT_SIZE; j++) {
      const position = center + j - FFT_SIZE / 2;
      re[j] = position >= first && position < end ? window[j] * (mono[position] / peak) : 0;
    }
    im.fill(0);
    fft(re, im);
    for (let k = noteBands[0][0]; k < magnitude.length; k++) magnitude[k] = Math.hypot(re[k], im[k]);
    for (let i = 0; i < NOTE_COUNT; i++) {
      const [lo, hi] = noteBands[i];
      let loudest = 0;
      for (let k = lo; k <= hi; k++) loudest = Math.max(loudest, magnitude[k]);
      pitches[i] = Math.log(loudest + 1e-4);
    }
    const row = new Float64Array(PITCHES);
    for (let i = 0; i < NOTE_COUNT; i++) {
      let local = 0;
      for (const k of notes[i]) local += pitches[k];
      row[(i + LOWEST_NOTE) % PITCHES] += Math.max(0, pitches[i] - local / 9) ** 1.6;
    }
    raw.push(row);
  }
  const frames = raw.map((_, t) => {
    const row = new Float64Array(PITCHES);
    for (let j = 0; j < smoothing.length; j++) {
      const other = raw[reflectFrame(t + j - 4, raw.length)];
      for (let p = 0; p < PITCHES; p++) row[p] += other[p] * (smoothing[j] / totalWeight);
    }
    const average = row.reduce((a, b) => a + b) / PITCHES;
    const centered = row.map(x => x - average);
    const norm = Math.max(1e-6, Math.hypot(...centered));
    return Float32Array.from(centered, x => x / norm);
  });
  return { frames, offsetMs: 1000 * first / SAMPLE_RATE, hopMs: HOP_MS };
}
