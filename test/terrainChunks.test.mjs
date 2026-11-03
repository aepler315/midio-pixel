import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../src/vendor/range/three-range.module.js';
import {
  chunkTable, subsetChunkTable, setChunks, setTerrainMaterial, terrainMaterial, frustumPlanes, visibleGroups,
  attachTerrainCulling, CHUNK_MAX_RUNS, CHUNK_MERGE_INDICES,
} from '../src/world/alpine/TerrainChunks.js';
import { buildTerrainGeometry, decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { createBandGeometries } from '../src/world/alpine/TerrainGL.js';
import { wetTexelMask, waterIndexSubset } from '../src/world/alpine/WaterSubset.js';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import zlib from 'node:zlib';

// Seeded so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function camera(r, { offset = false } = {}) {
  const cam = new THREE.PerspectiveCamera(20 + r() * 60, 0.5 + r() * 2, 5 + r() * 50, 20000 + r() * 80000);
  cam.position.set((r() - .5) * 4000, 1500 + r() * 1500, (r() - .5) * 4000);
  cam.lookAt(cam.position.x + (r() - .5) * 8000, 800 + r() * 1200, cam.position.z + (r() - .5) * 8000);
  if (offset) cam.setViewOffset(1600, 900, r() * 400, r() * 300, 800 + r() * 800, 450 + r() * 450);
  cam.updateMatrixWorld();
  return cam;
}

function scissorTarget(r, w = 704, h = 424) {
  const x = Math.floor(r() * w * .7), y = Math.floor(r() * h * .7);
  const sw = Math.max(1, Math.floor(r() * (w - x))), sh = Math.max(1, Math.floor(r() * (h - y)));
  return { scissorTest: true, scissor: new THREE.Vector4(x, y, sw, sh), viewport: new THREE.Vector4(0, 0, w, h), width: w, height: h };
}

// Whether world point p rasterizes inside `target`'s drawn rectangle (the
// scissor when on) for `cam`: in front, inside clip depth, and its NDC
// inside the rectangle.
function drawnAt(cam, target, p) {
  const v = new THREE.Vector4(p[0], p[1], p[2], 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
  if (!(v.w > 0) || Math.abs(v.z) > v.w) return false;
  const nx = v.x / v.w, ny = v.y / v.w;
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return false;
  if (!target?.scissorTest) return true;
  const px = (nx + 1) / 2 * target.viewport.z + target.viewport.x, py = (ny + 1) / 2 * target.viewport.w + target.viewport.y;
  const s = target.scissor;
  return px >= s.x && px <= s.x + s.z && py >= s.y && py <= s.y + s.w;
}

function singleChunk(box) {
  return chunkTable(Uint32Array.of(0), Uint32Array.of(3), Float64Array.from(box));
}

test('a culled tile has no point inside what the camera draws, with its lift and scissor', () => {
  let culled = 0, kept = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    const cam = camera(r, { offset: seed % 3 === 0 });
    const target = seed % 2 ? scissorTarget(r) : null;
    const planes = frustumPlanes(cam, target);
    assert.ok(planes, `seed ${seed}`);
    for (let b = 0; b < 200; b++) {
      const cx = cam.position.x + (r() - .5) * 30000, cz = cam.position.z + (r() - .5) * 30000;
      const sx = 50 + r() * 1300, sz = 50 + r() * 1300, y0 = 500 + r() * 2000, y1 = y0 + r() * 1500;
      const box = [cx - sx, y0, cz - sz, cx + sx, y1, cz + sz];
      const lift = { lo: -r() * 200, hi: r() * 300 };
      const groups = visibleGroups(singleChunk(box), planes, lift);
      if (groups.length) { kept++; continue; }
      culled++;
      // Corners and interior points of the lifted box: none may be drawn.
      for (let n = 0; n < 64; n++) {
        const t = n < 8 ? [n & 1, n & 2 ? 1 : 0, n & 4 ? 1 : 0] : [r(), r(), r()];
        const p = [box[0] + t[0] * (box[3] - box[0]), box[1] + lift.lo + t[1] * (box[4] + lift.hi - box[1] - lift.lo), box[2] + t[2] * (box[5] - box[2])];
        assert.ok(!drawnAt(cam, target, p), `seed ${seed} box ${b}: culled box has a drawn point ${p}`);
      }
    }
  }
  // Neither side is trivial.
  assert.ok(culled > 2000 && kept > 500, `culled ${culled}, kept ${kept}`);
});

