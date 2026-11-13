import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PerfGovernor, MAX_LEVEL } from '../src/render/PerfGovernor.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function production(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return main.slice(start, main.indexOf('\n}\n', start) + 3);
}

test('a pre-load fixture pin is applied before the first canvas fit and survives scene rebuilds', () => {
  const fitted = [];
  const context = vm.createContext({ PerfGovernor, PERF_MAX_LEVEL: MAX_LEVEL,
    perfGovernor: null, fixturePerfLevel: null, perfStartLevel: 0, generalQuality: 'high',
    renderQualityLevel: () => 0, exportMode: false, exportQualityLevel: 0,
    effectivePresentation: () => ({ quality: 'auto' }),
    fitCanvas: () => fitted.push(context.perfGovernor.level),
  });
  vm.runInContext(production('setFixtureLevel'), context);
  context.setFixtureLevel(3);
  assert.deepEqual(fitted, [], 'setting a fixture on the title does not draw a frame');
  const start = main.indexOf('  // A fresh governor per song');
  const end = main.indexOf('  fitCanvas(); // sync the new governor', start);
  assert.ok(start >= 0 && end > start);
  const construct = main.slice(start, main.indexOf('\n', end));
  const governors = [];
  // This is the same startTimeline block on initial load, whole-analysis
  // adoption and seek; the preference must outlive every replaced governor.
  for (let rebuild = 0; rebuild < 3; rebuild++) {
    vm.runInContext(construct, context);
    governors.push(context.perfGovernor);
    assert.equal(context.perfGovernor.fixtureLevel, 3);
    assert.equal(context.perfGovernor.level, 3);
  }
  assert.equal(new Set(governors).size, 3);
  assert.deepEqual(fitted, [3, 3, 3]);
  assert.throws(() => context.setFixtureLevel(-1), /fixture quality/);
  assert.equal(context.fixturePerfLevel, 3, 'an invalid pin cannot replace the saved preference');
  context.setFixtureLevel(null);
  vm.runInContext(construct, context);
  assert.equal(context.perfGovernor.fixtureLevel, null);
  assert.equal(context.perfGovernor.level, 0);
});

function frameRuntime() {
  let clock = 50;
  const context = vm.createContext({ running: true, paused: false, playbackPreparing: false,
    lastRafMs: null, lastRenderedWorkMs: null, lastRenderedSyncWaitMs: null,
    renderedFrames: 0, lastRenderAtMs: null, lastFrameTiming: null, sceneEpoch: 1,
    performance: { now: () => clock }, document: { hidden: false },
    resetSyncWaits() {}, takeSyncWaits: () => 4,
    noteFrameGap() {}, perfGovernor: { level: 0, sample() {} },
    playbackFps: () => 30, fittedPerfLevel: 0, fitCanvas() {}, emaFps: () => 60,
    fpsEma: 60, fpsHudVisible: false, hudIdleTick() {}, keepAwake: { tick() {} },
    audioEngine: { nowMs: 100 }, captureClock: { renderNow: n => n, leadMs: 0 },
    sim: {}, lastNowMs: 0, simTime: 0, acc: 0, STEP_MS: 1000 / 60,
    advanceFixedStepClock: () => ({ lastNowMs: 100, simTime: 100, accumulatorMs: 0 }),
    bulkExportArmed: false, cameraRun: null, playbackCadence: { shouldDraw: () => true },
    presentedFps: { sample() {} }, requestAnimationFrame: () => 1,
    rafHandle: null, pendingCaptureOptions: null,
    renderer: { draw: () => { clock += 9; return { presented: true, frameId: 5, generation: 2 }; }, getCaptureSource: () => ({}) },
    syncCaptionDetails() {}, drawErrors: { record: () => false },
    visionLoop: { maybeSample() { clock += 1; } }, debugOverlay: { render() {} },
    songRecorder: null, updateRecordReadout() {}, isSongComplete: () => false,
    grooveSaveDue: false, recalibration: { active: false }, applyShowAudio() {},
  });
  const start = main.indexOf('function callbackWorkMs(');
  vm.runInContext(main.slice(start, main.indexOf('\nfunction applyShowAudio()', start)), context);
  return context;
}

