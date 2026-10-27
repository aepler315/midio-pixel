import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REEL_SIZES, REEL_TARGET_SIZE, REEL_WARMUP_FRAMES, sizeLadder, sizeLabel, slugify, mmss, reelFileName,
  reelMoment, planReelRenders, stepTargets, warmupTimes, describeReelSave,
} from '../src/ui/ReelExport.js';
import { stepExportClock } from '../src/render/BulkExport.js';

const prefs = { look: 'pixel', pixelGrid: 'medium', scaling: 'integer', dither: 0 };
const frame = (atMs, over = {}) => ({
  dataUrl: 'data:image/jpeg;base64,x', atMs, eventAtMs: atMs - 10, label: 'Sunset', category: 'sunset',
  moment: { songSeed: 7, worldId: 'range', displayPrefs: prefs, qualityLevel: 0, atMs }, ...over,
});

test('the target is true 4K and the ladder steps down through the bulk export sizes', () => {
  assert.deepEqual(REEL_TARGET_SIZE, { w: 3840, h: 2160 });
  assert.deepEqual(REEL_SIZES, [{ w: 3840, h: 2160 }, { w: 2560, h: 1440 }, { w: 1920, h: 1080 }]);
  assert.deepEqual(sizeLadder(), REEL_SIZES);
  assert.deepEqual(sizeLadder({ w: 2560, h: 1440 }), [{ w: 2560, h: 1440 }, { w: 1920, h: 1080 }]);
  assert.deepEqual(sizeLadder({ w: 1920, h: 1080 }), [{ w: 1920, h: 1080 }]);
  assert.equal(sizeLabel(REEL_TARGET_SIZE), '3840×2160');
});

test('file names carry the song, the regime, the moment and the size actually drawn', () => {
  assert.equal(mmss(0), '0000');
  assert.equal(mmss(187_999), '0307');
  assert.equal(mmss(3_725_000), '6205');
  assert.equal(reelFileName({ songName: 'Héroes (Live) – 2024.mp3', frame: frame(187_400), width: 3840, height: 2160 }),
    'midio_heroes-live-2024_sunset_0307_3840x2160.png');
  assert.equal(reelFileName({ songName: 'x', frame: frame(5000, { label: 'Deepest night' }), width: 2560, height: 1440 }),
    'midio_x_deepest-night_0005_2560x1440.png');
  assert.equal(reelFileName({ songName: '???', frame: { atMs: 1000 }, width: 1920, height: 1080 }),
    'midio_song_highlight_0001_1920x1080.png');
  assert.equal(slugify('  --Storm   peak!! '), 'storm-peak');
});

test('a frame is reproducible only with its heard time, seed, world and display preferences', () => {
  assert.deepEqual(reelMoment(frame(9000)), { atMs: 9000, songSeed: 7, worldId: 'range', displayPrefs: prefs, qualityLevel: 0 });
  assert.equal(reelMoment(frame(9000, { moment: null })), null);
  assert.equal(reelMoment(frame(9000, { moment: { ...frame(9000).moment, songSeed: null } })), null);
  assert.equal(reelMoment(frame(9000, { moment: { ...frame(9000).moment, worldId: '' } })), null);
  assert.equal(reelMoment(frame(9000, { moment: { ...frame(9000).moment, displayPrefs: null } })), null);
  assert.equal(reelMoment(frame(9000, { moment: { ...frame(9000).moment, atMs: undefined } })).atMs, 9000);
  assert.equal(reelMoment(frame(-1, { moment: { ...frame(9000).moment, atMs: -1 } })), null);
  assert.equal(reelMoment(frame(9000, { moment: { ...frame(9000).moment, qualityLevel: 'high' } })).qualityLevel, null);
});

