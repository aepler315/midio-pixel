import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constrainPalette } from '../src/world/WorldIdentity.js';
import { ParticleField } from '../src/world/ParticleField.js';
import { getWorld } from '../src/world/Worlds.js';

for (const [id, kind] of [['fathom', 'bubbles'], ['understory', 'pollen']]) {
  test(`${id} generated drift respects actual particle physics`, () => {
    const world = getWorld(id), stock = world.palettes[0];
    const palette = constrainPalette(world, { ...stock, particles: { ...stock.particles, kind, count: 100, driftBias: { vx: 80, vy: 34 } } }, stock);
    const field = new ParticleField(palette.particles, 1280, 720, 315);
    const before = field.particles.map(p => ({ x: p.x, y: p.y }));
    field.update(0.01, 1, null, 1000);
    field.particles.forEach((p, i) => {
      if (kind === 'bubbles') assert.ok(p.y < before[i].y, 'bubbles must rise');
      else assert.ok(Math.abs(p.y - before[i].y) <= 0.091, 'pollen keeps slow local drift');
    });
  });
}