test('a tile the camera sees is never culled', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), cam = camera(r, { offset: seed % 2 === 0 }), target = seed % 3 ? null : scissorTarget(r);
    const planes = frustumPlanes(cam, target);
    for (let n = 0; n < 200; n++) {
      // A point drawn at a random pixel of the rectangle, at a random depth.
      const s = target?.scissor, vp = target?.viewport;
      const nx = s ? ((s.x + r() * s.z) - vp.x) / vp.z * 2 - 1 : r() * 2 - 1;
      const ny = s ? ((s.y + r() * s.w) - vp.y) / vp.w * 2 - 1 : r() * 2 - 1;
      const p = new THREE.Vector3(nx, ny, r() * 1.98 - .99).unproject(cam);
      const box = [p.x - r() * 5, p.y - r() * 5, p.z - r() * 5, p.x + r() * 5, p.y + r() * 5, p.z + r() * 5];
      assert.equal(visibleGroups(singleChunk(box), planes, { lo: 0, hi: 0 }).length, 1, `seed ${seed} point ${n}`);
      // A box below the view that only its lift raises into it is kept too.
      const below = [box[0], box[1] - 400, box[2], box[3], box[4] - 400, box[5]];
      assert.equal(visibleGroups(singleChunk(below), planes, { lo: -10, hi: 410 }).length, 1);
    }
  }
});

test('draw groups cover every visible tile in index order, merging only culled gaps', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed), cam = camera(r);
    const planes = frustumPlanes(cam, null);
    const n = 40 + Math.floor(r() * 400), start = new Uint32Array(n), count = new Uint32Array(n), box = new Float64Array(6 * n);
    let o = 0;
    for (let i = 0; i < n; i++) {
      start[i] = o; count[i] = r() < .05 ? 0 : 3 * Math.floor(1 + r() * 4000); o += count[i];
      const cx = cam.position.x + (r() - .5) * 20000, cz = cam.position.z + (r() - .5) * 20000;
      box.set([cx - 640, 900, cz - 640, cx + 640, 2400, cz + 640], i * 6);
    }
    const table = chunkTable(start, count, box);
    const all = visibleGroups(table, planes, { lo: 0, hi: 0 }, { mergeIndices: 0, maxRuns: Infinity });
    const groups = visibleGroups(table, planes, { lo: 0, hi: 0 });
    assert.ok(groups.length <= CHUNK_MAX_RUNS);
    for (let i = 1; i < groups.length; i++) {
      assert.ok(groups[i].start >= groups[i - 1].start + groups[i - 1].count + CHUNK_MERGE_INDICES || groups.length === CHUNK_MAX_RUNS,
        'adjacent groups are a merge gap apart unless the cap merged them');
      assert.ok(groups[i].start > groups[i - 1].start + groups[i - 1].count, 'ascending, disjoint');
    }
    // Every visible tile is inside a group; group edges are tile edges.
    const edges = new Set([...start, o]);
    for (const g of groups) { assert.ok(edges.has(g.start) && edges.has(g.start + g.count)); assert.equal(g.materialIndex, 0); }
    for (const v of all) for (let k = v.start; k < v.start + v.count; k += 997) {
      assert.ok(groups.some(g => k >= g.start && k < g.start + g.count), `seed ${seed}: visible index ${k} dropped`);
    }
    // Unmerged, the groups are exactly the visible tiles.
    let expected = 0;
    for (let i = 0; i < n; i++) if (count[i] && visibleGroups(singleChunk(box.subarray(i * 6, i * 6 + 6)), planes, { lo: 0, hi: 0 }).length) expected += count[i];
    assert.equal(all.reduce((s, g) => s + g.count, 0), expected);
  }
  // Nothing visible: no group, so nothing draws.
  const cam = camera(rng(5)), far = chunkTable(Uint32Array.of(0, 3), Uint32Array.of(3, 3), Float64Array.of(1e7, 0, 1e7, 1e7 + 1, 1, 1e7 + 1, -1e7, 0, -1e7, -1e7 + 1, 1, -1e7 + 1));
  assert.deepEqual(visibleGroups(far, frustumPlanes(cam, null), { lo: 0, hi: 0 }), []);
  // Unbounded lift culls nothing on the vertical planes' account.
  assert.equal(visibleGroups(singleChunk([cam.position.x - 10, -1e6, cam.position.z - 3000, cam.position.x + 10, -1e6 + 1, cam.position.z - 2990]),
    frustumPlanes(cam, null), { lo: NaN, hi: NaN }).length, 1);
});

test('chunk tables must tile the index in order', () => {
  assert.throws(() => chunkTable(Uint32Array.of(0, 4), Uint32Array.of(3, 3), new Float64Array(12)), /contiguous/);
  assert.throws(() => chunkTable(Uint32Array.of(0), Uint32Array.of(3, 3), new Float64Array(6)), /disagree/);
  const t = chunkTable(Uint32Array.of(0, 3, 9), Uint32Array.of(3, 6, 3), new Float64Array(18));
  assert.equal(t.indices, 12);
  const sub = subsetChunkTable(t, Uint32Array.of(0, 3, 3));
  assert.deepEqual([...sub.start], [0, 0, 3]); assert.deepEqual([...sub.count], [0, 3, 3]); assert.equal(sub.box, t.box);
});

