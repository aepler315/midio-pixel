import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bakeTerrain, mirroredPose, occlusionBuffer, gridTileBoxes, VISIBILITY } from '../tools/lib/terrain-bake.mjs';
import { mirrorCameraFor, MIRROR_LIFT } from '../src/world/alpine/WaterMirror.js';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { validatePoses } from '../tools/lib/scenic-coverage.mjs';

// 4 x 4 tiles of 64 cells at 20 m: broad hills with fine ripples, so
// strides carry real error. The rail sits at z = -600 looking north (-Z):
// tile rows 2 and 3 (z > 0) are behind it.
function fixture({ height = (x, z) => 1000 + 150 * Math.sin(x / 900) * Math.cos(z / 800) + 0.3 * Math.sin(x / 37 + z / 53) + 0.15 * Math.cos(x / 23 - z / 31) } = {}) {
  const width = 257, depth = 257, cellSizeM = 20, originM = [-2560, -2560];
  const heightsM = new Float32Array(width * depth);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) heightsM[j * width + i] = height(originM[0] + i * cellSizeM, originM[1] + j * cellSizeM);
  const grid = { width, height: depth, cellSizeM, originM, heightsM, valid: new Uint8Array(width * depth).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const view = { id: 'poses-test', camera: { eyeStartM: [0, 1500, -600], eyeEndM: [0, 1500, -600],
    targetStartM: [0, 1000, -2400], targetEndM: [0, 1000, -2400], fovYDeg: 30 } };
  return { grid, view };
}
const byKey = (manifest) => new Map(manifest.tiles.map((t) => [`${t.ix},${t.iz}`, t]));
// Looks south from above the rail eye at tile (2,3), which the rail never sees.
const behind = { eyeM: [640, 1500, 600], targetM: [640, 1000, 1920], fovYDeg: 20 };

test('an empty pose list bakes exactly the rail package', async () => {
  const { grid, view } = fixture();
  const rail = await bakeTerrain(grid, view);
  const empty = await bakeTerrain(grid, view, { poses: [] });
  assert.deepEqual(empty.decoded, rail.decoded);
  assert.equal(JSON.stringify(empty.manifest), JSON.stringify(rail.manifest));
  assert.equal(Object.hasOwn(rail.manifest.lod, 'poses'), false);
});

test('a tile hidden from the rail ships when a pose looks at it, and nothing gets coarser', async () => {
  const { grid, view } = fixture();
  const rail = byKey((await bakeTerrain(grid, view)).manifest);
  assert.equal(rail.has('2,3'), false, 'the rail cannot see behind itself');
  const baked = await bakeTerrain(grid, view, { poses: [behind] });
  const posed = byKey(baked.manifest);
  assert.equal(posed.get('2,3')?.framing, 'core');
  for (const [key, t] of rail) {
    assert.ok(posed.has(key), `rail tile ${key} kept`);
    for (const b of ['desktop', 'mobile']) assert.ok(posed.get(key).lod[b] <= t.lod[b], `${key} ${b}`);
  }
  assert.deepEqual(baked.manifest.lod.poses.sources, { rail: 21, core: 1 });
  assert.equal(baked.manifest.lod.poses.poseCount, 1);
  assert.equal(baked.manifest.lod.poses.minFovYDeg, 20);
  assert.equal(baked.manifest.lod.fovYDeg, 30);
});

test('a close narrow pose makes a distant rail tile finer', async () => {
  const { grid, view } = fixture();
  const rail = (await bakeTerrain(grid, view)).manifest;
  const far = rail.tiles.filter((t) => t.framing === 'core' && t.lod.desktop >= 2).sort((a, b) => b.closestM - a.closestM)[0];
  assert.ok(far, 'fixture has a coarse core tile');
  const cx = -2560 + (far.ix + 0.5) * 1280, cz = -2560 + (far.iz + 0.5) * 1280;
  const pose = { eyeM: [cx, far.maxY + 250, cz + 900], targetM: [cx, (far.minY + far.maxY) / 2, cz], fovYDeg: 16 };
  const tile = byKey((await bakeTerrain(grid, view, { poses: [pose] })).manifest).get(`${far.ix},${far.iz}`);
  assert.ok(tile.lod.desktop < far.lod.desktop, `stride ${far.lod.desktop} -> ${tile.lod.desktop}`);
  assert.ok(tile.closestM < far.closestM);
});

