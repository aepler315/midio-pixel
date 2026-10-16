import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePitchFeatures, computePitchFeaturesAsync, chromaHistogram, melodyPitchAt, estimateBassPitchAt,
  tonalityFrom, tonalityTimeline, meanBrightness, windowChroma, midiToHz, fft,
} from '../src/audio/PitchTracker.js';
import { buildSongProfile } from '../src/audio/SongProfile.js';

const SR = 44100;

function sine(freqs, seconds, sr = SR, amp = 0.3) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (const f of freqs) {
    for (let i = 0; i < n; i++) out[i] += amp * Math.sin((2 * Math.PI * f * i) / sr);
  }
  return out;
}

test('fft recovers a pure tone at the right bin', () => {
  const n = 1024;
  const re = new Float32Array(n), im = new Float32Array(n);
  const bin = 37;
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * bin * i) / n);
  fft(re, im);
  let best = 0, bestMag = 0;
  for (let b = 1; b < n / 2; b++) {
    const m = Math.hypot(re[b], im[b]);
    if (m > bestMag) { bestMag = m; best = b; }
  }
  assert.equal(best, bin);
});

test('async pitch analysis yields and honors cancellation', async () => {
  const controller = new AbortController();
  const pending = computePitchFeaturesAsync(sine([440], 1.0), SR, {
    yieldEvery: 1,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('melodyPitchAt finds the true pitch of a sustained A4 (440Hz)', () => {
  const mono = sine([440], 1.0);
  const features = computePitchFeatures(mono, SR);
  const pitch = melodyPitchAt(features, 200);
  assert.equal(pitch, 69, `expected MIDI 69 (A4), got ${pitch}`);
});

test('phase-inverted stereo retains melody and bass pitch evidence', () => {
  const left = sine([440, 55], 1.0);
  const right = Float32Array.from(left, (x) => -x);
  const features = computePitchFeatures([left, right], SR);
  assert.equal(melodyPitchAt(features, 200), 69, 'spectral power must not cancel across channels');
  const bass = estimateBassPitchAt([left, right], SR, 100);
  assert.ok(Math.abs(bass - 33) <= 1, `expected inverse-phase A1 to remain ~33, got ${bass}`);
});

test('melodyPitchAt reads the fundamental, not a louder harmonic, on a weak-fundamental A3', () => {
  // A real instrument's 2nd harmonic routinely outshines its fundamental --
  // reproduces the reported bug: an A3 (220Hz) tone with a stronger 2nd
  // harmonic (A4, 440Hz) was registering as A4 instead of A3.
  const n = Math.round(1.0 * SR);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mono[i] = 0.3 * Math.sin((2 * Math.PI * midiToHz(57) * i) / SR)
      + 0.6 * Math.sin((2 * Math.PI * midiToHz(69) * i) / SR);
  }
  const features = computePitchFeatures(mono, SR);
  const pitch = melodyPitchAt(features, 200);
  assert.equal(pitch, 57, `expected MIDI 57 (A3, the fundamental), got ${pitch}`);
});

test('melodyPitchAt returns null on silence so callers keep their fallback', () => {
  const mono = new Float32Array(SR); // 1s of silence
  const features = computePitchFeatures(mono, SR);
  assert.equal(melodyPitchAt(features, 200), null);
});

test('chromaHistogram of a C major triad peaks at C, E, G', () => {
  // C4, E4, G4
  const mono = sine([midiToHz(60), midiToHz(64), midiToHz(67)], 1.0);
  const features = computePitchFeatures(mono, SR);
  const hist = chromaHistogram(features);
  const ranked = hist.map((e, pc) => ({ e, pc })).sort((a, b) => b.e - a.e).map((c) => c.pc);
  const top3 = new Set(ranked.slice(0, 3));
  for (const pc of [0, 4, 7]) assert.ok(top3.has(pc), `expected pitch class ${pc} in top 3, got ${[...top3]}`);
});

test('tonalityFrom: a major triad reads major, a minor triad reads minor', () => {
  const majFeatures = computePitchFeatures(sine([midiToHz(60), midiToHz(64), midiToHz(67)], 1.0), SR);
  const maj = tonalityFrom(chromaHistogram(majFeatures));
  assert.ok(maj.majorness > 0.2, `expected clearly major, got ${maj.majorness}`);

  const minFeatures = computePitchFeatures(sine([midiToHz(57), midiToHz(60), midiToHz(64)], 1.0), SR);
  const min = tonalityFrom(chromaHistogram(minFeatures));
  assert.ok(min.majorness < -0.2, `expected clearly minor, got ${min.majorness}`);
});

test('estimateBassPitchAt recovers a 55Hz bass fundamental (A1 = MIDI 33)', () => {
  const mono = sine([55], 0.5);
  const pitch = estimateBassPitchAt(mono, SR, 100);
  assert.ok(Math.abs(pitch - 33) <= 1, `expected ~33, got ${pitch}`);
});

test('estimateBassPitchAt returns null on silence and on white noise', () => {
  assert.equal(estimateBassPitchAt(new Float32Array(SR), SR, 100), null);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const noise = Float32Array.from({ length: SR }, () => rand() * 0.3);
  const p = estimateBassPitchAt(noise, SR, 100);
  // Noise autocorrelation must not clear the 0.25 confidence floor.
  assert.equal(p, null, `expected null on noise, got ${p}`);
});

test('meanBrightness: a 4kHz tone reads brighter than a 110Hz tone', () => {
  const hi = meanBrightness(computePitchFeatures(sine([4000], 0.5), SR));
  const lo = meanBrightness(computePitchFeatures(sine([110], 0.5), SR));
  assert.ok(hi > lo + 0.3, `expected clear brightness separation, got hi=${hi} lo=${lo}`);
});

test('windowChroma returns the strongest classes of a window and [] for silence', () => {
  const mono = sine([midiToHz(62), midiToHz(66), midiToHz(69)], 1.0); // D major triad
  const features = computePitchFeatures(mono, SR);
  const chord = windowChroma(features, 0, 1000, 3);
  assert.ok(chord.length >= 2 && chord.length <= 3);
  const classes = new Set(chord.map((c) => c.pc));
  assert.ok(classes.has(2), `expected D (2) in ${[...classes]}`);
  for (const c of chord) assert.ok(c.strength > 0 && c.strength <= 1);

  const silent = computePitchFeatures(new Float32Array(SR / 2), SR);
  assert.deepEqual(windowChroma(silent, 0, 400), []);
});

test('tonalityTimeline provides a causal, confident key stream from spectral chroma', () => {
  const mono = sine([midiToHz(60), midiToHz(64), midiToHz(67)], 8.0);
  const timeline = tonalityTimeline(computePitchFeatures(mono, SR), { durationMs: 8000, hopMs: 1000 });
  const late = timeline.find((k) => k.tMs === 7000);
  assert.ok(late, 'expected a 7s key sample');
  assert.equal(late.tonic, 0, `expected C tonic, got ${late.tonic}`);
  assert.equal(late.mode, 'major');
  assert.ok(late.confidence > 0, 'a sustained triad should carry nonzero confidence');
});

test('ambiguous pitch becomes low key confidence on the song profile, not a fake tonic fact', () => {
  const flat = tonalityFrom([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.ok(flat.confidence < 0.35, `flat chroma must not look decided, got ${flat.confidence}`);
  const profile = buildSongProfile({
    durationMs: 4000,
    analysis: { tonic: flat.tonic, mode: flat.mode, tonalConfidence: flat.confidence },
  });
  assert.equal(profile.tonal.source, 'spectral-fallback');
  assert.ok(profile.confidence.key <= 0.2);
});
