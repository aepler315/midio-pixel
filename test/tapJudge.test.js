import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TapJudge, pointsForOffset, tierForPoints, JUDGE_WINDOW_MS, HOLD_END_GRACE_MS,
} from '../src/sim/TapJudge.js';
import { TICK_SCORE, HOLD_BONUS } from '../src/sim/NoteChart.js';

const tap = (tMs, vel = 0.7) => ({ type: 'tap', tMs, vel });
const hold = (tMs, tickTimesMs, vel = 0.7) => ({
  type: 'hold', tMs, endMs: tickTimesMs[tickTimesMs.length - 1], vel, tickTimesMs,
});
const judgeOf = (...notes) => new TapJudge({ notes });
const drain = (j) => {
  const evts = [...j.stepEvents];
  j.clearFrameFlags();
  return evts;
};

test('pointsForOffset: the 10ms snap, symmetric, clamped at zero', () => {
  const table = [[0, 100], [4.9, 100], [5, 90], [14, 90], [15, 80], [-15, 80],
    [50, 50], [94, 10], [95, 0], [104, 0], [500, 0]];
  for (const [off, pts] of table) {
    assert.equal(pointsForOffset(off), pts, `offset ${off}`);
  }
});

test('tierForPoints boundaries', () => {
  assert.equal(tierForPoints(100), 'perfect');
  assert.equal(tierForPoints(90), 'perfect');
  assert.equal(tierForPoints(80), 'great');
  assert.equal(tierForPoints(60), 'great');
  assert.equal(tierForPoints(50), 'good');
  assert.equal(tierForPoints(10), 'good');
  assert.equal(tierForPoints(0), 'sour');
});

test('a press consumes its note; a second press in the same window is sour', () => {
  const j = judgeOf(tap(1000));
  const res = j.onTapDown(1010);
  assert.deepEqual(res, { startedHold: false, matchedVel: 0.7 });
  let evts = drain(j);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].kind, 'hit');
  assert.equal(evts[0].basePts, 90);
  assert.equal(evts[0].tier, 'perfect');
  j.onTapUp(1050);
  j.onTapDown(1060);
  evts = drain(j);
  assert.equal(evts[0].kind, 'sour');
  assert.equal(evts[0].basePts, 0);
});

test('window edges: +120 still matches (for zero points), +121 is sour', () => {
  const inWindow = judgeOf(tap(1000));
  inWindow.onTapDown(1000 + JUDGE_WINDOW_MS);
  assert.equal(inWindow.stepEvents[0].kind, 'hit');
  assert.equal(inWindow.stepEvents[0].basePts, 0);
  assert.equal(inWindow.stepEvents[0].tier, 'sour');

  const outside = judgeOf(tap(1000));
  outside.onTapDown(1000 + JUDGE_WINDOW_MS + 1);
  assert.equal(outside.stepEvents[0].kind, 'sour');
});

test('overlapping windows: the nearest unconsumed note wins', () => {
  const j = judgeOf(tap(1000), tap(1200));
  j.onTapDown(1090); // 90 from the first, 110 from the second
  assert.equal(drain(j)[0].offsetMs, 90);
  j.onTapUp(1100);
  j.onTapDown(1198); // first is consumed; matches the second at -2
  const evts = drain(j);
  assert.equal(evts[0].offsetMs, -2);
  assert.equal(evts[0].basePts, 100);
});

test('miss sweep fires exactly once per unconsumed note and never rewinds', () => {
  const j = judgeOf(tap(500), tap(1000));
  j.update(1000 + JUDGE_WINDOW_MS + 1);
  let evts = drain(j);
  assert.deepEqual(evts.map((e) => e.kind), ['miss', 'miss']);
  assert.deepEqual(evts.map((e) => e.tMs), [500, 1000]);
  j.update(1000 + JUDGE_WINDOW_MS + 1);
  j.update(50000);
  assert.equal(j.stepEvents.length, 0);
});

test('a consumed note never misses', () => {
  const j = judgeOf(tap(500));
  j.onTapDown(510);
  drain(j);
  j.update(5000);
  assert.equal(j.stepEvents.length, 0);
});

test('holding the button through a tap note does not consume it', () => {
  const j = judgeOf(tap(1000));
  j.onTapDown(400); // sour press, then the player just keeps holding
  drain(j);
  j.update(1500);
  assert.deepEqual(j.stepEvents.map((e) => e.kind), ['miss']);
});

test('hold start scores like a tap and raises holdState', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  const res = j.onTapDown(1020);
  assert.equal(res.startedHold, true);
  assert.equal(res.matchedVel, 0.7);
  const evts = drain(j);
  assert.equal(evts[0].kind, 'holdStart');
  assert.equal(evts[0].basePts, 80);
  assert.equal(evts[0].tier, 'great');
  assert.equal(j.holdState.active, true);
  assert.equal(j.holdState.note.tMs, 1000);
});

