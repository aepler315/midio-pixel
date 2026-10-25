// What the cast do in a view (CastJobs.js): climb a summit that holds the
// frame, or light the shore where none does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castPlan, castWork, classifyCastJob, flowAt, pathPosition, siteWalk, threadSegments, MIDASUS_HOVER_M, ASCENT_STEPS, ASCENT_WATER_U, CAIRN_BINS, THREAD_SEGMENTS, THREAD_SEGMENTS_MAX } from '../src/world/alpine/CastJobs.js';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { hashSeed } from '../src/utils/math.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { scenePoseAt, projectPoint } from '../src/world/terrain/SceneTravel.js';
import { seenFrom } from '../src/world/alpine/LineOfSight.js';
import { terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';

/** A catalog view's real terrain, its water level found as RangeScene.prepare finds it. */
function realView(id) {
  const view = catalog.views.find((v) => v.id === id);
  const root = 'src/assets/range/v2/terrain/';
  const manifest = JSON.parse(fs.readFileSync(`${root}${id}.terrain.json`, 'utf8'));
  const data = decodeTerrain(manifest, new Uint8Array(gunzipSync(fs.readFileSync(`${root}${id}.terrain.bin.gz`))));
  const hs = [];
  for (const t of data.tiles.values()) {
    if (!t.flowBytes) continue;
    for (let i = 0; i < t.flowBytes.length; i += 7) if (t.flowBytes[i] === 255 && Number.isFinite(t.heightsM[i])) hs.push(t.heightsM[i]);
  }
  hs.sort((a, b) => a - b);
  const waterLevelM = view.riverPolicy?.terrainWater === 'mapped-only' || !hs.length ? null : hs[hs.length >> 1];
  return { view, data, waterLevelM };
}
const LAMPLIGHTER_VIEWS = ['panamint-dantes-view', 'monument-valley-163', 'black-mountains-catawba', 'san-gabriel-baldy', 'superstition-west-front'];

const LEVEL = 1000;
/** A 12.8 km square of terrain from `height(x, z)` and `wet(x, z)`, seen
 *  from its south edge looking north. */
function world(height, wet = () => false) {
  const cells = 32, cellSizeM = 50, tilesX = 8, tilesZ = 8, n = cells + 1;
  const tiles = new Map(), byIndex = new Map();
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const heightsM = new Float32Array(n * n), flowBytes = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const x = (ix * cells + u) * cellSizeM, z = (iz * cells + v) * cellSizeM;
      const w = wet(x, z);
      heightsM[v * n + u] = w ? LEVEL : height(x, z);
      flowBytes[v * n + u] = w ? 255 : 10;
    }
    const t = { id: `${ix}_${iz}`, ix, iz, samples: n, stride: 1, visible: true, band: 'mid', heightsM, flowBytes };
    tiles.set(t.id, t);
    byIndex.set(`${ix},${iz}`, t);
  }
  const data = { tiles, byIndex, cells, grid: { originM: [0, 0], cellSizeM }, manifest: { tilesX, tilesZ } };
  const view = { id: 'test', camera: { eyeStartM: [6300, 1900, -1500], eyeEndM: [6500, 1900, -1400],
    targetStartM: [6400, 1100, 6400], targetEndM: [6450, 1100, 6400], fovYDeg: 40 } };
  return { data, view };
}
// A cone 1.5 km tall, 2.5 km round, at the back of the valley.
const cone = (x, z) => LEVEL + 5 + Math.max(0, 1500 * (1 - Math.hypot(x - 6400, z - 8000) / 2500));
const lake = (x, z) => Math.hypot((x - 6400) / 2, z - 4300) < 900;

test('a cone above a lake is climbed from the water', () => {
  const { data, view } = world(cone, lake);
  const plan = castPlan(data, view, { waterLevelM: LEVEL, seed: 3 });
  assert.equal(plan.job, 'ascent');
  assert.equal(plan.waterU, ASCENT_WATER_U);
  assert.equal(plan.hidden.length, ASCENT_STEPS + 1);
  assert.ok(plan.seen >= 0.7, `${plan.seen}`);
  // The summit is the cone's top; the climb ends there.
  assert.ok(Math.hypot(plan.summit[0] - 6400, plan.summit[2] - 8000) < 200, `${plan.summit}`);
  assert.deepEqual(plan.points.at(-1), plan.summit);
  // Starts on the lake, lands on its shore.
  assert.equal(plan.start[1], LEVEL);
  assert.ok(plan.landing[1] > LEVEL && plan.landing[1] < LEVEL + 40);
  // Climbs: u runs 0..1 and height grows along the climb overall.
  assert.equal(plan.us[0], 0);
  assert.equal(plan.us.at(-1), 1);
  const at = (u) => pathPosition(plan, u, { data, waterLevelM: LEVEL });
  assert.equal(at(0.05)[1], LEVEL);
  assert.ok(at(0.95)[1] > at(0.3)[1] + 500);
  const pose = scenePoseAt(view, { progress01: 0.5 });
  for (const u of [0.2, 0.5, 0.8]) {
    const q = projectPoint(pose, 16 / 9, at(u));
    assert.ok(Math.abs(q.x) < 0.75 && Math.abs(q.y) < 0.65, `in frame at ${u}`);
  }
  assert.equal(classifyCastJob(data, view, { waterLevelM: LEVEL, seed: 3 }), 'ascent');
});

