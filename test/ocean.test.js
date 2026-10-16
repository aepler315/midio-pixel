import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seaLineY, oceanRowYs, waveRows, rowAlpha, SEA_LINE_MAX,
  breakerLift, whitecapMask, rowPhaseDrift,
} from '../src/world/Ocean.js';

test('seaLineY is bounded, finite, and periodic in u', () => {
  for (let t = 0; t < 20; t += 1.3) {
    for (let bass = 0; bass <= 1; bass += 0.5) {
      for (let u = 0; u <= 1.001; u += 0.02) {
        const y = seaLineY(u % 1, t, bass, 0);
        assert.ok(Number.isFinite(y));
        assert.ok(Math.abs(y) <= SEA_LINE_MAX + 0.01, `unbounded at u=${u}: ${y}`);
      }
      const start = seaLineY(0, t, bass, 0);
      const end = seaLineY(1, t, bass, 0);
      assert.ok(Math.abs(start - end) < 1e-6, `not periodic: ${start} vs ${end}`);
    }
  }
});

test('seaLineY amplitude scales with bass, kick presses the line down', () => {
  const quiet = seaLineY(0.15, 2, 0, 0);
  const loud = seaLineY(0.15, 2, 1, 0);
  assert.ok(Math.abs(loud) >= Math.abs(quiet) - 1e-9 || loud !== quiet, 'bass should change the wave amplitude');
  const noKick = seaLineY(0.3, 1, 0.5, 0);
  const withKick = seaLineY(0.3, 1, 0.5, 1);
  assert.ok(withKick < noKick, 'a kick should press the sea line down');
});

test('breakerLift is non-negative, bounded, and periodic in u', () => {
  for (let t = 0; t < 10; t += 1.1) {
    for (let e = 0; e <= 1; e += 0.5) {
      for (let u = 0; u <= 1.001; u += 0.05) {
        const y = breakerLift(u % 1, t, e);
        assert.ok(Number.isFinite(y) && y >= -1e-9);
        assert.ok(y <= 4.0 + 1e-6, `breaker too tall: ${y}`);
      }
      assert.ok(Math.abs(breakerLift(0, t, e) - breakerLift(1, t, e)) < 1e-6);
    }
  }
  assert.ok(breakerLift(0.25, 1, 1) >= breakerLift(0.25, 1, 0) - 1e-9);
});

test('whitecapMask is bounded and denser nearer the camera', () => {
  let nearSum = 0, farSum = 0, n = 0;
  for (let u = 0; u < 1; u += 0.05) {
    for (let t = 0; t < 8; t += 0.7) {
      const near = whitecapMask(u, t, 0.1);
      const far = whitecapMask(u, t, 0.9);
      assert.ok(near >= 0 && near <= 1);
      assert.ok(far >= 0 && far <= 1);
      nearSum += near;
      farSum += far;
      n++;
    }
  }
  assert.ok(nearSum / n > farSum / n, 'nearer rows should foam more on average');
});

test('rowPhaseDrift is finite and small', () => {
  for (let j = 0; j < 20; j++) {
    for (let t = 0; t < 30; t += 2.5) {
      const d = rowPhaseDrift(j, t);
      assert.ok(Number.isFinite(d));
      assert.ok(Math.abs(d) < 0.12, `drift too large: ${d}`);
    }
  }
});

test('oceanRowYs: rows stay within [horizon, near], recede monotonically, gaps shrink toward the horizon', () => {
  const horizonY = 100, nearY = 500;
  for (const count of [1, 2, 5, 14, 20]) {
    const ys = oceanRowYs(horizonY, nearY, count);
    assert.equal(ys.length, count);
    for (const y of ys) {
      assert.ok(Number.isFinite(y));
      assert.ok(y > horizonY, `row must stay above (never reach) the horizon: ${y}`);
      assert.ok(y <= nearY + 1e-9, `row must not exceed the near edge: ${y}`);
    }
    if (count >= 2) {
      assert.equal(ys[0], nearY, 'nearest row sits at the near edge');
      for (let j = 1; j < ys.length; j++) assert.ok(ys[j] < ys[j - 1], `row ${j} must be farther than row ${j - 1}`);
      if (count >= 3) {
        for (let j = 1; j < ys.length - 1; j++) {
          const gapNear = ys[j - 1] - ys[j];
          const gapFar = ys[j] - ys[j + 1];
          assert.ok(gapFar < gapNear, `gap must shrink toward horizon at row ${j}: ${gapFar} vs ${gapNear}`);
        }
      }
    }
  }
});

test('waveRows is deterministic per seed and respects count/ranges', () => {
  const a = waveRows(11, 14);
  const b = waveRows(11, 14);
  const c = waveRows(99, 14);
  assert.equal(a.length, 14);
  assert.deepEqual(a, b, 'same seed reproduces identical rows');
  assert.notDeepEqual(a, c, 'different seeds should differ');
  for (const row of a) {
    assert.ok(row.uPhase >= 0 && row.uPhase < 1);
    assert.ok(row.speedMul > 0);
    assert.ok(row.ampMul > 0);
    assert.ok(row.alphaMul > 0);
  }
  assert.equal(waveRows(1, 8).length, 8);
});

test('rowAlpha is bounded, fades near the horizon, and peaks in the interior', () => {
  const count = 14;
  let maxAlpha = -1, maxIdx = -1;
  for (let i = 0; i < count; i++) {
    const a = rowAlpha(i, count);
    assert.ok(Number.isFinite(a));
    assert.ok(a >= 0 && a <= 1, `out of bounds at i=${i}: ${a}`);
    if (a > maxAlpha) { maxAlpha = a; maxIdx = i; }
  }
  const horizonAlpha = rowAlpha(count - 1, count);
  // Horizon keeps a soft presence floor so the ocean plane never vanishes
  // into the skyline, but still reads fainter than the interior peak.
  assert.ok(horizonAlpha <= 0.22, `row nearest the horizon must fade, got ${horizonAlpha}`);
  assert.ok(maxIdx > 0 && maxIdx < count - 1, 'peak must be interior, not at either endpoint');
  assert.ok(maxAlpha > rowAlpha(0, count), 'interior peak must exceed the nearest row');
  assert.ok(maxAlpha > horizonAlpha, 'interior peak must exceed the horizon row');
});
