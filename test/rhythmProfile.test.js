import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRhythmOnsets } from '../src/audio/RhythmProfile.js';

test('steady beat-aligned kicks produce a confident, regular rhythm profile', () => {
  const onsets = Array.from({ length: 120 }, (_, i) => ({
    tMs: i * 500,
    kick: true,
    vel: 0.8,
  }));

  const profile = summarizeRhythmOnsets(onsets, 60000, {
    beatPeriodMs: 500,
    confidence: 0.9,
  });

  assert.equal(profile.eventRateHz, 2);
  assert.equal(profile.eventDensity, 0.5);
  assert.equal(profile.kickShare, 1);
  assert.equal(profile.pulseRegularity, 0.9);
  assert.equal(profile.confidence, 0.9);
});

test('unmetered rhythm preserves density while declining to invent a pulse', () => {
  const onsets = [
    { tMs: 100, kick: true, vel: 0.7 },
    { tMs: 900, kick: false, vel: 0.5 },
    { tMs: 2450, kick: true, vel: 0.9 },
    { tMs: 4000, kick: false, vel: 0.4 },
  ];

  const profile = summarizeRhythmOnsets(onsets, 4000, {
    beatPeriodMs: 0,
    confidence: 0,
  });

  assert.equal(profile.eventRateHz, 1);
  assert.equal(profile.eventDensity, 0.25);
  assert.equal(profile.kickShare, 0.5);
  assert.equal(profile.pulseRegularity, 0);
  assert.equal(profile.confidence, 0);
});
