import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRenderReadyPlayback } from '../src/render/RenderReadyPlayback.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function production(name, bindings) {
  const declaration = main.indexOf(`function ${name}(`);
  assert.ok(declaration >= 0);
  const start = main.slice(0, declaration).endsWith('async ') ? declaration - 6 : declaration;
  const end = main.indexOf('\n}\n', start) + 3;
  const context = vm.createContext(bindings);
  vm.runInContext(main.slice(start, end), context);
  return context;
}

function timelineGate(overrides = {}) {
  const owner = main.indexOf('    const owner = sim, ownedRenderer = renderer');
  const start = main.lastIndexOf('  if (!exportMode) {', owner);
  const end = main.indexOf('\n}\n', owner);
  assert.ok(start >= 0 && end > owner);
  const events = [];
  const bindings = { exportMode: false, sim: {}, renderer: {}, rangePresentation: {}, loadGen: 1, running: true,
    playBuffer: {}, waitForLandscape: true, keepAudio: false, lastAudioBuffer: null,
    renderReadyPromise: null, renderPlayback: createRenderReadyPlayback(), waitForScenicReady: async () => {},
    extra: {}, startedAt: 15950, paused: false, captureClock: { leadMs: 0 },
    audioEngine: { playBuffer: () => events.push('source'), resume: () => events.push('resume'),
      pause: () => events.push('pause'), ctx: { suspend: () => events.push('suspend') } },
    acc: 0, lastRafMs: null, lastNowMs: 0, playbackPreparing: false, rafHandle: null, restartRenderPreparation: null,
    terrainRecordingHold: null, holdRecordingForTerrain() {}, resumeRecordingAfterTerrain() {},
    playbackCadence: { reset() {} }, presentedFps: { reset() {} }, perfGovernor: { beginWarmup() {} },
    performance: { now: () => 0 }, revealPlayback() {}, frame() {},
    requestAnimationFrame: () => { events.push('raf'); return 1; }, updatePauseButtonUI() {},
    progressEl: { classList: { add() {} } }, showErrorBanner: message => events.push(message), ...overrides };
  const context = vm.createContext(bindings);
  vm.runInContext(main.slice(start, end), context);
  return { context, events };
}

test('confirmed recordings delegate their only audio start to timeline readiness', () => {
  const starts = [], buffer = {};
  const context = production('startConfirmedWorld', {
    resolveWorldId: id => id, stopWorldPreview() {}, closeWorldChooser() {},
    readBulkExportFromUrl: () => null, lastWorldId: null, muteTimelineSynth: false,
    audioEngine: { resume() {}, playBuffer: (...args) => starts.push(args) },
    startTimeline: () => {}, running: false, lastAudioBuffer: null,
  });
  context.startConfirmedWorld({ data: {}, extra: { playBuffer: buffer } }, 'range');
  assert.deepEqual(starts, [], 'a caller must not start a source before the readiness gate releases it');
});

test('a paused seek delegates its recording restart instead of starting before terrain is ready', () => {
  const starts = [], draws = [], buffer = {}, renderer = { composer: {}, draw: (_sim, _alpha, options) => draws.push(options) };
  const context = production('seekSong', { running: true, paused: true, playbackPreparing: true, lastAudioBuffer: buffer,
    sim: { songSeed: 315, conductor: { durationMs: 30000 } }, renderer, lastTimelineData: {},
    audioEngine: { nowMs: 0, playBuffer: (...args) => starts.push(args), ctx: { suspend() {} } },
    startTimeline() {}, updatePauseButtonUI() {},
  });
  context.seekSong(15950);
  assert.deepEqual(starts, []);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].preparing, true, 'the immediate seek paint cannot consume incomplete semantic captures');
});

test('preparing playback cannot advance the live frame clock', () => {
  let reads = 0;
  const context = production('frame', { running: true, paused: false, playbackPreparing: true,
    rafHandle: null, requestAnimationFrame: () => 1,
    audioEngine: { get nowMs() { reads++; throw new Error('clock advanced while preparing'); } },
    lastRafMs: null, hudIdleTick() {}, keepAwake: { tick() {} },
  });
  context.frame(1000);
  assert.equal(reads, 0);
});

