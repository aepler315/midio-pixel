import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { RangeSkyRenderer, cinematicCloudWeights } from '../src/world/alpine/RangeSkyRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { cloudBanks } from '../src/world/alpine/RangeCloudField.js';

const camera = { tourPose: { eyeM: [0, 2500, 0], targetM: [0, 3500, -40000], fovYDeg: 50, aspect: 16 / 9 } };
const frame = { camera, seed: 315, sourceWidth: 1280, sourceHeight: 720, night: 0, timeSec: 12,
  colors: { top: '#123456', mid: '#345678', horizon: '#789abc' },
  sun: { xFrac: .2, yFrac: .1, altitude01: .8, visibility: 1 }, light: { intensity: 1 } };

function cacheFixture(budgetBytes = 32 * 1024 ** 2) {
  let paints = 0;
  const residency = new GraphicsResidency({ budgetBytes });
  const sky = new RangeSkyRenderer({ residency, makeCanvas: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({
      clearRect() {}, setTransform() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      fillRect() { paints++; }, drawImage() {},
    });
    return canvas;
  } });
  return { sky, residency, paints: () => paints };
}

function outputFixture() {
  const images = [], gradients = [], stack = [];
  const ctx = {
    globalAlpha: 1, imageSmoothingEnabled: false,
    save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    createLinearGradient(...coords) { const stops = []; gradients.push({ coords, stops }); return { addColorStop: (...stop) => stops.push(stop) }; },
    fillRect() {}, transform() {},
    drawImage(image, ...rect) { images.push({ image, alpha: this.globalAlpha, rect }); },
  };
  return { ctx, images, gradients };
}

test('hybrid snapshot freezes the cinematic gate and leaves Classic disabled by default', () => {
  const manager = Object.assign(Object.create(BiomeManager.prototype), {
    rangePresentation: { skyPan: camera, frame: {} }, _pass: () => false,
    _rotated: value => value, lerpCache: { get: value => value },
    _moonPhase01: () => .5, tSec: 12, highResolutionSky: true,
  });
  const ctx = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const profile = { sky: [frame.colors.top, frame.colors.mid, frame.colors.horizon] };
  manager._prepareHighResolutionSky(ctx, { width: 1280, height: 720 }, profile, profile, 0, 0);
  assert.equal(manager.rangeSkyLayer.cinematicPixel, false);
  manager.cinematicPixel = true;
  manager.rangePresentation.frame.qualityLevel = 2;
  manager._prepareHighResolutionSky(ctx, { width: 1280, height: 720 }, profile, profile, 0, 0);
  const snapshot = manager.rangeSkyLayer;
  assert.equal(snapshot.cinematicPixel, true);
  assert.equal(snapshot.qualityLevel, 2);
  assert.ok(Object.isFrozen(snapshot));
  manager.cinematicPixel = false;
  manager.rangePresentation.frame.qualityLevel = 0;
  assert.equal(snapshot.cinematicPixel, true, 'capture cannot read a later preference into an older frame');
  assert.equal(snapshot.qualityLevel, 2, 'capture keeps this frame\'s effective quality');
});

