// Compiled terrain experiment (docs/compiled-terrain-experiment.md): the
// offline compiler's surfaces, quantization, merging, swell bounds and
// determinism on synthetic terrain, and the runtime's ground and fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import {
  compileTerrainPacks, bakeMaterial, mergeGapBoundM, cellMeanHeight, quantizeHeight,
} from '../tools/lib/compiled-terrain.mjs';
import {
  decodeCompiledPack, compiledTerrainData, columnGroundAt, regroundForest, compiledTerrainRequest,
  compiledViewUnsupported, compiledCameraView, validateCompiledManifest, COMPILED_PILOT, COMPILED_Y_UNIT_M, COMPILED_ATLAS_SCALE,
} from '../src/world/alpine/CompiledTerrain.js';
import { mergeChunkGeometry, buildCompiledScenes, COMPILED_VERT } from '../src/world/alpine/CompiledTerrainGL.js';
import { loadCompiledPack } from '../src/world/alpine/CompiledTerrainScene.js';
import { terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { sceneDeformation } from '../src/world/alpine/RangeFrame.js';
import { LAND_MAX_DISPLACEMENT_M, LAND_WAVE_K } from '../src/world/alpine/LandMotionLimits.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const CELL = 20;
// Plain material: no textures, forest only above 1000 m (source height).
const MATERIAL = {
  palette: { rockLit: '#b8805a', rockShade: '#4e2e22', rockWarm: '#c89468', soil: '#9a6a48', meadow: '#8a7a54', forestNear: '#203020',
    forestFar: '#304030', moss: '#6a6040', snow: '#f4f2f0', snowShade: '#bcc0c8', water: '#2e3c3c', waterDeep: '#141c1c', wetRock: '#442a20', lichen: '#8a7a60' },
  rules: { snowlineM: 9000, snowFullM: 9500, snowMaxSlopeDeg: 40, treelineM: 9000, forestMaxSlopeDeg: 28, forestDensity: 1,
    moss: 0, wetness: 0, strata: 0.9, forestFloorM: 1000 },
};

/** A 65 x 65 sample grid (4 x 4 chunks of 16 cells): a gentle ramp, a cliff
 *  plateau crossing chunk borders, optional no-data hole. */
function syntheticGrid({ hole = false, heightAt = null } = {}) {
  const W = 65, H = 65, heightsM = new Float32Array(W * H), valid = new Uint8Array(W * H).fill(1);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const plateau = x >= 12 && x <= 36 && z >= 10 && z <= 40;
    heightsM[z * W + x] = heightAt ? heightAt(x, z) : 990 + x * 0.3 + z * 0.2 + (plateau ? 87 : 0);
  }
  if (hole) for (let z = 50; z <= 52; z++) for (let x = 50; x <= 52; x++) { valid[z * W + x] = 0; heightsM[z * W + x] = NaN; }
  return { width: W, height: H, cellSizeM: CELL, originM: [-640, -640], heightsM, valid };
}

const SETTINGS = { chunkCells: 16, mergeBlockM: 80, level0WithinM: 0, gapToleranceM: 1,
  levels: [{ level: 0, cellSamples: 1, quantumM: 5 }, { level: 1, cellSamples: 2, quantumM: 10 }] };
// Mixed levels: chunks with ix + iz odd are coarse, so every interior
// chunk border also has some level border.
const levelFor = (c) => ((c.ix + c.iz) % 2 ? 1 : 0);

function compile(grid, extra = {}) {
  return compileTerrainPacks(grid, null, bakeMaterial(MATERIAL), { coverage: 'all', settings: SETTINGS, levelFor, ...extra });
}
function decoded(pack) { return decodeCompiledPack(pack.manifest, new Uint8Array(pack.decoded)); }

