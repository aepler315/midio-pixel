import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { planTerrainWindow, terrainWindowCoverage, terrainWindowStudio, terrainWindowTour, terrainWindowCovers, tourSummitTiles, TourWindowCache } from '../src/world/alpine/TerrainWindow.js';
import { decodeTour } from '../src/world/terrain/TourPackage.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const read = (name, decoder) => {
  const path = new URL(name, import.meta.url);
  return decoder(JSON.parse(fs.readFileSync(new URL(`${path}.json`))), gunzipSync(fs.readFileSync(new URL(`${path}.bin.gz`))));
};
const data = read('../src/assets/range/v2/terrain/teton-range-tour.terrain', decodeTerrain);
const routeData = read('../src/assets/range/v2/tour/teton-range-tour.tour', decodeTour);
const protectedTileIds = tourSummitTiles(data, routeData.points);
const tour = { durationMs: 180000, poseAt: t => ({ eyeM: [11000 + t / 1000, 2600, -3000],
  targetM: [2220 + t / 1000, 3000, -2600], fovYDeg: 32.64, tour: true }) };
const vp = { nominalWidth: 1280, nominalHeight: 720, logicalWidth: 1408, logicalHeight: 848, overscanPx: 64 };

const extremes = { enabled: true, preset: 'orbit', direction: 'ccw', distance: .35, elevation: -15,
  fovDeg: 70, focusX: .2, focusY: -.2, focusZ: .2, durationSec: 1, holdSec: 0, orbitSeconds: 20, overshoot: .5 };

test('Studio caps native terrain error and falls back to safe framing when a requested camera cannot fit', () => {
  for (const [settings, fallback] of [
    [{ enabled: true, preset: 'orbit' }, false], [extremes, true],
  ]) {
    const options = { coverage: terrainWindowCoverage(vp), cameraStudio: terrainWindowStudio(data, tour, settings),
      protectedTileIds, riseSink: 1, riseBaseM: 2070, budget: 'mobile', heightPx: 720, pixelHeightPx: 180 };
    const plan = planTerrainWindow(data, tour, 0, options);
    const route = terrainWindowTour(data, tour, { ...options, studioFallback: plan.studioFallback });
    assert.ok(plan.triangles <= 1000000, `${plan.triangles} triangles`);
    assert.ok(plan.visible.size > 0);
    assert.equal(plan.studioFallback === true, fallback);
    assert.ok(plan.maxErrorPx <= 16, `native terrain error ${plan.maxErrorPx}`);
    assert.ok(plan.summitMaxErrorPx <= 16, `native summit error ${plan.summitMaxErrorPx}`);
    assert.ok(plan.detailNote?.length > 0, 'report the quality tradeoff');
    for (let t = 0; t <= 8000; t += 137) {
      const actual = route.poseAt(t);
      const fovYDeg = 2 * Math.atan(Math.tan(actual.fovYDeg * Math.PI / 360) * vp.logicalHeight / 720) * 180 / Math.PI;
      assert.equal(terrainWindowCovers(plan, actual, { fovYDeg, aspect: vp.logicalWidth / vp.logicalHeight }), true, `time ${t}`);
    }
  }
});

test('the production camera uses the covering authored pose after an extreme Studio budget fallback', () => {
  const view = { id: 'budget-test', tour };
  const p = { view, data, rules: {}, windowCache: new TourWindowCache({ build: async () => null }), rawAhead: new Map(),
    windowOptions: { coverage: terrainWindowCoverage(vp), protectedTileIds, riseSink: 1, riseBaseM: 2070,
      budget: 'mobile', heightPx: 720, pixelHeightPx: 180 } };
  const scene = Object.assign(Object.create(RangeScene.prototype), { prepared: new Map([[view.id, p]]),
    _movedPoses: new WeakMap(), _ensureTourWindow() {}, pixelated: true, pixelHeightPx: 180 });
  const resolved = scene.movedPose(view, { frameId: 1, timeMs: 5300, progress01: .5, cameraStudio: extremes,
    rise01: 1, scenicViewport: vp, cameraEffects: null, cameraMove: null });
  assert.deepEqual(resolved.pose.eyeM, tour.poseAt(5300).eyeM);
  assert.deepEqual(resolved.pose.targetM, tour.poseAt(5300).targetM);
  assert.equal(resolved.pose.fovYDeg, 32.64);
  assert.equal(resolved.cameraStudio.budgetFallback, true);
  assert.ok(resolved.cameraStudio.reason.includes('using safe framing'));
  assert.ok(Number.isFinite(resolved.cameraStudio.summitMaxErrorPx));
  p.windowCache.dispose();
});
