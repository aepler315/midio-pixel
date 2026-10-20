import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as windows from '../src/world/alpine/TerrainWindow.js';
import { decodeTerrain, buildTerrainGeometry } from '../src/world/alpine/TerrainMesh.js';
import { projectPoint } from '../src/world/terrain/SceneTravel.js';

const pose = { eyeM: [0, 500, 12000], targetM: [0, 500, 0], fovYDeg: 40 };
const tour = { durationMs: 10000, poseAt: () => pose };
const coverage = { aspect: 2.16, fovScale: 1.7, motionFraction: .28 };
const ridge = () => ({ cells: 64, grid: { originM: [12500, -640], cellSizeM: 20 },
  tiles: new Map([['edge', { id: 'edge', ix: 0, iz: 0, stride: 1, minY: 0, maxY: 1200,
    errorsM: { 1: 0, 2: 5, 4: 20, 8: 80, 16: 160, 32: 320, 64: 600 } }]]) });

test('interpolated tilted turns and changing lenses remain covered at full pullback', () => {
  for (const [width, height] of [[720, 720], [405, 720], [2560, 720]]) {
    const vp = { nominalWidth: width, nominalHeight: height, logicalWidth: width / .66 + 128, logicalHeight: height / .66 + 128, overscanPx: 64 };
    const c = windows.terrainWindowCoverage(vp);
    const route = { durationMs: 100, poseAt: t => {
      const yaw = t / 1000 * 25 * Math.PI / 180, pitch = 20 * Math.PI / 180;
      return { eyeM: [0, 2000, 0], targetM: [12000 * Math.sin(yaw) * Math.cos(pitch), 2000 + 12000 * Math.sin(pitch), -12000 * Math.cos(yaw) * Math.cos(pitch)], fovYDeg: 32.64 };
    } };
    const plan = windows.planTerrainWindow(ridge(), route, 0, { coverage: c });
    const at = route.poseAt(50), fovYDeg = 2 * Math.atan(Math.tan(at.fovYDeg * Math.PI / 360) * vp.logicalHeight / height) * 180 / Math.PI;
    assert.equal(windows.terrainWindowCovers(plan, at, { fovYDeg, aspect: vp.logicalWidth / vp.logicalHeight }), true, `${width}x${height}`);
  }
});

test('a mountain visible in the wide pulled-back picture receives measured detail', () => {
  const projected = projectPoint(pose, 2.16, [13140, 1200, 0], 1 / .66);
  assert.ok(projected.x < 1 && projected.x > .8, 'ridge is inside the actual picture');
  const plan = windows.planTerrainWindow(ridge(), tour, 0, { coverage });
  assert.ok(plan.visible.has('edge'), 'planner must cover the on-screen mountain');
  assert.ok(plan.strides.get('edge') < 64, 'mountain must not flatten to two triangles');
  assert.ok(plan.maxErrorPx <= plan.pixelLimit + 1e-6);
});

test('the final partial window includes its exact endpoint when the camera turns', () => {
  const turning = { durationMs: 8250, poseAt: t => t < 8250 ? { ...pose, targetM: [-12000, 500, 12000] }
    : { ...pose, targetM: [13140, 1200, 0] } };
  const plan = windows.planTerrainWindow(ridge(), turning, 1, { coverage });
  assert.ok(plan.visible.has('edge'), 'the endpoint view cannot fall through the 500ms sampling gap');
});

