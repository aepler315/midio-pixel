import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bakeTerrain, mirroredPose, VISIBILITY } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { bakeForLibrary, libraryPoses, budgetErrors, fitToBudget, publishView, readFitted, writeFitted } from '../tools/build-scenic-tours.mjs';
import { samplePath, pathPoseAt } from '../src/world/terrain/ShotPath.js';
import { packageTileSet, validatePoses, sampleFootprintPoses, rangeAssetBytes, assetBudgetErrors } from '../tools/lib/scenic-coverage.mjs';

// 4 x 4 tiles of 64 cells at 20 m; the rail at z = -600 looks north, so
// tile rows 2 and 3 (z > 0) are behind it.
function fixture() {
  const width = 257, height = 257, cellSizeM = 20, originM = [-2560, -2560];
  const heightsM = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const x = originM[0] + i * cellSizeM, z = originM[1] + j * cellSizeM;
    heightsM[j * width + i] = 1000 + 150 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53);
  }
  const grid = { width, height, cellSizeM, originM, heightsM, valid: new Uint8Array(width * height).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const view = { id: 'coverage-test', camera: { eyeStartM: [0, 1500, -600], eyeEndM: [0, 1500, -600],
    targetStartM: [0, 1000, -2400], targetEndM: [0, 1000, -2400], fovYDeg: 30 } };
  return { grid, view };
}
const rail = { eyeM: [0, 1500, -600], targetM: [0, 1000, -2400], fovYDeg: 30 };
const behind = { eyeM: [640, 1500, 600], targetM: [640, 1000, 1920], fovYDeg: 20 };
const low = { eyeM: [-1500, 1250, 1800], targetM: [1200, 1000, -1500], fovYDeg: 16 };

async function context(grid, view, options) {
  const baked = await bakeTerrain(grid, view, options);
  return { grid, terrain: { manifest: baked.manifest, data: decodeTerrain(baked.manifest, baked.decoded) } };
}

test('packageTileSet lists the shipped tiles with their strides and errors', async () => {
  const { grid, view } = fixture();
  const ctx = await context(grid, view);
  const set = packageTileSet(ctx.terrain.data);
  assert.equal(set.keys.size, ctx.terrain.manifest.tiles.length);
  for (const t of ctx.terrain.manifest.tiles) {
    const entry = set.tiles.get(`${t.ix},${t.iz}`);
    assert.equal(entry.stride, t.stride);
    assert.deepEqual(entry.errorsM, t.errorsM);
  }
  assert.deepEqual([...packageTileSet(ctx.terrain.manifest).keys], [...set.keys]);
});

test('poses baked into a package validate against it', async () => {
  const { grid, view } = fixture();
  const poses = [rail, behind, low, mirroredPose(low, 1000)];
  const result = validatePoses(await context(grid, view, { poses }), poses);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.ok(result.worst.errorPx > 0 && result.worst.errorPx <= 1.05);
  assert.equal(result.worst.holeFrac, 0);
});

test('a pose looking where the rail package has no tiles finds holes', async () => {
  const { grid, view } = fixture();
  const ctx = await context(grid, view);
  const result = validatePoses(ctx, [rail, behind]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.holes.map((h) => h.poseIndex), [1]);
  assert.ok(result.holes[0].frac > 0.05);
  assert.ok(result.holes[0].tiles.includes('2,3'));
});

test('removing one visible tile is a hole; restoring it passes', async () => {
  const { grid, view } = fixture();
  const ctx = await context(grid, view, { poses: [behind] });
  assert.equal(validatePoses(ctx, [behind]).ok, true);
  const { data } = ctx.terrain;
  const tile = data.byIndex.get('2,3');
  data.byIndex.delete('2,3');
  data.tiles.delete(tile.id);
  const result = validatePoses(ctx, [behind]);
  assert.equal(result.ok, false);
  assert.equal(result.holes[0].poseIndex, 0);
  assert.deepEqual(result.holes[0].tiles, ['2,3']);
  data.byIndex.set('2,3', tile);
  data.tiles.set(tile.id, tile);
  assert.equal(validatePoses(ctx, [behind]).ok, true);
});

