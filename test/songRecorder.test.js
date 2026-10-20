// The recorder sits between the render loop and a file, and the things that
// matter about it are all failure-shaped: it must never take the song down
// with it, it must composite into a canvas of the EXPORT's size rather than
// the stage's (which changes mid-song), and it must push exactly one frame
// per rendered frame rather than letting the browser guess.
//
// Tested against fakes. Everything the class reaches for -- MediaRecorder,
// document, performance, the audio graph -- comes from an injected scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RECORDING_BYTES, SongRecorder } from '../src/render/SongRecorder.js';
import { presetById, STAGE_W, STAGE_H } from '../src/render/VideoExport.js';
import { PixelPresentation } from '../src/render/PixelPresentation.js';
import { pixelGrid } from '../src/render/PixelRenderPolicy.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

const H264 = 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"';

function fakeTrack({ withRequestFrame = true } = {}) {
  const track = { kind: 'video', frames: 0, stopped: false, stop() { track.stopped = true; } };
  if (withRequestFrame) track.requestFrame = () => { track.frames++; };
  return track;
}

function fakeCanvas({ withRequestFrame = true } = {}) {
  const canvas = {
    width: 0, height: 0,
    draws: [], fills: [], streams: [], samplers: [],
    getContext: () => ({
      setTransform() {},
      set fillStyle(v) { canvas._fill = v; },
      get fillStyle() { return canvas._fill; },
      fillRect: (...a) => canvas.fills.push(a),
      imageSmoothingEnabled: true,
      drawImage(...a) { canvas.draws.push(a); canvas.samplers.push(this.imageSmoothingEnabled); },
    }),
    captureStream(fps) {
      const track = fakeTrack({ withRequestFrame });
      const stream = {
        fps,
        _video: [track], _audio: [],
        getVideoTracks: () => stream._video,
        getAudioTracks: () => stream._audio,
        addTrack: (t) => stream._audio.push(t),
      };
      canvas.streams.push(stream);
      return stream;
    },
  };
  return canvas;
}

/** Bytes that sniff as H.264, so the label path is exercised for real. */
function h264Chunk(size = 512) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < 4; i++) bytes[40 + i] = 'avc1'.charCodeAt(i);
  return new Blob([bytes]);
}

function fakeScope({
  supported = [H264], withRequestFrame = true, chunkOnStart = true, failConstruct = false,
  deferStop = false,
} = {}) {
  const created = [];
  let clock = 1000;
  class FakeMediaRecorder {
    static isTypeSupported(type) { return supported.includes(type); }
    constructor(stream, options) {
      if (failConstruct) throw new Error('NotSupportedError');
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      created.push(this);
    }
    start(timeslice) {
      this.state = 'recording';
      this.timeslice = timeslice;
      if (chunkOnStart) queueMicrotask(() => this.ondataavailable?.({ data: h264Chunk() }));
    }
    pause() { this.state = 'paused'; this.pauses = (this.pauses || 0) + 1; }
    resume() { this.state = 'recording'; this.resumes = (this.resumes || 0) + 1; }
    stop() {
      this.state = 'inactive';
      // A real MediaRecorder always flushes what it is holding as a final
      // `dataavailable` before `onstop`. Without that here, a recording
      // stopped inside one timeslice would look like it captured nothing.
      const finish = () => {
        if (chunkOnStart) this.ondataavailable?.({ data: h264Chunk() });
        this.onstop?.();
      };
      if (deferStop) this.finishStop = finish;
      else finish();
    }
  }
  const scope = {
    MediaRecorder: FakeMediaRecorder,
    performance: { now: () => clock },
    document: { createElement: () => fakeCanvas({ withRequestFrame }) },
    recorders: created,
    advance: (ms) => { clock += ms; },
  };
  return scope;
}

function fakeAudio() {
  const dest = {
    stream: { getAudioTracks: () => dest._tracks },
    _tracks: [{ kind: 'audio', stopped: false, stop() { this.stopped = true; } }],
  };
  const source = { connected: [], disconnected: [], connect(d) { this.connected.push(d); }, disconnect(d) { this.disconnected.push(d); } };
  return { context: { createMediaStreamDestination: () => dest }, source, dest };
}

const stage = { width: STAGE_W, height: STAGE_H, nodeName: 'CANVAS' };

