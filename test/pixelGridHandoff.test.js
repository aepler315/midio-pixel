import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { planTerrainWindow, terrainWindowCoverage, TourWindowCache } from '../src/world/alpine/TerrainWindow.js';

function fixture() {
  const pose = { eyeM: [0, 2000, 12000], targetM: [0, 1000, 0], fovYDeg: 40 };
  const tour = { durationMs: 32000, poseAt: () => pose };
  const viewport = { nominalWidth: 1280, nominalHeight: 720, logicalWidth: 1408, logicalHeight: 848, overscanPx: 64 };
  const coverage = terrainWindowCoverage(viewport);
  const tile = { id: '0', ix: 0, iz: 0, visible: true, stride: 1, samples: 5, band: 'far', minY: 1000, maxY: 1000,
    heightsM: new Float32Array(25).fill(1000), flowBytes: new Uint8Array(25), errorsM: { 1: 0, 2: 0, 4: 0 } };
  const data = { cells: 4, grid: { originM: [-2000, -2000], cellSizeM: 1000 }, tiles: new Map([['0', tile]]),
    byIndex: new Map([['0,0', tile]]), manifest: { boundsM: { min: [-2000, 0, -2000], max: [2000, 4000, 2000] } } };
  const windowOptions = { coverage, coverageRevision: 0, pixelHeightPx: 180 };
  const forest = { counts: { meshDetail: 3, mesh: 7, billboard: 21 } };
  const active = { key: 'displayed', index: 0, coarse: false, forest,
    detail: planTerrainWindow(data, tour, 0, windowOptions), dispose() {} };
  const completions = [];
  const cache = new TourWindowCache({ build: () => new Promise(resolve => completions.push(resolve)), isDisplayed: w => w === p.activeWindow });
  cache.resident.set(0, active);
  const p = { view: { id: 'grid', tour }, data, rules: {}, uniforms: {}, activeWindow: active, forest,
    windowOptions, windowCache: cache, rawAhead: new Map() };
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, residency: null, pixelated: true,
    pixelHeightPx: 360, _swapTourWindow(owner, w) { owner.activeWindow = w; owner.forest = w.forest; } });
  return { scene, p, cache, active, forest, viewport, pose, completions };
}

test('a grid-only refinement keeps the displayed forest while replacement detail prepares', () => {
  const { scene, p, cache, active, forest, viewport, pose } = fixture();
  try {
    scene._updateTourCoverage(p, { scenicViewport: viewport });
    scene._ensureTourWindow(p, 1000, { pose, proj: { fovYDeg: 40, aspect: 16 / 9 } });
    assert.equal(p.activeWindow, active, 'increasing the pixel grid must not publish a treeless coarse stand-in');
    assert.equal(p.forest, forest);
    assert.equal(p.windowCoverage.covered, true);
    assert.equal(p.windowCoverage.reason, 'detail-pending');
    assert.equal(p.windowCoverage.detailHeightPx, 180);
    assert.equal(p.windowCoverage.targetDetailHeightPx, 360);
    assert.equal(p.windowCache.pending.has(0), true, 'replacement detail still prepares asynchronously');
    assert.equal(p.windowCache.pending.has(1), false, 'future speculation waits for the target grid');
  } finally { cache.dispose(); }
});

const camera = pose => ({ pose, proj: { fovYDeg: 40, aspect: 16 / 9 } });

test('replacement adoption retains displayed buffers until scene attachment and pin transfer', async () => {
  const { scene, p, cache, active, viewport, pose, completions } = fixture();
  const bands = ['near', 'mid', 'far'], events = [];
  const arrange = w => {
    w.geos = { geometries: Object.fromEntries(bands.map(b => [b, new THREE.BufferGeometry()])), fringes: {}, stats: {} };
    Object.assign(w.forest, { byBand: Object.fromEntries(bands.map(b => [b, [new THREE.Object3D()]])),
      depthByBand: Object.fromEntries(bands.map(b => [b, []])), depth: [] });
  };
  arrange(active);
  active.dispose = () => events.push('dispose old');
  Object.assign(p, { geometries: active.geos.geometries, fringes: {},
    scenes: Object.fromEntries(bands.map(b => { const s = new THREE.Scene(); s.add(...active.forest.byBand[b]); return [b, s]; })),
    depthScenes: Object.fromEntries(bands.map(b => [b, new THREE.Scene()])), depthScene: new THREE.Scene() });
  scene._swapTourWindow = RangeScene.prototype._swapTourWindow;
  scene.residency = { pinned: new Set(['displayed']), pin(keys) { events.push('pin new'); this.pinned = new Set(keys); } };
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  scene._ensureTourWindow(p, 1000, camera(pose));
  const next = { ...active, key: 'refined', forest: { counts: active.forest.counts },
    detail: planTerrainWindow(p.data, p.view.tour, 0, p.windowOptions),
    adopt() { events.push('adopt new'); return true; }, dispose() {} };
  arrange(next);
  completions[0](next);
  await cache.pending.get(0);
  assert.deepEqual(events, ['adopt new'], 'fulfilled work cannot destroy the still attached buffers');
  assert.equal(p.activeWindow, active);
  assert.equal(cache.resident.get(0), next);
  scene._ensureTourWindow(p, 1000, camera(pose));
  assert.equal(p.activeWindow, next);
  assert.deepEqual(events, ['adopt new', 'pin new', 'dispose old']);
  assert.equal(p.windowCoverage.reason, null);
  assert.equal(p.windowCoverage.detailHeightPx, 360);
  assert.equal(p.detailHeldWindow, null);
  for (const band of bands) assert.deepEqual(p.scenes[band].children, next.forest.byBand[band]);
  cache.dispose();
});