test('a tile shipped hidden (keepHidden) is a hole: the runtime does not draw it', async () => {
  const { grid, view } = fixture();
  const ctx = await context(grid, view, { keepHidden: true });
  assert.equal(ctx.terrain.data.byIndex.get('2,3')?.visible, false);
  assert.equal(packageTileSet(ctx.terrain.data).keys.has('2,3'), true);
  assert.equal(packageTileSet(ctx.terrain.data).tiles.get('2,3').visible, false);
  const result = validatePoses(ctx, [behind]);
  assert.equal(result.ok, false);
  assert.ok(result.holes[0].tiles.includes('2,3'));
});

test('a drawn stride too coarse for a pose is a detail violation', async () => {
  const { grid, view } = fixture();
  const ctx = await context(grid, view, { poses: [behind] });
  const tile = ctx.terrain.data.byIndex.get('2,3');
  tile.lod = { ...tile.lod, desktop: 64 };
  const result = validatePoses(ctx, [behind]);
  assert.equal(result.holes.length, 0);
  assert.deepEqual(result.lod.map((e) => [e.poseIndex, e.tile]), [[0, '2,3']]);
  assert.ok(result.lod[0].errorPx > result.lod[0].limitPx);
  // The mobile budget draws its own (unchanged) stride.
  assert.equal(validatePoses(ctx, [behind], { budget: 'mobile' }).ok, true);
  assert.throws(() => validatePoses({ ...ctx, grid: { ...grid, cellSizeM: 30 } }, [behind]), /package grid/);
});

test('footprint poses cover every path end to end at the spacing, deterministically', () => {
  const long = samplePath({ eyes: [[0, 1500, 0], [800, 1500, -600], [1600, 1400, -400]], aims: [[0, 1000, -3000], [800, 1000, -3000], [1600, 1000, -3000]], fovs: 26 });
  const short = samplePath({ eyes: [[0, 1500, 0], [30, 1500, 0]], aims: [[0, 1000, -3000], [30, 1000, -3000]], fovs: 16 });
  const records = [{ id: 'shot-a', path: long }, short];
  const poses = sampleFootprintPoses(records, { spacingM: 150 });
  assert.deepEqual(poses, sampleFootprintPoses(records, { spacingM: 150 }));
  for (const [pathIndex, p] of [[0, long], [1, short]]) {
    const own = poses.filter((q) => q.pathIndex === pathIndex);
    assert.equal(own[0].s, p.s[0]);
    assert.equal(own.at(-1).s, p.s.at(-1));
    assert.deepEqual(own.at(-1).eyeM, pathPoseAt(p, p.s.at(-1)).eyeM);
    for (let i = 1; i < own.length; i++) assert.ok(own[i].s - own[i - 1].s <= 150 + 1e-9 && own[i].s > own[i - 1].s);
  }
  assert.equal(poses.filter((q) => q.pathIndex === 0).length, Math.ceil(long.lengthM / 150) + 1);
  assert.equal(poses[0].pathId, 'shot-a');
  assert.equal(Object.hasOwn(poses.at(-1), 'pathId'), false);
  // Over the cap the spacing grows; every path keeps both ends.
  const thin = sampleFootprintPoses(records, { spacingM: 150, maxPoses: 6 });
  assert.ok(thin.length <= 6);
  assert.deepEqual(thin, sampleFootprintPoses(records, { spacingM: 150, maxPoses: 6 }));
  for (const [pathIndex, p] of [[0, long], [1, short]]) {
    const s = thin.filter((q) => q.pathIndex === pathIndex).map((q) => q.s);
    assert.deepEqual([s[0], s.at(-1)], [p.s[0], p.s.at(-1)]);
  }
  assert.equal(sampleFootprintPoses(records, { maxPoses: 3 }).length, 3);
  // Options that would sample nothing (and so validate clean) throw.
  for (const spacingM of [0, NaN, -10, Infinity]) assert.throws(() => sampleFootprintPoses(records, { spacingM }), /spacingM/);
  for (const maxPoses of [0, NaN, 2.5, -1]) assert.throws(() => sampleFootprintPoses(records, { maxPoses }), /maxPoses/);
  assert.throws(() => sampleFootprintPoses(long), /array/);
});

test('Range asset bytes are totalled under src/assets/range/v2 and held to the budget', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'src/assets/range/v2');
  await fs.mkdir(path.join(dir, 'terrain'), { recursive: true });
  await fs.writeFile(path.join(dir, 'catalog.json'), Buffer.alloc(234));
  await fs.writeFile(path.join(dir, 'terrain', 'a.terrain.bin.gz'), Buffer.alloc(1000));
  await fs.writeFile(path.join(root, 'outside.bin'), Buffer.alloc(5000));
  assert.equal(await rangeAssetBytes(root), 1234);
  assert.deepEqual(await assetBudgetErrors(root, { limit: 2000 }), []);
  assert.match((await assetBudgetErrors(root, { limit: 1000 }))[0], /1234 bytes, over its 1000 byte budget/);
  assert.deepEqual(await assetBudgetErrors(root), []);
});

