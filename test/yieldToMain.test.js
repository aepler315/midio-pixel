// Analysis loops used to yield with setTimeout(0) every few frames; browsers
// clamp a nested setTimeout(0) to >= 4ms, so pitch tracking a four-minute
// song spent seconds idle. These pin the replacement's two properties:
// yields cost nothing, and they happen by elapsed time, not iteration count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYielder, yieldToMain } from '../src/utils/yieldToMain.js';
import { computePitchFeaturesAsync } from '../src/audio/PitchTracker.js';

test('yieldToMain resolves on the next task without a timer clamp', async () => {
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) await yieldToMain();
  const perYield = (performance.now() - t0) / 200;
  // setTimeout(0) nesting would cost >= 1ms (4ms in browsers) per yield.
  assert.ok(perYield < 1, `a yield should be near-free, got ${perYield.toFixed(3)}ms`);
});

test('createYielder only yields once its time budget has passed', async () => {
  let clock = 0;
  const maybeYield = createYielder(12, () => clock);
  assert.equal(await maybeYield(), false, 'no time has passed');
  clock = 11;
  assert.equal(await maybeYield(), false, 'still inside the budget');
  clock = 12;
  assert.equal(await maybeYield(), true, 'budget spent: yield');
  assert.equal(await maybeYield(), false, 'the budget restarts after a yield');
  clock = 30;
  assert.equal(await maybeYield(), true);
});

test('pitch features are unchanged by how the loop yields', async () => {
  const rate = 22050;
  const samples = new Float32Array(rate * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
  const a = await computePitchFeaturesAsync([samples], rate);
  const b = await computePitchFeaturesAsync([samples], rate, { yieldEvery: 1 });
  assert.equal(a.frames.length, b.frames.length);
  assert.ok(a.frames.length > 10, 'a real number of frames was analysed');
  assert.deepEqual(Array.from(a.frames[5]), Array.from(b.frames[5]));
});

test('an aborted analysis still stops promptly', async () => {
  const rate = 22050;
  const samples = new Float32Array(rate * 20);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(computePitchFeaturesAsync([samples], rate, { signal: controller.signal }));
});
