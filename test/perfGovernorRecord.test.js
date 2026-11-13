// The governor's performance record (PerfGovernor.record): level changes
// with their cause, time at each level, sample counters and frame
// statistics, built from the same samples that drive the ladder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerfGovernor, EVENT_LOG_SIZE, STATS_SIZE, MAX_LEVEL } from '../src/render/PerfGovernor.js';

function run(governor, frames, { t = 0, period, work = null, wait = null }) {
  for (let i = 0; i < frames; i++) { t += period; governor.sample(period, t, { capFps: 60, workMs: work, syncWaitMs: wait }); }
  return t;
}

test('a period-pressure shed is logged with its cause and the deciding sample', () => {
  const g = new PerfGovernor();
  run(g, 120, { period: 30, work: 8, wait: 4.25 });
  const r = g.record;
  assert.ok(r.level >= 1);
  const e = r.events[0];
  assert.deepEqual([e.from, e.to, e.cause, e.periodMs, e.workMs, e.syncWaitMs], [0, 1, 'period', 30, 8, 4.25]);
  assert.ok(e.atSec > 0 && e.atSec < 3.6);
  assert.ok(e.overCount >= 60, 'the accumulator that crossed the line');
});

test('a work-pressure shed is logged as work', () => {
  const g = new PerfGovernor();
  run(g, 240, { period: 1000 / 60, work: 15.5 });
  assert.equal(g.record.events[0].cause, 'work');
  assert.equal(g.record.events[0].workMs, 15.5);
  assert.equal(g.record.events[0].syncWaitMs, null);
});

test('a recovery is logged, and time at each level adds up to the run', () => {
  const g = new PerfGovernor();
  let t = run(g, 120, { period: 30, work: 8 });
  const shedAt = g.record.events[0].atSec;
  t = run(g, 60 * 14, { t, period: 1000 / 60, work: 4 });
  const r = g.record;
  const rec = r.events.find((e) => e.cause === 'recovered');
  assert.ok(rec, 'recovered after ten clean seconds');
  assert.equal(rec.from, rec.to + 1, 'one rung at a time');
  assert.ok(rec.atSec - shedAt >= 10);
  const total = r.levelSec.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - t / 1000) < 0.05, `${total} s at levels against ${t / 1000} s of samples`);
  assert.equal(r.levelSec.length, MAX_LEVEL + 1);
  assert.ok(r.samples.overPeriod >= 60 && r.samples.samples > 900);
});

test('frame statistics keep the last STATS_SIZE samples; waits come only from callers that time them', () => {
  const g = new PerfGovernor();
  run(g, 100, { period: 20, work: 6 });
  let r = g.record;
  assert.equal(r.syncWaitMs.count, 0);
  assert.deepEqual([r.periodMs.median, r.workMs.median, r.periodMs.count], [20, 6, 100]);
  run(g, STATS_SIZE + 50, { t: 2000, period: 1000 / 60, work: 3, wait: 1.25 });
  r = g.record;
  assert.equal(r.periodMs.count, STATS_SIZE);
  assert.equal(r.periodMs.max, 16.67, 'the 20 ms periods have left the window');
  assert.deepEqual([r.syncWaitMs.median, r.syncWaitMs.p95], [1.25, 1.25]);
});

test('the first thirty seconds survive a long run after recent samples roll over', () => {
  const g = new PerfGovernor();
  g.beginWarmup(0);
  let t = run(g, 1500, { period: 20, work: 6, wait: 2.75 });
  t = run(g, 5000, { t, period: 10, work: 3, wait: 1.25 });
  const r = g.record;
  assert.equal(r.startup.windowSec, 30);
  assert.equal(r.startup.durationSec, 30);
  assert.equal(r.startup.truncated, false);
  assert.deepEqual(r.startup.periodMs, { count: 1500, median: 20, p95: 20, max: 20 });
  assert.deepEqual(r.startup.workMs, { count: 1500, median: 6, p95: 6, max: 6 });
  assert.deepEqual(r.startup.syncWaitMs, { count: 1500, median: 2.75, p95: 2.75, max: 2.75 });
  assert.equal(r.periodMs.max, 10, 'recent statistics still describe the tail');
  assert.equal(r.wholeRun.durationSec, t / 1000);
  assert.deepEqual(r.wholeRun.periodMs, { count: 6500, mean: 12.31, max: 20 });
  assert.deepEqual(r.wholeRun.workMs, { count: 6500, mean: 3.69, max: 6 });
  assert.deepEqual(r.wholeRun.syncWaitMs, { count: 6500, mean: 1.6, max: 2.75 });
});

