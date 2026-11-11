import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfGovernor, MAX_LEVEL, WARMUP_MS, EVENT_LOG_SIZE, FRAME_STATS_SIZE } from '../src/render/PerfGovernor.js';

// Phase 0 performance record (plan 2026-11-10-frame-cost, items 3 and 5):
// the governor's event log, counters and frame statistics. Observation only,
// so every test here also leans on the existing governor suites and
// tools/perf-governor-sim.mjs staying unchanged.

const VSYNC = 1000 / 60;

/** Feed `count` samples of a fixed shape; returns the last nowMs. */
function feed(gov, { count, deltaMs = VSYNC, startMs = 1000, workMs, syncWaitMs, capFps = 60, until = null } = {}) {
  let nowMs = startMs;
  for (let i = 0; i < count; i++) {
    nowMs += deltaMs;
    gov.sample(deltaMs, nowMs, { capFps, workMs, syncWaitMs });
    if (until !== null && until(gov)) break;
  }
  return nowMs;
}

test('diagnostics keeps its six original fields and adds the record', () => {
  const d = new PerfGovernor({ startLevel: 2, minLevel: 1 }).diagnostics;
  for (const key of ['workTimingEnabled', 'framePeriodMs', 'observedWorkMs', 'workHeadroomMs', 'probeLevel', 'probeUntilMs']) {
    assert.ok(key in d, key);
  }
  assert.equal(d.level, 2);
  assert.equal(d.minLevel, 1);
  assert.equal(d.sinceStartMs, 0);
  assert.deepEqual(d.levelMs, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(d.counters, { samples: 0, overBudget: 0, workPressure: 0, noHeadroom: 0, levelChanges: 0 });
  assert.deepEqual(d.events, []);
  assert.equal(d.eventsDropped, 0);
  const empty = { count: 0, median: null, p95: null, max: null };
  assert.deepEqual(d.frames, { periodMs: empty, workMs: empty, syncWaitMs: empty });
});

test('the constructor start level, including 8-bit, is not an event', () => {
  assert.equal(new PerfGovernor({ startLevel: 3 }).diagnostics.events.length, 0);
  const retro = new PerfGovernor({ retro: true });
  assert.equal(retro.level, MAX_LEVEL);
  assert.equal(retro.diagnostics.counters.levelChanges, 0);
});

test('a period shed logs cause period with the deciding sample and the accumulator before its reset', () => {
  const gov = new PerfGovernor();
  gov.beginWarmup(500);
  // Past the warm-up: 20 ms periods are over the 18.5 ms line, no work timing.
  feed(gov, { count: 200, deltaMs: 20, startMs: 500 + WARMUP_MS, until: g => g.level === 1 });
  assert.equal(gov.level, 1);
  const { events, sinceStartMs } = gov.diagnostics;
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.cause, 'period');
  assert.equal(e.from, 0);
  assert.equal(e.to, 1);
  assert.equal(e.periodMs, 20);
  assert.equal(e.workMs, null);
  assert.equal(e.overCount, 60, 'the accumulator at the decision, not the zero it is reset to');
  assert.equal(e.workOverCount, 0);
  assert.equal(gov._overCount, 0, 'the shed itself still resets the accumulator');
  assert.equal(e.atMs, sinceStartMs, 'atMs is measured from the warm-up origin');
  assert.ok(e.atMs > WARMUP_MS);
});

test('a work shed logs cause work with the deciding work and both accumulators', () => {
  const gov = new PerfGovernor();
  feed(gov, { count: 200, workMs: 15, until: g => g.level === 1 });
  const [e] = gov.diagnostics.events;
  assert.equal(e.cause, 'work');
  assert.deepEqual([e.from, e.to], [0, 1]);
  assert.equal(e.periodMs, VSYNC);
  assert.equal(e.workMs, 15);
  assert.equal(e.overCount, 0);
  assert.equal(e.workOverCount, 60);
  assert.equal(gov._workOverCount, 0);
});

test('a recovery logs cause recovered with the deciding sample', () => {
  const gov = new PerfGovernor({ startLevel: 1 });
  const nowMs = feed(gov, { count: 1000, until: g => g.level === 0 });
  assert.equal(gov.level, 0);
  const [e] = gov.diagnostics.events;
  assert.equal(e.cause, 'recovered');
  assert.deepEqual([e.from, e.to], [1, 0]);
  assert.equal(e.periodMs, VSYNC);
  assert.equal(e.workMs, null);
  assert.equal(e.overCount, 0);
  assert.equal(e.workOverCount, 0);
  assert.equal(e.atMs, nowMs - (1000 + VSYNC));
});