function bandScene() {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10, 5000, 0, 0, 5010, 0, 0, 5000, 0, 10]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.of(0, 1, 2, 3, 4, 5), 1));
  setChunks(geometry, chunkTable(Uint32Array.of(0, 3), Uint32Array.of(3, 3), Float64Array.of(0, 0, 0, 10, 0, 10, 5000, 0, 0, 5010, 0, 10)));
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, [material]);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  // Looking at the first tile only.
  const cam = new THREE.PerspectiveCamera(30, 1, 1, 10000);
  cam.position.set(5, 200, 300); cam.lookAt(5, 0, 5); cam.updateMatrixWorld();
  return { scene, mesh, geometry, material, cam };
}

test('a band scene draws its visible tiles for each render and its whole index after', () => {
  const { scene, mesh, geometry, cam } = bandScene();
  const stats = { kept: 0, total: 0, draws: 0 };
  let lift = { lo: 0, hi: 0 };
  attachTerrainCulling(scene, () => lift, stats);
  assert.deepEqual(geometry.groups.map(g => [g.start, g.count]), [[0, Infinity]]);
  scene.onBeforeRender(null, scene, cam, null);
  assert.deepEqual(geometry.groups.map(g => [g.start, g.count]), [[0, 3]]);
  assert.deepEqual(stats, { kept: 3, total: 6, draws: 1 });
  scene.onAfterRender(null, scene, cam);
  assert.deepEqual(geometry.groups.map(g => [g.start, g.count]), [[0, Infinity]]);
  // A lift that could raise the far tile into view keeps it.
  lift = { lo: 0, hi: 1e6 };
  cam.position.set(5000, 200, 300); cam.lookAt(5005, 4000, 5); cam.updateMatrixWorld();
  scene.onBeforeRender(null, scene, cam, null);
  assert.ok(geometry.groups.some(g => g.start <= 3 && g.start + g.count >= 6), 'lifted tile kept');
  scene.onAfterRender(null, scene, cam);
  // Left alone: a single-material mesh, a hidden mesh, a mesh on a layer the
  // camera does not draw, or one that is moved (its boxes are mesh space).
  lift = { lo: 0, hi: 0 };
  cam.position.set(5, 200, 300); cam.lookAt(5, 0, 5); cam.updateMatrixWorld();
  for (const change of [m => { m.material = m.material[0]; }, m => { m.visible = false; }, m => m.layers.set(5), m => { m.position.x = 1; m.updateMatrixWorld(); }]) {
    const s = bandScene();
    attachTerrainCulling(s.scene, () => lift);
    change(s.mesh);
    s.scene.onBeforeRender(null, s.scene, cam, null);
    assert.deepEqual(s.geometry.groups.map(g => [g.start, g.count]), [[0, Infinity]]);
  }
  // A swapped-in geometry without chunks draws whole.
  const plain = new THREE.BufferGeometry();
  setChunks(plain, null);
  mesh.geometry = plain;
  scene.onBeforeRender(null, scene, cam, null);
  assert.deepEqual(plain.groups.map(g => [g.start, g.count]), [[0, Infinity]]);
});

test('terrain materials swap in their array form', () => {
  const { mesh, material } = bandScene();
  const other = new THREE.MeshBasicMaterial();
  setTerrainMaterial(mesh, other);
  assert.ok(Array.isArray(mesh.material)); assert.equal(terrainMaterial(mesh), other);
  const single = new THREE.Mesh(new THREE.BufferGeometry(), material);
  setTerrainMaterial(single, other);
  assert.equal(single.material, other);
});

// A baked package with mixed strides, all three bands and seam fill.
function makeGrid(width, height, cell, fn) {
  const heightsM = new Float32Array(width * height), valid = new Uint8Array(width * height).fill(1);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    heightsM[r * width + c] = fn(-((width - 1) * cell) / 2 + c * cell, -((height - 1) * cell) / 2 + r * cell);
  }
  return { width, height, cellSizeM: cell, originM: [-((width - 1) * cell) / 2, -((height - 1) * cell) / 2],
    heightsM, valid, horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: cell, outputSpacingM: cell, provenance: { provider: 'test' } };
}
const branched = (x, z) => 1200 + 900 * Math.exp(-(((x + 400) / 180) ** 2)) + 300 * Math.sin(x / 700) * Math.cos(z / 900);
let baked = null;
async function terrain() {
  baked ||= await bakeTerrain(makeGrid(257, 257, 10, branched), { id: 'chunks', bands: { nearM: 1300, midM: 2200 },
    camera: { eyeStartM: [0, 2400, 1900], eyeEndM: [0, 2400, 1900], targetStartM: [0, 1300, -600], targetEndM: [0, 1300, -600], fovYDeg: 50 } });
  return decodeTerrain(baked.manifest, new Uint8Array(zlib.gunzipSync(baked.payload)));
}

