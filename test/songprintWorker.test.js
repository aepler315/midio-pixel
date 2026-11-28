import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { analyzeSongprintOffThread } from '../src/audio/SongprintWorkerClient.js';
import { analyzeSongprintPCM } from '../src/audio/Songprint.js';
import { SongprintReducer } from '../src/audio/SongprintReducer.js';
import { analyze as fableAnalyze } from '../src/audio/songprintFable/analyze.js';
import { copySongprint, copySongprintSkyline } from '../src/audio/SongprintData.js';

function audio(planes, rate) {
  return { numberOfChannels: planes.length, sampleRate: rate, length: planes[0].length,
    duration: planes[0].length / rate, getChannelData: ch => planes[ch] };
}

// Run the actual browser module and transfer list in a real thread. The shim
// only translates Worker events to the equivalent node:worker_threads events.
function workerFactory() {
  const url = new URL('../src/audio/songprintWorker.js', import.meta.url);
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: data => parentPort.postMessage(data) };
    import(${JSON.stringify(url.href)}).then(() => parentPort.on('message', data => self.onmessage({ data })));
  `, { eval: true });
  const client = {
    postMessage: (data, transfer) => worker.postMessage(data, transfer),
    terminate: () => worker.terminate(),
  };
  worker.on('message', data => client.onmessage({ data }));
  worker.on('error', error => client.onerror(error));
  return client;
}

test('real worker recovers an anti-phase recording across blocks and leaves playback PCM intact', async () => {
  const rate = 22050, frequencies = [220, 330, 392, 247, 294, 262];
  const duration = 28;
  const samples = Float32Array.from({ length: rate * duration }, (_, i) =>
    .7 * Math.sin(2 * Math.PI * frequencies[Math.floor(i / rate * 2) % frequencies.length] * i / rate));
  const inverted = samples.map(x => -x);
  const reducer = new SongprintReducer(rate, samples.length, 1);
  reducer.push([samples]);
  const expected = analyzeSongprintPCM(reducer.output);
  assert.ok(expected?.phraseFamilies.families.length, 'the fixture must carry verified returning phrases');
  const result = await analyzeSongprintOffThread(audio([samples, inverted], rate), { workerFactory, phrases: true });
  assert.deepEqual(result, expected);
  assert.equal(samples.length, duration * rate);
  assert.equal(inverted.length, samples.length);
  assert.equal(samples[32], -inverted[32]);
});

test('a measured silent recording is cacheable and worker failures are retriable', async () => {
  const buffer = audio([new Float32Array(11025)], 11025);
  assert.equal(await analyzeSongprintOffThread(buffer, { workerFactory }), null);
  const blocked = () => { throw Error('worker unavailable'); };
  assert.equal(await analyzeSongprintOffThread(buffer, { workerFactory: blocked }), undefined);
  let terminated = 0;
  const inert = () => ({ postMessage() {}, terminate() { terminated++; } });
  assert.equal(await analyzeSongprintOffThread(buffer, { workerFactory: inert, timeoutMs: 3 }), undefined);
  const controller = new AbortController();
  const pending = analyzeSongprintOffThread(buffer, { workerFactory: inert, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(terminated, 2);
});

test('2D measures the native stereo mix, independent of the geographic duration and bandwidth', async () => {
  const rate = 48000, length = rate * 6;
  const channels = [0, 1].map(ch => Float32Array.from({ length }, (_, i) => {
    const t = i / rate;
    if (t < .65 || t > 5.4) return 0;
    return .3 * Math.sin(2 * Math.PI * 220 * t)
      + (.12 + .1 * ch) * Math.sin(2 * Math.PI * 6800 * t + ch);
  }));
  const expected = fableAnalyze(channels, rate);
  const source = audio(channels, rate);
  const result = await analyzeSongprintOffThread(source, { workerFactory, fable: true, phrases: true });
  assert.equal(result.skyline, undefined);
  assert.equal(copySongprintSkyline(result), null);
  assert.deepEqual(result.fable.chroma, Array.from(expected.chroma));
  assert.deepEqual(result.fable.tone, Array.from(expected.tone));
  assert.ok(result.fable.offsetSeconds > .63 && result.fable.offsetSeconds < .66);
  assert.ok(Math.abs(result.fable.stereoWidth - expected.stereoWidth) < 1e-9);
  assert.deepEqual(copySongprint(JSON.parse(JSON.stringify(result)), 6000), result);
  assert.equal(await analyzeSongprintOffThread(source, { workerFactory, fable: false }), null);
});

test('a short anti-phase track keeps its Fable-only print and measured stereo width', async () => {
  const rate = 44100;
  const left = Float32Array.from({ length: rate * 8 }, (_, i) =>
    Math.sin(2 * Math.PI * 220 * i / rate) + .3 * Math.sin(2 * Math.PI * 6800 * i / rate));
  const right = left.map(x => -x);
  const expected = fableAnalyze([left], rate);
  // The rear pair is louder, and also cancels. The geographic pass recovers
  // channel 2 while the front-pair Fable recovers channel 0 on its own pass.
  const rear = Float32Array.from(left, (_, i) => 3 * Math.sin(2 * Math.PI * 370 * i / rate));
  for (const planes of [[left, right], [left, right, rear, rear.map(x => -x)]]) {
    const print = await analyzeSongprintOffThread(audio(planes, rate), { workerFactory, fable: true, phrases: true });
    assert.equal(print.skyline, undefined);
    assert.equal(print.fable.stereoWidth, 1);
    assert.deepEqual(print.fable.chroma, Array.from(expected.chroma));
    assert.deepEqual(print.fable.tone, Array.from(expected.tone));
    assert.deepEqual(copySongprint(print, 8000), print);
  }
});

test('rate reduction rejects above-Nyquist tones and gives identical samples across arbitrary block cuts', () => {
  const rate = 48000, frames = rate;
  const input = Float32Array.from({ length: frames }, (_, i) => Math.sin(2 * Math.PI * 9000 * i / rate));
  const one = new SongprintReducer(rate, frames, 1), split = new SongprintReducer(rate, frames, 1);
  one.push([input]);
  for (let i = 0; i < frames; i += 377) split.push([input.subarray(i, i + 377)]);
  assert.deepEqual(one.output, split.output);
  assert.ok(one.output.subarray(64, -64).every(x => Math.abs(x) < .005));
  const low = new SongprintReducer(rate, frames, 1);
  low.push([Float32Array.from(input, (_, i) => Math.sin(2 * Math.PI * 1000 * i / rate))]);
  assert.ok(Math.max(...low.output) > .99);
});
