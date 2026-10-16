// Range v2 Task 3: the terrain package bakes faithfully and loads safely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  bakeTerrain, encodeResiduals, decodeResiduals, validateTerrainManifest, tileStrideError, waterMask, SHORE_MAX_STRIDE, despikeGrid,
} from '../tools/lib/terrain-bake.mjs';
import { decodeTerrain, buildTerrainGeometry, buildSurfaceTexture, terrainHeightAt, tileStrides, terrainFringeBytes } from '../src/world/alpine/TerrainMesh.js';

function makeGrid(width, height, cell, fn, holes = () => false) {
  const heightsM = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const i = r * width + c;
    const x = -((width - 1) * cell) / 2 + c * cell, z = -((height - 1) * cell) / 2 + r * cell;
    if (holes(c, r)) { heightsM[i] = NaN; continue; }
    heightsM[i] = fn(x, z);
    valid[i] = 1;
  }
  return {
    width, height, cellSizeM: cell, originM: [-((width - 1) * cell) / 2, -((height - 1) * cell) / 2],
    heightsM, valid, horizontalCrs: 'synthetic', verticalReference: 'synthetic',
    sourceResolutionM: cell, outputSpacingM: cell, provenance: { provider: 'test' },
  };
}
// Ridge along Z with an eastern spur and a valley: all formula, no data.
const branched = (x, z) => 1200 + 900 * Math.exp(-(((x + 400) / 180) ** 2))
  + 500 * Math.exp(-(((z - 300 + 0.6 * (x + 400)) / 120) ** 2)) * (x > -400 ? Math.exp(-(((x + 400) / 900) ** 2)) : 0)
  - 150 * Math.exp(-(((z + 500) / 90) ** 2)) * (x > 0 ? 1 : 0);
const view = (eye, target, extra = {}) => ({
  id: 'test-view', camera: { eyeStartM: eye, eyeEndM: eye, targetStartM: target, targetEndM: target, fovYDeg: 35 }, ...extra,
});

async function loadBaked(baked) {
  const decoded = zlib.gunzipSync(baked.payload);
  assert.equal(decoded.byteLength, baked.manifest.payload.decodedByteLength);
  return decodeTerrain(baked.manifest, new Uint8Array(decoded));
}

test('despike lowers a seam blob at the grid edge but keeps a real peak', () => {
  // Gentle slope with a broad real summit inland and a 2 x 5 blob of bad
  // samples on the west edge, as a mosaic seam leaves.
  const g = makeGrid(40, 40, 20, (x, z) => 1200 + 0.1 * z + 600 * Math.exp(-((x - 200) ** 2 + z ** 2) / (2 * 120 ** 2)));
  const inlandMax = () => Math.max(...Array.from(g.heightsM).filter((_, i) => i % 40 >= 2));
  const summit = inlandMax();
  for (let r = 18; r < 23; r++) for (let c = 0; c < 2; c++) g.heightsM[r * 40 + c] += 3000;
  assert.ok(despikeGrid(g) >= 10);
  for (let r = 18; r < 23; r++) for (let c = 0; c < 2; c++) assert.ok(g.heightsM[r * 40 + c] < 1400, `blob sample ${c},${r} still ${g.heightsM[r * 40 + c]}`);
  assert.equal(inlandMax(), summit, 'the real summit survives');
});

test('despike keeps a long narrow ridge however steep its sides', () => {
  const g = makeGrid(40, 40, 20, (x, z) => 1200 + 0.1 * z);
  for (let r = 0; r < 40; r++) for (let c = 18; c < 23; c++) g.heightsM[r * 40 + c] += 800;
  const before = Float32Array.from(g.heightsM);
  despikeGrid(g);
  assert.deepEqual(Array.from(g.heightsM), Array.from(before));
});

