// The cast as lights in the Range (RangeActors.js): the per-song score
// from each lane, each view's job state, and the wandering routes tours
// keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_IDS, ROUTE_UNITS, compileActorScore, rangeActorsAt, actorRoutes, routePosition,
} from '../src/world/alpine/RangeActors.js';
import { cameraPoseAt, projectPoint } from '../src/world/terrain/SceneTravel.js';

/** A narrative whose lanes play `fn(id, tMs)` (0..1). */
const narrative = (durationMs, fn) => ({
  durationMs,
  sample: (t) => ({ sources: Object.fromEntries(ACTOR_IDS.map((id) => [id, { activity: fn(id, t) }])) }),
});
// Midio plays a steady bass with two loud stretches; Broshi is silent.
const song = narrative(120000, (id, t) => {
  if (id === 'broshi') return 0;
  if (id === 'midio') return (t > 30000 && t < 34000) || (t > 40000 && t < 44000) || (t > 80000 && t < 85000) ? 0.95 : 0.3;
  return 0.2 + 0.1 * Math.sin(t / 900);
});

test('the score has no peaks: only glow and travel', () => {
  const score = compileActorScore(song);
  assert.equal(score.peaks, undefined);
  assert.deepEqual(Object.keys(score.at(31000).midio).sort(), ['glow', 'travel']);
  // A silent lane only drifts.
  assert.equal(score.at(60000).broshi.glow, 0);
});

test('the score is a function of heard time: travel grows faster while the lane plays', () => {
  const score = compileActorScore(song);
  const a = score.at(31000).midio, b = score.at(31000).midio;
  assert.deepEqual(a, b);
  const quiet = score.at(28000).midio.travel - score.at(26000).midio.travel;
  const loud = score.at(33000).midio.travel - score.at(31000).midio.travel;
  assert.ok(loud > quiet * 1.5, `${loud} vs ${quiet}`);
  assert.ok(score.at(33000).midio.glow > score.at(28000).midio.glow);
});

test('the cast arrives with the scene', () => {
  const sim = { rangeNarrative: song, biomes: {} };
  assert.equal(rangeActorsAt(sim, 1000).presence, 0);
  assert.equal(rangeActorsAt(sim, 9000).presence, 1);
  assert.ok(Number.isFinite(rangeActorsAt(sim, 9000).midio.trail));
  assert.equal(rangeActorsAt(sim, 9000).jobs, null, 'no views cast, no jobs');
  assert.equal(rangeActorsAt({}, 9000), null);
});

test('each view the song visits has a job, and a review can hold its progress', () => {
  const sections = [0, 1, 2, 3].map((i) => ({ startMs: i * 30000, endMs: (i + 1) * 30000, barMs: 2000, profile: i % 2 ? 'B' : 'A',
    provenance: 'detected', confidence: 1 }));
  const sim = { rangeNarrative: { ...song, onsets: { midio: [], broshi: [], midasus: [] } },
    biomes: { sections, durationMs: 120000, energyCurves: { globalEnergyNorm: (t) => (t > 60000 && t < 90000 ? 0.9 : 0.3) } } };
  const sceneAssignments = new Map([['A', { view: { id: 'va' } }], ['B', { view: { id: 'vb' } }]]);
  const at = (t) => rangeActorsAt(sim, t, { sceneAssignments });
  assert.deepEqual(Object.keys(at(10000).jobs).sort(), ['va', 'vb']);
  assert.equal(at(10000).schedule, at(50000).schedule, 'compiled once');
  assert.ok(at(29000).jobs.va.p > at(10000).jobs.va.p);
  assert.equal(at(45000).jobs.va.p, at(30000).jobs.va.p, 'held while away');
  // The loud third section is the climax: A finishes on it.
  assert.equal(at(70000).jobs.va.p, 1);
  sim.biomes.castProgressOverride = { vb: 0.5 };
  assert.equal(at(10000).jobs.vb.p, 0.5);
  assert.equal(at(10000).jobs.vb.override, true);
  assert.notEqual(at(10000).jobs.va.p, 0.5);
  sim.biomes.castProgressOverride = 1;
  assert.equal(at(10000).jobs.va.payoff01, 1);
});