test('poses alone bake a view without a rail; a broken rail still fails', async () => {
  const { grid, view } = fixture();
  const baked = await bakeTerrain(grid, { id: 'no-rail' }, { poses: [behind] });
  const tiles = byKey(baked.manifest);
  assert.ok(tiles.has('2,3'));
  assert.ok(!tiles.has('1,0') && !tiles.has('2,0'), 'only what the pose sees ships');
  assert.equal(baked.manifest.lod.fovYDeg, null);
  assert.deepEqual(baked.manifest.lod.poses.sources, { core: 1 });
  await assert.rejects(bakeTerrain(grid, { ...view, camera: { ...view.camera, fovYDeg: 0 } }, { poses: [behind] }), /fovYDeg/);
  await assert.rejects(bakeTerrain(grid, view, { poses: [{ ...behind, fovYDeg: 1 }] }), /pose 0: fovYDeg/);
  await assert.rejects(bakeTerrain(grid, view, { poses: [{ ...behind, framing: 'mirror' }] }), /levelM/);
  await assert.rejects(bakeTerrain(grid, view, { poses: [{ ...behind, framing: 'side' }] }), /framing/);
});

test('an extended-only pose ships its tiles at the extended budget only', async () => {
  const { grid } = fixture();
  const core = byKey((await bakeTerrain(grid, { id: 'x' }, { poses: [behind] })).manifest).get('2,3');
  const wide = byKey((await bakeTerrain(grid, { id: 'x' }, { poses: [{ ...behind, framing: 'extended' }] })).manifest).get('2,3');
  assert.equal(wide.framing, 'extended');
  assert.ok(wide.lod.desktop >= core.lod.desktop);
});

test('an extended pose close to a core rail tile refines it to the extended budget', async () => {
  const { grid, view } = fixture();
  const rail = (await bakeTerrain(grid, view)).manifest;
  const h = (x, z) => grid.heightsM[Math.round((z + 2560) / 20) * 257 + Math.round((x + 2560) / 20)];
  // From 150 m south of each core rail tile, a 16-degree lens looking north
  // into it: closer and narrower than any rail station.
  const poses = rail.tiles.filter((t) => t.framing === 'core').map((t) => {
    const cx = -2560 + (t.ix + 0.5) * 1280, sz = Math.min(2540, -2560 + (t.iz + 1) * 1280 + 150);
    return { eyeM: [cx, h(cx, sz) + 60, sz], targetM: [cx, h(cx, sz - 750) - 30, sz - 750], fovYDeg: 16, framing: 'extended' };
  });
  assert.ok(poses.length >= 3);
  const baked = await bakeTerrain(grid, view, { poses });
  const result = validatePoses({ grid, terrain: { manifest: baked.manifest, data: decodeTerrain(baked.manifest, baked.decoded) } }, poses);
  assert.equal(result.ok, true, JSON.stringify(result.lod.slice(0, 4)));
  assert.ok(result.worst.extendedErrorPx <= 3);
  // The rail package fails the same poses, and no tile changes framing.
  const before = validatePoses({ grid, terrain: { manifest: rail, data: decodeTerrain(rail, (await bakeTerrain(grid, view)).decoded) } }, poses);
  assert.ok(before.lod.length > 0);
  const posed = byKey(baked.manifest);
  for (const t of rail.tiles) assert.equal(posed.get(`${t.ix},${t.iz}`).framing, t.framing);
});

