import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function frame(tRaf) {');
const end = source.indexOf('\nfunction applyShowAudio()', start);
const frameSource = source.slice(start, end);

function runtime({ draw = true, hidden = false, paused = false } = {}) {
  let clock = 50;
  const samples = [];
  const context = vm.createContext({ running: true, paused, playbackPreparing: false, lastRafMs: 0,
    lastRenderedWorkMs: 8, lastRenderedSyncWaitMs: 3, performance: { now: () => clock }, document: { hidden },
    syncWaitMs: 0, resetSyncWaits() { context.syncWaitMs = 0; }, takeSyncWaits() { const ms = context.syncWaitMs; context.syncWaitMs = 0; return ms; },
    noteFrameGap() {}, perfGovernor: { level: 0, sample: (...args) => samples.push(args) },
    playbackFps: () => 30, fittedPerfLevel: 0, fitCanvas() {}, emaFps: () => 60,
    fpsEma: 60, fpsHudVisible: false, hudIdleTick() {}, keepAwake: { tick() {} },
    audioEngine: { nowMs: 100 }, captureClock: { renderNow: n => n, leadMs: 0 },
    sim: {}, lastNowMs: 0, simTime: 0, acc: 0, STEP_MS: 1000 / 60,
    advanceFixedStepClock: () => ({ lastNowMs: 100, simTime: 100, acc: 0 }),
    bulkExportArmed: false, cameraRun: null, playbackCadence: { shouldDraw: () => draw },
    presentedFps: { sample() {} }, requestAnimationFrame: () => 1,
    rafHandle: null, pendingCaptureOptions: null,
    renderer: { draw: () => { clock += 9; return { presented: true }; }, getCaptureSource: () => ({}) },
    syncCaptionDetails() {}, drawErrors: { record: () => false },
    visionLoop: { maybeSample() { clock += 1; } }, debugOverlay: { render() {} },
    songRecorder: null, updateRecordReadout() {},
    isSongComplete: () => false,
    grooveSaveDue: false, recalibration: { active: false }, applyShowAudio() {},
  });
  // Run the production callback with neutral HUD/audio boundaries.
  const script = new vm.Script(frameSource);
  script.runInContext(context);
  return { context, samples, run: t => vm.runInContext(`frame(${t})`, context) };
}

test('a skipped FPS-cap draw passes the previous work once, then no timing evidence', () => {
  const r = runtime();
  r.context.playbackCadence.shouldDraw = () => false;
  r.run(17);
  assert.equal(r.samples[0][2].workMs, 8);
  assert.equal(r.context.lastRenderedWorkMs, null);
  r.run(34);
  assert.equal(r.samples[1][2].workMs, null);
});

test('paused and hidden callbacks discard stale rendered-work timing', () => {
  for (const state of [{ paused: true }, { hidden: true }]) {
    const r = runtime(state);
    r.context.playbackCadence.shouldDraw = () => false;
    r.run(17);
    assert.equal(r.context.lastRenderedWorkMs, null);
    assert.equal(r.samples.length, 0);
  }
});

test('only a successful visible rendered callback records CPU work, including post-frame work', () => {
  const r = runtime();
  r.run(17);
  assert.equal(r.context.lastRenderedWorkMs, 10);
  r.run(50);
  assert.equal(r.samples[1][2].workMs, 10);
});

test('a failed or hidden presentation cannot provide headroom evidence', () => {
  for (const hidden of [false, true]) {
    const r = runtime({ hidden });
    if (!hidden) r.context.renderer.draw = () => { throw new Error('fixture failure'); };
    r.run(17);
    assert.equal(r.context.lastRenderedWorkMs, null);
  }
});

test('the previous callback synchronous wait travels with its work, never larger than it', () => {
  const r = runtime();
  r.context.renderer.draw = () => { r.context.performance.now = ((t) => () => t)(r.context.performance.now() + 9); r.context.syncWaitMs += 4; return { presented: true }; };
  r.run(17);
  assert.equal(r.samples[0][2].syncWaitMs, 3, 'the wait recorded with the previous work');
  assert.equal(r.context.lastRenderedSyncWaitMs, 4);
  r.run(34);
  assert.equal(r.samples[1][2].syncWaitMs, 4);
  r.context.renderer.draw = () => { r.context.syncWaitMs += 500; return { presented: true }; };
  r.run(51);
  assert.ok(r.context.lastRenderedSyncWaitMs <= r.context.lastRenderedWorkMs);
  r.context.playbackCadence.shouldDraw = () => false;
  r.run(68);
  assert.equal(r.context.lastRenderedSyncWaitMs, null, 'a skipped draw records no wait');
});