test('despike lowers a whole five-sample block beside a no-data hole, not just its middle', () => {
  const g = makeGrid(40, 40, 20, (x, z) => 1200 + 0.1 * z);
  for (let r = 15; r < 20; r++) for (let c = 12; c < 14; c++) g.valid[r * 40 + c] = 0;
  const before = Float32Array.from(g.heightsM);
  for (let r = 15; r < 20; r++) for (let c = 15; c < 20; c++) g.heightsM[r * 40 + c] += 2500;
  despikeGrid(g);
  for (let i = 0; i < before.length; i++) {
    if (g.valid[i]) assert.ok(Math.abs(g.heightsM[i] - before[i]) < 15, `sample ${i % 40},${Math.floor(i / 40)} at ${g.heightsM[i]}`);
  }
});

test('despike keeps a compact butte away from any data edge', () => {
  const g = makeGrid(40, 40, 20, (x, z) => 1200 + 0.1 * z);
  for (let r = 15; r < 20; r++) for (let c = 15; c < 20; c++) g.heightsM[r * 40 + c] += 130;
  const before = Float32Array.from(g.heightsM);
  despikeGrid(g);
  assert.deepEqual(Array.from(g.heightsM), Array.from(before));
});

test('residual coding round-trips arbitrary samples', () => {
  const n = 9;
  const q = Uint16Array.from({ length: n * n }, (_, i) => (i * 7919 + (i % 5) * 60000) & 0xffff);
  assert.deepEqual(decodeResiduals(encodeResiduals(q, n), n), q);
});

test('a close camera bakes full resolution and decodes the input samples', async () => {
  const g = makeGrid(129, 129, 10, (x, z) => 1000 + 0.2 * x - 0.1 * z);
  const baked = await bakeTerrain(g, view([0, 1400, 900], [0, 1000, 0]));
  const data = await loadBaked(baked);
  const step = baked.manifest.quantization.stepM;
  for (const [c, r] of [[0, 0], [64, 64], [128, 3], [17, 99]]) {
    const x = g.originM[0] + c * 10, z = g.originM[1] + r * 10;
    const h = terrainHeightAt(data, x, z);
    assert.ok(Math.abs(h - g.heightsM[r * 129 + c]) <= step / 2 + 1e-3, `(${c},${r}) ${h}`);
  }
});

test('terrain hidden behind a nearer ridge from every station is not drawn', async () => {
  // A wall 300 m high right in front of the camera hides the plain behind it.
  const g = makeGrid(257, 257, 10, (x, z) => 1000 + (z > 900 && z < 1000 ? 300 : 0));
  const baked = await bakeTerrain(g, view([0, 1100, 1250], [0, 1000, -1000]));
  assert.equal(baked.manifest.tiles.filter((t) => t.iz === 0).length, 0, 'occluded plain should not ship');
  const kept = await bakeTerrain(g, view([0, 1100, 1250], [0, 1000, -1000]), { keepHidden: true });
  const behind = kept.manifest.tiles.filter((t) => t.iz === 0);
  assert.ok(behind.length && behind.every((t) => !t.visible && t.stride === 64), 'kept hidden tiles are coarsest');
  const wall = baked.manifest.tiles.filter((t) => t.visible);
  assert.ok(wall.length > 0);
});

test('branch and valley extrema survive the accepted detail level', async () => {
  const g = makeGrid(257, 257, 10, branched);
  const eye = [0, 2600, 9000];
  const baked = await bakeTerrain(g, view(eye, [0, 1500, 0]));
  const data = await loadBaked(baked);
  let tileErrors = 0;
  for (const t of baked.manifest.tiles) {
    if (!t.visible) continue;
    // What the tile shows is within its own measured error of the source.
    const err = t.errorsM[t.lod.desktop];
    assert.ok(Number.isFinite(err));
    tileErrors = Math.max(tileErrors, err * 1713 / t.closestM);
  }
  assert.ok(tileErrors <= 1 + 1e-9, `projected error ${tileErrors}px`);
  assert.ok(baked.manifest.lod.achievedErrorPx.desktop <= 1 + 1e-9);
  // The spur crest and valley floor keep their heights within budget.
  const sample = (x, z) => terrainHeightAt(data, x, z);
  const ridge = sample(-400, 0), valley = sample(300, -500);
  assert.ok(Math.abs(ridge - branched(-400, 0)) < 12, `ridge ${ridge} vs ${branched(-400, 0)}`);
  assert.ok(Math.abs(valley - branched(300, -500)) < 12, `valley ${valley} vs ${branched(300, -500)}`);
  assert.ok(ridge - sample(400, 0) > 500, 'ridge flattened');
});

