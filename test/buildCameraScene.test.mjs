import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { landRiseCamera } from '../src/world/alpine/LandRiseCamera.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { scenicProjection } from '../src/world/alpine/RangeFrame.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { NEUTRAL_MOVE } from '../src/world/alpine/RangeCamera.js';
import { projectRailSky } from '../src/world/alpine/RangeSkyComposition.js';

const camera = { eyeStartM: [0, 1500, 0], eyeEndM: [1000, 1600, 0],
  targetStartM: [0, 700, -9000], targetEndM: [2000, 700, -8000], fovYDeg: 35 };
const viewport = { logicalWidth: 1600, logicalHeight: 720, nominalWidth: 1600, nominalHeight: 720 };
const sourcePose = { eyeM: [1000, 1500, 0], targetM: [2000, 700, -8000], fovYDeg: 35 };
const summit = [-4000, 4000, -12000];
function fixture(view, p) {
  const windows = [];
  const scene = Object.assign(Object.create(RangeScene.prototype), { prepared: new Map([[view.id, p]]),
    _movedPoses: new WeakMap(), camera: new THREE.PerspectiveCamera(),
    _updateTourCoverage() {},
    _ensureTourWindow(owner, at, requested) { windows.push(requested); } });
  // Under the title card, before the opening clock releases the close-up
  // (OpeningTimeline.openingZoomRelease01): framing here follows rise alone.
  const frame = { frameId: 1, timeMs: 1000, progress01: .4, rise01: .3, scenicViewport: viewport };
  return { scene, frame, windows };
}

test('generated static shot tours open close over their current authored action', () => {
  // The pose provider remains a supported duck type even if it does not
  // attach the optional tour metadata to every pose it returns.
  for (const tour of [false, true]) {
    const pose = tour ? { ...sourcePose, tour: true } : sourcePose;
    const cameraTour = { durationMs: 100000, poseAt: () => pose };
    const view = { id: 'static-with-shot-tour', camera };
    const prepared = { view, cameraTour, buildFocusM: summit, waterLevelM: 100 };
    const { scene, frame } = fixture(view, prepared);
    const resolved = scene.movedPose(view, frame);
    const expected = landRiseCamera({ ...pose, fovYDeg: resolved.pose.fovYDeg }, { rise01: frame.rise01, baseM: 100,
      groundM: NaN, focusM: null, aspect: scenicProjection(sourcePose.fovYDeg, viewport).aspect, overview: true });
    assert.deepEqual(resolved.pose.eyeM, expected.eyeM);
    assert.deepEqual(resolved.pose.targetM, expected.targetM);
    assert.ok(resolved.pose.fovYDeg < sourcePose.fovYDeg);
    assert.equal(resolved.pose.eyeM[0], sourcePose.eyeM[0]);
    assert.equal(resolved.pose.eyeM[2], sourcePose.eyeM[2]);
    assert.deepEqual(resolved.pose.targetM, [sourcePose.targetM[0], 100 + frame.rise01 * (sourcePose.targetM[1] - 100), sourcePose.targetM[2]]);
  }
});

test('windowed mapped tours crop their admitted route while following the rising action', () => {
  for (const tour of [false, true]) {
    const pose = tour ? { ...sourcePose, tour: true } : sourcePose;
    const view = { id: 'mapped-tour', camera, tour: { durationMs: 100000, poseAt: () => pose } };
    const prepared = { view, windowCache: {}, buildFocusM: summit, waterLevelM: 100 };
    const { scene, frame, windows } = fixture(view, prepared);
    const resolved = scene.movedPose(view, frame);
    assert.ok(resolved.pose.fovYDeg < sourcePose.fovYDeg);
    assert.equal(resolved.pose.eyeM[0], sourcePose.eyeM[0]);
    assert.equal(resolved.pose.eyeM[2], sourcePose.eyeM[2]);
    assert.deepEqual(resolved.proj, scenicProjection(resolved.pose.fovYDeg, viewport));
    assert.equal(windows[0].proj, resolved.proj);
    assert.equal(windows[0].pose, resolved.pose);
    scene._setCamera(view, frame, prepared);
    assert.equal(scene.camera.fov, resolved.proj.fovYDeg);
    assert.equal(scene.camera.userData.rangeCameraPose, resolved.pose);
    assert.deepEqual(resolved.pose.targetM, [sourcePose.targetM[0], 100 + frame.rise01 * (sourcePose.targetM[1] - 100), sourcePose.targetM[2]]);
  }
});

test('ordinary rails retain their source summit as the build focus', () => {
  const view = { id: 'ordinary-rail', camera }, prepared = { view, buildFocusM: summit, waterLevelM: 100 };
  const { scene, frame } = fixture(view, prepared);
  const rail = scenePoseAt(view, { progress01: frame.progress01 });
  const resolved = scene.movedPose(view, frame);
  const expected = landRiseCamera({ ...rail, fovYDeg: resolved.pose.fovYDeg }, { rise01: frame.rise01, baseM: 100, groundM: NaN, focusM: summit,
    aspect: scenicProjection(rail.fovYDeg, viewport).aspect });
  assert.deepEqual(scene.movedPose(view, frame).pose, { ...expected, userScale: 1 });
});

