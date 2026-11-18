import test from 'node:test';
import assert from 'node:assert/strict';
import { tourBeatsRail } from '../src/world/alpine/CameraChoice.js';
import { buildShotTimeline, restoreShotTimeline, shotTimelineData } from '../src/world/terrain/ShotTimeline.js';

const shot = { subjectId: 'peak', payoffS: 100, holdS: [0, 200], path: {
  s: [0, 100, 200], eye: [0, 500, 0, 100, 500, 0, 200, 500, 0],
  aim: [0, 500, -1000, 100, 500, -1000, 200, 500, -1000], fov: [30, 30, 30], flow: [0, 0, 0],
} };
const library = { subjects: [{ id: 'peak' }], shotById: new Map([['shot', shot]]) };
const plan = { durationMs: 10000, fallback: null, start: { speedMps: 10, accelMps2: 2 }, items: [
  { kind: 'shot', id: 'shot', startMs: 0, endMs: 10000, sFrom: 0, sTo: 200, payoffMs: 5000 },
] };

test('a built timeline keeps its structured acceleration diagnostics across a worker clone', () => {
  const source = buildShotTimeline(library, plan, { tunables: { maxAccelMps2: 1 } });
  const data = structuredClone(shotTimelineData(source));
  assert.deepEqual(data.diagnostics.limitBreaches.map(b => b.kind), ['progressAccel', 'eyeAccel']);
  assert.ok(data.diagnostics.limitBreaches.every(b => b.value > b.limit));
  data.notes = []; data.diagnostics.notes = [];
  const verdict = tourBeatsRail(restoreShotTimeline(data));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /^progress acceleration/);
});

test('missing arrivals reject a tour without reporting an infinite timing error', () => {
  const timeline = buildShotTimeline(library, plan);
  assert.equal(tourBeatsRail(timeline).ok, true);
  for (const actualMs of [null, NaN, Infinity]) {
    const verdict = tourBeatsRail({ ...timeline, payoffs: [{ plannedMs: 5000, actualMs }] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /no arrival time/);
    assert.equal(verdict.metrics.missingPayoffs, 1);
    assert.equal(verdict.metrics.payoffErrorMs, null);
  }
});