/** World-space quads of a decoded chunk (pairs of triangles a,b,c / a,c,d). */
function quads(chunk) {
  const P = (i) => [chunk.originM[0] + chunk.positions[i * 3], chunk.yBaseM + chunk.positions[i * 3 + 1] * COMPILED_Y_UNIT_M, chunk.originM[1] + chunk.positions[i * 3 + 2]];
  const out = [];
  for (let k = 0; k < chunk.indices.length; k += 6) {
    const ids = [chunk.indices[k], chunk.indices[k + 1], chunk.indices[k + 2], chunk.indices[k + 5]];
    const pts = ids.map(P);
    const n = [chunk.normals[ids[0] * 4] / 127, chunk.normals[ids[0] * 4 + 1] / 127, chunk.normals[ids[0] * 4 + 2] / 127];
    out.push({ pts, n, ids });
  }
  return out;
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

/** Expected displayed column height over fine cell (gi, gj), from the plan. */
function expectedColumns(grid, plan, cells = SETTINGS.chunkCells) {
  const byIndex = new Map(plan.chunks.map(c => [`${c.ix},${c.iz}`, c]));
  return (gi, gj) => {
    const c = byIndex.get(`${Math.floor(gi / cells)},${Math.floor(gj / cells)}`);
    if (!c) return undefined;
    const L = SETTINGS.levels[c.level], s = L.cellSamples;
    const u = Math.floor((gi - c.ix * cells) / s), v = Math.floor((gj - c.iz * cells) / s);
    const mean = cellMeanHeight(grid, c.ix * cells + u * s, c.iz * cells + v * s, s);
    return Number.isFinite(mean) ? quantizeHeight(mean, L.quantumM) : NaN;
  };
}

/** Unit faces (20 m wide, 5 m tall slices for sides; 20 m cells for tops)
 *  of every quad in a pack, as counted keys. */
function unitFaces(pack) {
  const tops = new Map(), sides = new Map();
  const add = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const [ox, oz] = pack.manifest.source.grid.originM;
  for (const chunk of pack.chunks) for (const q of quads(chunk)) {
    const xs = q.pts.map(p => p[0]), ys = q.pts.map(p => p[1]), zs = q.pts.map(p => p[2]);
    const [x0, x1, y0, y1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)];
    if (near(q.n[1], 1, 0.01)) {
      for (let x = x0; x < x1 - 1e-6; x += CELL) for (let z = z0; z < z1 - 1e-6; z += CELL) add(tops, `${(x - ox) / CELL},${(z - oz) / CELL}@${y0}`);
    } else {
      const xAxis = Math.abs(q.n[0]) > 0.5, dir = xAxis ? (q.n[0] > 0 ? '+x' : '-x') : (q.n[2] > 0 ? '+z' : '-z');
      const plane = xAxis ? (x0 - ox) / CELL : (z0 - oz) / CELL;
      const [a0, a1] = xAxis ? [(z0 - oz) / CELL, (z1 - oz) / CELL] : [(x0 - ox) / CELL, (x1 - ox) / CELL];
      for (let a = a0; a < a1 - 1e-6; a++) for (let y = y0; y < y1 - 1e-6; y += 5) add(sides, `${dir}|${plane}|${a}|${y}`);
    }
  }
  return { tops, sides };
}

