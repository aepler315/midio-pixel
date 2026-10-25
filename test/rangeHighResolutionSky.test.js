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

test('finite cloud sprites have distinct stable shapes and scale smoothly with the destination', () => {
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
    assert.ok(indices.every(Number.isInteger));
    assert.equal(new Set(indices).size, indices.length, 'visible world banks must not repeat a six-sprite catalogue');
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

/** A 2D context that records every paint with its effective state. */
function recordingContext() {
  const ops = [], stack = [];
  const gradient = kind => { const stops = []; return { kind, stops, addColorStop: (offset, color) => stops.push([offset, color]) }; };
  const paint = (ctx, op, extra = {}) => ops.push({ op, alpha: ctx.globalAlpha, mode: ctx.globalCompositeOperation, style: ctx.fillStyle, ...extra });
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000000',
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.fillStyle]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.fillStyle] = stack.pop(); },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createRadialGradient: () => gradient('radial'), createLinearGradient: () => gradient('linear'),
    translate() {}, scale() {}, rotate() {}, beginPath() {}, arc() {}, ellipse() {}, closePath() {}, clip() {},
    fillRect(...rect) { paint(this, 'fillRect', { rect }); },
    fill() { paint(this, 'fill'); },
    drawImage(image, ...rect) { paint(this, 'drawImage', { image, rect }); },
  };
  return { ctx, ops };
}
const alphaOf = color => { const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(color); return m ? Number(m[1]) : 1; };
/** The strongest opacity a recorded paint can reach. */
const peakAlpha = op => op.alpha * (typeof op.style === 'string' || op.op === 'drawImage' ? (op.op === 'drawImage' ? 1 : alphaOf(op.style))
  : Math.max(...op.style.stops.map(([, color]) => alphaOf(color))));
function bakingCanvas() {
  const canvas = { width: 0, height: 0, bakes: 0 };
  canvas.getContext = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image) { canvas.bakes++; canvas.pixels = image.data.slice(); },
  });
  return canvas;
}

test('a Landscape moon hidden by daylight paints nothing; the sun fades with its horizon visibility', () => {
  const sky = new RangeSkyRenderer({ makeCanvas: bakingCanvas });
  sky._seed(7);
  const moon = { xFrac: .6, yFrac: .3, altitude01: .6, radiusFrac: .02, visibility: 1, visible: true };
  const sun = { xFrac: .3, yFrac: .4, altitude01: .5, radiusFrac: .02, visibility: 1, visible: true, colorHex: '#fff3df' };
  const paints = frame => { const { ctx, ops } = recordingContext(); sky._bodies(ctx, { phase: .5, ...frame }, 1408, 848, 0); return ops; };
  try {
    assert.deepEqual(paints({ moon: { ...moon, discAlpha: 0 } }), [], 'no disc, backing or glow from a gated moon');
    assert.ok(paints({ moon: { ...moon, discAlpha: 1 } }).length > 0);
    assert.deepEqual(paints({ sun: { ...sun, visibility: 0 } }), [], 'a sun on the waterline has faded out');
    const full = Math.max(...paints({ sun }).map(peakAlpha));
    const half = Math.max(...paints({ sun: { ...sun, visibility: .5 } }).map(peakAlpha));
    assert.ok(full > .5 && Math.abs(half - full / 2) < 1e-9, `the sun fades with visibility: ${half} of ${full}`);
  } finally { sky.dispose(); }
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

test('individual cloud textures reuse, evict with their tint, and reconstruct deterministically', () => {
  const residency = new GraphicsResidency({ budgetBytes: 8 * 1024 ** 2 });
  let paints = 0;
  const sky = new RangeSkyRenderer({ residency, makeCanvas: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData(image) { paints++; canvas.pixels = image.data.slice(); },
    });
    return canvas;
  } });
  sky._seed(315);
  const first = sky._cloud(103), pixels = first.pixels.slice();
  assert.equal(sky._cloud(103), first);
  assert.equal(paints, 1, 'unchanged bank does not rebake during playback');
  sky.buffers.ensure('storm-cloud-103', 192, 128);
  for (let i = 0; i < 56; i++) sky._cloud(i + 500);
  assert.equal(sky.cloudCache.size, 48);
  assert.equal(sky.buffers.buffers.has('storm-cloud-103'), false);
  assert.equal(residency.usedBytes, 48 * 192 * 128 * 4);
  assert.deepEqual(sky._cloud(103).pixels, pixels, 'returning to a world bank restores exactly its shape');
  sky._seed(316);
  assert.equal(sky.cloudCache.size, 0);
  assert.equal(residency.usedBytes, 0);
  sky.dispose();
});
