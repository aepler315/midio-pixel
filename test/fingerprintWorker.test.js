import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NativeWorker } from 'node:worker_threads';
import { fingerprintBufferOffThread } from '../src/audio/FingerprintWorkerClient.js';
import { fingerprintBuffer, fingerprintSignals } from '../src/audio/SongFingerprint.js';

function recording(rate = 44100, seconds = 1) {
  const channels = [0, 1].map(c => Float32Array.from({ length: rate * seconds }, (_, i) =>
    Math.sin(i * (0.08 + c * 0.01)) * (0.3 + 0.2 * Math.sin(i / 800))));
  return { sampleRate: rate, length: channels[0].length, duration: seconds,
    numberOfChannels: channels.length, getChannelData: c => channels[c] };
}

async function fixture(run, behavior = () => {}) {
  const original = globalThis.Worker;
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, deadlines = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const timer = set(fn, ms, ...args);
    if (ms === 120000) deadlines.add(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { deadlines.delete(timer); clear(timer); };
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.terminations = 0; workers.push(this); }
    postMessage(data) { behavior(this, data); }
    terminate() { this.terminations++; }
  };
  try { await run(workers); assert.equal(deadlines.size, 0, 'deadline timer released'); }
  finally {
    // Release the old implementation's unbounded promise during RED runs.
    for (const worker of workers) worker.onmessage?.({ data: { ok: false } });
    globalThis.Worker = original;
    for (const timer of deadlines) clear(timer);
    globalThis.setTimeout = set; globalThis.clearTimeout = clear;
  }
}

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('did not settle within test bound')), 1000);
  })]); } finally { clearTimeout(timer); }
}

