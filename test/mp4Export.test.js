import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MP4_EXPORT_RESOLUTIONS, MAX_MP4_BUFFER_BYTES, resolveMp4ExportSettings,
  estimateMp4ExportBytes, mp4ExportFileName, exportMp4, checkMp4ExportSupport, createMp4MemorySink,
} from '../src/render/Mp4Export.js';

function audioBuffer({ rate = 3000, length = 3100, channels = 2 } = {}) {
  const data = Array.from({ length: channels }, (_, ch) => Float32Array.from({ length }, (_, i) => (ch + 1) * (i % 10) / 100));
  return { sampleRate: rate, length, numberOfChannels: channels, duration: length / rate, getChannelData: ch => data[ch] };
}

function codecFixture({ videoSupported = true, audioSupported = true, addVideo = null } = {}) {
  const state = { video: [], audio: [], closedSamples: 0, cancelled: 0, finalized: 0, outputs: 0, probes: [] };
  class Output {
    constructor(options) { this.options = options; this.target = options.target; this.state = 'pending'; state.outputs++; state.output = this; }
    addVideoTrack(source, meta) { state.videoConfig = source.options; state.videoMeta = meta; }
    addAudioTrack(source) { state.audioConfig = source.options; }
    async start() { this.state = 'started'; this.target.start(); await this.target.write(new Uint8Array([1, 2, 3, 4]), 0); }
    async finalize() { state.finalized++; await this.target.close(); this.state = 'finalized'; }
    async cancel() { state.cancelled++; await this.target.close().catch(() => {}); this.state = 'canceled'; }
  }
  class CanvasSource {
    constructor(canvas, options) { this.options = options; }
    async add(time, duration, options) {
      state.video.push({ time, duration, options });
      if (addVideo) await addVideo(state.video.length, state);
    }
    close() { state.videoClosed = true; }
  }
  class AudioSampleSource {
    constructor(options) { this.options = options; }
    async add(sample) { state.audio.push({ ...sample.init, data: new Float32Array(sample.init.data) }); }
    close() { state.audioClosed = true; }
  }
  class AudioSample {
    constructor(init) { this.init = init; }
    close() { state.closedSamples++; }
  }
  class BufferTarget { constructor() { throw new Error('An unbounded BufferTarget must never be allocated.'); } }
  class StreamTarget {
    constructor(writable) { this.writable = writable; }
    start() { this.writer = this.writable.getWriter(); }
    async write(data, position) { await this.writer.write({ type: 'write', data, position }); this.onwrite?.(position, position + data.byteLength); }
    async close() { if (this.writer) { const writer = this.writer; this.writer = null; try { await writer.close(); } finally { writer.releaseLock(); } } }
  }
  class Mp4OutputFormat { constructor(options) { state.format = options; } }
  class Quality { constructor(options) { this.options = options; } }
  const library = {
    Output, CanvasSource, AudioSampleSource, AudioSample, BufferTarget, StreamTarget, Mp4OutputFormat, Quality,
    async canEncodeVideo(codec, options) { state.probes.push({ codec, options }); return videoSupported; },
    async canEncodeAudio(codec, options) { state.probes.push({ codec, options }); return audioSupported; },
  };
  return { state, library };
}

function runOptions(fixture, overrides = {}) {
  const canvas = { width: 640, height: 360 };
  return {
    canvas, audioBuffer: audioBuffer(), settings: { resolutionId: '360p', fps: 30 }, library: fixture.library,
    renderFrame: async () => ({ presented: true, width: canvas.width, height: canvas.height }),
    yieldControl: async () => {}, ...overrides,
  };
}

test('export settings select all six requested sizes and reject unsupported cadence or dimensions', () => {
  assert.deepEqual(MP4_EXPORT_RESOLUTIONS.map(r => [r.id, r.width, r.height]), [
    ['360p', 640, 360], ['480p', 854, 480], ['720p', 1280, 720],
    ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['2160p', 3840, 2160],
  ]);
  assert.equal(resolveMp4ExportSettings({ resolutionId: '4k', fps: 60 }).width, 3840);
  assert.equal(resolveMp4ExportSettings({ resolutionId: '720p', fps: '30' }).fps, 30);
  assert.throws(() => resolveMp4ExportSettings({ resolutionId: '8k' }), /resolution/i);
  assert.throws(() => resolveMp4ExportSettings({ fps: 24 }), /30 or 60/);
  assert.ok(estimateMp4ExportBytes({ resolutionId: '2160p', fps: 60 }, 600_000) > MAX_MP4_BUFFER_BYTES);
  assert.match(mp4ExportFileName({ songName: 'AC/DC.wav', settings: { resolutionId: '4k', fps: 60 } }), /AC-DC.*2160p60\.mp4$/);
});

