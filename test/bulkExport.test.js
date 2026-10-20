import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BULK_RESOLUTIONS, parseResolutions, parseFrameRates, evenExportSize,
  frameCount, frameTimeMs, passesFor, stepExportClock, bulkFileName,
  songLabels, ffmpegRawArgs, parseBulkArgs, isAudioPath,
} from '../src/render/BulkExport.js';

test('every bulk resolution is even 16:9', () => {
  for (const r of BULK_RESOLUTIONS) {
    assert.equal(r.width % 2, 0, r.id);
    assert.equal(r.height % 2, 0, r.id);
    assert.ok(Math.abs(r.width / r.height - 16 / 9) < 1e-9, r.id);
  }
  assert.deepEqual(BULK_RESOLUTIONS.map((r) => r.height), [1080, 1440, 2160]);
});

test('resolution and frame-rate lists accept aliases and come back canonical', () => {
  assert.deepEqual(parseResolutions('4k, 1440, 1080p, 4k'), ['1080p', '1440p', '2160p']);
  assert.deepEqual(parseResolutions('all'), ['1080p', '1440p', '2160p']);
  assert.deepEqual(parseFrameRates('30,60,30'), [60, 30]);
  assert.deepEqual(parseFrameRates('30'), [30]);
  assert.throws(() => parseResolutions('720'), /1080/);
  assert.throws(() => parseFrameRates('24'), /30 or 60/);
});

test('a 60fps draw and a 30fps file share timestamps', () => {
  const passes = passesFor(['2160p', '1080p'], [30, 60]);
  assert.deepEqual(passes.map((p) => p.resolution.id), ['1080p', '2160p']);
  assert.equal(passes[0].drawFps, 60);
  assert.deepEqual(passes[0].outputs, [
    { fps: 60, every: 1 },
    { fps: 30, every: 2 },
  ]);
  const frames = frameCount(180_000, 60);
  assert.equal(frames, 10800);
  for (let i = 0; i < frames; i += 2) {
    assert.equal(frameTimeMs(i, 60), frameTimeMs(i / 2, 30));
  }
  assert.equal(frameCount(0, 60), 0);
  assert.equal(passesFor(['1440p'], [30])[0].drawFps, 30);
});

test('filenames keep the song readable and disambiguate collisions', () => {
  assert.equal(
    bulkFileName({ songName: 'A/B: Night?.mp3', resolutionId: '2160p', fps: 60 }),
    'A-B- Night- - 2160p60.mp4',
  );
  assert.deepEqual(songLabels([
    'C:/music/album/intro.wav',
    'C:/music/live/intro.wav',
    'C:/music/album/other.mp3',
  ]), ['album - intro.wav', 'live - intro.wav', 'other.mp3']);
  assert.equal(isAudioPath('song.FLAC'), true);
  assert.equal(isAudioPath('notes.mid'), false);
});

test('ffmpeg is asked for H.264, AAC, and a constant frame rate', () => {
  const args = ffmpegRawArgs({
    width: 2560, height: 1440, fps: 30,
    audioPath: 'song.wav', outPath: 'out.mp4', crf: 16, preset: 'medium',
  });
  assert.equal(args[args.indexOf('-pixel_format') + 1], 'rgba');
  assert.equal(args[args.indexOf('-video_size') + 1], '2560x1440');
  assert.equal(args[args.indexOf('-framerate') + 1], '30');
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-crf') + 1], '16');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.ok(args.includes('+faststart'));
  assert.equal(args.at(-1), 'out.mp4');
  assert.throws(() => ffmpegRawArgs({
    width: 100, height: 100, fps: 24, audioPath: 'a', outPath: 'b',
  }), /30 or 60/);
});

test('the command line defaults to the full matrix and records the inputs', () => {
  const opts = parseBulkArgs(['--res', '4k,1080', '--fps=30', '--out', 'vids', '--crf', '18', 'a.mp3', 'album']);
  assert.deepEqual(opts.resolutions, ['1080p', '2160p']);
  assert.deepEqual(opts.frameRates, [30]);
  assert.equal(opts.out, 'vids');
  assert.equal(opts.crf, 18);
  assert.deepEqual(opts.inputs, ['a.mp3', 'album']);
  assert.equal(opts.lyrics, false);
  assert.equal(parseBulkArgs(['--help']).help, true);
  assert.deepEqual(parseBulkArgs(['song.wav']).resolutions, ['1080p', '1440p', '2160p']);
  assert.deepEqual(parseBulkArgs(['song.wav']).frameRates, [60, 30]);
  assert.throws(() => parseBulkArgs(['--nope']), /Unknown option/);
});

