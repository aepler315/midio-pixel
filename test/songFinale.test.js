import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '../src/core/NoteEvent.js';
import {
  findLastImpactMs, findBuildPeakMs, analyzeSongFinale, buildPeakProgress,
  FINALE_FREEZE_LEAD_MS,
} from '../src/core/SongFinale.js';

test('last impact prefers the final kick when it closes the song', () => {
  const timeline = [
    { tMs: 1000, role: Role.RHYTHM, kick: true },
    { tMs: 5000, role: Role.MELODY, vel: 0.5 },
    { tMs: 9000, role: Role.RHYTHM, kick: true },
    { tMs: 9200, role: Role.MELODY, vel: 0.4 },
  ];
  assert.equal(findLastImpactMs(timeline, 12000), 9000);
});

test('last impact falls back to last note when no kick is near the end', () => {
  const timeline = [
    { tMs: 1000, role: Role.RHYTHM, kick: true },
    { tMs: 8000, role: Role.MELODY, vel: 0.9 },
  ];
  // Kick is 7s before last note → not "near the end"
  assert.equal(findLastImpactMs(timeline, 10000), 8000);
});

test('build peak finds densest late kick cluster', () => {
  const kicks = [];
  // Sparse early
  for (let t = 1000; t < 4000; t += 500) kicks.push({ tMs: t, role: Role.RHYTHM, kick: true });
  // Dense near end
  for (let t = 7000; t < 8500; t += 80) kicks.push({ tMs: t, role: Role.RHYTHM, kick: true });
  const peak = findBuildPeakMs(kicks, 10000, null, 9000);
  assert.ok(peak >= 7000 && peak <= 8500, `peak ${peak} should sit in the dense window`);
});

test('analyzeSongFinale schedules freeze after last impact and silence before freeze', () => {
  const timeline = [
    { tMs: 0, role: Role.RHYTHM, kick: true },
    { tMs: 5000, role: Role.RHYTHM, kick: true },
    { tMs: 10000, role: Role.RHYTHM, kick: true },
  ];
  // Declared duration has a long silence pad after musical end.
  const f = analyzeSongFinale(timeline, 20000);
  assert.equal(f.lastImpactMs, 10000);
  assert.ok(f.freezeAtMs >= f.lastImpactMs, 'freeze after impact');
  assert.ok(f.silenceAtMs <= f.freezeAtMs, 'silence arms at freeze lead');
  assert.ok(f.silenceAtMs >= f.freezeAtMs - FINALE_FREEZE_LEAD_MS - 1);
  assert.ok(f.musicalEndMs < 20000, 'musical end cuts the silence pad');
  assert.ok(f.buildPeakMs > 0 && f.buildPeakMs <= f.lastImpactMs);
});

test('buildPeakProgress is 1 at the peak and falls off', () => {
  assert.equal(buildPeakProgress(5000, 5000), 1);
  assert.ok(buildPeakProgress(5000, 5000 + 5000) < 0.2);
});

test('an opening-only timeline does not end the song at the opening', () => {
  // Song started on its first 15s (OpeningAnalysis.asOpening): events stop
  // at ~14s while the declared duration is the whole 4-minute song.
  const timeline = [];
  for (let t = 0; t < 14500; t += 500) timeline.push({ tMs: t, role: Role.RHYTHM, kick: true });
  const whole = 240000;
  const naive = analyzeSongFinale(timeline, whole);
  assert.ok(naive.freezeAtMs < 15000, 'precondition: the bug this guards against');
  const f = analyzeSongFinale(timeline, whole, null, { analyzedThroughMs: 15000 });
  assert.ok(f.freezeAtMs >= whole - FINALE_FREEZE_LEAD_MS, `freeze at ${f.freezeAtMs}`);
  assert.ok(f.silenceAtMs > 200000);
  // A fully analysed song still ends on its last impact.
  const full = analyzeSongFinale(timeline, whole, null, { analyzedThroughMs: whole });
  assert.equal(full.lastImpactMs, naive.lastImpactMs);
});