// An initially dry northern rail cannot see the lake to its south. The
// south-facing tour adds water at 1000 m, whose reflection sees the far
// rising slope outside the direct camera's downward field of view.
async function mirrorExpansion({ water = true, mappedOnly = false, northernLake = false, northernLakeLevelM = 900 } = {}) {
  const width = 513, height = 513, cellSizeM = 20, originM = [-5120, -5120];
  const heightsM = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const x = originM[0] + i * cellSizeM, z = originM[1] + j * cellSizeM;
    heightsM[j * width + i] = northernLake && z < -3000 && z > -3600 && Math.abs(x) < 800 ? northernLakeLevelM : z > 500 && z < 2600 && Math.abs(x) < 2400 ? 1000
      : z > 2600 ? 1000 + (z - 2600) * 1.3 : 1200 + 300 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53);
  }
  const grid = { width, height, cellSizeM, originM, heightsM, valid: new Uint8Array(width * height).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const view = { id: 'black-mountains-catawba', regionId: 'appalachian', water, ...(mappedOnly ? { riverPolicy: { terrainWater: 'mapped-only' } } : {}),
    camera: { eyeStartM: [0, 1700, -2000], eyeEndM: [100, 1700, -2000],
      targetStartM: [0, 1000, -4500], targetEndM: [100, 1000, -4500], fovYDeg: 30 } };
  const baked = await bakeTerrain(grid, view, water ? {} : { water: false });
  const ctx = { grid, view, viewId: view.id, build: { view },
    terrain: { manifest: baked.manifest, data: decodeTerrain(baked.manifest, baked.decoded) } };
  const path = samplePath({ eyes: [[640, 1800, 600], [740, 1800, 600]], aims: [[640, 1000, 2100], [740, 1000, 2100]], fovs: 30 });
  const shot = (id, move, p) => ({ id, move, path: p, subjectId: 'peak', lengthM: p.lengthM, payoffS: p.lengthM / 2, holdS: [0, p.lengthM],
    durationMs: { min: 4000, ideal: 8000, max: 20000 },
    traits: { headingDeg: 90, azimuthDeg: 0, elevationDeg: 5, aglM: 300, distanceM: 5000, lens: 'normal', foreground: 0, side: 'left' }, score: { total: 0.6 } });
  const railPath = samplePath({ eyes: [view.camera.eyeStartM, view.camera.eyeEndM], aims: [view.camera.targetStartM, view.camera.targetEndM], fovs: 30 });
  const library = { subjects: [{ id: 'peak', kind: 'peak', posM: [640, 2000, 4000], radiusM: 300 }],
    shots: [shot('rail', 'rail', railPath), shot('tour', 'traverse', path)], links: [] };
  const config = { region: { hero: [] }, budget: { poseErrorScale: 3, assetBytes: 1e9, desktopTriangles: 1e9, mobileTriangles: 1e9 } };
  return { ctx, library, config };
}
const quiet = { log: () => {} };

