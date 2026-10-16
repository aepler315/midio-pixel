import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windProjection, fireExtent, fireIntensity01, fireActive,
  FIRE_DURATION_MS, FIRE_MAX_HALF_WIDTH_PX, flameFlicker, smokeDrift,
} from '../src/world/Wildfire.js';

test('windProjection maps angle to a -1..1 x-lean, +x and -x at the extremes', () => {
  assert.ok(Math.abs(windProjection(0) - 1) < 1e-9);
  assert.ok(Math.abs(windProjection(Math.PI) - -1) < 1e-9);
  assert.ok(Math.abs(windProjection(Math.PI / 2)) < 1e-9);
});

test('fireExtent grows outward from zero at age 0', () => {
  const e = fireExtent(0, 1);
  assert.equal(e.x0, -0);
  assert.equal(e.x1, 0);
});

test('fireExtent spreads asymmetrically: much faster in the wind-leaned direction', () => {
  const e = fireExtent(10000, 1); // full downwind lean (+x)
  const downwind = e.x1;
  const upwind = -e.x0;
  assert.ok(downwind > upwind * 3, `downwind (${downwind}) should heavily outrun upwind (${upwind})`);
});

test('fireExtent flips direction with the wind lean sign', () => {
  const pos = fireExtent(10000, 1);
  const neg = fireExtent(10000, -1);
  assert.ok(pos.x1 > 0 && pos.x1 > -pos.x0, 'positive lean should spread further in +x');
  assert.ok(-neg.x0 > 0 && -neg.x0 > neg.x1, 'negative lean should spread further in -x');
});

test('fireExtent is capped at FIRE_MAX_HALF_WIDTH_PX in either direction, even after a very long time', () => {
  const e = fireExtent(10_000_000, 1);
  assert.ok(e.x1 <= FIRE_MAX_HALF_WIDTH_PX + 1e-6);
  assert.ok(-e.x0 <= FIRE_MAX_HALF_WIDTH_PX + 1e-6);
});

test('fireIntensity01 ramps up, holds at 1, then dies down to 0 by FIRE_DURATION_MS', () => {
  assert.equal(fireIntensity01(-1), 0);
  assert.ok(fireIntensity01(1000) > 0 && fireIntensity01(1000) < 1, 'should be mid-ramp early on');
  assert.equal(fireIntensity01(FIRE_DURATION_MS * 0.5), 1, 'should be at full hold mid-life');
  assert.equal(fireIntensity01(FIRE_DURATION_MS), 0, 'should have fully died down by the end');
  assert.equal(fireIntensity01(FIRE_DURATION_MS + 1), 0);
});

test('fireIntensity01 never exceeds 1 or drops below 0 across the whole lifetime', () => {
  for (let t = 0; t <= FIRE_DURATION_MS; t += 137) {
    const v = fireIntensity01(t);
    assert.ok(v >= 0 && v <= 1, `intensity out of range at t=${t}: ${v}`);
  }
});

test('fireActive matches the closed interval [0, FIRE_DURATION_MS]', () => {
  assert.equal(fireActive(-1), false);
  assert.equal(fireActive(0), true);
  assert.equal(fireActive(FIRE_DURATION_MS), true);
  assert.equal(fireActive(FIRE_DURATION_MS + 1), false);
});

test('flameFlicker stays in a bounded, deterministic range', () => {
  for (let x = 0; x < 2000; x += 173) {
    const v = flameFlicker(x, 12.3);
    assert.ok(v >= 0.35 && v <= 1.05, `flicker out of expected range at x=${x}: ${v}`);
  }
  assert.equal(flameFlicker(100, 5), flameFlicker(100, 5), 'must be a pure function of (worldX, tSec)');
});

test('smokeDrift grows with height fraction and is deterministic', () => {
  assert.equal(smokeDrift(0, 3, 0), 0, 'no sway/lean at the base');
  const base = smokeDrift(1, 3, 0);
  assert.equal(smokeDrift(1, 3, 0), base);
  const leaned = smokeDrift(1, 3, 40);
  assert.ok(leaned > base, 'a positive wind lean should push the top of the column further');
});
