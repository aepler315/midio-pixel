import assert from 'node:assert/strict';
import { test } from 'node:test';

test('BiomeManager is importable as an ES module', async () => {
  const module = await import('../src/world/BiomeManager.js');
  assert.equal(typeof module.BiomeManager, 'function');
});