test('a measured probe that expires without observed work logs cause probe-expired', () => {
  const gov = new PerfGovernor({ startLevel: 1 });
  const nowMs = feed(gov, { count: 1000, workMs: 5, until: g => g.level === 0 });
  assert.equal(gov.diagnostics.probeLevel, 0);
  // Skipped callbacks only: no work can certify the probe at its deadline.
  feed(gov, { count: 300, workMs: null, startMs: nowMs, until: g => g.level === 1 });
  const events = gov.diagnostics.events;
  assert.equal(events.length, 2);
  assert.equal(events[0].cause, 'recovered');
  assert.equal(events[0].workMs, 5);
  const e = events[1];
  assert.equal(e.cause, 'probe-expired');
  assert.deepEqual([e.from, e.to], [0, 1]);
  assert.equal(e.periodMs, VSYNC);
  assert.equal(e.workMs, null);
});

test('external level changes log limit, fixture, hold and retro, only when the level changes', () => {
  const gov = new PerfGovernor();
  // Bank some period evidence, then change the limit: the event keeps it.
  feed(gov, { count: 10, deltaMs: 20 });
  const banked = gov._overCount;
  assert.ok(banked > 10);
  gov.setQualityLimit(2);
  gov.setQualityLimit(2); // unchanged level: no event
  gov.setFixtureLevel(4);
  gov.setFixtureLevel(4);
  gov.freezeQuality(0); // fixture outranks hold: still 4, no event
  gov.setFixtureLevel(null); // back to the held level 0
  gov.holdQuality = false; // level stays 0: no event
  assert.throws(() => gov.setFixtureLevel(9), RangeError);
  gov.retro = true;
  gov.setFixtureLevel(1);
  gov.setFixtureLevel(null); // retro floor
  const events = gov.diagnostics.events.map(e => [e.cause, e.from, e.to, e.periodMs, e.workMs]);
  assert.deepEqual(events, [
    ['limit', 0, 2, null, null],
    ['fixture', 2, 4, null, null],
    ['fixture', 4, 0, null, null],
    ['retro', 0, MAX_LEVEL, null, null],
    ['fixture', MAX_LEVEL, 1, null, null],
    ['fixture', 1, MAX_LEVEL, null, null],
  ]);
  assert.equal(gov.diagnostics.events[0].overCount, banked, 'accumulator before setQualityLimit resets it');
});

test('freezeQuality logs one hold event', () => {
  const gov = new PerfGovernor({ startLevel: 3 });
  gov.freezeQuality(0);
  const events = gov.diagnostics.events;
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].cause, events[0].from, events[0].to], ['hold', 3, 0]);
});

test('external events before any sample are at 0; after samples, at the latest sample', () => {
  const gov = new PerfGovernor();
  gov.setFixtureLevel(2);
  assert.equal(gov.diagnostics.events[0].atMs, 0);
  gov.sample(10, 100);
  gov.sample(10, 130);
  gov.setFixtureLevel(3);
  assert.equal(gov.diagnostics.events[1].atMs, 30);
  assert.equal(gov.diagnostics.sinceStartMs, 30);
});

test('the event ring keeps the newest 32, oldest first, and counts what it dropped', () => {
  const gov = new PerfGovernor();
  const total = EVENT_LOG_SIZE + 8;
  for (let i = 0; i < total; i++) gov.setFixtureLevel(i % 2 === 0 ? 1 : 2);
  const d = gov.diagnostics;
  assert.equal(d.events.length, EVENT_LOG_SIZE);
  assert.equal(d.eventsDropped, 8);
  assert.equal(d.counters.levelChanges, total);
  // Event 8 (even) went 2 -> 1; the last (39, odd) went 1 -> 2.
  assert.deepEqual([d.events[0].from, d.events[0].to], [2, 1]);
  assert.deepEqual([d.events.at(-1).from, d.events.at(-1).to], [1, 2]);
  for (const e of d.events) assert.equal(e.cause, 'fixture');
});

test('levelMs attributes each period to the level held before that sample decided', () => {
  const gov = new PerfGovernor();
  let nowMs = feed(gov, { count: 200, deltaMs: 20, until: g => g.level === 1 });
  const shedAfter = gov.diagnostics.counters.samples;
  assert.equal(gov.diagnostics.levelMs[0], 20 * shedAfter, 'the deciding sample counts at the old level');
  nowMs = feed(gov, { count: 5, deltaMs: 10, startMs: nowMs });
  gov.setFixtureLevel(5);
  feed(gov, { count: 4, deltaMs: 10, startMs: nowMs });
  const { levelMs } = gov.diagnostics;
  assert.equal(levelMs[1], 50);
  assert.equal(levelMs[5], 40);
  assert.equal(levelMs.reduce((a, b) => a + b, 0), 20 * shedAfter + 90);
});

