import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShotTour, shotPaceLimits } from '../src/world/terrain/ShotPlanner.js';
import { buildShotTimeline, shotContinuation, SHOT_MOTION } from '../src/world/terrain/ShotTimeline.js';
import { packShotPaths, decodeShotLibrary, SHOT_SCHEMA, SHOT_VERSION } from '../src/world/terrain/ShotLibrary.js';

function decoded(shots, links = [], maxClimbMps = 22) {
  const packed = packShotPaths([...shots, ...links]);
  const records = list => list.map(({ path, ...record }) => record);
  return decodeShotLibrary({ schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId: 'climb-fixture', terrainManifestSha256: 'a'.repeat(64),
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' }, motion: { ...SHOT_MOTION, maxClimbMps },
    subjects: shots.map(s => ({ id: s.subjectId, kind: 'landmark', posM: [0, 0, -1000], radiusM: 100 })), shots: records(shots), links: records(links),
    payload: { url: 'fixture.bin', byteLength: packed.length, decodedByteLength: packed.length, sha256: 'b'.repeat(64), decodedSha256: 'c'.repeat(64) } }, packed);
}
function path(eyes, step = 100) {
  return { s: Float32Array.from(eyes, (_, i) => i * step), eye: Float32Array.from(eyes.flat()),
    aim: Float32Array.from(eyes.flatMap(([x, y, z]) => [x, y, z - 1000])), fov: new Float32Array(eyes.length).fill(36), flow: new Float32Array(eyes.length).fill(.0001) };
}
function shot(id, p, payoffS = p.s.at(-1) / 2) {
  return { id, subjectId: id, move: 'traverse', path: p, lengthM: p.s.at(-1), payoffS, holdS: [payoffS, payoffS],
    durationMs: { min: p.s.at(-1) / 120 * 1000, max: p.s.at(-1) / 4 * 1000 }, traits: { headingDeg: 0, aglM: 1000, lens: 'wide' }, score: { total: 1 }, tags: [] };
}
const straight = maxClimb => decoded([shot('climb', path(Array.from({ length: 21 }, (_, i) => [60 * i, 1000 + 80 * i, 0])))], [], maxClimb);
const song = durationMs => ({ durationMs, sections: [{ startMs: 0, endMs: durationMs / 2, label: 'I' }, { startMs: durationMs / 2, endMs: durationMs, label: 'C' }],
  roles: [{ role: 'intro' }, { role: 'chorus', finalChorus: true }], energy: new Float32Array(Math.ceil(durationMs / 100) + 1).fill(.5), energyStepMs: 100, seed: 0 });
function drawnClimb(t) {
  let max = 0;
  for (let ms = 0; ms < t.durationMs; ms += 10) { const end = Math.min(ms + 10, t.durationMs); max = Math.max(max, Math.abs(t.poseAt(end).eyeM[1] - t.poseAt(ms).eyeM[1]) * 1000 / (end - ms)); }
  return max;
}

test('a configured climb cap rejects a fast decoded shot that otherwise has a legal payoff', () => {
  const fast = planShotTour(straight(100), song(20000));
  assert.equal(fast.fallback, null);
  assert.ok(Math.abs(drawnClimb(buildShotTimeline(straight(100), fast)) - 80) < 1e-8);
  assert.match(planShotTour(straight(22), song(20000)).fallback, /no feasible/);
});

test('runtime climb overrides constrain a feasible slow shot without changing other motion limits', () => {
  const lib = straight(100), options = song(80000), legal = planShotTour(lib, { ...options, tunables: { maxClimbMps: 22 } });
  assert.equal(legal.fallback, null);
  assert.ok(drawnClimb(buildShotTimeline(lib, legal)) <= 22 + 1e-6);
  assert.match(planShotTour(lib, { ...options, tunables: { maxClimbMps: 1 } }).fallback, /no feasible/);
});

