import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTourTimeline, measureHeroFraming, restoreTourTimeline, summarizeHeroCoverage } from '../src/world/terrain/TourTimeline.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';

function fixedRouteFixture(durationMs = 20000) {
  const data = tourFixture();
  data.points = data.points.slice(0, 3);
  const [road, intended, alternative] = data.points;
  // Keep the road out of the same-role alternatives so the test controls
  // both the geometrically impossible subject and its feasible replacement.
  road.role = 'road';
  road.localM = [0, 1137, -5000];
  const plan = {
    durationMs, previewPointId: road.id, notes: [], segments: [], heroes: [],
    routeAt: () => ({
      posM: [0, 0], floorY: 100, ceilY: 2000, speedMps: 0,
      pointId: road.id, role: 'intro', headingDeg: 0,
    }),
  };
  return { data, plan, road, intended, alternative };
}

test('an off-screen pitch-clamped candidate cannot prevent a feasible distant alternative', () => {
  const { data, plan, intended, alternative } = fixedRouteFixture();
  intended.localM = [5000, 20000, 0];
  alternative.localM = [5000, 1137, 0];
  plan.heroes = [{ pointId: intended.id, timeMs: 10000, passedAtRange: true }];

  const tour = buildTourTimeline(data, plan), framing = tour.heroFraming[0];
  assert.equal(tour.heroes[0].framingPointId, alternative.id,
    'the intended subject is far above the permitted pitch and must be rejected before trying the alternative');
  assert.equal(framing.framedPointId, alternative.id);
  assert.ok(framing.framedFraction >= .8, JSON.stringify(framing));
  assert.equal(framing.outcome, 'distant');
  assert.equal(framing.intendedPointId, intended.id);
  assert.equal(framing.intendedFramedFraction, 0,
    'a successful alternative must not count as coverage of the intended subject');
  assert.deepEqual(tour.heroCoverage, summarizeHeroCoverage(tour.heroFraming),
    'the prepared timeline carries the semantic report alongside scenic quality');
});

test('a distant candidate with no usable projected subject leaves the safe camera unchanged', () => {
  const { data, plan, intended } = fixedRouteFixture();
  data.points = data.points.slice(0, 2);
  intended.localM = [5000, 20000, 0];
  const safe = buildTourTimeline(data, plan);
  const tour = buildTourTimeline(data, {
    ...plan, heroes: [{ pointId: intended.id, timeMs: 10000, passedAtRange: true }],
  });

  assert.deepEqual(tour.target, safe.target,
    'failed framing attempts must roll back their yaw and pitch changes');
  assert.deepEqual(tour.fov, safe.fov);
  assert.equal(tour.heroes[0].framingPointId, undefined,
    'a failed candidate must not be recorded as an accepted composition');
  assert.equal(tour.heroFraming[0].outcome, 'missed');
});

test('a stopped route cannot acquire a pitch-only distant camera move', () => {
  const { data, plan, intended } = fixedRouteFixture();
  data.points = data.points.slice(0, 2);
  intended.localM = [0, 4500, -5000];
  const routeAt = plan.routeAt;
  plan.routeAt = time => ({ ...routeAt(time), stop: true });
  const stopped = buildTourTimeline(data, plan);
  const withHero = buildTourTimeline(data, {
    ...plan, heroes: [{ pointId: intended.id, timeMs: 10000, passedAtRange: true }],
  });
  assert.deepEqual(withHero.target, stopped.target,
    'a zero yaw budget also freezes pitch on the deliberately held view');
  assert.deepEqual(withHero.fov, stopped.fov);
  assert.equal(withHero.heroFraming[0].outcome, 'missed');
});

test('a later pitch-only composition preserves an earlier accepted shot in full', () => {
  const { data, plan, intended: first, alternative: later } = fixedRouteFixture(25000);
  first.localM = [0, 1300, -5000];
  later.localM = [0, 4500, -5000];
  const earlier = { pointId: first.id, timeMs: 10000, passedAtRange: true };
  const before = buildTourTimeline(data, { ...plan, heroes: [earlier] });
  assert.equal(before.heroFraming[0].framedFraction, 1, 'this is an actually accepted earlier shot');
  const after = buildTourTimeline(data, {
    ...plan, heroes: [earlier, { pointId: later.id, timeMs: 16000, passedAtRange: true }],
  });

  assert.equal(after.heroFraming[0].framedFraction, 1,
    'heading equality alone does not preserve coverage when pitch changes');
  for (let time = 8500; time <= 11500; time += 100) {
    const a = before.poseAt(time), b = after.poseAt(time);
    assert.deepEqual(b.eyeM, a.eyeM, `accepted eye at ${time} ms`);
    assert.deepEqual(b.targetM, a.targetM, `accepted heading and pitch at ${time} ms`);
    assert.equal(b.fovYDeg, a.fovYDeg, `accepted FOV at ${time} ms`);
  }
});

test('repairing an earlier hero preserves a future subject that is already framed', () => {
  const { data, plan, intended: earlierPoint, alternative: futurePoint } = fixedRouteFixture(25000);
  earlierPoint.role = futurePoint.role = 'verse';
  earlierPoint.localM = [5000, 1137, 0];
  futurePoint.localM = [0, 1137, -5000];
  const earlier = { pointId: earlierPoint.id, timeMs: 10000, passedAtRange: true };
  const future = { pointId: futurePoint.id, timeMs: 15000, passedAtRange: true };
  const baseline = buildTourTimeline(data, { ...plan, heroes: [future] });
  assert.equal(baseline.heroFraming[0].framedFraction, 1,
    'the future intended subject is accepted before any repair');
  for (const heroes of [[earlier, future], [future, earlier]]) {
    const candidate = buildTourTimeline(data, { ...plan, heroes });
    const after = candidate.heroFraming.find(hero => hero.pointId === futurePoint.id);
    assert.equal(after.framedPointId, futurePoint.id,
      'an earlier repair must not replace an already covered future subject with its own alternative');
    assert.equal(after.intendedFramedFraction, 1,
      'initially accepted future coverage must survive regardless of hero array order');
  }
});