function cleaned(worker) {
  assert.equal(worker.terminations, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
}

test('fingerprint abort before preparation reads no samples and creates no worker', async () => {
  await fixture(async workers => {
    const controller = new AbortController(); controller.abort();
    const buffer = { getChannelData() { assert.fail('read after cancellation'); } };
    await assert.rejects(bounded(fingerprintBufferOffThread(buffer, { signal: controller.signal })), { name: 'AbortError' });
    assert.equal(workers.length, 0);
  });
});

test('fingerprint cancellation during resampling creates no worker', async () => {
  await fixture(async workers => {
    const controller = new AbortController();
    const task = fingerprintBufferOffThread(recording(44100, 8), { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(bounded(task), { name: 'AbortError' });
    assert.equal(workers.length, 0);
  });
});

test('fingerprint successful worker preserves every frame and cache identity and cleans once', async () => {
  const buffer = recording();
  const expected = fingerprintBuffer(buffer);
  await fixture(async workers => {
    const actual = await bounded(fingerprintBufferOffThread(buffer));
    assert.deepEqual(actual, expected);
    cleaned(workers[0]);
  }, (worker, { signals }) => {
    const lateReply = () => worker.onmessage?.({ data: { ok: true, ...fingerprintSignals(signals) } });
    queueMicrotask(lateReply); setTimeout(lateReply, 0);
  });
});

for (const failure of ['error', 'messageerror', 'postMessage', 'negative reply']) {
  test(`fingerprint ${failure} rejects as cache miss and cleans exactly once`, async () => {
    await fixture(async workers => {
      await assert.rejects(bounded(fingerprintBufferOffThread(recording())), error => error.name !== 'AbortError');
      cleaned(workers[0]);
    }, worker => {
      if (failure === 'postMessage') throw new Error('injected post failure');
      queueMicrotask(() => {
        if (failure === 'negative reply') worker.onmessage?.({ data: { ok: false } });
        else worker[`on${failure}`]?.({ preventDefault() {} });
      });
    });
  });
}

test('silent fingerprint worker expires and leaves no worker or signal listener', async () => {
  await fixture(async workers => {
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { listeners++; add(...args); };
    controller.signal.removeEventListener = (...args) => { listeners--; remove(...args); };
    await assert.rejects(bounded(fingerprintBufferOffThread(recording(), {
      signal: controller.signal, deadlineMs: 25,
    })), { name: 'TimeoutError' });
    cleaned(workers[0]); assert.equal(listeners, 0);
    controller.abort(); cleaned(workers[0]);
  });
});

test('aborting active fingerprint worker cleans once and ignores late results', async () => {
  const controller = new AbortController();
  await fixture(async workers => {
    await assert.rejects(bounded(fingerprintBufferOffThread(recording(), { signal: controller.signal })), { name: 'AbortError' });
    cleaned(workers[0]);
  }, worker => {
    const late = worker.onmessage;
    controller.abort();
    late?.({ data: { ok: false } });
  });
});

for (const unavailable of ['missing', 'constructor throws']) {
  test(`fingerprint ${unavailable} fallback is identical and abortable`, async () => {
    const original = globalThis.Worker;
    globalThis.Worker = unavailable === 'missing' ? undefined : class { constructor() { throw new Error('unsupported'); } };
    try {
      const buffer = recording();
      assert.deepEqual(await bounded(fingerprintBufferOffThread(buffer)), fingerprintBuffer(buffer));
      const controller = new AbortController();
      const task = fingerprintBufferOffThread(recording(8000, 8), { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      await assert.rejects(bounded(task), { name: 'AbortError' });
    } finally { globalThis.Worker = original; }
  });
}

test('fingerprint deadline also bounds cooperative preparation before worker creation', async () => {
  await fixture(async workers => {
    await assert.rejects(bounded(fingerprintBufferOffThread(recording(44100, 8), { deadlineMs: 1 })), { name: 'TimeoutError' });
    assert.equal(workers.length, 0);
  });
});

// Unlike the lifecycle mocks above, this bridge performs the native transfer
// list. A successful fingerprint must not consume the decoded input channels.
for (const mode of ['success', 'error after transfer', 'abort after transfer']) {
  test(`already-8k fingerprint preserves input ownership on native ${mode}`, async () => {
    const original = globalThis.Worker, workers = [], terminations = [];
    const controller = new AbortController();
    const buffer = recording(8000), channels = [0, 1].map(c => buffer.getChannelData(c));
    const expected = fingerprintBuffer(buffer);
    const before = channels.map(c => ({ length: c.length, byteLength: c.byteLength, value: c[123] }));
    const bridge = `
      const { parentPort, workerData } = require('node:worker_threads');
      globalThis.self = { postMessage(data, transfer) { parentPort.postMessage(data, transfer); } };
      import(workerData.module).then(() => parentPort.on('message', data => self.onmessage({ data })));
    `;
    globalThis.Worker = class {
      constructor(module) {
        this.native = new NativeWorker(bridge, { eval: true, workerData: { module: module.href } });
        this.native.on('message', data => this.onmessage?.({ data }));
        this.native.on('error', error => this.onerror?.(error));
        this.terminations = 0;
        workers.push(this);
      }
      postMessage(data, transfer) {
        this.aliases = data.signals.map((signal, i) => signal.buffer === channels[i].buffer);
        this.native.postMessage(data, transfer);
        if (mode === 'error after transfer') queueMicrotask(() => this.onerror?.({ preventDefault() {} }));
        if (mode === 'abort after transfer') controller.abort();
      }
      terminate() { this.terminations++; terminations.push(this.native.terminate()); }
    };
    try {
      const pending = fingerprintBufferOffThread(buffer, { signal: controller.signal, deadlineMs: 5000 });
      if (mode === 'success') assert.deepEqual(await pending, expected);
      else await assert.rejects(pending, error => mode.startsWith('abort') ? error.name === 'AbortError' : error.name !== 'AbortError');
      assert.equal(workers.length, 1);
      cleaned(workers[0]);
      channels.forEach((channel, i) => {
        assert.equal(channel.length, before[i].length, 'input sample count survives worker transfer');
        assert.equal(channel.byteLength, before[i].byteLength, 'input buffer survives worker transfer');
        assert.equal(channel[123], before[i].value, 'input samples remain readable');
      });
      assert.deepEqual(workers[0].aliases, [false, false], 'only privately owned signal buffers transfer');
    } finally {
      globalThis.Worker = original;
      await Promise.all(terminations);
    }
  });
}

test('already-8k private signal preparation can abort before worker construction', async () => {
  await fixture(async workers => {
    const controller = new AbortController();
    const pending = fingerprintBufferOffThread(recording(8000, 8), { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(bounded(pending), { name: 'AbortError' });
    assert.equal(workers.length, 0);
  });
});

test('already-8k private signal copy is covered by the preparation deadline', async () => {
  await fixture(async workers => {
    const buffer = recording(8000, 8);
    const before = [0, 1].map(c => buffer.getChannelData(c).byteLength);
    await assert.rejects(bounded(fingerprintBufferOffThread(buffer, { deadlineMs: 1 })), { name: 'TimeoutError' });
    assert.equal(workers.length, 0);
    assert.deepEqual([0, 1].map(c => buffer.getChannelData(c).byteLength), before);
  });
});
