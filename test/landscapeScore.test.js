import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStorm } from '../src/world/alpine/RangeStorm.js';

const sections = [0, 20000, 40000, 60000, 80000, 100000].map((startMs, i) => ({
  startMs, endMs: startMs + 20000, provenance: 'detected', motifId: i % 2 ? 'chorus' : 'verse',
}));
const energyCurves = { globalEnergyNorm: t => (t >= 20000 && t < 40000) || (t >= 60000 && t < 80000) ? .95 : .15 };
const song = { sections, energyCurves, durationMs: 120000 };

test('two separated sustained musical peaks produce two weather episodes and a quiet recovery', () => {
  const score = compileStorm(song);
  assert.equal(score.episodes?.length, 2);
  assert.ok(score.at(28000).amount > .9);
  assert.equal(score.at(50000).amount, 0);
  assert.ok(score.at(50000).break01 > .5);
  assert.ok(score.at(68000).amount > .9);
});

test('quiet recordings and flat unsegmented drones do not acquire an obligatory storm', () => {
  for (const energy of [.0, .2, .8]) {
    const score = compileStorm({ durationMs: 120000, energyCurves: { globalEnergyNorm: () => energy } });
    assert.equal(score.at(60000).amount, 0, `flat activity ${energy}`);
    assert.equal(score.section, null);
  }
});

test('normalized background noise cannot become storm weather when physical power is negligible', () => {
  const score = compileStorm({ ...song, energyCurves: { ...energyCurves, rmsBands: [new Float32Array(2)], sampleRms: () => .00001 } });
  assert.equal(score.at(28000).amount, 0);
});

test('weather, musical phrasing and camera moves share a deterministic heard-time score', () => {
  const storm = compileStorm(song);
  assert.ok(storm.landscape, 'the shared performance schedule must be exposed');
  const a = storm.landscape.at(29000), b = storm.landscape.at(29000);
  assert.deepEqual(a, b);
  assert.equal(a.motifId, 'chorus');
  assert.equal(storm.landscape.at(69000).motifId, a.motifId);
  assert.ok(a.energy01 > .9);
  assert.ok(Object.isFrozen(storm.landscape.phrases));
  assert.ok(Object.values(a.camera).filter(v => typeof v === 'number').every(Number.isFinite));
});

test('analysis adoption preserves the active phrase and weather, then admits future episodes', () => {
  const previous = compileStorm(song);
  assert.ok(previous.landscape);
  const replacement = compileStorm({ ...song, energyCurves: { globalEnergyNorm: t => t >= 80000 && t < 100000 ? .9 : .1 },
    previous: previous.landscape, committedThroughMs: 29000 });
  for (const t of [28000, 29000, 30000, 39000]) {
    assert.deepEqual(replacement.at(t), previous.at(t), `active weather at ${t}`);
    assert.deepEqual(replacement.landscape.at(t), previous.landscape.at(t), `active camera at ${t}`);
  }
  assert.ok(replacement.at(88000).amount > .8);
  const a = replacement.landscape.at(40000).camera, b = replacement.landscape.at(40001).camera;
  for (const key of ['dolly', 'yaw', 'crane', 'truck']) assert.ok(Math.abs(a[key] - b[key]) < .0001);
});

test('seeking does not accumulate or replay flashes from another weather episode', () => {
  const storm = compileStorm({ ...song, timeline: [28000, 68000].map(tMs => ({ tMs, pitch: 36, role: 'RHYTHM', vel: .95 })) });
  assert.ok(storm.at(68000).flash > .5);
  assert.equal(storm.at(50000).flash, 0);
  assert.deepEqual(storm.at(28000), storm.at(28000));
  assert.equal(storm.at(68000, { reducedFlash: true }).flash, 0);
});

test('late analysis cannot rewrite a flash already heard or consume its restrike', () => {
  const previous = compileStorm({ ...song, timeline: [{ tMs: 29000, pitch: 36, role: 'RHYTHM', vel: .9 }] });
  const next = compileStorm({ ...song, timeline: [{ tMs: 29050, pitch: 36, role: 'RHYTHM', vel: 1 }],
    previous: previous.landscape, committedThroughMs: 29020 });
  for (const t of [29000, 29020, 29050, 29150]) assert.deepEqual(next.at(t), previous.at(t));
});

test('an unsegmented final build closes at the exact decoded duration between weather samples', () => {
  const storm = compileStorm({ durationMs: 30001, sections: [], timeline: [],
    energyCurves: { globalEnergyNorm: t => t < 15000 ? .1 : .9 } });
  assert.equal(storm.landscape.episodes.length, 1);
  assert.equal(storm.landscape.episodes[0].startMs, 15000);
  assert.equal(storm.landscape.episodes[0].endMs, 30001);
});
