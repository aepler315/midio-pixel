import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broshiHopHeightMul } from '../src/sim/Broshi.js';

test('broshiHopHeightMul: no observed range yet -> neutral multiplier', () => {
  assert.equal(broshiHopHeightMul(64, Infinity, -Infinity), 1);
  assert.equal(broshiHopHeightMul(NaN, 40, 80), 1);
});

test('broshiHopHeightMul: higher pitch within the observed range lifts him higher', () => {
  const low = broshiHopHeightMul(40, 40, 80);
  const mid = broshiHopHeightMul(60, 40, 80);
  const high = broshiHopHeightMul(80, 40, 80);
  assert.ok(low < mid && mid < high, `expected monotone increase: ${low}, ${mid}, ${high}`);
});

test('broshiHopHeightMul: bounded even for out-of-range pitches', () => {
  assert.ok(broshiHopHeightMul(-1000, 40, 80) >= 0.75 - 1e-9);
  assert.ok(broshiHopHeightMul(1000, 40, 80) <= 1.35 + 1e-9);
});
