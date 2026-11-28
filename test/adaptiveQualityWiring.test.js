import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PerfGovernor, MAX_LEVEL } from '../src/render/PerfGovernor.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function callbackWorkMs(');
const end = source.indexOf('\nfunction applyShowAudio()', start);
const frameSource = source.slice(start, end);

function runtime({ draw = true, hidden = false, paused = false } = {}) {
  let clock = 50;
  const samples = [];
  const context = vm.createContext({ running: true, paused, playbackPreparing: false, lastRafMs: 0,
    cameraStudioStatusAt: -Infinity, syncCameraStudio() {},
    renderedFrames: 0, lastRenderAtMs: null, lastFrameTiming: null, sceneEpoch: 1,
    lastRenderedWorkMs: 8, lastRenderedSyncWaitMs: 0, performance: { now: () => clock }, document: { hidden },
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
  assert.equal(r.samples[0][2].syncWaitMs, 0, 'the wait recorded with the previous work');
  assert.equal(r.context.lastRenderedSyncWaitMs, 4);
  const work = r.context.lastRenderedWorkMs;
  r.run(34);
  assert.equal(r.samples[1][2].syncWaitMs, 4);
  assert.equal(r.samples[1][2].workMs, work - 4, 'the governor sees work outside the wait');
  r.context.renderer.draw = () => { r.context.syncWaitMs += 500; return { presented: true }; };
  r.run(51);
  assert.ok(r.context.lastRenderedSyncWaitMs <= r.context.lastRenderedWorkMs);
  r.context.playbackCadence.shouldDraw = () => false;
  r.run(68);
  assert.equal(r.context.lastRenderedSyncWaitMs, null, 'a skipped draw records no wait');
});

test('a 15 ms callback with 9 ms of timed wait reports 6 ms of work; without timers, the whole callback', () => {
  const r = runtime();
  r.context.lastRenderedWorkMs = 15; r.context.lastRenderedSyncWaitMs = 9;
  r.run(17);
  assert.equal(r.samples[0][2].workMs, 6);
  const q = runtime();
  q.context.lastRenderedWorkMs = 15; q.context.lastRenderedSyncWaitMs = null;
  q.run(17);
  assert.equal(q.samples[0][2].workMs, 15);
});


test('timeline rebuild carries only the live level and starts a fresh timing record', () => {
  const begin = source.indexOf('  const retainedPerfLevel =', source.indexOf('function startTimeline('));
  const end = source.indexOf('  // World construction', begin);
  const rebuildSetup = new vm.Script(source.slice(begin, end));
  const timeline = { durationMs: 120000, worldId: 'alpine' };
  const presentation = {};
  const playBuffer = { length: 5292735, sampleRate: 44100 };
  for (const [label, options, expected, durationMs = timeline.durationMs] of [
    ['same song', {}, 4],
    ['different song', { timelineData: { ...timeline } }, 1],
    ['new presentation', { previousPresentation: {} }, 1],
    ['fresh start', { keepPerfLevel: false }, 1],
    ['export', { exportMode: true }, 2],
    ['decoded 2D track', { songprint2D: true, playBuffer }, 4, playBuffer.length / playBuffer.sampleRate * 1000],
  ]) {
    const governor = new PerfGovernor({ startLevel: 4 });
    governor.sample(16, 100, { workMs: 8 });
    const context = vm.createContext({
      PerfGovernor, PERF_MAX_LEVEL: MAX_LEVEL, perfGovernor: governor, running: true,
      keepPerfLevel: true, lastTimelineData: timeline, timelineData: timeline,
      previousPresentation: presentation, rangePresentation: presentation,
      exportMode: false, exportQualityLevel: 2, perfStartLevel: 1, fixturePerfLevel: null,
      renderQualityLevel: () => 0, generalQuality: 'auto', effectivePresentation: () => ({ quality: 'auto' }),
      preservePause: false, keepAudio: false, startAtMs: 0, songprint2D: false, playBuffer: null,
      conductor: { load(data) { this.durationMs = data.durationMs; } },
      resolveDurationMs: (_, duration) => duration, getWorld: () => null,
      ensureRidgeMusicSession() {}, retainPerformanceScene() {}, stopTimeline() {}, fitCanvas() {},
      lastRenderedWorkMs: 31, lastRenderedSyncWaitMs: 7, ...options,
    });
    rebuildSetup.runInContext(context);
    assert.equal(context.conductor.durationMs, durationMs, label);
    assert.equal(context.timelineData.durationMs, 120000, 'the shared analysis retains its duration');
    assert.equal(context.perfGovernor.level, expected, label);
    assert.equal(context.perfGovernor.record.wholeRun.periodMs.count, 0, label);
    assert.equal(context.lastRenderedWorkMs, null, label);
    assert.equal(context.lastRenderedSyncWaitMs, null, label);
    assert.equal(context.perfGovernor.holdQuality, label === 'export', label);
  }
});