test('a distant camera coarsens tiles and keeps their errors', async () => {
  const g = makeGrid(257, 257, 10, branched);
  const near = await bakeTerrain(g, view([0, 1600, 1400], [0, 1300, 0]));
  const far = await bakeTerrain(g, view([0, 4000, 60000], [0, 1500, 0]));
  // Compare tiles both cameras actually see; hidden tiles are not drawn.
  const nearById = new Map(near.manifest.tiles.map((t) => [t.id, t]));
  const both = far.manifest.tiles.filter((t) => t.visible && nearById.get(t.id)?.visible);
  assert.ok(both.length > 4);
  for (const t of both) assert.ok(t.stride >= nearById.get(t.id).stride, `${t.id} finer from far away`);
  assert.ok(both.some((t) => t.stride > nearById.get(t.id).stride));
  for (const t of far.manifest.tiles) {
    assert.ok(t.lod.mobile >= t.lod.desktop, 'mobile budget never finer than desktop');
    assert.equal(t.stride, t.lod.desktop);
  }
});

test('no-data holes are excluded from triangles and stay NaN', async () => {
  const g = makeGrid(129, 129, 10, (x) => 1000 + 0.3 * x, (c, r) => c >= 40 && c < 60 && r >= 40 && r < 60);
  const baked = await bakeTerrain(g, view([0, 1300, 900], [0, 1000, 0]));
  const data = await loadBaked(baked);
  assert.ok(Number.isNaN(terrainHeightAt(data, g.originM[0] + 50 * 10, g.originM[1] + 50 * 10)));
  const geo = buildTerrainGeometry(data, { includeHidden: true });
  for (const band of Object.values(geo.bands)) {
    for (const i of band.indices) {
      const x = band.positions[3 * i], z = band.positions[3 * i + 2];
      const c = Math.round((x - g.originM[0]) / 10), r = Math.round((z - g.originM[1]) / 10);
      assert.ok(!(c >= 40 && c < 60 && r >= 40 && r < 60), `triangle uses hole vertex ${c},${r}`);
    }
  }
  const tex = buildSurfaceTexture(data);
  assert.equal(tex.data[(50 * 129 + 50) * 4 + 3], 0);
});

test('mixed detail levels share their edges exactly (no cracks)', async () => {
  const g = makeGrid(129, 129, 10, branched);
  const baked = await bakeTerrain(g, view([0, 1600, 1200], [0, 1300, 0]));
  const data = await loadBaked(baked);
  // Force a checkerboard of strides so every edge is mixed.
  const strides = new Map([...data.tiles.values()].map((t) => [t.id, (t.ix + t.iz) % 2 ? Math.max(t.stride, 8) : t.stride]));
  const geo = buildTerrainGeometry(data, { strides, includeHidden: true });
  // Collect vertices on the shared vertical edge x = boundary between tiles 0 and 1.
  const xEdge = g.originM[0] + 64 * 10;
  const pts = [];
  for (const band of Object.values(geo.bands)) {
    for (let i = 0; i < band.positions.length; i += 3) {
      if (Math.abs(band.positions[i] - xEdge) < 1e-6) pts.push([band.positions[i + 2], band.positions[i + 1]]);
    }
  }
  // Coarse edge vertices (every 8 cells) must coincide, and every other
  // vertex on the edge must lie exactly on the segment between them.
  const byZ = new Map();
  for (const [z, y] of pts) {
    const key = Math.round(z * 1000);
    if (byZ.has(key)) assert.ok(Math.abs(byZ.get(key) - y) < 1e-4, `edge vertex disagrees at z=${z}`);
    byZ.set(key, y);
  }
  const coarse = [...byZ.entries()].filter(([k]) => Math.round((k / 1000 - g.originM[1]) / 10) % 8 === 0)
    .sort((a, b) => a[0] - b[0]);
  for (const [k, y] of byZ) {
    const z = k / 1000;
    const i = coarse.findIndex(([ck]) => ck / 1000 > z);
    if (i <= 0) continue;
    const [z0, y0] = [coarse[i - 1][0] / 1000, coarse[i - 1][1]];
    const [z1, y1] = [coarse[i][0] / 1000, coarse[i][1]];
    const expect = y0 + (y1 - y0) * (z - z0) / (z1 - z0);
    assert.ok(Math.abs(expect - y) < 1e-3, `crack at z=${z}: ${y} vs ${expect}`);
  }
  assert.ok(coarse.length >= 10);
});

