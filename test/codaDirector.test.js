import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodaDirector, DESATURATE_MAX } from '../src/sim/CodaDirector.js';

const DURATION = 120000; // 2 minutes

test('unravel is 0 well before the ending arc starts, and stays 0 up to exactly durationMs-18000', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(0);
  assert.equal(coda.unravel, 0);
  assert.equal(coda.active, false);
  coda.update(DURATION - 20000);
  assert.equal(coda.unravel, 0);
  coda.update(DURATION - 18000);
  assert.equal(coda.unravel, 0);
});

test('unravel reaches (and holds at) 1 by durationMs-4000 -- the same moment the atlas detonation fires', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(DURATION - 4000);
  assert.equal(coda.unravel, 1);
  coda.update(DURATION - 1000);
  assert.equal(coda.unravel, 1, 'unravel must hold at 1 through novae/freeze/shatter, never drop back');
  coda.update(DURATION);
  assert.equal(coda.unravel, 1);
});

test('unravel is a monotonically non-decreasing curve across the full ending arc', () => {
  const coda = new CodaDirector(DURATION);
  let prev = -1;
  for (let ms = DURATION - 19000; ms <= DURATION; ms += 50) {
    coda.update(ms);
    assert.ok(coda.unravel >= prev - 1e-12, `unravel dipped at ${ms}: ${coda.unravel} < ${prev}`);
    prev = coda.unravel;
  }
});

test('active flips true early in the ramp, and the transition through the arc is smooth (no jump)', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(DURATION - 18000);
  assert.equal(coda.active, false);
  // Smoothstep grows quadratically near its start, so "active" (unravel
  // crosses a small epsilon) takes on the order of a few hundred ms into
  // the 14s ramp, not the very first millisecond -- confirm it does flip
  // well before the ramp is meaningfully underway.
  coda.update(DURATION - 17000);
  assert.equal(coda.active, true);
  // Smoothstep continuity: a 1ms step must not jump the curve far.
  const a = coda.unravel;
  coda.update(DURATION - 16999);
  assert.ok(coda.unravel - a < 0.01, 'unravel must ease in smoothly, not jump');
});

test('free-time audio (durationMs<=0) is a clean no-op: unravel stays 0 and active stays false at any nowMs', () => {
  const coda = new CodaDirector(0);
  for (const t of [0, 1000, 50000, 999999]) {
    coda.update(t);
    assert.equal(coda.unravel, 0);
    assert.equal(coda.active, false);
  }
  const coda2 = new CodaDirector(); // default durationMs
  coda2.update(100000);
  assert.equal(coda2.unravel, 0);
});

// --- Desaturation ---

test('desaturation ramps 0 -> DESATURATE_MAX in lockstep with unravel, and never exceeds the cap', () => {
  const coda = new CodaDirector(DURATION);
  coda.update(DURATION - 18000);
  assert.equal(coda.desaturation, 0);
  coda.update(DURATION - 4000);
  assert.ok(Math.abs(coda.desaturation - DESATURATE_MAX) < 1e-9);
  for (let ms = DURATION - 18000; ms <= DURATION; ms += 200) {
    coda.update(ms);
    assert.ok(coda.desaturation >= -1e-9 && coda.desaturation <= DESATURATE_MAX + 1e-9);
  }
});

// --- Parallax delamination ---

test('delaminateRatio(base, 0) is an exact no-op', () => {
  for (const base of [0.05, 0.10, 0.18, 0.30, 0.65, 1.00, 1.20]) {
    assert.equal(CodaDirector.delaminateRatio(base, 0), base);
  }
});

test('delaminateRatio spreads farther layers less than nearer ones, and never shrinks a ratio', () => {
  const far = CodaDirector.delaminateRatio(0.05, 1);   // L1-ish
  const near = CodaDirector.delaminateRatio(1.20, 1);  // L7-ish
  assert.ok(far >= 0.05, 'a layer ratio must never shrink under unravel');
  assert.ok(near > 1.20, 'the nearest layer must visibly race ahead at full unravel');
  const farSpread = (far - 0.05) / 0.05;
  const nearSpread = (near - 1.20) / 1.20;
  assert.ok(nearSpread > farSpread, `expected the near layer to spread proportionally more: far=${farSpread}, near=${nearSpread}`);
});

test('delaminateRatio is monotonically increasing in unravel for a fixed base ratio', () => {
  const base = 0.65;
  let prev = CodaDirector.delaminateRatio(base, 0);
  for (let u = 0.1; u <= 1; u += 0.1) {
    const r = CodaDirector.delaminateRatio(base, u);
    assert.ok(r >= prev, 'ratio must not decrease as unravel increases');
    prev = r;
  }
});

test('delaminateRatio stays within a sane bound (spec: up to 1 + 0.25*unravel, spread by depth)', () => {
  // The nearest real layer ratio in the stack is 1.20 (L7); even there,
  // full unravel should not multiply the ratio by more than ~1.4x.
  const r = CodaDirector.delaminateRatio(1.20, 1);
  assert.ok(r / 1.20 < 1.4, `L7 spread too aggressive: x${(r / 1.20).toFixed(3)}`);
});