test('the column surface is exactly the exterior: every top once, every exposed side span once, no interior face', () => {
  const grid = syntheticGrid({ hole: true });
  const { packs, plan } = compile(grid);
  const pack = decoded(packs.columns);
  const col = expectedColumns(grid, plan);
  const { tops, sides } = unitFaces(pack);
  const N = 64;
  // Tops: each valid fine cell exactly once, at its column's height; no-data has none.
  for (let gj = 0; gj < N; gj++) for (let gi = 0; gi < N; gi++) {
    const h = col(gi, gj), key = `${gi},${gj}@${h}`;
    if (Number.isNaN(h)) { assert.ok(![...tops.keys()].some(k => k.startsWith(`${gi},${gj}@`)), `hole ${gi},${gj} has a top`); continue; }
    assert.equal(tops.get(key), 1, `top ${key}`);
  }
  assert.equal(tops.size, [...Array(N * N).keys()].filter(i => !Number.isNaN(col(i % N, Math.floor(i / N)))).length);
  // Sides: expected spans from the taller column down to its lower
  // neighbour (or the chunk floor at the pack edge and over no-data).
  const floorOf = new Map(plan.chunks.map(c => {
    let lo = Infinity;
    for (let v = 0; v < SETTINGS.chunkCells; v++) for (let u = 0; u < SETTINGS.chunkCells; u++) {
      const h = col(c.ix * SETTINGS.chunkCells + u, c.iz * SETTINGS.chunkCells + v);
      if (Number.isFinite(h)) lo = Math.min(lo, h);
    }
    return [`${c.ix},${c.iz}`, lo - SETTINGS.levels[c.level].quantumM];
  }));
  const expected = new Map();
  for (let gj = 0; gj < N; gj++) for (let gi = 0; gi < N; gi++) {
    const h = col(gi, gj);
    if (!Number.isFinite(h)) continue;
    const floor = floorOf.get(`${Math.floor(gi / 16)},${Math.floor(gj / 16)}`);
    for (const [dir, ni, nj, plane, along] of [['+x', gi + 1, gj, gi + 1, gj], ['-x', gi - 1, gj, gi, gj], ['+z', gi, gj + 1, gj + 1, gi], ['-z', gi, gj - 1, gj, gi]]) {
      const nb = ni < 0 || nj < 0 || ni >= N || nj >= N ? undefined : col(ni, nj);
      const bottom = nb === undefined || Number.isNaN(nb) ? floor : nb;
      for (let y = bottom; y < h; y += 5) expected.set(`${dir}|${plane}|${along}|${y}`, 1);
    }
  }
  for (const [key, n] of sides) assert.equal(n, 1, `duplicate side ${key}`);
  for (const key of expected.keys()) assert.ok(sides.has(key), `missing side ${key}`);
  for (const key of sides.keys()) assert.ok(expected.has(key), `unexpected (interior) side ${key}`);
});

test('cliff faces close across chunk and detail-level borders, and every face is wound outward', () => {
  const grid = syntheticGrid();
  const { packs } = compile(grid);
  const pack = decoded(packs.columns);
  let borderSides = 0;
  for (const chunk of pack.chunks) for (const q of quads(chunk)) {
    // Counter-clockwise seen from the stored normal (front face, outward).
    const [a, b, c] = q.pts;
    const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
    const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert.ok(cr[0] * q.n[0] + cr[1] * q.n[1] + cr[2] * q.n[2] > 0, `face of ${chunk.id} wound inward`);
    if (Math.abs(q.n[1]) < 0.5) {
      const xAxis = Math.abs(q.n[0]) > 0.5, p = xAxis ? q.pts[0][0] : q.pts[0][2];
      if (near(((p - (xAxis ? -640 : -640)) / CELL) % 16, 0)) borderSides++;
    }
  }
  // The plateau's cliffs cross chunk borders at x = 16 and z = 16/32 cells.
  assert.ok(borderSides > 0, 'cliff faces on chunk border planes');
});

test('quantization stays within half a step of the area mean and on the world lattice', () => {
  const grid = syntheticGrid({ heightAt: (x, z) => 1000 + 37 * Math.sin(x / 5) * Math.cos(z / 7) + x * 0.9 });
  const { packs, plan } = compile(grid);
  const pack = decoded(packs.columns);
  for (const c of plan.chunks) {
    const q = SETTINGS.levels[c.level].quantumM;
    for (let i = 0; i < c.cols.length; i++) {
      assert.ok(Math.abs(c.cols[i] - c.means[i]) <= q / 2 + 1e-9, `${c.id} column ${i}`);
      assert.ok(near(c.cols[i] / q, Math.round(c.cols[i] / q), 1e-9), 'world-anchored step');
    }
  }
  // Tops sit on their chunk's cell lattice, anchored at the grid origin,
  // and on the vertical step; sides (split at level borders) on the 20 m one.
  const onLattice = (v, m) => near((v + 640) / m, Math.round((v + 640) / m), 1e-9);
  for (const chunk of pack.chunks) {
    const q = SETTINGS.levels[chunk.level].quantumM;
    for (const quad of quads(chunk)) for (const p of quad.pts) {
      const top = near(quad.n[1], 1, 0.01), m = top ? chunk.cellM : CELL;
      assert.ok(onLattice(p[0], m) && onLattice(p[2], m), `${chunk.id} vertex off its lattice`);
      if (top) assert.ok(near(p[1] / q, Math.round(p[1] / q), 1e-6), `${chunk.id} top off its step`);
    }
  }
  // The displayed ground is the column top.
  const data = compiledTerrainData(pack);
  for (const c of plan.chunks) {
    const s = SETTINGS.levels[c.level].cellSamples, x = -640 + (c.ix * 16 + 0.5 * s) * CELL, z = -640 + (c.iz * 16 + 0.5 * s) * CELL;
    assert.equal(columnGroundAt(data, x, z), c.cols[0]);
    assert.equal(terrainHeightAt(data, x, z), c.cols[0], 'terrainHeightAt follows the drawn columns');
  }
});