test('counters count every valid sample, including warm-up, against that sample\'s lines', () => {
  const gov = new PerfGovernor();
  gov.beginWarmup(0);
  // 60 FPS: budget 18.5, pressure >= 14.17, no headroom > 11.67.
  gov.sample(20, 20, { workMs: 5 });       // over budget
  gov.sample(16, 36, { workMs: 15 });      // pressure and no headroom
  gov.sample(16, 52, { workMs: 12 });      // no headroom only
  gov.sample(16, 68, { workMs: 11 });      // neither
  gov.sample(16, 84, { workMs: null });    // not rendered
  gov.sample(16, 100);                     // no timing
  // 30 FPS: budget 35.17, pressure >= 28.33, no headroom > 23.33.
  gov.sample(34, 134, { capFps: 30, workMs: 25 }); // no headroom only
  assert.deepEqual(gov.diagnostics.counters,
    { samples: 7, overBudget: 1, workPressure: 1, noHeadroom: 3, levelChanges: 0 });
  assert.equal(gov.level, 0);
  assert.equal(gov.diagnostics.events.length, 0, 'warm-up still decides nothing');
});

test('a pinned fixture records samples without the ladder deciding anything', () => {
  const gov = new PerfGovernor();
  gov.setFixtureLevel(0);
  feed(gov, { count: 500, deltaMs: 80, workMs: 70, syncWaitMs: 3 });
  const d = gov.diagnostics;
  assert.equal(gov.level, 0);
  assert.equal(d.events.length, 0);
  assert.equal(d.counters.samples, 500);
  assert.equal(d.counters.overBudget, 500);
  assert.equal(d.frames.periodMs.count, 500);
  assert.equal(d.frames.workMs.count, 500);
  assert.equal(d.frames.syncWaitMs.max, 3);
  assert.equal(d.levelMs[0], 500 * 80);
});

test('frame statistics: odd and even medians, p95, max', () => {
  const odd = new PerfGovernor();
  odd.beginWarmup(0);
  [5, 1, 3].forEach((d, i) => odd.sample(d, 10 + i));
  assert.deepEqual(odd.diagnostics.frames.periodMs, { count: 3, median: 3, p95: 5, max: 5 });
  const even = new PerfGovernor();
  even.beginWarmup(0);
  [4, 1, 3, 2].forEach((d, i) => even.sample(d, 10 + i));
  assert.deepEqual(even.diagnostics.frames.periodMs, { count: 4, median: 2.5, p95: 4, max: 4 });
  // Numeric, not lexicographic, ordering.
  const mixed = new PerfGovernor();
  mixed.beginWarmup(0);
  [100, 9, 20].forEach((d, i) => mixed.sample(d, 10 + i));
  assert.equal(mixed.diagnostics.frames.periodMs.median, 20);
});

test('frame statistics keep the last 600 entries', () => {
  const gov = new PerfGovernor();
  gov.setFixtureLevel(3);
  let nowMs = 0;
  for (let i = 1; i <= 700; i++) gov.sample(i, nowMs += i);
  const s = gov.diagnostics.frames.periodMs;
  assert.equal(FRAME_STATS_SIZE, 600);
  // Ring holds 101..700.
  assert.deepEqual(s, { count: 600, median: 400.5, p95: 671, max: 700 });
  assert.equal(gov.diagnostics.counters.samples, 700);
});

test('work and sync waits record only rendered samples; sync only when finite and non-negative', () => {
  const gov = new PerfGovernor();
  gov.beginWarmup(0);
  gov.sample(16, 16, { workMs: 5, syncWaitMs: 1 });
  gov.sample(16, 32, { workMs: 6 });
  gov.sample(16, 48, { workMs: 7, syncWaitMs: NaN });
  gov.sample(16, 64, { workMs: 8, syncWaitMs: -1 });
  gov.sample(16, 80, { workMs: null, syncWaitMs: 2 });
  gov.sample(16, 96, { workMs: -1, syncWaitMs: 4 });
  gov.sample(16, 112, { workMs: 9, syncWaitMs: 0 });
  const { frames } = gov.diagnostics;
  assert.equal(frames.periodMs.count, 7);
  assert.deepEqual(frames.workMs, { count: 5, median: 7, p95: 9, max: 9 });
  assert.deepEqual(frames.syncWaitMs, { count: 2, median: 0.5, p95: 1, max: 1 });
});

