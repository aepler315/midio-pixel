import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

test('WP11 the narrative Range never steps the generic weaver', () => {
  assert.equal(BiomeManager.prototype.optionalEffectsActive.call({ world: { kind: 'alpine' }, rangeNarrative: {} }).weaver, false);
  assert.equal(BiomeManager.prototype.optionalEffectsActive.call({ world: { kind: 'alpine' } }).weaver, true, 'legacy Range remains eligible');
});
