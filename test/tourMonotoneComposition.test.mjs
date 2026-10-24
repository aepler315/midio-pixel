import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';
import { tourYawBudget } from '../src/world/terrain/TourMotion.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';

// A fixed eye on a static road. With uniform view scores the route aims at
// the road point, heading 0; a subject `bearing` degrees clockwise sits at
// the same height 5 km away.
function staticRoute(durationMs, { stop = false } = {}) {
  const data = tourFixture();
  data.points = data.points.slice(0, 6);
  const [road, ...subjects] = data.points;
  road.role = 'road';
  // Distinct roles: a test shares one only where it wants an alternative.
  subjects.forEach((point, index) => { point.role = `subject-${index}`; });
  road.localM = [0, 1137, -5000];
  const plan = {
    durationMs, previewPointId: road.id, notes: [], segments: [], heroes: [],
    routeAt: () => ({ posM: [0, 0], floorY: 100, ceilY: 2000, speedMps: 0, pointId: road.id, role: 'intro', headingDeg: 0, stop }),
  };
  const place = (point, bearing) => {
    point.localM = [5000 * Math.sin(bearing * Math.PI / 180), 1137, -5000 * Math.cos(bearing * Math.PI / 180)];
    return point;
  };
  return { data, plan, subjects, place };
}
const passed = (point, timeMs) => ({ pointId: point.id, timeMs, passedAtRange: true });
const framing = (tour, point) => tour.heroFraming.find(hero => hero.pointId === point.id);
function windowTargets(tour, timeMs) {
  const from = Math.floor((timeMs - 1500) / 100), to = Math.ceil((timeMs + 1500) / 100);
  return Array.from(tour.target.subarray(from * 3, (to + 1) * 3));
}

// Every sampled interval, including the slerp inside each 100 ms frame,
// stays within the shared yaw budget.
function assertYawWithinBudget(tour, plan, stepMs) {
  const frames = Array.from({ length: tour.fov.length }, (_, i) => ({ ...plan.routeAt(), timeMs: Math.min(tour.durationMs, i * 100) }));
  const budget = tourYawBudget(frames);
  const heading = time => { const p = tour.poseAt(time); return Math.atan2(p.targetM[0] - p.eyeM[0], -(p.targetM[2] - p.eyeM[2])) * 180 / Math.PI; };
  let previous = heading(0), worst = 0;
  for (let time = stepMs; time <= tour.durationMs; time = Math.min(tour.durationMs, time + stepMs)) {
    const current = heading(time), turn = Math.abs(((current - previous + 540) % 360) - 180);
    worst = Math.max(worst, turn - budget(time - stepMs, time));
    previous = current;
    if (time === tour.durationMs) break;
  }
  assert.ok(worst <= .002, `yaw exceeds the budget by ${worst} degrees at ${stepMs} ms sampling`);
}

test('a subject already in frame is recorded without moving a held camera', () => {
  const { data, plan, subjects: [intended, alternative], place } = staticRoute(20000, { stop: true });
  place(intended, 170);
  place(alternative, 10);
  alternative.role = intended.role;
  const held = buildTourTimeline(data, plan);
  const tour = buildTourTimeline(data, { ...plan, heroes: [passed(intended, 10000)] });
  assert.deepEqual(tour.target, held.target, 'recording a subject must not move the camera');
  assert.deepEqual(tour.fov, held.fov);
  const hero = tour.heroFraming[0];
  assert.equal(hero.framedPointId, alternative.id);
  assert.equal(hero.reason, 'retained-in-frame-subject');
  assert.ok(hero.framedFraction >= .8 && hero.alternative && hero.intendedFramedFraction === 0, JSON.stringify(hero));
});