test('a real dry-to-wet rebake validates final mirrors including retained rail without changing its reference', async () => {
  const { ctx, library, config } = await mirrorExpansion();
  const original = structuredClone(ctx), reference = ctx.terrain;
  assert.equal(libraryPoses(ctx, library).mirrorLevelM, null);
  const baked = await bakeForLibrary(ctx, library, config, quiet);
  const final = { ...ctx, terrain: { manifest: baked.manifest, data: baked.data } };
  const required = libraryPoses(final, library);
  assert.equal(baked.rebaked, true);
  assert.equal(required.mirrorLevelM, 1000);
  assert.equal(validatePoses(final, required.poses.filter((p) => p.framing !== 'mirror'), { errorPx: 3, extendedErrorPx: 9 }).ok, true);
  assert.equal(validatePoses(final, required.poses, { errorPx: 3, extendedErrorPx: 9 }).worst.holeFrac, 0.253002);
  assert.equal(baked.validation.ok, false, 'new runtime mirror holes cannot pass as covered direct poses');
  assert.equal(baked.mirrorLevelM, 1000);
  assert.deepEqual(baked.poses.slice(0, required.poses.length), required.poses);
  const railMirrors = baked.poses.slice(required.poses.length);
  assert.equal(railMirrors.length, VISIBILITY.stations);
  assert.deepEqual(railMirrors[0], mirroredPose(cameraPoseAt(ctx.build.view, 0), 1000));
  assert.deepEqual(railMirrors.at(-1), mirroredPose(cameraPoseAt(ctx.build.view, 1), 1000));
  for (const budget of ['desktop', 'mobile']) assert.ok(baked.validation.holes.some((h) => h.budget === budget));
  assert.equal(ctx.terrain, reference);
  assert.deepEqual(structuredClone(ctx), original, 'source terrain, DEM and authoring context stay the original baseline');
  assert.equal(baked.budget.sourceDrift, false);
  const originalBytes = Buffer.byteLength(JSON.stringify(ctx.terrain.manifest) + '\n') + ctx.terrain.manifest.payload.byteLength;
  assert.equal(baked.budget.addedBytes, Buffer.byteLength(baked.manifestText) + baked.payload.byteLength - originalBytes);
});

test('rebaked coverage failure cannot pass a generous byte and triangle budget or a restored publication', async (t) => {
  const { ctx, library, config } = await mirrorExpansion();
  const baked = await bakeForLibrary(ctx, library, config, quiet);
  const final = { ...ctx, terrain: { manifest: baked.manifest, data: baked.data } };
  // Obtain the real independent failure even on the regressed implementation.
  baked.validation = validatePoses(final, libraryPoses(final, library).poses, { errorPx: 3, extendedErrorPx: 9 });
  const packed = { manifest: { shots: [], links: [] }, manifestText: '{"shots":[],"links":[]}\n', payload: Buffer.alloc(0) };
  const budget = await budgetErrors(ctx, config, packed, baked);
  assert.ok(budget.errors.some((e) => /cover/i.test(e)), 'coverage is an admission error even when rebaked and far below every cap');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenic-failed-coverage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeFitted(dir, ctx.viewId, { library, bake: baked, packed, budget, iterations: 1, failed: true });
  const restored = await readFitted(ctx.viewId, dir);
  assert.equal(restored.failed, true);
  assert.equal(restored.bake.validation.ok, false);
  await assert.rejects(publishView(ctx.viewId, restored, quiet), /not publishable/);
});

test('fitting explicitly refuses a real rebake with uncovered final mirrors before packing', async () => {
  const built = await mirrorExpansion();
  await assert.rejects(fitToBudget(built, { ...quiet, maxIterations: 1 }), /final.*coverage|coverage.*final/i);
});

test('dry and mapped-only rebakes retain direct coverage and their no-rebake path', async (t) => {
  for (const options of [{ water: false }, { mappedOnly: true }]) await t.test(JSON.stringify(options), async () => {
    const { ctx, library, config } = await mirrorExpansion(options);
    const baked = await bakeForLibrary(ctx, library, config, quiet);
    assert.equal(baked.rebaked, true);
    assert.equal(baked.validation.ok, true);
    assert.equal(baked.poses.length, 2);
    assert.ok(baked.poses.every((p) => p.framing !== 'mirror'));
    const final = { ...ctx, terrain: { manifest: baked.manifest, data: baked.data } };
    const again = await bakeForLibrary(final, library, config, quiet);
    assert.equal(again.rebaked, false);
    assert.equal(again.validation.ok, true);
    assert.deepEqual(again.poses, baked.poses);
  });
});

test('an active mirror whose sampled plane moves uses the final exact level', async () => {
  const { ctx, library, config } = await mirrorExpansion({ northernLake: true });
  assert.equal(libraryPoses(ctx, library).mirrorLevelM, 899.97998046875);
  const baked = await bakeForLibrary(ctx, library, config, quiet);
  assert.equal(baked.rebaked, true);
  assert.equal(baked.mirrorLevelM, 1000);
  assert.equal(baked.validation.ok, false);
  const mirrors = baked.poses.filter((p) => p.framing === 'mirror');
  assert.equal(mirrors.length, VISIBILITY.stations + 1);
  assert.ok(mirrors.every((p) => p.levelM === 1000), 'rounded input mirror levels cannot stand in for the delivered package plane');
});

