// Pins the exact contract Simulation._driveAutoplay relies on: an offset-0
// press against a chart note always judges 'perfect', and a hold's
// down-at-tMs/up-at-endMs pair always pays every tick plus the full
// completion bonus with no choke. This is the autoplay engine -- Midio
// performs the song himself; there is no player input to judge anymore.
// Exercised directly against TapJudge (a full Simulation is DOM-adjacent
// and heavy) using the same down/up timing _driveAutoplay itself enqueues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapJudge } from '../src/sim/TapJudge.js';
import { HOLD_BONUS, TICK_SCORE } from '../src/sim/NoteChart.js';

const tap = (tMs, vel = 0.7) => ({ type: 'tap', tMs, vel });
const hold = (tMs, tickTimesMs, vel = 0.7) => ({
  type: 'hold', tMs, endMs: tickTimesMs[tickTimesMs.length - 1], vel, tickTimesMs,
});

/** Mirrors Simulation._driveAutoplay + step()'s autoplay drain exactly: for
 *  each note, enqueue down@tMs and up@(hold ? endMs : tMs+60), merge into
 *  one time-ordered queue (insertion-sorted, ties keep insertion order --
 *  same as Simulation.enqueueTap), then drain in order against the judge. */
function driveGhost(judge, notes) {
  const queue = [];
  const enqueue = (kind, tMs) => {
    let i = queue.length;
    while (i > 0 && queue[i - 1].tMs > tMs) i--;
    queue.splice(i, 0, { kind, tMs });
  };
  for (const n of notes) {
    enqueue('down', n.tMs);
    enqueue('up', n.type === 'hold' ? n.endMs : n.tMs + 60);
  }
  const allEvents = [];
  for (const ev of queue) {
    if (ev.kind === 'down') judge.onTapDown(ev.tMs);
    else judge.onTapUp(ev.tMs);
    judge.update(ev.tMs);
    allEvents.push(...judge.stepEvents);
    judge.clearFrameFlags();
  }
  return allEvents;
}

test('ghost-driven tap notes always judge perfect (offset 0 -> 100 pts)', () => {
  const notes = [tap(1000), tap(1500), tap(2200), tap(3100)];
  const judge = new TapJudge({ notes });
  const events = driveGhost(judge, notes);

  const hits = events.filter((e) => e.kind === 'hit');
  assert.equal(hits.length, notes.length, `expected one hit per note, got ${hits.length}`);
  for (const h of hits) {
    assert.equal(h.tier, 'perfect', `expected perfect, got ${h.tier} at tMs=${h.tMs}`);
    assert.equal(h.basePts, 100);
    assert.equal(h.offsetMs, 0);
  }
  assert.ok(!events.some((e) => e.kind === 'sour' || e.kind === 'miss'), 'no sour/miss should ever appear');
});

test('ghost-driven hold notes pay every tick plus the full completion bonus, never choke', () => {
  const notes = [hold(1000, [1150, 1300, 1450, 1600, 1750])];
  const judge = new TapJudge({ notes });
  const events = driveGhost(judge, notes);

  const start = events.find((e) => e.kind === 'holdStart');
  assert.ok(start, 'expected a holdStart event');
  assert.equal(start.tier, 'perfect');

  const ticks = events.filter((e) => e.kind === 'holdTick');
  assert.equal(ticks.length, notes[0].tickTimesMs.length, 'every tick must be paid');
  for (const t of ticks) assert.equal(t.basePts, TICK_SCORE);

  const complete = events.find((e) => e.kind === 'holdComplete');
  assert.ok(complete, 'expected a holdComplete event');
  assert.equal(complete.basePts, HOLD_BONUS);

  assert.ok(!events.some((e) => e.kind === 'holdChoke'), 'a ghost-driven hold must never choke');
});

test('a dense tap sequence at the 100ms (10 taps/sec) hard cap never sours from the +60ms ghost release', () => {
  const notes = [];
  for (let t = 1000; t <= 1000 + 100 * 20; t += 100) notes.push(tap(t));
  const judge = new TapJudge({ notes });
  const events = driveGhost(judge, notes);

  const hits = events.filter((e) => e.kind === 'hit');
  assert.equal(hits.length, notes.length, `expected every dense note to be hit, got ${hits.length}/${notes.length}`);
  for (const h of hits) assert.equal(h.tier, 'perfect');
  assert.ok(!events.some((e) => e.kind === 'sour' || e.kind === 'miss'));
});

test('a ghost-driven mixed tap+hold chart produces zero sour/miss/choke end to end', () => {
  const notes = [
    tap(1000), tap(1200),
    hold(1500, [1650, 1800, 1950, 2100]),
    tap(2400), tap(2600), tap(2800),
  ];
  const judge = new TapJudge({ notes });
  const events = driveGhost(judge, notes);
  assert.ok(events.length > 0);
  assert.ok(!events.some((e) => e.kind === 'sour' || e.kind === 'miss' || e.kind === 'holdChoke'));
});
