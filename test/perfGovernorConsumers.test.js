import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticleField } from '../src/world/ParticleField.js';
import { Murmuration } from '../src/world/Murmuration.js';
import { OrbitalDebris } from '../src/sim/OrbitalDebris.js';

function fakeCtx() {
  let arcs = 0, lines = 0, strokes = 0;
  return {
    get arcCount() { return arcs; },
    get lineCount() { return lines; },
    get strokeCount() { return strokes; },
    save() {}, restore() {}, beginPath() {}, fill() {}, stroke() { strokes++; }, closePath() {},
    arc() { arcs++; },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    moveTo() {}, lineTo() { lines++; }, translate() {}, rotate() {}, roundRect() {}, fillRect() {}, strokeRect() {},
    ellipse() {}, quadraticCurveTo() {}, drawImage() {}, clearRect() {}, scale() {}, filter: '',
  };
}

test('ParticleField.draw draws fewer particles at a lower particleMul', () => {
  const full = new ParticleField({ kind: 'fireflies', color: '#fff', count: 20, speed: 10 }, 800, 600, 1);
  const ctxFull = fakeCtx(), ctxShed = fakeCtx();
  full.draw(ctxFull, 1);
  full.draw(ctxShed, 0.6);
  assert.equal(ctxFull.arcCount, 20);
  assert.equal(ctxShed.arcCount, 12);
});

test('Murmuration.draw draws fewer boids at a lower particleMul', () => {
  const m = new Murmuration(800, 600, 1);
  const ctxFull = fakeCtx(), ctxShed = fakeCtx();
  m.draw(ctxFull, 0, '#fff', 1);
  m.draw(ctxShed, 0, '#fff', 0.6);
  assert.equal(ctxFull.lineCount, 120); // 60 birds, two wings each
  assert.equal(ctxShed.lineCount, 72); // 36 birds
});

test('OrbitalDebris.draw draws fewer shards at a lower particleMul', () => {
  const d = new OrbitalDebris(1);
  const ctxFull = fakeCtx(), ctxShed = fakeCtx();
  d.draw(ctxFull, 200, 0, 1);
  d.draw(ctxShed, 200, 0, 0.6);
  assert.equal(ctxFull.strokeCount, 13);
  assert.equal(ctxShed.strokeCount, 8);
  assert.equal(ctxFull.lineCount, 39); // closed triangles
  assert.equal(ctxShed.lineCount, 24);
});

for (const mul of [0, -0.5, 2]) {
  test(`fixed-size particle consumers bound emitted geometry for multiplier ${mul}`, () => {
    const m = new Murmuration(800, 600, 1);
    const d = new OrbitalDebris(1);
    const birds = fakeCtx(), debris = fakeCtx();
    m.draw(birds, 0, '#fff', mul);
    d.draw(debris, 200, 0, mul);
    assert.equal(birds.lineCount, mul <= 0 ? 0 : 120);
    assert.equal(debris.strokeCount, mul <= 0 ? 0 : 13);
  });
}

test('empty particle collections emit no geometry', () => {
  const birds = fakeCtx(), debris = fakeCtx();
  new Murmuration(800, 600, 1, { n: 0 }).draw(birds, 0, '#fff', 1);
  new OrbitalDebris(1, { n: 0 }).draw(debris, 200, 0, 1);
  assert.equal(birds.lineCount, 0);
  assert.equal(debris.strokeCount, 0);
});

// Range v2 Task 1: an explicit fixture pin outranks export's full-quality hold.
test('PerfGovernor fixture pin survives holdQuality and repeated samples', async () => {
  const { PerfGovernor, MAX_LEVEL } = await import('../src/render/PerfGovernor.js');
  const perf = new PerfGovernor();
  perf.setFixtureLevel(6);
  perf.holdQuality = true;
  for (let i = 0; i < 50; i++) perf.sample(200, 1000 + i * 16);
  assert.equal(perf.level, 6);
  assert.equal(perf.fixtureLevel, 6);
  perf.setFixtureLevel(null);
  assert.equal(perf.fixtureLevel, null);
  // Cleared: export's hold wins again.
  assert.equal(perf.level, 0);
  perf.holdQuality = false;
  perf.setFixtureLevel(0);
  perf.retro = true;
  assert.equal(perf.level, 0, 'fixture outranks the retro floor while active');
  perf.setFixtureLevel(null);
  assert.equal(perf.level, MAX_LEVEL, 'retro floor resumes when the pin clears');
});

test('PerfGovernor fixture pin rejects non-integer and out-of-range levels', async () => {
  const { PerfGovernor } = await import('../src/render/PerfGovernor.js');
  const perf = new PerfGovernor();
  for (const bad of [-1, 7, 2.5, NaN, '3', undefined]) {
    assert.throws(() => perf.setFixtureLevel(bad), RangeError, String(bad));
  }
  assert.equal(perf.fixtureLevel, null);
});

// Renderer._drawTrioCast consumes rimLightEnabled (cast lights) and
// contactShadowsEnabled (the three contact shadows) from the real ladder.
test('Renderer trio cast sheds its lights at the rim-light rung and its shadows at the contact-shadow rung', async () => {
  const { PerfGovernor } = await import('../src/render/PerfGovernor.js');
  const { Renderer } = await import('../src/render/Renderer.js');
  const run = (level) => {
    const perf = new PerfGovernor();
    perf.setFixtureLevel(level);
    const got = { shadows: 0 };
    const trio = {
      midio: { screenX: 500, groundY: 600, y: 0, halfWidth: 23 },
      broshi: { burrow: { depth: 0 }, renderX: 400, groundY: 600, hopY: 0, shadowWidthPx: 60, draw(_c, _p, lights) { got.lights = lights; } },
      midasus: { p: { x: 600, y: 540 }, hue: 200, pulse: 1, voyage: { depth: 0 }, yFloor: 600, shadowWidthPx: 30, draw() {} },
      performer: { beatFlash: 0 }, clockMs: 0,
      pose: () => ({ midioDrawX: 500, midioY: 600, worldX: 0, originX: 435 }),
    };
    const r = Object.create(Renderer.prototype);
    r._drawMidio = () => {};
    const ctx = fakeCtx();
    ctx.ellipse = () => { got.shadows++; };
    r._drawTrioCast(ctx, { trio, perf, songBeat: { snapshotAt: () => ({ freeTime: true }) },
      biomes: { _groundLight: { x: 0, y: 0, intensity: 1 }, currentHaloColor: () => '#fff' } }, perf.particleMul);
    return got;
  };
  assert.ok(Array.isArray(run(1).lights));
  assert.equal(run(2).lights, null);
  assert.equal(run(2).shadows, 3);
  assert.equal(run(3).shadows, 0);
});