// A bowl with a round lake in it, seen from its south rim.
function bowl() {
  const cells = 32, cellSizeM = 50, tilesX = 8, tilesZ = 8, n = cells + 1, level = 1000;
  const tiles = new Map(), byIndex = new Map();
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const heightsM = new Float32Array(n * n), flowBytes = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const x = (ix * cells + u) * cellSizeM, z = (iz * cells + v) * cellSizeM;
      const r = Math.hypot(x - 6400, z - 6400);
      const wet = r < 2000;
      heightsM[v * n + u] = wet ? level : level + (r - 2000) * 0.2;
      flowBytes[v * n + u] = wet ? 255 : 10;
    }
    const t = { id: `${ix}_${iz}`, ix, iz, samples: n, stride: 1, visible: true, band: 'mid', heightsM, flowBytes };
    tiles.set(t.id, t);
    byIndex.set(`${ix},${iz}`, t);
  }
  const data = { tiles, byIndex, cells, grid: { originM: [0, 0], cellSizeM }, manifest: { tilesX, tilesZ } };
  const view = { id: 'bowl', camera: { eyeStartM: [6400, 1900, -1500], eyeEndM: [6600, 1900, -1400], targetStartM: [6400, 1000, 6400], targetEndM: [6500, 1000, 6400], fovYDeg: 40 } };
  return { data, view, level };
}

test('routes: Midio on the lake, Broshi on its shore, Midasus in the air, all in frame', () => {
  const { data, view, level } = bowl();
  const r = actorRoutes(data, view, { waterLevelM: level, seed: 7 });
  assert.equal(r.midio.kind, 'water');
  assert.equal(r.broshi.kind, 'ground');
  assert.equal(r.midasus.kind, 'air');
  for (const p of r.midio.points) assert.equal(p[1], level);
  for (const p of r.broshi.points) assert.ok(p[1] > level && p[1] < level + 40, `${p}`);
  const pose = cameraPoseAt(view, 0.5);
  for (const id of ACTOR_IDS) {
    const xs = r[id].points.map((p) => projectPoint(pose, 16 / 9, p).x);
    assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]), `${id} anchors run left to right`);
    for (const p of r[id].points) {
      const q = projectPoint(pose, 16 / 9, p);
      assert.ok(Math.abs(q.x) < 0.75 && Math.abs(q.y) < 0.75, `${id} ${q.x},${q.y}`);
    }
  }
  for (const p of r.midasus.points) assert.ok(projectPoint(pose, 16 / 9, p).y > 0.3);
  // Same view, same seed: the same routes.
  assert.deepEqual(actorRoutes(data, view, { waterLevelM: level, seed: 7 }).midio.points, r.midio.points);
});

test('a route is walked back and forth at its hover height', () => {
  const { data, level } = bowl();
  const route = { kind: 'water', points: [[5000, level, 6000], [6000, level, 6400], [7000, level, 6000]], lengths: [], total: 0 };
  for (let i = 1; i < 3; i++) route.lengths.push(Math.hypot(route.points[i][0] - route.points[i - 1][0], route.points[i][2] - route.points[i - 1][2]));
  route.total = route.lengths[0] + route.lengths[1];
  const at = (t) => routePosition(route, t, { data, waterLevelM: level, hoverM: 7 });
  assert.deepEqual(at(0).map(Math.round), [5000, level + 7, 6000]);
  assert.deepEqual(at(ROUTE_UNITS).map(Math.round), [7000, level + 7, 6000]);
  // There and back again.
  assert.deepEqual(at(2 * ROUTE_UNITS).map(Math.round), at(0).map(Math.round));
  assert.deepEqual(at(0.5 * ROUTE_UNITS).map(Math.round), at(1.5 * ROUTE_UNITS).map(Math.round));
});