test('material differences survive merging: merged tops keep one atlas texel per column', () => {
  // Source heights 998 m and 1002 m quantize to one 1000 m step, but the
  // forest floor at 1000 m (source height) gives the halves different
  // albedo. Tops merge by height only; colour stays per column.
  // Flat synthetic ground would read as water (which pins the swell and so
  // forbids merging); declare none, as a view may.
  const grid = syntheticGrid({ heightAt: (x) => (x < 32 ? 998 : 1002) });
  const { packs } = compile(grid, { levelFor: () => 0, water: false });
  const pack = decoded(packs.columns);
  const texel = (ax, ay) => { const o = (ay * pack.atlas.width + ax) * 4; return [...pack.atlas.texels.subarray(o, o + 3)].join(','); };
  let mixedQuad = false;
  for (const chunk of pack.chunks) for (const q of quads(chunk)) {
    if (!near(q.n[1], 1, 0.01)) continue;
    const ax = q.ids.map(i => chunk.atlas[i * 2] / COMPILED_ATLAS_SCALE), ay = q.ids.map(i => chunk.atlas[i * 2 + 1] / COMPILED_ATLAS_SCALE);
    const colours = new Set();
    for (let x = Math.min(...ax); x < Math.max(...ax); x++) for (let y = Math.min(...ay); y < Math.max(...ay); y++) colours.add(texel(x, y));
    if (colours.size > 1) mixedQuad = true;
  }
  const left = texel(pack.chunks[0].atlasTile.x + 2, pack.chunks[0].atlasTile.y + 2);
  const rightChunk = pack.chunks.find(c => c.ix === 3);
  const right = texel(rightChunk.atlasTile.x + 2, rightChunk.atlasTile.y + 2);
  assert.notEqual(left, right, 'the forest floor separates the halves');
  // Split mid-block (x = 26 cells, inside a merge block) the halves are merged
  // geometry (same height) yet different texels.
  const straddle = decoded(compile(syntheticGrid({ heightAt: (x) => (x < 26 ? 998 : 1002) }), { levelFor: () => 0, water: false }).packs.columns);
  for (const chunk of straddle.chunks.filter(c => c.ix === 1)) for (const q of quads(chunk)) {
    if (!near(q.n[1], 1, 0.01)) continue;
    const xs = q.ids.map(i => chunk.atlas[i * 2] / COMPILED_ATLAS_SCALE), y = chunk.atlas[q.ids[0] * 2 + 1] / COMPILED_ATLAS_SCALE;
    const tex = (x) => { const o = (y * straddle.atlas.width + x) * 4; return straddle.atlas.texels[o]; };
    if (tex(Math.min(...xs)) !== tex(Math.max(...xs) - 1)) mixedQuad = true;
  }
  assert.ok(mixedQuad, 'some merged top spans columns of different colours');
});

