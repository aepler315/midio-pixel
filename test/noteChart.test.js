import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNoteChart, HOLD_MAX_GAP_MS, HOLD_MIN_HITS, HOLD_MIN_SPAN_MS,
  TAP_SCORE, TICK_SCORE, HOLD_BONUS, SONG_END_KEEPOUT_MS,
} from '../src/sim/NoteChart.js';
import { predictJumpArcs } from '../src/sim/JumpPlanner.js';
import { Role } from '../src/core/NoteEvent.js';
import { mulberry32 } from '../src/utils/math.js';

const kickEv = (tMs, vel = 0.7) => ({ tMs, vel, role: Role.RHYTHM, kick: true, pitch: 36 });
const snareEv = (tMs) => ({ tMs, vel: 0.8, role: Role.RHYTHM, kick: false, pitch: 38 });
const melodyEv = (tMs) => ({ tMs, vel: 0.8, role: Role.MELODY, kick: false, pitch: 60 });

test('only RHYTHM kicks reach the chart', () => {
  const timeline = [kickEv(0), melodyEv(100), snareEv(250), kickEv(500), melodyEv(600)];
  const chart = buildNoteChart(timeline, 10000);
  assert.equal(chart.tapCount, 2);
  assert.equal(chart.holdCount, 0);
  assert.ok(chart.notes.every((n) => n.type === 'tap'));
});

test('empty timeline yields an empty chart with zero max score', () => {
  const chart = buildNoteChart([melodyEv(0), snareEv(100)], 5000);
  assert.deepEqual(chart, { notes: [], holdSpans: [], maxPossibleScore: 0, tapCount: 0, holdCount: 0 });
});

test('gap boundary: exactly HOLD_MAX_GAP_MS chains a roll, one ms more does not', () => {
  const atGap = [];
  for (let i = 0; i < 6; i++) atGap.push(kickEv(i * HOLD_MAX_GAP_MS));
  const chartHold = buildNoteChart(atGap, 20000);
  assert.equal(chartHold.holdCount, 1);
  assert.equal(chartHold.tapCount, 0, 'every takeoff trigger inside the roll is consumed by the hold');
  assert.equal(chartHold.notes[0].tickTimesMs.length, 5);
  assert.deepEqual(chartHold.holdSpans, [{ fromMs: 0, toMs: 5 * HOLD_MAX_GAP_MS }]);

  const past = [];
  for (let i = 0; i < 6; i++) past.push(kickEv(i * (HOLD_MAX_GAP_MS + 1)));
  const chartTaps = buildNoteChart(past, 20000);
  assert.equal(chartTaps.holdCount, 0);
  assert.equal(chartTaps.tapCount, predictJumpArcs(past.map((e) => ({ tMs: e.tMs, vel: e.vel }))).length);
});

test('a run below HOLD_MIN_HITS stays taps no matter how tight', () => {
  const timeline = [];
  for (let i = 0; i < HOLD_MIN_HITS - 1; i++) timeline.push(kickEv(i * 100));
  const chart = buildNoteChart(timeline, 20000);
  assert.equal(chart.holdCount, 0);
});

test('span floor: 5 hits over 480ms hold, 5 hits over 440ms do not', () => {
  const wide = [0, 120, 240, 360, 480].map((t) => kickEv(t));
  assert.equal(buildNoteChart(wide, 20000).holdCount, 1);
  assert.ok(480 >= HOLD_MIN_SPAN_MS);

  const tight = [0, 110, 220, 330, 440].map((t) => kickEv(t));
  assert.equal(buildNoteChart(tight, 20000).holdCount, 0);
  assert.ok(440 < HOLD_MIN_SPAN_MS);
});

test('four-on-the-floor at 180bpm never clusters; taps mirror the jump predictor exactly', () => {
  const timeline = [];
  for (let i = 0; i < 20; i++) timeline.push(kickEv(i * 333));
  const chart = buildNoteChart(timeline, 60000);
  assert.equal(chart.holdCount, 0);
  const arcs = predictJumpArcs(timeline.map((e) => ({ tMs: e.tMs, vel: e.vel })));
  assert.equal(chart.tapCount, arcs.length, 'halftime ghosting must match the obstacle planner');
  assert.ok(chart.tapCount < 20, 'at 180bpm some kicks must be ghosted');
});