test('an obsolete grid worker cannot replace the retained forest after switching back', async () => {
  const { scene, p, cache, active, viewport, pose, completions } = fixture();
  const disposed = [];
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  scene._ensureTourWindow(p, 1000, camera(pose));
  const obsolete = cache.pending.get(0);
  scene.pixelHeightPx = 180;
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  scene._ensureTourWindow(p, 1000, camera(pose));
  const current = cache.pending.get(0);
  completions[0]({ dispose() { disposed.push('obsolete'); }, adopt() { assert.fail('obsolete result adopted'); } });
  await obsolete;
  assert.equal(p.activeWindow, active);
  assert.equal(cache.pending.get(0), current);
  const next = { index: 0, coarse: false, forest: active.forest,
    detail: planTerrainWindow(p.data, p.view.tour, 0, p.windowOptions), dispose() {} };
  completions[1](next); await current;
  scene._ensureTourWindow(p, 1000, camera(pose));
  assert.equal(p.activeWindow, next);
  assert.deepEqual(disposed, ['obsolete']);
  cache.dispose();
});

test('a grid hold cannot survive changed scenic coverage or a replacement route', () => {
  for (const change of ['viewport', 'route', 'turn']) {
    const { scene, p, cache, active, viewport, pose } = fixture();
    scene._updateTourCoverage(p, { scenicViewport: viewport });
    scene._ensureTourWindow(p, 1000, camera(pose));
    assert.equal(p.activeWindow, active);
    if (change === 'viewport') scene._updateTourCoverage(p, { scenicViewport: { ...viewport, nominalWidth: 2400, logicalWidth: 2528 } });
    if (change === 'route') { scene.prepared = new Map([['grid', p]]); p.windowWorker = { setTour() {} }; scene.replaceTour({ ...p.view, tour: { ...p.view.tour } }); }
    const displayPose = change === 'turn' ? { ...pose, targetM: [0, 2000, 24000] } : pose;
    scene._ensureTourWindow(p, 1000, camera(displayPose));
    assert.notEqual(p.activeWindow, active, change);
    assert.equal(p.activeWindow.coarse, true, change);
    assert.notEqual(p.windowCoverage.reason, 'detail-pending', change);
    cache.dispose();
  }
});

test('failed cache adoption preserves the old resident and its buffers', async () => {
  const { p, cache, active, completions } = fixture();
  let disposed = 0;
  active.dispose = () => assert.fail('old resident must survive failed adoption');
  const job = cache.request(0, { replace: true });
  completions[0]({ adopt: () => false, dispose() { disposed++; } });
  assert.equal(await job, null);
  assert.equal(cache.resident.get(0), active);
  assert.equal(p.activeWindow, active);
  assert.equal(disposed, 1);
  active.dispose = () => {}; cache.dispose();
});

test('a later grid change cannot revive detail invalidated by a replacement route', () => {
  const { scene, p, cache, active, viewport, pose } = fixture();
  scene.prepared = new Map([['grid', p]]);
  p.windowWorker = { setTour() {} };
  scene.replaceTour({ ...p.view, tour: { ...p.view.tour } });
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  scene._ensureTourWindow(p, 1000, camera(pose));
  assert.equal(p.detailHeldWindow, null);
  assert.notEqual(p.activeWindow, active);
  assert.equal(p.activeWindow.coarse, true);
  cache.dispose();
});

test('view cleanup releases a displayed window displaced before the next render', async () => {
  const { scene, p, cache, active, completions } = fixture();
  const disposed = [];
  active.dispose = () => disposed.push('displayed');
  const job = cache.request(0, { replace: true });
  completions[0]({ dispose() { disposed.push('resident'); } });
  await job;
  assert.deepEqual(disposed, []);
  scene._disposePrepared(p);
  assert.deepEqual(disposed.sort(), ['displayed', 'resident']);
});