test('merged edges stay within the declared swell gap, inside world-aligned blocks', () => {
  const heightRangeM = [1500, 2045];
  const L = 160;
  const bound = mergeGapBoundM(L, heightRangeM, 'landscape');
  const span = heightRangeM[1] - heightRangeM[0], cap = Math.min(LAND_MAX_DISPLACEMENT_M, 0.065 * span);
  // Largest Landscape swell: wave amplitude 50·m and lift 40·m, calibrated
  // to the view's cap (RangeFrame.landMotion / calibrateRangeMusic).
  const music = { amplitudeM: 50 * cap / 106.7, structuralM: 40 * cap / 106.7, kickM: 0, gestureM: 0, melodicM: 0,
    waveK: LAND_WAVE_K, phaseRad: 0, melodyK: 0, melodyPhaseRad: 0, melodyDir: [1, 0] };
  let worst = 0;
  for (let k = 0; k < 64; k++) {
    const angle = k * Math.PI / 32;
    music.waveDir = [Math.cos(angle), Math.sin(angle)];
    music.phaseRad = k * 0.7;
    for (const [x0, z0] of [[0, 0], [1234, -560], [-800, 3000]]) for (const axis of [[1, 0], [0, 1]]) {
      const d = (t) => sceneDeformation(music, x0 + axis[0] * t, z0 + axis[1] * t, heightRangeM[1], heightRangeM);
      for (let t = 0; t <= L; t += 20) worst = Math.max(worst, Math.abs(d(t) - (d(0) + (d(L) - d(0)) * t / L)));
    }
  }
  assert.ok(worst <= bound + 1e-9, `measured ${worst} m > bound ${bound} m`);
  assert.ok(bound <= 0.1, 'the pilot tolerance holds for 160 m blocks');
  // No compiled face exceeds or crosses a merge block.
  const { packs } = compile(syntheticGrid({ heightAt: () => 1000 }), { levelFor: () => 0, water: false });
  let largest = 0;
  for (const chunk of decoded(packs.columns).chunks) for (const q of quads(chunk)) {
    largest = Math.max(largest, Math.max(...q.pts.map(p => p[0])) - Math.min(...q.pts.map(p => p[0])));
    const xs = q.pts.map(p => p[0] + 640), zs = q.pts.map(p => p[2] + 640);
    for (const v of [xs, zs]) {
      if (Math.max(...v) - Math.min(...v) < 1e-6) continue; // the plane a side lies in
      assert.ok(Math.max(...v) - Math.min(...v) <= 80 + 1e-6, 'face within the merge block size');
      assert.equal(Math.floor(Math.min(...v) / 80), Math.floor((Math.max(...v) - 1e-6) / 80), 'face inside one block');
    }
  }
  assert.equal(largest, 80, 'flat dry ground merges up to the block size');
});

test('culling bounds cover the swell, and trees stand on the drawn columns', () => {
  const grid = syntheticGrid();
  const pack = decoded(compile(grid).packs.columns);
  const group = mergeChunkGeometry(THREE, pack.chunks.slice(0, 3));
  const sphere = group.geometry.boundingSphere.clone().translate(new THREE.Vector3(group.originM[0], group.yBaseM, group.originM[1]));
  for (const chunk of pack.chunks.slice(0, 3)) for (const q of quads(chunk)) for (const p of q.pts) {
    for (const lift of [-LAND_MAX_DISPLACEMENT_M, LAND_MAX_DISPLACEMENT_M]) {
      assert.ok(sphere.containsPoint(new THREE.Vector3(p[0], p[1] + lift, p[2])), 'swollen vertex outside bounds');
    }
  }
  const data = compiledTerrainData(pack);
  const placed = { stride: 8, meshDetail: Float32Array.from([-500, 0, -500, 10, 4, 0, 0, 2, 9999, 0, 9999, 10, 4, 0, 0, 2]), mesh: new Float32Array(), billboard: new Float32Array(), count: 2 };
  const grounded = regroundForest(placed, data.groundAt);
  assert.equal(grounded.count, 1, 'a root with no ground under it is dropped');
  assert.equal(grounded.meshDetail[1], columnGroundAt(data, -500, -500));
});

