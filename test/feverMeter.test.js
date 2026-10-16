import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeverMeter } from '../src/sim/FeverMeter.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { BANDS } from '../src/audio/bands.js';
import { danceOffset, DANCE_LAYERS } from '../src/world/MountainChoreo.js';

function flatEnergy(level, durationMs = 60000) {
  const ec = new EnergyCurves(durationMs);
  for (let f = 0; f < ec.n; f++) ec.setFrame(f, new Array(BANDS.length).fill(level));
  return ec;
}

function hit(offsetMs, tier = 'perfect') {
  return { kind: 'hit', tier, basePts: 100, offsetMs, tMs: 0 };
}

function runSteps(fever, seconds, energy, nowMs = 5000) {
  const dt = 1 / 120;
  for (let i = 0; i < seconds * 120; i++) fever.update(nowMs, dt, energy);
}

test('steady perfect taps at high energy climb toward insane', () => {
  const fever = new FeverMeter();
  const energy = flatEnergy(1);
  for (let i = 0; i < 12; i++) fever.onJudge(hit(4));
  runSteps(fever, 3, energy);
  assert.ok(fever.level > 0.8, `expected insane, got ${fever.level}`);
});

test('the same taps at low song energy stay tame', () => {
  const fever = new FeverMeter();
  const energy = flatEnergy(0.05);
  for (let i = 0; i < 12; i++) fever.onJudge(hit(4));
  runSteps(fever, 3, energy);
  assert.ok(fever.level < 0.4, `low-energy song must cap the fever, got ${fever.level}`);
});

test('jittery offsets kill steadiness even when tiers stay good', () => {
  const steady = new FeverMeter();
  const jittery = new FeverMeter();
  const offsets = [80, -75, 70, -80, 78, -72, 74, -79]; // wild but within window
  for (let i = 0; i < 8; i++) {
    steady.onJudge(hit(5, 'great'));
    jittery.onJudge(hit(offsets[i], 'great'));
  }
  assert.ok(steady.steadiness > 0.85);
  assert.ok(jittery.steadiness < 0.1);
});

test('a consistent 30ms-late player still reads as steady (bias is not jitter)', () => {
  const fever = new FeverMeter();
  for (let i = 0; i < 8; i++) fever.onJudge(hit(30 + (i % 2), 'great'));
  assert.ok(fever.steadiness > 0.9, 'constant lag must not read as sloppiness');
});

test('misses cool the fever faster than hits heat it', () => {
  const fever = new FeverMeter();
  const energy = flatEnergy(1);
  for (let i = 0; i < 12; i++) fever.onJudge(hit(4));
  runSteps(fever, 3, energy);
  const hot = fever.level;
  for (let i = 0; i < 4; i++) fever.onJudge({ kind: 'miss', basePts: 0, tMs: 0 });
  runSteps(fever, 2, energy);
  assert.ok(fever.level < hot * 0.5, `misses must drain it (${fever.level} vs ${hot})`);
});

test('spark bumps the level directly and clamps at 1', () => {
  const fever = new FeverMeter();
  fever.spark(0.5);
  assert.equal(fever.level, 0.5);
  fever.spark(0.9);
  assert.equal(fever.level, 1);
});

test('fever cranks the mountain dance amplitude', () => {
  const cfg = DANCE_LAYERS.L5;
  const cold = danceOffset(100, 2, 1, 0.5, cfg, 0);
  const hot = danceOffset(100, 2, 1, 0.5, cfg, 1);
  assert.ok(Math.abs(hot) > Math.abs(cold) * 2.0, 'insane fever ≳ 2.4× the cold dance');
  const legacy = danceOffset(100, 2, 1, 0.5, cfg); // 5-arg call unchanged
  assert.equal(legacy, cold);
});