test('preparing playback cannot accept scored beat taps', () => {
  let taps = 0;
  const context = production('beatTap', { running: true, paused: false, playbackPreparing: true,
    sim: { onBeatTap() { taps++; } }, audioEngine: { nowMs: 0 },
    visualNow: n => n, effectiveOutputLatencyMs: () => 0, recalibration: { active: false },
  });
  context.beatTap(); assert.equal(taps, 0);
});

test('synchronous export arming can await terrain without accepting a placeholder frame', () => {
  const start = main.indexOf('  if (exportMode) {\n    // No rAF loop:');
  const end = main.indexOf('  } else if (!waitForLandscape)', start) + 3;
  assert.ok(start >= 0 && end > start);
  let aborted = 0;
  const bindings = { exportMode: true, sim: {}, renderer: { draw: () => ({ presented: false, reason: 'terrain-not-ready' }) },
    abortBulkExport() { aborted++; }, failBulkExport: message => new Error(message) };
  assert.doesNotThrow(() => vm.runInNewContext(main.slice(start, end), bindings));
  assert.equal(aborted, 0, 'tools must retain their armed stepped clock until rangeReady can resolve');
  bindings.renderer.draw = () => ({ presented: false, reason: 'allocation-denied' });
  assert.throws(() => vm.runInNewContext(main.slice(start, end), bindings), /allocation-denied/);
  assert.equal(aborted, 1, 'unrelated presentation failures still abort export');
});

test('a recording startup exception fails the actual timeline gate before its audio source starts', async () => {
  const { context, events } = timelineGate({ extra: { beforePlayback() { throw new Error('Recorder unavailable'); } } });
  const result = await context.renderReadyPromise;
  assert.equal(result.status, 'failed');
  assert.equal(context.paused, true);
  assert.equal(context.playbackPreparing, false);
  assert.ok(events.includes('pause'));
  assert.ok(events.some(event => event.includes('Recorder unavailable')));
  assert.ok(!events.includes('source') && !events.includes('resume') && !events.includes('raf'));
});

test('a prepared paused seek releases exactly one frame loop with the audio context suspended', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const { context, events } = timelineGate({ paused: true, waitForScenicReady: () => ready });
  await Promise.resolve();
  assert.equal(events.filter(event => event === 'raf').length, 0);
  release(); await context.renderReadyPromise;
  assert.equal(events.filter(event => event === 'source').length, 1);
  assert.equal(events.filter(event => event === 'raf').length, 1);
  assert.ok(events.includes('suspend') && !events.includes('resume'));
  assert.equal(context.paused, true);
});

test('switching to Trio while landscape startup is pending retargets the owned readiness preparation', async () => {
  let restarts = 0;
  const owner = { biomes: {}, setExperience() {} };
  const context = production('changeExperience', { resolveExperience: value => value, experienceRequest: 0,
    sim: owner, experience: 'landscape', running: true, experienceControl: {}, experienceStatus: {},
    rangePresentation: { dispose() {} }, renderer: { draw() {} },
    writeExperience() {}, displayStorage() {}, location: { href: 'https://example.test/' }, history: { replaceState() {} },
    URL, fitCanvas() {}, syncRangeTourControl() {}, worldSelectEl: null,
    playbackPreparing: true, restartRenderPreparation: () => { restarts++; },
  });
  await context.changeExperience('trio');
  assert.equal(context.experience, 'trio');
  assert.equal(restarts, 1, 'discarding the landscape must replace its pending readiness owner');
});

test('a retargeted main preparation cancels its old terrain waiter and starts the current scene once', async () => {
  let release;
  const oldReady = new Promise(resolve => { release = resolve; }), presentations = [];
  const { context, events } = timelineGate({ waitForScenicReady: ({ presentation }) => {
    presentations.push(presentation); return presentations.length === 1 ? oldReady : Promise.resolve();
  } });
  const oldPromise = context.renderReadyPromise;
  await Promise.resolve();
  const replacement = {};
  context.rangePresentation = replacement;
  context.restartRenderPreparation();
  const ready = await context.renderReadyPromise;
  assert.equal(ready.status, 'ready');
  assert.equal(presentations[1], replacement);
  release();
  assert.equal((await oldPromise).status, 'cancelled');
  assert.equal(events.filter(event => event === 'source').length, 1);
  assert.equal(events.filter(event => event === 'raf').length, 1);
});

