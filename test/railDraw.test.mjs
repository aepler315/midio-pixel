import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain, buildTerrainGeometry, terrainBandsFor, terrainFringeBytes, terrainRailCopyBytes, BANDS } from '../src/world/alpine/TerrainMesh.js';
import { createBandGeometries } from '../src/world/alpine/TerrainGL.js';
import { placeForest, LATTICE_M } from '../src/world/alpine/ForestCover.js';
import { createForest } from '../src/world/alpine/ForestGL.js';
import { waterIndexSubset, waterIndexSubsetAsync, waterIndexSubsetPartsAsync, wetTexelMask } from '../src/world/alpine/WaterSubset.js';
import { setTerrainDrawMode, drawnIndexCount, tourGround } from '../src/world/alpine/RailDraw.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

// The terrainBakePoses fixture (4 x 4 tiles of 64 cells at 20 m, a rail at
// z = -600 looking north) with forest-friendly ground, and tour poses that
// add ground only they see: one far and wide, so its ground is coarse.
function fixture() {
  const width = 257, depth = 257, cellSizeM = 20, originM = [-2560, -2560];
  const ground = (x, z) => 1000 + 150 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53) + 0.15 * Math.cos(x / 23 - z / 31);
  const heightsM = new Float32Array(width * depth);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) heightsM[j * width + i] = ground(originM[0] + i * cellSizeM, originM[1] + j * cellSizeM);
  const grid = { width, height: depth, cellSizeM, originM, heightsM, valid: new Uint8Array(width * depth).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const view = { id: 'rail-draw', camera: { eyeStartM: [0, 1500, -600], eyeEndM: [0, 1500, -600],
    targetStartM: [0, 1000, -2400], targetEndM: [0, 1000, -2400], fovYDeg: 30 } };
  return { grid, view };
}
const POSES = [{ eyeM: [800, 1500, 300], targetM: [800, 1000, 1600], fovYDeg: 40 }, { eyeM: [-1500, 6000, 2400], targetM: [-2400, 1000, 600], fovYDeg: 50 }];
let cache = null;
async function packages() {
  if (cache) return cache;
  const { grid, view } = fixture();
  const rail = await bakeTerrain(grid, view);
  const tour = await bakeTerrain(grid, view, { poses: POSES, poseErrorScale: 64 });
  cache = { view, rail: decodeTerrain(rail.manifest, rail.decoded), tour: decodeTerrain(tour.manifest, tour.decoded) };
  return cache;
}
/** The package as if its tour-only tiles had never shipped. */
function withoutTourGround(data) {
  const tiles = new Map([...data.tiles].filter(([, t]) => t.rail !== false));
  return { ...data, tiles, byIndex: new Map([...tiles.values()].map((t) => [`${t.ix},${t.iz}`, t])) };
}
/** Triangles of `index` (an array of a band's indices) as sorted position
 *  tuples: a picture, whatever the vertex order. */
const picture = (positions, index) => {
  const out = [];
  for (let i = 0; i + 2 < index.length; i += 3) {
    out.push([0, 1, 2].map((k) => Array.from(positions.subarray(3 * index[i + k], 3 * index[i + k] + 3)).join(',')).join(' '));
  }
  return out.sort();
};

