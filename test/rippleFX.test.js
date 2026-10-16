import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rippleRadius, rippleAlpha, rippleLifeMs, groundPulseX, puffOffset, puffAlpha, PUFF_COUNT, PUFF_LIFE_MS, RippleFX,
} from '../src/sim/RippleFX.js';

test('rippleRadius grows monotonically within life, scales with I, and is finite', () => {
  for (const I of [0, 0.3, 0.7, 1]) {
    let prev = -1;
    const life = rippleLifeMs(I);
    for (let age = 0; age <= life; age += 40) {
      const r = rippleRadius(age, I);
      assert.ok(Number.isFinite(r));
      assert.ok(r >= prev - 1e-9, `radius must not shrink: ${r} < ${prev} at age=${age}, I=${I}`);
      prev = r;
    }
  }
  assert.ok(rippleRadius(9999, 1) > rippleRadius(9999, 0), 'harder landings ripple farther');
});

test('rippleAlpha fades to (near) zero by the end of life and is bounded', () => {
  for (const I of [0, 0.5, 1]) {
    const life = rippleLifeMs(I);
    const start = rippleAlpha(0, I);
    assert.ok(start > 0 && start <= 1);
    assert.ok(rippleAlpha(life, I) === 0, 'alpha must reach zero at end of life');
    assert.ok(rippleAlpha(life * 0.5, I) < start, 'alpha must decrease over time');
  }
});

test('groundPulseX moves outward monotonically and scales with I', () => {
  let prev = -1;
  for (let age = 0; age <= 700; age += 50) {
    const d = groundPulseX(age, 0.8);
    assert.ok(Number.isFinite(d));
    assert.ok(d >= prev - 1e-9);
    prev = d;
  }
  assert.ok(groundPulseX(300, 1) >= groundPulseX(300, 0));
});

test('RippleFX: trigger spawns staggered rings and a pulse; they all drain over time', () => {
  const fx = new RippleFX();
  fx.trigger(1000, 540, 0.9);
  assert.equal(fx.rings.active.length, 3, 'expects RIPPLE_RINGS staggered rings');
  assert.equal(fx.pulses.active.length, 1);
  // Staggered starts: ring ages should differ (negative delay before they show).
  const ages = fx.rings.active.map((r) => r.age);
  assert.ok(new Set(ages).size > 1, 'rings must be staggered, not simultaneous');
  for (let i = 0; i < 60; i++) fx.update(50); // 3s, well past any life
  assert.equal(fx.rings.active.length, 0);
  assert.equal(fx.pulses.active.length, 0);
});

test('RippleFX.trigger spawns fewer rings under a lower particleMul, never below one', () => {
  // Previously trigger() ignored particleMul entirely, always spawning the
  // fixed RIPPLE_RINGS count regardless of perf level.
  const full = new RippleFX();
  full.trigger(1000, 540, 0.9, 1);
  assert.equal(full.rings.active.length, 3);

  const shed = new RippleFX();
  shed.trigger(1000, 540, 0.9, 0.6);
  assert.ok(shed.rings.active.length < 3, 'a lower particleMul should spawn fewer rings');
  assert.ok(shed.rings.active.length >= 1, 'never sheds down to zero rings');
});

test('RippleFX.draw runs without throwing and only draws finite geometry', () => {
  const fx = new RippleFX();
  fx.trigger(500, 540, 0.6);
  fx.landingPuff(500, 540, 0.6, '#ffffff');
  const calls = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, moveTo(x, y) { calls.push(x, y); }, lineTo(x, y) { calls.push(x, y); },
    ellipse(x, y, rx, ry) { calls.push(x, y, rx, ry); },
    arc(x, y, r) { calls.push(x, y, r); },
    set globalCompositeOperation(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set fillStyle(v) {}, set globalAlpha(v) {},
  };
  assert.doesNotThrow(() => fx.draw(ctx, 500, 220, false));
  assert.ok(calls.length > 0);
  for (const v of calls) assert.ok(Number.isFinite(v));
});