async function coveredMirrorExpansion() {
  const { ctx, library, config } = await mirrorExpansion();
  const tour = libraryPoses(ctx, library).poses;
  const mirrors = [...tour.filter((_, i) => i % 2 === 0), ...Array.from({ length: VISIBILITY.stations }, (_, k) => cameraPoseAt(ctx.build.view, k / (VISIBILITY.stations - 1)))].map((p) => mirroredPose(p, 1000));
  const terrain = await bakeTerrain(ctx.grid, ctx.build.view, { poses: [...tour, ...mirrors], poseErrorScale: 3, poseFramings: ['core'] });
  return { ctx: { ...ctx, terrain: { manifest: terrain.manifest, data: decodeTerrain(terrain.manifest, terrain.decoded) } }, library, config };
}

test('a stable wet package keeps deterministic coverage with all retained rail mirror stations', async () => {
  const { ctx, library, config } = await coveredMirrorExpansion();
  const first = await bakeForLibrary(ctx, library, config, quiet);
  const second = await bakeForLibrary(ctx, library, config, quiet);
  assert.equal(first.rebaked, false);
  assert.equal(first.validation.ok, true);
  assert.equal(first.mirrorLevelM, 1000);
  assert.equal(first.poses.filter((p) => p.framing === 'mirror').length, VISIBILITY.stations + 1);
  assert.deepEqual(second, first);
});

test('tour mobile coverage uses the baker mobile pixel budget rather than desktop pixels', async () => {
  const { grid, view } = fixture();
  const path = samplePath({ eyes: [low.eyeM, [low.eyeM[0] + 100, ...low.eyeM.slice(1)]],
    aims: [low.targetM, [low.targetM[0] + 100, ...low.targetM.slice(1)]], fovs: 16 });
  const ctx = { ...await context(grid, view), view, viewId: view.id, build: { view } };
  const baked = await bakeForLibrary(ctx, { shots: [{ id: 'low', move: 'traverse', path }], links: [] }, { budget: { poseErrorScale: 3 } }, quiet);
  assert.equal(baked.rebaked, true);
  const final = { ...ctx, terrain: { manifest: baked.manifest, data: baked.data } };
  const mobile = validatePoses(final, baked.poses, { budget: 'mobile', errorPx: 6, extendedErrorPx: 18 });
  assert.equal(mobile.ok, true);
  assert.ok(mobile.worst.errorPx > 3 && mobile.worst.errorPx <= 6, 'the real coarser mobile draw legitimately uses more than three pixels');
  assert.equal(baked.validation.ok, true);
});

test('retained rail mirrors keep ordinary rail detail limits on both budgets', async () => {
  const { ctx, library, config } = await coveredMirrorExpansion();
  // Coarsen only northern land tiles: the southern tour remains covered.
  for (const tile of ctx.terrain.data.tiles.values()) if (tile.iz < 4) tile.lod = { desktop: 64, mobile: 64 };
  const tour = libraryPoses(ctx, library).poses;
  for (const budget of ['desktop', 'mobile']) assert.equal(validatePoses(ctx, tour, { budget, errorPx: budget === 'desktop' ? 3 : 6, extendedErrorPx: budget === 'desktop' ? 9 : 18 }).ok, true);
  const baked = await bakeForLibrary({ ...ctx, coverageOnly: true }, library, config, quiet);
  assert.equal(baked.rebaked, false);
  assert.equal(baked.validation.ok, false);
  for (const budget of ['desktop', 'mobile']) {
    assert.ok(baked.validation.lod.some((e) => e.poseIndex >= tour.length && e.budget === budget && e.limitPx === (budget === 'desktop' ? 1 : 2)));
  }
});

test('a stable active mirror rebake uses ordinary rail viewers and preserves the original baseline', async () => {
  const { ctx, library, config } = await mirrorExpansion({ northernLake: true, northernLakeLevelM: 1000 });
  assert.equal(libraryPoses(ctx, library).mirrorLevelM, 1000);
  const reference = structuredClone(ctx);
  const baked = await bakeForLibrary(ctx, library, config, quiet);
  assert.equal(baked.rebaked, true);
  assert.equal(baked.validation.ok, true);
  assert.equal(baked.mirrorLevelM, 1000);
  assert.deepEqual(baked.manifest.lod.railPoses, { poseCount: VISIBILITY.stations, bakedPoses: VISIBILITY.stations });
  assert.deepEqual(structuredClone(ctx), reference);
  assert.equal(baked.budget.sourceDrift, false);
});
