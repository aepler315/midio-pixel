import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTourTimeline } from '../src/world/terrain/TourTimeline.js';
import { tourYawBudget } from '../src/world/terrain/TourMotion.js';

const delta = (a, b) => ((a - b + 540) % 360) - 180;
const heading = pose => Math.atan2(pose.targetM[0] - pose.eyeM[0], -(pose.targetM[2] - pose.eyeM[2])) * 180 / Math.PI;
function schedule({ durationMs = 20000, secondTime = 14000, secondHeading = 110, switchMs = 5000, stop = null } = {}) {
  const point = (id, headingDeg) => {
    const a = headingDeg * Math.PI / 180, pitch = 5 * Math.PI / 180;
    return { id, role: 'verse', localM: [12000 * Math.sin(a), 700 + 12000 * Math.tan(pitch), -12000 * Math.cos(a)],
      station: { posM: [0, 0], yM: 700, bestAim: { headingDeg, pitchDeg: 5, hfovDeg: 55, score: 1, subjectId: id } } };
  };
  const points = [point('first', 0), point('second', secondHeading)];
  const sample = { posM: [0, 0], floorY: 100, ceilY: 2000,
    tiers: [220, 700, 1100].map(yM => ({ yM, score: new Uint8Array(72).fill(255), pitch: new Int8Array(36).fill(5), fovIdx: new Uint8Array(18).fill(85) })) };
  const data = { points, field: { samples: [sample], edges: [] }, roles: ['verse', 'outro'], tunables: { aimSmoothSec: .6 } };
  const roleAt = time => time < switchMs ? 'verse' : 'outro';
  const plan = { durationMs, reducedMotion: false, notes: [], previewPointId: 'first', heroes: [
    { pointId: 'first', timeMs: 2000, passedAtRange: false },
    { pointId: 'second', timeMs: secondTime, passedAtRange: false },
  ], routeAt: time => ({ posM: [0, 0], floorY: 100, ceilY: 2000, speedMps: 0,
    role: roleAt(time), pointId: time < secondTime ? 'first' : 'second', headingDeg: 0,
    stop: !!stop && time >= stop[0] && time <= stop[1] }) };
  return { data, plan, roleAt };
}
function assertMotion(tour, roleAt, reducedMotion = false) {
  let previous = tour.poseAt(0);
  for (let t = 100; t <= tour.durationMs + 99; t += 100) {
    const time = Math.min(t, tour.durationMs), pose = tour.poseAt(time), dt = (time - Math.min(t - 100, tour.durationMs)) / 1000;
    const yaw = reducedMotion || ['outro', 'breakdown'].includes(roleAt(time)) ? 12 : 25;
    assert.ok([...pose.eyeM, ...pose.targetM, pose.fovYDeg].every(Number.isFinite), `finite pose at ${time}`);
    assert.ok(pose.eyeM[1] >= 105 && pose.eyeM[1] <= 2000, `clearance at ${time}`);
    assert.ok(Math.abs(pose.eyeM[1] - previous.eyeM[1]) <= (reducedMotion ? 15 : 30) * dt + .01, `climb at ${time}`);
    assert.ok(Math.abs(delta(heading(pose), heading(previous))) <= yaw * dt + .02, `yaw at ${time}`);
    previous = pose;
  }
}

test('future aim feasibility integrates normal and slow roles through final smoothing', () => {
  const { data, plan, roleAt } = schedule();
  const tour = buildTourTimeline(data, plan);
  assert.ok(tour.heroes.every(hero => !hero.passedAtRange), 'both physically reachable station shots are retained');
  assertMotion(tour, roleAt);
  assert.ok(Math.abs(delta(heading(tour.poseAt(12500)), 110)) < .02, 'the second lock begins on time');
});

test('a blocking future lock is released legally even before its active window', () => {
  const { data, plan, roleAt } = schedule({ secondTime: 5500, secondHeading: 180 });
  const tour = buildTourTimeline(data, plan);
  assert.equal(tour.heroes[0].passedAtRange, false, 'the already feasible first shot is preserved');
  assert.equal(tour.heroes[1].passedAtRange, true, 'only the unreachable later shot is released');
  assert.match(tour.notes.join('\n'), /second: aim lock unreachable/);
  assertMotion(tour, roleAt);
});

