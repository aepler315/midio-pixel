// The audit's remaining pure instrument parts: the live callback summary,
// the CPU profile summary, and the governor trace runner whose results the
// audit's section 4.4 quotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as liveInstrument from '../tools/range-live-callbacks.mjs';
import { summarizeCallbacks } from '../tools/range-live-callbacks.mjs';
import { summarizeProfile } from '../tools/cpuprofile-top.mjs';
import { runTrace, scenarios } from '../tools/perf-governor-sim.mjs';

test('callback summary: per-second rows, wait share and level changes', () => {
  const f = (at, ms, level, waits = {}) => ({ at, ms, level, waits, filteredOps: level ? 10 : 0, ops2d: 100 });
  const frames = [f(1000, 10, 0, { 'gl1.getError': 4 }), f(1500, 20, 0, { '2d.getImageData': 10 }), f(2100, 30, 1), f(2600, 10, 1)];
  const s = summarizeCallbacks(frames, 1000);
  assert.equal(s.total.callbacks, 4);
  assert.equal(s.total.waitShare, 14 / 70);
  assert.deepEqual(s.total.waits, { 'gl1.getError': 4, '2d.getImageData': 10 });
  assert.deepEqual(s.levelChanges, [{ atSec: 1.1, from: 0, to: 1 }]);
  assert.deepEqual(s.perSecond.map((r) => [r.second, r.callbacks, r.levelMin, r.levelMax, r.filteredOpsPerCallback]), [[0, 2, 0, 0, 0], [1, 2, 1, 1, 10]]);
  assert.equal(s.perSecond[1].workMaxMs, 30);
  assert.equal(summarizeCallbacks([], 0).total, null);
});

test('profile summary: self time by function and inclusive time counted once per sample', () => {
  const node = (id, functionName, children = [], line = 0) => ({ id, callFrame: { functionName, url: 'http://x/src/a.js', lineNumber: line }, children });
  // root -> outer -> inner -> outer (recursion): outer counts once per sample.
  const profile = { nodes: [node(1, '(root)', [2]), node(2, 'outer', [3], 9), node(3, 'inner', [4], 19), node(4, 'outer', [], 9)],
    samples: [2, 3, 4, 4], timeDeltas: [1000, 2000, 3000, 4000] };
  const s = summarizeProfile(profile, { inclusive: ['outer', 'inner'] });
  assert.equal(s.totalMs, 10);
  assert.deepEqual(s.self, [['outer a.js:10', 8], ['inner a.js:20', 2]]);
  assert.deepEqual(Object.fromEntries(s.inclusive), { outer: 10, inner: 9 });
});

test('governor traces reproduce the audit: what recovers and what never does', () => {
  const byName = Object.fromEntries(scenarios().map((s, i) => [i + 1, { s, r: runTrace(s.frame, s) }]));
  assert.deepEqual(byName[1].r.changes, [], '1: healthy stays at 0');
  const t2 = byName[2].r.changes;
  assert.deepEqual([t2[0].from, t2[0].to], [0, 1]);
  assert.ok(t2.length >= 3, '2: level 0 is probed and falls again');
  assert.equal(byName[3].r.level, 1, '3: one 30 ms frame every 4 s blocks recovery');
  assert.equal(byName[4].r.level, 1, '4: 12.5 ms of work never shows headroom');
  assert.equal(byName[5].r.level, 1, '5: one 12 ms callback every 8 s blocks recovery');
  assert.equal(byName[6].r.level, 0, '6: recovers after the burst');
  assert.equal(byName[7].r.level, 0, '7: recovers after the burst');
  assert.equal(byName[8].r.level, 0, '8: recovers in the clean 12 s and holds 0 through the later hitches');
  assert.ok(byName[9].r.changes.some((c) => c.to === 4), '9: sheds to the first rung that costs less');
});

test('a trace is deterministic and carries the previous callback work, as the frame loop does', () => {
  const seen = [];
  const governor = { level: 0, beginWarmup() {}, sample(delta, now, { workMs }) { seen.push(workMs); } };
  runTrace((i) => ({ delta: 1000 / 60, work: i }), { seconds: 0.1, governor });
  assert.deepEqual(seen.slice(0, 3), [undefined, 0, 1]);
  const [a, b] = [0, 1].map(() => runTrace(scenarios()[1].frame, scenarios()[1]).changes);
  assert.deepEqual(a.map((c) => c.to), b.map((c) => c.to));
});

test('live summaries keep tool callback, product callback, sync waits and governor CPU separate', () => {
  const frames = [{ at: 10, ms: 23, productCallbackMs: 20, productSyncWaitMs: 7, governorCpuMs: 13,
    phase: 'playback', level: 0, waits: { 'gl.readPixels': 4 }, filteredOps: 0, ops2d: 2 }];
  const result = summarizeCallbacks(frames, 0);
  assert.equal(result.total.workMedianMs, 23);
  assert.equal(result.total.productCallbackMedianMs, 20);
  assert.equal(result.total.productSyncWaitMedianMs, 7);
  assert.equal(result.total.governorCpuMedianMs, 13);
  assert.equal(result.total.waitShare, 4 / 23, 'instrumented calls are not the product sync-wait signal');
});

