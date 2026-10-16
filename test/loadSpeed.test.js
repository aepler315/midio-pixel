// The pieces that cut the file-to-picker time: bands rendered a few at a
// time, and pitch analysis off the main thread. Both must produce exactly
// what the one-at-a-time, main-thread path did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandRenderConcurrency, separateStemsPooled, separateStemsSequential } from '../src/audio/StemSeparator.js';
import { BANDS } from '../src/audio/bands.js';
import { computePitchFeatures } from '../src/audio/PitchTracker.js';
import { computePitchFeaturesOffThread, frameRanges, pitchWorkerCount } from '../src/audio/PitchWorkerClient.js';

// A stand-in OfflineAudioContext: "renders" by tagging the output with the
// band's filter chain, after a delay that differs per band so completions
// arrive out of order.
function installFakeOffline(log) {
  let live = 0;
  globalThis.window = {
    OfflineAudioContext: class {
      constructor(channels, length, rate) { this.length = length; this.rate = rate; this.filters = []; }
      createBufferSource() { return { connect: (n) => n, start() {} }; }
      createBiquadFilter() {
        const b = { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect: (n) => n };
        this.filters.push(b);
        return b;
      }
      get destination() { return {}; }
      async startRendering() {
        live++;
        log.maxLive = Math.max(log.maxLive || 0, live);
        const tag = this.filters.map((f) => `${f.type}${f.frequency.value}`).join(',');
        await new Promise((r) => setTimeout(r, 5 + ((tag.length * 7) % 11)));
        live--;
        return { tag, length: this.length, sampleRate: this.rate };
      }
    },
  };
}

test('pooled band rendering hands over the same bands as sequential, a few at a time', async () => {
  const src = { numberOfChannels: 2, length: 1000, sampleRate: 44100 };
  const seqLog = {}, poolLog = {};
  installFakeOffline(seqLog);
  const seq = new Array(BANDS.length);
  await separateStemsSequential(src, (i, buf) => { seq[i] = buf.tag; });
  installFakeOffline(poolLog);
  const pooled = new Array(BANDS.length);
  let inBand = 0, overlap = false;
  await separateStemsPooled(src, async (i, buf) => {
    inBand++; if (inBand > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 1));
    pooled[i] = buf.tag;
    inBand--;
  }, null, null, 3);
  delete globalThis.window;
  assert.deepEqual(pooled, seq);
  assert.equal(seqLog.maxLive, 1);
  assert.equal(poolLog.maxLive, 3, 'three renders in flight');
  assert.equal(overlap, false, 'per-band work never interleaves');
});

test('band concurrency scales with device memory and song length', () => {
  const song = (sec) => ({ length: sec * 44100, channels: 2 });
  assert.equal(bandRenderConcurrency({ ...song(210), deviceMemoryGb: 4 }), 3);
  assert.equal(bandRenderConcurrency({ ...song(210), deviceMemoryGb: 2 }), 1);
  assert.equal(bandRenderConcurrency({ ...song(420), deviceMemoryGb: 4 }), 1);
  assert.equal(bandRenderConcurrency({ ...song(210) }), 3, 'unknown memory assumes 4GB');
  assert.equal(bandRenderConcurrency({ ...song(30), deviceMemoryGb: 8 }), 3, 'never more than three');
});

test('off-thread pitch falls back to the same features where no worker exists', async () => {
  const rate = 22050;
  const tone = new Float32Array(rate).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
  const direct = computePitchFeatures([tone], rate);
  const viaClient = await computePitchFeaturesOffThread([tone], rate);
  assert.equal(viaClient.frames.length, direct.frames.length);
  assert.deepEqual(Array.from(viaClient.frames[3]), Array.from(direct.frames[3]));
  assert.deepEqual(Array.from(viaClient.brightness), Array.from(direct.brightness));
});

test('off-thread pitch honours an abort', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(computePitchFeaturesOffThread([new Float32Array(4096)], 22050, { signal: ac.signal }), { name: 'AbortError' });
});

// A stand-in Worker that runs pitchWorker's computation in-process.
function installFakeWorker(log) {
  globalThis.Worker = class {
    postMessage({ channels, sampleRate, options }) {
      log.push(channels[0].length);
      setTimeout(() => this.onmessage({ data: { ok: true, features: computePitchFeatures(channels, sampleRate, options) } }), 1);
    }
    terminate() {}
  };
}

test('a song split across two pitch workers gives exactly the whole-song features', async () => {
  const rate = 8000;
  const n = rate * 7 + 1234;
  const mix = [new Float32Array(n).map((_, i) => Math.sin(i / 7) * Math.sin(i / 3000) + 0.3 * Math.sin(i / 2.1))];
  const whole = computePitchFeatures(mix, rate);
  const log = [];
  installFakeWorker(log);
  try {
    const split = await computePitchFeaturesOffThread(mix, rate, { parts: 2 });
    assert.equal(log.length, 2, 'two workers');
    assert.equal(split.frames.length, whole.frames.length);
    for (let f = 0; f < whole.frames.length; f++) assert.deepEqual(Array.from(split.frames[f]), Array.from(whole.frames[f]), `frame ${f}`);
    assert.deepEqual(Array.from(split.brightness), Array.from(whole.brightness));
  } finally {
    delete globalThis.Worker;
  }
});

test('frame ranges cover every frame once; long songs on 4+ cores split', () => {
  assert.deepEqual(frameRanges(10, 2), [[0, 5], [5, 10]]);
  assert.deepEqual(frameRanges(1, 2), [[0, 1]]);
  assert.equal(pitchWorkerCount({ seconds: 300, cores: 8 }), 2);
  assert.equal(pitchWorkerCount({ seconds: 300, cores: 2 }), 1);
  assert.equal(pitchWorkerCount({ seconds: 45, cores: 8 }), 1);
});
