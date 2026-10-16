import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeteorShowerFX } from '../src/world/MeteorShower.js';
import { FLASH_CAP } from '../src/ui/Accessibility.js';

const CANVAS = { width: 1280, height: 720 };

test('trigger queues the requested count, staggered (not all launched at once)', () => {
  const fx = new MeteorShowerFX(1);
  fx.trigger(0, 10, 40);
  assert.equal(fx._meteors.length, 10);
  const launchTimes = fx._meteors.map((m) => m.launchInMs);
  assert.ok(launchTimes.some((t) => t > 0), 'at least some meteors must be staggered into the future');
  assert.ok(new Set(launchTimes.map((t) => Math.round(t))).size > 1, 'launch times should vary, not be identical');
});

test('update() eventually drains the whole array -- no leaked entries', () => {
  const fx = new MeteorShowerFX(2);
  fx.trigger(0, 8, 100);
  for (let i = 0; i < 200; i++) fx.update(1 / 60); // ~3.3s of simulated time, longer than any life+launch
  assert.equal(fx._meteors.length, 0);
});

test('update(0) is a safe no-op: no NaN, no state change', () => {
  const fx = new MeteorShowerFX(3);
  fx.trigger(0, 3, 200);
  const before = JSON.stringify(fx._meteors);
  fx.update(0);
  assert.equal(JSON.stringify(fx._meteors), before);
});

test('xFrac/yFrac stay within a generous bound over a meteor\'s life', () => {
  const fx = new MeteorShowerFX(4);
  fx.trigger(0, 5, 300);
  for (let i = 0; i < 120; i++) {
    fx.update(1 / 60);
    for (const m of fx._meteors) {
      assert.ok(m.xFrac > -0.5 && m.xFrac < 2.0, `xFrac out of bound: ${m.xFrac}`);
      assert.ok(m.yFrac > -0.5 && m.yFrac < 2.0, `yFrac out of bound: ${m.yFrac}`);
    }
  }
});

test('trigger() never exceeds MAX_ACTIVE_METEORS even across repeated calls', () => {
  const fx = new MeteorShowerFX(5);
  fx.trigger(0, 30, 10);
  fx.trigger(0, 30, 10);
  assert.ok(fx._meteors.length <= 40);
});

test('hue<0 is the achromatic sentinel: no arbitrary hue/jitter on a gray biome', () => {
  const fx = new MeteorShowerFX(6);
  fx.trigger(0, 6, -1);
  for (const m of fx._meteors) {
    assert.equal(m.achromatic, true);
    assert.equal(m.hueJitter, 0);
  }
  const fx2 = new MeteorShowerFX(6);
  fx2.trigger(0, 6, 210);
  assert.ok(fx2._meteors.every((m) => m.achromatic === false));
  assert.ok(new Set(fx2._meteors.map((m) => m.hueJitter)).size > 1, 'chromatic meteors should have varied jitter');
});

test('draw() with reducedFlash caps every alpha at FLASH_CAP', () => {
  const fx = new MeteorShowerFX(7);
  fx.trigger(0, 6, 40);
  for (let i = 0; i < 30; i++) fx.update(1 / 60); // let some launch and build a trail
  const alphas = [];
  const fakeCtx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
    set fillStyle(v) { const m = /,\s*([\d.]+)\)$/.exec(v); if (m) alphas.push(parseFloat(m[1])); },
    set strokeStyle(v) { const m = /,\s*([\d.]+)\)$/.exec(v); if (m) alphas.push(parseFloat(m[1])); },
    set lineWidth(_v) {}, set globalCompositeOperation(_v) {}, set lineCap(_v) {},
  };
  fx.draw(fakeCtx, CANVAS, true);
  assert.ok(alphas.length > 0, 'expected at least one styled draw call');
  for (const a of alphas) assert.ok(a <= FLASH_CAP + 1e-9, `alpha ${a} exceeds FLASH_CAP with reducedFlash`);
});

test('draw() without reducedFlash can exceed FLASH_CAP', () => {
  const fx = new MeteorShowerFX(8);
  fx.trigger(0, 6, 40);
  for (let i = 0; i < 30; i++) fx.update(1 / 60);
  const alphas = [];
  const fakeCtx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
    set fillStyle(v) { const m = /,\s*([\d.]+)\)$/.exec(v); if (m) alphas.push(parseFloat(m[1])); },
    set strokeStyle(v) { const m = /,\s*([\d.]+)\)$/.exec(v); if (m) alphas.push(parseFloat(m[1])); },
    set lineWidth(_v) {}, set globalCompositeOperation(_v) {}, set lineCap(_v) {},
  };
  fx.draw(fakeCtx, CANVAS, false);
  assert.ok(alphas.some((a) => a > FLASH_CAP), 'expected at least one alpha above FLASH_CAP without capping');
});