test('terrain preparation pauses recording samples and excludes its wait from elapsed and final duration', async () => {
  const scope = fakeScope(), rec = new SongRecorder({ stage, scope });
  rec.start({ presetId: '720p' }); scope.advance(250);
  const release = rec.holdForPreparation(), track = rec._videoTrack, frames = track.frames;
  assert.equal(scope.recorders[0].state, 'paused');
  scope.advance(5000); rec.captureFrame();
  assert.equal(track.frames, frames, 'held draws cannot add recording samples');
  assert.equal(rec.elapsedMs, 250);
  assert.equal(release(), true); assert.equal(scope.recorders[0].state, 'recording');
  assert.equal(release(), false, 'one preparation cannot release twice');
  scope.advance(750);
  assert.equal((await rec.stop()).durationMs, 1000);
});

test('terrain readiness cannot resume an independently paused recording', async () => {
  const scope = fakeScope(), rec = new SongRecorder({ stage, scope });
  rec.start(); rec.pause();
  assert.equal(rec.holdForPreparation(), null, 'an existing user pause is not owned by terrain');
  rec.resume();
  const release = rec.holdForPreparation();
  rec.pause();
  assert.equal(release(), false, 'a later user pause remains in force after readiness');
  assert.equal(scope.recorders[0].state, 'paused');
  rec.resume(); assert.equal(scope.recorders[0].state, 'recording');
  await rec.stop();
});

test('a cancelled preparation cannot resume a stopped or replacement recording session', () => {
  const scope = fakeScope(), rec = new SongRecorder({ stage, scope });
  rec.start(); const release = rec.holdForPreparation(), old = scope.recorders[0];
  rec.cancel(); rec.start();
  assert.equal(release(), false);
  assert.equal(old.resumes || 0, 0);
  assert.equal(scope.recorders[1].resumes || 0, 0);
  rec.cancel();
});
test('Classic/Detailed/Natural changes keep encoded dimensions and never sample a pending grid', async () => {
  const makeStage = (width, height) => {
    const canvas = fakeCanvas(); canvas.width = width; canvas.height = height;
    canvas.ownerDocument = { createElement: () => makeStage(0, 0) }; return canvas;
  };
  const output = makeStage(800, 480), residency = new GraphicsResidency({ budgetBytes: 4000000 });
  const profile = { pixelated: true, grid: pixelGrid(), paletteId: 'none', scaling: 'integer' };
  const owner = new PixelPresentation({ canvas: output, presentation: profile, residency });
  owner.beginFrame(); owner.finishFrame();
  const rec = new SongRecorder({ stage: output, scope: fakeScope() });
  assert.equal(rec.start({ presetId: 'car', deferFirstFrame: true }), true);
  rec.captureFrame(owner.getCaptureSource());
  for (const gridId of ['detailed', 'classic', 'detailed']) {
    owner.setPresentation({ ...profile, grid: pixelGrid(gridId) });
    const frames = rec._videoTrack.frames;
    rec.captureFrame(owner.getCaptureSource()); assert.equal(rec._videoTrack.frames, frames, 'no previous or pending source gets encoded');
    owner.beginFrame(); assert.equal(owner.finishFrame().presented, true);
    rec.captureFrame(owner.getCaptureSource()); assert.equal(rec._videoTrack.frames, frames + 1);
    assert.equal(rec._canvas.width, 800); assert.equal(rec._canvas.height, 480);
    assert.equal(rec._canvas.draws.at(-1)[0].width, gridId === 'detailed' ? 640 : 320);
    assert.equal(rec._canvas.samplers.at(-1), false);
  }
  owner.setPresentation({ ...profile, pixelated: false }); owner.beginFrame(); owner.finishFrame(); rec.captureFrame(owner.getCaptureSource());
  assert.equal(rec._canvas.width, 800); assert.equal(rec._canvas.height, 480);
  await rec.stop(); owner.dispose(); assert.equal(residency.usedBytes, 0);
});

test('a browser that cannot record says so instead of throwing', () => {
  const rec = new SongRecorder({ stage, scope: fakeScope({ supported: [] }) });
  assert.equal(rec.supported, false);
  assert.equal(rec.candidate, null);
  assert.equal(rec.start(), false);
  assert.match(rec.error, /cannot record/);
  // And with no MediaRecorder at all.
  const none = new SongRecorder({ stage, scope: { document: {}, performance: { now: () => 0 } } });
  assert.equal(none.supported, false);
  assert.equal(none.start(), false);
});

