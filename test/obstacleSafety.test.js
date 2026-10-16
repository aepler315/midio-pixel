import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObstacleSpawner, geoRowTimes } from '../src/sim/ObstacleSpawner.js';
import { predictJumpArcs } from '../src/sim/JumpPlanner.js';
import { jumpY } from '../src/sim/JumpController.js';
import { GUARDRAIL_MIN } from '../src/core/ParamBus.js';
import { buildDemoTimeline } from '../src/core/DemoTimeline.js';
import { Role, makeNoteEvent } from '../src/core/NoteEvent.js';
import { mulberry32 } from '../src/utils/math.js';

const OBSTACLE_HEIGHT = 46;
const OBSTACLE_WIDTH = 28;
const MARGIN = 14;
const MIDIO_HALF_WIDTH = 23;

/** Independently re-derives worst-case arcs and asserts a candidate's full
 * crossing window (at the slowest possible scroll speed) stays above the
 * obstacle-clearance threshold for its whole traversal. */
function assertCandidateIsSafe(candidateMs, kicks) {
  const arcs = predictJumpArcs(kicks, { jumpHeightMul: GUARDRAIL_MIN });
  const worstScrollPxPerMs = (220 * GUARDRAIL_MIN) / 1000;
  const crossHalfMs = (MIDIO_HALF_WIDTH + OBSTACLE_WIDTH / 2) / worstScrollPxPerMs;
  const threshold = OBSTACLE_HEIGHT + MARGIN;

  const arc = arcs.find((a) => candidateMs - crossHalfMs >= a.takeoffMs && candidateMs + crossHalfMs <= a.landMs);
  assert.ok(arc, `candidate at ${candidateMs}ms (crossing +/-${crossHalfMs.toFixed(0)}ms) must fall entirely within one arc`);

  for (let t = candidateMs - crossHalfMs; t <= candidateMs + crossHalfMs; t += 5) {
    const u = (t - arc.takeoffMs) / arc.D;
    const y = jumpY(Math.min(1, u), arc.H);
    assert.ok(y >= threshold, `altitude ${y.toFixed(1)}px at t=${t.toFixed(0)} must clear threshold ${threshold}px`);
  }
}

/** A candidate is either a single obstacle ({tMs}) or a lined-up geometric
 *  row ({row}); assert every obstacle it produces is worst-case clearable. */
function assertObstacleCandidateSafe(c, kicks) {
  if (c.row) {
    for (const t of geoRowTimes(c.row.fromMs, c.row.toMs, c.row.count)) assertCandidateIsSafe(t, kicks);
  } else {
    assertCandidateIsSafe(c.tMs, kicks);
  }
}

function extractKicks(timeline) {
  return timeline.filter((e) => e.role === Role.RHYTHM && e.kick).map((e) => ({ tMs: e.tMs, vel: e.vel }));
}

test('every obstacle candidate on the demo timeline sits in a verified worst-case-safe window', () => {
  const data = buildDemoTimeline({ bpm: 128, bars: 64, seed: 42 });
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } });
  spawner.buildCandidates(data.timeline, 60000 / 128, MIDIO_HALF_WIDTH);

  assert.ok(spawner.candidates.length > 0, 'expected at least some obstacle candidates on a 64-bar demo');
  const kicks = extractKicks(data.timeline);
  for (const c of spawner.candidates) assertObstacleCandidateSafe(c, kicks);
});

test('obstacle candidates stay safe across a range of BPMs, including halftime territory', () => {
  for (const bpm of [90, 128, 150, 190]) {
    const data = buildDemoTimeline({ bpm, bars: 48, seed: 7 });
    const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } });
    spawner.buildCandidates(data.timeline, 60000 / bpm, MIDIO_HALF_WIDTH);
    const kicks = extractKicks(data.timeline);
    for (const c of spawner.candidates) assertObstacleCandidateSafe(c, kicks);
  }
});

test('obstacle candidates stay safe with randomized velocities and irregular kick spacing', () => {
  const rand = mulberry32(99);
  const timeline = [];
  let t = 0;
  for (let i = 0; i < 150; i++) {
    t += 300 + rand() * 500;
    timeline.push(makeNoteEvent({ tMs: t, pitch: 36, vel: 0.3 + rand() * 0.7, role: Role.RHYTHM, kick: true, src: 'audio' }));
    // A handful of off-kick accents scattered around, some strong enough to be candidates.
    if (rand() < 0.6) {
      timeline.push(makeNoteEvent({ tMs: t + 150 + rand() * 150, pitch: 38, vel: 0.5 + rand() * 0.5, role: Role.RHYTHM, kick: false, src: 'audio' }));
    }
  }
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } });
  spawner.buildCandidates(timeline, 500, MIDIO_HALF_WIDTH);
  const kicks = extractKicks(timeline);
  for (const c of spawner.candidates) assertObstacleCandidateSafe(c, kicks);
});

test('no safe window is invented for an arc that never clears the obstacle height', () => {
  // A single, very weak kick (vel near 0) at worst-case jump-height guardrail
  // should produce zero candidates rather than an unsafe one.
  const timeline = [makeNoteEvent({ tMs: 0, pitch: 36, vel: 0.01, role: Role.RHYTHM, kick: true, src: 'audio' })];
  timeline.push(makeNoteEvent({ tMs: 200, pitch: 38, vel: 0.9, role: Role.RHYTHM, kick: false, src: 'audio' }));
  const spawner = new ObstacleSpawner({ live: { obstacleDensity: 1 } });
  spawner.buildCandidates(timeline, 500, MIDIO_HALF_WIDTH);
  assert.equal(spawner.candidates.length, 0);
});