test('startup timing coverage cannot be filled by later work or waits', () => {
  const g = new PerfGovernor();
  g.setFixtureLevel(3);
  const t = run(g, 1500, { period: 20 });
  run(g, 1000, { t, period: 20, work: 5, wait: 0 });
  const r = g.record;
  assert.equal(r.startup.workMs.count, 0);
  assert.equal(r.startup.syncWaitMs.count, 0);
  assert.deepEqual(r.wholeRun.workMs, { count: 1000, mean: 5, max: 5 });
  assert.deepEqual(r.wholeRun.syncWaitMs, { count: 1000, mean: 0, max: 0 });
  assert.equal(r.wholeRun.durationSec, 50, 'pinned runs still have a measured duration');
});

test('startup storage overflow is explicit while whole-run statistics stay complete', () => {
  const g = new PerfGovernor();
  run(g, 10000, { period: 1, work: 0.5, wait: 0.25 });
  const r = g.record;
  assert.equal(r.startup.truncated, true);
  assert.equal(r.startup.periodMs.count, r.startup.sampleLimit);
  assert.ok(r.startup.durationSec < 10, 'duration describes retained samples');
  assert.deepEqual(r.wholeRun.periodMs, { count: 10000, mean: 1, max: 1 });
});

test('whole-run statistics exclude invalid timings and retain unmeasured fields as null', () => {
  const g = new PerfGovernor();
  assert.deepEqual(g.record.wholeRun.periodMs, { count: 0, mean: null, max: null });
  g.sample(NaN, 10, { workMs: 100, syncWaitMs: 100 });
  g.sample(0, 20, { workMs: 100, syncWaitMs: 100 });
  g.sample(10, NaN, { workMs: 100, syncWaitMs: 100 });
  g.sample(10, 30, { workMs: -1, syncWaitMs: Infinity });
  g.sample(20, 50, { workMs: 2, syncWaitMs: 0 });
  const r = g.record.wholeRun;
  assert.deepEqual(r.periodMs, { count: 2, mean: 15, max: 20 });
  assert.deepEqual(r.workMs, { count: 1, mean: 2, max: 2 });
  assert.deepEqual(r.syncWaitMs, { count: 1, mean: 0, max: 0 });
});

test('the event log is a ring: the newest EVENT_LOG_SIZE changes, oldest first', () => {
  const g = new PerfGovernor();
  let t = 0;
  // Alternate shed and recover until more changes than the ring holds.
  for (let i = 0; i < EVENT_LOG_SIZE; i++) {
    t = run(g, 200, { t, period: 40, work: 8 });
    t = run(g, 60 * 90, { t, period: 1000 / 60, work: 3 });
  }
  const r = g.record;
  assert.equal(r.events.length, EVENT_LOG_SIZE);
  assert.equal(r.eventsDropped, true);
  for (let i = 1; i < r.events.length; i++) assert.ok(r.events[i].atSec >= r.events[i - 1].atSec);
});

test('pins and holds are visible in the record and log no decisions', () => {
  const g = new PerfGovernor();
  g.setFixtureLevel(3);
  run(g, 200, { period: 40, work: 8 });
  const r = g.record;
  assert.deepEqual([r.level, r.fixtureLevel, r.events.length], [3, 3, 0]);
  assert.ok(r.levelSec[3] > 7);
});

test('sample() allocates nothing for the record', () => {
  const g = new PerfGovernor();
  const before = g._log;
  run(g, 2000, { period: 30, work: 8, wait: 2 });
  assert.equal(g._log, before);
  assert.equal(g._log.length, EVENT_LOG_SIZE);
});