test('stride error measures real deviation', () => {
  const g = makeGrid(65, 65, 10, (x, z) => 0.01 * x * x + z);
  assert.equal(tileStrideError(g.heightsM, g.valid, 65, 65, 0, 0, 64, 1), 0);
  const e2 = tileStrideError(g.heightsM, g.valid, 65, 65, 0, 0, 64, 2);
  const e8 = tileStrideError(g.heightsM, g.valid, 65, 65, 0, 0, 64, 8);
  assert.ok(e2 > 0 && e8 > e2);
  // Parabola 0.01 x^2 over half a stride of 80 m: 0.01 * 40^2 = 16 m at the midpoint.
  assert.ok(Math.abs(e8 - 16) < 0.5, String(e8));
});

test('hydro-flattened water is found, sloped ground is not', () => {
  const g = makeGrid(80, 80, 10, (x, z) => (Math.hypot(x, z) < 150 ? 500 : 500 + 0.2 * (Math.hypot(x, z) - 150)));
  const mask = waterMask(g.heightsM, g.valid, 80, 80);
  assert.equal(mask[40 * 80 + 40], 1);
  assert.equal(mask[2 * 80 + 2], 0);
});

test('shoreline tiles keep a fine stride and the surface keeps the shore', async () => {
  // A flat lake in a gentle cone: planar enough that height error alone
  // would let every tile, lake edge included, fall to its four corners.
  const lake = (x, z) => { const r = Math.hypot(x, z); return r < 600 ? 500 : 500 + 0.1 * (r - 600); };
  const g = makeGrid(257, 257, 10, lake);
  const baked = await bakeTerrain(g, view([0, 4000, 60000], [0, 520, 0]));
  const wet = waterMask(g.heightsM, g.valid, 257, 257);
  const cells = baked.manifest.tileCells;
  let shore = 0;
  for (const t of baked.manifest.tiles.filter((x) => x.visible)) {
    let w = 0, d = 0;
    for (let r = t.iz * cells; r <= Math.min(256, (t.iz + 1) * cells); r++) {
      for (let c = t.ix * cells; c <= Math.min(256, (t.ix + 1) * cells); c++) (wet[r * 257 + c] ? w++ : d++);
    }
    if (w && d) { shore++; assert.ok(t.stride <= SHORE_MAX_STRIDE, `${t.id} shoreline at stride ${t.stride}`); }
  }
  assert.ok(shore > 0);
  assert.ok(baked.manifest.tiles.some((t) => t.visible && t.stride > SHORE_MAX_STRIDE), 'land still coarsens');
  // The surface texture's water follows the full-resolution mask.
  const data = await loadBaked(baked);
  const surf = buildSurfaceTexture(data);
  let wrong = 0, lakeCells = 0;
  for (let r = 0; r < 257; r++) for (let c = 0; c < 257; c++) {
    const gx = c - Math.round((data.grid.originM[0] - g.originM[0]) / 10), gz = r - Math.round((data.grid.originM[1] - g.originM[1]) / 10);
    if (gx < 0 || gz < 0 || gx >= surf.width || gz >= surf.height) continue;
    const a = surf.data[(gz * surf.width + gx) * 4 + 3];
    if (a === 0) continue; // not covered by a shipped tile
    if (wet[r * 257 + c]) lakeCells++;
    if ((a === 255) !== !!wet[r * 257 + c]) wrong++;
  }
  assert.ok(lakeCells > 1000);
  // Within about one cell of the true shore (the lake's rim is ~377 cells).
  const rimCells = (2 * Math.PI * 600) / 10;
  assert.ok(wrong < 1.5 * rimCells, `${wrong} cells disagree (rim ${Math.round(rimCells)})`);
});

