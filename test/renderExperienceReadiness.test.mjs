import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('async function changeExperience(');
const end = main.indexOf('\n}\n', start) + 3;
const implementation = main.slice(start, end);

function changeContext(overrides = {}) {
  const starts = [], applied = [], timeline = { worldId: 'alpine' };
  const context = vm.createContext({
    resolveExperience: value => (value === 'trio' ? 'trio' : 'landscape'), experienceRequest: 0,
    sim: { songSeed: 315 }, experience: 'landscape', running: true, paused: false,
    experienceControl: {}, experienceStatus: {}, lastTimelineData: timeline, bulkExportArmed: false,
    songRecorder: null, pendingCaptureOptions: null,
    lastStartExtra: { live: false, songSeed: 1, startAtMs: 999 }, audioEngine: { nowMs: 0 },
    worldForExperience: value => (value === 'trio' ? 'trio' : 'alpine'), tailoredWorldId: id => id,
    applyExperience: value => applied.push(value), fitCanvas() {},
    startTimeline: (data, options) => starts.push({ data, options }),
    ...overrides,
  });
  vm.runInContext(implementation, context);
  return { context, starts, applied, timeline };
}

// Landscape's real terrain and Trio's procedural range are different worlds,
// so a mid-song switch rebuilds the scene in the other world at the heard
// position, through the same playback gate as a seek.
for (const [from, to, world] of [['trio', 'landscape', 'alpine'], ['landscape', 'trio', 'trio']]) {
  for (const paused of [false, true]) for (const position of [0, 65000]) {
    test(`${from} to ${to} rebuilds the song in ${world} at ${position} with paused=${paused}`, async () => {
      const { context, starts, applied, timeline } = changeContext({ experience: from, paused,
        audioEngine: { nowMs: position }, lastTimelineData: { worldId: from === 'trio' ? 'trio' : 'alpine', chapterState: {} } });
      await context.changeExperience(to);
      assert.equal(context.experienceStatus.textContent, to === 'trio' ? 'Automatic performance' : '',
        'the transition must not swallow an integration error');
      assert.deepEqual(applied, [], 'startTimeline owns the presentation switch');
      assert.equal(starts.length, 1);
      assert.equal(starts[0].data, context.lastTimelineData);
      assert.equal(starts[0].data.worldId, world);
      assert.equal(starts[0].data.chapterState, undefined);
      const options = starts[0].options;
      assert.equal(options.startAtMs, position);
      assert.equal(options.songSeed, 315);
      assert.equal(options.keepAudio, true);
      assert.equal(options.keepUserCamera, true);
      assert.equal(options.preservePause, paused);
      assert.equal(options.chapterState, null);
      assert.ok(timeline);
    });
  }
}

test('a switch before any song only points the page at the chosen world', async () => {
  const { context, starts, applied } = changeContext({ running: false, sim: null });
  await context.changeExperience('trio');
  assert.deepEqual(applied, ['trio']);
  assert.equal(starts.length, 0);
});

test('choosing the current world does nothing', async () => {
  const { context, starts, applied } = changeContext({ experience: 'trio' });
  await context.changeExperience('trio');
  assert.equal(starts.length + applied.length, 0);
});

test('an armed export keeps its world', async () => {
  const { context, starts, applied } = changeContext({ bulkExportArmed: true, experienceControl: { value: 'trio' } });
  await context.changeExperience('trio');
  assert.equal(starts.length + applied.length, 0);
  assert.equal(context.experienceControl.value, 'landscape');
  assert.equal(context.experienceStatus.textContent, 'Could not switch world. Choose the world before exporting.');
});

test('a failed rebuild restores the control and says why', async () => {
  const { context } = changeContext({ experienceControl: { value: 'trio' },
    startTimeline() { throw new Error('no world'); } });
  await context.changeExperience('trio');
  assert.equal(context.experienceControl.value, 'landscape');
  assert.equal(context.experienceStatus.textContent, 'Could not switch world. no world');
  assert.equal(context.experienceControl.disabled, false);
});