test('each band and seam fill is chunked by tile: contiguous ranges holding every triangle, boxes holding their vertices', async () => {
  const data = await terrain();
  const built = buildTerrainGeometry(data, { budget: 'desktop' });
  let bands = 0, fringes = 0;
  for (const b of Object.values(built.bands)) {
    for (const [index, c] of [[b.indices, b.chunks], [b.fringe, b.fringeChunks]]) {
      if (!index.length) { assert.equal(c.start.length, 0); continue; }
      const table = chunkTable(c.start, c.count, c.box);
      assert.equal(table.start[0], 0); assert.equal(table.indices, index.length);
      for (let i = 0; i < table.length; i++) {
        const box = table.box.subarray(i * 6, i * 6 + 6);
        // One tile: no wider than a tile, and holding each referenced vertex.
        assert.ok(box[3] - box[0] <= data.cells * data.grid.cellSizeM + 1e-6 && box[5] - box[2] <= data.cells * data.grid.cellSizeM + 1e-6);
        for (let k = table.start[i]; k < table.start[i] + table.count[i]; k++) {
          const v = index[k] * 3;
          for (let a = 0; a < 3; a++) assert.ok(b.positions[v + a] >= box[a] && b.positions[v + a] <= box[a + 3], `vertex ${index[k]} axis ${a} outside its tile box`);
        }
      }
      if (index === b.indices) bands++; else fringes++;
    }
  }
  assert.ok(bands >= 2 && fringes >= 1, `bands ${bands}, fringes ${fringes}`);
  // The GL geometries carry those tables and the whole-index group.
  const geos = createBandGeometries(THREE, data, { built });
  for (const g of [...Object.values(geos.geometries), ...Object.values(geos.fringes)]) {
    if (!g.index.count) continue;
    assert.equal(g.userData.terrainChunks.indices, g.index.count);
    assert.deepEqual(g.groups.map(x => [x.start, x.count, x.materialIndex]), [[0, Infinity, 0]]);
    g.dispose();
  }
  // A build without chunk arrays (or with ones that do not tile the index)
  // draws whole.
  const bare = { bands: Object.fromEntries(Object.entries(built.bands).map(([k, b]) => [k, { ...b, chunks: k === 'far' ? null : { ...b.chunks, count: b.chunks.count.map(() => 3) } }])), stats: built.stats };
  for (const g of Object.values(createBandGeometries(THREE, data, { built: bare }).geometries)) {
    if (g.index.count > 3 * g.userData.terrainChunks?.length) assert.equal(g.userData.terrainChunks, null);
    assert.deepEqual(g.groups.map(x => [x.start, x.count]), [[0, Infinity]]);
  }
});

test('a water subset counts its kept indices per tile, so its own table culls by the same boxes', async () => {
  const data = await terrain();
  const built = buildTerrainGeometry(data, { budget: 'desktop' });
  const g = data.grid, r = rng(3);
  const rgba = new Uint8Array(g.width * g.height * 4);
  for (let i = 0; i < g.width * g.height; i++) rgba[i * 4 + 3] = r() < .01 ? 255 : 10;
  const mask = wetTexelMask(rgba, g.width, g.height);
  for (const b of Object.values(built.bands)) {
    if (!b.indices.length) continue;
    const table = chunkTable(b.chunks.start, b.chunks.count, b.chunks.box);
    const kept = new Uint32Array(table.length);
    const keep = waterIndexSubset(b.positions, b.indices, g, mask, { maxShare: 1, chunks: { start: table.start, count: table.count, kept } });
    assert.deepEqual(keep, waterIndexSubset(b.positions, b.indices, g, mask, { maxShare: 1 }), 'counting changes nothing');
    const sub = subsetChunkTable(table, kept);
    assert.equal(sub.indices, keep.length);
    // Brute force: subset chunk i is exactly the kept triangles of tile i.
    let k = 0;
    for (let i = 0; i < table.length; i++) {
      for (let t = table.start[i]; t < table.start[i] + table.count[i] && k < keep.length; t += 3) {
        if (b.indices[t] === keep[k] && b.indices[t + 1] === keep[k + 1] && b.indices[t + 2] === keep[k + 2]) {
          assert.ok(k >= sub.start[i] && k < sub.start[i] + sub.count[i], `kept triangle at ${k} is not in tile ${i}'s range`);
          k += 3;
        }
      }
    }
    assert.equal(k, keep.length);
  }
});