test('invalid samples record nothing', () => {
  const gov = new PerfGovernor();
  gov.sample(0, 100, { workMs: 5, syncWaitMs: 1 });
  gov.sample(-5, 100, { workMs: 5 });
  gov.sample(NaN, 100, { workMs: 5 });
  gov.sample(Infinity, 100, { workMs: 5 });
  gov.sample(16, NaN, { workMs: 5 });
  gov.sample(16, Infinity, { workMs: 5 });
  const d = gov.diagnostics;
  assert.equal(d.counters.samples, 0);
  assert.equal(d.sinceStartMs, 0);
  assert.deepEqual(d.levelMs, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(d.frames.periodMs.count, 0);
  assert.equal(d.frames.workMs.count, 0);
  assert.equal(d.frames.syncWaitMs.count, 0);
});

test('the time origin is the earlier of the first sample and beginWarmup', () => {
  const late = new PerfGovernor();
  late.sample(10, 100);
  late.beginWarmup(400);
  late.sample(10, 600);
  assert.equal(late.diagnostics.sinceStartMs, 500);
  const early = new PerfGovernor();
  early.beginWarmup(40);
  assert.equal(early.diagnostics.sinceStartMs, 0, 'no sample yet');
  early.sample(10, 100);
  assert.equal(early.diagnostics.sinceStartMs, 60);
});

test('the record survives forgetRecoveryHistory, setQualityLimit and beginWarmup', () => {
  const gov = new PerfGovernor();
  feed(gov, { count: 200, deltaMs: 20, workMs: 5, syncWaitMs: 2, until: g => g.level === 1 });
  const before = gov.diagnostics;
  assert.equal(before.events.length, 1);
  gov.forgetRecoveryHistory();
  gov.setQualityLimit(0); // returns the level to the limit: one 'limit' event
  gov.beginWarmup(1e6);
  const after = gov.diagnostics;
  assert.deepEqual(after.counters, { ...before.counters, levelChanges: 2 });
  assert.deepEqual(after.events[0], before.events[0]);
  assert.equal(after.events[1].cause, 'limit');
  assert.deepEqual(after.levelMs, before.levelMs);
  assert.deepEqual(after.frames, before.frames);
  assert.equal(after.sinceStartMs, before.sinceStartMs);
});

test('diagnostics returns copies: mutating one read does not change the next', () => {
  const gov = new PerfGovernor();
  gov.setFixtureLevel(2);
  gov.sample(16, 16, { workMs: 4, syncWaitMs: 1 });
  const first = gov.diagnostics;
  first.events[0].cause = 'tampered';
  first.levelMs[2] = -1;
  first.counters.samples = -1;
  first.frames.periodMs.max = -1;
  const second = gov.diagnostics;
  assert.equal(second.events[0].cause, 'fixture');
  assert.equal(second.levelMs[2], 16);
  assert.equal(second.counters.samples, 1);
  assert.equal(second.frames.periodMs.max, 16);
});

test('100k samples reuse the preallocated slots and rings', () => {
  const gov = new PerfGovernor();
  const slots = gov._events.slice();
  const rings = [gov._periodRing, gov._workRing, gov._syncRing, gov._levelMs, gov._clock];
  const buffers = rings.map(r => r.buffer);
  let nowMs = 0;
  // Alternate hard and healthy stretches so the ladder sheds and recovers.
  for (let i = 0; i < 100000; i++) {
    const hard = Math.floor(i / 3000) % 2 === 0;
    const deltaMs = hard ? 40 : VSYNC;
    nowMs += deltaMs;
    gov.sample(deltaMs, nowMs, { workMs: hard ? 30 : 4, syncWaitMs: hard ? 2 : 0.5 });
  }
  const d = gov.diagnostics;
  assert.ok(d.counters.levelChanges > 0, 'the run exercised the event log');
  assert.equal(gov._events.length, EVENT_LOG_SIZE);
  gov._events.forEach((slot, i) => assert.equal(slot, slots[i], `slot ${i} replaced`));
  // A null in a slot's fractional field would make V8 box every double
  // written there; "none" is kept as NaN until diagnostics copies it out.
  for (const slot of gov._events) {
    for (const key of ['atMs', 'periodMs', 'workMs', 'overCount', 'workOverCount']) {
      assert.equal(typeof slot[key], 'number', `slot.${key} holds a non-number`);
    }
  }
  for (const [i, r] of rings.entries()) {
    assert.equal([gov._periodRing, gov._workRing, gov._syncRing, gov._levelMs, gov._clock][i], r);
    assert.equal(r.buffer, buffers[i]);
  }
  assert.equal(d.frames.periodMs.count, FRAME_STATS_SIZE);
  assert.equal(d.counters.samples, 100000);
});