test('the close opening preserves ground clearance at the authored eye', () => {
  const nearCamera = { eyeStartM: [0, 1000, 0], eyeEndM: [0, 1000, 0],
    targetStartM: [0, 500, -1000], targetEndM: [0, 500, -1000], fovYDeg: 35 };
  const view = { id: 'near-rail', camera: nearCamera }, samples = [];
  const prepared = { view, waterLevelM: 100, data: { grid: { cellSizeM: 20 },
    groundAt(x, z) { samples.push([x, z]); return z > 1000 ? 5000 : 0; } } };
  const { scene, frame } = fixture(view, prepared);
  let factories = 0;
  scene._renderedGround = (...args) => {
    factories++;
    return RangeScene.prototype._renderedGround.call(scene, ...args);
  };
  const resolved = scene.movedPose(view, frame);
  assert.equal(factories, 1, 'camera controls and growth share their terrain sampler');
  assert.ok(samples.every(([x, z]) => x === 0 && z === 0), 'the opening never moves into a different foreground');
  const sourceGround = prepared.data.groundAt(...[resolved.pose.eyeM[0], resolved.pose.eyeM[2]]);
  const drawnGround = 100 + frame.rise01 * (sourceGround - 100);
  assert.ok(resolved.pose.eyeM[1] >= drawnGround + 1000, 'the original authored clearance survives over the newly encountered ground');
});

test('every camera route opens at twenty-four times magnification and smoothly restores its full lens', () => {
  const fixedCamera = { eyeStartM: sourcePose.eyeM, eyeEndM: sourcePose.eyeM,
    targetStartM: sourcePose.targetM, targetEndM: sourcePose.targetM, fovYDeg: 35 };
  for (const mode of ['rail', 'static-tour', 'mapped-tour']) for (const scenicViewport of [viewport,
    { logicalWidth: 560, logicalHeight: 920, nominalWidth: 400, nominalHeight: 720, overscanPx: 64 }]) {
    const view = { id: mode, camera: fixedCamera };
    const tour = { durationMs: 100000, poseAt: () => ({ ...sourcePose, tour: true }) };
    const prepared = { view, waterLevelM: 100 };
    if (mode === 'static-tour') prepared.cameraTour = tour;
    if (mode === 'mapped-tour') { view.tour = tour; prepared.windowCache = {}; }
    const { scene, frame } = fixture(view, prepared);
    const base = scenicProjection(35, scenicViewport);
    const ordinary = new THREE.PerspectiveCamera(base.fovYDeg, base.aspect);
    let lastFocal = Infinity;
    for (let i = 0; i <= 70; i++) {
      const at = { ...frame, rise01: i / 100, scenicViewport };
      scene._setCamera(view, at, prepared);
      const focal = scene.camera.projectionMatrix.elements[5];
      const magnification = focal / ordinary.projectionMatrix.elements[5];
      if (i === 0) assert.ok(Math.abs(magnification - 24) < 1e-12, mode);
      assert.ok(at.rise01 * magnification <= 1 + 1e-12, 'the opening retains the admitted terrain detail bound');
      assert.ok(focal <= lastFocal + 1e-12, 'framing widens continuously with growth');
      lastFocal = focal;
      assert.equal(scene.camera.position.x, sourcePose.eyeM[0]);
      assert.equal(scene.camera.position.z, sourcePose.eyeM[2]);
    }
    assert.ok(Math.abs(lastFocal - ordinary.projectionMatrix.elements[5]) < 1e-12);
    scene._setCamera(view, { ...frame, rise01: 1, scenicViewport }, prepared);
    assert.equal(scene.camera.fov, base.fovYDeg);
  }
});

test('the opening magnifies ordinary sky anchors with the terrain lens', () => {
  const view = { id: 'opening-sky', camera: {
    eyeStartM: [0, 102, 1000], eyeEndM: [0, 102, 1000],
    targetStartM: [0, 100, 0], targetEndM: [0, 100, 0], fovYDeg: 35 } };
  const prepared = { view, waterLevelM: 100, railOnly: true };
  const { scene, frame } = fixture(view, prepared);
  const at = { ...frame, cameraMove: NEUTRAL_MOVE, rise01: 0 };
  const sky = RangePresentation.prototype._skyPan.call({ scene }, view, null, at);
  const point = projectRailSky({ xFrac: .51, yFrac: .5 }, sky.skyCamera);
  assert.ok(Math.abs(point.xFrac - .74) < 1e-9, 'sky and terrain share the tight opening magnification');
  assert.ok(Math.abs(point.yFrac - .5) < 1e-9);
});