test('distant composition cannot change any pose through the committed horizon', () => {
  const { data, plan, intended } = fixedRouteFixture(30000);
  intended.localM = [5000, 1137, 0];
  const previous = buildTourTimeline(data, plan);
  const next = buildTourTimeline(data, {
    ...plan, heroes: [{ pointId: intended.id, timeMs: 20000, passedAtRange: true }],
  }, { previous, frozenThroughMs: 10000 });

  for (let time = 0; time <= 10000; time += 100) {
    assert.deepEqual(next.poseAt(time), previous.poseAt(time), `committed pose at ${time} ms`);
  }
  assert.ok(next.heroFraming[0].framedFraction >= .8, 'the uncommitted tail can still earn a distant shot');
});

test('framing reports the authored station subject separately from a composed alternative', () => {
  const data = { points: [
    { id: 'waypoint', localM: [0, 0, -10], station: { posM: [0, 0], bestAim: { subjectId: 'intended' } } },
    { id: 'intended', localM: [10, 0, 0] },
    { id: 'alternative', localM: [0, 0, -10] },
  ] };
  const tour = {
    durationMs: 4000,
    heroes: [{ pointId: 'waypoint', framingPointId: 'alternative', timeMs: 2000, passedAtRange: false }],
    poseAt: () => ({ eyeM: [0, 0, 0], targetM: [0, 0, -10], fovYDeg: 45 }),
  };
  const framing = measureHeroFraming(tour, data)[0];
  assert.equal(framing.intendedPointId, 'intended');
  assert.equal(framing.intendedFramedFraction, 0);
  assert.equal(framing.framedPointId, 'alternative');
  assert.equal(framing.framedFraction, 1);
});

test('hero projection checks include the exact fractional song endpoint', () => {
  const calls = [];
  const tour = {
    durationMs: 984, heroes: [{ pointId: 'ending', timeMs: 875, passedAtRange: true }],
    poseAt: time => {
      calls.push(time);
      return { eyeM: [0, 0, 0], targetM: [0, 0, time === 984 ? 10 : -10], fovYDeg: 45 };
    },
  };
  const framing = measureHeroFraming(tour, { points: [{ id: 'ending', localM: [0, 0, -10] }] })[0];
  assert.ok(calls.includes(984), 'the final camera pose must be checked even when it is off the 250 ms grid');
  assert.ok(framing.framedFraction < 1, 'losing the subject at the endpoint must appear in the measured coverage');
});

test('coverage summary keeps intended subjects, alternatives, and ending misses distinct', () => {
  const data = { points: [
    { id: 'verse', localM: [0, 0, -10] },
    { id: 'chorus', localM: [10, 0, 0] },
    { id: 'alternative', localM: [0, 0, -20] },
    { id: 'outro', localM: [0, 0, 10] },
  ] };
  const tour = {
    durationMs: 4000,
    heroes: [
      { pointId: 'verse', role: 'verse', timeMs: 1000, passedAtRange: true },
      { pointId: 'chorus', role: 'chorus', timeMs: 2000, passedAtRange: true,
        framingPointId: 'alternative', finalChorus: true },
      { pointId: 'outro', role: 'outro', timeMs: 3000, passedAtRange: true },
    ],
    poseAt: () => ({ eyeM: [0, 0, 0], targetM: [0, 0, -10], fovYDeg: 45 }),
  };
  const framing = measureHeroFraming(tour, data), summary = summarizeHeroCoverage(framing);
  assert.equal(summary.projectionOnly, true);
  assert.equal(summary.total, 3);
  assert.equal(summary.intended, 1);
  assert.equal(summary.alternative, 1);
  assert.equal(summary.station, 0);
  assert.equal(summary.distant, 2);
  assert.equal(summary.missed, 1);
  assert.deepEqual(summary.endings.map(hero => [hero.pointId, hero.intendedFramedFraction, hero.framedFraction]),
    [['chorus', 0, 1], ['outro', 0, 0]], 'the final chorus alternative and missed outro remain explicit');
});

for (const durationMs of [50, 184]) {
  test(`restored timeline uses the real final interval for its ${durationMs} ms endpoint`, () => {
    const times = durationMs < 100 ? [0, durationMs] : [0, 100, durationMs];
    const tour = restoreTourTimeline({
      durationMs,
      eye: Float32Array.from(times.flatMap(t => [t, 0, 0])),
      target: Float32Array.from(times.flatMap(t => [t, 0, -12000])),
      fov: Float32Array.from(times.map(t => 30 + t / 10)),
      meta: new Uint16Array(times.length * 4), heroes: [],
    });
    assert.deepEqual(tour.poseAt(durationMs).eyeM, [durationMs, 0, 0]);
    assert.deepEqual(tour.poseAt(durationMs).targetM, [durationMs, 0, -12000]);
    assert.equal(tour.poseAt(durationMs).fovYDeg, tour.fov.at(-1));
    const middle = (times.at(-2) + durationMs) / 2;
    assert.ok(Math.abs(tour.poseAt(middle).eyeM[0] - middle) < 1e-6,
      'the shortened final interval must interpolate at its actual elapsed fraction');
  });
}