test('identical inputs compile to identical bytes', () => {
  const a = compile(syntheticGrid({ hole: true })).packs, b = compile(syntheticGrid({ hole: true })).packs;
  for (const rep of ['columns', 'mesh']) {
    assert.ok(a[rep].payload.equals(b[rep].payload), `${rep} payload`);
    assert.equal(JSON.stringify(a[rep].manifest), JSON.stringify(b[rep].manifest), `${rep} manifest`);
    assert.equal(a[rep].manifest.payload.sha256, b[rep].manifest.payload.sha256);
  }
});

test('the control mesh and its ground agree, and seams snap to the coarser neighbour', () => {
  const grid = syntheticGrid();
  const pack = decoded(compile(grid).packs.mesh);
  const data = compiledTerrainData(pack);
  assert.equal(data.groundAt, null);
  for (const chunk of pack.chunks) for (const q of quads(chunk)) for (const p of q.pts) {
    assert.ok(Math.abs(terrainHeightAt(data, p[0], p[2]) - p[1]) < 0.051, `${chunk.id}: ground ${terrainHeightAt(data, p[0], p[2])} vs vertex ${p[1]}`);
  }
});

test('a pack declares its identity and settings, and runtime decoding rejects tampering', () => {
  const { packs } = compile(syntheticGrid());
  const m = packs.columns.manifest;
  for (const k of ['demSha256', 'validSha256', 'grid', 'verticalReference', 'horizontalCrs']) assert.ok(m.source[k], `source.${k}`);
  assert.equal(m.source.heightUnits, 'metre');
  assert.ok(m.compilerVersion && m.settings.levels.every(l => l.cellM && l.quantumM));
  assert.ok(validateCompiledManifest(m).ok);
  assert.equal(validateCompiledManifest({ ...m, version: 99 }).ok, false);
  const bytes = new Uint8Array(packs.columns.decoded);
  const chunk = m.chunks.find(c => c.indexCount);
  const view = new Uint16Array(bytes.buffer, bytes.byteOffset + chunk.sections.indices.byteOffset, 1);
  view[0] = 65000;
  assert.throws(() => decodeCompiledPack(m, bytes), /index/);
});

test('the URL request is strict, and only the pilot view is compiled', () => {
  assert.deepEqual(compiledTerrainRequest(''), { mode: 'original', camera: null, groupTiles: null, profile: null, invalid: null, invalidCamera: null });
  assert.equal(compiledTerrainRequest('?compiledTerrainProfile=lean').profile, 'lean');
  assert.equal(compiledTerrainRequest('?compiledTerrainProfile=..%2Fx').profile, null);
  assert.equal(compiledTerrainRequest('?compiledTerrain=columns').mode, 'columns');
  assert.equal(compiledTerrainRequest('?compiledTerrain=mesh&compiledTerrainCamera=reverse').camera, 'reverse');
  for (const v of ['1', 'voxels', 'COLUMNS']) {
    const r = compiledTerrainRequest(`?compiledTerrain=${v}`);
    assert.equal(r.mode, 'original'); assert.equal(r.invalid, v);
  }
  assert.equal(compiledTerrainRequest('?compiledTerrainCamera=sideways').invalidCamera, 'sideways');
  const pilot = { id: COMPILED_PILOT.viewId, camera: { eyeStartM: [0, 0, 0] } };
  assert.equal(compiledViewUnsupported(pilot), null);
  for (const v of [{ ...pilot, id: 'teton-jackson-lake' }, { ...pilot, tour: {} }, { ...pilot, glacier: {} }, { ...pilot, terrainSourceId: 'x' }]) {
    assert.ok(compiledViewUnsupported(v));
  }
  assert.deepEqual(compiledCameraView(pilot, 'reverse').camera, { ...COMPILED_PILOT.cameras.reverse });
  assert.equal(compiledCameraView({ ...pilot, id: 'other' }, 'reverse').camera, pilot.camera);
});

/** A RangeScene stand-in for _prepareCompiled: the request, an empty
 *  ledger, and no GPU (packs that fail never reach it). */
