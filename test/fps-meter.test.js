import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emaFps, resolveFpsHudVisible } from '../src/render/FpsMeter.js';

test('emaFps: first sample seeds the EMA exactly (no lag-in from a null baseline)', () => {
  assert.ok(Math.abs(emaFps(null, 16.6667) - 60) < 0.01);
  assert.ok(Math.abs(emaFps(undefined, 8.3333) - 120) < 0.01);
});

test('emaFps: converges toward a steady frame rate over repeated samples', () => {
  let fps = null;
  for (let i = 0; i < 60; i++) fps = emaFps(fps, 1000 / 30); // a steady 30fps stream
  assert.ok(Math.abs(fps - 30) < 0.5, `expected convergence to ~30fps, got ${fps}`);
});

test('emaFps: a single stutter frame nudges but does not snap the reading', () => {
  let fps = 60;
  const after = emaFps(fps, 1000 / 10); // one 10fps frame amid a 60fps stream
  assert.ok(after < 60 && after > 10, `one bad frame should pull the EMA down without collapsing it, got ${after}`);
});

test('emaFps: ignores non-positive deltas (paused/backgrounded tab) instead of spiking', () => {
  assert.equal(emaFps(45, 0), 45);
  assert.equal(emaFps(45, -5), 45);
});

test('resolveFpsHudVisible: true whenever ?fps is present, regardless of value', () => {
  assert.equal(resolveFpsHudVisible('?fps'), true);
  assert.equal(resolveFpsHudVisible('?fps=1'), true);
  assert.equal(resolveFpsHudVisible('?renderer=webgl&fps'), true);
  assert.equal(resolveFpsHudVisible('fps'), true, 'works without a leading ?');
});

test('resolveFpsHudVisible: false when absent or on a malformed search string', () => {
  assert.equal(resolveFpsHudVisible(''), false);
  assert.equal(resolveFpsHudVisible('?renderer=webgl'), false);
  assert.equal(resolveFpsHudVisible(undefined), false);
});

test('delivered FPS counts successful presentations separately from 144 Hz callbacks', async () => {
  const { PresentedFpsMeter } = await import('../src/render/FpsMeter.js');
  const { FrameCadence } = await import('../src/render/FrameCadence.js');
  const meter = new PresentedFpsMeter(), cadence = new FrameCadence();
  let callbackFps = null;
  for (let i = 0; i <= 1440; i++) {
    const now = i * 1000 / 144;
    callbackFps = emaFps(callbackFps, 1000 / 144);
    meter.sample(now, cadence.shouldDraw(now, 60));
  }
  assert.ok(Math.abs(meter.fps - 60) <= 1, `delivered ${meter.fps}`);
  assert.ok(Math.abs(callbackFps - 144) < .01);
  for (let i = 1; i <= 150; i++) meter.sample(10000 + i * 1000 / 144, false);
  assert.equal(meter.fps, 0, 'failed presentations are not delivered frames');
  meter.reset();
  meter.sample(15000, true);
  assert.equal(meter.fps, 0, 'a resume does not count the gap as delivered time');
});
