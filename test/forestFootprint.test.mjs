// Scenic shot tours: a view's forest follows every eye path its library can
// take (view.cameraPaths), not only the authored rail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { placeForest, forestPlacementBound, FOREST_RINGS } from '../src/world/alpine/ForestCover.js';

// The forestCover.test.js valley: lake floor, forest slopes, a summit.
const W = 257, cell = 10;
const hAt = (x, z) => {
  const r = Math.abs(x);
  if (r < 150) return 500;
  if (x > 700 && x < 760) return 500 + 0.35 * 550 + (x - 700) * 3;
  return 500 + 0.35 * (r - 150) + (x > 760 ? 180 : 0) + Math.max(0, 900 - Math.hypot(x - 1000, z)) * 1.2;
};
const heightsM = new Float32Array(W * W), valid = new Uint8Array(W * W).fill(1);
for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) heightsM[r * W + c] = hAt(-1280 + c * cell, -1280 + r * cell);
const grid = { width: W, height: W, cellSizeM: cell, originM: [-1280, -1280], heightsM, valid,
  horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: cell, outputSpacingM: cell };
const view = { id: 'forest-footprint', camera: { eyeStartM: [-200, 1400, 2600], eyeEndM: [200, 1400, 2600],
  targetStartM: [-200, 600, 0], targetEndM: [200, 600, 0], fovYDeg: 40 } };
const baked = await bakeTerrain(grid, view);
const data = decodeTerrain(baked.manifest, new Uint8Array(zlib.gunzipSync(baked.payload)));
const rules = { treelineM: 1200, forestMaxSlopeDeg: 40, forestDensity: 0.9 };
const trees = (p) => {
  const out = [];
  for (const [kind, arr] of [['meshDetail', p.meshDetail], ['mesh', p.mesh], ['billboard', p.billboard]]) {
    for (let i = 0; i < arr.length; i += p.stride) out.push({ kind, t: arr.subarray(i, i + p.stride) });
  }
  return out;
};
const segDist = (a, b, p) => {
  const d = b.map((v, k) => v - a[k]), l2 = d.reduce((s, v) => s + v * v, 0);
  const t = l2 > 0 ? Math.max(0, Math.min(1, d.reduce((s, v, k) => s + v * (p[k] - a[k]), 0) / l2)) : 0;
  return Math.hypot(...p.map((v, k) => v - a[k] - t * d[k]));
};
const lineDist = (line, p) => (line.length === 1 ? segDist(line[0], line[0], p)
  : Math.min(...line.slice(1).map((b, i) => segDist(line[i], b, p))));
// A zig-zag traverse along the west slope (many segments), a short climb on
// the east side, and a single hovering point over the lake.
const zigzag = Array.from({ length: 160 }, (_, i) => [-1150 + i * 5, 980 + 40 * Math.sin(i / 3), -900 + (i % 2 ? 30 : -30) + i * 8]);
const footprint = [zigzag, [[400, 1000, -600], [500, 1050, -300], [620, 1100, 0]], [[0, 700, 800]]];

test('an empty cameraPaths list leaves placement and its bound byte-identical', () => {
  const close = { ...view, camera: { ...view.camera, eyeStartM: [-200, 750, 0], eyeEndM: [200, 750, 0], targetStartM: [-200, 600, 500], targetEndM: [200, 600, 500] } };
  for (const v of [view, close]) {
    const base = placeForest(data, v, rules, { seed: 5 });
    assert.ok(base.count > 500, `trees placed: ${base.count}`);
    for (const paths of [[], [[]]]) {
      const same = placeForest(data, { ...v, cameraPaths: paths }, rules, { seed: 5 });
      for (const k of ['meshDetail', 'mesh', 'billboard', 'stride', 'count']) assert.deepEqual(same[k], base[k], k);
      assert.deepEqual(forestPlacementBound(data, { ...v, cameraPaths: paths }, rules), forestPlacementBound(data, v, rules));
    }
  }
});

test('trees near a footprint polyline far from the rail are placed and represented by that distance', () => {
  const rings = { detailM: 100, meshM: 200, billboardM: 300 };
  const railOnly = placeForest(data, view, rules, { seed: 5, rings });
  assert.equal(railOnly.count, 0, 'the rail stands more than a kilometre off the grid');
  const withPaths = placeForest(data, { ...view, cameraPaths: footprint }, rules, { seed: 5, rings, bands: { nearM: 120, midM: 220 } });
  assert.ok(withPaths.count > 300, `trees placed along the footprint: ${withPaths.count}`);
  const kinds = new Set();
  for (const { kind, t } of trees(withPaths)) {
    const p = [t[0], t[1], t[2]], d = Math.min(...footprint.map((line) => lineDist(line, p)));
    kinds.add(kind);
    assert.ok(d <= rings.billboardM + 0.01, `tree ${d.toFixed(1)} m from every path`);
    // Bands use the exact distance: an independent brute force must agree.
    if ([120, 220].every((edge) => Math.abs(d - edge) > 0.01)) assert.equal(t[7], d < 120 ? 2 : d < 220 ? 1 : 0, `band at ${d.toFixed(2)} m`);
    const scale = kind === 'meshDetail' ? rings.detailM : kind === 'mesh' ? rings.meshM : rings.billboardM;
    assert.ok(d < scale * 1.18 + 0.01, `${kind} tree at ${d.toFixed(1)} m`);
  }
  assert.deepEqual([...kinds].sort(), ['billboard', 'mesh', 'meshDetail']);
  const bound = forestPlacementBound(data, { ...view, cameraPaths: footprint }, rules, rings);
  assert.ok(bound.count >= withPaths.count && forestPlacementBound(data, view, rules, rings).count === 0);
});

test('a malformed footprint point is refused instead of turning every distance into NaN', () => {
  for (const paths of [[[[0, 0], [100, 100]]], [[[0, NaN, 0], [100, 500, 100]]], [[[0, 700, 0], [100, Infinity, 100]]], [[0, 700, 0]]]) {
    assert.throws(() => placeForest(data, { ...view, cameraPaths: paths }, rules, { seed: 5 }), /cameraPaths point .* is not a finite \[x, y, z\]/);
    assert.throws(() => forestPlacementBound(data, { ...view, cameraPaths: paths }, rules), /cameraPaths point/);
  }
});

test('with default rings a footprint brings detail-ring trees to a far rail view', () => {
  const railOnly = placeForest(data, view, rules, { seed: 5 });
  const withPaths = placeForest(data, { ...view, cameraPaths: footprint }, rules, { seed: 5 });
  assert.equal(railOnly.meshDetail.length, 0);
  assert.ok(withPaths.meshDetail.length > 0);
  // Every tree the rail already placed keeps its root and size.
  const key = (t) => `${t[0]},${t[2]}`;
  const placed = new Map(trees(withPaths).map(({ t }) => [key(t), [...t.subarray(0, 7)]]));
  for (const { t } of trees(railOnly)) assert.deepEqual(placed.get(key(t)), [...t.subarray(0, 7)]);
  for (let i = 0; i < withPaths.meshDetail.length; i += withPaths.stride) {
    const p = [...withPaths.meshDetail.subarray(i, i + 3)];
    assert.ok(Math.min(...footprint.map((line) => lineDist(line, p))) < FOREST_RINGS.detailM * 1.18 + 0.01);
  }
});