test('offline encoding renders every exact frame timestamp and preserves the entire source PCM', async () => {
  const fixture = codecFixture(), times = [], progress = [];
  const options = runOptions(fixture, { onProgress: value => progress.push(value) });
  options.renderFrame = async ms => { times.push(ms); return { presented: true, width: 640, height: 360 }; };
  const result = await exportMp4(options);
  assert.equal(result.frames, 31);
  assert.equal(times.length, 31);
  assert.equal(times[0], 0);
  assert.equal(times[1], 1000 / 30);
  assert.equal(times[30], 1000);
  assert.equal(fixture.state.video[30].time, 1);
  assert.equal(fixture.state.video[30].duration, 1 / 30);
  assert.equal(fixture.state.videoMeta.frameRate, 30);
  assert.equal(fixture.state.videoConfig.latencyMode, 'quality');
  assert.equal(fixture.state.videoConfig.codec, 'avc');
  assert.equal(fixture.state.audioConfig.codec, 'aac');
  const restored = [[], []];
  for (const sample of fixture.state.audio) {
    assert.equal(sample.format, 'f32-planar');
    assert.equal(sample.sampleRate, 3000);
    assert.equal(sample.numberOfChannels, 2);
    const count = sample.data.length / 2;
    restored[0].push(...sample.data.subarray(0, count));
    restored[1].push(...sample.data.subarray(count));
  }
  assert.deepEqual(restored[0], [...options.audioBuffer.getChannelData(0)]);
  assert.deepEqual(restored[1], [...options.audioBuffer.getChannelData(1)]);
  assert.equal(fixture.state.closedSamples, fixture.state.audio.length);
  assert.equal(fixture.state.finalized, 1);
  assert.equal(fixture.state.cancelled, 0);
  assert.equal(result.blob.type, 'video/mp4');
  assert.equal(progress.at(-1).progress, 1);
  assert.equal(fixture.state.videoClosed, true);
  assert.equal(fixture.state.audioClosed, true);
  assert.equal(fixture.state.format.fastStart, false);
});

test('60 fps covers a partial last frame without clipping the final audio sample', async () => {
  const fixture = codecFixture();
  const result = await exportMp4(runOptions(fixture, { settings: { resolutionId: '360p', fps: 60 }, audioBuffer: audioBuffer({ length: 3050 }) }));
  assert.equal(result.frames, 61);
  assert.equal(fixture.state.video.at(-1).time, 1);
  assert.equal(fixture.state.audio.reduce((n, sample) => n + sample.data.length / 2, 0), 3050);
});

test('encoder backpressure holds the next render and audio stays near the video clock', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const first = new Promise(resolve => { started = resolve; });
  const fixture = codecFixture({ addVideo: async count => { if (count === 1) { started(); await gate; } } });
  let rendered = 0;
  const promise = exportMp4(runOptions(fixture, { renderFrame: async () => { rendered++; return { presented: true, width: 640, height: 360 }; } }));
  await first;
  assert.equal(rendered, 1);
  assert.ok(fixture.state.audio.reduce((n, sample) => n + sample.data.length / 2, 0) <= 600);
  release();
  await promise;
});

test('unsupported H.264 or AAC fails before starting a render or output', async () => {
  for (const codec of ['video', 'audio']) {
    const fixture = codecFixture({ videoSupported: codec !== 'video', audioSupported: codec !== 'audio' });
    let rendered = false;
    await assert.rejects(exportMp4(runOptions(fixture, { renderFrame: () => { rendered = true; } })), codec === 'video' ? /H\.264/ : /AAC/);
    assert.equal(rendered, false);
    assert.equal(fixture.state.outputs, 0);
  }
});

test('encoder support can be checked before changing the player or allocating an output', async () => {
  const fixture = codecFixture({ videoSupported: false });
  await assert.rejects(checkMp4ExportSupport({ settings: { resolutionId: '720p', fps: 60 }, audioBuffer: audioBuffer(), library: fixture.library }), /H\.264/);
  assert.equal(fixture.state.outputs, 0);
});

test('cancellation stops a pending encoder and releases output resources', async () => {
  const controller = new AbortController();
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const fixture = codecFixture({ addVideo: async () => { started(); await new Promise(() => {}); } });
  const promise = exportMp4(runOptions(fixture, { signal: controller.signal }));
  await first;
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(fixture.state.cancelled, 1);
  assert.equal(fixture.state.finalized, 0);
  assert.equal(fixture.state.video.length, 1);
});

