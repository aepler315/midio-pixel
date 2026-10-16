import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePitchFeaturesOffThread } from '../src/audio/PitchWorkerClient.js';
import { computePitchFeatures } from '../src/audio/PitchTracker.js';

const channels = [Float32Array.from({ length: 16384 }, (_, i) => Math.sin(i / 10) * .3)];
const expected = computePitchFeatures(channels, 8000);

async function fixture(behavior, run) {
  const original = globalThis.Worker, workers = [];
  globalThis.Worker = class {
    constructor() { this.terminations = 0; workers.push(this); }
    terminate() { this.terminations++; }
    postMessage(data) { behavior(this, data); }
  };
  let timer;
  try {
    await Promise.race([run(workers), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('pitch did not settle')), 1000);
    })]);
  } finally {
    clearTimeout(timer);
    for (const worker of workers) worker.onmessage?.({ data: { ok: false } });
    globalThis.Worker = original;
  }
}

for (const failure of ['silent', 'messageerror', 'post throws', 'error']) {
  test(`pitch ${failure} releases worker and returns identical cooperative fallback`, async () => {
    await fixture(worker => {
      if (failure === 'post throws') throw new Error('post failed');
      if (failure !== 'silent') queueMicrotask(() => worker[`on${failure}`]?.({ preventDefault() {} }));
    }, async workers => {
      const result = await computePitchFeaturesOffThread(channels, 8000, { parts: 1, deadlineMs: 10 });
      assert.deepEqual(result, expected);
      assert.equal(workers[0].terminations, 1);
      assert.equal(workers[0].onmessage, null);
      assert.equal(workers[0].onerror, null);
      assert.equal(workers[0].onmessageerror, null);
    });
  });
}

test('pitch success clears its deadline and listeners, late error cannot terminate twice', async () => {
  await fixture(worker => {
    const error = worker.onerror;
    queueMicrotask(() => {
      worker.onmessage({ data: { ok: true, features: expected } });
      error({ preventDefault() {} });
    });
  }, async workers => {
    assert.deepEqual(await computePitchFeaturesOffThread(channels, 8000, { deadlineMs: 10 }), expected);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workers[0].terminations, 1);
    assert.equal(workers[0].onmessage, null);
  });
});

test('pitch cancellation terminates both silent workers without starting fallback', async () => {
  const controller = new AbortController();
  await fixture(() => {}, async workers => {
    const task = computePitchFeaturesOffThread(channels, 8000, { parts: 2, signal: controller.signal });
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(workers.length, 2);
    assert.deepEqual(workers.map(w => w.terminations), [1, 1]);
  });
});
