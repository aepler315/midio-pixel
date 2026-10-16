// Range v2 Task 10: forests describe the slopes and never regenerate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import * as forestCover from '../src/world/alpine/ForestCover.js';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { placeForest, keptInstances, forestKeepFraction, LATTICE_M } from '../src/world/alpine/ForestCover.js';
import { sceneDeformation, rangeMusicState } from '../src/world/alpine/RangeFrame.js';

const W = 257, cell = 10;
// A valley with a lake floor (flat, low), gentle forest slopes, a cliff
// band and a summit above the treeline.
const hAt = (x, z) => {
  const r = Math.abs(x);
  if (r < 150) return 500; // lake: hydro-flattened
  if (x > 700 && x < 760) return 500 + 0.35 * 550 + (x - 700) * 3; // cliff
  return 500 + 0.35 * (r - 150) + (x > 760 ? 180 : 0) + Math.max(0, 900 - Math.hypot(x - 1000, z)) * 1.2;
};
const heightsM = new Float32Array(W * W), valid = new Uint8Array(W * W).fill(1);
for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) heightsM[r * W + c] = hAt(-1280 + c * cell, -1280 + r * cell);
const grid = { width: W, height: W, cellSizeM: cell, originM: [-1280, -1280], heightsM, valid,
  horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: cell, outputSpacingM: cell };
const view = { id: 'forest-test', camera: { eyeStartM: [-200, 1400, 2600], eyeEndM: [200, 1400, 2600],
  targetStartM: [-200, 600, 0], targetEndM: [200, 600, 0], fovYDeg: 40 } };
const baked = await bakeTerrain(grid, view);
const data = decodeTerrain(baked.manifest, new Uint8Array(zlib.gunzipSync(baked.payload)));
const rules = { treelineM: 1200, forestMaxSlopeDeg: 40, forestDensity: 0.9 };
const all = (p) => { const out = []; for (const arr of [p.meshDetail || [], p.mesh, p.billboard]) for (let i = 0; i < arr.length; i += p.stride) out.push(arr.subarray(i, i + p.stride)); return out; };

test('detail rail ring splits near instances without altering any tree record', () => {
  assert.equal(forestCover.FOREST_RINGS.detailM, 450);
  const close = { ...view, camera: { ...view.camera, eyeStartM: [-200, 750, 0], eyeEndM: [200, 750, 0],
    targetStartM: [-200, 600, 500], targetEndM: [200, 600, 500] } };
  const p = placeForest(data, close, rules, { seed: 5 });
  const unsplit = placeForest(data, close, rules, { seed: 5, rings: { ...forestCover.FOREST_RINGS, detailM: 0 } });
  assert.ok(p.meshDetail.length > 0 && p.mesh.length > 0 && p.billboard.length > 0);
  assert.equal(p.count, unsplit.count);
  const sorted = p => all(p).sort((a, b) => a[0] - b[0] || a[2] - b[2]).map(t => [...t]);
  assert.deepEqual(sorted(p), sorted(unsplit));
  for (const [arr, lo, hi] of [[p.meshDetail, 0, 450], [p.mesh, 450, 1200], [p.billboard, 1200, 8000]]) {
    for (let i = 0; i < arr.length; i += 8) {
      const d = Math.hypot(arr[i] - Math.max(-200, Math.min(200, arr[i])), arr[i + 1] - 750, arr[i + 2]);
      assert.ok(d >= lo - .001 && d < hi + .001, `rail class ${d}: ${lo}..${hi}`);
    }
  }
  assert.deepEqual(p.meshDetail, placeForest(data, close, rules, { seed: 5 }).meshDetail);
});

test('placement is deterministic and seeded', () => {
  const a = placeForest(data, view, rules, { seed: 5 });
  const b = placeForest(data, view, rules, { seed: 5 });
  assert.deepEqual(a.billboard, b.billboard);
  assert.deepEqual(a.mesh, b.mesh);
  assert.ok(a.count > 500, `trees placed: ${a.count}`);
  const c = placeForest(data, view, rules, { seed: 6 });
  assert.notDeepEqual(c.billboard, a.billboard);
});

