import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REEL_SIZES, REEL_TARGET_SIZE, REEL_WARMUP_FRAMES, sizeLadder, sizeLabel, slugify, mmss, reelFileName,
  reelMoment, planReelRenders, stepTargets, warmupTimes, describeReelSave, approximationReasons,
  createReelSaver, ReelSaveCancelled, ReelSizeError,
} from '../src/ui/ReelExport.js';
import { stepExportClock } from '../src/render/BulkExport.js';

const prefs = { look: 'pixel', pixelGrid: 'medium', scaling: 'integer', dither: 0 };
const frame = (atMs, over = {}) => ({
  dataUrl: 'data:image/jpeg;base64,x', atMs, eventAtMs: atMs - 10, label: 'Sunset', category: 'sunset',
  moment: { songSeed: 7, worldId: 'range', displayPrefs: prefs, qualityLevel: 0, atMs, sceneStartMs: 0, continued: false, analysis: 'full' }, ...over,
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
  assert.deepEqual(reelMoment(frame(9000)), { atMs: 9000, songSeed: 7, worldId: 'range', displayPrefs: prefs, qualityLevel: 0,
    sceneStartMs: 0, continued: false, analysis: 'full' });
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
  assert.match(smaller.message, /2 frames were drawn at 2560×1440, because 3840×2160 did not work here \(the frame could not be encoded\)/);
  const none = describeReelSave({ unsaved: [2], failures: [{ size: { w: 1920, h: 1080 }, reason: 'no room' }] });
  assert.match(none.message, /One frame could not be drawn at any size: no room/);
  assert.match(describeReelSave({ unavailable: [0, 1] }).message, /2 frames have no record/);
  assert.match(describeReelSave({ error: 'the world failed', unsaved: [1] }).message, /^The save stopped: the world failed\. One frame could not be drawn\.$/);
});

test('a frame from a scene built part-way in, or on another analysis, is flagged approximate', () => {
  const m = (over) => reelMoment(frame(9000, { moment: { ...frame(9000).moment, ...over } }));
  assert.deepEqual(approximationReasons(m({}), { analysis: 'full' }), []);
  assert.deepEqual(approximationReasons(m({ sceneStartMs: 4200 }), { analysis: 'full' }), ['scene']);
  assert.deepEqual(approximationReasons(m({ continued: true }), { analysis: 'full' }), ['scene']);
  assert.deepEqual(approximationReasons(m({ analysis: 'opening' }), { analysis: 'full' }), ['analysis']);
  assert.deepEqual(approximationReasons(m({ analysis: undefined }), { analysis: 'full' }), ['analysis']);
  const plan = planReelRenders([frame(1000), frame(8000, { moment: { ...frame(8000).moment, sceneStartMs: 5000, continued: true } })]);
  assert.deepEqual(plan.groups[0].items.map((i) => i.approximate), [[], ['scene']]);
  const report = describeReelSave({ saved: [{ index: 0, width: 3840, height: 2160, approximate: ['scene'] },
    { index: 1, width: 3840, height: 2160, approximate: ['analysis'] }] });
  assert.equal(report.ok, false);
  assert.match(report.message, /One frame was captured in a scene rebuilt part-way through the song/);
  assert.match(report.message, /One frame was captured on a different analysis/);
});

/** A fake page for the save loop: records every call, fails where told. */
function fakePage({ failDraw = () => null, failBegin = () => null } = {}) {
  const log = [];
  let size = null, cancelled = false;
  const page = {
    log,
    cancelNow() { cancelled = true; },
    begin: async (group, s) => { log.push(['begin', `${s.w}x${s.h}`]); const e = failBegin(s); if (e) throw e; size = s; },
    draw: async (item, s) => { log.push(['draw', item.index, `${s.w}x${s.h}`]); const e = failDraw(item, s); if (e) throw e; },
    encode: async () => ({ blob: {}, width: size.w, height: size.h }),
    save: (item, file) => { log.push(['save', item.index, `${file.width}x${file.height}`]); },
    check: () => { if (cancelled) throw new ReelSaveCancelled(); },
    end: () => { log.push(['end']); },
    cancel: () => { log.push(['cancel']); },
  };
  return page;
}
const twoFrames = () => planReelRenders([frame(1000), frame(5000)]);

