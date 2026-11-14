import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeCameraStudioSettings } from '../src/world/alpine/CameraStudio.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('full camera terrain can be selected visibly while preserving the song position and pause', () => {
  const start = main.indexOf('function applyTourMode(choice) {');
  assert.ok(start >= 0, 'one route action serves the Settings terrain selector');
  const end = main.indexOf('\n}\n', start) + 3;
  let restarted, mode;
  const context = vm.createContext({ videoExportSession: { busy: false }, bulkExportArmed: false,
    settings: { markApplied() {} }, reelSaver: { busy: false }, snapshotBusy: false, paused: true, running: true,
    localStorage: { setItem() {} }, URL, location: { href: 'http://localhost/' }, history: { replaceState() {} },
    rangePresentation: { setTourMode(value) { mode = value; } }, renderer: {},
    applyTerrainTourPolicy() {}, getWorld: () => ({ kind: 'alpine' }),
    lastTimelineData: { worldId: 'range', chapterState: {} }, cameraRun: { forgetTours() {} },
    sim: { songSeed: 7 }, audioEngine: { nowMs: 5000 }, lastStartExtra: {},
    startTimeline(data, options) { restarted = { data, options }; },
    syncRangeTourControl() {}, syncCameraStudio() {}, updatePauseButtonUI() {},
  });
  const rebuildStart = main.indexOf('function rebuildSceneInPlace(overrides = {}) {');
  const rebuildEnd = main.indexOf('\n}\n', rebuildStart) + 3;
  vm.runInContext(main.slice(rebuildStart, rebuildEnd) + main.slice(start, end) + '\napplyTourMode("tetons");', context);
  assert.equal(mode, 'tetons');
  assert.equal(restarted.options.songSeed, 7);
  assert.equal(restarted.options.startAtMs, 5000);
  assert.equal(restarted.options.keepAudio, true);
  assert.equal(restarted.options.preservePause, true);
  assert.equal(context.paused, true);
});

test('full terrain can be selected on the title screen before any song exists', () => {
  const start = main.indexOf('function applyTourMode(choice) {');
  const end = main.indexOf('\n}\n', start) + 3;
  let selected;
  const context = vm.createContext({ videoExportSession: { busy: false }, bulkExportArmed: false,
    settings: { markApplied() {} }, reelSaver: { busy: false }, snapshotBusy: false, paused: false, running: false,
    localStorage: { setItem() {} }, URL, location: { href: 'http://localhost/' }, history: { replaceState() {} },
    rangePresentation: { setTourMode(mode) { selected = mode; } }, renderer: null,
    applyTerrainTourPolicy() {}, getWorld: () => assert.fail('there is no selected world yet'),
    lastTimelineData: null, cameraRun: null, sim: null, audioEngine: null,
    syncRangeTourControl() {}, syncCameraStudio() {},
  });
  const rebuildStart = main.indexOf('function rebuildSceneInPlace(overrides = {}) {');
  const rebuildEnd = main.indexOf('\n}\n', rebuildStart) + 3;
  vm.runInContext(main.slice(rebuildStart, rebuildEnd) + main.slice(start, end) + '\napplyTourMode("tetons");', context);
  assert.equal(selected, 'tetons');
});

test('paused composition redraws settled terrain only for the same scene and settings', async () => {
  const start = main.indexOf('async function redrawPausedCameraStudio() {');
  assert.ok(start >= 0, 'paused preview has an asynchronous settle lifecycle');
  const end = main.indexOf('\n}\n', start) + 3;
  let finish, draws = 0;
  const settings = normalizeCameraStudioSettings({ enabled: true });
  const context = vm.createContext({ paused: true, running: true, snapshotBusy: false, playbackPreparing: false,
    videoExportSession: { busy: false }, bulkExportArmed: false, reelSaver: { busy: false },
    sim: { cameraStudioSettings: settings }, renderer: { draw() { draws++; } }, loadGen: 1,
    cameraStudioRedraw: null, AbortController, console,
    rangePresentation: { settle: () => new Promise(resolve => { finish = resolve; }) }, syncCameraStudio() {},
    showErrorBanner: assert.fail,
  });
  vm.runInContext(main.slice(start, end), context);
  const pending = context.redrawPausedCameraStudio();
  assert.equal(draws, 1);
  finish(true); await pending;
  assert.equal(draws, 2, 'newly refined trees and terrain are displayed without Resume');
  const obsolete = context.redrawPausedCameraStudio();
  assert.equal(draws, 3);
  context.sim = { cameraStudioSettings: settings }; context.loadGen++;
  finish(true); await obsolete;
  assert.equal(draws, 3, 'stale refinement never redraws over a replacement song');
});
test('a multi-detail snapshot holds one composition while Camera Studio input is locked', () => {
  const start = main.indexOf('const cameraStudioPanel = new CameraStudioPanel(');
  const end = main.indexOf('\nlet cameraStudioStatusAt', start);
  const original = normalizeCameraStudioSettings({ enabled: true, fovDeg: 35 });
  let writes = 0, resets = 0;
  const context = vm.createContext({
    CameraStudioPanel: class { constructor(options) { Object.assign(this, options); } },
    document: { getElementById: () => ({}), body: {} },
    cameraStudioSettings: original, sim: { cameraStudioSettings: original },
    videoExportSession: { busy: false }, bulkExportArmed: false, reelSaver: { busy: false }, snapshotBusy: true,
    normalizeCameraStudioSettings, writeCameraStudioSettings() { writes++; }, displayStorage: () => null,
    syncCameraStudio() {}, paused: false, rangeUserCamera: { reset() { resets++; } },
  });
  vm.runInContext(main.slice(start, end)
    + '\ncameraStudioPanel.onChange({enabled:true,fovDeg:20}); cameraStudioPanel.onRecenter();', context);
  assert.strictEqual(context.sim.cameraStudioSettings, original);
  assert.equal(writes, 0);
  assert.equal(resets, 0);
});

test('camera studio marks its fixed overlay busy while snapshots borrow the canvas', () => {
  const start = main.indexOf('function syncCameraStudio() {');
  const end = main.indexOf('\n}\n', start) + 3;
  let state;
  const context = vm.createContext({ rangePresentation: { status: () => ({}) },
    cameraStudioPanel: { setState(value) { state = value; } },
    cameraStudioSettings: { enabled: true }, running: true, playbackPreparing: false,
    sim: { biomes: { world: { kind: 'alpine' } } },
    videoExportSession: { busy: false }, bulkExportArmed: false, reelSaver: { busy: false }, snapshotBusy: true,
  });
  vm.runInContext(main.slice(start, end) + '\nsyncCameraStudio();', context);
  assert.equal(state.busy, true);
});

for (const busy of ['video', 'bulk', 'reel', 'snapshot']) {
  test(`unified camera settings cannot rebuild the scene during ${busy} capture`, () => {
    const start = main.indexOf('function settingBlockedReason(id) {');
    const end = main.indexOf('\n}\n', start) + 3;
    const context = vm.createContext({ videoExportSession: { busy: busy === 'video' },
      bulkExportArmed: busy === 'bulk', reelSaver: { busy: busy === 'reel' }, snapshotBusy: busy === 'snapshot' });
    vm.runInContext(main.slice(start, end), context);
    assert.ok(context.settingBlockedReason('rangeTour'));
  });
}
