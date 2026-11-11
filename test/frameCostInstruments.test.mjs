// The audit's remaining pure instrument parts: the live callback summary,
// the CPU profile summary, and the governor trace runner whose results the
// audit's section 4.4 quotes.
import test from 'node:test';
import assert from 'node:assert/strict';
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