test('an incomplete or resized render cancels instead of encoding a stale frame', async () => {
  for (const frame of [{ presented: false }, { presented: true, width: 1280, height: 720 }]) {
    const fixture = codecFixture();
    await assert.rejects(exportMp4(runOptions(fixture, { renderFrame: async () => frame })), /frame|size/i);
    assert.equal(fixture.state.video.length, 0);
    assert.equal(fixture.state.cancelled, 1);
  }
});

test('large exports require writable output before allocating an in-memory movie', async () => {
  const fixture = codecFixture();
  const options = runOptions(fixture, {
    canvas: { width: 3840, height: 2160 }, settings: { resolutionId: '4k', fps: 60 },
    audioBuffer: audioBuffer({ rate: 1, length: 600 }),
  });
  await assert.rejects(exportMp4(options), /large|file|memory/i);
  assert.equal(fixture.state.outputs, 0);
});

test('direct writable output uses the stream target without making an in-memory blob', async () => {
  let closed = 0, aborted = 0;
  const fixture = codecFixture(), writable = new WritableStream({ close() { closed++; }, abort() { aborted++; } });
  const result = await exportMp4(runOptions(fixture, { writable }));
  assert.ok(fixture.state.output.target instanceof fixture.library.StreamTarget);
  assert.equal(result.blob, null);
  assert.equal(closed, 1);
  assert.equal(aborted, 0);
  assert.equal(writable.locked, false);
});

test('a direct file is aborted instead of committed after encoding or preflight failure', async () => {
  for (const videoSupported of [false, true]) {
    let closed = 0, aborted = 0;
    const fixture = codecFixture({ videoSupported });
    const writable = new WritableStream({ close() { closed++; }, abort() { aborted++; } });
    await assert.rejects(exportMp4(runOptions(fixture, { writable, renderFrame: async () => { throw new Error('lost landscape'); } })));
    assert.equal(aborted, 1);
    assert.equal(closed, 0);
    assert.equal(writable.locked, false);
  }
});

test('actual byte growth enforces the memory guard and cancels the output', async () => {
  const fixture = codecFixture({ addVideo: async (count, state) => { await state.output.target.write(new Uint8Array([1]), MAX_MP4_BUFFER_BYTES); } });
  await assert.rejects(exportMp4(runOptions(fixture)), /limit|large|memory/i);
  assert.equal(fixture.state.cancelled, 1);
  assert.equal(fixture.state.finalized, 0);
});

test('the memory sink rejects an oversized end offset before allocating even one new page', async () => {
  const sink = createMp4MemorySink({ maxBytes: 10, pageBytes: 4 });
  const writer = sink.writable.getWriter();
  await writer.write({ type: 'write', position: 0, data: new Uint8Array([1, 2, 3]) });
  assert.equal(sink.bytes, 3);
  assert.equal(sink.allocatedBytes, 4);
  // Growing first would add pages for bytes4..11. The rejected write must
  // leave both the existing content and its allocation unchanged.
  await assert.rejects(writer.write({ type: 'write', position: 9, data: new Uint8Array([8, 9]) }), /limit|large/i);
  assert.equal(sink.bytes, 3);
  assert.equal(sink.allocatedBytes, 4);
  writer.releaseLock(); sink.clear();
  assert.equal(sink.allocatedBytes, 0);
});

test('fixed memory pages support cross-page header rewrites and a partial final page without a large contiguous buffer', async () => {
  const sink = createMp4MemorySink({ maxBytes: 10, pageBytes: 4 });
  const writer = sink.writable.getWriter();
  await writer.write({ type: 'write', position: 0, data: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  assert.equal(sink.allocatedBytes, 10, 'the final allocation fits the remaining budget exactly');
  await writer.write({ type: 'write', position: 3, data: new Uint8Array([30, 40, 50]) });
  assert.equal(sink.allocatedBytes, 10, 'header rewrites allocate no new pages');
  await writer.close(); writer.releaseLock();
  const blob = sink.toBlob();
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 2, 30, 40, 50, 6, 7, 8, 9]);
  assert.equal(sink.allocatedBytes, 0, 'page references are released after the Blob snapshot');
});

test('sparse MP4 writes create zero-filled holes and omit unused page capacity from the Blob', async () => {
  const sink = createMp4MemorySink({ maxBytes: 12, pageBytes: 4 });
  const writer = sink.writable.getWriter();
  await writer.write({ type: 'write', position: 6, data: new Uint8Array([7]) });
  assert.equal(sink.allocatedBytes, 8);
  await writer.close(); writer.releaseLock();
  const blob = sink.toBlob();
  assert.equal(blob.size, 7);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 0, 0, 0, 0, 0, 7]);
});