test('the save keeps a 4K frame and retries only the rest at the next size, from a fresh rebuild', async () => {
  const page = fakePage({ failDraw: (item, s) => (item.index === 1 && s.w === 3840 ? new ReelSizeError('the frame did not finish drawing') : null) });
  const result = await createReelSaver().run({ plan: twoFrames(), ...page });
  assert.equal(result.status, 'done');
  assert.deepEqual(page.log, [
    ['begin', '3840x2160'], ['draw', 0, '3840x2160'], ['save', 0, '3840x2160'], ['draw', 1, '3840x2160'],
    ['begin', '2560x1440'], ['draw', 1, '2560x1440'], ['save', 1, '2560x1440'], ['end'],
  ]);
  assert.deepEqual(result.saved.map((s) => [s.index, s.width]), [[0, 3840], [1, 2560]]);
  assert.match(result.report.message, /One frame was drawn at 2560×1440, because 3840×2160 did not work here \(the frame did not finish drawing\)/);
});

test('a size that never works leaves the frames unsaved after the whole ladder', async () => {
  const page = fakePage({ failBegin: (s) => new ReelSizeError(`the stage came up at 1x1, not ${s.w}×${s.h}`) });
  const result = await createReelSaver().run({ plan: twoFrames(), ...page });
  assert.deepEqual(page.log.filter((e) => e[0] === 'begin').map((e) => e[1]), ['3840x2160', '2560x1440', '1920x1080']);
  assert.deepEqual(result.unsaved, [0, 1]);
  assert.equal(page.log.at(-1)[0], 'end');
  assert.match(result.report.message, /2 frames could not be drawn at any size/);
});

test('an error that is not about size stops the save at once and is reported as itself', async () => {
  const page = fakePage({ failBegin: () => new Error('Export armed at 0×0, wanted 3840×2160.') });
  const plan = planReelRenders([frame(1000), frame(5000, { moment: { ...frame(5000).moment, songSeed: 9 } })]);
  const result = await createReelSaver().run({ plan, ...page });
  assert.deepEqual(page.log, [['begin', '3840x2160'], ['end']]);
  assert.equal(result.error, 'Export armed at 0×0, wanted 3840×2160.');
  assert.deepEqual(result.unsaved, [0, 1]);
  assert.deepEqual(result.failures, []);
  assert.doesNotMatch(result.report.message, /did not work here/);
  assert.match(result.report.message, /^The save stopped: Export armed/);
});

test('a cancel part-way runs cancel, not end, and reports nothing', async () => {
  let page;
  page = fakePage({ failDraw: (item) => { if (item.index === 1) page.cancelNow(); return null; } });
  const result = await createReelSaver().run({ plan: twoFrames(), ...page });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.report, undefined);
  assert.deepEqual(page.log.slice(-2), [['draw', 1, '3840x2160'], ['cancel']]);
  assert.ok(!page.log.some((e) => e[0] === 'end'));
  // An error thrown because the page was taken is the cancel too, not a size failure.
  let page2;
  page2 = fakePage({ failDraw: () => { page2.cancelNow(); return new ReelSizeError('the stage is 800×600, not 3840×2160'); } });
  const r2 = await createReelSaver().run({ plan: twoFrames(), ...page2 });
  assert.equal(r2.status, 'cancelled');
  assert.equal(page2.log.filter((e) => e[0] === 'begin').length, 1);
});

test('a second save while one runs is refused, and the saver is free again after', async () => {
  const saver = createReelSaver();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = fakePage();
  const first = saver.run({ plan: twoFrames(), ...page, begin: async (g, s) => { await gate; return page.begin(g, s); } });
  assert.equal(saver.busy, true);
  const second = await saver.run({ plan: twoFrames(), ...fakePage() });
  assert.deepEqual(second, { status: 'busy' });
  release();
  assert.equal((await first).status, 'done');
  assert.equal(saver.busy, false);
  assert.equal((await saver.run({ plan: twoFrames(), ...fakePage() })).status, 'done');
});

test('a group whose world is gone is unsaved without a rebuild', async () => {
  const page = fakePage();
  const result = await createReelSaver().run({ plan: twoFrames(), ...page, available: () => false });
  assert.deepEqual(page.log, [['end']]);
  assert.deepEqual(result.unsaved, [0, 1]);
});
