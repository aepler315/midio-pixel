import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { landRiseCamera } from '../src/world/alpine/LandRiseCamera.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { scenicProjection } from '../src/world/alpine/RangeFrame.js';

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
  const frame = { frameId: 1, timeMs: 10000, progress01: .4, rise01: .3, scenicViewport: viewport };
  return { scene, frame, windows };
}

test('generated static shot tours open wide over their current authored action', () => {
  // The pose provider remains a supported duck type even if it does not
  // attach the optional tour metadata to every pose it returns.
  for (const tour of [false, true]) {
    const pose = tour ? { ...sourcePose, tour: true } : sourcePose;
    const cameraTour = { durationMs: 100000, poseAt: () => pose };
    const view = { id: 'static-with-shot-tour', camera };
    const prepared = { view, cameraTour, castPlan: { summit }, waterLevelM: 100 };
    const { scene, frame } = fixture(view, prepared);
    const resolved = scene.movedPose(view, frame);
    const expected = landRiseCamera(pose, { rise01: frame.rise01, baseM: 100,
      groundM: NaN, focusM: null, aspect: scenicProjection(sourcePose.fovYDeg, viewport).aspect, overview: true });
    assert.deepEqual(resolved.pose.eyeM, expected.eyeM);
    assert.deepEqual(resolved.pose.targetM, expected.targetM);
    assert.equal(resolved.pose.fovYDeg, expected.fovYDeg);
    assert.ok(Math.hypot(resolved.pose.eyeM[0] - sourcePose.targetM[0], resolved.pose.eyeM[2] - sourcePose.targetM[2])
      > Math.hypot(sourcePose.eyeM[0] - sourcePose.targetM[0], sourcePose.eyeM[2] - sourcePose.targetM[2]));
    assert.deepEqual(resolved.pose.targetM, [sourcePose.targetM[0], 100 + frame.rise01 * (sourcePose.targetM[1] - 100), sourcePose.targetM[2]]);
  }
});

test('windowed mapped tours retain their admitted route and lens while following the rising action', () => {
  for (const tour of [false, true]) {
    const pose = tour ? { ...sourcePose, tour: true } : sourcePose;
    const view = { id: 'mapped-tour', camera, tour: { durationMs: 100000, poseAt: () => pose } };
    const prepared = { view, windowCache: {}, castPlan: { summit }, waterLevelM: 100 };
    const { scene, frame, windows } = fixture(view, prepared);
    const resolved = scene.movedPose(view, frame);
    assert.equal(resolved.pose.fovYDeg, sourcePose.fovYDeg);
    assert.equal(resolved.pose.eyeM[0], sourcePose.eyeM[0]);
    assert.equal(resolved.pose.eyeM[2], sourcePose.eyeM[2]);
    assert.deepEqual(resolved.proj, scenicProjection(sourcePose.fovYDeg, viewport));
    assert.equal(windows[0].proj, resolved.proj);
    assert.equal(windows[0].pose, resolved.pose);
    scene._setCamera(view, frame, prepared);
    assert.equal(scene.camera.fov, resolved.proj.fovYDeg);
    assert.equal(scene.camera.userData.rangeCameraPose, resolved.pose);
    assert.deepEqual(resolved.pose.targetM, [sourcePose.targetM[0], 100 + frame.rise01 * (sourcePose.targetM[1] - 100), sourcePose.targetM[2]]);
  }
});

test('ordinary rails retain their source summit as the build focus', () => {
  const view = { id: 'ordinary-rail', camera }, prepared = { view, castPlan: { summit }, waterLevelM: 100 };
  const { scene, frame } = fixture(view, prepared);
  const rail = scenePoseAt(view, { progress01: frame.progress01 });
  const expected = landRiseCamera(rail, { rise01: frame.rise01, baseM: 100, groundM: NaN, focusM: summit,
    aspect: scenicProjection(rail.fovYDeg, viewport).aspect });
  assert.deepEqual(scene.movedPose(view, frame).pose, { ...expected, userScale: 1 });
});

test('the overview clears newly encountered ground through one shared scene sampler', () => {
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
  assert.equal(factories, 1, 'camera controls and overview share their terrain sampler');
  assert.ok(samples.some(([, z]) => z > 1000), 'the moved overview eye is checked, not only the rail eye');
  const sourceGround = prepared.data.groundAt(...[resolved.pose.eyeM[0], resolved.pose.eyeM[2]]);
  const drawnGround = 100 + frame.rise01 * (sourceGround - 100);
  assert.ok(resolved.pose.eyeM[1] >= drawnGround + 1000, 'the original authored clearance survives over the newly encountered ground');
});