test('live hardware dry runs are allowed but software and unknown GPU evidence are rejected', () => {
  assert.equal(typeof liveInstrument.parseArgs, 'function');
  assert.equal(typeof liveInstrument.hardwareRendererProblem, 'function');
  assert.equal(liveInstrument.parseArgs(['--out', '.smoke/test', '--view', 'teton-range', '--dry', '--hardware-gpu']).dry, true);
  for (const renderer of [null, '', 'unknown', 'WebKit WebGL', 'ANGLE (Google, SwiftShader Device)', 'llvmpipe (LLVM)']) {
    assert.ok(liveInstrument.hardwareRendererProblem(renderer), String(renderer));
  }
  assert.equal(liveInstrument.hardwareRendererProblem('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)'), null);
});

function callbackHarness() {
  assert.equal(typeof liveInstrument.installCallbackLog, 'function');
  let now = 0;
  const pending = [];
  const counters = { by: {}, waits: {}, canvas2d: {}, reset() { this.by = {}; this.waits = {}; this.canvas2d = { ops: 0, filteredOps: 0 }; } };
  const smw = { frameRates: { renderedFrames: 0 }, playbackState: { running: true, preparing: false, paused: false, status: 'ready' },
    sceneIdentity: { sceneEpoch: 1, analysisStage: 'opening', songSeed: 315 }, perfLevel: 0,
    sim: { heardTimeMs: 0 }, lastFrameTiming: null, rangeState: { viewId: 'teton-range' } };
  const sandbox = vm.createContext({ window: { __gl: counters, __SMW: smw, requestAnimationFrame(fn) { pending.push(fn); } },
    performance: { now: () => now }, structuredClone });
  vm.runInContext(`(${liveInstrument.installCallbackLog.toString()})()`, sandbox);
  const run = (fn) => { sandbox.window.requestAnimationFrame(fn); pending.shift()(now); };
  const advance = (ms) => { now += ms; };
  return { live: sandbox.window.__live, smw, counters, run, advance };
}

test('live callback capture counts fast 2D presentations and excludes slow HUD callbacks', () => {
  const h = callbackHarness();
  h.live.arm();
  h.run(() => { h.advance(25); h.counters.by.hud = { draws: 5 }; });
  h.run(() => {
    h.smw.frameRates.renderedFrames++;
    h.smw.lastFrameTiming = { frameId: 1, callbackMs: 0.4, workMs: 0.3, syncWaitMs: 0.1 };
    h.counters.canvas2d.ops = 1;
    h.advance(0.5);
  });
  assert.equal(h.live.frames.length, 1);
  assert.equal(h.live.frames[0].ms, 0.5);
  assert.equal(h.live.frames[0].frameId, 1);
  assert.equal(h.live.frames[0].governorCpuMs, 0.3);
  assert.equal(h.live.frames[0].phase, 'playback');
  h.smw.sceneIdentity = { ...h.smw.sceneIdentity, sceneEpoch: 2, analysisStage: 'full' };
  h.run(() => h.advance(2));
  assert.equal(h.live.transitions.at(-1).identity.analysisStage, 'full');
  const stopped = h.live.stop();
  h.run(() => { h.smw.frameRates.renderedFrames++; h.advance(100); });
  assert.equal(stopped.frames.length, 1);
  assert.equal(stopped.boundaries.stoppedAt, 27.5);
  assert.equal(stopped.boundaries.firstPresentedAt, 25);
});

test('live capture arms before upload, marks readiness and stops atomically before profile serialization', async () => {
  assert.equal(typeof liveInstrument.captureLivePlayback, 'function');
  const h = callbackHarness();
  const events = [];
  const sandbox = vm.createContext({ window: { __live: h.live, __SMW: h.smw }, performance: { now: () => 100 }, structuredClone });
  h.smw.renderReady = Promise.resolve({ status: 'ready' });
  const page = {
    evaluate: async (fn, arg) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg) ?? ''})`, sandbox),
    locator: () => ({ setInputFiles: async () => {
      assert.equal(h.live.on, true); assert.ok(events.includes('Profiler.start')); events.push('upload');
      h.run(() => { h.smw.frameRates.renderedFrames++; });
    } }),
    waitForFunction: async () => {},
    waitForTimeout: async () => { h.advance(20); },
  };
  const client = { send: async (method) => { events.push(method); if (method === 'Profiler.stop') { assert.equal(h.live.on, false); return { profile: { nodes: [] } }; } return {}; } };
  const result = await liveInstrument.captureLivePlayback({ page, client, audio: 'fixture.wav', seconds: 1 });
  assert.ok(events.indexOf('Profiler.start') < events.indexOf('upload'));
  assert.ok(events.indexOf('upload') < events.indexOf('Profiler.stop'));
  assert.equal(result.capture.boundaries.stoppedAt, 20);
  assert.deepEqual(result.profile, { nodes: [] });
});

test('live transitions retain catalog view changes without song-range stage keys', () => {
  const h = callbackHarness();
  h.smw.sceneIdentity = { ...h.smw.sceneIdentity, incomingViewId: 'catalog-a', incomingStageKey: null };
  h.live.arm();
  h.smw.sceneIdentity.incomingViewId = 'catalog-b';
  h.run(() => h.advance(1));
  assert.equal(h.live.transitions.length, 2);
  assert.equal(h.live.transitions[0].identity.incomingViewId, 'catalog-a');
  assert.equal(h.live.transitions[1].identity.incomingViewId, 'catalog-b');
});
