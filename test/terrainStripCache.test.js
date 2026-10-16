import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainStripCache, stripSetBytes } from '../src/world/terrain/TerrainStripCache.js';

test('owned surface descriptors count against strip-set memory', () => {
  const a = strip(10, 20);
  a.ridge = { surface: { byteLength: 2048 } };
  assert.equal(stripSetBytes({ L2: a }), 10 * 20 * 4 + 2048);
});

const strip = (width, height) => ({ width, height });

test('strip byte accounting includes every owned RGBA surface', () => {
  assert.equal(stripSetBytes({ L2: strip(10, 20), L3: strip(4, 5) }), (200 + 20) * 4);
});

test('cache evicts least-recent unpinned palettes by accounted bytes', () => {
  const cache = new TerrainStripCache({ maxBytes: 1_000 });
  cache.set('a', { L2: strip(10, 10) }); // 400
  cache.set('b', { L2: strip(10, 10) }); // 400
  cache.get('a');
  cache.set('c', { L2: strip(10, 10) }); // evicts b
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.bytes, 800);
});

test('current and incoming palettes survive transition eviction', () => {
  const cache = new TerrainStripCache({ maxBytes: 800 });
  cache.set('old', { L2: strip(10, 10) });
  cache.setPins(['from', 'to']);
  cache.set('from', { L2: strip(10, 10) });
  cache.set('to', { L2: strip(10, 10) });
  assert.equal(cache.has('old'), false);
  assert.equal(cache.has('from'), true);
  assert.equal(cache.has('to'), true);
});

test('clear releases every owned palette', () => {
  const cache = new TerrainStripCache({ maxBytes: 1_000 });
  const surface = strip(10, 10);
  surface.getContext = () => ({});
  cache.set('a', { L2: surface });
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(surface.width, 0);
  assert.equal(surface.height, 0);
});

test('reserve evicts before the next palette allocation', () => {
  const cache = new TerrainStripCache({ maxBytes: 1_000 });
  cache.set('old', { L2: strip(10, 10) });
  cache.set('current', { L2: strip(10, 10) });
  cache.setPins(['current']);
  assert.equal(cache.reserve(400), true);
  assert.equal(cache.has('old'), false);
  assert.equal(cache.bytes + 400 <= cache.maxBytes, true);
});

// --- Regression: the seam between the cache and what actually uses it.
//
// The tests above all size strips at 10x10 against budgets of ~1000 bytes,
// so they exercise the eviction POLICY but never the real ratio of working
// set to budget. At real dimensions a single alpine biome's four layers are
// ~35.8MB and a city biome's ~69.7MB, against DEFAULT_TERRAIN_STRIP_BUDGET
// of 64MB -- so two biomes have never fit, and one city biome does not fit
// on its own.

import { layerBake } from '../src/world/WorldMaterial.js';
import { TERRAIN_STRIP_WIDTH } from '../src/world/terrain/StripRead.js';
import { DEFAULT_TERRAIN_STRIP_BUDGET } from '../src/world/terrain/TerrainStripCache.js';

/** One biome's strip set at the dimensions BiomeManager really bakes. */
function realStripSet(kind) {
  const strips = {};
  for (const layerKey of ['L2', 'L3', 'L4', 'L5']) {
    const bake = layerBake(kind, layerKey);
    const width = layerKey !== 'L5' ? TERRAIN_STRIP_WIDTH : 2048;
    const surface = { width, height: bake.height, getContext: () => ({}) };
    if (bake.profile === 'city') surface.windows = { width, height: bake.height, getContext: () => ({}) };
    strips[layerKey] = surface;
  }
  return strips;
}

test('the default budget holds the two biomes a transition draws at once', () => {
  // Every world's draw function asks for two strip sets per frame:
  //   const stripsA = mgr.stripsFor(from);
  //   const stripsB = mgr.stripsFor(to);
  // If the pair cannot be resident together, fetching the second one evicts
  // the first while the caller is still holding it.
  for (const kind of ['alpine', 'city']) {
    const pair = stripSetBytes(realStripSet(kind)) * 2;
    assert.ok(pair <= DEFAULT_TERRAIN_STRIP_BUDGET,
      `${kind}: a transition needs ${(pair / 1048576).toFixed(1)}MB but the budget is `
      + `${(DEFAULT_TERRAIN_STRIP_BUDGET / 1048576).toFixed(1)}MB`);
  }
});

test('fetching a second strip set does not destroy the first one', () => {
  // The exact shape of drawCity/drawNave/drawFarside/... at real sizes.
  const cache = new TerrainStripCache();
  cache.setPins(['from', 'to']);
  cache.set('from', realStripSet('alpine'));
  cache.set('to', realStripSet('alpine'));

  const stripsA = cache.get('from');
  const stripsB = cache.get('to');
  assert.ok(stripsA && stripsB, 'both sets should still be cached');
  // A destroyed canvas is a 0x0 one: drawing it silently paints nothing.
  for (const [label, set] of [['from', stripsA], ['to', stripsB]]) {
    for (const [layerKey, surface] of Object.entries(set)) {
      assert.ok(surface.width > 0 && surface.height > 0,
        `${label}.${layerKey} was released while still referenced`);
    }
  }
});

test('an entry handed out is not released underneath its holder', () => {
  // Eviction must cost a rebuild, never corrupt a frame already in flight:
  // BiomeManager:4924 fetches two arbitrary section profiles in one
  // expression, and the second fetch re-pins before the first is drawn.
  const cache = new TerrainStripCache({ maxBytes: 1_000 });
  const held = { L2: { width: 10, height: 10, getContext: () => ({}) } };
  cache.set('held', held);
  cache.setPins(['other']);
  cache.set('other', { L2: { width: 10, height: 10, getContext: () => ({}) } });
  cache.set('third', { L2: { width: 10, height: 10, getContext: () => ({}) } });
  assert.equal(cache.has('held'), false, 'it may leave the cache');
  assert.ok(held.L2.width > 0,
    'but the canvas the caller still holds must remain drawable');
});
