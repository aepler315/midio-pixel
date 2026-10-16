import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quakePhaseEnvelope, quakeEnvelope01, quakeActive, quakeDistanceFalloff,
  QuakeDirector, QUAKE_TOTAL_SEC, QUAKE_P_DELAY_SEC, QUAKE_S_DELAY_SEC, QUAKE_SURFACE_DELAY_SEC,
} from '../src/sim/QuakeDirector.js';

test('a single phase envelope is 0 outside its own window and positive inside', () => {
  assert.equal(quakePhaseEnvelope(-0.1, 1, 2), 0);
  assert.equal(quakePhaseEnvelope(3.1, 1, 2), 0);
  assert.ok(quakePhaseEnvelope(1.5, 1, 2) > 0);
});

test('the combined envelope is 0 before the strike and after the quake ends', () => {
  assert.equal(quakeEnvelope01(-1), 0);
  assert.equal(quakeEnvelope01(QUAKE_TOTAL_SEC + 5), 0);
  assert.ok(!quakeActive(-1));
  assert.ok(!quakeActive(QUAKE_TOTAL_SEC + 0.01));
  assert.ok(quakeActive(QUAKE_TOTAL_SEC * 0.5));
});

test('the three phases arrive in P -> S -> surface order and each is felt', () => {
  assert.ok(QUAKE_P_DELAY_SEC < QUAKE_S_DELAY_SEC);
  assert.ok(QUAKE_S_DELAY_SEC < QUAKE_SURFACE_DELAY_SEC);
  // Sample well inside each phase's own attack window and confirm it registers.
  assert.ok(quakeEnvelope01(QUAKE_P_DELAY_SEC + 0.3) > 0, 'P-wave should register');
  assert.ok(quakeEnvelope01(QUAKE_S_DELAY_SEC + 0.4) > 0, 'S-wave should register');
  assert.ok(quakeEnvelope01(QUAKE_SURFACE_DELAY_SEC + 1) > 0, 'surface wave should register');
});

test('the surface wave reads as the strongest phase -- real quakes peak late, not at the first tremor', () => {
  const pPeak = Math.max(...Array.from({ length: 20 }, (_, i) => quakeEnvelope01(QUAKE_P_DELAY_SEC + i * 0.04)));
  const surfPeak = Math.max(...Array.from({ length: 40 }, (_, i) => quakeEnvelope01(QUAKE_SURFACE_DELAY_SEC + i * 0.1)));
  assert.ok(surfPeak > pPeak, `surface peak (${surfPeak}) should exceed the P-wave's own peak (${pPeak})`);
});

test('the envelope never exceeds 1 even where phases overlap', () => {
  for (let t = 0; t <= QUAKE_TOTAL_SEC; t += 0.05) {
    assert.ok(quakeEnvelope01(t) <= 1.0001, `envelope exceeded 1 at t=${t}`);
  }
});

test('distance falloff is 1 at the epicenter and monotonically decreases with distance', () => {
  assert.equal(quakeDistanceFalloff(0), 1);
  const near = quakeDistanceFalloff(200);
  const far = quakeDistanceFalloff(4000);
  assert.ok(near > far);
  assert.ok(far > 0, 'never fully zero -- a distant tremor still registers faintly');
});

test('QuakeDirector: dormant until struck, and idle costs nothing', () => {
  const q = new QuakeDirector(1);
  assert.equal(q.active, false);
  q.update(1000, 0.016, null);
  assert.equal(q.active, false);
  assert.equal(q.intensity01, 0);
  assert.equal(q.groundOffsetAt(500), 0);
});

test('QuakeDirector: a strike goes active immediately and eventually settles', () => {
  const q = new QuakeDirector(2);
  q.strike(1000, 0);
  q.update(1000, 0.016, null);
  assert.equal(q.active, true);
  assert.ok(q.intensity01 >= 0);
  // Step far past the end.
  let t = 1000;
  for (let i = 0; i < 2000; i++) { t += 16; q.update(t, 0.016, null); }
  assert.equal(q.active, false);
  assert.equal(q.intensity01, 0);
});

test('QuakeDirector: dust rises while shaking and settles afterward', () => {
  const q = new QuakeDirector(3);
  q.strike(0, 0);
  let t = 0;
  let peakDust = 0;
  for (let i = 0; i < 400; i++) {
    t += 16;
    q.update(t, 0.016, null);
    peakDust = Math.max(peakDust, q.dustLevel01);
  }
  assert.ok(peakDust > 0.1, `expected measurable dust buildup, got ${peakDust}`);
  const dustAtEnd = q.dustLevel01;
  for (let i = 0; i < 400; i++) { t += 16; q.update(t, 0.016, null); }
  assert.ok(q.dustLevel01 < dustAtEnd, 'dust should settle once the shaking stops');
});

test('QuakeDirector: camera.shake is invoked while intensity is meaningful, not called when dormant', () => {
  const q = new QuakeDirector(4);
  let shakeCalls = 0;
  const camera = { shake: () => { shakeCalls++; } };
  q.update(0, 0.016, camera);
  assert.equal(shakeCalls, 0, 'no strike yet -- camera should be untouched');
  q.strike(1000, 0);
  let t = 1000;
  for (let i = 0; i < 10; i++) { t += 16; q.update(t, 0.016, camera); }
  assert.ok(shakeCalls > 0);
});

test('QuakeDirector: ground offset falls off with distance from the epicenter', () => {
  const q = new QuakeDirector(5);
  q.strike(0, 1000);
  q.update(0, 0.016, null);
  const near = Math.abs(q.groundOffsetAt(1050));
  const far = Math.abs(q.groundOffsetAt(5000));
  // Jitter direction is randomized per-frame, but magnitude must still fall off.
  assert.ok(near >= far, `nearby offset (${near}) should be >= a distant one (${far})`);
});
