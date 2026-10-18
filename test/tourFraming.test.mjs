import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';

test('hero selection rejects a station whose altitude cannot be reached by its musical window', () => {
  const data = tourFixture();
  for (const p of data.points) if (p.role === 'chorus') {
    p.station.yM = 10000; p.grandeur = 1;
  }
  const viable = data.points.find(p => p.role === 'chorus' && p.tier === 'backup');
  viable.station.yM = 700; viable.grandeur = .1;
  data.points = [data.points.find(p => p.role === 'verse'), data.points.find(p => p.role === 'chorus'), viable];
  const sections = [{ startMs: 0, endMs: 120000, role: 'verse' }, { startMs: 120000, endMs: 240000, role: 'chorus' }];
  const plan = planTour(data, { sections, durationMs: 240000 });
  const chosen = plan.heroes.find(h => h.sectionIndex === 1 && !h.subHero && !h.passedAtRange);
  assert.ok(!chosen || chosen.pointId === viable.id, 'a faster road cannot make an impossible climb feasible');
});

test('timeline reports projected subject framing separately from physical station visits', () => {
  const data = tourFixture();
  for (const point of data.points) {
    point.localM = [point.station.posM[0] - 5000, 1137, point.station.posM[1]];
  }
  const point = data.points[0];
  const plan = { durationMs: 20000, previewPointId: point.id, notes: [], segments: [],
    heroes: [{ pointId: point.id, timeMs: 10000, passedAtRange: false }],
    routeAt: () => ({ posM: point.station.posM, floorY: 100, ceilY: 2000,
      speedMps: 0, pointId: point.id, role: 'intro', headingDeg: 270 }) };
  const tour = buildTourTimeline(data, plan);
  assert.ok(Array.isArray(tour.heroFraming), 'framing outcomes must travel with the prepared timeline');
  assert.equal(tour.heroFraming.length, tour.heroes.length);
  const feasible = tour.heroFraming.filter(h => h.stationVisit);
  assert.ok(feasible.length > 0);
  assert.ok(feasible.every(h => h.framedFraction >= .8), JSON.stringify(feasible));
  assert.ok(tour.heroFraming.every(h => ['station', 'distant', 'missed'].includes(h.outcome)));
});

test('an unreachable close visit still earns a deliberately framed distant view', () => {
  const data = tourFixture(), point = data.points[1], roadPoint = data.points[0];
  roadPoint.localM = [0, 1137, -5000];
  point.localM = [5000, 1137, 0];
  const plan = { durationMs: 20000, previewPointId: roadPoint.id, notes: [], segments: [],
    heroes: [{ pointId: point.id, timeMs: 10000, passedAtRange: true }],
    routeAt: () => ({ posM: [0, 0], floorY: 100, ceilY: 2000, speedMps: 0,
      pointId: roadPoint.id, role: 'intro', headingDeg: 0 }) };
  const tour = buildTourTimeline(data, plan);
  assert.equal(tour.heroFraming[0].outcome, 'distant', JSON.stringify(tour.heroFraming));
  assert.ok(tour.heroFraming[0].framedFraction >= .8);
});

test('a safe station also frames its named subject when its baked scenic aim looks elsewhere', () => {
  const data = tourFixture(), point = data.points[0];
  point.localM = [point.station.posM[0] - 5000, 1137, point.station.posM[1] - 3000];
  const plan = { durationMs: 20000, previewPointId: point.id, notes: [], segments: [],
    heroes: [{ pointId: point.id, timeMs: 10000, passedAtRange: false }],
    routeAt: () => ({ posM: point.station.posM, floorY: 100, ceilY: 2000,
      speedMps: 0, pointId: point.id, role: 'intro', headingDeg: 270 }) };
  const tour = buildTourTimeline(data, plan);
  assert.equal(tour.heroFraming[0].outcome, 'station');
  assert.ok(tour.heroFraming[0].framedFraction >= .8, JSON.stringify(tour.heroFraming));
});

test('station framing names its authored scenic subject separately from the road waypoint', () => {
  const data = tourFixture(), waypoint = data.points[0], subject = data.points[1];
  subject.localM = [waypoint.station.posM[0] - 5000, 1137, waypoint.station.posM[1]];
  waypoint.station.bestAim.subjectId = subject.id;
  const plan = { durationMs: 20000, previewPointId: waypoint.id, notes: [], segments: [],
    heroes: [{ pointId: waypoint.id, timeMs: 10000, passedAtRange: false }],
    routeAt: () => ({ posM: waypoint.station.posM, floorY: 100, ceilY: 2000,
      speedMps: 0, pointId: waypoint.id, role: 'intro', headingDeg: 270 }) };
  const tour = buildTourTimeline(data, plan), framing = tour.heroFraming[0];
  assert.equal(framing.pointId, waypoint.id);
  assert.equal(framing.framedPointId, subject.id);
  assert.equal(framing.outcome, 'station');
});