test('pausing during render preparation immediately suspends the audio context', () => {
  let suspends = 0;
  const context = production('togglePause', { running: true, sim: {}, paused: false, playbackPreparing: true,
    renderPlayback: { status: 'preparing' }, playbackCadence: { reset() {} }, presentedFps: { reset() {} },
    audioEngine: { ctx: { suspend() { suspends++; } } }, updatePauseButtonUI() {},
  });
  context.togglePause();
  assert.equal(context.paused, true);
  assert.equal(suspends, 1);
});

test('an already paused preparation awaits real audio suspension before starting its buffer', async () => {
  let suspendReady;
  const suspended = new Promise(resolve => { suspendReady = resolve; });
  let sources = 0;
  const { context } = timelineGate({ paused: true, audioEngine: { playBuffer: () => { sources++; },
    pause() {}, ctx: { suspend: () => suspended } } });
  for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.equal(sources, 0, 'the source must not run during asynchronous AudioContext suspension');
  suspendReady(); await context.renderReadyPromise;
  assert.equal(sources, 1);
});

test('recording preparation ownership transfers across rebuilds and waits for an unpaused ready transport', () => {
  let holds = 0, resumes = 0;
  const context = production('holdRecordingForTerrain', { songRecorder: { recording: true,
    holdForPreparation() { holds++; return () => { resumes++; }; } }, terrainRecordingHold: null,
    paused: false, finishRecording() { assert.fail('a supported active recording should span the rebuild'); } });
  const releaseSource = main.indexOf('function resumeRecordingAfterTerrain(');
  vm.runInContext(main.slice(releaseSource, main.indexOf('\n}\n', releaseSource) + 3), context);
  context.holdRecordingForTerrain();
  context.terrainRecordingHold.ready = true;
  context.holdRecordingForTerrain();
  assert.equal(holds, 1, 'a replacement readiness owner must inherit the existing recorder hold');
  context.resumeRecordingAfterTerrain(); assert.equal(resumes, 0);
  context.terrainRecordingHold.ready = true; context.paused = true;
  context.resumeRecordingAfterTerrain(); assert.equal(resumes, 0);
  context.paused = false; context.resumeRecordingAfterTerrain();
  assert.equal(resumes, 1); assert.equal(context.terrainRecordingHold, null);
});

test('the actual readiness gate releases its recording hold only after successful preparation', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; }), hold = { ready: false };
  let resumed = 0;
  const { context } = timelineGate({ terrainRecordingHold: hold, waitForScenicReady: () => ready,
    resumeRecordingAfterTerrain() { assert.equal(hold.ready, true); resumed++; } });
  await Promise.resolve(); assert.equal(resumed, 0);
  release(); await context.renderReadyPromise;
  assert.equal(resumed, 1);
});

test('a failed actual readiness gate retains the recorder hold without resuming it', async () => {
  const hold = { ready: false }; let resumed = 0, retained = 0;
  const { context } = timelineGate({ terrainRecordingHold: hold,
    waitForScenicReady: async () => { throw new Error('Terrain unavailable'); },
    holdRecordingForTerrain() { retained++; }, resumeRecordingAfterTerrain() { resumed++; } });
  await context.renderReadyPromise;
  assert.equal(resumed, 0); assert.equal(retained, 1); assert.equal(hold.ready, false);
});

test('cancelling a pending actual readiness gate cannot resume its held recording', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; }), hold = { ready: false };
  let resumed = 0;
  const { context } = timelineGate({ terrainRecordingHold: hold, waitForScenicReady: () => ready,
    resumeRecordingAfterTerrain() { resumed++; } });
  await Promise.resolve(); context.renderPlayback.cancel(); release();
  assert.equal((await context.renderReadyPromise).status, 'cancelled');
  assert.equal(resumed, 0); assert.equal(hold.ready, false);
});

test('a platform that refuses recorder suspension saves the file before waiting for terrain', () => {
  let saved = 0;
  const context = production('holdRecordingForTerrain', { songRecorder: { recording: true,
    paused: false, holdForPreparation: () => null }, terrainRecordingHold: null,
    finishRecording() { saved++; } });
  context.holdRecordingForTerrain();
  assert.equal(saved, 1); assert.equal(context.terrainRecordingHold, null);
});
