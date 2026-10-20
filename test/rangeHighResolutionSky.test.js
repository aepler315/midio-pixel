import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { skyProjector, createSkyCatalogue, cloudDensity, RangeSkyRenderer } from '../src/world/alpine/RangeSkyRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

test('sky directions use the terrain perspective including its off-axis camera crop', () => {
  const pose = { eyeM: [400, 1000, 1200], targetM: [100, 1200, 0], fovYDeg: 42,
    viewOffset: { fx: .3, rx: .08, uy: -.04 }, aspect: 16 / 9 };
  const project = skyProjector({ tourPose: pose });
  const camera = new THREE.PerspectiveCamera(pose.fovYDeg, pose.aspect, 20, 150000);
  camera.position.fromArray(pose.eyeM); camera.lookAt(...pose.targetM);
  const tan = Math.tan(pose.fovYDeg * Math.PI / 360), { fx, rx, uy } = pose.viewOffset;
  camera.setViewOffset(1600, 900, (fx + rx / (tan * pose.aspect)) * 800,
    (fx - uy / tan) * 450, (1 - fx) * 1600, (1 - fx) * 900);
  camera.updateMatrixWorld();
  for (const direction of [[0, .2, -1], [-.3, .4, -1], [.2, -.1, -1]]) {
    const expected = new THREE.Vector3(...direction).multiplyScalar(20000).add(camera.position).project(camera);
    const actual = project(direction);
    assert.ok(Math.abs(actual.xFrac - (expected.x + 1) / 2) < 1e-10);
    assert.ok(Math.abs(actual.yFrac - (1 - expected.y) / 2) < 1e-10);
  }
});

test('world sky anchors turn with the camera but do not acquire terrain translation parallax', () => {
  const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 50, aspect: 16 / 9 };
  const a = skyProjector({ tourPose: pose })([0, .2, -1]);
  const translated = skyProjector({ tourPose: { ...pose, eyeM: [200, 50, 100], targetM: [200, 50, -900] } })([0, .2, -1]);
  assert.deepEqual(translated, a);
  const turned = skyProjector({ tourPose: { ...pose, targetM: [400, 0, -1000] } })([0, .2, -1]);
  assert.ok(turned.xFrac < a.xFrac - .1);
});

test('extended sky shapes retain offscreen endpoints that remain in front of the lens', () => {
  const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 50, aspect: 16 / 9 };
  const project = skyProjector({ tourPose: pose });
  const outside = project([2, .2, -1]);
  assert.equal(outside.visible, false);
  assert.equal(outside.inFront, true);
  assert.equal(project([0, .2, 1]).inFront, false);
  const rail = skyProjector({ skyCamera: { from: { pose, aspect: pose.aspect },
    to: { pose: { ...pose, targetM: [400, 0, -1000] }, aspect: pose.aspect }, mix: .4 } });
  const a = project([2, .2, -1]);
  const b = skyProjector({ tourPose: { ...pose, targetM: [400, 0, -1000] } })([2, .2, -1]);
  assert.ok(Math.abs(rail([2, .2, -1]).xFrac - (a.xFrac * .6 + b.xFrac * .4)) < 1e-10);
});

test('sky textures use smooth sampling even after native pixel terrain presentation', () => {
  const sky = new RangeSkyRenderer();
  const stack = [];
  const ctx = {
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    save() { stack.push([this.imageSmoothingEnabled, this.imageSmoothingQuality]); },
    restore() { [this.imageSmoothingEnabled, this.imageSmoothingQuality] = stack.pop(); },
    createLinearGradient() { return { addColorStop() {} }; }, fillRect() {},
  };
  let inspected = 0;
  for (const method of ['_stars', '_aurora', '_bodies', '_clouds']) sky[method] = c => {
    assert.equal(c.imageSmoothingEnabled, true);
    assert.equal(c.imageSmoothingQuality, 'high');
    inspected++;
  };
  sky.draw(ctx, { camera: { tourPose: { eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 50, aspect: 16 / 9 } },
    seed: 3, sourceWidth: 1280, sourceHeight: 720, night: 1, timeSec: 1, colors: { top: '#000', mid: '#123', horizon: '#456' } });
  assert.equal(inspected, 4);
  assert.equal(ctx.imageSmoothingEnabled, false, 'the caller retains its native terrain sampling policy');
  sky.dispose();
});

