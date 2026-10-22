import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terrainCostModel, TILE_BYTES } from '../tools/lib/scenic-cost.mjs';

// Two 64-cell tiles side by side: flat ground, then sharp ridges.
function ctx(shipped = {}) {
  const width = 129, height = 65, heightsM = new Float32Array(width * height), valid = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 66; x < width; x++) heightsM[y * width + x] = 40 * Math.abs(Math.sin(x * 1.3)) + 25 * Math.abs(Math.cos(y * 0.9));
  const byIndex = new Map(Object.entries(shipped).map(([k, stride]) => [k, { stride }]));
  return { grid: { width, height, heightsM, valid }, terrain: { manifest: { tileCells: 64 }, data: { byIndex } } };
}

test('the stride a tile needs follows its relief and how sharply it is seen', () => {
  const cost = terrainCostModel(ctx(), { scale: 4 });
  assert.equal(cost.strideFor(0, 50), 64, 'flat ground needs no detail however close');
  assert.ok(cost.strideFor(1, 50) <= 2, 'sharp ridges seen up close need full detail');
  assert.ok(cost.strideFor(1, 0.05) > cost.strideFor(1, 50), 'and less from far away');
});

test('a footprint costs only the detail it adds beyond the shipped package and what is already owned', () => {
  const fp = new Map([[0, 50], [1, 50]]);
  const bare = terrainCostModel(ctx(), { scale: 4 });
  const need = bare.strideFor(1, 50);
  assert.equal(bare.marginal(fp), TILE_BYTES[64] + TILE_BYTES[need]);
  const shipped = terrainCostModel(ctx({ '0,0': 64, '1,0': 4 }), { scale: 4 });
  assert.equal(shipped.marginal(fp), TILE_BYTES[need] - TILE_BYTES[4], 'a shipped tile pays the difference to the finer stride');
  const owned = shipped.own(fp, new Map());
  assert.equal(shipped.marginal(fp, owned), 0, 'nothing more once another shot has paid for it');
});
