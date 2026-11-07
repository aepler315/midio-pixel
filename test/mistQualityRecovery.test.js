import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfGovernor } from '../src/render/PerfGovernor.js';
import { rangeQuality } from '../src/world/alpine/RangeQuality.js';
import { easeMistSteps } from '../src/world/alpine/RangeAtmosphere.js';

test('mist recovery reaches affordable detail without a temporary dual-bank workload rejecting the probe', () => {
  const governor = new PerfGovernor({ startLevel: 3 });
  const periodMs = 1000 / 60;
  let steps = rangeQuality(3).mistSteps, nowMs = 0;
  // Synthetic fog-bound GPU: both 4 and 6 samples fit 60 FPS. CPU
  // submission is cheap, but dual-bank interpolation would miss vsync.
  // These costs test the controller/transition interaction, not device FPS.
  while (nowMs < 14000) {
    const n = Math.floor(steps);
    const bankSamples = n + (steps - n > 1e-3 ? Math.ceil(steps) : 0);
    const callbackMs = Math.ceil(bankSamples * 2.2 / periodMs) * periodMs;
    nowMs += callbackMs;
    governor.sample(callbackMs, nowMs, { workMs: 2 });
    steps = easeMistSteps(steps, rangeQuality(governor.level).mistSteps, callbackMs / 1000);
  }
  assert.equal(governor.level, 2, 'the affordable next rung should remain active');
  assert.equal(governor.diagnostics.probeLevel, null, 'its probe should finish successfully');
  assert.equal(governor.recoverWindowMsFor(2), 10000, 'no false failure/backoff from transition overhead');
});
