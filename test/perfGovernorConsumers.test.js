import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticleField } from '../src/world/ParticleField.js';

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