test('taps mirror predictJumpArcs over a long randomized no-roll sequence', () => {
  const rand = mulberry32(7);
  const timeline = [];
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t += 250 + Math.round(rand() * 500); // always > HOLD_MAX_GAP_MS -> no rolls
    timeline.push(kickEv(t, 0.4 + rand() * 0.6));
  }
  const chart = buildNoteChart(timeline, t + 5000);
  assert.equal(chart.holdCount, 0);
  const arcs = predictJumpArcs(timeline.map((e) => ({ tMs: e.tMs, vel: e.vel })));
  assert.equal(chart.tapCount, arcs.length);
  for (let i = 1; i < chart.notes.length; i++) {
    assert.ok(chart.notes[i].tMs > chart.notes[i - 1].tMs, 'notes sorted ascending');
  }
});

test('song-end keepout trims a roll tail; a hold that survives keeps its clamped end', () => {
  const roll = [6000, 6150, 6300, 6450, 6600].map((t) => kickEv(t)); // 5 hits, span 600
  const chart = buildNoteChart(roll, 7200); // keepout boundary at 6700 keeps all 5
  assert.equal(chart.holdCount, 1);
  assert.equal(chart.notes[0].endMs, 6600);
  assert.equal(chart.notes[0].tickTimesMs.length, 4);
});

test('song-end keepout demotes a roll that no longer qualifies', () => {
  const roll = [6000, 6150, 6300, 6450, 6600, 6750].map((t) => kickEv(t));
  const chart = buildNoteChart(roll, 7000); // boundary 6500 -> only 4 hits survive
  assert.equal(chart.holdCount, 0, 'clamped below HOLD_MIN_HITS -> no hold');
  assert.ok(chart.tapCount >= 1, 'the demoted roll kicks flow back through tap selection');
  assert.ok(6500 === 7000 - SONG_END_KEEPOUT_MS);
});

test('layered simultaneous kicks collapse to one hit before clustering', () => {
  const timeline = [];
  for (let i = 0; i < 5; i++) {
    timeline.push(kickEv(i * 160, 0.6), { ...kickEv(i * 160, 0.9), pitch: 35 }); // 35+36 doubled
  }
  const chart = buildNoteChart(timeline, 20000);
  assert.equal(chart.holdCount, 1, '5 real moments over 640ms is a hold');
  const ticks = chart.notes[0].tickTimesMs;
  assert.equal(ticks.length, 4, 'doubled layers must not double the pay ticks');
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
  assert.equal(chart.notes[0].vel, 0.9, 'a collapsed hit keeps the louder layer');
});

test('maxPossibleScore arithmetic: taps + hold start + ticks + bonus', () => {
  const timeline = [
    kickEv(0), kickEv(500), kickEv(1000), // 3 taps at a steady beat
    ...[3000, 3150, 3300, 3450, 3600].map((t) => kickEv(t)), // one 5-hit hold
  ];
  const chart = buildNoteChart(timeline, 20000);
  assert.equal(chart.tapCount, 3);
  assert.equal(chart.holdCount, 1);
  assert.equal(
    chart.maxPossibleScore,
    3 * TAP_SCORE + (TAP_SCORE + 4 * TICK_SCORE + HOLD_BONUS),
  );
});

test('a hold and surrounding taps merge into one sorted note list', () => {
  const timeline = [
    kickEv(0), kickEv(500),
    ...[2000, 2150, 2300, 2450, 2600].map((t) => kickEv(t)),
    kickEv(4000), kickEv(4500),
  ];
  const chart = buildNoteChart(timeline, 20000);
  assert.equal(chart.holdCount, 1);
  const types = chart.notes.map((n) => n.type);
  assert.deepEqual(types.filter((x) => x === 'hold').length, 1);
  for (let i = 1; i < chart.notes.length; i++) {
    assert.ok(chart.notes[i].tMs > chart.notes[i - 1].tMs);
  }
  const hold = chart.notes.find((n) => n.type === 'hold');
  assert.ok(chart.notes.some((n) => n.type === 'tap' && n.tMs > hold.endMs), 'taps resume after the hold');
});