test('a real Teton peak left of the aim stays detailed outside the old planning cone', () => {
  const base = new URL('../src/assets/range/v2/terrain/teton-range-tour.terrain', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL(`${base}.json`)));
  const data = decodeTerrain(manifest, gunzipSync(fs.readFileSync(new URL(`${base}.bin.gz`))));
  const names = JSON.parse(fs.readFileSync(new URL('../data/terrain/teton-tour-names.json', import.meta.url))).names;
  const buck = names.find(p => p.name === 'Buck Mountain');
  const [x, z] = buck.localM;
  const tile = data.byIndex.get(`${Math.floor((x + 24000) / 1280)},${Math.floor((z + 38000) / 1280)}`);
  const camera = { eyeM: [11000, 2600, -3000], targetM: [2220, 3000, -2600], fovYDeg: 32.64 };
  const projected = projectPoint(camera, 2.16, [x, buck.elevationM, z], 1 / .66);
  assert.ok(projected.x > -1 && projected.x < 0, 'Buck is visible to the left');
  const plan = windows.planTerrainWindow(data, { durationMs: 8000, poseAt: () => camera }, 0, { coverage });
  assert.ok(plan.visible.has(tile.id), 'Buck Mountain is part of the displayed skyline');
  assert.ok(plan.strides.get(tile.id) < 64);
  assert.ok(tile.errorsM[plan.strides.get(tile.id)] < 50, 'preserve the summit instead of losing hundreds of metres');
  const built = buildTerrainGeometry({ ...data, tiles: new Map([[tile.id, tile]]) }, { strides: plan.strides });
  let peak = -Infinity;
  for (const band of Object.values(built.bands)) for (let i = 0; i < band.positions.length; i += 3) {
    if (Math.hypot(band.positions[i] - x, band.positions[i + 2] - z) <= 200) peak = Math.max(peak, band.positions[i + 1]);
  }
  assert.ok(peak > 3577, `Buck Mountain must retain its summit in drawable geometry (${peak})`);
  const fallback = windows.planTerrainWindow(data, { durationMs: 8000, poseAt: () => camera }, 0, { coverage, bias: 2 });
  assert.ok(fallback.triangles <= 1500000, 'temporary reconstruction must respect the desktop triangle cap too');
});

test('a held mesh is rejected when a turn exposes a different side of the route', () => {
  const plan = windows.planTerrainWindow(ridge(), tour, 0, { coverage });
  assert.equal(windows.terrainWindowCovers(plan, pose, { fovYDeg: 40, aspect: 2.16 }), true);
  assert.equal(windows.terrainWindowCovers(plan, { ...pose, targetM: [0, 500, 24000] }, { fovYDeg: 40, aspect: 2.16 }), false);
});

test('coverage revisions keep a late old request from removing or adopting its replacement', async () => {
  const completions = [], disposed = [];
  const cache = new windows.TourWindowCache({ build: () => new Promise(resolve => completions.push(resolve)) });
  const old = cache.at(0);
  assert.equal(typeof cache.invalidate, 'function', 'cache must invalidate pending coverage');
  cache.invalidate();
  const next = cache.at(0);
  assert.notEqual(next, old);
  completions[0]({ dispose() { disposed.push('old'); } });
  await old;
  assert.equal(cache.pending.size, 1, 'old completion cannot delete the new request');
  completions[1]({ id: 'new', dispose() { disposed.push('new'); } });
  await next;
  assert.equal(cache.resident.get(0).id, 'new');
  assert.deepEqual(disposed, ['old']);
  cache.dispose();
});

test('resizing invalidates incompatible prepared windows without changing the tour camera', async () => {
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const old = { index: 0, dispose() {} }, next = { index: 1, disposed: false, dispose() { this.disposed = true; } };
  const cache = new windows.TourWindowCache({ build: async () => ({ dispose() {} }) });
  cache.resident.set(0, old); cache.resident.set(1, next);
  const route = { poseAt: () => pose }, entry = {};
  const p = { view: { tour: route }, activeWindow: old, windowCache: cache, windowOptions: {}, rawAhead: new Map([[2, entry]]) };
  const scene = Object.assign(Object.create(RangeScene.prototype), { _dropTourRaw(e) { e.cancelled = true; } });
  assert.equal(typeof scene._updateTourCoverage, 'function');
  scene._updateTourCoverage(p, { scenicViewport: { nominalWidth: 1280, nominalHeight: 720, overscanPx: 64 } });
  const first = p.coverageRevision;
  scene._updateTourCoverage(p, { scenicViewport: { nominalWidth: 2560, nominalHeight: 720, overscanPx: 64 } });
  assert.ok(p.coverageRevision > first);
  assert.equal(next.disposed, true); assert.equal(entry.cancelled, true);
  assert.equal(p.rawAhead.size, 0); assert.equal(p.view.tour, route);
  assert.equal(p.activeWindow, old, 'keep ownership until a covering replacement can be drawn');
});