test('ticks pay in order while held, and chargeU climbs', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  j.onTapDown(1000);
  drain(j);
  j.update(1160);
  let evts = drain(j);
  assert.deepEqual(evts.map((e) => [e.kind, e.tMs]), [['holdTick', 1150]]);
  assert.equal(j.holdState.chargeU, 0.25);
  j.update(1500);
  evts = drain(j);
  assert.deepEqual(evts.map((e) => e.tMs), [1300, 1450]);
  assert.equal(j.holdState.chargeU, 0.75);
});

test('early release chokes: remaining ticks forfeited, hold stays dead', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  j.onTapDown(1000);
  j.update(1340);
  drain(j);
  j.onTapUp(1350); // well before endMs - grace = 1500
  const evts = drain(j);
  assert.equal(evts[0].kind, 'holdChoke');
  assert.equal(evts[0].remainingTicks, 2);
  assert.equal(j.holdState.active, false);
  j.onTapDown(1460); // re-press inside the dead hold matches nothing
  assert.equal(drain(j)[0].kind, 'sour');
  j.update(5000);
  assert.equal(j.stepEvents.length, 0, 'a consumed (choked) hold never also misses');
});

test('release inside the end grace completes: full value is reachable', () => {
  const ticks = [1150, 1300, 1450, 1600];
  const j = judgeOf(hold(1000, ticks));
  j.onTapDown(1000); // 100
  const all = [...drain(j)];
  j.update(1460);
  all.push(...drain(j));
  j.onTapUp(1600 - HOLD_END_GRACE_MS + 10);
  all.push(...drain(j));
  const earned = all.reduce((s, e) => s + e.basePts, 0);
  assert.equal(earned, 100 + ticks.length * TICK_SCORE + HOLD_BONUS);
  assert.equal(all[all.length - 1].kind, 'holdComplete');
});

test('holding past the end auto-completes; the later release is a no-op', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  j.onTapDown(1000);
  drain(j);
  j.update(1601);
  const evts = drain(j);
  assert.equal(evts.filter((e) => e.kind === 'holdTick').length, 4);
  assert.equal(evts[evts.length - 1].kind, 'holdComplete');
  j.onTapUp(1700);
  assert.equal(j.stepEvents.length, 0);
});

test('a slightly-early press late-arms the hold with zero start points', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  j.onTapDown(750); // 250ms early: sour, but the button stays down
  assert.equal(drain(j)[0].kind, 'sour');
  j.update(999);
  assert.equal(j.holdState.active, false);
  j.update(1000);
  const evts = drain(j);
  assert.equal(evts[0].kind, 'holdStart');
  assert.equal(evts[0].basePts, 0);
  assert.equal(j.holdState.active, true);
  j.update(1601);
  const rest = drain(j);
  assert.equal(rest.filter((e) => e.kind === 'holdTick').length, 4);
  assert.equal(rest[rest.length - 1].kind, 'holdComplete');
});

test('a press too early to arm leaves the hold to miss', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  j.onTapDown(650); // 350ms early: beyond HOLD_ARM_EARLY_MS
  drain(j);
  j.update(1000);
  assert.equal(j.holdState.active, false);
  j.update(1000 + JUDGE_WINDOW_MS + 1);
  assert.deepEqual(drain(j).map((e) => e.kind), ['miss']);
});

test('a late hold press loses the ticks already past', () => {
  const j = judgeOf(hold(1000, [1050, 1300, 1450, 1600]));
  j.onTapDown(1100); // tick at 1050 already gone
  drain(j);
  j.update(1601);
  const evts = drain(j);
  assert.equal(evts.filter((e) => e.kind === 'holdTick').length, 3);
});

test('release with no hold active is a no-op', () => {
  const j = judgeOf(tap(1000));
  j.onTapUp(500);
  assert.equal(j.stepEvents.length, 0);
});

test('update is idempotent at the same instant', () => {
  const j = judgeOf(hold(1000, [1150, 1300, 1450, 1600]));
  j.onTapDown(1000);
  j.update(1500);
  const n = j.stepEvents.length;
  j.update(1500);
  assert.equal(j.stepEvents.length, n);
});

test('a huge first update misses every note exactly once', () => {
  const j = judgeOf(tap(100), tap(200), hold(500, [600, 700, 800, 900]));
  j.update(1e9);
  assert.deepEqual(j.stepEvents.map((e) => e.kind), ['miss', 'miss', 'miss']);
});

test('an empty chart judges nothing at all', () => {
  const j = new TapJudge({ notes: [] });
  const res = j.onTapDown(500);
  assert.deepEqual(res, { startedHold: false, matchedVel: null });
  j.update(10000);
  assert.equal(j.stepEvents.length, 0);
});
