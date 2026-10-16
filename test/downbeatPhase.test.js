import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTempo, buildDriftAwareBarGrid, bandEnvelope, envelopeFrameCount, normalizeBands, detectRhythmOnsets } from '../src/audio/OnsetDetector.js';
import { analysisCacheKey } from '../src/audio/AnalysisCache.js';
import { packBundle, unpackBundle } from '../src/audio/AnalysisBundle.js';
import { Conductor } from '../src/core/Conductor.js';

function pulses(seconds, { rate = 44100 / 512, bpm = 120, offsetMs = 0, meter = 4, hats = false, accent = true, quietIntro = 0 } = {}) {
  const O = new Float32Array(Math.round(rate * seconds));
  const kickFrames = [];
  const tau = rate * 60 / bpm;
  for (let beat = 0, f = offsetMs / 1000 * rate; f < O.length; beat++, f += tau) {
    const fi = Math.round(f);
    if (fi >= O.length || f < quietIntro * rate) continue;
    O[fi] = accent && beat % meter === 0 ? 1 : 0.3;
    kickFrames.push(fi);
    if (hats && Math.round(f + tau / 2) < O.length) O[Math.round(f + tau / 2)] = 0.15;
  }
  return { O, kickFrames, rate, tau };
}

for (const seconds of [20, 60, 120, 240, 600, 1200]) {
  test(`exact 120 BPM downbeat phase and last bar stay within one frame at ${seconds}s`, () => {
    const { O, rate, kickFrames } = pulses(seconds);
    const tempo = estimateTempo(O, rate, kickFrames);
    const frameMs = 1000 / rate;
    assert.ok(Math.abs(tempo.bpm - 120) < 1, `${tempo.bpm} BPM`);
    assert.ok(tempo.firstBarMs <= frameMs, `first bar ${tempo.firstBarMs}ms`);
    const grid = buildDriftAwareBarGrid(tempo.firstBarMs, seconds * 1000, 4, rate, tempo.curve, tempo.tau);
    const last = grid.at(-1);
    assert.ok(Math.abs(last.ms - last.tick * 500) <= frameMs, `last bar ${last.ms}ms vs ${last.tick * 500}ms`);
    assert.ok(tempo.phaseConfidence > 0.5);
    assert.ok(tempo.downbeatConfidence > 0.5);
    assert.ok(tempo.meterConfidence > 0.1);
  });
}

test('fractional rates, shifted starts, hats and three-beat accents preserve annotated phase', () => {
  for (const rate of [44100 / 512, 48000 / 512]) for (const meter of [3, 4]) {
    const { O, kickFrames } = pulses(240, { rate, bpm: 137, offsetMs: 173, meter, hats: true });
    const tempo = estimateTempo(O, rate, kickFrames);
    assert.equal(tempo.beatsPerBar, meter);
    assert.ok(Math.abs(tempo.firstBarMs - 173) <= 1000 / rate, `offset ${tempo.firstBarMs}ms`);
    const grid = buildDriftAwareBarGrid(tempo.firstBarMs, 240000, meter, rate, tempo.curve, tempo.tau);
    for (const b of grid) assert.ok(Math.abs(b.ms - (173 + b.tick * 60000 / 137)) <= 1000 / rate, `bar ${b.tick}: ${b.ms}ms`);
  }
});

test('tempo confidence does not certify an unaccented meter or downbeat', () => {
  const { O, rate, kickFrames } = pulses(120, { accent: false });
  const tempo = estimateTempo(O, rate, kickFrames);
  assert.ok(tempo.confidence > 0.7);
  assert.ok(tempo.phaseConfidence > 0.5);
  assert.ok(tempo.downbeatConfidence < 0.1);
  assert.ok(tempo.meterConfidence < 0.1);
  assert.equal(tempo.beatsPerBar, 4);
});

test('quiet intro and free-time evidence retain honest phase confidence', () => {
  const { O, rate, kickFrames } = pulses(240, { quietIntro: 12 });
  const tempo = estimateTempo(O, rate, kickFrames);
  assert.ok(tempo.firstBarMs <= 1000 / rate);
  assert.ok(tempo.curve[0].phaseConfidence < tempo.curve[1].phaseConfidence);
  for (const envelope of [new Float32Array(2000), Float32Array.from({ length: 2000 }, (_, i) => i % 419 === 7 ? 1 : 0)]) {
    const sparse = estimateTempo(envelope, rate, []);
    assert.equal(sparse.freeTime, true);
    assert.ok(sparse.phaseConfidence < 0.25);
    assert.ok(sparse.downbeatConfidence < 0.25);
  }
});

test('generated PCM clicks reproduce duration-invariant phase through raw RMS and onset detection', () => {
  const sampleRate = 44100, offsetMs = 173;
  for (const seconds of [20, 120]) {
    const pcm = new Float32Array(sampleRate * seconds);
    for (let beat = 0, from = Math.round(sampleRate * offsetMs / 1000); from < pcm.length; beat++, from += sampleRate / 2) {
      const amplitude = beat % 4 === 0 ? 1 : 0.3;
      for (let j = 0; j < 180 && from + j < pcm.length; j++) pcm[from + j] = amplitude * Math.exp(-j / 50) * Math.sin(2 * Math.PI * 100 * j / sampleRate);
    }
    const { rate, numFrames } = envelopeFrameCount(pcm.length, sampleRate);
    const env = bandEnvelope({ numberOfChannels: 1, getChannelData: () => pcm }, numFrames);
    const raw = Array.from({ length: 7 }, (_, b) => b < 2 ? env : new Float32Array(numFrames));
    const { O, onsets } = detectRhythmOnsets(normalizeBands(raw, rate), raw, rate);
    const tempo = estimateTempo(O, rate, onsets.filter(o => o.kick).map(o => o.frame));
    // The forward 1024-sample RMS window exposes an attack up to two hops early.
    assert.ok(Math.abs(tempo.firstBarMs - offsetMs) <= 2 * 1000 / rate, `${seconds}s raw phase ${tempo.firstBarMs}ms`);
  }
});