test('the plan groups frames by run and look, each group in song order', () => {
  const frames = [
    frame(40000),
    frame(10000),
    frame(25000, { moment: { ...frame(25000).moment, displayPrefs: { ...prefs, pixelGrid: 'detailed' } } }),
    frame(30000, { moment: null }),
    frame(55000, { moment: { ...frame(55000).moment, displayPrefs: { dither: 0, scaling: 'integer', pixelGrid: 'medium', look: 'pixel' } } }),
  ];
  const plan = planReelRenders(frames);
  assert.deepEqual(plan.unavailable, [3]);
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.groups.map(g => g.items.map(i => i.index)), [[1, 0, 4], [2]]);
  assert.deepEqual(plan.groups.map(g => g.items.map(i => i.atMs)), [[10000, 40000, 55000], [25000]]);
  assert.equal(plan.groups[1].displayPrefs.pixelGrid, 'detailed');
  assert.equal(plan.groups[0].songSeed, 7);
  assert.equal(plan.groups[0].worldId, 'range');
  assert.equal('atMs' in plan.groups[0], false);

  const one = planReelRenders(frames, { indices: [0, 0, 9, -1, 3] });
  assert.deepEqual(one.groups.map(g => g.items.map(i => i.index)), [[0]]);
  assert.deepEqual(one.unavailable, [3]);
  assert.deepEqual(planReelRenders(null), { groups: [], unavailable: [] });
});

test('a different seed or world is a separate rebuild', () => {
  const frames = [frame(1000), frame(2000, { moment: { ...frame(2000).moment, songSeed: 8 } }),
    frame(3000, { moment: { ...frame(3000).moment, worldId: 'trio' } })];
  assert.equal(planReelRenders(frames).groups.length, 3);
});

test('chunked stepping takes exactly the steps of one straight run', () => {
  const STEP = 1000 / 120;
  const straight = [], chunked = [];
  stepExportClock({ simTime: 0, targetMs: 12_345.6, stepMs: STEP, step: (dt, at) => straight.push(at) });
  let simTime = 0;
  const targets = stepTargets(0, 12_345.6, 2000);
  assert.equal(targets.at(-1), 12_345.6);
  assert.ok(targets.every((t, i) => i === 0 || t - targets[i - 1] <= 2000));
  for (const target of targets) simTime = stepExportClock({ simTime, targetMs: target, stepMs: STEP, step: (dt, at) => chunked.push(at) }).simTime;
  assert.deepEqual(chunked, straight);
  assert.deepEqual(stepTargets(500, 500), []);
  assert.deepEqual(stepTargets(500, 400), []);
  assert.deepEqual(stepTargets(0, 100, 0), []);
});

test('warmup draws lead into the instant at 60 fps, never before where the sim is', () => {
  const times = warmupTimes(10_000);
  assert.equal(times.length, REEL_WARMUP_FRAMES + 1);
  assert.equal(times.at(-1), 10_000);
  assert.ok(times.every((t, i) => i === 0 || Math.abs(t - times[i - 1] - 1000 / 60) < 1e-9));
  assert.deepEqual(warmupTimes(10, { fromMs: 0 }), [10]);
  assert.deepEqual(warmupTimes(10_000, { fromMs: 9_980 }), [10_000 - 1000 / 60, 10_000]);
});

test('the report is honest about smaller sizes, failures and frames without a record', () => {
  assert.deepEqual(describeReelSave({ saved: [{ index: 0, width: 3840, height: 2160 }] }), { ok: true, message: '' });
  const smaller = describeReelSave({
    saved: [{ index: 0, width: 2560, height: 1440 }, { index: 1, width: 2560, height: 1440 }],
    failures: [{ size: { w: 3840, h: 2160 }, reason: 'the frame could not be encoded' }],
  });
  assert.equal(smaller.ok, false);
  assert.match(smaller.message, /2 frames were saved at 2560×1440, because 3840×2160 did not work here \(the frame could not be encoded\)/);
  const none = describeReelSave({ unsaved: [2], failures: [{ size: { w: 1920, h: 1080 }, reason: 'no room' }] });
  assert.match(none.message, /One frame could not be drawn at any size: no room/);
  assert.match(describeReelSave({ unavailable: [0, 1] }).message, /2 frames have no record/);
});