test('finite cloud sprites share six bounded textures and scale smoothly with the destination', () => {
  const sky = new RangeSkyRenderer();
  sky.seed = 4;
  const indices = [], matrices = [];
  sky._cloud = index => { indices.push(index); return {}; };
  const ctx = { save() {}, restore() {}, transform(...matrix) { matrices.push(matrix); }, drawImage() {} };
  const camera = { tourPose: { eyeM: [0, 2500, 0], targetM: [0, 3500, -40000], fovYDeg: 50, aspect: 16 / 9 } };
  try {
    sky._clouds(ctx, camera, 1280, 720, 1, 0);
    const first = structuredClone(matrices), firstIndices = [...indices];
    assert.ok(first.length > 0);
    assert.ok(indices.every(index => Number.isInteger(index) && index >= 0 && index < 6));
    indices.length = matrices.length = 0;
    sky._clouds(ctx, camera, 2560, 1440, 1, 0);
    assert.deepEqual(indices, firstIndices, 'resizing cannot change the world cloud catalogue');
    assert.deepEqual(matrices, first.map(matrix => matrix.map(value => value * 2)));
  } finally { sky.dispose(); }
});

test('aurora paints bounded emission rays through the narrowest tour lens', () => {
  const sky = new RangeSkyRenderer();
  const project = skyProjector({ tourPose: { eyeM: [0, 0, 0], targetM: [0, Math.tan(20 * Math.PI / 180), -1],
    fovYDeg: 5, aspect: 16 / 9 } });
  const pieces = [];
  let points = [];
  const ctx = {
    save() {}, restore() {}, createLinearGradient() { return { addColorStop() {} }; },
    beginPath() { points = []; }, moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); }, stroke() { pieces.push(points); },
  };
  sky._aurora(ctx, project, 1280, 720, 1, 0, 1);
  assert.ok(pieces.length > 100 && pieces.length < 2000, `bounded smooth visible rays: ${pieces.length}`);
  assert.ok(pieces.every(p => p.flat().every(Number.isFinite)));
  assert.ok(pieces.every(p => p.length === 2), 'the sky has vertical ray strokes rather than filled ribbon panels');
  assert.ok(pieces.some(p => Math.min(...p.map(v => v[1])) < 0 && Math.max(...p.map(v => v[1])) > 720),
    'a curtain crossing both viewport edges remains drawable');
  sky.dispose();
});

test('the star catalogue and cloud density reconstruct after seeks without frame history', () => {
  assert.deepEqual(createSkyCatalogue(41), createSkyCatalogue(41));
  assert.notDeepEqual(createSkyCatalogue(41), createSkyCatalogue(42));
  const stars = createSkyCatalogue(41);
  assert.ok(stars.length >= 1500);
  for (const star of stars) assert.ok(Math.abs(Math.hypot(...star.direction) - 1) < 1e-10);
  const density = Array.from({ length: 64 }, (_, i) => cloudDensity(i % 8 / 7, Math.floor(i / 8) / 7, 41));
  assert.ok(density.every(Number.isFinite));
  assert.ok(density.some(d => d > .25) && density.some(d => d === 0), 'clouds contain opaque structure and open gaps');
  const reflected = Array.from({ length: 64 }, (_, i) => cloudDensity(i % 8 / 7, 1 - Math.floor(i / 8) / 7, 41));
  assert.notDeepEqual(density, reflected, 'the cloud has an upper silhouette and a distinct lower base');
});

test('sky image caches reserve bounded canvas storage and release it on disposal', () => {
  const residency = new GraphicsResidency({ budgetBytes: 2 * 1024 ** 2 });
  const sky = new RangeSkyRenderer({ residency, makeCanvas: () => ({ width: 0, height: 0 }) });
  sky.buffers.ensure('cloud-0', 192, 128);
  sky.buffers.ensure('moon', 192, 192);
  assert.equal(residency.usedBytes, (192 * 128 + 192 * 192) * 4);
  sky.dispose();
  assert.equal(residency.usedBytes, 0);
});