test('the climb cap uses the smoothed vertical derivative through link support joins', () => {
  const a = shot('a', path([[-160, 1000, 0], [-80, 1000, 0]])), b = shot('b', path([[80, 1040, 0], [160, 1040, 0]]));
  const p = path([[-80, 1000, 0], [0, 1040, 0], [80, 1040, 0]]), link = { id: 'join', from: a.id, to: b.id, kind: 'direct', path: p, lengthM: 200, durationMs: { min: 2000, max: 50000 }, score: { total: 1 } };
  // The joined vertical Catmull segment is [0,0,40,40]: peak slope .5,
  // although its chord rises only .4 per metre of progress.
  const limits = shotPaceLimits(decoded([a, b], [link], 10));
  assert.ok(Math.abs(limits.link[0].capMps - 20) < 1e-6, `joined climb cap ${limits.link[0].capMps}`);
});

test('a pinned partial-shot ending cannot exceed the configured climb cap', () => {
  const lib = straight(5), p = planShotTour(lib, { ...song(80000), start: { timeMs: 60000, itemKind: 'shot', id: 'climb', s: 1500, speedMps: 4, accelMps2: 0, payoffMs: 40000 } });
  assert.equal(p.fallback, null);
  const t = buildShotTimeline(lib, p);
  let max = 0;
  for (let ms = 60000; ms < 80000; ms += 10) max = Math.max(max, Math.abs(t.poseAt(ms + 10).eyeM[1] - t.poseAt(ms).eyeM[1]) * 100);
  assert.ok(max <= 5 + 1e-6, `partial ending climbs ${max}`);
});

test('timeline climb diagnostics include the interior maximum of the actual key spline', () => {
  const lib = decoded([shot('keys', path([[0, 1000, 0], [80, 1000, 0], [160, 1001, 0], [240, 1001, 0]]))], [], 10);
  const t = buildShotTimeline(lib, { durationMs: 300, items: [{ kind: 'shot', id: 'keys', sFrom: 0, sTo: 300 }] });
  // At the middle of [0,0,1,1], the 100ms Catmull key interval rises at12.5m/s.
  assert.ok(Math.abs(t.diagnostics.maxClimbMps - 12.5) < 1e-9);
  assert.ok(t.notes.some(n => /climb/.test(n)));
});

test('a partial tail is not capped by vertical motion before its start', () => {
  const lib = decoded([shot('flat-tail', path([[0, 1000, 0], [80, 1040, 0], [160, 1040, 0], [240, 1040, 0]]), 200)], [], 1);
  // The final segment and its support samples all have y1040: zero climb.
  const tail = shotPaceLimits(lib).tail[0];
  assert.equal(tail.climbPerM, 0);
  assert.ok(tail.capMps > 40, 'other motion limits still apply to the flat tail');
});

test('a pinned continuation that already exceeds the climb cap is infeasible', () => {
  for (const s of [500, 1500]) {
    const p = planShotTour(straight(5), { ...song(80000), start: { timeMs: 60000, itemKind: 'shot', id: 'climb', s, speedMps: 10, accelMps2: 0 } });
    assert.match(p.fallback, /no feasible/);
  }
});

test('invalid explicit climb limits cannot silently disable the configured cap', () => {
  for (const maxClimbMps of [0, -1, NaN, Infinity]) assert.match(planShotTour(straight(22), { ...song(20000), tunables: { maxClimbMps } }).fallback, /no feasible/);
});

test('a checked plan cannot deliver Float32 key interpolation above its climb cap', () => {
  const lib = decoded([shot('high-altitude', path(Array.from({ length: 21 }, (_, i) => [60 * i, 100000 + 22 * i, 0])))], [], 22);
  const p = planShotTour(lib, song(20000));
  assert.equal(p.fallback, null, 'the underlying uniform path climbs at exactly22m/s');
  // Float32 altitude rounding at100km perturbs the100mskeys: their Catmull
  // derivative exceeds22m/s even though the continuous source path does not.
  assert.throws(() => buildShotTimeline(lib, p), /climb/);
});