test('a recorder that refuses to be constructed fails the export, not the song', () => {
  const rec = new SongRecorder({ stage, scope: fakeScope({ failConstruct: true }) });
  assert.equal(rec.start(), false);
  assert.match(rec.error, /NotSupportedError/);
  assert.equal(rec.recording, false);
  // Teardown ran: a second attempt starts from a clean slate rather than
  // inheriting half a recording.
  assert.equal(rec.captureFrame(), undefined);
});

test('the compositor canvas is the size of the EXPORT, not of the stage', () => {
  // The stage's backing store is whatever the resolution selector and the
  // perf governor made it, and Auto changes it mid-song. A video track
  // whose dimensions move halfway through is not recoverable, so the
  // recording is sized by the preset and nothing else.
  const scope = fakeScope();
  const rec = new SongRecorder({ stage: { width: 3840, height: 2160 }, scope });
  assert.equal(rec.start({ presetId: 'car' }), true);
  assert.equal(rec._canvas.width, 800);
  assert.equal(rec._canvas.height, 480);
});

test('the car preset letterboxes rather than stretching, and paints its bars once', () => {
  const scope = fakeScope();
  const rec = new SongRecorder({ stage, scope });
  rec.start({ presetId: 'car' });
  const canvas = rec._canvas;
  // One full-canvas fill for the bars, at setup.
  assert.deepEqual(canvas.fills, [[0, 0, 800, 480]]);
  rec.captureFrame();
  rec.captureFrame();
  // Still one: nothing draws over the bars, so re-clearing every frame
  // would be a full-canvas fill the export does not need.
  assert.equal(canvas.fills.length, 1);
  // Every draw goes to the 800x450 window inside those bars.
  for (const draw of canvas.draws) {
    assert.deepEqual(draw.slice(1), [0, 15, 800, 450]);
  }
});

test('a 16:9 preset fills the frame and never paints bars', () => {
  const rec = new SongRecorder({ stage, scope: fakeScope() });
  rec.start({ presetId: '720p' });
  assert.deepEqual(rec._canvas.fills, []);
  rec.captureFrame();
  assert.deepEqual(rec._canvas.draws.at(-1).slice(1), [0, 0, 1280, 720]);
});

test('exactly one frame is pushed per rendered frame', () => {
  const scope = fakeScope({ withRequestFrame: true });
  const rec = new SongRecorder({ stage, scope });
  rec.start({ presetId: '720p' });
  const track = rec._videoTrack;
  // start() captures one immediately, so an instantly-stopped recording
  // still holds a picture rather than an empty track.
  assert.equal(track.frames, 1);
  rec.captureFrame();
  rec.captureFrame();
  assert.equal(track.frames, 3);
  assert.equal(rec._canvas.draws.length, 3);
  // The stream was opened at fps 0: the browser samples nothing on its own.
  assert.equal(rec._canvas.streams[0].fps, 0);
});

test('capture can defer its first frame until the rebased picture is drawn', () => {
  const scope = fakeScope({ withRequestFrame: true });
  const rec = new SongRecorder({ stage, scope });
  rec.start({ presetId: '720p', deferFirstFrame: true });
  assert.equal(rec._videoTrack.frames, 0);
  assert.equal(rec._canvas.draws.length, 0);
  rec.captureFrame();
  assert.equal(rec._videoTrack.frames, 1);
  assert.equal(rec._canvas.draws.length, 1);
});

test('a browser without requestFrame falls back to timed sampling, not to failure', () => {
  const scope = fakeScope({ withRequestFrame: false });
  const rec = new SongRecorder({ stage, scope });
  assert.equal(rec.start({ presetId: '720p' }), true);
  const canvas = rec._canvas;
  // The manual stream was opened, found wanting, stopped, and replaced by
  // a sampled one.
  assert.equal(canvas.streams.length, 2);
  assert.equal(canvas.streams[0].fps, 0);
  assert.equal(canvas.streams[0]._video[0].stopped, true);
  assert.ok(canvas.streams[1].fps > 0);
  rec.captureFrame();
  assert.ok(canvas.draws.length >= 2); // still compositing, just not pushing
});

