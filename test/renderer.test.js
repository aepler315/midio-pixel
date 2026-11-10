import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, bloomStrength, BLOOM_BASE, heatAmbient01 } from '../src/render/Renderer.js';

// --- bloomStrength -----------------------------------------------------

function fakeHype(slam = 0, surge = 0) { return { slam, surge }; }
function fakeFever(level = 0) { return { level }; }

test('bloomStrength has a steady base at rest, never zero', () => {
  const s = bloomStrength(fakeHype(), fakeFever());
  assert.ok(s > 0, 'a lit scene always catches a little light');
  assert.ok(Math.abs(s - BLOOM_BASE) < 1e-9, 'exactly the base with no reactive signal');
});

test('bloomStrength rises monotonically with hype.slam, hype.surge, and fever.level', () => {
  const base = bloomStrength(fakeHype(0, 0), fakeFever(0));
  assert.ok(bloomStrength(fakeHype(0.5, 0), fakeFever(0)) > base, 'slam raises it');
  assert.ok(bloomStrength(fakeHype(0, 0.5), fakeFever(0)) > base, 'surge raises it');
  assert.ok(bloomStrength(fakeHype(0, 0), fakeFever(0.5)) > base, 'fever raises it');
  let prev = base;
  for (const level of [0.2, 0.4, 0.6, 0.8, 1]) {
    const v = bloomStrength(fakeHype(level, level), fakeFever(level));
    assert.ok(v >= prev, `must rise monotonically, level=${level}`);
    prev = v;
  }
});

test('bloomStrength is bounded: a maxed-out drop during max fever never blows out', () => {
  const s = bloomStrength(fakeHype(1, 1), fakeFever(1));
  assert.ok(s <= 0.24 + 1e-9, `bloom must stay a restrained highlight pass, got ${s}`);
});

test('bloom preserves bright terrain detail instead of additively clipping it to white', () => {
  const bufferCtx = { drawImage() {}, clearRect() {} };
  const buffer = () => ({ width: 320, height: 180, getContext: () => bufferCtx });
  const renderer = Object.create(Renderer.prototype);
  renderer._bloomA = buffer();
  renderer._bloomB = buffer();
  let composite, alpha;
  const ctx = { save() {}, restore() {}, drawImage() {
    composite = this.globalCompositeOperation;
    alpha = this.globalAlpha;
  } };
  renderer._drawBloom(ctx, { width: 960, height: 540 }, {
    hype: fakeHype(1, 1), fever: fakeFever(1),
  });
  assert.equal(composite, 'screen', 'highlight spill should use remaining brightness headroom');
  assert.ok(alpha <= 0.24);
});

test('bloomStrength tolerates missing hype/fever (defensive defaults)', () => {
  assert.ok(Math.abs(bloomStrength(null, null) - BLOOM_BASE) < 1e-9);
});

test('heatAmbient01 is 0 with no fire and no ember haze', () => {
  assert.equal(heatAmbient01(false, 0, 0), 0);
  assert.equal(heatAmbient01(false, 1, 0), 0, 'a stale/leftover intensity01 with fireActive=false must not leak through');
});

test('heatAmbient01 tracks an active fire\'s own intensity directly', () => {
  assert.equal(heatAmbient01(true, 0.3, 0), 0.3);
  assert.equal(heatAmbient01(true, 1, 0), 1);
});

test('heatAmbient01: EMBER ambient haze is capped well below a full wildfire blast', () => {
  const full = heatAmbient01(false, 0, 1);
  assert.ok(full > 0 && full < 1, `expected a capped mood, got ${full}`);
  assert.ok(full <= heatAmbient01(true, 1, 0), 'a full ember haze should never exceed a full wildfire strike');
});

test('heatAmbient01 takes the max of fire and ember, not their sum', () => {
  const v = heatAmbient01(true, 0.9, 1);
  assert.ok(v <= 1, `should stay clamped, got ${v}`);
});

test('Range skips full-frame bloom even during a maximum drop', () => {
  const renderer = Object.create(Renderer.prototype);
  renderer._drawBloom({}, { width: 960, height: 540 }, {
    biomes: { world: { kind: 'alpine' } }, hype: fakeHype(1, 1), fever: fakeFever(1),
  });
  assert.ok(!renderer._bloomA, 'the dormant bloom owns no buffer');
});