test('the rail draws its package without the tour ground; the tour draws every tile once', async () => {
  const { rail, tour } = await packages();
  assert.ok(tourGround(tour) && !tourGround(rail));
  const split = buildTerrainGeometry(tour), whole = buildTerrainGeometry(tour, { railSplit: false });
  const railOnly = buildTerrainGeometry(withoutTourGround(tour));
  const railMode = terrainBandsFor(split, 'rail'), tourMode = terrainBandsFor(split, 'tour');
  let copies = 0, hidden = 0;
  for (const band of BANDS) {
    const b = split.bands[band];
    assert.deepEqual(picture(b.positions, railMode[band].indices), picture(railOnly.bands[band].positions, railOnly.bands[band].indices), `${band} rail`);
    assert.deepEqual(picture(b.positions, railMode[band].fringe), picture(railOnly.bands[band].positions, railOnly.bands[band].fringe), `${band} rail seam fill`);
    assert.deepEqual(picture(b.positions, tourMode[band].indices), picture(whole.bands[band].positions, whole.bands[band].indices), `${band} tour`);
    assert.deepEqual(picture(b.positions, tourMode[band].fringe), picture(whole.bands[band].positions, whole.bands[band].fringe), `${band} tour seam fill`);
    if (b.ranges) {
      // One contiguous range per mode: the rail's from 0, the tour's to the end.
      assert.equal(b.ranges.rail[0], 0);
      assert.ok(b.ranges.tour[0] <= b.ranges.rail[1]);
      assert.equal(b.ranges.tour[0] + b.ranges.tour[1], b.indices.length);
      copies += b.ranges.tour[0];
      hidden += b.indices.length - b.ranges.rail[1];
    }
  }
  assert.ok(hidden > 0, 'the tour ships ground its rail never draws');
  assert.ok(split.stats.railCopies > 0 && copies > 0, 'a rail tile next to coarser tour ground has a rail copy');
  assert.equal(split.stats.triangles, whole.stats.triangles);
  assert.equal(split.stats.railTriangles, railOnly.stats.triangles);
  // The reservation counts the seam fill and the copies exactly.
  const fringeBytes = BANDS.reduce((n, b) => n + split.bands[b].fringe.byteLength, 0);
  assert.equal(terrainFringeBytes(tour), fringeBytes);
  assert.equal(terrainRailCopyBytes(tour), split.stats.bytes - whole.stats.bytes);
  assert.equal(terrainRailCopyBytes(rail), 0);
  // A package without tour ground builds byte for byte as before.
  const plain = buildTerrainGeometry(rail), plainWhole = buildTerrainGeometry(rail, { railSplit: false });
  for (const band of BANDS) {
    assert.equal(plain.bands[band].ranges, null);
    assert.equal(plain.bands[band].fringeRanges, null);
    assert.deepEqual(plain.bands[band].positions, plainWhole.bands[band].positions);
    assert.deepEqual(plain.bands[band].indices, plainWhole.bands[band].indices);
    assert.deepEqual(plain.bands[band].fringe, plainWhole.bands[band].fringe);
  }
});

test('band geometries start on the rail and never draw their whole buffer', async () => {
  const { rail, tour } = await packages();
  const geos = createBandGeometries(THREE, tour);
  const split = Object.values(geos.geometries).filter((g) => g.userData.terrainRanges);
  assert.ok(split.length > 0);
  for (const g of [...Object.values(geos.geometries), ...Object.values(geos.fringes)]) {
    const r = g.userData.terrainRanges;
    if (!r) { assert.deepEqual([g.drawRange.start, g.drawRange.count], [0, Infinity]); continue; }
    assert.deepEqual([g.drawRange.start, g.drawRange.count], r.rail);
    setTerrainDrawMode(g, 'tour');
    assert.deepEqual([g.drawRange.start, g.drawRange.count], r.tour);
    assert.equal(drawnIndexCount(g), r.tour[1]);
    setTerrainDrawMode(g, 'rail');
    assert.equal(drawnIndexCount(g), r.rail[1]);
  }
  const tourStart = createBandGeometries(THREE, tour, { terrainMode: 'tour' });
  for (const g of Object.values(tourStart.geometries)) if (g.userData.terrainRanges) assert.equal(g.drawRange.start, g.userData.terrainRanges.tour[0]);
  assert.throws(() => setTerrainDrawMode(split[0], 'all'), /terrain draw mode all/);
  for (const g of Object.values(createBandGeometries(THREE, rail).geometries)) assert.equal(g.userData.terrainRanges, undefined);
});