test('the master bus is tapped in and let go again', async () => {
  const audio = fakeAudio();
  const scope = fakeScope();
  const rec = new SongRecorder({ stage, audioContext: audio.context, audioSource: audio.source, scope });
  rec.start({ presetId: '720p' });
  assert.deepEqual(audio.source.connected, [audio.dest]);
  assert.equal(rec._canvas.streams[0]._audio.length, 1);

  await rec.stop();
  // Left connected, the tap would keep a destination node alive on the
  // graph for every recording the session ever makes.
  assert.deepEqual(audio.source.disconnected, [audio.dest]);
  assert.equal(audio.dest._tracks[0].stopped, true);
});

test('a refused audio tap yields a silent video, not no video', async () => {
  const hostile = { createMediaStreamDestination() { throw new Error('graph closed'); } };
  const rec = new SongRecorder({ stage, audioContext: hostile, audioSource: {}, scope: fakeScope() });
  assert.equal(rec.start({ presetId: '720p' }), true);
  const result = await rec.stop();
  assert.ok(result.blob.size > 0);
});

test('stopping resolves with the file, its real size, and the codec read from its bytes', async () => {
  const scope = fakeScope();
  const rec = new SongRecorder({ stage, scope });
  rec.start({ presetId: 'car' });
  scope.advance(195_000);

  const result = await rec.stop();
  assert.ok(result.blob.size > 0);
  assert.equal(result.bytes, result.blob.size);
  assert.equal(result.durationMs, 195_000);
  assert.equal(result.preset.id, 'car');
  assert.equal(result.candidate.reach, 'anywhere');
  // Read out of the container, not assumed from the mime type it asked for.
  assert.equal(result.codec, 'H.264');
  assert.equal(rec.recording, false);
});

test('a recording that captured nothing resolves null rather than an empty file', async () => {
  const rec = new SongRecorder({ stage, scope: fakeScope({ chunkOnStart: false }) });
  rec.start({ presetId: '720p' });
  assert.equal(await rec.stop(), null);
});

test('bitrate and container are chosen per preset, and handed to the recorder', () => {
  const scope = fakeScope();
  const car = new SongRecorder({ stage, scope });
  car.start({ presetId: 'car' });
  const hd = new SongRecorder({ stage, scope });
  hd.start({ presetId: '1080p' });
  const [carOpts, hdOpts] = scope.recorders.map((r) => r.options);
  assert.ok(carOpts.videoBitsPerSecond < hdOpts.videoBitsPerSecond);
  assert.equal(carOpts.mimeType, H264);
  assert.ok(carOpts.audioBitsPerSecond > 0);
  // Chunked, so a crash costs a second rather than the whole song.
  assert.ok(scope.recorders[0].timeslice > 0);
});

test('an unknown preset records at the default rather than 0x0', () => {
  const rec = new SongRecorder({ stage, scope: fakeScope() });
  assert.equal(rec.start({ presetId: 'nonsense' }), true);
  assert.equal(rec._canvas.width, presetById('720p').width);
});

test('recording requests owner cleanup before retaining chunks beyond the byte budget', async () => {
  const scope = fakeScope({ chunkOnStart: false });
  let requested = 0;
  let rec;
  rec = new SongRecorder({ stage, scope, onAutoStop: () => { requested++; rec.stop(); } });
  assert.equal(rec.start(), true);
  scope.recorders[0].ondataavailable({ data: { size: MAX_RECORDING_BYTES + 1 } });
  assert.equal(rec.bytes, 0);
  assert.match(rec.error, /512 MB export limit/);
  assert.equal(rec.recording, false);
  assert.equal(requested, 1);
  await rec._stopPromise;
});

test('start is not re-entrant and frames outside a recording are ignored', async () => {
  const scope = fakeScope();
  const rec = new SongRecorder({ stage, scope });
  rec.captureFrame(); // before start
  assert.equal(rec.start({ presetId: '720p' }), true);
  assert.equal(rec.start({ presetId: '720p' }), false, 'a second start must not replace a live recording');
  assert.equal(scope.recorders.length, 1);
  const canvas = rec._canvas;
  await rec.stop();
  const after = canvas.draws.length;
  rec.captureFrame(); // after stop
  assert.equal(canvas.draws.length, after);
  assert.equal(await rec.stop(), null, 'stopping twice is not an error');
});

