import test from 'node:test';
import assert from 'node:assert/strict';
import { measureProjectedMotion, sampleProjectedTerrainMotion } from '../tools/lib/range-motion-metrics.mjs';
import * as THREE from 'three';

// Breaks caught: reporting render pixels without nominal-720 normalization,
// including masked/hydro anchors, and treating the target uniform as evidence.
test('projected movement reports measured 720-normalized displacement and interpolated percentiles', () => {
  const neutralPoints = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }];
  const activePoints = [{ x: 3, y: 4 }, { x: 10, y: 20 }, { x: 20, y: 35 }];
  assert.deepEqual(measureProjectedMotion({ neutralPoints, activePoints, visibleMask: [true, true, true], nominalHeight: 360 }),
    { visibleCount: 3, medianPx: 20, p95Px: 29, maxPx: 30 });
});

test('masked anchors cannot inflate the visible movement distribution', () => {
  const result = measureProjectedMotion({ neutralPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    activePoints: [{ x: 0, y: 2 }, { x: 0, y: 900 }], visibleMask: [1, 0], nominalHeight: 720 });
  assert.deepEqual(result, { visibleCount: 1, medianPx: 2, p95Px: 2, maxPx: 2 });
});

test('empty or completely hidden groups report zero samples rather than apparent motion', () => {
  for (const [neutralPoints, activePoints, visibleMask] of [[[], [], []], [[{ x: 0, y: 0 }], [{ x: 0, y: 20 }], [false]]]) {
    assert.deepEqual(measureProjectedMotion({ neutralPoints, activePoints, visibleMask, nominalHeight: 720 }),
      { visibleCount: 0, medianPx: 0, p95Px: 0, maxPx: 0 });
  }
});

test('a nominal target uniform does not establish visible motion', () => {
  const music = { targetPx: 20, projectedBoundPx: 20 };
  const points = [{ x: 10, y: 20 }, { x: 20, y: 30 }];
  const measured = measureProjectedMotion({ neutralPoints: points, activePoints: points, visibleMask: [true, true], nominalHeight: 720, music });
  assert.equal(measured.visibleCount, 2);
  assert.equal(measured.maxPx, 0);
  assert.ok(measured.medianPx < 4, 'an unchanged mesh fails the artistic movement target despite its uniform');
});

test('invalid or unmatched anchors cannot silently produce plausible evidence', () => {
  const valid = { neutralPoints: [{ x: 0, y: 0 }], activePoints: [{ x: 0, y: 2 }], visibleMask: [true], nominalHeight: 720 };
  assert.throws(() => measureProjectedMotion({ ...valid, activePoints: [] }), /matched|length/);
  assert.throws(() => measureProjectedMotion({ ...valid, visibleMask: [] }), /matched|length/);
  assert.throws(() => measureProjectedMotion({ ...valid, nominalHeight: 0 }), /height/i);
  assert.throws(() => measureProjectedMotion({ ...valid, activePoints: [{ x: NaN, y: 2 }] }), /finite/i);
});

// A deliberately small real Three mesh proves the sampler measures paired
// geometry through one camera rather than camera travel or target uniforms.
function planePrepared() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-5, 10, -5, 5, 10, -5, -5, 10, 5, 5, 10, 5], 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  return { view: { id: 'test-plane', camera: { eyeStartM: [0, 18, 16], eyeEndM: [0, 18, 16], targetStartM: [0, 10, 0], targetEndM: [0, 10, 0], fovYDeg: 40 } }, geometries: { near: geometry },
    uniforms: { uHeightRange: { value: new THREE.Vector2(0, 10) } } };
}
function planeFrame() {
  return { progress01: .5, scenicViewport: { logicalWidth: 1280, logicalHeight: 720, nominalHeight: 720, transform: [1, 0, 0, 1, 0, 0] },
    music: { amplitudeM: 0, kickM: 1, gestureM: 0, melodicM: 0, structuralM: 0, totalBoundM: 1,
      activity01: 1, waveK: 0, waveDir: [1, 0], phaseRad: 0, melodyK: 0, melodyDir: [1, 0], melodyPhaseRad: 0 } };
}
function planeCamera() {
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 200);
  camera.position.set(0, 18, 16); camera.lookAt(0, 10, 0);
  camera.updateMatrixWorld(); return camera;
}

test('terrain evidence holds the camera fixed, samples actual displacement, and leaves input geometry unchanged', () => {
  const prepared = planePrepared(), frame = planeFrame(), camera = planeCamera();
  const vertices = Array.from(prepared.geometries.near.attributes.position.array), matrix = camera.matrixWorld.toArray();
  const active = sampleProjectedTerrainMotion({ THREE, prepared, frame, camera, receiverAt: () => 1, columns: 6, rows: 5 });
  assert.ok(active.groups.near.visibleCount > 0);
  assert.ok(active.groups.near.maxPx > 0);
  assert.deepEqual(prepared.geometries.near.attributes.position.array, new Float32Array(vertices));
  assert.deepEqual(camera.matrixWorld.toArray(), matrix);
  const neutral = sampleProjectedTerrainMotion({ THREE, prepared, frame: { ...frame,
    music: { ...frame.music, kickM: 0, totalBoundM: 0 } }, camera, receiverAt: () => 1, columns: 6, rows: 5 });
  assert.equal(neutral.groups.near.maxPx, 0);
  assert.equal(active.cameraComparison, 'fixed camera, time, glacier and lighting; music displacement only');
});

test('water-pinned anchors are excluded from terrain response and remain exactly stationary', () => {
  const result = sampleProjectedTerrainMotion({ THREE, prepared: planePrepared(), frame: planeFrame(), camera: planeCamera(),
    receiverAt: () => 0, columns: 6, rows: 5 });
  assert.ok(result.excluded.hydro > 0);
  assert.equal(result.waterMaxDisplacementM, 0);
  assert.equal(result.groups.near.visibleCount, 0);
});

test('terrain back faces do not count as visible anchors', () => {
  const camera = planeCamera();
  camera.position.set(0, 2, 16); camera.lookAt(0, 10, 0); camera.updateMatrixWorld();
  const result = sampleProjectedTerrainMotion({ THREE, prepared: planePrepared(), frame: planeFrame(), camera,
    receiverAt: () => 1, columns: 6, rows: 5 });
  assert.equal(result.sampledSurfaceCount, 0, 'production terrain is front-sided; underside rays must miss');
});

test('letterboxed portrait evidence normalizes by fitted stage height rather than the bars', () => {
  const args = { THREE, prepared: planePrepared(), frame: planeFrame(), camera: planeCamera(),
    receiverAt: () => 1, columns: 6, rows: 5 };
  const wide = sampleProjectedTerrainMotion(args);
  const portrait = sampleProjectedTerrainMotion({ ...args, outputWidth: 540, outputHeight: 960,
    frame: { ...args.frame, scenicViewport: { ...args.frame.scenicViewport,
      nominalWidth: 1280, transform: [.421875, 0, 0, .421875, 0, 328.125] } } });
  assert.equal(portrait.groups.near.visibleCount, wide.groups.near.visibleCount);
  assert.ok(Math.abs(portrait.groups.near.medianPx - wide.groups.near.medianPx) < 1e-9,
    'letterboxing must not be mistaken for weaker terrain response');
});