test('a two-sample link uses both neighbouring support samples together', () => {
  const a = shot('left', path([[-200, 1000, 0], [-100, 1000, 0]])), b = shot('right', path([[0, 1040, 0], [100, 1040, 0]]));
  const link = { id: 'rise', from: a.id, to: b.id, kind: 'direct', path: path([[-100, 1000, 0], [0, 1040, 0]]), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } };
  const lib = decoded([a, b], [link], 10);
  assert.ok(Math.abs(shotPaceLimits(lib).link[0].climbPerM - .5) < 1e-9);
  const p = planShotTour(lib, { durationMs: 14300, sections: [{ startMs: 0, endMs: 2400 }, { startMs: 2400, endMs: 11900 }, { startMs: 11900, endMs: 14300 }],
    roles: [{ role: 'intro' }, { role: 'verse' }, { role: 'outro' }], energy: new Float32Array(144).fill(.5), energyStepMs: 100, seed: 0 });
  if (p.fallback === null) assert.ok(buildShotTimeline(lib, p).diagnostics.maxClimbMps <= 10 + 1e-6);
});

test('a link continuation excludes a climb it has already passed', () => {
  const a = shot('pre', path([[-200, 1000, 0], [-100, 1000, 0]])), b = shot('post', path([[200, 1040, 0], [300, 1040, 0]]));
  const link = { id: 'past-rise', from: a.id, to: b.id, kind: 'direct', path: path([[-100, 1000, 0], [0, 1040, 0], [100, 1040, 0], [200, 1040, 0]]), lengthM: 300, durationMs: { min: 3000, max: 75000 }, score: { total: 1 } };
  const lib = decoded([a, b], [link], 1), p = planShotTour(lib, { ...song(80000), start: { timeMs: 60000, itemKind: 'link', id: link.id, s: 200, speedMps: 10, accelMps2: 0 } });
  assert.equal(p.fallback, null);
  assert.equal(buildShotTimeline(lib, p).diagnostics.maxClimbMps, 0);
});

test('a partial ending before a future rise remains legal at the default climb limit', () => {
  const lib = decoded([shot('future-rise', path(Array.from({ length: 12 }, (_, i) => [600 * i, i < 11 ? 1000 : 1800, 0]), 1000), 1000)]);
  const p = planShotTour(lib, { ...song(70000), start: { timeMs: 60000, itemKind: 'shot', id: 'future-rise', s: 2000, speedMps: 40, accelMps2: 0, payoffMs: 40000 } });
  assert.equal(p.fallback, null);
  assert.ok(p.items[0].sTo < 3000);
  assert.equal(buildShotTimeline(lib, p).diagnostics.maxClimbMps, 0);
});


test('key-climb rejection preserves an already legal committed timeline', () => {
  const lib = decoded([shot('high-altitude', path(Array.from({ length: 21 }, (_, i) => [60 * i, 100000 + 22 * i, 0])))], [], 22);
  const previous = buildShotTimeline(lib, { durationMs: 20000, items: [{ kind: 'shot', id: 'high-altitude', sFrom: 0, sTo: 1800 }] });
  assert.ok(previous.diagnostics.maxClimbMps < 22);
  const next = buildShotTimeline(lib, planShotTour(lib, song(20000)), { previous, frozenThroughMs: 0 });
  assert.deepEqual(next.eye, previous.eye);
  assert.ok(next.notes.some(n => /Refinement deferred:.*climb/.test(n)));
});

test('a pending-link ending uses no support from an unreached next shot', () => {
  const a = shot('left', path([[-600, 200, 0], [0, 1000, 0]], 1000)), b = shot('right', path([[1200, 2600, 0], [1800, 2600, 0]], 1000));
  const link = { id: 'unreached-support', from: a.id, to: b.id, kind: 'direct', path: path([[0, 1000, 0], [600, 1800, 0], [1200, 2600, 0]], 1000), lengthM: 2000, durationMs: { min: 20000, max: 500000 }, score: { total: 1 } };
  const lib = decoded([a, b], [link]), p = planShotTour(lib, { ...song(61000), start: { timeMs: 60000, itemKind: 'link', id: link.id, s: 1900, speedMps: 40, accelMps2: 0 } });
  assert.match(p.fallback, /no feasible/, 'the actual unjoined path already climbs at32m/s at the committed40m/s');
});