test('a new recording cannot replace a session while stop is finalizing', async () => {
  const scope = fakeScope({ deferStop: true });
  const rec = new SongRecorder({ stage, scope });
  assert.equal(rec.start({ presetId: '720p' }), true);
  const firstRecorder = scope.recorders[0];
  const stopped = rec.stop();

  assert.equal(rec.recording, false);
  assert.equal(rec.finalizing, true);
  assert.equal(rec.start({ presetId: 'car' }), false);
  assert.equal(scope.recorders.length, 1, 'the pending session must retain its fields');
  assert.equal(rec.stop(), stopped, 'repeated stop returns the same pending result');

  firstRecorder.finishStop();
  const result = await stopped;
  assert.equal(result.preset.id, '720p');
  assert.equal(rec.finalizing, false);
  assert.equal(rec.start({ presetId: 'car' }), true);
  assert.equal(scope.recorders.length, 2);
});

test('cancelling throws the recording away and releases everything', async () => {
  const audio = fakeAudio();
  const scope = fakeScope();
  const rec = new SongRecorder({ stage, audioContext: audio.context, audioSource: audio.source, scope });
  rec.start({ presetId: '720p' });
  const track = rec._videoTrack;
  const pending = rec._stopPromise;

  rec.cancel();

  // A real MediaRecorder flushes a final chunk and fires onstop when it is
  // stopped, so a cancel that left its handlers attached would finish the
  // export and hand back a file -- the opposite of what was asked for.
  assert.equal(await pending, null);
  assert.equal(track.stopped, true);
  assert.deepEqual(audio.source.disconnected, [audio.dest]);
  assert.equal(rec.recording, false);
  // And cancelling something that is not recording is not an error.
  rec.cancel();
});

test('elapsed time is zero unless something is actually recording', () => {
  const scope = fakeScope();
  const rec = new SongRecorder({ stage, scope });
  assert.equal(rec.elapsedMs, 0);
  rec.start({ presetId: '720p' });
  scope.advance(4500);
  assert.equal(rec.elapsedMs, 4500);
});

 test('pixel sampling follows each capture without changing output dimensions', () => {
  const rec = new SongRecorder({ stage: { width: 320, height: 180 }, scope: fakeScope() });
  rec.start({ presetId: '720p', deferFirstFrame: true });
  const output = rec._canvas;
  for (const pixelated of [true, false, true]) rec.captureFrame({ pixelated });
  assert.deepEqual(output.samplers, [false, true, false]);
  assert.equal(output.width, 1280);
  assert.equal(output.height, 720);
  assert.equal(rec._videoTrack.frames, 3);
});
test('capture source and integer scaling preserve bars through mode changes', () => {
  const source = { width: 320, height: 180 };
  const rec = new SongRecorder({ stage, scope: fakeScope() });
  rec.start({ presetId: 'car', deferFirstFrame: true });
  rec.captureFrame({ canvas: source, pixelated: true, scaling: 'integer' });
  assert.equal(rec._canvas.draws.at(-1)[0], source);
  assert.deepEqual(rec._canvas.draws.at(-1).slice(1), [80, 60, 640, 360]);
  rec.captureFrame({ canvas: source, pixelated: true, scaling: 'fit' });
  assert.deepEqual(rec._canvas.draws.at(-1).slice(1), [0, 15, 800, 450]);
});

test('nullable failed capture is ignored without destructuring or pushing a frame', () => {
  const rec = new SongRecorder({ stage, scope: fakeScope() });
  rec.start({ presetId: 'car', deferFirstFrame: true });
  assert.doesNotThrow(() => rec.captureFrame(null));
  assert.equal(rec._canvas.draws.length, 0);
  assert.equal(rec._videoTrack.frames, 0);
  rec.cancel();
});

test('mixed sky captures recompose at recorder size and never smooth the completed terrain picture', () => {
  const rec = new SongRecorder({ stage, scope: fakeScope() });
  rec.start({ presetId: 'car', deferFirstFrame: true });
  const native = { width: 320, height: 180 }, calls = [];
  const source = { canvas: stage, pixelated: false, drawCaptureFrame(ctx, width, height) {
    calls.push([width, height]);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(native, 0, 15, 800, 450);
    return true;
  } };
  rec.captureFrame(source);
  assert.deepEqual(calls, [[800, 480]]);
  assert.deepEqual(rec._canvas.samplers, [false]);
  assert.equal(rec._canvas.draws[0][0], native);
  assert.equal(rec._videoTrack.frames, 1);
  rec.captureFrame({ ...source, drawCaptureFrame: () => false });
  assert.equal(rec._videoTrack.frames, 1, 'a rejected or stale mixed capture adds no encoded frame');
  rec.cancel();
});
