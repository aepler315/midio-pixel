import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawnWeatherKindFor, windSpeedScaleFor } from '../src/world/BiomeManager.js';
import { ParticleField } from '../src/world/ParticleField.js';

test('the Range paints epic ember weather as driven wind', () => {
  assert.equal(drawnWeatherKindFor('alpine', 'embers'), 'wind');
});

test('every other Range weather kind, and every other world, paints as directed', () => {
  for (const kind of ['rain', 'snow', 'petals', 'sunshine', 'fog', 'wind']) assert.equal(drawnWeatherKindFor('alpine', kind), kind);
  for (const world of ['city', 'fathom', undefined]) assert.equal(drawnWeatherKindFor(world, 'embers'), 'embers');
});

test('the Range slows wind streaks to a drift; other worlds keep their gale', () => {
  assert.equal(windSpeedScaleFor('alpine'), .125);
  for (const world of ['city', 'fathom', undefined]) assert.equal(windSpeedScaleFor(world), 1);
  const travel = (scale) => {
    const f = new ParticleField({ kind: 'wind', color: '#fff', count: 8, speed: 0 }, 1280, 720, 7);
    f.windSpeedScale = scale;
    const x0 = f.particles.map(p => p.x), len0 = f.particles.map(p => p.vx);
    f.update(.1, 1, null, 1000, 0, { x: 20, y: 0 });
    return { dx: f.particles.map((p, i) => p.x - x0[i]), len: f.particles.map((p, i) => p.vx - len0[i]) };
  };
  const full = travel(1), slow = travel(.25);
  full.dx.forEach((dx, i) => assert.ok(Math.abs(slow.dx[i] - dx * .25) < 1e-9));
  assert.deepEqual(slow.len, full.len, 'the drawn streak length keeps its speed');
});