test('near-identical poses merge before rasterizing; poseStride thins them', async () => {
  const { grid } = fixture();
  const jittered = Array.from({ length: 400 }, (_, i) => ({
    eyeM: [behind.eyeM[0] + (i % 7) - 3, behind.eyeM[1] + (i % 5) - 2, behind.eyeM[2] + (i % 3)],
    targetM: [behind.targetM[0] + ((i * 13) % 21) - 10, behind.targetM[1], behind.targetM[2]], fovYDeg: 20 + (i % 3) * 0.5,
  }));
  const merged = await bakeTerrain(grid, { id: 'x' }, { poses: jittered });
  assert.equal(merged.manifest.lod.poses.poseCount, 400);
  assert.equal(merged.manifest.lod.poses.bakedPoses, 1);
  const single = byKey((await bakeTerrain(grid, { id: 'x' }, { poses: [behind] })).manifest);
  for (const [key, t] of single) assert.ok(byKey(merged.manifest).get(key)?.lod.desktop <= t.lod.desktop, key);
  // A 16-degree lens never merges into a 36-degree one.
  const lenses = await bakeTerrain(grid, { id: 'x' }, { poses: [behind, { ...behind, fovYDeg: 36 }, { ...behind, fovYDeg: 16 }] });
  assert.equal(lenses.manifest.lod.poses.bakedPoses, 3);
  const strided = await bakeTerrain(grid, { id: 'x' }, { poses: jittered.slice(0, 10), poseStride: 5, poseDedupe: false });
  assert.equal(strided.manifest.lod.poses.bakedPoses, 3, 'poses 0, 5 and the last');
});

test('mirroredPose is the camera WaterMirror renders', () => {
  const pose = { eyeM: [100, 1500, 200], targetM: [400, 900, 1200], fovYDeg: 28 };
  const m = mirroredPose(pose, 1000);
  assert.deepEqual(m.eyeM, [100, 1000 - MIRROR_LIFT * 500, 200]);
  // The look direction is reflected, not lifted: (300, -600, 1000) -> (300, 600, 1000).
  assert.deepEqual(m.targetM.map((v, k) => v - m.eyeM[k]), [300, 600, 1000]);
  assert.equal(m.fovYDeg, 28);
  assert.equal(m.framing, 'mirror');
  assert.equal(m.levelM, 1000);
  // Without lift it is the plain reflection of eye and target.
  assert.deepEqual(mirroredPose(pose, 1000, 1), { eyeM: [100, 500, 200], targetM: [400, 1100, 1200], fovYDeg: 28, framing: 'mirror', levelM: 1000 });
  // Against the renderer itself.
  const camera = new THREE.PerspectiveCamera(28, 16 / 9, 20, 1e6);
  camera.position.set(...pose.eyeM);
  camera.lookAt(...pose.targetM);
  const out = mirrorCameraFor(THREE, camera, 1000, new THREE.PerspectiveCamera(), MIRROR_LIFT);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(out.quaternion);
  const dir = new THREE.Vector3(...m.targetM).sub(new THREE.Vector3(...m.eyeM)).normalize();
  assert.ok(out.position.distanceTo(new THREE.Vector3(...m.eyeM)) < 1e-6);
  assert.ok(fwd.angleTo(dir) < 1e-6);
});

test('a mirror pose sees past the water plane its eye is under', async () => {
  // A flat lake (1000 m) south of z = -1000, a slope rising north of it.
  const { grid } = fixture({ height: (x, z) => (z > -1000 ? 1000 : 1000 + 0.5 * (-1000 - z) + 2 * Math.sin(x / 41)) });
  const real = { eyeM: [0, 1300, 1500], targetM: [0, 1100, -2000], fovYDeg: 30 };
  const mirror = mirroredPose(real, 1000);
  const plain = { eyeM: mirror.eyeM, targetM: mirror.targetM, fovYDeg: mirror.fovYDeg };
  const seen = byKey((await bakeTerrain(grid, { id: 'lake' }, { poses: [mirror] })).manifest);
  const unclipped = byKey((await bakeTerrain(grid, { id: 'lake' }, { poses: [plain] })).manifest);
  assert.ok(seen.has('1,0') && seen.has('2,0'), 'the reflected slope ships');
  assert.ok(!unclipped.has('1,0') && !unclipped.has('2,0'), 'from below, the lake surface hides the slope');
  const baked = await bakeTerrain(grid, { id: 'lake' }, { poses: [mirror] });
  assert.deepEqual(baked.manifest.lod.poses.sources, { mirror: 1 });
});

