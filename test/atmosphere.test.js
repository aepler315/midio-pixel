import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Atmosphere } from '../src/world/Atmosphere.js';

function mag(v) { return Math.hypot(v.x, v.y); }

test('field continuity: a small time step never produces a huge jump in the wind vector', () => {
  const a = new Atmosphere(1);
  a.update(1, 0.6); // let the energy EMA settle away from 0
  const w0 = a.at(400, 200);
  a.update(1 / 120, 0.6);
  const w1 = a.at(400, 200);
  const dW = Math.hypot(w1.x - w0.x, w1.y - w0.y);
  assert.ok(dW < 5, `expected a bounded step-to-step change, got dW=${dW}`);
});

test('field continuity: a small spatial step never produces a huge jump in the wind vector', () => {
  const a = new Atmosphere(2);
  a.update(1, 0.5);
  const w0 = a.at(500, 300);
  const w1 = a.at(501, 300);
  const dW = Math.hypot(w1.x - w0.x, w1.y - w0.y);
  assert.ok(dW < 2, `expected spatially smooth noise, got dW=${dW}`);
});

test('gust magnitude scales monotonically with the energy EMA', () => {
  const a = new Atmosphere(3);
  const mags = [];
  for (const e of [0, 0.25, 0.5, 0.75, 1]) {
    a.energyEMA = e; // set directly -- isolates the scaling law from the EMA's own dynamics
    mags.push(mag(a.at(123, 456)));
  }
  for (let i = 1; i < mags.length; i++) {
    assert.ok(mags[i] > mags[i - 1], `expected strictly increasing gust magnitude, got ${JSON.stringify(mags)}`);
  }
});

test('gust magnitude scales monotonically with the turbulence dial', () => {
  const a = new Atmosphere(4);
  a.energyEMA = 0.6;
  const at1 = (() => { a.turbulence = 1; return mag(a.at(50, 50)); })();
  const at2 = (() => { a.turbulence = 2; return mag(a.at(50, 50)); })();
  assert.ok(at2 > at1, 'doubling turbulence should scale the gust magnitude up');
  assert.ok(Math.abs(at2 / at1 - 2) < 1e-9, 'turbulence is a pure linear multiplier on the gust magnitude');
});

test('the energy EMA eases toward its target with the documented time constant, never overshoots', () => {
  const a = new Atmosphere(5);
  let prev = 0;
  for (let i = 0; i < 600; i++) {
    a.update(1 / 60, 1);
    assert.ok(a.energyEMA >= prev - 1e-9, 'the EMA must rise monotonically toward a constant target');
    assert.ok(a.energyEMA <= 1 + 1e-9, 'the EMA must never overshoot its target');
    prev = a.energyEMA;
  }
  assert.ok(a.energyEMA > 0.95, 'after 10s the EMA should have essentially reached the target');
});

test('per-seed determinism: same seed reproduces the exact same field, different seeds diverge', () => {
  const a1 = new Atmosphere(42);
  const a2 = new Atmosphere(42);
  a1.update(1, 0.7); a2.update(1, 0.7);
  assert.deepEqual(a1.at(300, 150), a2.at(300, 150));

  const a3 = new Atmosphere(99);
  a3.update(1, 0.7);
  const w1 = a1.at(300, 150), w3 = a3.at(300, 150);
  assert.ok(Math.abs(w1.x - w3.x) > 1e-6 || Math.abs(w1.y - w3.y) > 1e-6, 'different seeds should not coincide');
});

test('zero energy and zero turbulence still yields a finite, well-defined vector (never NaN)', () => {
  const a = new Atmosphere(6);
  a.turbulence = 0;
  const w = a.at(0, 0);
  assert.equal(Number.isFinite(w.x), true);
  assert.equal(Number.isFinite(w.y), true);
  assert.equal(w.x === 0 || Object.is(w.x, -0), true);
  assert.equal(w.y === 0 || Object.is(w.y, -0), true);
});