test('RippleFX.draw culls rings, pulses, and puffs that have scrolled off-screen', () => {
  const canvasWidth = 800;
  const near = new RippleFX();
  near.trigger(400, 540, 0.6);
  near.landingPuff(400, 540, 0.6, '#ffffff');

  const far = new RippleFX();
  far.trigger(50000, 540, 0.6);
  far.landingPuff(50000, 540, 0.6, '#ffffff');

  let nearCalls = 0, farCalls = 0;
  const makeCtx = (counter) => ({
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, moveTo() {}, lineTo() {},
    ellipse() { counter(); }, arc() { counter(); },
    set globalCompositeOperation(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set fillStyle(v) {}, set globalAlpha(v) {},
  });
  near.draw(makeCtx(() => nearCalls++), 0, 0, false, canvasWidth);
  far.draw(makeCtx(() => farCalls++), 0, 0, false, canvasWidth);

  assert.ok(nearCalls > 0, 'on-screen rings/pulses/puffs should draw');
  assert.equal(farCalls, 0, 'off-screen rings/pulses/puffs should be culled');
});

test('RippleFX.draw with no canvasWidth given draws everything regardless of scroll distance', () => {
  const fx = new RippleFX();
  fx.trigger(50000, 540, 0.6);
  let calls = 0;
  const ctx = {
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, moveTo() {}, lineTo() {},
    ellipse() { calls++; }, arc() { calls++; },
    set globalCompositeOperation(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set fillStyle(v) {}, set globalAlpha(v) {},
  };
  fx.draw(ctx, 0, 0, false); // canvasWidth omitted -- defaults to Infinity
  assert.ok(calls > 0);
});

test('RippleFX.draw falls back to source-over compositing under reducedFlash', () => {
  // Rings, pulses and puffs all draw additively at the same landing point;
  // stacked with ImpactFX's ignition ring and RainbowBrush's dabs, capped
  // layers can still sum past FLASH_CAP under 'lighter'. Reduced-flash must
  // fall back to normal compositing so the cap actually holds.
  const fx = new RippleFX();
  fx.trigger(500, 540, 0.6);
  fx.landingPuff(500, 540, 0.6, '#ffffff');
  const compositeOps = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, moveTo() {}, lineTo() {},
    ellipse() {}, arc() {},
    set globalCompositeOperation(v) { compositeOps.push(v); },
    set strokeStyle(v) {}, set lineWidth(v) {}, set fillStyle(v) {}, set globalAlpha(v) {},
  };
  fx.draw(ctx, 500, 220, true);
  assert.ok(compositeOps.includes('source-over'), 'reducedFlash falls back to source-over');
  assert.ok(!compositeOps.includes('lighter'), 'reducedFlash must not use additive compositing');
});

test('puffOffset: distance grows monotonically within life, rises then settles, finite', () => {
  let prevDist = -1;
  for (let age = 0; age <= PUFF_LIFE_MS; age += 40) {
    const { dx, dy } = puffOffset(age, 0, 0.8);
    assert.ok(Number.isFinite(dx) && Number.isFinite(dy));
    const dist = Math.abs(dx);
    assert.ok(dist >= prevDist - 1e-9, `radial distance must not shrink: ${dist} < ${prevDist} at age=${age}`);
    prevDist = dist;
  }
  // Rise (negative dy contribution) peaks mid-life and returns toward 0.
  const { dy: dyStart } = puffOffset(0, Math.PI / 2, 1);
  const { dy: dyMid } = puffOffset(PUFF_LIFE_MS / 2, Math.PI / 2, 1);
  const { dy: dyEnd } = puffOffset(PUFF_LIFE_MS, Math.PI / 2, 1);
  assert.ok(dyMid < dyStart && dyMid < dyEnd, 'rises mid-life relative to start/end');
});

test('puffAlpha fades to zero by end of life and is bounded', () => {
  const start = puffAlpha(0, 0.7);
  assert.ok(start > 0 && start <= 1);
  assert.equal(puffAlpha(PUFF_LIFE_MS, 0.7), 0);
  assert.ok(puffAlpha(PUFF_LIFE_MS * 0.5, 0.7) < start);
});

test('RippleFX.landingPuff spawns PUFF_COUNT motes carrying the given color, which drain over time', () => {
  const fx = new RippleFX();
  fx.landingPuff(200, 540, 0.5, '#abc123');
  assert.equal(fx.puffs.active.length, PUFF_COUNT);
  for (const p of fx.puffs.active) assert.equal(p.color, '#abc123');
  for (let i = 0; i < 30; i++) fx.update(50); // 1.5s, well past PUFF_LIFE_MS
  assert.equal(fx.puffs.active.length, 0);
});
