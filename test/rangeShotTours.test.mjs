import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeShotTours, shotTourEligible, visibleIntervals, cameraFootprint, SHOT_PLAN_TIMEOUT_MS } from '../src/world/alpine/RangeShotTours.js';
import { resolveRangeMode } from '../src/world/alpine/RangePresentation.js';
import { samplePath } from '../src/world/terrain/ShotPath.js';

const sha = 'a'.repeat(64);
const view = (id, status = 'approved') => ({ id, status, shotsManifestUrl: `tour/${id}.shots.json`, shotsManifestSha256: sha });
const path = (x0) => ({ ...samplePath({ eyes: [[x0, 500, 0], [x0 + 1000, 500, 0]], aims: [[x0, 400, -5000], [x0 + 1000, 400, -5000]], fovs: 30 }), flow: null });
const library = { shots: [{ id: 's1', path: path(0) }, { id: 's2', path: path(3000) }], links: [{ id: 'l1', path: path(1000) }] };
const mgr = (sections = [{ startMs: 0, endMs: 60000, profile: { name: 'CONIFER' } }]) => ({ durationMs: 60000, sections, songSeed: 7, tSec: 0 });
const settle = () => new Promise((r) => setTimeout(r, 0));
const timeline = (offset = 0) => ({ durationMs: 60000, items: [{}, {}, {}], payoffs: [], diagnostics: {},
  poseAt: (t) => ({ eyeM: [t / 100 + offset, 500, 0], targetM: [0, 400, -5000], fovYDeg: 30, tour: true }), stateAt: () => ({ kind: 'shot' }) });

test('only approved views with a complete shot identity are eligible; candidates only for review', () => {
  assert.equal(shotTourEligible(view('a')), true);
  assert.equal(shotTourEligible(view('a', 'candidate')), false);
  assert.equal(shotTourEligible(view('a', 'candidate'), { allowCandidates: true }), true);
  assert.equal(shotTourEligible({ ...view('a'), shotsManifestSha256: 'x' }), false);
  assert.equal(shotTourEligible({ id: 'rail-only', status: 'approved' }), false);
});

test('mode resolution: shot tours by default, off keeps rails, tetons forces the highway', () => {
  assert.deepEqual(resolveRangeMode(''), { mode: 'v2', forcedViewId: null, diag: null, tour: null, shots: true, shotCandidates: false });
  assert.equal(resolveRangeMode('?rangeTour=off').shots, false);
  assert.equal(resolveRangeMode('', { getItem: () => 'off' }).shots, false);
  assert.equal(resolveRangeMode('?rangeTour=shots', { getItem: () => 'off' }).shots, true);
  const tetons = resolveRangeMode('?rangeTour=tetons');
  assert.equal(tetons.tour, 'tetons'); assert.equal(tetons.shots, false);
  assert.equal(resolveRangeMode('?rangeShots=all').shotCandidates, true);
});

test('a view is prepared for its library footprint and drawn only once its plan settles', async () => {
  let resolvePlan;
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }),
    plan: () => new Promise((r) => { resolvePlan = r; }) });
  const v = view('teton-jackson-lake');
  tours.setSong({ mgr: mgr(), views: [v, { id: 'rail-only', status: 'approved' }], generation: 1 });
  assert.equal(tours.prepareView(v), null, 'waits for the library before preparing');
  assert.equal(tours.prepareView({ id: 'rail-only' }).id, 'rail-only', 'a rail view prepares at once');
  await settle();
  const prepared = tours.prepareView(v);
  assert.equal(prepared.cameraPaths.length, 3, 'one footprint polyline per shot and link');
  assert.equal(tours.settled(v.id), false);
  resolvePlan(timeline());
  await settle();
  assert.equal(tours.settled(v.id), true);
  assert.ok(tours.timeline(v.id));
  assert.equal(tours.status()[v.id].state, 'ready');
  assert.equal(tours.timeline('rail-only'), null);
});

test('a missing library or a failed plan keeps the rail with the reason recorded', async () => {
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => { throw new Error('HTTP 404'); }, plan: async () => timeline() });
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 1 });
  await settle(); await settle();
  assert.equal(tours.settled('a'), true);
  assert.equal(tours.timeline('a'), null);
  assert.match(tours.status().a.reason, /shot library: HTTP 404/);
  const planned = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => ({ ...timeline(), fallback: 'no feasible sequence' }) });
  planned.setSong({ mgr: mgr(), views: [view('b')], generation: 1 });
  await settle(); await settle();
  assert.equal(planned.timeline('b'), null);
  assert.match(planned.status().b.reason, /no feasible sequence/);
});

test('a plan that outlives the timeout falls back to the rail, except in export', async () => {
  let now = 0;
  const make = (exportMode) => {
    const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: () => new Promise(() => {}), now: () => now });
    tours.setSong({ mgr: mgr(), views: [view('a')], generation: 1, exportMode });
    return tours;
  };
  const live = make(false), exported = make(true);
  await settle();
  now = SHOT_PLAN_TIMEOUT_MS + 1;
  assert.equal(live.settled('a'), true);
  assert.match(live.status().a.reason, /timed out/);
  assert.equal(exported.settled('a'), false, 'an export waits for its plan');
});

test('refinement is admitted only when it continues the camera heard now', async () => {
  let next = timeline();
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => next });
  const m = mgr();
  tours.setSong({ mgr: m, views: [view('a')], generation: 1 });
  await settle(); await settle();
  const first = tours.timeline('a');
  next = timeline(25); // jumps 25 m: must be held
  m.sections = [...m.sections];
  tours.refine(m);
  await settle(); await settle();
  assert.equal(tours.timeline('a'), first);
  assert.equal(tours.status().a.refinement.state, 'held');
  next = timeline(0);
  m.sections = [...m.sections];
  tours.refine(m);
  await settle(); await settle();
  assert.equal(tours.status().a.refinement.state, 'applied');
  assert.notEqual(tours.timeline('a'), first);
});

test('visible intervals follow the chapters that show the view, widened by the seam', () => {
  const sections = [{ startMs: 0, endMs: 40000, profile: { name: 'CONIFER' } }, { startMs: 40000, endMs: 90000, profile: { name: 'ICEFIELD' } },
    { startMs: 90000, endMs: 120000, profile: { name: 'CONIFER' } }];
  const choice = (b) => ({ view: { id: b === 'CONIFER' ? 'teton' : 'denali' } });
  assert.deepEqual(visibleIntervals('teton', { durationMs: 120000, sections }, choice), [{ startMs: 0, endMs: 46000 }, { startMs: 84000, endMs: 120000 }]);
  assert.deepEqual(visibleIntervals('denali', { durationMs: 120000, sections }, choice), [{ startMs: 34000, endMs: 96000 }]);
  assert.deepEqual(visibleIntervals('elsewhere', { durationMs: 120000, sections }, choice), [{ startMs: 0, endMs: 120000 }], 'a forced view is visible throughout');
  assert.equal(cameraFootprint(library, 200)[0].length >= 2, true);
});
