import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as cache from '../src/audio/AnalysisCache.js';
import * as limits from '../src/audio/loadLimits.js';
import * as opening from '../src/audio/OpeningAnalysis.js';
import { createAudioSelection } from '../src/audio/AudioSelection.js';
import { normalizeSourceMetadata } from '../src/audio/SourceMetadata.js';
import * as sessionIdentity from '../src/audio/AudioSessionIdentity.js';
import { fingerprintBuffer, fingerprintSignals } from '../src/audio/SongFingerprint.js';
import { fingerprintBufferOffThread } from '../src/audio/FingerprintWorkerClient.js';
import { GrooveFingerprint } from '../src/sim/GrooveFingerprint.js';
import { ensureRidgeMusicSession, upgradeRidgeMusicSession } from '../src/world/RidgeMotionHistory.js';

// Reuse the established loading fixture, then replace its fingerprint stub
// with the real client. This executes current main.js, including the actual
// signal/catch/adoption/cache-publication call sites, rather than a model.
const fixtureSource = readFileSync(new URL('./audioLoadLifecycle.test.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const loadSource = main.slice(main.indexOf('async function resolveLyricsForAudio('), main.indexOf('\nfunction handleFile('));
const { harness } = vm.runInNewContext(fixtureSource.slice(fixtureSource.indexOf('const element ='),
  fixtureSource.indexOf('\ntest(')) + '\n({ harness })', {
  vm, assert, cache, opening, ...limits, loadSource, fingerprintBuffer, GrooveFingerprint,
  createAudioSelection, normalizeSourceMetadata, sessionIdentity,
  ensureRidgeMusicSession, upgradeRidgeMusicSession, AbortController, console,
});

async function workers(behavior, run) {
  const original = globalThis.Worker, instances = [];
  globalThis.Worker = class {
    constructor() { this.terminations = 0; instances.push(this); }
    terminate() { this.terminations++; }
    postMessage(data) { behavior(this, data, instances.length); }
  };
  try { await run(instances); }
  finally {
    for (const worker of instances) worker.onmessage?.({ data: { ok: false } });
    globalThis.Worker = original;
  }
}

for (const fault of ['silent', 'error', 'messageerror', 'post throws']) {
  test(`actual short/stem loading reaches chooser on fingerprint ${fault} without caching`, async () => {
    await workers(worker => {
      if (fault === 'post throws') throw new Error('post failed');
      if (fault !== 'silent') queueMicrotask(() => worker[`on${fault}`]?.({ preventDefault() {} }));
    }, async instances => {
      for (const files of [['short.wav'], ['drums.wav', 'bass.wav']]) {
        const { context, load, keys } = harness();
        let offered = null, published = 0;
        context.fingerprintBufferOffThread = (buffer, options) => fingerprintBufferOffThread(buffer, { ...options, deadlineMs: 25 });
        context.offerWorldsThenStart = data => { offered = data; };
        context.putBundle = async () => { published++; };
        await load(files);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(offered, 'current recording was offered');
        assert.equal(keys.length, 0); assert.equal(published, 0);
      }
      assert.deepEqual(instances.map(w => w.terminations), [1, 1]);
    });
  });
}

test('actual successful fingerprint loading degrades gracefully when IndexedDB is unavailable', async () => {
  await workers((worker, { signals }) => queueMicrotask(() => worker.onmessage({
    data: { ok: true, ...fingerprintSignals(signals) },
  })), async instances => {
    const { context, load } = harness();
    let offered;
    context.fingerprintBufferOffThread = fingerprintBufferOffThread;
    context.getBundle = cache.getBundle;
    context.offerWorldsThenStart = data => { offered = data; };
    await load();
    assert.equal(cache.analysisCacheSupported(), false);
    assert.ok(offered); assert.equal(instances[0].terminations, 1);
  });
});

test('actual replacement aborts old fingerprint and prevents late cache publication or adoption', async () => {
  let late;
  let workerStarted;
  const started = new Promise(resolve => { workerStarted = resolve; });
  await workers((worker, { signals }, number) => {
    const reply = worker.onmessage;
    if (number === 1) {
      late = () => reply({ data: { ok: true, ...fingerprintSignals(signals) } });
      workerStarted();
    }
    else queueMicrotask(() => reply({ data: { ok: true, ...fingerprintSignals(signals) } }));
  }, async instances => {
    const { context, load, keys } = harness();
    const offered = [], published = [];
    context.fingerprintBufferOffThread = (buffer, options) => fingerprintBufferOffThread(buffer, { ...options, deadlineMs: 500 });
    context.offerWorldsThenStart = data => offered.push(data.sourceFileName);
    context.putBundle = async key => published.push(key);
    const old = load(['old.wav']);
    // Preparation yields through timers; rapid immediates can finish their
    // poll budget before it reaches the worker. Await the real postMessage,
    // bounded by the client's existing deadline and load completion.
    await Promise.race([started, old.then(() => { throw new Error('old load completed before its fingerprint worker started'); })]);
    assert.ok(late, 'old fingerprint began');
    const current = load(['current.wav']);
    assert.equal(instances[0].terminations, 1, 'replacement terminates the old worker immediately');
    late();
    await Promise.all([old, current]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(offered, ['current.wav']);
    assert.equal(keys.length, 1, 'only current fingerprint reaches cache');
    assert.equal(published.length, 0, 'cache restoration did not republish');
    assert.deepEqual(instances.map(w => w.terminations), [1, 1]);
  });
});