test('cloud light weights follow the projected sun continuously and preserve optical coverage', () => {
  const bank = { matrix: [200, 10, -5, 100, 640, 200] };
  const left = cinematicCloudWeights(bank, frame, 1280, 720);
  const right = cinematicCloudWeights(bank, { ...frame, sun: { ...frame.sun, xFrac: .8 } }, 1280, 720);
  assert.ok(left[1] > left[2], 'a left sun illuminates the left volume');
  assert.ok(right[2] > right[1], 'a right sun illuminates the right volume');
  for (const weights of [left, right]) {
    assert.ok(weights.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(Math.abs(weights.reduce((a, b) => a + b) - 1) < 1e-12, 'premultiplied weights preserve the density alpha');
  }
  assert.deepEqual(cinematicCloudWeights({ matrix: bank.matrix.map(value => value * 2) }, frame, 2560, 1440), left,
    'recording size cannot move the illumination across a cloud');
  const nearby = cinematicCloudWeights(bank, { ...frame, sun: { ...frame.sun, xFrac: .200001 } }, 1280, 720);
  assert.ok(nearby.every((value, i) => Math.abs(value - left[i]) < .0001), 'no direction buckets or threshold shimmer');
  assert.deepEqual(cinematicCloudWeights(bank, { ...frame, sun: { ...frame.sun, visibility: 0 } }, 1280, 720), [1, 0, 0]);
  assert.deepEqual(cinematicCloudWeights(bank, { ...frame, night: 1 }, 1280, 720), [1, 0, 0]);
  const storm = cinematicCloudWeights(bank, { ...frame, storm: { amount: 1 } }, 1280, 720);
  assert.ok(storm[0] > left[0], 'the storm deck mutes the same solar source');
  assert.deepEqual(cinematicCloudWeights({ matrix: [0, 0, 0, 0, 0, 0] }, frame, 1280, 720), [1, 0, 0]);
});

test('cinematic cloud variants reuse their density and release on eviction, switch off and disposal', () => {
  const f = cacheFixture();
  f.sky._seed(315); f.sky._setCinematic(true);
  try {
    const density = f.sky.buffers.ensure('cloud-7', 192, 128);
    f.sky.painted.add(density);
    f.sky._cloud(7);
    const variants = f.sky._cinematicCloud(7, density);
    assert.equal(variants.length, 3);
    assert.equal(f.paints(), 3);
    assert.equal(f.sky._cinematicCloud(7, density), variants);
    assert.equal(f.paints(), 3, 'motion, light direction and repeated draws cannot rebake the cached volume');
    for (let i = 10; i < 60; i++) {
      const image = f.sky.buffers.ensure(`cloud-${i}`, 192, 128);
      f.sky.painted.add(image); f.sky._cloud(i); f.sky._cinematicCloud(i, image);
    }
    assert.equal(f.sky.cloudCache.size, 48);
    assert.equal(f.sky.buffers.buffers.has('cinematic-cloud-7'), false, 'all variants retire with their world cloud');
    assert.ok(f.residency.usedBytes <= 48 * 4 * 192 * 128 * 4);
    f.sky._setCinematic(false);
    assert.ok([...f.sky.buffers.buffers.keys()].every(name => !name.startsWith('cinematic-')));
    assert.equal(f.residency.usedBytes, 48 * 192 * 128 * 4, 'switching back keeps only the established density catalogue');
  } finally { f.sky.dispose(); }
  assert.equal(f.residency.usedBytes, 0);
});

test('cinematic tint allocation refusal paints the established current cloud without a partial tint', () => {
  const f = cacheFixture(192 * 128 * 4);
  f.sky.seed = 315;
  f.sky._cloud = () => ({ width: 192, height: 128 });
  const out = outputFixture();
  try {
    f.sky._clouds(out.ctx, camera, 1280, 720, 0, 12, 0, { ...frame, cinematicPixel: true });
    assert.ok(out.images.length > 0);
    assert.ok(out.images.every(({ image }) => image.width === 192 && image.height === 128));
    assert.equal(f.paints(), 0, 'a denied whole variant bundle never starts drawing into it');
  } finally { f.sky.dispose(); }
  assert.equal(f.residency.usedBytes, 0);
});

test('cinematic sky leaves the Classic gradient recipe exact and reduces faint sky activity', () => {
  const sky = new RangeSkyRenderer(), seen = [];
  for (const name of ['_stars', '_aurora', '_bodies', '_clouds']) sky[name] = (...args) => seen.push([name, args]);
  const classic = outputFixture(), cinematic = outputFixture();
  try {
    sky.draw(classic.ctx, frame);
    assert.deepEqual(classic.gradients[0].stops, [[0, '#123456'], [.65, '#345678'], [1, '#789abc']]);
    sky.draw(cinematic.ctx, { ...frame, cinematicPixel: true });
    assert.notDeepEqual(cinematic.gradients[0].stops, classic.gradients[0].stops);
    assert.equal(seen.find(([name]) => name === '_stars')[1].at(-1), false);
    assert.equal(seen.filter(([name]) => name === '_stars')[1][1].at(-1), true);
    assert.equal(classic.ctx.imageSmoothingEnabled, true);
  } finally { sky.dispose(); }
});

test('cinematic sparse stars depend on authored brightness rather than animated twinkle', () => {
  const sky = new RangeSkyRenderer();
  sky.stars = [.12, .2, .4, .9].map(brightness => ({ brightness, radius: .5, phase: 0, color: 0, direction: [0, .2, -1] }));
  const draw = (time, cinematic) => {
    const stars = [];
    sky._stars({ save() {}, restore() {}, beginPath() {}, fill() {}, fillRect() {},
      createRadialGradient: () => ({ addColorStop() {} }), arc: (...args) => stars.push(args),
    }, () => ({ visible: true, xFrac: .4, yFrac: .2 }), 1280, 720, 1, time, cinematic);
    return stars;
  };
  try {
    assert.equal(draw(0, false).length, 4);
    assert.equal(draw(0, true).length, 2);
    assert.deepEqual(draw(100, true), draw(0, true), 'twinkle never toggles a star identity or position');
  } finally { sky.dispose(); }
});

test('quality shedding releases cloud variants and mix while retaining cinematic sky and live density', () => {
  const f = cacheFixture(), calls = [];
  f.sky._seed(frame.seed);
  for (const name of ['_stars', '_aurora', '_bodies']) f.sky[name] = (...args) => calls.push([name, args]);
  const banks = cloudBanks({ camera, width: 1280, height: 720, timeSec: frame.timeSec, seed: frame.seed });
  assert.ok(banks.length > 0);
  const densities = banks.map(bank => {
    const index = bank.shapeSeed ?? bank.index;
    const density = f.sky.buffers.ensure(`cloud-${index}`, 192, 128);
    f.sky.painted.add(density); f.sky._cloud(index);
    return density;
  });
  const draw = qualityLevel => {
    const out = outputFixture();
    f.sky.draw(out.ctx, { ...frame, cinematicPixel: true, qualityLevel });
    return out;
  };
  const cinematicNames = () => [...f.sky.buffers.buffers.keys()].filter(name => name.startsWith('cinematic-'));
  try {
    const full = draw(0), richBytes = f.residency.usedBytes, paints = f.paints();
    assert.ok(cinematicNames().length > 1 && richBytes > banks.length * 192 * 128 * 4);
    draw(1);
    assert.equal(f.paints(), paints, 'q0/q1 share the exact prepared tint recipe');
    assert.equal(f.residency.usedBytes, richBytes);
    const shed = draw(2);
    assert.deepEqual(cinematicNames(), [], 'q2 immediately gives back every tint and mix allocation');
    assert.equal(f.residency.usedBytes, banks.length * 192 * 128 * 4);
    assert.deepEqual(shed.images.map(item => item.image), densities, 'the current established densities still draw');
    assert.deepEqual(shed.gradients, full.gradients, 'the inexpensive cinematic sky grade is retained');
    assert.equal(calls.filter(([name]) => name === '_stars').at(-1)[1].at(-1), true);
    assert.equal(calls.filter(([name]) => name === '_aurora').at(-1)[1].at(-1), true);
    draw(6);
    assert.deepEqual(cinematicNames(), []);
    assert.equal(f.paints(), paints, 'shed frames cannot rebuild hidden tint resources');
    const recovered = draw(0);
    assert.equal(f.residency.usedBytes, richBytes, 'q0 reconstructs only its admitted current variants');
    assert.deepEqual(recovered.gradients, full.gradients);
    assert.equal(f.paints(), paints * 2);
    draw(2);
    assert.deepEqual(cinematicNames(), [], 'the next shed releases recovered resources again');
  } finally { f.sky.dispose(); }
  assert.equal(f.residency.usedBytes, 0);
});

test('manager quality admission releases optional cloud storage before another frame can draw', () => {
  const f = cacheFixture();
  const manager = Object.assign(Object.create(BiomeManager.prototype), { _highResolutionSkyRenderer: f.sky });
  f.sky._seed(frame.seed); f.sky._setCinematic(true);
  f.sky.draw = () => assert.fail('quality shedding cannot wait for a successful sky draw');
  try {
    const density = f.sky.buffers.ensure('cloud-7', 192, 128);
    f.sky.painted.add(density); f.sky._cloud(7);
    f.sky._cinematicCloud(7, density);
    f.sky.buffers.ensure('cinematic-cloud-mix', 192, 128);
    assert.equal(f.residency.usedBytes, 5 * 192 * 128 * 4);
    manager.setCinematicQuality(1);
    assert.equal(f.residency.usedBytes, 5 * 192 * 128 * 4, 'q1 keeps the unchanged recipe');
    manager.setCinematicQuality(2);
    assert.equal(f.residency.usedBytes, 192 * 128 * 4, 'q2 returns bytes before terrain/window admission');
    assert.ok([...f.sky.buffers.buffers.keys()].every(name => !name.startsWith('cinematic-')));
    manager.setCinematicQuality(0);
    assert.equal(f.residency.usedBytes, 192 * 128 * 4, 'quality recovery allocates only when a sky actually draws');
    const cold = Object.assign(Object.create(BiomeManager.prototype), {});
    cold.setCinematicQuality(6);
    assert.equal(cold._highResolutionSkyRenderer, undefined, 'quality notification cannot initialize a hidden renderer');
  } finally { f.sky.dispose(); }
  assert.equal(f.residency.usedBytes, 0);
});