test('a conservative climb prefix bound cannot decrease when its range grows', () => {
  const p = path([[0, 1134, 0], [60, 1947, 0], [72, 49, 0]]);
  p.s = Float32Array.of(0, 100, 120);
  const early = shotPaceLimits(decoded([shot('uneven-prefix', p, 91.6)])).head[0].climbPerM;
  const later = shotPaceLimits(decoded([shot('uneven-prefix', p, 100)])).head[0].climbPerM;
  assert.ok(later >= early - 1e-9, `prefix bound decreased from${early} to${later}`);
});


test('a continued link carries the actual committed predecessor into its climb check', () => {
  const a = shot('incoming', path([[-200, 1000, 0], [-100, 1000, 0]])), b = shot('outgoing', path([[0, 1040, 0], [100, 1040, 0]]));
  const link = { id: 'committed-rise', from: a.id, to: b.id, kind: 'direct', path: path([[-100, 1000, 0], [0, 1040, 0]]), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } };
  const lib = decoded([a, b], [link], 10);
  const previous = buildShotTimeline(lib, { fallback: null, durationMs: 30000, items: [
    { kind: 'shot', id: a.id, sFrom: 0, sTo: 100, payoffMs: 5000, startMs: 0, endMs: 10000 },
    { kind: 'link', id: link.id, sFrom: 0, sTo: 100, startMs: 10000, endMs: 20000 },
    { kind: 'shot', id: b.id, sFrom: 0, sTo: 100, payoffMs: 25000, startMs: 20000, endMs: 30000 },
  ] });
  const start = shotContinuation(previous, 15000, { leadMs: 0 });
  assert.deepEqual(start.before, { itemKind: 'shot', id: a.id, sTo: 100 });
  const plan = planShotTour(lib, { ...song(30000), start });
  assert.equal(plan.fallback, null);
  const next = buildShotTimeline(lib, plan, { previous, frozenThroughMs: start.timeMs });
  assert.ok(next.diagnostics.maxClimbMps <= 10 + 1e-6);
  assert.deepEqual(next.eye.subarray(0, 151 * 3), previous.eye.subarray(0, 151 * 3));
});

test('a pending link can reach a different legal support topology at song end', () => {
  const a = shot('left-topology', path([[-600, 200, 0], [0, 1000, 0]], 1000)), b = shot('right-topology', path([[1200, 2600, 0], [1800, 2600, 0]], 1000));
  const link = { id: 'topology-boundary', from: a.id, to: b.id, kind: 'direct', path: path([[0, 1000, 0], [600, 1800, 0], [1200, 2600, 0]], 1000), lengthM: 2000, durationMs: { min: 20000, max: 500000 }, score: { total: 1 } };
  const lib = decoded([a, b], [link]);
  // The old, faster cap allowed this committed prefix. From60s onward its
  // already joined geometry is below22m/s, provided the next shot is reached.
  const previous = buildShotTimeline(lib, { fallback: null, durationMs: 64000, items: [
    { kind: 'shot', id: a.id, sFrom: 500, sTo: 1000, startMs: 0, endMs: 12500 },
    { kind: 'link', id: link.id, sFrom: 0, sTo: 2000, startMs: 12500, endMs: 62500 },
    { kind: 'shot', id: b.id, sFrom: 0, sTo: 60, startMs: 62500, endMs: 64000 },
  ] }, { tunables: { maxClimbMps: 100 } });
  const start = shotContinuation(previous, 60000, { leadMs: 0 });
  const plan = planShotTour(lib, { ...song(64000), start });
  assert.equal(plan.fallback, null, 'a higher-distance topology remains legal when the shorter one is not');
  assert.equal(plan.items.at(-1).kind, 'shot');
  const next = buildShotTimeline(lib, plan, { previous, frozenThroughMs: start.timeMs });
  assert.ok(next.diagnostics.maxClimbMps <= 22 + 1e-6);
});

