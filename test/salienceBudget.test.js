import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salienceBudgetFor } from '../src/render/SalienceBudget.js';
import { getWorld } from '../src/world/Worlds.js';

test('a dramatic subject protects landmark and terrain while reducing supporting spectacle', () => {
  const budget = salienceBudgetFor({
    subject: 'voyage',
    mul: (key) => key === 'sky' ? 0.3 : 0.3,
  });

  assert.equal(budget.subject, 'voyage');
  assert.equal(budget.landmark, 1);
  assert.equal(budget.terrain, 1);
  assert.ok(budget.sky < 1);
  assert.ok(budget.particles < 1);
  assert.ok(budget.bloom < 1);
});

test('a drop keeps its own bloom while still reducing unrelated particles', () => {
  const budget = salienceBudgetFor({
    subject: 'drop',
    mul: () => 0.3,
  });

  assert.equal(budget.bloom, 1);
  assert.ok(budget.particles < 1);
});

test('a world keeps its structure and the drop its full bloom', () => {
  for (const world of [getWorld('alpine'), getWorld('trio'), { kind: 'unregistered-kind' }]) {
    const budget = salienceBudgetFor({ subject: 'drop', mul: () => 0.3 }, world);
    assert.equal(budget.landmark, 1, world.kind);
    assert.equal(budget.terrain, 1, world.kind);
    assert.equal(budget.bloom, 1, world.kind);
    assert.ok(budget.particles < 1, world.kind);
    assert.equal(salienceBudgetFor(null, world).bloom, 1, world.kind);
  }
});

test('ordinary playback is a no-op budget', () => {
  const budget = salienceBudgetFor(null);
  assert.deepEqual(budget, {
    subject: null,
    landmark: 1,
    terrain: 1,
    sky: 1,
    particles: 1,
    bloom: 1,
  });
});
