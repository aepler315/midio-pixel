import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { projectRailSky } from '../src/world/alpine/RangeSkyComposition.js';
import { buildRangeFrame, viewportState } from '../src/world/alpine/RangeFrame.js';
import * as windows from '../src/world/alpine/TerrainWindow.js';
import { cameraStudioTour } from '../src/world/alpine/CameraStudio.js';

const pose = { eyeM: [0, 2000, 10000], targetM: [0, 0, 0], fovYDeg: 40, tour: true };
const tour = { durationMs: 30000, poseAt: () => ({ ...pose, eyeM: [...pose.eyeM], targetM: [...pose.targetM] }) };
const data = { cells: 64, groundAt: () => 0,
  grid: { originM: [-16000, -16000], width: 641, height: 641, cellSizeM: 50 },
  tiles: new Map([['mountain', { id: 'mountain', ix: 4, iz: 4, visible: true, stride: 1, minY: 0, maxY: 1000,
    errorsM: { 1: 0, 2: 1, 4: 4, 8: 10, 16: 20, 32: 100, 64: 200 } }]]) };
const settings = { enabled: true, preset: 'orbit', distance: .8, direction: 'cw', durationSec: 1, holdSec: .5, orbitSeconds: 20, overshoot: .4 };
const vp = viewportState({ logicalWidth: 1408, logicalHeight: 848, backingWidth: 1408, backingHeight: 848,
  nominalWidth: 1280, nominalHeight: 720, overscanPx: 64 });

test('RangeFrame owns an immutable settings snapshot for seek and export consumers', () => {
  const input = { ...settings };
  const sim = { cameraStudioSettings: input, heardTimeMs: 16000, songSeed: 1, biomes: {
    currentBlend: { from: 'ALPINE', to: 'ALPINE', t: 1 }, durationMs: 30000,
    world: {}, _profile: () => null,
  } };
  const frame = buildRangeFrame({ frameId: 1, sim, pose: { worldX: 0, midioX: 0 }, scenicViewport: vp, groundViewport: vp });
  assert.equal(frame.cameraStudio?.preset, 'orbit');
  assert.ok(Object.isFrozen(frame.cameraStudio));
  input.distance = 1.8;
  assert.equal(frame.cameraStudio.distance, .8);
});

test('production movedPose uses physical Studio orbits for full tours and preserves a pruned eye', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { prepared: new Map(), _movedPoses: new WeakMap(), _ensureTourWindow() {} });
  const view = { id: 'full', tour };
  const frame = { frameId: 1, timeMs: 5300, progress01: .5, cameraStudio: settings, rise01: 1,
    scenicViewport: vp, cameraEffects: null, cameraMove: { yaw: .05, dolly: .1 } };
  const full = scene.movedPose(view, frame, { view, data });
  assert.ok(Math.abs(full.pose.eyeM[0]) > 1000, 'orbit moves the actual eye');
  assert.equal(full.cameraStudio?.capability, 'full');
  const staticView = { id: 'pruned', camera: { eyeStartM: pose.eyeM, eyeEndM: pose.eyeM,
    targetStartM: pose.targetM, targetEndM: pose.targetM, fovYDeg: pose.fovYDeg } };
  const cropped = scene.movedPose(staticView, { ...frame, cameraStudio: { ...settings, distance: .5 } }, null);
  assert.deepEqual(cropped.pose.eyeM, pose.eyeM, 'automatic section moves do not shift the crop-only Studio eye');
  assert.deepEqual(cropped.pose.targetM, pose.targetM);
  assert.equal(cropped.cameraStudio?.capability, 'crop');
});

test('terrain windows cover the resolved spring orbit, including interpolation and a changed Studio shot', () => {
  const coverage = windows.terrainWindowCoverage(vp);
  for (const direction of ['cw', 'ccw']) {
    const studio = { settings: { ...settings, direction }, referencePose: pose, waterLevelM: null };
    const route = cameraStudioTour(tour, studio.settings, { referencePose: pose, heightAt: data.groundAt });
    const plan = windows.planTerrainWindow(data, tour, 0, { coverage, cameraStudio: studio });
    for (let t = 0; t <= 8000; t += 37) {
      const actual = route.poseAt(t);
      const fovYDeg = 2 * Math.atan(Math.tan(actual.fovYDeg * Math.PI / 360) * vp.logicalHeight / 720) * 180 / Math.PI;
      assert.equal(windows.terrainWindowCovers(plan, actual, { fovYDeg, aspect: vp.logicalWidth / vp.logicalHeight }), true, `${direction} @${t}`);
    }
  }
});

