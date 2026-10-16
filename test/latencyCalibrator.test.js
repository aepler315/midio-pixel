import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LatencyCalibrator, computeCalibrationOffset, median,
  CAL_WINDOW, MAX_OFFSET_MS,
} from '../src/sim/LatencyCalibrator.js';

function feed(cal, offsets) {
  for (const o of offsets) cal.onJudgedHit(o);
}

test('a steady 30ms-late player gets most of the bias cancelled', () => {
  const cal = new LatencyCalibrator(0);
  feed(cal, Array.from({ length: CAL_WINDOW }, (_, i) => 30 + (i % 3) - 1)); // 29..31
  assert.ok(cal.lastAdjustment, 'must adjust on a steady biased window');
  assert.ok(cal.offsetMs < -15 && cal.offsetMs > -30, `expected ~-21, got ${cal.offsetMs}`);
});

test('convergence: the closed loop walks the residual toward zero', () => {
  const trueLatency = 40; // player intends on-time; pipeline adds 40ms
  const cal = new LatencyCalibrator(0);
  for (let round = 0; round < 5; round++) {
    // Judged offset = intended (0) + latency + applied offset.
    feed(cal, Array.from({ length: CAL_WINDOW }, () => trueLatency + cal.offsetMs));
  }
  const residual = trueLatency + cal.offsetMs;
  assert.ok(Math.abs(residual) < 12, `should converge under the deadband, residual=${residual}`);
});

test('jittery windows never move the offset (that is the player, not the pipeline)', () => {
  const cal = new LatencyCalibrator(0);
  feed(cal, [80, -70, 60, -80, 75, -65, 70, -75, 66, -72]);
  assert.equal(cal.offsetMs, 0);
  assert.equal(cal.lastAdjustment, null);
});

test('small bias inside the deadband is left alone', () => {
  const cal = new LatencyCalibrator(0);
  feed(cal, Array.from({ length: CAL_WINDOW }, () => 8));
  assert.equal(cal.offsetMs, 0);
});

test('the total correction is railed', () => {
  const cal = new LatencyCalibrator(0);
  for (let i = 0; i < 30; i++) feed(cal, Array.from({ length: CAL_WINDOW }, () => 300));
  assert.ok(Math.abs(cal.offsetMs) <= MAX_OFFSET_MS);
});

test('computeCalibrationOffset negates the median and survives one wild tap', () => {
  assert.equal(computeCalibrationOffset([30, 31, 29, 30, 32, 28, 30, 400]), -30);
  assert.equal(computeCalibrationOffset([10, 12]), null, 'too few taps');
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('an early (negative-bias) player is corrected the other way', () => {
  const cal = new LatencyCalibrator(0);
  feed(cal, Array.from({ length: CAL_WINDOW }, () => -35));
  assert.ok(cal.offsetMs > 15, `expected a positive shift, got ${cal.offsetMs}`);
});
