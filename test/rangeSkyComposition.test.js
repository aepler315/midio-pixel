import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { createRangeSkyComposition, rangeMoonRadius, tourCloudBanks } from '../src/world/alpine/RangeSkyComposition.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import * as catalogue from '../src/world/StarCatalogue.js';
import { ParticleField } from '../src/world/ParticleField.js';

test('tour lens magnifies cloud bodies along with their sky positions', () => {
  const pose = { eyeM: [0, 1000, 0], targetM: [0, 1000, -10000], fovYDeg: 35 };
  const options = { pose, width: 1280, height: 720, seed: 315 };
  const ordinary = tourCloudBanks(options);
  const zoomed = tourCloudBanks({ ...options, lensScale: .82 });
  assert.ok(ordinary.length > 0);
  for (const bank of ordinary) {
    const zoom = zoomed.find(b => b.id === bank.id);
    assert.ok(Math.abs(zoom.w * .82 - bank.w) < 1e-8);
    assert.ok(Math.abs(zoom.h * .82 - bank.h) < 1e-8);
  }
});

test('Range attenuates stars locally behind the aurora and keeps the rest of the field', () => {
  const canvas = { width: 1280, height: 720 };
  const ridge = new SpaceRidge(315);
  const plan = createRangeSkyComposition(ridge, canvas);
  const corridor = ridge.corridor(canvas)(640);
  const centerY = (corridor.top + corridor.bottom) / 2;
  assert.ok(plan.starBrightnessAt(640, centerY) > 0);
  assert.ok(plan.starBrightnessAt(640, centerY) < 0.2);
  assert.equal(plan.allowPoint(640, centerY), false);
  assert.equal(plan.starBrightnessAt(640, corridor.top - canvas.height * 0.03), 1, 'clear sky above the curtain');
  assert.equal(plan.starBrightnessAt(640, corridor.bottom + canvas.height * 0.03), 1, 'clear sky below the hem');
  assert.equal(createRangeSkyComposition(ridge, canvas).starBrightnessAt(640, centerY), plan.starBrightnessAt(640, centerY));
  assert.ok(plan.starBrightnessAt(640, corridor.top - 3) < plan.starBrightnessAt(640, corridor.top - 18));
  assert.equal(plan.weaverOptions.maxFigures, 1);
  assert.equal(plan.weaverOptions.maxRetained, 0);
});

test('authored voyage has priority over the incidental Range constellation', () => {
  const canvas = { width: 1280, height: 720 };
  const ridge = new SpaceRidge(315);
  assert.equal(createRangeSkyComposition(ridge, canvas).showWeaver, true);
  assert.equal(createRangeSkyComposition(ridge, canvas, { voyageActive: true }).showWeaver, false);
});

test('Range excludes permanent celestial shaft fans and biome ray fans', () => {
  const plan = createRangeSkyComposition(new SpaceRidge(315), { width: 1280, height: 720 });
  assert.equal(plan.celestialShafts, false);
  assert.equal(plan.biomeRays, false);
});

test('Range moon stays present without dominating the entire upper sky late in a song', () => {
  assert.equal(rangeMoonRadius(720, 1), 720 * 0.0361);
  assert.ok(rangeMoonRadius(720, 3.4) <= 52);
  assert.ok(rangeMoonRadius(720, 3.4) >= 45);
});

test('the shared star painter retains faint aurora stars and the clear sky around it', () => {
  const canvas = { width: 1280, height: 720 };
  const ridge = new SpaceRidge(315);
  const plan = createRangeSkyComposition(ridge, canvas);
  const corridor = ridge.corridor(canvas)(640);
  const skyPx = 720 * 0.3781;
  const insideYFrac = (corridor.top + corridor.bottom) / 2 / skyPx;
  const clearYFrac = (corridor.bottom + canvas.height * 0.03) / skyPx;
  const stars = Array.from({ length: 6 }, (_, i) => ({
    xFrac: 0.5, yFrac: i === 0 ? insideYFrac : clearYFrac,
    size: 1, layer: 2, bright: 1, phase: 0, ext: 1, hue: 0, varAmp: 0,
  }));
  const draws = [];
  const ctx = {
    globalAlpha: 1, save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    translate() {}, rotate() {}, scale() {}, arc() {}, rect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect(x, y, w, h) { if (w <= 1 && h <= 1) draws.push([x, y, this.globalAlpha]); },
  };
  const manager = {
    world: { kind: 'alpine' }, tSec: 0, calmLevel: 0, openingGain: 1,
    stars, planets: [], dustLanes: [], deepSky: [], _starBuckets: new Map(),
    _rangeSky: plan,
  };
  BiomeManager.prototype._drawStarfield.call(manager, ctx, canvas, { fx: '' }, { fx: '' }, 0, 1);
  assert.equal(draws.length, 6, 'no blanket star rejection');
  assert.ok(draws[0][2] < draws[1][2] * 0.2, 'the aurora has locally reduced starlight');
  draws.length = 0;
  manager._rangeSky = null;
  BiomeManager.prototype._drawStarfield.call(manager, ctx, canvas, { fx: '' }, { fx: '' }, 0, 1);
  assert.equal(draws.length, 6, 'shared painter retains all six without a Range plan');
});

