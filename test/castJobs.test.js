// What the cast do in a view (CastJobs.js): climb a summit that holds the
// frame, or light the shore where none does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castPlan, classifyCastJob, pathPosition, siteWalk, ASCENT_STEPS, ASCENT_WATER_U, CAIRN_BINS } from '../src/world/alpine/CastJobs.js';
import { scenePoseAt, projectPoint } from '../src/world/terrain/SceneTravel.js';
import { seenFrom } from '../src/world/alpine/LineOfSight.js';

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
  const pose = scenePoseAt(view, { progress01: 0.5 });
  const xs = plan.cairns.map((p) => projectPoint(pose, 16 / 9, p).x);
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]), 'swept left to right');
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