test('Studio lens crops project sky anchors through the same magnification as terrain', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { prepared: new Map(), _movedPoses: new WeakMap(), _ensureTourWindow() {} });
  const view = { id: 'pruned', camera: { eyeStartM: pose.eyeM, eyeEndM: pose.eyeM,
    targetStartM: pose.targetM, targetEndM: pose.targetM, fovYDeg: 40 } };
  const frame = { frameId: 1, timeMs: 20000, progress01: .5, cameraStudio: { ...settings, distance: .5 },
    rise01: 1, scenicViewport: vp, cameraEffects: null, cameraMove: null };
  const sky = RangePresentation.prototype._skyPan.call({ scene, shots: { timeline: () => null } }, view, null, frame);
  const projected = projectRailSky({ xFrac: .6, yFrac: .5 }, sky.skyCamera);
  assert.ok(projected.xFrac > .7 && projected.xFrac < .75, `sky shares inward lens crop: ${projected.xFrac}`);
});

test('effective crop limits follow the actual authored shot lens and report capped settings', () => {
  const scene = Object.assign(Object.create(RangeScene.prototype), { prepared: new Map(), _movedPoses: new WeakMap(), _ensureTourWindow() {} });
  const view = { id: 'pruned', camera: { eyeStartM: pose.eyeM, eyeEndM: pose.eyeM,
    targetStartM: pose.targetM, targetEndM: pose.targetM, fovYDeg: 40 } };
  const p = { view, cameraTour: { ...tour, poseAt: () => ({ ...pose, fovYDeg: 28 }) } };
  scene.prepared.set(view.id, p);
  const cameraStudio = { enabled: true, distance: 1.8, fovDeg: 70 };
  const resolved = scene.movedPose(view, { frameId: 1, timeMs: 20000, progress01: .5, cameraStudio,
    rise01: 1, scenicViewport: vp, cameraEffects: null, cameraMove: null });
  assert.equal(resolved.cameraStudio.effectiveDistanceMax, 1);
  assert.equal(resolved.cameraStudio.effectiveFovMaxDeg, 28);
  const status = scene.cameraStudioStatus(view.id, cameraStudio);
  assert.equal(status.effectiveDistanceMax, 1);
  assert.equal(status.effectiveFovMaxDeg, 28);
  assert.equal(status.effectiveDistance, 1);
  assert.equal(status.effectiveFovDeg, 28);
});

test('changing Studio settings invalidates outstanding terrain and forest plans once', () => {
  const cache = new windows.TourWindowCache({ build: async () => null });
  const scene = Object.assign(Object.create(RangeScene.prototype), {});
  const p = { view: { id: 'tour', tour }, data, windowCache: cache,
    windowOptions: { coverage: windows.terrainWindowCoverage(vp), pixelHeightPx: null }, rawAhead: new Map() };
  scene._updateTourCoverage(p, { scenicViewport: vp, cameraStudio: settings });
  assert.equal(p.coverageRevision, 1);
  assert.equal(p.windowOptions.cameraStudio?.settings.preset, 'orbit');
  const first = p.windowOptions;
  scene._updateTourCoverage(p, { scenicViewport: vp, cameraStudio: { ...settings } });
  assert.equal(p.windowOptions, first);
  scene._updateTourCoverage(p, { scenicViewport: vp, cameraStudio: { ...settings, direction: 'ccw' } });
  assert.equal(p.coverageRevision, 2);
  scene._updateTourCoverage(p, { scenicViewport: vp, cameraStudio: { enabled: false } });
  assert.equal(p.coverageRevision, 3);
  assert.equal(p.windowOptions.cameraStudio, null);
  cache.dispose();
});

test('the canonical Studio path is continuous through lattice boundaries and clears a crossing ridge', () => {
  const heightAt = (x, z) => x < -200 && x > -300 && z > 8000 ? 3800 : 0;
  const route = cameraStudioTour(tour, { ...settings, distance: 1 }, { referencePose: pose, heightAt, sampleStepM: 20 });
  let previous = route.poseAt(0);
  for (let t = 1; t < 1500; t++) {
    const next = route.poseAt(t);
    assert.ok(Math.hypot(...next.eyeM.map((v, i) => v - previous.eyeM[i])) < 100, `continuous at ${t}`);
    assert.ok(next.eyeM[1] >= heightAt(next.eyeM[0], next.eyeM[2]) + 400, `ridge clearance at ${t}`);
    previous = next;
  }
});