test('a cone with no water is climbed from its foot', () => {
  const { data, view } = world(cone);
  const plan = castPlan(data, view, { waterLevelM: null });
  assert.equal(plan.job, 'ascent');
  assert.equal(plan.waterU, 0);
  assert.deepEqual(plan.start, plan.landing);
  assert.ok(plan.landing[1] < LEVEL + 300, `${plan.landing}`);
});

test('a flat basin has no summit: the cast light its shore', () => {
  const { data, view } = world(() => LEVEL + 5, lake);
  const plan = castPlan(data, view, { waterLevelM: LEVEL, seed: 3 });
  assert.equal(plan.job, 'lamplighters');
  assert.ok(plan.cairns.length >= 6 && plan.cairns.length <= CAIRN_BINS, `${plan.cairns.length} cairns`);
  assert.ok(plan.buoys.length > 0 && plan.buoys.length <= 6);
  for (const b of plan.buoys) assert.equal(b[1], LEVEL);
  // Tiles share their edge samples: no two sites stand on one point.
  assert.equal(new Set([...plan.cairns, ...plan.buoys].map(String)).size, plan.cairns.length + plan.buoys.length);
  const pose = scenePoseAt(view, { progress01: 0.5 });
  const xs = plan.cairns.map((p) => projectPoint(pose, 16 / 9, p).x);
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]), 'swept left to right');
  // Survey threads lie draped six feet over the ground, not in the air.
  const work = castWork(plan, { data, waterLevelM: LEVEL });
  assert.ok(work.threads.length >= 2);
  for (const th of work.threads) for (const q of th.points) {
    assert.ok(Math.abs(q[1] - Math.max(LEVEL, terrainHeightAt(data, q[0], q[2])) - MIDASUS_HOVER_M) < 1e-6, `${q}`);
  }
});

test('a summit hidden behind a nearer ridge fails the visibility check', () => {
  // A ridge 3.2 km high at 5 km out hides the cone's face from the rail
  // (its own crest stands in the sky band, so it is no summit).
  const ridge = (x, z) => Math.max(cone(x, z), LEVEL + 2200 * Math.max(0, 1 - Math.abs(z - 3500) / 300));
  const { data, view } = world(ridge);
  const eye = scenePoseAt(view, { progress01: 0.5 }).eyeM;
  assert.equal(seenFrom(data, eye, [6400, cone(6400, 7000), 7000]), false);
  assert.equal(classifyCastJob(data, view, { waterLevelM: null }), 'lamplighters');
});

test('tour views keep wandering lanterns', () => {
  const { data, view } = world(cone);
  assert.equal(classifyCastJob(data, { ...view, tour: true }), 'wander');
});

test('a lamplighter eases between its sites and closes the loop', () => {
  const sites = [[0, 0, 0], [100, 0, 0], [200, 0, 0]], dues = [0.25, 0.5, 0.75];
  assert.deepEqual(siteWalk(sites, dues, 0), [100, 0, 0]);
  assert.deepEqual(siteWalk(sites, dues, 0.25), sites[0]);
  assert.deepEqual(siteWalk(sites, dues, 0.5), sites[1]);
  assert.deepEqual(siteWalk(sites, dues, 1), sites[0]);
});

test('a shore is found by position, across tile seams and never across rows', () => {
  // Water only in the column just west of a tile seam (x = 1550 m).
  const { data } = world(() => LEVEL + 5, (x) => x === 1550);
  assert.equal(flowAt(data, 1550, 800), 255, 'tile 0, one column west of the seam');
  assert.equal(flowAt(data, 1600, 800), 10, 'the first column of tile 1');
  assert.equal(flowAt(data, 1575, 800), null, 'between samples');
  assert.equal(flowAt(data, -50, 800), null, 'off the terrain');
});