for (const [bearing] of [[170], [100]]) {
  test(`a miss reachable only at the full yaw rate is covered within the budget (bearing ${bearing})`, () => {
    const { data, plan, subjects: [intended], place } = staticRoute(18000);
    place(intended, bearing);
    const tour = buildTourTimeline(data, { ...plan, heroes: [passed(intended, 15000)] });
    const hero = tour.heroFraming[0];
    assert.equal(hero.framedPointId, intended.id);
    assert.equal(hero.reason, 'rate-limited-intended-subject');
    assert.ok(hero.framedFraction >= .8 && hero.intendedFramedFraction >= .8, JSON.stringify(hero));
    for (const stepMs of [25, 50]) assertYawWithinBudget(tour, plan, stepMs);
  });
}

test('a chase that cannot rejoin the route before its end leaves the camera unchanged', () => {
  const { data, plan, subjects: [intended], place } = staticRoute(30000);
  place(intended, 170);
  const route = buildTourTimeline(data, plan);
  const tour = buildTourTimeline(data, { ...plan, heroes: [passed(intended, 15000)] });
  assert.deepEqual(tour.target, route.target, 'a ramp that cannot return before frames it does not own is rejected');
  assert.equal(tour.heroFraming[0].outcome, 'missed');
});

test('a later shot covered by the first pass is never traded for an earlier miss', () => {
  const { data, plan, subjects: [held, early, late], place } = staticRoute(40000);
  place(held, 2);
  place(early, -70);
  place(late, 80);
  // The first pass rejects `early` (its smoothstep needs 36 deg/s after the
  // held shot) and composes `late` over 20.6-28.5 s. Chasing `early` first
  // would leave `late` only 1.9 s to turn 127 degrees.
  const heroes = [passed(held, 19000), passed(early, 25000), passed(late, 30000)];
  const withoutEarly = buildTourTimeline(data, { ...plan, heroes: heroes.filter(h => h.pointId !== early.id) });
  const tour = buildTourTimeline(data, { ...plan, heroes });
  assert.ok(framing(withoutEarly, late).framedFraction >= .8, 'the first pass covers the later shot');
  assert.equal(framing(tour, late).framedPointId, late.id);
  assert.ok(framing(tour, late).framedFraction >= .8, JSON.stringify(framing(tour, late)));
  assert.deepEqual(windowTargets(tour, 30000), windowTargets(withoutEarly, 30000), 'the later window keeps every byte');
  assert.deepEqual(windowTargets(tour, 19000), windowTargets(withoutEarly, 19000));
  assert.equal(framing(tour, early).outcome, 'missed', 'the earlier miss stays an honest miss');
});

test('intended upgrades are off by default and replace only the alternative they are asked to', () => {
  // 22 s: the first pass has 5.5 s to release its 40 degree alternative, and
  // the shot's ramp still ends on the song's final frame.
  const { data, plan, subjects: [intended, alternative, held], place } = staticRoute(22000);
  place(intended, 170);
  place(alternative, 40);
  place(held, 2);
  alternative.role = intended.role;
  const shot = { ...plan, heroes: [passed(held, 4000), passed(intended, 15000)] };
  const absent = buildTourTimeline(data, shot), off = buildTourTimeline(data, shot, { upgradeIntended: false });
  assert.deepEqual(off.target, absent.target);
  assert.deepEqual(off.heroFraming, absent.heroFraming);
  assert.equal(framing(absent, intended).framedPointId, alternative.id, 'by default the accepted alternative stays');
  const upgraded = buildTourTimeline(data, shot, { upgradeIntended: true });
  const hero = framing(upgraded, intended);
  assert.equal(hero.framedPointId, intended.id);
  assert.equal(hero.reason, 'rate-limited-intended-upgrade');
  assert.ok(hero.intendedFramedFraction >= .8, JSON.stringify(hero));
  assert.deepEqual(windowTargets(upgraded, 4000), windowTargets(absent, 4000), 'other covered windows are untouched');
  for (const stepMs of [25, 50]) assertYawWithinBudget(upgraded, plan, stepMs);
});