test('tile culling and reused scratch leave the occlusion raster unchanged', () => {
  const { grid } = fixture();
  const tiles = gridTileBoxes(grid);
  const scratch = {};
  for (const pose of [behind, { eyeM: [0, 1500, -600], targetM: [0, 1000, -2400], fovYDeg: 30 }, { eyeM: [-2000, 1400, 2000], targetM: [2000, 1000, -2000], fovYDeg: 16 }]) {
    for (const name of ['core', 'extended']) {
      const plain = occlusionBuffer(grid, pose, VISIBILITY[name], VISIBILITY.occlusion);
      const culled = occlusionBuffer(grid, pose, VISIBILITY[name], VISIBILITY.occlusion, { tiles, scratch, ids: true });
      assert.deepEqual(culled.buf, plain.buf);
      for (let o = 0; o < culled.buf.length; o++) assert.equal(culled.tile[o] >= 0, culled.buf[o] > 0);
    }
  }
});

test('extra rail reflection poses retain ordinary detail despite coarse core-only tour options', async () => {
  const { grid } = fixture({ height: (x, z) => (z > -1000 ? 1000 : 1000 + 0.5 * (-1000 - z) + 5 * Math.sin(x / 41)) });
  const mirror = mirroredPose({ eyeM: [0, 1300, 1500], targetM: [0, 1100, -2000], fovYDeg: 30 }, 1000);
  const options = { poses: [mirror], poseErrorScale: 4, poseFramings: ['core'] };
  const coarse = await bakeTerrain(grid, { id: 'lake' }, options);
  const strict = await bakeTerrain(grid, { id: 'lake' }, { ...options, railPoses: [mirror] });
  const ctx = (baked) => ({ grid, terrain: { manifest: baked.manifest, data: decodeTerrain(baked.manifest, baked.decoded) } });
  for (const budget of ['desktop', 'mobile']) {
    assert.equal(validatePoses(ctx(coarse), [mirror], { budget }).ok, false, 'the tour budget alone does not meet the ordinary rail limit');
    const checked = validatePoses(ctx(strict), [mirror], { budget });
    assert.equal(checked.ok, true, JSON.stringify(checked));
  }
  const reference = await bakeTerrain(grid, { id: 'lake' }, { poses: [mirror] });
  assert.deepEqual(strict.manifest.tiles, reference.manifest.tiles, 'ordinary rail framings match the unscaled reference bake, including extended support');
  assert.deepEqual(strict.manifest.lod.railPoses, { poseCount: 1, bakedPoses: 1 });
  assert.ok(strict.manifest.tiles.some((t) => t.iz === 0), 'mirror clipping retains the reflected slope beyond the water');
});

test('empty extra rail poses leave rail-only and tour package bytes exactly unchanged', async () => {
  const { grid, view } = fixture();
  for (const options of [{}, { poses: [behind], poseErrorScale: 4, poseFramings: ['core'] }]) {
    const legacy = await bakeTerrain(grid, view, options);
    const empty = await bakeTerrain(grid, view, { ...options, railPoses: [] });
    assert.deepEqual(empty.manifest, legacy.manifest);
    assert.deepEqual(empty.decoded, legacy.decoded);
    assert.deepEqual(empty.payload, legacy.payload);
    assert.equal(Object.hasOwn(empty.manifest.lod, 'railPoses'), false);
  }
});

test('rail-only mirror viewers clip lake occlusion with absent or empty tour poses', async () => {
  const { grid } = fixture({ height: (x, z) => (z > -1000 ? 1000 : 1000 + 0.5 * (-1000 - z) + 5 * Math.sin(x / 41)) });
  const mirror = mirroredPose({ eyeM: [0, 1300, 1500], targetM: [0, 1100, -2000], fovYDeg: 30 }, 1000);
  const reference = await bakeTerrain(grid, { id: 'lake' }, { poses: [mirror] });
  for (const options of [{ railPoses: [mirror] }, { poses: [], railPoses: [mirror] }]) {
    const baked = await bakeTerrain(grid, { id: 'lake' }, options);
    const ctx = { grid, terrain: { manifest: baked.manifest, data: decodeTerrain(baked.manifest, baked.decoded) } };
    for (const budget of ['desktop', 'mobile']) {
      const result = validatePoses(ctx, [mirror], { budget });
      assert.equal(result.ok, true, JSON.stringify({ options, budget, result }));
      assert.equal(result.worst.holeFrac, 0);
    }
    assert.deepEqual(baked.manifest.tiles, reference.manifest.tiles, 'independent rail mirrors retain the unscaled clipped reference coverage and detail');
  }
});