// --- The clock and the frame size (carried over from main, #300/#301) ---

// A recording stepper: every call is kept so the tests can assert on the
// shape of the advance, not just where it ended up.
function recorder() {
  const calls = [];
  return { calls, step: (dt, at) => calls.push({ dt, at }) };
}

test('stepExportClock advances in whole fixed steps', () => {
  const { calls, step } = recorder();
  const advanced = stepExportClock({ simTime: 0, targetMs: 50, stepMs: 10, step });
  assert.deepEqual(advanced, { simTime: 50, steps: 5 });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], { dt: 10, at: 10 });
  assert.deepEqual(calls[4], { dt: 10, at: 50 });
});

test('stepExportClock reports the instant it actually reached, not the one asked for', () => {
  // 33.37ms is a real frame interval (29.97fps) against a 16ms step: the
  // exporter must draw what was simulated, or the sim would drift behind the
  // time written into the video.
  const { calls, step } = recorder();
  const advanced = stepExportClock({ simTime: 0, targetMs: 33.37, stepMs: 16, step });
  assert.equal(advanced.steps, 2);
  assert.equal(advanced.simTime, 32);
  assert.equal(calls.at(-1).at, 32);
});

test('stepExportClock carries the remainder into the next frame rather than losing it', () => {
  // Frame times accumulate, so the leftover from one frame is made up by the
  // next. Over four frames of 33.37ms the clock must not fall a step behind
  // per frame.
  const { calls, step } = recorder();
  let simTime = 0;
  for (let frame = 1; frame <= 4; frame += 1) {
    simTime = stepExportClock({ simTime, targetMs: frame * 33.37, stepMs: 16, step }).simTime;
  }
  assert.equal(calls.length, 8);
  assert.equal(simTime, 128);
  // Still within one step of the requested 133.48ms, not four steps adrift.
  assert.ok(133.48 - simTime < 16);
});

test('stepExportClock does not run backwards', () => {
  const { calls, step } = recorder();
  const advanced = stepExportClock({ simTime: 100, targetMs: 40, stepMs: 10, step });
  assert.deepEqual(advanced, { simTime: 100, steps: 0 });
  assert.equal(calls.length, 0);
});

test('stepExportClock re-requesting the same frame is a no-op', () => {
  const { calls, step } = recorder();
  const first = stepExportClock({ simTime: 0, targetMs: 40, stepMs: 10, step });
  const again = stepExportClock({ simTime: first.simTime, targetMs: 40, stepMs: 10, step });
  assert.equal(again.simTime, first.simTime);
  assert.equal(again.steps, 0);
  assert.equal(calls.length, 4);
});

test('stepExportClock refuses a step that would never reach the target', () => {
  const { step } = recorder();
  // Each of these would spin forever in a naive loop.
  for (const stepMs of [0, -16, NaN, Infinity]) {
    assert.throws(() => stepExportClock({ simTime: 0, targetMs: 100, stepMs, step }), /positive number of milliseconds/);
  }
});

test('stepExportClock refuses times that are not numbers', () => {
  const { step } = recorder();
  assert.throws(() => stepExportClock({ simTime: NaN, targetMs: 10, stepMs: 10, step }), /clock time is not a number/);
  assert.throws(() => stepExportClock({ simTime: 0, targetMs: NaN, stepMs: 10, step }), /frame time is not a number/);
  assert.throws(() => stepExportClock({ simTime: 0, targetMs: 10, stepMs: 10 }), /step function/);
});

test('evenExportSize passes an even pair through unchanged', () => {
  assert.deepEqual(evenExportSize({ w: 1280, h: 720 }), { w: 1280, h: 720 });
  assert.deepEqual(evenExportSize({ w: 800, h: 480 }), { w: 800, h: 480 });
  assert.deepEqual(evenExportSize({ w: 2, h: 2 }), { w: 2, h: 2 });
});

test('evenExportSize is idempotent', () => {
  // startTimeline re-validates a size beginBulkExport already approved.
  const once = evenExportSize({ w: 3840, h: 2160 });
  assert.deepEqual(evenExportSize(once), once);
});

test('evenExportSize coerces numeric strings, as query parameters arrive', () => {
  assert.deepEqual(evenExportSize({ w: '1920', h: '1080' }), { w: 1920, h: 1080 });
});

