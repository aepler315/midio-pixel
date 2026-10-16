import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureClock } from '../src/core/CaptureClock.js';

test('mid-song capture pays lead debt without rewinding event time', () => {
  const clock = new CaptureClock({ liveLeadMs: 52 });
  assert.equal(clock.renderNow(1000), 1052);
  clock.arm(1000);
  const samples = [1010, 1020, 1030, 1040, 1050, 1060].map((now) => clock.renderNow(now));
  assert.deepEqual(samples, [1052, 1052, 1052, 1052, 1052, 1060]);
  assert.equal(clock.captureReady, true);
  assert.ok(samples.every((value, i) => i === 0 || value >= samples[i - 1]));
});

test('full-song capture starts at the source-audio clock with zero lead', () => {
  const clock = new CaptureClock({ liveLeadMs: 52 });
  clock.beginFullCapture(0);
  assert.equal(clock.renderNow(0), 0);
  assert.equal(clock.captureReady, true);
  assert.equal(clock.leadMs, 0);
});

test('returning live restores presentation lead without duplicate time', () => {
  const clock = new CaptureClock({ liveLeadMs: 52 });
  clock.beginFullCapture(1000);
  assert.equal(clock.renderNow(1000), 1000);
  clock.release(1000);
  const samples = [1010, 1020, 1030, 1040, 1050, 1060].map((now) => clock.renderNow(now));
  assert.ok(samples.every((value, i) => i === 0 || value > samples[i - 1]));
  assert.equal(clock.leadMs, 52);
  assert.equal(samples.at(-1), 1112);
});
