// The pure parts of the frame cost audit's instruments
// (docs/frame-cost-audit-2026-11-10.md): the live callback summary
// (tools/range-live-callbacks.mjs), the .cpuprofile summary
// (tools/cpuprofile-top.mjs) and the governor trace runner
// (tools/perf-governor-sim.mjs). The in-page counters are covered by
// rangeFrameCostCounters.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCallbacks } from '../tools/range-live-callbacks.mjs';
import { summarizeProfile } from '../tools/cpuprofile-top.mjs';
import { runTrace, jitterSource, scenarios } from '../tools/perf-governor-sim.mjs';
import { PerfGovernor, WARMUP_MS, MAX_LEVEL } from '../src/render/PerfGovernor.js';

const VSYNC_MS = 1000 / 60;

/** One callback record as installCallbackLog writes it. */
const cb = (at, ms, level, waits = {}, ops2d = 0, filteredOps = 0) => ({ at, ms, draws: 1, level, heardMs: null, waits, ops2d, filteredOps });

// Values are binary-exact so the sums compare without tolerances.
const FRAMES = [
  cb(1000, 10, 0, { 'gl.readPixels': 2 }, 4, 1),
  cb(1500, 20, 0, { 'gl.getError': 1 }, 6, 0),
  cb(1999, 30, 1, { 'gl.readPixels': 3 }, 2, 2),
  cb(2000, 40, 1, {}, 0, 0),
  cb(2600, 50, 0, { 'gl.getError': 4 }, 8, 3),
];

test('summarizeCallbacks: whole-run row from the callback log', () => {
  const { total } = summarizeCallbacks(FRAMES, 1000);
  // work sorted [10,20,30,40,50]: median = sorted[floor(2.5)], p95 = sorted[floor(4.75)].
  assert.deepEqual(total, {
    callbacks: 5, workMedianMs: 30, workP95Ms: 50, workMaxMs: 50,
    waitShare: 10 / 150, levelMin: 0, levelMax: 1,
    filteredOpsPerCallback: 6 / 5, ops2dPerCallback: 4,
    waits: { 'gl.readPixels': 5, 'gl.getError': 5 },
  });
});

test('summarizeCallbacks: per-second rows bucket from startAt', () => {
  const { perSecond } = summarizeCallbacks(FRAMES, 1000);
  assert.deepEqual(perSecond, [
    // startAt+999 is still second 0.
    { second: 0, callbacks: 3, workMedianMs: 20, workP95Ms: 30, workMaxMs: 30, waitShare: 6 / 60, levelMin: 0, levelMax: 1,
      filteredOpsPerCallback: 1, ops2dPerCallback: 4, waits: { 'gl.readPixels': 5, 'gl.getError': 1 } },
    // Two entries: the median is the upper middle (sorted[floor(n/2)]), not their mean.
    { second: 1, callbacks: 2, workMedianMs: 50, workP95Ms: 50, workMaxMs: 50, waitShare: 4 / 90, levelMin: 0, levelMax: 1,
      filteredOpsPerCallback: 1.5, ops2dPerCallback: 4, waits: { 'gl.getError': 4 } },
  ]);
});

test('summarizeCallbacks: level changes are timed from startAt', () => {
  assert.deepEqual(summarizeCallbacks(FRAMES, 1000).levelChanges, [
    { atSec: 0.999, from: 0, to: 1 },
    { atSec: 1.6, from: 1, to: 0 },
  ]);
  // A later origin moves every bucket and change time; nothing is dropped.
  const shifted = summarizeCallbacks(FRAMES, 500);
  assert.deepEqual(shifted.perSecond.map((r) => [r.second, r.callbacks]), [[0, 1], [1, 3], [2, 1]]);
  assert.deepEqual(shifted.levelChanges.map((c) => c.atSec), [1.499, 2.1]);
  assert.equal(shifted.total.callbacks, 5);
});

test('summarizeCallbacks: rows come out in second order and waits without work share 0', () => {
  const frames = [cb(3200, 0, 2, { 'gl.readPixels': 0 }), cb(1100, 0, 2), cb(2100, 4, 2, {}, 2, 1)];
  const summary = summarizeCallbacks(frames, 1000);
  assert.deepEqual(summary.perSecond.map((r) => r.second), [0, 1, 2]);
  assert.equal(summary.perSecond[0].waitShare, 0);
  assert.equal(summary.perSecond[1].waitShare, 0);
  assert.deepEqual(summary.levelChanges, []);
  assert.equal(summary.total.workMedianMs, 0);
});

test('summarizeCallbacks: an empty log has no rows', () => {
  assert.deepEqual(summarizeCallbacks([], 0), { total: null, levelChanges: [], perSecond: [] });
});

/** A V8-shaped profile: ancestry is in `children`, times in microseconds. */
function profile() {
  const frame = (functionName, file, lineNumber) => ({ functionName, url: file ? `http://127.0.0.1:4173/src/${file}` : '', lineNumber });
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)', '', -1), children: [2, 6] },
      { id: 2, callFrame: frame('frame', 'main.js', 9), children: [3, 4] },
      { id: 3, callFrame: frame('draw', 'render/Renderer.js', 99), children: [5] },
      { id: 4, callFrame: frame('', 'main.js', 19), children: [] },
      // frame -> draw -> frame: same function, file and line as node 2.
      { id: 5, callFrame: frame('frame', 'main.js', 9), children: [] },
      { id: 6, callFrame: frame('(idle)', '', -1) },
    ],
    samples: [2, 3, 3, 4, 5, 1, 6, 6],
    // The last sample has no delta and counts as 0.
    timeDeltas: [1000, 2000, 3000, 500, 1500, 250, 4000],
  };
}

