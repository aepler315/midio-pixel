import test from 'node:test';
import assert from 'node:assert/strict';
import { levelTimeline } from '../tools/landscape-review.mjs';

test('level timeline is empty without samples', () => {
  assert.deepEqual(levelTimeline([], []), []);
});

test('a held level is one run spanning its first and last sample', () => {
  assert.deepEqual(levelTimeline([0, 0, 0], [0, 16.7, 33.3]), [{ level: 0, frames: 3, fromMs: 0, toMs: 33.3 }]);
});

test('a level that returns later is a new run, not merged with the earlier one', () => {
  const runs = levelTimeline([0, 0, 1, 1, 1, 0], [0, 16, 32, 48, 64, 80]);
  assert.deepEqual(runs, [
    { level: 0, frames: 2, fromMs: 0, toMs: 16 },
    { level: 1, frames: 3, fromMs: 32, toMs: 64 },
    { level: 0, frames: 1, fromMs: 80, toMs: 80 },
  ]);
  assert.equal(runs.reduce((n, r) => n + r.frames, 0), 6, 'every sample lands in exactly one run');
});

test('unknown levels form their own null runs', () => {
  assert.deepEqual(levelTimeline([null, undefined, 2, NaN], [0, 10, 20, 30]), [
    { level: null, frames: 2, fromMs: 0, toMs: 10 },
    { level: 2, frames: 1, fromMs: 20, toMs: 20 },
    { level: null, frames: 1, fromMs: 30, toMs: 30 },
  ]);
});

test('times are relative to the window start, rounded to 0.1 ms and never negative', () => {
  // The first rAF timestamp can precede the performance.now() that opened the window.
  assert.deepEqual(levelTimeline([3, 3, 4], [-0.4, 16.66, 33.349]), [
    { level: 3, frames: 2, fromMs: 0, toMs: 16.7 },
    { level: 4, frames: 1, fromMs: 33.3, toMs: 33.3 },
  ]);
});
