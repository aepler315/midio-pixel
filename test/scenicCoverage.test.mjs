import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bakeTerrain, mirroredPose } from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
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