test('new analysis revision rejects stale outputs and preserves confidence through bundle and conductor', () => {
  const key = analysisCacheKey({ key: 'recording', durationMs: 60000, signal: 0.9 });
  assert.notEqual(JSON.parse(key)[0], 'analysis-v2');
  const data = { timeline: [], barGrid: [{ ms: 173, tick: 0, numerator: 4, denominator: 4 }], durationMs: 60000, bpm: 120, beatPeriodMs: 500, confidence: 0.9, phaseConfidence: 0.8, downbeatConfidence: 0.7, meterConfidence: 0.6, firstBarMs: 173, localTempo: [{ tMs: 0, beatPeriodMs: 500, confidence: 0.9, firstBeatMs: 173, phaseConfidence: 0.8 }] };
  const packed = packBundle(data);
  const restored = unpackBundle(packed);
  const conductor = new Conductor();
  conductor.load(restored);
  for (const field of ['phaseConfidence', 'downbeatConfidence', 'meterConfidence']) {
    assert.equal(restored[field], data[field]);
    assert.equal(conductor.beatMetadata[field], data[field]);
  }
  assert.equal(restored.songProfile.confidence.phase, 0.8);
  assert.equal(restored.songProfile.confidence.downbeat, 0.7);
  assert.equal(restored.songProfile.confidence.meter, 0.6);
  assert.deepEqual(restored.localTempo, data.localTempo);
  for (const field of ['phaseConfidence', 'downbeatConfidence', 'meterConfidence']) {
    const corrupt = structuredClone(packed);
    corrupt[field] = NaN;
    assert.equal(unpackBundle(corrupt), null);
  }
  const stale = structuredClone(packed);
  delete stale.analysisRevision;
  assert.equal(unpackBundle(stale), null);
  const seen = [];
  conductor.onBar(b => seen.push(b.ms));
  conductor.dispatchUpTo(172);
  assert.deepEqual(seen, []);
  conductor.dispatchUpTo(173);
  assert.deepEqual(seen, [173]);
  conductor.seekTo(0);
  conductor.dispatchUpTo(173);
  assert.deepEqual(seen, [173, 173]);
});

test('rubato local phase anchors bound bar error and reject unsupported phase jumps', () => {
  const rate = 44100 / 512, seconds = 240;
  const O = new Float32Array(Math.round(rate * seconds)), kickFrames = [], bars = [];
  for (let beat = 0, f = 0; f < O.length; beat++) {
    const fi = Math.round(f);
    O[fi] = beat % 4 === 0 ? 1 : 0.3;
    kickFrames.push(fi);
    if (beat % 4 === 0) bars.push(f / rate * 1000);
    f += rate * 60 / (120 + 3 * Math.sin(2 * Math.PI * f / (rate * 120)));
  }
  const tempo = estimateTempo(O, rate, kickFrames);
  const grid = buildDriftAwareBarGrid(tempo.firstBarMs, seconds * 1000, 4, rate, tempo.curve, tempo.tau);
  for (let i = 0; i < Math.min(grid.length, bars.length); i++) assert.ok(Math.abs(grid[i].ms - bars[i]) < 100, `rubato bar ${i}: ${grid[i].ms} vs ${bars[i]}`);
  const corrupted = [{ startFrame: 0, tau: 43, confidence: 0.9, phaseFrame: 18, phaseConfidence: 0.99 }];
  const bounded = buildDriftAwareBarGrid(0, 10000, 4, rate, corrupted, 43);
  assert.equal(bounded[0].ms, 0);
  assert.ok(Math.abs(bounded[1].ms - 172 / rate * 1000) < 1e-6, 'a nearly half-beat jump cannot re-anchor the grid');
});

test('a fully silent opening window and shifted first downbeats keep the musical origin', () => {
  for (const offsetMs of [0, 173, 999, 1831]) {
    const { O, rate, kickFrames } = pulses(240, { offsetMs, quietIntro: 40 });
    const tempo = estimateTempo(O, rate, kickFrames);
    assert.ok(Math.abs(tempo.firstBarMs - offsetMs) <= 1000 / rate, `quiet origin ${offsetMs}: ${tempo.firstBarMs}`);
    assert.equal(tempo.curve[0].phaseConfidence, 0);
  }
});

test('rounded impulses and interpolated Gaussian peaks agree on long-file phase', () => {
  for (const seconds of [600, 1200]) {
    const rate = 44100 / 512, tau = rate / 2;
    const O = new Float32Array(Math.round(rate * seconds)), kickFrames = [];
    for (let beat = 0, f = 0; f < O.length; beat++, f += tau) {
      kickFrames.push(Math.round(f));
      for (let j = Math.max(0, Math.floor(f) - 3); j <= Math.min(O.length - 1, Math.ceil(f) + 3); j++) O[j] += (beat % 4 === 0 ? 1 : 0.3) * Math.exp(-((j - f) ** 2) / 2);
    }
    const tempo = estimateTempo(O, rate, kickFrames);
    assert.ok(tempo.firstBarMs <= 1000 / rate);
    const grid = buildDriftAwareBarGrid(tempo.firstBarMs, seconds * 1000, 4, rate, tempo.curve, tempo.tau);
    assert.ok(Math.abs(grid.at(-1).ms - grid.at(-1).tick * 500) <= 1000 / rate);
  }
});