for (const reducedMotion of [false, true]) {
  test(`fractional final frame respects actual elapsed yaw time, reduced motion ${reducedMotion}`, () => {
    const { data, plan, roleAt } = schedule({ durationMs: 14951, secondHeading: 80 });
    const tour = buildTourTimeline(data, plan, { reducedMotion });
    assertMotion(tour, roleAt, reducedMotion);
  });
}

test('yaw capacity includes role transitions, stopped intervals and the final fractional frame', () => {
  const frames = [
    { timeMs: 0, role: 'verse' }, { timeMs: 100, role: 'verse' },
    { timeMs: 200, role: 'outro', stop: true }, { timeMs: 300, role: 'outro', stop: true },
    { timeMs: 351, role: 'verse' },
  ];
  const normal = tourYawBudget(frames), reduced = tourYawBudget(frames, { reducedMotion: true });
  assert.ok(Math.abs(normal(0, 351) - (2.5 + 1.2 + 0 + 1.275)) < 1e-9);
  assert.ok(Math.abs(normal(50, 225) - (1.25 + 1.2)) < 1e-9);
  assert.ok(Math.abs(reduced(0, 351) - (1.2 + 1.2 + 0 + .612)) < 1e-9);
  assert.equal(normal(300, 200), 0);
});

test('stopped intervals keep their aim and still leave enough time for a reachable later shot', () => {
  const { data, plan, roleAt } = schedule({ secondHeading: 45, stop: [5000, 10000] });
  const tour = buildTourTimeline(data, plan);
  assert.ok(tour.heroes.every(hero => !hero.passedAtRange));
  for (let t = 5100; t <= 10000; t += 100) {
    assert.ok(Math.abs(delta(heading(tour.poseAt(t)), heading(tour.poseAt(t - 100)))) < .01, `stopped view at ${t}`);
  }
  assertMotion(tour, roleAt);
});

test('an unreachable first future lock is released without changing a committed prefix', () => {
  const { data, plan, roleAt } = schedule();
  const previous = buildTourTimeline(data, { ...plan, heroes: [{ ...plan.heroes[0], timeMs: 2500 }] });
  const changed = { ...plan, heroes: [{ ...plan.heroes[1], timeMs: 5500 }] };
  const next = buildTourTimeline(data, changed, { previous, frozenThroughMs: 4000, qualityRetry: false });
  assert.equal(next.heroes[0].passedAtRange, true);
  assert.match(next.notes.join('\n'), /second: aim lock unreachable/);
  for (let t = 0; t <= 4000; t += 100) assert.deepEqual(next.poseAt(t), previous.poseAt(t), `committed pose at ${t}`);
  assertMotion(next, roleAt);
});

test('a dense set of incompatible locks uses bounded recovery and preserves a feasible shot', () => {
  const { data, plan, roleAt } = schedule({ durationMs: 20000 });
  const first = data.points[0], second = data.points[1];
  plan.heroes = Array.from({ length: 18 }, (_, i) => ({ pointId: i % 2 ? second.id : first.id,
    timeMs: 2000 + i * 200, passedAtRange: false }));
  let routeReads = 0;
  const routeAt = plan.routeAt;
  plan.routeAt = time => {
    assert.ok(++routeReads <= 5 * (Math.ceil(plan.durationMs / 100) + 1), 'lock recovery must not recursively rebuild the route');
    return routeAt(time);
  };
  const tour = buildTourTimeline(data, plan, { qualityRetry: false });
  assert.ok(tour.heroes.some(hero => !hero.passedAtRange), 'feasible station shots survive recovery');
  assert.ok(tour.heroes.some(hero => hero.passedAtRange), 'incompatible locks are explicitly released');
  assert.ok(tour.notes.filter(note => /aim lock unreachable/.test(note)).length <= plan.heroes.length);
  assertMotion(tour, roleAt);
});