test('no trees on water, cliffs or above the treeline; roots sit on the drawn surface', () => {
  const p = placeForest(data, view, rules, { seed: 5 });
  for (const t of all(p)) {
    const [x, y, z] = t;
    // Shoreline trees are real; the flattened lake ends a cell before the slope.
    assert.ok(Math.abs(x) >= 150 - cell, `tree in the lake at ${x}`);
    // No tree on ground the drawn surface makes too steep (the same surface
    // the terrain shader's rock mask reads).
    const d = cell;
    const gx = (terrainHeightAt(data, x + d, z) - terrainHeightAt(data, x - d, z)) / (2 * d);
    const gz = (terrainHeightAt(data, x, z + d) - terrainHeightAt(data, x, z - d)) / (2 * d);
    assert.ok(Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI <= rules.forestMaxSlopeDeg + 3.01, `tree on a cliff at ${x}`);
    assert.ok(y <= rules.treelineM + 110 + 1e-6, `tree above treeline ${y}`);
    // Instances are Float32: x/z/y round to ~1e-4 m, so allow a centimetre.
    assert.ok(Math.abs(terrainHeightAt(data, x, z) - y) < 1e-2, `root off the surface by ${terrainHeightAt(data, x, z) - y}`);
  }
});

test('a forest floor keeps low ground open and treeScale shrinks every tree', () => {
  const base = placeForest(data, view, rules, { seed: 5 });
  const floored = placeForest(data, view, { ...rules, forestFloorM: 800 }, { seed: 5 });
  assert.ok(floored.count > 0 && floored.count < base.count);
  // The floor edge is broken up by up to 100 m either way.
  for (const t of all(floored)) assert.ok(t[1] >= 800 - 100, `tree at ${t[1].toFixed(0)} m under the floor`);
  const small = placeForest(data, view, { ...rules, treeScale: 0.3 }, { seed: 5 });
  assert.equal(small.count, base.count, 'same stands, smaller trees');
  const a = all(base), b = all(small);
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual([...b[i].subarray(0, 3)], [...a[i].subarray(0, 3)]);
    assert.ok(Math.abs(b[i][3] - 0.3 * a[i][3]) < 1e-3);
  }
  // Absent rules are the defaults: nothing moves.
  assert.deepEqual(placeForest(data, view, { ...rules, forestFloorM: undefined, treeScale: undefined }, { seed: 5 }).mesh, base.mesh);
});

test('quality keeps a stable subset and never moves a tree', () => {
  const p = placeForest(data, view, rules, { seed: 5 });
  const full = new Set(keptInstances(p.billboard, p.stride, 0));
  const low = keptInstances(p.billboard, p.stride, 6);
  assert.ok(low.length < full.size * 0.5);
  for (const i of low) assert.ok(full.has(i));
  assert.equal(forestKeepFraction(0), 1);
  assert.ok(forestKeepFraction(6) < forestKeepFraction(3));
  // Placement itself does not depend on quality.
  assert.deepEqual(placeForest(data, view, rules, { seed: 5 }).billboard, p.billboard);
});

test('trees sit on a fixed metric lattice: one per cell at most', () => {
  const p = placeForest(data, view, rules, { seed: 5 });
  const cells = new Set();
  for (const [x, , z] of all(p)) {
    const key = `${Math.floor(x / LATTICE_M)},${Math.floor(z / LATTICE_M)}`;
    assert.ok(!cells.has(key), `two trees in cell ${key}`);
    cells.add(key);
  }
});

test('roots follow the shared deformation at the same heard time after a seek', () => {
  const p = placeForest(data, view, rules, { seed: 5 });
  const [x, y, z] = all(p)[0];
  const at = (t) => sceneDeformation(rangeMusicState({ env: { groove: 0.8, sustain: 0.6, scaleMul: 1.1, kickMul: 0.5 }, tSec: t }), x, z, y, [500, 1600]);
  const first = at(42);
  at(100); at(3);
  assert.equal(at(42), first);
});

