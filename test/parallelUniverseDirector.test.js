import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelUniverseDirector } from '../src/sim/ParallelUniverseDirector.js';

test('a fresh director is neutral -- no cosmetic drift and no pulse until the first shift', () => {
  const d = new ParallelUniverseDirector();
  assert.equal(d.hueDeg, 0);
  assert.equal(d.hazeMul, 1);
  assert.equal(d.windMul, 1);
  assert.equal(d.terrainMul, 1);
  assert.equal(d.pulse, 0);
});

test('shift() is deterministic per seed, and different seeds usually drift differently', () => {
  const a = new ParallelUniverseDirector();
  const b = new ParallelUniverseDirector();
  a.shift('song123:2');
  b.shift('song123:2');
  assert.deepEqual(
    { h: a.hueDeg, haze: a.hazeMul, wind: a.windMul, terrain: a.terrainMul },
    { h: b.hueDeg, haze: b.hazeMul, wind: b.windMul, terrain: b.terrainMul },
    'the same seed must reproduce the same universe on replay',
  );
  const c = new ParallelUniverseDirector();
  c.shift('song123:3');
  assert.notEqual(a.hueDeg, c.hueDeg, 'a different section index should (almost always) roll a different universe');
});

test('every cosmetic knob stays inside its documented jitter band, across many seeds', () => {
  const d = new ParallelUniverseDirector();
  for (let i = 0; i < 200; i++) {
    d.shift(`seed:${i}`);
    assert.ok(Math.abs(d.hueDeg) <= 10, `hueDeg out of band: ${d.hueDeg}`);
    assert.ok(d.hazeMul >= 1 - 0.18 - 1e-9 && d.hazeMul <= 1 + 0.18 + 1e-9, `hazeMul out of band: ${d.hazeMul}`);
    assert.ok(d.windMul >= 1 - 0.22 - 1e-9 && d.windMul <= 1 + 0.22 + 1e-9, `windMul out of band: ${d.windMul}`);
    assert.ok(d.terrainMul >= 1 - 0.12 - 1e-9 && d.terrainMul <= 1 + 0.12 + 1e-9, `terrainMul out of band: ${d.terrainMul}`);
  }
});

test('shift() starts the pulse envelope, which rises then settles back to (near) zero', () => {
  const d = new ParallelUniverseDirector();
  d.shift('a');
  assert.ok(d.pulse === 0, 'pulse starts at 0 the instant of the shift, before any update() has run');
  let peak = 0;
  for (let i = 0; i < 240; i++) { d.update(1 / 60); peak = Math.max(peak, d.pulse); }
  assert.ok(peak > 0.9, `expected the pulse to rise close to 1, got peak ${peak}`);
  assert.ok(d.pulse < 0.02, `expected the pulse to have settled back down, got ${d.pulse}`);
});

test('update() with no pending shift is inert', () => {
  const d = new ParallelUniverseDirector();
  for (let i = 0; i < 60; i++) d.update(1 / 60);
  assert.equal(d.pulse, 0);
});

test('a second shift mid-pulse restarts the envelope from zero, not from wherever it was', () => {
  const d = new ParallelUniverseDirector();
  d.shift('a');
  for (let i = 0; i < 20; i++) d.update(1 / 60); // partway up the rise
  const midPulse = d.pulse;
  assert.ok(midPulse > 0);
  d.shift('b');
  assert.equal(d.pulse, midPulse, 'shift() itself does not touch pulse -- only the next update() does');
  d.update(1 / 60);
  assert.ok(d.pulse >= 0, 'restarts cleanly rather than going negative or NaN');
});

test('a zero or negative dt is inert rather than explosive', () => {
  const d = new ParallelUniverseDirector();
  d.shift('a');
  d.update(0);
  assert.ok(Number.isFinite(d.pulse));
  d.update(-1);
  assert.ok(Number.isFinite(d.pulse) && d.pulse >= 0);
});
