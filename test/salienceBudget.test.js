import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salienceBudgetFor } from '../src/render/SalienceBudget.js';

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

test('world-local structures take precedence over broad bloom even during a drop', () => {
  for (const kind of ['city', 'nave', 'overgrowth', 'foundry', 'abyssal', 'airless']) {
    const budget = salienceBudgetFor({ subject: 'drop', mul: () => 0.3 }, { kind });
    assert.ok(budget.bloom < 0.8, kind + ' broad bloom must support local light');
    assert.equal(budget.landmark, 1);
    assert.equal(budget.terrain, 1);
  }
});