test('the async placement yields during the work and gives the same forest', async () => {
  const { placeForestAsync } = await import('../src/world/alpine/ForestCover.js');
  let yields = 0;
  const a = await placeForestAsync(data, view, rules, { seed: 5, sliceMs: 0, yieldTo: async () => { yields++; } });
  const b = placeForest(data, view, rules, { seed: 5 });
  assert.ok(yields > 3, `yielded ${yields} times`);
  assert.deepEqual(a.billboard, b.billboard);
  assert.deepEqual(a.mesh, b.mesh);
});

test('forest rings include stands beside the curved camera path', () => {
  // Endpoints are far outside this patch; the midpoint arcs directly over it.
  const bent = { ...view, camera: { ...view.camera,
    eyeStartM: [-200, 1400, 10000], eyeEndM: [200, 1400, 10000],
    targetStartM: [-200, 600, 0], targetEndM: [200, 600, 0],
    eyeArcM: [0, 0, -9000], targetArcM: [0, 0, -500] } };
  const trees = placeForest(data, bent, rules, { seed: 5, rings: { billboardM: 2500, meshM: 2000 } });
  assert.ok(trees.count > 500, `stands along the curved rail: ${trees.count}`);
});

// Recorded from main d53c6c9 before Phase 2: roots, IDs and band classes.
const mainPlacementSamples = [
  {"index": 0, "bits": [3298604802, 1146983246, 3298724635, 1060999598, 1065353216]},
  {"index": 1, "bits": [3298493097, 1146905052, 3298717788, 1040825874, 1065353216]},
  {"index": 19, "bits": [3294343815, 1144833250, 3298717735, 1059247798, 1065353216]},
  {"index": 99, "bits": [3293754594, 1144627023, 3298473932, 1023482208, 1065353216]},
  {"index": 199, "bits": [3290534940, 1143500144, 3298267796, 1052978244, 1065353216]},
  {"index": 499, "bits": [3292663757, 1144245230, 3297544317, 1051956295, 1065353216]},
  {"index": 999, "bits": [3291535260, 1143850256, 3295998567, 1051931257, 1065353216]},
  {"index": 1999, "bits": [3294105254, 1144749754, 3291164286, 1046814160, 1065353216]},
  {"index": 3999, "bits": [1129731637, 1141023013, 3297955832, 1035389606, 1065353216]},
  {"index": 20736, "bits": [1151201955, 1149614111, 1151250552, 1049084986, 1073741824]}
];
test('species and sizes preserve every main placement root, ID and band byte', () => {
  const p = placeForest(data, view, rules, { seed: 5 });
  const records = all(p).map(t => [t[0], t[1], t[2], t[6], t[7]]);
  assert.equal(p.count, 20737);
  assert.equal(p.mesh.length, 0);
  const bytes = new Float32Array(records.flat());
  assert.equal(createHash('sha256').update(new Uint8Array(bytes.buffer)).digest('hex'),
    'f1292fcfddcc18c6cbb516b491452f07ebfe73b7725fe4b66ef500c982e66010');
  for (const { index, bits } of mainPlacementSamples) {
    assert.deepEqual([...new Uint32Array(new Float32Array(records[index]).buffer)], bits);
  }
});

test('treeTraits follows the prescribed species mix in each elevation band', () => {
  assert.equal(typeof forestCover.treeTraits, 'function');
  const cases = [[1200, [.5, .2, 0, .3]], [650, [.2, .45, .35, 0]], [150, [0, .3, .7, 0]]];
  for (const [below, expected] of cases) {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 10000; i++) {
      const t = forestCover.treeTraits(i % 100 - 50, Math.floor(i / 100) - 50, 315,
        3000 - below, 0, { ...rules, treelineM: 3000 }, view);
      counts[t.species]++;
    }
    expected.forEach((fraction, species) => assert.ok(Math.abs(counts[species] / 10000 - fraction) < .02,
      `band ${below}, species ${species}: ${counts[species] / 10000}`));
  }
});

