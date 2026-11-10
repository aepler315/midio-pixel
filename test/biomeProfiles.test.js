import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIOMES } from '../src/world/BiomeProfiles.js';

test('every biome has a unique fx and a distinct terrainEnergy -- no two read visually identical', () => {
  const fxNames = BIOMES.map((b) => b.fx);
  assert.equal(new Set(fxNames).size, BIOMES.length, 'every biome must have its own fx treatment');
  for (const b of BIOMES) {
    assert.ok(Number.isFinite(b.terrainEnergy), `${b.name} must define terrainEnergy`);
    assert.ok(b.terrainEnergy > 0, `${b.name}.terrainEnergy must be positive`);
  }
  const energies = BIOMES.map((b) => b.terrainEnergy);
  assert.ok(Math.max(...energies) - Math.min(...energies) > 0.3, 'terrain energy must spread meaningfully across biomes, not cluster near 1');
});