test('a two-sample shot uses both selected neighbours before accepting its head and tail', () => {
  const a = shot('a', path([[-200, 1000, 0], [-100, 1000, 0]])), b = shot('b', path([[0, 1000, 0], [100, 1040, 0]])), c = shot('c', path([[200, 1040, 0], [300, 1040, 0]]));
  const links = [
    { id: 'ab', from: a.id, to: b.id, kind: 'direct', path: path([[-100, 1000, 0], [0, 1000, 0]]), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } },
    { id: 'bc', from: b.id, to: c.id, kind: 'direct', path: path([[100, 1040, 0], [200, 1040, 0]]), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } },
  ];
  const lib = decoded([a, b, c], links, 10);
  const plan = planShotTour(lib, { durationMs: 21000, sections: [{ startMs: 0, endMs: 9700 }, { startMs: 9700, endMs: 19400 }, { startMs: 19400, endMs: 21000 }],
    roles: [{ role: 'intro' }, { role: 'chorus' }, { role: 'chorus', finalChorus: true }], energy: Float32Array.from({ length: 211 }, (_, i) => i < 97 ? .2 : i < 194 ? .5 : 1), energyStepMs: 100, seed: 0,
    start: { timeMs: 0, itemKind: 'shot', id: a.id, s: 50, speedMps: 20.6, accelMps2: 0, payoffMs: 0 } });
  assert.equal(plan.fallback, null, 'short decoded shots still have legal alternatives');
  const t = buildShotTimeline(lib, plan);
  assert.ok(t.diagnostics.maxClimbMps <= 10 + 1e-6);
});

test('a continued shot retains its incoming support after reaching its payoff', () => {
  const a = shot('a', path([[-200, 1000, 0], [-100, 1000, 0]])), b = shot('b', path([[0, 1000, 0], [100, 1040, 0]])), c = shot('c', path([[200, 1040, 0], [300, 1040, 0]]));
  const links = [
    { id: 'ab', from: a.id, to: b.id, kind: 'direct', path: path([[-100, 1000, 0], [0, 1000, 0]]), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } },
    { id: 'bc', from: b.id, to: c.id, kind: 'direct', path: path([[100, 1040, 0], [200, 1040, 0]]), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } },
  ];
  const lib = decoded([a, b, c], links, 10), durationMs = 14780;
  const previous = buildShotTimeline(lib, { fallback: null, durationMs, items: [
    { kind: 'shot', id: a.id, sFrom: 0, sTo: 100, payoffMs: 2500, startMs: 0, endMs: 5000 },
    { kind: 'link', id: 'ab', sFrom: 0, sTo: 100, startMs: 5000, endMs: 10000 },
    { kind: 'shot', id: b.id, sFrom: 0, sTo: 95.6, payoffMs: 12500, startMs: 10000, endMs: durationMs },
  ] });
  const start = shotContinuation(previous, 10500, { leadMs: 0, minRemainingMs: 0 });
  const plan = planShotTour(lib, { durationMs, start, energy: new Float32Array(149).fill(.5), energyStepMs: 100 });
  assert.equal(plan.fallback, null);
  const next = buildShotTimeline(lib, plan, { previous, frozenThroughMs: start.timeMs });
  assert.ok(next.diagnostics.maxClimbMps <= 10 + 1e-6);
  assert.ok(!next.notes.some(n => /Refinement deferred:.*climb/.test(n)), 'legal continuation is checked with its actual incoming support');
  assert.deepEqual(next.eye.subarray(0, 106 * 3), previous.eye.subarray(0, 106 * 3));
});