test('bright, faint and cluster members share Range sky drift in heard time', () => {
  const rects = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, fill() {},
    fillRect(x, y) { rects.push([x, y]); }, rect(x, y) { rects.push([x, y]); } };
  const m = { world: { kind: 'alpine' }, openingGain: 1, tSec: 0,
    stars: [0, 1, 2].map((layer) => ({ xFrac: .2 + layer * .2, yFrac: .1, bright: .8, layer, phase: 0, hue: 0, parallax: .007 + layer * .04 })),
    planets: [], dustLanes: [], deepSky: [], _starBuckets: new Map(),
    _rangeSky: { starBrightnessAt: () => 1 } };
  const draw = () => { rects.length = 0; BiomeManager.prototype._drawStarfield.call(m, ctx, { width: 1280, height: 720 }, { fx: '' }, { fx: '' }, 0, 1, { atmosphere: false }); return rects.map(([x]) => x).sort((a, b) => a - b); };
  const start = draw(); m.tSec = 150; const end = draw();
  const offsets = end.map((x, i) => x - start[i]);
  assert.ok(offsets[0] > 1);
  assert.ok(Math.max(...offsets) - Math.min(...offsets) < 1e-8);
  assert.deepEqual(draw(), end, 'pause/re-render holds angular positions');
});

test('granular galactic structure is deterministic, clustered and subpixel faint', () => {
  assert.equal(typeof catalogue.generateGalacticGranules, 'function');
  const points = catalogue.generateGalacticGranules(12, 800, 1280, 272);
  assert.equal(points.length, 800);
  assert.deepEqual(catalogue.generateGalacticGranules(12, 800, 1280, 272), points);
  for (const p of points) {
    assert.ok(p.x >= 0 && p.x <= 1280 && p.y >= 0 && p.y <= 272);
    assert.ok(p.sizePx < 1 && p.brightness > 0 && p.brightness < .35);
  }
  const pairs = points.slice(0, -1).filter((p, i) => Math.hypot(p.x - points[i + 1].x, p.y - points[i + 1].y) < 30);
  assert.ok(pairs.length > 200, 'correlated local groups rather than uniform scatter');
});

test('Range dims large decorative motes while retaining the true point-star catalogue', () => {
  const plan = createRangeSkyComposition(new SpaceRidge(315), { width: 1280, height: 720 });
  const draws = [], stack = [];
  const ctx = { globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, arc() {}, fill() { draws.push(this.globalAlpha); } };
  const field = new ParticleField({ kind: 'pollen', color: '#ffdda0', count: 8, speed: 1 }, 1280, 720, 1);
  const profile = { name: 'TAIGA', celestial: { haloColor: '#ffdda0' } };
  const mgr = { _rangeSky: plan, openingGain: 1, currentBlend: { from: 'TAIGA', to: 'TAIGA' },
    fields: new Map([['TAIGA', field]]), _rotated: (c) => c, lerpCache: { get: (a) => a },
    swarm: { draw() {} }, murmuration: { draw() {} } };
  const draw = () => {
    draws.length = 0;
    BiomeManager.prototype._drawMidDepthLife.call(mgr, ctx, { width: 1280, height: 720 },
      { ctx, A: profile, B: profile, t: 1, particleMul: 1 },
      { worldX: 0, originX: 0, phenomenaFull: false, particleMul: 1, mandalaColor: '#ffdda0' });
    return draws.reduce((sum, a) => sum + a, 0);
  };
  const subdued = draw(); mgr._rangeSky = null; const ordinary = draw();
  assert.ok(subdued > 0 && subdued < ordinary * .25, 'large ambient dots recede from clusters');
});
