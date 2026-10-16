import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spread01 } from '../src/utils/math.js';

test('spread01 is a no-op at the ends and center of the range', () => {
  assert.equal(spread01(0), 0);
  assert.equal(spread01(1), 1);
  assert.equal(spread01(0.5), 0.5);
});

test('spread01 is monotone non-decreasing (never reorders two values)', () => {
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const y = spread01(x);
    assert.ok(y >= prev - 1e-9, `not monotone at x=${x.toFixed(2)}`);
    prev = y;
  }
});

test('spread01 pushes values away from 0.5 toward their nearer edge', () => {
  // Anything below center moves further below; anything above moves further above.
  for (const x of [0.1, 0.2, 0.3, 0.4]) {
    assert.ok(spread01(x) < x, `${x} should move down, got ${spread01(x)}`);
  }
  for (const x of [0.6, 0.7, 0.8, 0.9]) {
    assert.ok(spread01(x) > x, `${x} should move up, got ${spread01(x)}`);
  }
});

test('spread01 clamps out-of-range input instead of producing NaN/out-of-bounds output', () => {
  assert.equal(spread01(-0.4), 0);
  assert.equal(spread01(1.7), 1);
  assert.equal(spread01(NaN), 0);
});

test('spread01 measurably improves edge-band reachability for a central-limit-collapsed distribution', () => {
  // Same shape as WorldScore's real `drive`/`computeTemperature` formulas:
  // a weighted sum of several independent-ish 0..1 features, which by the
  // central limit theorem collapses toward 0.5 far more than a genuinely
  // uniform 0..1 value would.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(31337);
  const N = 20000;
  let rawInEdge = 0, spreadInEdge = 0;
  const EDGE_LO = 0.02, EDGE_HI = 0.30; // matches WorldScore's 'farside' comfort band
  for (let i = 0; i < N; i++) {
    const raw = Math.min(1, 0.28 * rand() + 0.18 * rand() + 0.16 * rand() + 0.14 * rand() + 0.24 * rand());
    if (raw >= EDGE_LO && raw <= EDGE_HI) rawInEdge++;
    const spread = spread01(raw);
    if (spread >= EDGE_LO && spread <= EDGE_HI) spreadInEdge++;
  }
  const rawFrac = rawInEdge / N, spreadFrac = spreadInEdge / N;
  assert.ok(rawFrac < 0.10, `sanity: raw distribution should already under-cover this edge band, got ${rawFrac}`);
  assert.ok(spreadFrac > rawFrac * 2, `spread01 should at least double edge-band coverage: raw ${rawFrac.toFixed(3)} -> spread ${spreadFrac.toFixed(3)}`);
});