test('summarizeProfile: self time by function file:line', () => {
  const summary = summarizeProfile(profile());
  assert.equal(summary.totalMs, 12.25);
  assert.deepEqual(summary.self, [
    ['draw Renderer.js:100', 5],
    ['(idle) :0', 4],
    // Nodes 2 and 5 share a label and merge.
    ['frame main.js:10', 2.5],
    ['(anonymous) main.js:20', 0.5],
    ['(root) :0', 0.25],
  ]);
  assert.deepEqual(summary.inclusive, []);
});

test('summarizeProfile: inclusive time of named functions, outermost frame once', () => {
  const { inclusive } = summarizeProfile(profile(), { inclusive: ['draw', 'frame', 'missing'] });
  assert.deepEqual(inclusive, [
    // Nodes 2, 3, 4 and 5; node 5's 1.5 ms counts once although frame is on its stack twice.
    ['frame', 8],
    // Node 3 and its callee node 5.
    ['draw', 6.5],
    ['missing', 0],
  ]);
});

test('runTrace: healthy 60 Hz periods stay at level 0', () => {
  const jitter = jitterSource();
  assert.deepEqual(runTrace(() => ({ delta: VSYNC_MS + jitter(), work: 7 }), { seconds: 30 }), { level: 0, changes: [] });
  assert.deepEqual(runTrace(() => ({ delta: VSYNC_MS, work: 7 }), { seconds: 30 }), { level: 0, changes: [] });
});

test('runTrace: constant 40 ms periods shed one rung at a time to the bottom', () => {
  const result = runTrace(() => ({ delta: 40, work: 30 }), { seconds: 30 });
  assert.equal(result.level, MAX_LEVEL);
  assert.equal(result.changes.length, MAX_LEVEL);
  result.changes.forEach((c, i) => assert.deepEqual([c.from, c.to], [i, i + 1]));
  // Nothing sheds inside the warm-up.
  assert.ok(result.changes[0].atSec > WARMUP_MS / 1000, `first shed at ${result.changes[0].atSec} s`);
  // Without the warm-up the same trace sheds earlier.
  const cold = runTrace(() => ({ delta: 40, work: 30 }), { seconds: 30, warmup: false });
  assert.equal(cold.level, MAX_LEVEL);
  assert.ok(cold.changes[0].atSec < result.changes[0].atSec);
});

test('runTrace: a governor passed in is the one driven, whatever startLevel says', () => {
  const g = new PerfGovernor({ startLevel: 3 });
  // Recovery out of level 3 is gated on the window of the rung recovered into (level 2).
  const recoverSec = (WARMUP_MS + g.recoverWindowMsFor(2)) / 1000;
  const result = runTrace(() => ({ delta: VSYNC_MS, work: 7 }), { seconds: 30, startLevel: 0, governor: g });
  assert.equal(result.level, g.level);
  assert.deepEqual([result.changes[0].from, result.changes[0].to], [3, 2]);
  assert.ok(result.changes[0].atSec >= recoverSec, `first recovery at ${result.changes[0].atSec} s, window ends ${recoverSec} s`);
  assert.ok(g.level < 3);
});

test('runTrace: each sample carries the previous callback\'s work', () => {
  const calls = [], frames = [];
  const g = {
    level: 2, warmups: [],
    beginWarmup(nowMs) { this.warmups.push(nowMs); },
    sample(deltaMs, nowMs, options) { calls.push({ deltaMs, nowMs, capFps: options.capFps, workMs: options.workMs }); },
  };
  const works = [5, 6, 7, 8];
  const result = runTrace((index, elapsedMs, level) => {
    frames.push([index, elapsedMs, level]);
    return { delta: 250, work: works[index] };
  }, { seconds: 1, capFps: 30, governor: g });
  assert.deepEqual(g.warmups, [1000]);
  assert.deepEqual(frames, [[0, 0, 2], [1, 250, 2], [2, 500, 2], [3, 750, 2]]);
  assert.deepEqual(calls, [
    { deltaMs: 250, nowMs: 1250, capFps: 30, workMs: undefined },
    { deltaMs: 250, nowMs: 1500, capFps: 30, workMs: 5 },
    { deltaMs: 250, nowMs: 1750, capFps: 30, workMs: 6 },
    { deltaMs: 250, nowMs: 2000, capFps: 30, workMs: 7 },
  ]);
  assert.deepEqual(result, { level: 2, changes: [] });

  g.warmups.length = 0;
  runTrace(() => ({ delta: 500, work: 1 }), { seconds: 1, warmup: false, governor: g });
  assert.deepEqual(g.warmups, []);
});

test('jitterSource: deterministic per seed, within +-0.6 ms', () => {
  const a = jitterSource(7), b = jitterSource(7), c = jitterSource(8);
  const seqA = Array.from({ length: 1000 }, a), seqB = Array.from({ length: 1000 }, b);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA.slice(0, 10), Array.from({ length: 10 }, c));
  for (const v of seqA) assert.ok(v >= -0.6 && v < 0.6, `jitter ${v}`);
});

test('scenarios: every trace runs and ends on a valid level', () => {
  for (const s of scenarios()) {
    assert.equal(typeof s.name, 'string');
    const result = runTrace(s.frame, s);
    assert.ok(Number.isInteger(result.level) && result.level >= 0 && result.level <= MAX_LEVEL, `${s.name}: level ${result.level}`);
  }
});