test('normal trees have species-specific height and crown proportions, and traits drive placement', () => {
  assert.equal(typeof forestCover.treeTraits, 'function');
  const ranges = [[14, 26, .24, .32], [18, 32, .32, .40], [12, 24, .22, .28], [18, 30, .36, .44]];
  const seen = new Set();
  for (const below of [1200, 650]) for (let ix = -200; ix < 200; ix++) {
    const t = forestCover.treeTraits(ix, -7, 315, 3000 - below, 0, { ...rules, treelineM: 3000 }, view);
    const [lo, hi, narrow, wide] = ranges[t.species]; seen.add(t.species);
    assert.ok(t.height >= lo && t.height <= hi);
    assert.ok(t.width / t.height >= narrow && t.width / t.height <= wide);
    assert.deepEqual(t, forestCover.treeTraits(ix, -7, 315, 3000 - below, 0, { ...rules, treelineM: 3000 }, view));
    const scaled = forestCover.treeTraits(ix, -7, 315, 3000 - below, 0, { ...rules, treelineM: 3000, treeScale: .3 }, view);
    assert.ok(Math.abs(scaled.height / t.height - .3) < 1e-12);
    assert.ok(Math.abs(scaled.width / t.width - .3) < 1e-12);
  }
  assert.equal(seen.size, 4);
  for (const t of all(placeForest(data, view, rules, { seed: 5 }))) {
    const ix = Math.floor(t[0] / LATTICE_M), iz = Math.floor(t[2] / LATTICE_M);
    // Traits consume the unrounded root/slope used by placement.
    const xz = forestCover.treeTraits(ix, iz, 5, 0, 0, rules, view);
    const y = terrainHeightAt(data, xz.x, xz.z);
    const gx = (terrainHeightAt(data, xz.x + cell, xz.z) - terrainHeightAt(data, xz.x - cell, xz.z)) / (2 * cell);
    const gz = (terrainHeightAt(data, xz.x, xz.z + cell) - terrainHeightAt(data, xz.x, xz.z - cell)) / (2 * cell);
    const trait = forestCover.treeTraits(ix, iz, 5, y, Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI, rules, view);
    assert.deepEqual([...t.subarray(3, 7)], [...new Float32Array([trait.height, trait.width, trait.species, trait.id])]);
  }
});

test('low-vigor trees form 2–6 m wide krummholz and tour trees obey the 35 m cap', () => {
  assert.equal(typeof forestCover.treeTraits, 'function');
  const tourView = { ...view, tour: {} };
  for (let ix = -200; ix < 200; ix++) {
    const t = forestCover.treeTraits(ix, 17, 315, 2990, 0, { ...rules, treelineM: 3000 }, view);
    assert.ok(t.height >= 2 && t.height <= 6);
    assert.ok(t.width / t.height >= .7 && t.width / t.height <= 1);
    const giant = forestCover.treeTraits(ix, 17, 315, 1000, 0, { ...rules, treelineM: 3000, treeScale: 4 }, tourView);
    assert.equal(giant.height, 35);
    assert.ok(giant.width / giant.height >= .24 && giant.width / giant.height <= .44);
  }
});


test('height responds to the tree’s own broken treeline and slope before the tour cap', () => {
  const ix = -13, iz = 24, seed = 315, r = { ...rules, treelineM: 3000 };
  const { x, z } = forestCover.treeTraits(ix, iz, seed, 0, 0, r, view);
  const edge = 3000 + (forestCover.hash2(Math.floor(x / 90), Math.floor(z / 90), seed + 9) / 4294967296 - .5) * 220;
  const full = forestCover.treeTraits(ix, iz, seed, edge - 450, 0, r, view);
  const tapered = forestCover.treeTraits(ix, iz, seed, edge - 350, 0, r, view);
  assert.equal(tapered.species, full.species);
  assert.ok(Math.abs(tapered.height / full.height - .875) < 1e-12);
  const sloped = forestCover.treeTraits(ix, iz, seed, edge - 450, 35, r, view);
  assert.ok(Math.abs(sloped.height / full.height - .88) < 1e-12);
  const mat = forestCover.treeTraits(ix, iz, seed, edge - 220 + .001, 0, r, view);
  const upright = forestCover.treeTraits(ix, iz, seed, edge - 220 - .001, 0, r, view);
  assert.ok(mat.height >= 2 && mat.height <= 6 && mat.width / mat.height >= .7);
  assert.ok(upright.width / upright.height < .45);
});