function fallbackScene(search) {
  const scene = Object.create(RangeScene.prototype);
  Object.assign(scene, { compiledTerrain: { request: compiledTerrainRequest(search), views: {} }, contextEpoch: 0, residency: null, prepared: new Map() });
  return scene;
}
const PILOT_VIEW = { id: COMPILED_PILOT.viewId, terrainManifestSha256: 'a'.repeat(64), camera: {} };

test('missing, incompatible or tampered packs fall back to the existing renderer, and say so', async () => {
  const { packs } = compile(syntheticGrid());
  const pack = packs.columns;
  const serve = (manifest, payload = pack.payload) => async (url) => {
    if (url.endsWith('.json')) return new Response(JSON.stringify(manifest));
    if (url.endsWith('.bin.gz')) return new Response(payload);
    return new Response('', { status: 404 });
  };
  const good = { ...pack.manifest, viewId: COMPILED_PILOT.viewId,
    source: { ...pack.manifest.source, terrainPackage: { manifestSha256: PILOT_VIEW.terrainManifestSha256 } } };
  const cases = [
    ['missing pack', async () => new Response('', { status: 404 }), /^http/],
    ['other terrain', serve({ ...good, source: { ...good.source, terrainPackage: { manifestSha256: 'b'.repeat(64) } } }), /^hash/],
    ['newer schema', serve({ ...good, version: 2 }), /^manifest/],
    ['other representation', serve({ ...good, representation: 'mesh' }), /^manifest/],
    ['tampered payload', serve(good, Buffer.concat([pack.payload.subarray(0, -1), Buffer.from([pack.payload.at(-1) ^ 1])])), /^hash/],
  ];
  for (const [name, fetchImpl, reason] of cases) {
    const scene = fallbackScene('?compiledTerrain=columns');
    const warn = console.warn; console.warn = () => {};
    let result;
    try { result = await scene._prepareCompiled(PILOT_VIEW, { baseUrl: 'http://x/assets/range/v2/', fetchImpl }, 0); } finally { console.warn = warn; }
    assert.equal(result, null, name);
    const record = scene.compiledTerrain.views[PILOT_VIEW.id];
    assert.equal(record.requested, 'columns', name);
    assert.equal(record.selected, 'original', name);
    assert.match(record.reason, reason, `${name}: ${record.reason}`);
  }
  // A good pack passes every check up to GPU construction.
  const loaded = await loadCompiledPack(PILOT_VIEW, 'columns', { baseUrl: 'http://x/assets/range/v2/', fetchImpl: serve(good) });
  assert.equal(loaded.pack.chunks.length, good.chunks.length);
  // Unsupported views and unknown values are recorded, never guessed.
  const other = fallbackScene('?compiledTerrain=mesh');
  assert.equal(await other._prepareCompiled({ id: 'teton-jackson-lake' }, {}, 0), null);
  assert.equal(other.compiledTerrain.views['teton-jackson-lake'].selected, 'original');
  const unknown = fallbackScene('?compiledTerrain=voxels');
  assert.equal(await unknown._prepareCompiled(PILOT_VIEW, {}, 0), null);
  assert.match(unknown.compiledTerrain.views[PILOT_VIEW.id].reason, /unknown compiledTerrain value voxels/);
  assert.equal(await fallbackScene('')._prepareCompiled(PILOT_VIEW, {}, 0), null);
});

test('draw groups keep bands apart and share one invariant vertex transform with the depth pass', () => {
  const pack = decoded(compile(syntheticGrid()).packs.columns);
  pack.chunks.forEach((c, i) => { c.band = ['far', 'mid', 'near'][i % 3]; });
  const material = new THREE.ShaderMaterial({ vertexShader: COMPILED_VERT, fragmentShader: 'void main(){}' });
  const depthMaterial = new THREE.ShaderMaterial({ vertexShader: COMPILED_VERT, fragmentShader: 'void main(){}' });
  const built = buildCompiledScenes(THREE, pack, { material, depthMaterial, groupTiles: 4 });
  assert.match(COMPILED_VERT, /invariant gl_Position/);
  for (const band of ['far', 'mid', 'near']) {
    const own = built.scenes[band].children.filter(m => !built.fringeMeshes.includes(m));
    assert.equal(own.length, 1, `${band}: one merged draw for the 4 x 4 block`);
    const triangles = own[0].geometry.index.count / 3;
    assert.equal(triangles, pack.chunks.filter(c => c.band === band).reduce((n, c) => n + c.indexCount / 3, 0));
    assert.equal(built.depthBandMeshes[band].length, 1);
    assert.equal(built.depthBandMeshes[band][0].geometry, own[0].geometry, 'colour and depth draw the same buffers');
  }
  built.dispose();
});

