import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeCameraStudioSettings } from '../src/world/alpine/CameraStudio.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

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