test('manifest validation rejects malformed packages before any GPU work', async () => {
  const g = makeGrid(129, 129, 10, branched);
  const baked = await bakeTerrain(g, view([0, 1600, 1200], [0, 1300, 0]));
  const m = baked.manifest;
  assert.deepEqual(validateTerrainManifest(m), { ok: true, errors: [] });
  const clone = () => JSON.parse(JSON.stringify(m));
  const bad = (mutate, re) => {
    const c = clone(); mutate(c);
    const r = validateTerrainManifest(c);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), re);
  };
  bad((c) => { c.version = 2; }, /unsupported version/);
  bad((c) => { c.tiles[0].stride = 3; }, /stride/);
  bad((c) => { c.tiles[0].samples += 1; }, /samples/);
  bad((c) => { c.tiles[1].id = c.tiles[0].id; }, /duplicate/);
  bad((c) => { c.tiles[0].heights.byteOffset = c.payload.decodedByteLength; }, /heights range/);
  bad((c) => { c.tiles[0].minY = NaN; }, /bounds/);
  bad((c) => { c.quantization.stepM = 0; }, /quantization/);
  bad((c) => { c.tiles[0].lod.desktop = 128; }, /lod/);
  bad((c) => { c.grid.width = 0; }, /grid/);
  bad((c) => { c.grid.height = -4; }, /grid/);
  bad((c) => { c.grid.originM = []; }, /grid/);
  bad((c) => { c.grid.originM = [0, 0, 0]; }, /grid/);
  const truncated = validateTerrainManifest(m, { decoded: m.payload.decodedByteLength - 10 });
  assert.equal(truncated.ok, false);
  assert.throws(() => decodeTerrain(m, new Uint8Array(10)), /manifest rejected/);
  await assert.rejects(bakeTerrain({ ...g, upsampled: true }, view([0, 1600, 1200], [0, 1300, 0])), /upsampled/);
  await assert.rejects(bakeTerrain(g, view([0, 1, 0], [0, 1, 0])), /coincide/);
  await assert.rejects(bakeTerrain({ ...g, valid: new Uint8Array(g.valid.length) }, view([0, 1600, 1200], [0, 1300, 0])), /no valid samples/);
});

test('runtime strides can coarsen for the mobile budget without re-baking', async () => {
  const g = makeGrid(257, 257, 10, branched);
  const baked = await bakeTerrain(g, view([0, 2600, 9000], [0, 1500, 0]));
  const data = await loadBaked(baked);
  const desk = buildTerrainGeometry(data, { budget: 'desktop' });
  const mob = buildTerrainGeometry(data, { budget: 'mobile' });
  assert.ok(mob.stats.triangles <= desk.stats.triangles);
  for (const [id, s] of tileStrides(data, 'mobile')) assert.ok(s >= data.tiles.get(id).stride);
  // The seam-fill size a GPU reservation is taken for matches what is built.
  for (const [budget, geo] of [['desktop', desk], ['mobile', mob]]) {
    const built = Object.values(geo.bands).reduce((sum, b) => sum + b.fringe.byteLength, 0);
    assert.equal(terrainFringeBytes(data, { budget }), built);
  }
});