test('every column face resolves to its own column texel, including split sides on level borders', () => {
  const grid = syntheticGrid({ heightAt: (x, z) => 1000 + 23 * Math.sin(x * 0.9) + 17 * Math.cos(z * 1.3) });
  const pack = decoded(compile(grid).packs.columns);
  let sides = 0;
  for (const chunk of pack.chunks) {
    const tile = chunk.atlasTile, cm = chunk.cellM;
    for (const q of quads(chunk)) {
      const centre = [0, 1, 2].map(a => q.pts.reduce((sum, p) => sum + p[a], 0) / 4);
      const atlas = [0, 1].map(a => q.ids.reduce((sum, i) => sum + chunk.atlas[i * 2 + a] / COMPILED_ATLAS_SCALE, 0) / 4);
      // Shader: floor(vAtlas - 0.5 * n.xz); geometry: the column the face
      // centre belongs to, stepped inside along the normal.
      const fetched = [Math.floor(atlas[0] - 0.5 * q.n[0]), Math.floor(atlas[1] - 0.5 * q.n[2])];
      const inside = [centre[0] - 0.5 * cm * q.n[0] - chunk.originM[0], centre[2] - 0.5 * cm * q.n[2] - chunk.originM[1]];
      assert.deepEqual(fetched, [tile.x + Math.floor(inside[0] / cm), tile.y + Math.floor(inside[1] / cm)], `${chunk.id} face at ${centre}`);
      if (Math.abs(q.n[1]) < 0.5) sides++;
    }
  }
  assert.ok(sides > 0);
});

test('control vertices shared across a level border carry one normal and one colour', () => {
  const grid = syntheticGrid({ heightAt: (x, z) => 1000 + 40 * Math.sin(x / 3) * Math.cos(z / 4) });
  const pack = decoded(compile(grid).packs.mesh);
  const seen = new Map();
  let shared = 0;
  for (const chunk of pack.chunks) for (let i = 0; i < chunk.vertexCount; i++) {
    const key = `${chunk.originM[0] + chunk.positions[i * 3]},${chunk.originM[1] + chunk.positions[i * 3 + 2]}`;
    const o = (chunk.atlas[i * 2 + 1] / COMPILED_ATLAS_SCALE * pack.atlas.width + chunk.atlas[i * 2] / COMPILED_ATLAS_SCALE) * 4;
    const attrs = JSON.stringify([...chunk.normals.subarray(i * 4, i * 4 + 3), ...pack.atlas.texels.subarray(o, o + 4),
      chunk.yBaseM + chunk.positions[i * 3 + 1] * COMPILED_Y_UNIT_M]);
    if (seen.has(key)) { shared++; assert.equal(attrs, seen.get(key), `vertex ${key}`); } else seen.set(key, attrs);
  }
  assert.ok(shared > 0, 'chunks share border vertices');
});

test('grids that do not tile into whole chunks are rejected rather than wrapped', () => {
  const W = 70, H = 65, heightsM = new Float32Array(W * H).fill(1000), valid = new Uint8Array(W * H).fill(1);
  assert.throws(() => compile({ width: W, height: H, cellSizeM: CELL, originM: [0, 0], heightsM, valid }), /does not tile/);
  assert.ok(Number.isNaN(cellMeanHeight({ width: W, height: H, heightsM, valid }, 68, 0, 4)), 'no read past the right edge');
});