test('only presented playback callbacks advance frame identity, with matching governor work and waits', () => {
  const context = frameRuntime();
  context.frame(17);
  assert.equal(context.renderedFrames, 1);
  assert.equal(context.lastRenderAtMs, 17);
  assert.deepEqual(JSON.parse(JSON.stringify(context.lastFrameTiming)), {
    frameId: 1, rafAtMs: 17, rafDeltaMs: null, sceneEpoch: 1, callbackMs: 10, workMs: 6, syncWaitMs: 4,
    presentationId: 5, presentationGeneration: 2,
  });
  const first = context.lastFrameTiming;
  context.playbackPreparing = true;
  context.frame(34);
  context.playbackPreparing = false;
  context.paused = true;
  context.frame(51);
  context.paused = false;
  context.playbackCadence.shouldDraw = () => false;
  context.frame(68);
  context.playbackCadence.shouldDraw = () => true;
  context.renderer.draw = () => ({ presented: false });
  context.frame(85);
  assert.equal(context.renderedFrames, 1);
  assert.strictEqual(context.lastFrameTiming, first, 'skipped/preparing/failed draws cannot masquerade as a new frame');
  context.sceneEpoch = 2;
  context.renderer.draw = () => ({ presented: true, frameId: 1, generation: 1 });
  context.frame(102);
  assert.equal(context.renderedFrames, 2, 'new renderers may restart their IDs; playback IDs stay monotonic');
  assert.equal(context.lastFrameTiming.sceneEpoch, 2);
  assert.equal(context.lastFrameTiming.rafDeltaMs, 17, 'raw callback cadence is independent of delivered frame spacing');
  assert.equal(context.lastFrameTiming.presentationId, 1);
  assert.equal(context.lastFrameTiming.syncWaitMs, 1, 'reported waits cannot exceed callback time');
  assert.equal(context.lastFrameTiming.workMs, 0);
});

test('scene identity follows the simulation analysis even when the loaded timeline upgrades in place', () => {
  const data = { opening: { analyzedMs: 12000 }, sourceTrack: { id: 'track-1' }, ridgeMusicSession: { stateKey: 'song-identity' } };
  const context = vm.createContext({ sim: { songSeed: 7, worldId: 'range', analysisOpening: data.opening },
    lastTimelineData: data, loadGen: 4, sceneGeneration: 4, sceneEpoch: 1, sceneStartMs: 0, sceneStartedAtMs: 100 });
  vm.runInContext(production('sceneIdentitySnapshot'), context);
  delete data.opening;
  assert.equal(context.sceneIdentitySnapshot().analysisStage, 'opening');
  assert.equal(context.sceneIdentitySnapshot().analyzedMs, 12000);
  context.sim = { songSeed: 7, worldId: 'range', analysisOpening: null };
  context.sceneEpoch = 2;
  context.sceneStartMs = 14000;
  const full = context.sceneIdentitySnapshot();
  assert.equal(full.analysisStage, 'full');
  assert.equal(full.sceneEpoch, 2);
  assert.equal(full.generation, 4);
  assert.equal(full.songSeed, 7);
  assert.equal(full.ridgeStateKey, 'song-identity');
  assert.equal(full.sourceTrack.id, 'track-1');
  assert.equal(full.sceneStartMs, 14000);
});

test('scene identity reports the active prepared stage, without substituting planned or stale views', () => {
  const presentation = {
    active: true, runtimeState: 'ready', viewId: 'catalog-outgoing', incomingViewId: 'song-range-incoming',
    frame: { viewFromId: 'catalog-outgoing', viewToId: 'song-range-incoming' },
    scene: { contextLost: false, prepared: new Map([
      ['catalog-outgoing', { view: { id: 'catalog-outgoing' } }],
      ['song-range-incoming', { view: { id: 'song-range-incoming', songRange: { key: 'actual-stage-key' } } }],
    ]) },
    sceneByBiome: new Map([['alpine', { songRange: true, view: { id: 'planned-only', songRange: { key: 'unused-key' } } }]]),
    snapshot() { assert.fail('per-frame identity must not build full terrain diagnostics'); },
  };
  const context = vm.createContext({ sim: { songSeed: 7, worldId: 'range', analysisOpening: null, biomes: { rangePresentation: presentation } },
    lastTimelineData: {}, loadGen: 4, sceneGeneration: 4, sceneEpoch: 1, sceneStartMs: 0, sceneStartedAtMs: 100 });
  vm.runInContext(production('sceneIdentitySnapshot'), context);
  const current = context.sceneIdentitySnapshot();
  assert.equal(current.viewId, 'catalog-outgoing');
  assert.equal(current.stageKey, null, 'catalog scenery is not the planned composed stage');
  assert.equal(current.incomingViewId, 'song-range-incoming');
  assert.equal(current.incomingStageKey, 'actual-stage-key');
  for (const state of [{ active: false }, { runtimeState: 'loading' }, { scene: { ...presentation.scene, contextLost: true } }]) {
    const previous = { ...presentation };
    Object.assign(presentation, state);
    assert.equal(context.sceneIdentitySnapshot().viewId, null);
    assert.equal(context.sceneIdentitySnapshot().incomingStageKey, null);
    Object.assign(presentation, previous);
  }
});

