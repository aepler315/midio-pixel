import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceFixedStepClock } from '../src/core/FixedStepClock.js';

const STEP_MS = 1000 / 120;

test('fixed-step clock uses ordinary deterministic steps for short gaps', () => {
  const calls = [];
  const result = advanceFixedStepClock({
    nowMs: STEP_MS * 3 + 1,
    lastNowMs: 0,
    simTime: 0,
    accumulatorMs: 0,
    stepMs: STEP_MS,
    step: (dtMs, atMs) => calls.push({ dtMs, atMs }),
  });
  assert.equal(result.resynced, false);
  assert.equal(calls.length, 3);
  assert.equal(result.simTime, STEP_MS * 3);
  assert.ok(result.accumulatorMs < STEP_MS);
});

test('long frame gaps resync simulation time to the audio clock', () => {
  const calls = [];
  const result = advanceFixedStepClock({
    nowMs: 6_000,
    lastNowMs: 1_000,
    simTime: 1_000,
    accumulatorMs: 0,
    stepMs: STEP_MS,
    step: (dtMs, atMs) => calls.push({ dtMs, atMs }),
  });
  assert.deepEqual(calls, [{ dtMs: 250, atMs: 6_000 }]);
  assert.deepEqual(result, {
    lastNowMs: 6_000,
    simTime: 6_000,
    accumulatorMs: 0,
    resynced: true,
  });
});
