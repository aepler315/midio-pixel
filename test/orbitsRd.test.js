import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReactionDiffusion } from '../src/world/ReactionDiffusion.js';

function fakeEnergy(value) {
  return { globalEnergy: () => value, sample: () => value };
}

// --- Orbital debris ---

test('Gray-Scott concentrations stay clamped to [0,1] under regime sweeps', () => {
  const rd = new ReactionDiffusion(9);
  let t = 0;
  for (let i = 0; i < 600; i++) {
    rd.update(t, 1 / 120, fakeEnergy(i % 2 ? 0.9 : 0.1), 0);
    if (i % 60 === 0) rd.onKick();
    t += 8.33;
  }
  for (let i = 0; i < rd.u.length; i++) {
    assert.ok(rd.u[i] >= 0 && rd.u[i] <= 1);
    assert.ok(rd.v[i] >= 0 && rd.v[i] <= 1);
  }
});

test('Gray-Scott develops spatial structure from its seeds (variance well above zero)', () => {
  const rd = new ReactionDiffusion(5); // constructor warms up 400 iterations
  let mean = 0;
  for (let i = 0; i < rd.v.length; i++) mean += rd.v[i];
  mean /= rd.v.length;
  let variance = 0;
  for (let i = 0; i < rd.v.length; i++) variance += (rd.v[i] - mean) ** 2;
  variance /= rd.v.length;
  assert.ok(variance > 1e-4, `expected a live pattern, got variance ${variance}`);
});

test('an unseeded uniform Gray-Scott plate stays uniform (no spontaneous noise)', () => {
  const rd = new ReactionDiffusion(5);
  rd.u.fill(1); rd.v.fill(0);
  for (let i = 0; i < 100; i++) rd.step(0.0367, 0.0649);
  for (let i = 0; i < rd.v.length; i++) assert.equal(rd.v[i], 0);
});