test('a water subset cut at the mode boundaries keeps each mode\'s triangles', async () => {
  // Synthetic triangles over a wet mask: the cut subset is the plain subset,
  // and each cut counts exactly the kept triangles before it.
  let seed = 7;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const w = 48, h = 40, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba[i + 3] = r() < 0.3 ? 255 : 10;
  const grid = { originM: [0, 0], cellSizeM: 20, width: w, height: h };
  const n = 3000, positions = new Float32Array(n * 9), index = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const x = r() * (w - 1) * 20, z = r() * (h - 1) * 20;
    for (let v = 0; v < 3; v++) { positions.set([x + r() * 10, 1000, z + r() * 10], (t * 3 + v) * 3); index[t * 3 + v] = t * 3 + v; }
  }
  const mask = wetTexelMask(rgba, w, h);
  const cuts = [3 * 700, 3 * 2100];
  let pauses = [0, 0];
  const plain = await waterIndexSubsetAsync(positions, index, grid, mask, { maxShare: 1, sliceTriangles: 333, pause: async () => { pauses[0]++; } });
  const parts = await waterIndexSubsetPartsAsync(positions, index, grid, mask, { maxShare: 1, sliceTriangles: 333, cuts, pause: async () => { pauses[1]++; } });
  assert.deepEqual(parts.keep, plain);
  for (let c = 0; c < cuts.length; c++) assert.equal(parts.before[c], waterIndexSubset(positions, index.subarray(0, cuts[c]), grid, mask, { maxShare: 1 }).length);
  assert.ok(pauses[1] >= pauses[0]);
  assert.deepEqual((await waterIndexSubsetPartsAsync(positions, index, grid, mask, { maxShare: 1 })).before, []);
});

test('the rail\'s trees lead every batch, and the rail draws only them', async () => {
  const { view, tour } = await packages();
  const rules = { treelineM: 2000, forestMaxSlopeDeg: 60, forestDensity: 1, forestFloorM: 0 };
  const railGround = withoutTourGround(tour);
  const railTrees = placeForest(railGround, view, rules), tourTrees = placeForest(tour, view, rules);
  assert.equal(railTrees.railCount, undefined, 'a package without tour ground places no tour trees');
  assert.ok(tourTrees.railCount && tourTrees.count > railTrees.count, 'the tour ground grows trees');
  const S = tourTrees.stride, cs = tour.grid.cellSizeM, size = tour.cells * cs, [ox, oz] = tour.grid.originM;
  const owner = (x, z) => tour.byIndex.get(`${Math.floor((x - ox) / size)},${Math.floor((z - oz) / size)}`);
  let added = 0;
  for (const kind of ['meshDetail', 'mesh', 'billboard']) {
    const all = tourTrees[kind], n = tourTrees.railCount[kind], mine = railTrees[kind];
    // The trees of the package without tour ground, in order, plus the ones
    // its missing neighbours denied a slope: they stand within a cell of it.
    let j = 0;
    for (let i = 0; i < n; i++) {
      const tree = all.subarray(i * S, i * S + S), x = tree[0], z = tree[2];
      assert.ok(owner(x, z)?.rail !== false, `${kind} tree ${i} stands on the rail's ground`);
      if (j < mine.length / S && tree.every((v, k) => v === mine[j * S + k])) { j++; continue; }
      added++;
      const ex = (x - ox) / size % 1, ez = (z - oz) / size % 1, edge = Math.min(ex, 1 - ex, ez, 1 - ez) * size;
      assert.ok(edge <= 1.5 * cs, `${kind} tree ${i} is new away from the rail's border (${edge.toFixed(1)} m in)`);
    }
    assert.equal(j, mine.length / S, `${kind}: every tree of the rail's ground stands in the rail's part`);
    // The tour's trees stand on its ground, or were jittered off it (at
    // most one lattice cell) onto the rail's.
    for (let i = n; i < all.length / S; i++) {
      const x = all[i * S], z = all[i * S + 2];
      if (owner(x, z)?.rail === false) continue;
      const near = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]].some(([dx, dz]) => owner(x + dx * LATTICE_M, z + dz * LATTICE_M)?.rail === false);
      assert.ok(near, `${kind} tour tree ${i} stands a lattice cell from tour ground at most`);
    }
  }
  assert.ok(added < 0.05 * railTrees.count, `${added} border trees`);
  const forest = createForest(THREE, tourTrees, {});
  assert.ok(forest.modeGeometries.length > 0);
  for (const g of forest.modeGeometries) {
    const c = g.userData.instanceCounts;
    assert.ok(c.rail < c.tour && g.instanceCount === c.rail, 'a batch starts on the rail');
  }
  for (const g of forest.modeGeometries) setTerrainDrawMode(g, 'tour');
  assert.ok(forest.modeGeometries.every((g) => g.instanceCount === g.userData.instanceCounts.tour));
  const railDrawn = forest.modeGeometries.reduce((s, g) => s + g.userData.instanceCounts.rail, 0);
  assert.ok(railDrawn < forest.modeGeometries.reduce((s, g) => s + g.userData.instanceCounts.tour, 0));
  assert.equal(createForest(THREE, railTrees, {}).modeGeometries.length, 0);
  forest.dispose();
});