test('scene performance history preserves opening startup and decisions across full analysis and seeks, bounded to first plus latest', () => {
  const context = vm.createContext({ perfGovernor: null, sim: null, loadGen: 5,
    performanceHistoryGeneration: null, previousScenePerformance: [], omittedScenePerformance: 0,
    sceneGeneration: 5, sceneEpoch: 1, sceneStartMs: 0, sceneStartedAtMs: 100,
    lastTimelineData: { sourceTrack: { id: 'first-track' } }, performance: { now: () => 4000 }, structuredClone,
    rangePresentation: null, playbackFps: () => 60, presentedFps: { fps: 60 }, fpsEma: 60,
    lastFrameTiming: null, lastSyncWaits: () => ({ total: 0 }),
  });
  for (const name of ['sceneIdentitySnapshot', 'retainPerformanceScene', 'performanceSnapshot']) {
    vm.runInContext(production(name), context);
  }
  context.retainPerformanceScene();
  context.perfGovernor = new PerfGovernor();
  context.sim = { songSeed: 7, worldId: 'range', analysisOpening: { analyzedMs: 15000 } };
  context.retainPerformanceScene();
  assert.equal(context.previousScenePerformance.length, 0, 'empty preparation scenes do not claim the preserved startup slot');

  context.sceneEpoch = 2;
  for (let frame = 1; frame <= 100; frame++) context.perfGovernor.sample(30, 100 + frame * 30, { workMs: 8, syncWaitMs: 5 });
  context.retainPerformanceScene();
  const opening = context.previousScenePerformance[0];
  assert.equal(opening.scene.analysisStage, 'opening');
  assert.equal(opening.scene.generation, 5);
  assert.equal(opening.scene.startedAtMs, 100);
  assert.equal(opening.endedAtMs, 4000);
  assert.equal(opening.governor.startup.periodMs.count, 100);
  assert.equal(opening.governor.events[0].cause, 'period');
  context.perfGovernor.sample(30, 3130, { workMs: 8, syncWaitMs: 5 });
  context.lastTimelineData.sourceTrack.id = 'upgraded-metadata';
  assert.equal(opening.governor.startup.periodMs.count, 100, 'the archived governor record is immutable with respect to later samples');
  assert.equal(opening.scene.sourceTrack.id, 'first-track', 'later metadata mutation cannot rewrite the archived identity');

  for (let epoch = 3; epoch <= 12; epoch++) {
    context.sceneEpoch = epoch;
    context.sceneStartMs = epoch === 3 ? 3000 : 0;
    context.sceneStartedAtMs = epoch * 4000;
    context.sim = { songSeed: 7, worldId: 'range', analysisOpening: null };
    context.perfGovernor = new PerfGovernor();
    context.perfGovernor.sample(16, epoch * 4000 + 16, { workMs: 4, syncWaitMs: 2 });
    context.retainPerformanceScene();
  }
  assert.deepEqual(Array.from(context.previousScenePerformance, s => s.scene.sceneEpoch), [2, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(context.omittedScenePerformance, 3);
  const snapshot = context.performanceSnapshot();
  assert.equal(snapshot.recordScope, 'scene');
  assert.equal(snapshot.scene.sceneEpoch, 12);
  assert.equal(snapshot.governor.wholeRun.periodMs.count, 1, 'current governor retains its existing per-scene contract');
  assert.equal(snapshot.previousScenes[0].governor.startup.periodMs.count, 100);
  assert.equal(snapshot.previousScenesOmitted, 3);
  snapshot.previousScenes[0].governor.events.length = 0;
  assert.ok(context.previousScenePerformance[0].governor.events.length > 0, 'callers cannot mutate retained evidence');

  context.loadGen = 6;
  context.retainPerformanceScene();
  assert.equal(context.previousScenePerformance.length, 0, 'new loads do not retain the preceding song');
  assert.equal(context.omittedScenePerformance, 0);
  assert.equal(context.performanceHistoryGeneration, 6);
});

test('scene identity retains its construction generation while another audio selection is pending', () => {
  const context = vm.createContext({ sim: { songSeed: 7, worldId: 'range', analysisOpening: null },
    lastTimelineData: {}, loadGen: 8, sceneGeneration: 7, sceneEpoch: 3, sceneStartMs: 0, sceneStartedAtMs: 100 });
  vm.runInContext(production('sceneIdentitySnapshot'), context);
  assert.equal(context.sceneIdentitySnapshot().generation, 7);
});
