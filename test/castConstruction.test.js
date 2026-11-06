import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castConstructionJob } from '../src/world/alpine/CastConstruction.js';
import { castWork } from '../src/world/alpine/CastJobs.js';
import { risenHeight } from '../src/world/alpine/LandRise.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const plan = { job: 'ascent', points: [[0, 1000, 0], [1000, 2000, 0]], us: [0, 1], waterU: 0,
  landing: [0, 1000, 0], shoreStart: null };
const work = castWork(plan);
const actors = { midio: { glow: .7, pulse01: .5, noteAgeMs: 150 },
  broshi: { glow: .8, pulse01: .6, noteAgeMs: 200 }, midasus: { glow: .6, pulse01: .4, noteAgeMs: 100 } };
const at = (rise01, extra = {}) => castConstructionJob({ plan, work, actors, rise01, ...extra });

test('a flat landscape is preparation, even when the independent cast schedule says finished', () => {
  const job = at(0, { state: { p: 1, payoff01: 1, fuse01: .5, camps: 8 } });
  assert.ok(job, 'construction job exists');
  assert.equal(job.construction.phase, 'prepare');
  assert.equal(job.state.p, 0);
  assert.equal(job.state.camps, 0);
  assert.equal(job.beacon01, 0);
  assert.ok(work.marks.every((_, k) => !job.reached(k)), 'no infrastructure built on flat ground');
  for (const actor of Object.values(job.actors)) {
    assert.equal(actor.fly, null, 'survey/setup has no lifting effect');
    assert.equal(risenHeight(actor.pos[1], 0, { sink: 1, baseM: 75 }), 75, 'source anchor follows the actual flat floor');
  }
});

test('the rising mountain advances a coordinated director, anchor and scout', () => {
  const low = at(.2), high = at(.65);
  assert.ok(low && high, 'construction jobs exist');
  assert.equal(high.construction.phase, 'raise');
  for (const job of [low, high]) {
    assert.ok(job.actors.broshi.pos[0] < job.actors.midio.pos[0]);
    assert.ok(job.actors.midio.pos[0] < job.actors.midasus.pos[0]);
    assert.ok(job.actors.midio.fly, 'Midio directs a transfer toward the next build front');
    assert.ok(job.actors.midio.fly.pos[0] > job.actors.midio.pos[0]);
    assert.ok(job.actors.midasus.fly, 'Midasus surveys the next front');
  }
  assert.ok(high.actors.midio.pos[0] > low.actors.midio.pos[0]);
  assert.ok(work.marks.filter((_, k) => high.reached(k)).length > work.marks.filter((_, k) => low.reached(k)).length);
});

test('complete relief stops construction regardless of late song notes or stale work progress', () => {
  const job = at(1, { state: { p: .2, payoff01: 0, fuse01: .5 } });
  assert.ok(job, 'construction job exists');
  assert.equal(job.construction.phase, 'inspect');
  assert.equal(job.construction.activity01, 0);
  assert.equal(job.state.p, 1);
  assert.equal(job.state.fuse01, 0, 'no unrelated construction finale');
  assert.ok(work.marks.every((_, k) => job.reached(k)));
  assert.ok(work.marks.every((_, k) => job.since(k) >= 1500));
  for (const actor of Object.values(job.actors)) assert.equal(actor.fly, null);
  assert.equal(at(.96).construction.phase, 'settle');
});

test('construction is repeatable on seek, pause and analysis schedule replacement', () => {
  const first = at(.51);
  assert.ok(first, 'construction job exists');
  at(.99); at(.01);
  const replay = at(.51, { state: { p: .99, offsets: { broshi: .6, midasus: .2 }, camps: 4 } });
  assert.deepEqual(replay.actors, first.actors);
  assert.deepEqual(replay.construction, first.construction);
  assert.deepEqual(work.marks.map((_, k) => replay.since(k)), work.marks.map((_, k) => first.since(k)));
});

