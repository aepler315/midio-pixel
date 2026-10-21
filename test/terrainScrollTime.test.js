import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a same-biome returning-section cut completes within its short cut window', async () => {
  const { blendSections } = await import('../src/world/BiomeSchedule.js');
  const sections = [{ startMs: 0, profile: 'TAIGA', heightMul: 1 }, { startMs: 5000, profile: 'TAIGA', heightMul: 2, transition: 'cut', barMs: 2000 }];
  assert.equal(blendSections(sections, 5800).t, 1);
});

test('legacy scanned terrain scroll advances with time', async () => {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const m = Object.create(BiomeManager.prototype);
  Object.assign(m, { world: { kind: 'alpine' }, energyCurves: { globalEnergyNorm: () => .5 }, durationMs: 60000,
    w: 1280, _scannedLayer: () => true,
    _terrainStripWidth: () => 10000, _scannedMaxDepth: () => 1, tSec: 10 });
  const before = m._terrainScroll('L2', 2000); m.tSec = 20;
  assert.notEqual(m._terrainScroll('L2', 4000), before);
});
