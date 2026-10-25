import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { LightningFX } from '../src/world/Lightning.js';
import { RangeSkyRenderer } from '../src/world/alpine/RangeSkyRenderer.js';
import { compileStorm } from '../src/world/alpine/RangeStorm.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 50, aspect: 16 / 9 };
const profile = { sky: ['#123456', '#234567', '#345678'] };
function managerFixture(storm = {}, options = {}) {
  return Object.assign(Object.create(BiomeManager.prototype), {
    rangePresentation: { skyPan: { tourPose: pose }, frame: { storm }, arrival: 1, scene: {} },
    _scenicLight: { x: 640, y: 120, colorHex: '#ffffff' },
    _pass: () => true, _rotated: value => value, lerpCache: { get: value => value },
    _moonPhase01: () => .5, songSeed: 315, tSec: 45.02, highResolutionSky: true,
    lightning: new LightningFX(315), ...options,
  });
}
function contextFixture() {
  const events = [], stack = [];
  const ctx = { globalAlpha: 1, imageSmoothingEnabled: false,
    save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createLinearGradient(...coords) { const stops = []; events.push({ gradient: coords, stops }); return { addColorStop: (...stop) => stops.push(stop) }; },
    fillRect(...rect) { events.push({ fill: rect, alpha: this.globalAlpha, style: typeof this.fillStyle === 'string' ? this.fillStyle : 'gradient' }); },
    clearRect() {}, drawImage(...args) { events.push({ image: args.slice(1), alpha: this.globalAlpha }); },
    transform(...matrix) { assert.ok(matrix.every(Number.isFinite)); events.push({ matrix }); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() { events.push({ stroke: this.lineWidth, alpha: this.globalAlpha }); },
    arc() { assert.fail('the hybrid storm must not use ellipse cloud puffs'); },
  };
  return { ctx, events };
}
function snapshot(manager) {
  const { ctx } = contextFixture();
  assert.equal(manager._prepareHighResolutionSky(ctx, { width: 1280, height: 720 }, profile, profile, 0, .5), true);
  return manager.rangeSkyLayer;
}
function weatherOnly(sky) {
  for (const method of ['_stars', '_aurora', '_bodies', '_clouds']) sky[method] = () => {};
  return sky;
}

test('the hybrid descriptor retains immutable full weather and existing music/cue lightning', () => {
  const storm = { amount: 1, flash: .8, flashU: .37, break01: .2, wet01: .9 };
  const manager = managerFixture(storm);
  manager.lightning.strike(45000, 1280, 625);
  const frame = snapshot(manager);
  assert.deepEqual(frame.storm, storm);
  assert.ok(Object.isFrozen(frame.storm));
  assert.ok(Object.isFrozen(frame.lightning) && Object.isFrozen(frame.lightning._bolt.main[0]));
  assert.deepEqual(frame.lightning._bolt, manager.lightning._bolt);
  assert.notEqual(frame.lightning._bolt, manager.lightning._bolt);
  storm.flash = 0; manager.lightning._bolt.main[0].x += 100; manager._scenicLight.x = 0;
  assert.equal(frame.storm.flash, .8);
  assert.notEqual(frame.lightning._bolt.main[0].x, manager.lightning._bolt.main[0].x);
  assert.equal(frame.light.x, 640);
  manager.rangeNarrative = { skyDark: 1 };
  assert.equal(snapshot(manager).lightning, null, 'the original narrative exclusion remains in force');
});

test('the hybrid snapshot carries the moon\'s daylight gate and geometric phase, frozen', () => {
  const moon = { xFrac: .6, yFrac: .3, altitude01: .6, radiusFrac: .02, visibility: 1, discAlpha: 0, illumination: .42,
    illuminant: { xFrac: .2, yFrac: .9 } };
  const sun = { xFrac: .3, yFrac: .4, altitude01: .5, radiusFrac: .02, visibility: 1, colorHex: '#fff3df' };
  const manager = managerFixture({}, { celestialState: { sun, moon, activeBody: 'sun' } });
  const frame = snapshot(manager);
  assert.equal(frame.moon.discAlpha, 0);
  assert.equal(frame.moon.illumination, .42);
  assert.ok(Object.isFrozen(frame.moon) && Object.isFrozen(frame.moon.illuminant));
  assert.equal(manager._moonDisc, null, 'a moon hidden by daylight occludes nothing');
  manager.celestialState = { sun, moon: { ...moon, discAlpha: 1 }, activeBody: 'moon' };
  snapshot(manager);
  assert.ok(manager._moonDisc && Math.abs(manager._moonDisc.R - 1280 * .02) < 1e-9, 'the shown moon keeps its occluder');
});

test('actual weak/strong scheduled attacks survive the hybrid sky draw and random access', () => {
  const score = compileStorm({ durationMs: 120000,
    energyCurves: { globalEnergyNorm: time => time >= 40000 && time < 60000 ? .95 : .25 },
    sections: [{ startMs: 0, endMs: 40000 }, { startMs: 40000, endMs: 60000 }, { startMs: 60000, endMs: 120000 }],
    timeline: [{ tMs: 45000, pitch: 36, role: 'RHYTHM', vel: .25 }, { tMs: 45400, pitch: 36, role: 'RHYTHM', vel: .9 }] });
  const sky = weatherOnly(new RangeSkyRenderer());
  const drawAt = time => {
    const calls = [], { ctx, events } = contextFixture();
    sky._stormClouds = (_, banks, options) => calls.push({ banks, options });
    const manager = managerFixture(score.at(time), { tSec: time / 1000 });
    sky.draw(ctx, snapshot(manager));
    return { calls, events };
  };
  try {
    const weak = drawAt(45000), strong = drawAt(45400);
    assert.equal(weak.calls.length, 1, 'weak percussion cannot consume the strong kick\'s lightning');
    assert.equal(strong.calls.length, 2, 'the strong kick illuminates banks inside the storm deck');
    assert.ok(strong.calls[1].banks.some(bank => bank.alpha > .05));
    assert.ok(strong.events.some(event => event.fill?.[1] === 144), 'the existing rain curtains reach the sky target');
    drawAt(70000);
    assert.deepEqual(drawAt(45400), strong, 'seek order cannot change weather or its scheduled accent');
  } finally { sky.dispose(); }
});

test('already triggered legacy lightning draws on the smooth layer', () => {
  const manager = managerFixture();
  manager.lightning.strike(45000, 1280, 625);
  const sky = weatherOnly(new RangeSkyRenderer());
  try {
    const normal = contextFixture();
    sky.draw(normal.ctx, snapshot(manager));
    assert.ok(normal.events.some(event => event.stroke && event.alpha > .4), 'a triggered bolt cannot disappear inside separateSky');
  } finally { sky.dispose(); }
});

test('hybrid storm banks use bounded density sprites and release their storage', () => {
  const residency = new GraphicsResidency({ budgetBytes: 2 * 1024 ** 2 });
  const sky = weatherOnly(new RangeSkyRenderer({ residency, makeCanvas: () => {
    const { ctx } = contextFixture(); return { width: 0, height: 0, getContext: () => ctx };
  } }));
  sky._cloud = () => ({ width: 192, height: 128 });
  const { ctx, events } = contextFixture();
  try {
    sky.draw(ctx, snapshot(managerFixture({ amount: 1, flash: .9, flashU: .4, break01: 0, wet01: 1 })));
    assert.ok(events.some(event => event.image), 'storm clouds must render textured density instead of ellipse banks');
    assert.ok(residency.usedBytes > 0 && residency.usedBytes <= Math.min(residency.budgetBytes, 48 * 192 * 128 * 4));
  } finally { sky.dispose(); }
  assert.equal(residency.usedBytes, 0);
});

test('legacy bolts remain behind celestial bodies, clear clouds and the storm deck', () => {
  const manager = managerFixture({ amount: 1, flash: .9, flashU: .4, break01: 0, wet01: 1 });
  manager.lightning.strike(45000, 1280, 625);
  const sky = weatherOnly(new RangeSkyRenderer()), order = [], { ctx } = contextFixture();
  sky._aurora = () => order.push('aurora');
  sky._bodies = () => order.push('bodies');
  sky._clouds = () => order.push('clouds');
  sky._stormClouds = () => order.push('storm');
  ctx.stroke = () => order.push('bolt');
  try {
    sky.draw(ctx, snapshot(manager));
    assert.ok(order.indexOf('bolt') > order.indexOf('aurora'));
    assert.ok(order.lastIndexOf('bolt') < order.indexOf('bodies'));
    assert.ok(order.indexOf('bodies') < order.indexOf('clouds'));
    assert.ok(order.indexOf('clouds') < order.indexOf('storm'));
  } finally { sky.dispose(); }
});