test('evenExportSize rejects odd sizes rather than nudging them', () => {
  // Silently exporting 1279 wide would change the aspect ratio of a long
  // render without saying so.
  assert.equal(evenExportSize({ w: 1279, h: 720 }), null);
  assert.equal(evenExportSize({ w: 1280, h: 721 }), null);
});

test('evenExportSize rejects sizes that are not usable pixels', () => {
  for (const size of [
    { w: NaN, h: 720 }, { w: 1280, h: NaN },
    { w: 0, h: 0 }, { w: -1280, h: -720 },
    { w: 1280.5, h: 720 }, { w: Infinity, h: 720 },
    { w: 'wide', h: 'tall' },
  ]) {
    assert.equal(evenExportSize(size), null, `${size.w}x${size.h} should be rejected`);
  }
});

test('evenExportSize survives a missing size', () => {
  // `exportSize || fromUrl || bulkExportSize` is null when nothing is armed.
  assert.equal(evenExportSize(null), null);
  assert.equal(evenExportSize(undefined), null);
  assert.equal(evenExportSize(1280), null);
});

test('stepExportClock takes the same whole steps every frame across a long render', () => {
  // Frame times are products (i * 1000/fps); simTime is a running sum of
  // 1000/120. Without a rounding tolerance the two drift apart and some
  // frames take one step short and the next one long: a periodic stutter
  // that round-number cases like the ones above can never show. Ten minutes
  // at each rate the bulk tool draws.
  const stepMs = 1000 / 120;
  for (const [fps, perFrame] of [[60, 2], [30, 4]]) {
    let simTime = 0;
    const frames = frameCount(600_000, fps);
    for (let i = 1; i <= frames; i += 1) {
      const out = stepExportClock({ simTime, targetMs: frameTimeMs(i, fps), stepMs, step: () => {} });
      assert.equal(out.steps, perFrame, `${fps}fps frame ${i} took ${out.steps} steps`);
      simTime = out.simTime;
    }
    assert.ok(Math.abs(simTime - 600_000) < 1e-3, `${fps}fps ended at ${simTime}`);
  }
});

test('bulk display overrides are explicit and validated', () => {
  const opts = parseBulkArgs(['--look', 'palette', '--quality', 'economy', '--palette', 'rgb332', '--dither', 'full', '--scaling', 'integer', 'song.wav']);
  assert.deepEqual(opts.presentation, { version: 2, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, ditherMode: 'selective', pixelGrid: 'classic', scaling: 'integer', pixelScale: 'original' });
  assert.equal(parseBulkArgs(['song.wav']).presentation, null);
  assert.throws(() => parseBulkArgs(['--look', 'bad']), /look/);
});
test('bulk export accepts Chroma and world selections and rejects unknown palette values', () => {
  for (const palette of ['world', 'range32', 'chroma32', 'rgb332']) assert.equal(parseBulkArgs(['song.wav', '--look', 'palette', '--palette', palette]).presentation.palette, palette);
  assert.throws(() => parseBulkArgs(['song.wav', '--palette', 'custom']));
});
test('bulk export accepts only deterministic Ordered and Selective dither styles', () => {
  for (const ditherMode of ['ordered', 'selective']) assert.equal(parseBulkArgs(['song.wav', '--dither-mode', ditherMode]).presentation.ditherMode, ditherMode);
  assert.throws(() => parseBulkArgs(['song.wav', '--dither-mode', 'random']));
});
test('bulk export round trips both explicit grids with the v2 palette/dither profile', () => {
  for (const pixelGrid of ['classic', 'detailed']) {
    const opts = parseBulkArgs(['song.wav', '--look', 'palette', '--quality', 'auto', '--palette', 'world', '--dither', 'subtle', '--dither-mode', 'selective', '--pixel-grid', pixelGrid, '--scaling', 'integer']);
    assert.deepEqual(opts.presentation, { version: 2, look: 'palette', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid, scaling: 'integer', pixelScale: 'original' });
  }
  assert.throws(() => parseBulkArgs(['song.wav', '--pixel-grid', 'arbitrary']));
});

test('bulk export rejects Natural and the removed pixel-scale option', () => {
  assert.throws(() => parseBulkArgs(['--look', 'natural', 'song.wav']), /look/);
  for (const pixelScale of ['depth', 'original', 'random']) {
    assert.throws(() => parseBulkArgs(['--pixel-scale', pixelScale, 'song.wav']), /Unknown option --pixel-scale/);
    assert.throws(() => parseBulkArgs([`--pixel-scale=${pixelScale}`, 'song.wav']), /Unknown option --pixel-scale/);
  }
});
