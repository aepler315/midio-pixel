// The land moves only at the song's big moments (RangeFrame.landMoment01 /
// landMotion): still between section changes, a slow swell at each one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAND_SWELL, landMoment01, landMotion, landWaveDir, rangeMusicState, sceneDeformation } from '../src/world/alpine/RangeFrame.js';

const sections = [
  { startMs: 0, label: 'intro', meanEnergy: 0.2, relEnergy01: 0.2 },
  { startMs: 20000, label: 'verse', meanEnergy: 0.3, relEnergy01: 0.4 },
  { startMs: 40000, label: 'drop', meanEnergy: 0.9, relEnergy01: 1 },
  { startMs: 60000, label: 'drop', meanEnergy: 0.9, relEnergy01: 1 },
];
const span = LAND_SWELL.riseMs + LAND_SWELL.holdMs + LAND_SWELL.settleMs;

test('the land is still between moments and at the song start', () => {
  for (const t of [0, 5000, 19999, 20000 + span, 39000, 60000 + 4000, 90000]) assert.equal(landMoment01(sections, t), 0, `${t}`);
  assert.equal(landMoment01(null, 1000), 0);
});

test('a lift into a louder part swells fully; a plain change swells less; a repeat not at all', () => {
  const peakOf = (start) => Math.max(...Array.from({ length: 60 }, (_, i) => landMoment01(sections, start + i * 250)));
  const drop = peakOf(40000), verse = peakOf(20000);
  assert.ok(drop > 0.9, `${drop}`);
  assert.ok(Math.abs(verse - LAND_SWELL.changeFloor) < 0.05, `${verse}`);
  assert.equal(peakOf(60000), 0, 'drop into the same drop');
});

test('a swell rises and settles slowly: no frame jolts', () => {
  let prev = 0, maxStep = 0;
  for (let t = 39000; t < 40000 + span + 1000; t += 1000 / 24) {
    const m = landMoment01(sections, t);
    maxStep = Math.max(maxStep, Math.abs(m - prev));
    prev = m;
  }
  assert.ok(maxStep < 0.03, `${maxStep}`);
});

test('kicks, melody and gesture move nothing; the moment alone shapes the land', () => {
  const loud = rangeMusicState({ env: { groove: 1, sustain: 1, kickMul: 1, gesture: 1 }, evaluatedKick01: 1,
    melody: { activity: 1, pitch01: 0.8, pan: 0.3 }, structural01: 1, activity01: 1, tSec: 12 });
  const still = landMotion(loud, 0, { tSec: 12 });
  assert.equal(sceneDeformation(still, 900, 400, 1800, [0, 2000]), 0);
  assert.equal(still.source, loud, 'the heard channels stay on the frame');
  assert.equal(still.kick01, loud.kick01, 'water still ripples to the kick');
  const swell = landMotion(loud, 1, { tSec: 12 });
  assert.ok(Math.abs(sceneDeformation(swell, 900, 400, 1800, [0, 2000])) > 1);
  assert.ok(swell.totalBoundM <= LAND_SWELL.waveM + LAND_SWELL.liftM);
  assert.equal(sceneDeformation(landMotion(loud, 1, { tSec: 12, reducedMotion: true }), 900, 400, 1800, [0, 2000]), 0);
});

test('a louder repeat of the same part still never swells', () => {
  const secs = [{ startMs: 0, label: 'a', meanEnergy: 0.1, relEnergy01: 0.1 }, { startMs: 20000, label: 'a', meanEnergy: 0.9, relEnergy01: 1 }];
  for (let t = 20000; t < 20000 + span; t += 500) assert.equal(landMoment01(secs, t), 0);
});

test('a live re-analysis keeps the swells already heard and starts none in the past', () => {
  // Playing on the opening analysis: a change at 30 s. The whole-song
  // analysis lands at 36 s with that boundary moved to 33 s and a new one at 35 s.
  const before = [{ startMs: 0, label: 'a' }, { startMs: 30000, label: 'b' }];
  const after = [{ startMs: 0, label: 'a' }, { startMs: 33000, label: 'b' }, { startMs: 35000, label: 'c' }, { startMs: 50000, label: 'd' }];
  const history = { sections: before, throughMs: 36000 };
  for (let t = 36000; t < 46000; t += 1000 / 24) {
    assert.equal(landMoment01(after, t, history), landMoment01(before, t), `${t}`);
  }
  // Boundaries after the handoff come from the new analysis.
  assert.ok(landMoment01(after, 54000, history) > 0.3);
  assert.equal(landMoment01(before, 54000), 0);
});

test('boundaries crossed while the show was rebuilt start no swell after it rejoins', () => {
  // Cutoff captured at 36 s; the rebuilt show rejoins the kept audio at 40 s.
  const before = [{ startMs: 0, label: 'a' }];
  const after = [{ startMs: 0, label: 'a' }, { startMs: 38000, label: 'b' }, { startMs: 41000, label: 'c' }];
  const history = { sections: before, throughMs: 36000, rejoinMs: 40000 };
  assert.equal(landMoment01(after, 40000, history), 0, 'the 38 s change was never seen, so it starts nothing');
  assert.ok(landMoment01(after, 44000, history) > 0.3, 'the 41 s change swells as usual');
  // Without the rejoin time the 38 s change would pop in mid-rise.
  assert.ok(landMoment01(after, 40000, { sections: before, throughMs: 36000 }) > 0);
});

test('a decorative pacing cut never swells, even between different labels', () => {
  const secs = [{ startMs: 0, label: 'a' }, { startMs: 80000, label: 'b', provenance: 'decorative' }];
  for (let t = 80000; t < 80000 + span; t += 500) assert.equal(landMoment01(secs, t), 0);
});

test('the swell keeps one direction for the whole song', () => {
  const a = rangeMusicState({ motif: { angle: 0.4 }, tSec: 3 }), b = rangeMusicState({ motif: { angle: -0.4 }, tSec: 3 });
  assert.notDeepEqual(a.waveDir, b.waveDir, 'the heard channels still turn with the section');
  assert.deepEqual(landMotion(a, 0.5, { seed: 7 }).waveDir, landMotion(b, 0.5, { seed: 7 }).waveDir);
  assert.deepEqual(landMotion(a, 0.5, { seed: 7 }).waveDir, landWaveDir(7));
});

test('an authored section cue swells even when the analysis gave both sides one label', () => {
  const secs = [{ startMs: 0, label: 0 }, { startMs: 32000, label: 0, provenance: 'authored' }];
  assert.ok(landMoment01(secs, 32000 + LAND_SWELL.riseMs + 1000) >= LAND_SWELL.changeFloor - 1e-9);
});