test('every cairn stands where the rail can see it, and every thread lies on terrain', () => {
  // Black Mountains used to light eight cairns the rail never sees (the
  // lowest ground sat behind nearer ridges); San Gabriel strung two threads
  // across ground with no terrain at all.
  for (const id of LAMPLIGHTER_VIEWS) {
    const { view, data, waterLevelM } = realView(id);
    const plan = castPlan(data, view, { waterLevelM, seed: hashSeed(`${id}:cast`) });
    assert.equal(plan.job, 'lamplighters', id);
    assert.ok(plan.cairns.length >= 2 && plan.cairns.length <= CAIRN_BINS, `${id}: ${plan.cairns.length} cairns`);
    const eye = scenePoseAt(view, { progress01: 0.5 }).eyeM;
    for (const c of plan.cairns) assert.ok(seenFrom(data, eye, [c[0], c[1] + 2, c[2]]), `${id}: cairn ${c} hidden from the rail`);
    const work = castWork(plan, { data, waterLevelM });
    assert.ok(work.threads.length >= 1, id);
    for (const th of work.threads) {
      assert.ok(th.points.length - 1 >= THREAD_SEGMENTS && th.points.length - 1 <= THREAD_SEGMENTS_MAX);
      for (const q of th.points) assert.ok(Number.isFinite(terrainHeightAt(data, q[0], q[2])), `${id}: thread over missing terrain at ${q}`);
    }
  }
});

test('a basin seen through a notch lights its cairns in the notch, and one seen not at all wanders', () => {
  // A wall 250-690 m in front of the eye (too near for a site) hides the
  // whole basin except through a notch.
  const view = { id: 'walled', camera: { eyeStartM: [6400, 1300, 1000], eyeEndM: [6410, 1300, 1000],
    targetStartM: [6400, 1005, 8000], targetEndM: [6410, 1005, 8000], fovYDeg: 40 } };
  const wall = (notch) => (x, z) => LEVEL + 5 + (z >= 1250 && z <= 1690 && !(notch && Math.abs(x - 6400) < 160) ? 600 : 0);
  const eye = scenePoseAt(view, { progress01: 0.5 }).eyeM;
  const { data } = world(wall(true));
  const plan = castPlan(data, view, { waterLevelM: null, seed: 3 });
  assert.equal(plan.job, 'lamplighters');
  assert.ok(plan.cairns.length >= 2);
  for (const c of plan.cairns) assert.ok(seenFrom(data, eye, [c[0], c[1] + 2, c[2]]), `cairn ${c} behind the wall`);
  assert.equal(castPlan(world(wall(false)).data, view, { waterLevelM: null, seed: 3 }).job, 'wander');
});

test('a survey thread follows the drawn mesh cell by cell, and none hangs across missing terrain', () => {
  const { data } = world(() => LEVEL + 5);
  // 50 m cells: one segment per cell, never fewer than the old 16, capped.
  assert.equal(threadSegments(data, [1000, 0, 1000], [3000, 0, 1000]), 40);
  assert.equal(threadSegments(data, [1000, 0, 1000], [1300, 0, 1000]), THREAD_SEGMENTS);
  assert.equal(threadSegments(data, [100, 0, 100], [9000, 0, 9000]), THREAD_SEGMENTS_MAX);
  assert.equal(threadSegments(null, [0, 0, 0], [5000, 0, 0]), THREAD_SEGMENTS);
  // A coarser runtime stride draws coarser cells.
  for (const t of data.tiles.values()) t.lod = { desktop: 2 };
  assert.equal(threadSegments(data, [1000, 0, 1000], [3000, 0, 1000]), 20);
  // Take a tile (x and z 1600..3200 m) out: the thread across it is not
  // drawn, the others are.
  data.byIndex.delete('1,1');
  const plan = { job: 'lamplighters', cairns: [[500, 0, 500], [500, 0, 2500], [3500, 0, 2500], [3500, 0, 500]], buoys: [] };
  const work = castWork(plan, { data, waterLevelM: null });
  assert.deepEqual(work.threads.map((th) => [th.a[0], th.a[2], th.b[0], th.b[2]]), [[500, 500, 500, 2500], [3500, 2500, 3500, 500], [3500, 500, 500, 500]]);
  assert.equal(work.threads.at(-1).closing, true);
  for (const th of work.threads) for (const q of th.points) assert.ok(Number.isFinite(terrainHeightAt(data, q[0], q[2])));
  // Without terrain (no data) every thread is kept, straight.
  assert.equal(castWork(plan).threads.length, 4);
});
