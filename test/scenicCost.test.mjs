import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strideCost, TILE_BYTES, MANIFEST_TILE_BYTES } from '../tools/lib/scenic-cost.mjs';

// A 4x2-tile grid whose shipped package holds tile (1,0) at stride 4.
const ctx = { grid: { width: 257, height: 129 }, terrain: { manifest: { tileCells: 64 }, data: { byIndex: new Map([['1,0', { stride: 4 }], ['2,0', { stride: 8, visible: false }]]) } } };

test('a new tile costs its samples and its manifest entry; a shipped one only the finer detail', () => {
  const cost = strideCost(ctx);
  assert.equal(cost.tilesX, 4);
  assert.equal(cost.shipped(1), 4);
  assert.equal(cost.shipped(2), null, 'a hidden shipped tile is not drawn, so not owned');
  assert.equal(cost.marginal(new Map([[0, 2]])), TILE_BYTES[2] + MANIFEST_TILE_BYTES);
  assert.equal(cost.marginal(new Map([[1, 1]])), TILE_BYTES[1] - TILE_BYTES[4]);
  assert.equal(cost.marginal(new Map([[1, 8]])), 0, 'coarser than shipped costs nothing');
});

test('footprints add up tile by tile at the finest stride any record needs', () => {
  const cost = strideCost(ctx);
  const a = new Map([[0, 4], [5, 16]]), b = new Map([[0, 1], [6, 64]]);
  const owned = cost.own(a, new Map());
  assert.equal(cost.marginal(b, owned), TILE_BYTES[1] - TILE_BYTES[4] + TILE_BYTES[64] + MANIFEST_TILE_BYTES);
  assert.equal(cost.total([a, b]), cost.marginal(a) + cost.marginal(b, owned));
  assert.equal(cost.total([a, a]), cost.marginal(a));
});