async function windowScene() {
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const data = ridge(); data.byIndex = new Map();
  for (const tile of data.tiles.values()) {
    Object.assign(tile, { visible: true, samples: 65, band: 'far', heightsM: new Float32Array(4225), flowBytes: new Uint8Array(4225) });
    data.byIndex.set('0,0', tile);
  }
  data.grid.width = data.grid.height = 65;
  const active = { index: 0, coarse: false, dispose() {} };
  const cache = new windows.TourWindowCache({ build: () => new Promise(() => {}) });
  cache.resident.set(0, active);
  const p = { view: { id: 'coverage', tour: { ...tour, durationMs: 30000 } }, data, uniforms: {}, windowCache: cache,
    activeWindow: active, windowOptions: { coverage }, coverageRevision: 1 };
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, residency: null,
    _swapTourWindow(owner, resource) { owner.activeWindow = resource; } });
  return { scene, p, cache };
}

test('replacing an uncovered prefetched window disposes its resource ownership', async () => {
  const { scene, p, cache } = await windowScene();
  const next = { index: 1, coarse: false, disposed: false, dispose() { this.disposed = true; } };
  cache.resident.set(1, next);
  scene._ensureTourWindow(p, 9000, { pose, proj: { fovYDeg: 40, aspect: 2.16 } });
  assert.equal(next.disposed, true);
  assert.equal(cache.resident.get(1).coarse, true);
  cache.dispose();
});

test('a denied reconstruction exposes unavailable coverage and still requests async replacement', async () => {
  const { scene, p, cache } = await windowScene();
  scene.residency = { reserve: () => null };
  scene._ensureTourWindow(p, 9000, { pose, proj: { fovYDeg: 40, aspect: 2.16 } });
  assert.equal(p.windowCoverage?.covered, false);
  assert.equal(cache.pending.has(1), true, 'replacement must be able to progress while fallback is shown');
  cache.dispose();
});

test('export settling waits for the current terrain window before requesting a redraw', async () => {
  const { RangePresentation } = await import('../src/world/alpine/RangePresentation.js');
  let finish;
  const job = new Promise(resolve => { finish = resolve; });
  const presentation = { _needed: new Set(), _wants: [], frameInputs: {},
    scene: { prepared: new Map([['tour', { windowCache: { current: 1, pending: new Map([[1, job]]) } }]]) } };
  let settled = false;
  const pending = RangePresentation.prototype.settle.call(presentation, { timeoutMs: 1000 }).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  finish(); assert.equal(await pending, true);
});

test('export settling explicitly retries current terrain preparation during admission cooldown', async () => {
  const { RangePresentation } = await import('../src/world/alpine/RangePresentation.js');
  let builds = 0;
  const cache = new windows.TourWindowCache({ now: () => 1000, build: async () => {
    if (++builds === 1) throw Object.assign(new Error('budget'), { reason: 'budget' });
    return { dispose() {} };
  } });
  cache.current = 1;
  await assert.rejects(cache.request(1), /budget/);
  const presentation = { _needed: new Set(), _wants: [], frameInputs: {},
    scene: { prepared: new Map([['tour', { windowCache: cache }]]) } };
  assert.equal(await RangePresentation.prototype.settle.call(presentation, { timeoutMs: 1000 }), true);
  assert.equal(builds, 2, 'export settling must not accept a cooldown without retrying');
  assert.ok(cache.resident.has(1));
  cache.dispose();
});