test('setCameraTour switches every prepared geometry, the water and the height range between the rail and the tour', () => {
  const ranged = (rail, tour) => {
    const g = new THREE.BufferGeometry();
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(30), 1));
    g.userData.terrainRanges = { rail, tour };
    setTerrainDrawMode(g, 'rail');
    return g;
  };
  const band = ranged([0, 12], [6, 24]), ink = ranged([0, 4], [4, 9]);
  const trees = new THREE.InstancedBufferGeometry();
  trees.userData.instanceCounts = { rail: 3, tour: 10 };
  setTerrainDrawMode(trees, 'rail');
  const modeWater = { rail: { waterLevelM: null, mirrorLevelM: null, heightRange: [0, 100] }, tour: { waterLevelM: 700, mirrorLevelM: 700, heightRange: [-50, 200] } };
  const p = { view: { id: 'v' }, modeGeometries: [band, ink, trees], terrainMode: 'rail', cameraTour: null, stats: { triangles: 10, railTriangles: 4 },
    modeWater, waterLevelM: null, mirrorLevelM: null, castWaterLevelM: null, uniforms: { uHeightRange: { value: new THREE.Vector2(0, 100) } } };
  const scene = { prepared: new Map([['v', p]]), depthCache: { A: { frame: 9 }, B: { frame: 9 } }, mirrors: { A: { frame: 9 }, B: null },
    _setTerrainMode: RangeScene.prototype._setTerrainMode };
  const tour = { poseAt: () => null, durationMs: 1 };
  RangeScene.prototype.setCameraTour.call(scene, 'v', tour);
  assert.deepEqual([band.drawRange.start, band.drawRange.count, ink.drawRange.start, trees.instanceCount], [6, 24, 4, 10]);
  assert.equal(p.terrainMode, 'tour');
  assert.equal(p.stats.drawnTriangles, 10);
  // The tour's own lake, mirror plane and height range; the cast keeps the rail's water.
  assert.deepEqual([p.waterLevelM, p.mirrorLevelM, p.uniforms.uHeightRange.value.x, p.uniforms.uHeightRange.value.y, p.castWaterLevelM], [700, 700, -50, 200, null]);
  assert.deepEqual([scene.depthCache.A.frame, scene.depthCache.B.frame, scene.mirrors.A.frame], [-1, -1, -1]);
  // A refined plan stays on the tour without touching anything.
  scene.depthCache.A.frame = 5;
  RangeScene.prototype.setCameraTour.call(scene, 'v', { ...tour });
  assert.equal(scene.depthCache.A.frame, 5);
  RangeScene.prototype.setCameraTour.call(scene, 'v', null);
  assert.deepEqual([band.drawRange.start, band.drawRange.count, trees.instanceCount], [0, 12, 3]);
  assert.equal(p.stats.drawnTriangles, 4);
  assert.deepEqual([p.waterLevelM, p.mirrorLevelM, p.uniforms.uHeightRange.value.x, p.uniforms.uHeightRange.value.y], [null, null, 0, 100]);
  // Highway tour windows have no rail.
  const windowed = { view: { id: 'w', tour: {} }, windowCache: {}, modeGeometries: [band], cameraTour: null };
  scene.prepared.set('w', windowed);
  RangeScene.prototype.setCameraTour.call(scene, 'w', tour);
  assert.equal(band.drawRange.count, 12);
});