test('tour routes become one coordinated work front instead of independent repeated walks', () => {
  const route = { kind: 'ground', points: [[0, 1000, 0], [1000, 2000, 0]], lengths: [Math.hypot(1000, 1000)], total: Math.hypot(1000, 1000) };
  const job = castConstructionJob({ plan: { job: 'wander' }, routes: { broshi: route }, rise01: .5, actors });
  assert.ok(job, 'a tour participates without a static-view schedule');
  assert.ok(job.actors.broshi.pos[0] < job.actors.midio.pos[0]);
  assert.ok(job.actors.midio.pos[0] < job.actors.midasus.pos[0]);
  assert.equal(job.state.camps, 0);
  assert.equal(castConstructionJob({ plan: { job: 'wander' }, rise01: .5 }), null, 'no invented terrain path');
});

test('basin walkers and scouts sit on sampled ground between sites', () => {
  const cells = 4, samples = cells + 1;
  const heightsM = Float32Array.from({ length: samples ** 2 }, (_, i) => 100 + (i % samples === 2 ? 200 : 0));
  const tile = { ix: 0, iz: 0, samples, stride: 1, heightsM };
  const data = { grid: { originM: [0, 0], cellSizeM: 100 }, cells, manifest: { tilesX: 1, tilesZ: 1 }, byIndex: new Map([['0,0', tile]]) };
  const basin = { job: 'lamplighters', cairns: [[0, 100, 100], [400, 100, 100]], buoys: [] };
  const job = castConstructionJob({ plan: basin, work: castWork(basin), data, rise01: .5, actors });
  assert.ok(job, 'construction job exists');
  const lead = job.actors.midio.pos;
  assert.ok(lead[0] > 100 && lead[0] < 300, 'lead crosses the intermediate ridge');
  assert.ok(lead[1] > 250, 'terrain is sampled instead of interpolating site heights');
});

test('survey lines wait for the anchors at both ends to finish installation', () => {
  for (const buoys of [[], [[0, 100, 100], [300, 100, 100]]]) {
    const basin = { job: 'lamplighters', cairns: [[0, 100, 0], [100, 100, 0], [200, 100, 0], [300, 100, 0]], buoys };
    const basinWork = castWork(basin);
    for (const rise01 of [.37275, .682]) {
      const job = castConstructionJob({ plan: basin, work: basinWork, rise01, actors });
      for (const thread of basinWork.threads) {
        const after = basinWork.marks[thread.mark].after;
        if (!after) continue;
        const youngestAnchor = Math.min(...after.map(k => job.since(k)));
        if (youngestAnchor < 800) assert.ok(job.since(thread.mark) < 0, 'survey waits for the fixed ends');
      }
    }
  }
});

test('installed work never recedes as relief rises or the playing lane changes', () => {
  let last = work.marks.map(() => -Infinity);
  for (let i = 0; i <= 100; i++) {
    const job = at(i / 100, { actors: i % 2 ? actors : { broshi: { glow: 0 } } });
    const current = work.marks.map((_, k) => Math.max(0, job.since(k)));
    current.forEach((age, k) => assert.ok(age >= last[k], `anchor ${k} does not unbuild at relief ${i / 100}`));
    last = current;
  }
});

test('RangeScene uses the true build without a cast schedule, including tour routes', () => {
  const staticView = { view: { id: 'static' }, castPlan: plan, castWork: work };
  const route = { kind: 'ground', points: [[0, 1000, 0], [1000, 2000, 0]], lengths: [Math.hypot(1000, 1000)], total: Math.hypot(1000, 1000) };
  const tour = { view: { id: 'tour', tour: true }, castPlan: { job: 'wander' }, actorRoutes: { broshi: route } };
  for (const prepared of [staticView, tour]) {
    const job = RangeScene.prototype._castJob.call({}, prepared, { rise01: .5, actors });
    assert.equal(job.construction.phase, 'raise');
    assert.ok(job.actors.midio.pos[0] > 100 && job.actors.midio.pos[0] < 900);
    assert.ok(job.actors.midio.pos[1] > 1000, 'anchors stay in source space for the shared GPU ground lift');
    assert.equal(job.actors.midio.pos[2], 0);
    const complete = RangeScene.prototype._castJob.call({}, prepared, { rise01: 1, actors });
    assert.equal(complete.construction.phase, 'inspect');
    assert.ok(Object.values(complete.actors).every(a => !a.fly));
  }
});

test('no finite build state leaves the legacy job available', () => {
  assert.equal(castConstructionJob({ plan, work, actors }), null);
  assert.equal(castConstructionJob({ plan, work, actors, rise01: NaN }), null);
});
