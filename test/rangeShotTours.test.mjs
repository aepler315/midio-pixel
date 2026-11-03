import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeShotTours, shotTourEligible, visibleIntervals, retainsHeardCamera, cameraFootprint, SHOT_PLAN_TIMEOUT_MS, SHOT_REPLAN_RETRIES, SHOT_REPLAN_RETRY_MS } from '../src/world/alpine/RangeShotTours.js';
import { resolveRangeMode } from '../src/world/alpine/RangePresentation.js';
import { samplePath } from '../src/world/terrain/ShotPath.js';
import { compileSceneRailPlan } from '../src/world/terrain/SceneRailPlan.js';
import { handleShotMessage } from '../src/world/terrain/shot-worker.js';
import { shotPlanRequest } from '../src/world/terrain/ShotRuntime.js';
import { restoreShotTimeline } from '../src/world/terrain/ShotTimeline.js';
import { shotLibraryFixture, anthemSong } from './fixtures/shot-library-fixture.mjs';

const sha = 'a'.repeat(64);
const view = (id, status = 'approved') => ({ id, status, shotsManifestUrl: `tour/${id}.shots.json`, shotsManifestSha256: sha,
  terrainManifestSha256: sha, baseViewSha256: sha,
  shotTour: { status: 'approved', identity: { shotsManifestSha256: sha, terrainManifestSha256: sha, baseViewSha256: sha },
    approval: { shotsManifestSha256: sha, terrainManifestSha256: sha, baseViewSha256: sha, date: '2026-10-22', evidence: ['review.md'] } } });
const path = (x0) => ({ ...samplePath({ eyes: [[x0, 500, 0], [x0 + 1000, 500, 0]], aims: [[x0, 400, -5000], [x0 + 1000, 400, -5000]], fovs: 30 }), flow: null });
const library = { terrainManifestSha256: sha, shots: [{ id: 's1', path: path(0) }, { id: 's2', path: path(3000) }], links: [{ id: 'l1', path: path(1000) }] };
const mgr = (sections = [{ startMs: 0, endMs: 60000, profile: { name: 'CONIFER' } }]) => ({ durationMs: 60000, sections, songSeed: 7, tSec: 0 });
const settle = () => new Promise((r) => setTimeout(r, 0));
// A plan that beats the rail (CameraChoice.js): all shot keys, one payoff.
const timeline = (offset = 0) => ({ durationMs: 60000, items: [{}, {}, {}], meta: new Uint8Array(601 * 4),
  payoffs: [{ plannedMs: 30000, actualMs: 30000 }], diagnostics: {},
  poseAt: (t) => ({ eyeM: [t / 100 + offset, 500, 0], targetM: [0, 400, -5000], fovYDeg: 30, tour: true }), stateAt: () => ({ kind: 'shot' }) });

test('only approved views with a complete shot identity are eligible; candidates only for review', () => {
  assert.equal(shotTourEligible(view('a')), true);
  assert.equal(shotTourEligible(view('a', 'candidate')), false);
  assert.equal(shotTourEligible(view('a', 'candidate'), { allowCandidates: true }), true);
  assert.equal(shotTourEligible({ ...view('a'), shotsManifestSha256: 'x' }), false);
  assert.equal(shotTourEligible({ id: 'rail-only', status: 'approved' }), false);
});

test('tour approval, regional review state and exact package identities are independent gates', () => {
  const candidate = view('a'); candidate.shotTour.status = 'candidate';
  assert.equal(shotTourEligible(candidate), false);
  assert.equal(shotTourEligible(candidate, { allowCandidates: true }), true);
  const noApproval = view('a'); noApproval.shotTour.approval = null;
  assert.equal(shotTourEligible(noApproval), false);
  assert.equal(shotTourEligible(noApproval, { allowCandidates: true }), true);
  for (const key of ['shotsManifestSha256', 'terrainManifestSha256', 'baseViewSha256']) {
    const stale = view('a'); stale.shotTour.identity[key] = 'b'.repeat(64);
    assert.equal(shotTourEligible(stale), false, key);
    assert.equal(shotTourEligible(stale, { allowCandidates: true }), false, key);
    const staleApproval = view('a'); staleApproval.shotTour.approval[key] = 'b'.repeat(64);
    assert.equal(shotTourEligible(staleApproval), false, key);
    assert.equal(shotTourEligible(staleApproval, { allowCandidates: true }), false, key);
  }
  const missingEvidence = view('a'); missingEvidence.shotTour.approval.evidence = [];
  assert.equal(shotTourEligible(missingEvidence), false);
});

test('candidate tours keep the rail until diagnostics explicitly opt in', async () => {
  const candidate = view('a'); candidate.shotTour.status = 'candidate'; candidate.shotTour.approval = null;
  let loads = 0;
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => { loads++; return { library }; }, plan: async () => timeline() });
  tours.setSong({ mgr: mgr(), views: [candidate], generation: 1 });
  await settle();
  assert.equal(loads, 0);
  assert.equal(tours.prepareView(candidate), candidate);
  assert.equal(tours.timeline('a'), null);
  const review = new RangeShotTours({ assetBase: 'http://x/', allowCandidates: true, load: async () => ({ library }), plan: async () => timeline() });
  review.setSong({ mgr: mgr(), views: [candidate], generation: 1 });
  await settle(); await settle();
  assert.ok(review.timeline('a'));
});

test('a loaded library for another terrain package falls back to the rail', async () => {
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library: { ...library, terrainManifestSha256: 'b'.repeat(64) } }), plan: async () => timeline() });
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 1 });
  await settle(); await settle();
  assert.equal(tours.timeline('a'), null);
  assert.match(tours.status().a.reason, /terrain identity/);
});

test('mode resolution: shot tours by default, off keeps rails, tetons forces the highway', () => {
  assert.deepEqual(resolveRangeMode(''), { mode: 'v2', forcedViewId: null, diag: null, tour: null, shots: true, shotCandidates: false, upgradeIntended: false });
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

test('visible intervals follow the chapters that show the view, through the outgoing allowance', () => {
  const sections = [{ startMs: 0, endMs: 40000, profile: { name: 'CONIFER' } }, { startMs: 40000, endMs: 90000, profile: { name: 'ICEFIELD' } },
    { startMs: 90000, endMs: 120000, profile: { name: 'CONIFER' } }];
  const choice = (b) => ({ view: { id: b === 'CONIFER' ? 'teton' : 'denali' } });
  assert.deepEqual(visibleIntervals('teton', { durationMs: 120000, sections }, choice), [{ startMs: 0, endMs: 48200 }, { startMs: 90000, endMs: 120000 }]);
  assert.deepEqual(visibleIntervals('denali', { durationMs: 120000, sections }, choice), [{ startMs: 40000, endMs: 98200 }]);
  assert.deepEqual(visibleIntervals('elsewhere', { durationMs: 120000, sections }, choice), [{ startMs: 0, endMs: 120000 }], 'a forced view is visible throughout');
  assert.equal(cameraFootprint(library, 200)[0].length >= 2, true);
});

// Break caught: a tour planned for chapters the rail schedule never shows.
test('visible intervals read the actual schedule, including its committed views', () => {
  const sections = [{ startMs: 0, endMs: 20000, profile: 'A' }, { startMs: 20000, endMs: 40000, profile: 'B' }, { startMs: 40000, endMs: 60000, profile: 'A' }];
  const choiceFor = (b) => ({ view: { id: b } });
  const old = compileSceneRailPlan({ sections, choiceFor, durationMs: 60000 });
  const adopted = compileSceneRailPlan({ sections: [{ startMs: 0, endMs: 60000, profile: 'B' }], choiceFor, durationMs: 60000, previous: old, committedThroughMs: 5000 });
  const m = { durationMs: 60000, sections: adopted.occurrences && [{ startMs: 0, endMs: 60000, profile: 'B' }] };
  assert.deepEqual(visibleIntervals('A', m, choiceFor, adopted.occurrences), [{ startMs: 0, endMs: 28200 }]);
  assert.deepEqual(visibleIntervals('B', m, choiceFor, adopted.occurrences), [{ startMs: 20000, endMs: 60000 }]);
});

test('plans and refinements receive the schedule windows, not a pre-chapter margin', async () => {
  const calls = [];
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async (l, m, o) => { calls.push(o.visible); return timeline(); } });
  const sections = [{ startMs: 0, endMs: 20000, profile: { name: 'CONIFER' } }, { startMs: 20000, endMs: 60000, profile: { name: 'ICEFIELD' } }];
  const m = mgr(sections), choiceFor = (b) => ({ view: { id: b === 'CONIFER' ? 'a' : 'b' } });
  const plan = compileSceneRailPlan({ sections, choiceFor, durationMs: 60000 });
  tours.setSong({ mgr: m, views: [view('b')], choiceFor, generation: 1, occurrences: plan.occurrences });
  await settle(); await settle();
  m.sections = [{ startMs: 0, endMs: 60000, profile: { name: 'ICEFIELD' } }];
  tours.refine(m);
  await settle(); await settle();
  assert.deepEqual(calls, [[{ startMs: 20000, endMs: 60000 }], [{ startMs: 20000, endMs: 60000 }]]);
});

// keyed(from, by): a timeline equal to timeline() before `from`, offset after.
const keyed = (from, by = 3) => ({ ...timeline(), poseAt: (t) => ({ ...timeline().poseAt(t), eyeM: [t / 100 + (t >= from ? by : 0), 500, 0] }) });

test('heard history is compared key by key through its Catmull-Rom support', () => {
  const a = timeline();
  assert.equal(retainsHeardCamera(a, timeline(), 10050), true);
  assert.equal(retainsHeardCamera(a, keyed(10300), 10050), true, 'the third key after 10050 ms shapes nothing heard');
  assert.equal(retainsHeardCamera(a, keyed(10200), 10050), false, 'the last heard interval reads key 10200');
  assert.equal(retainsHeardCamera(a, keyed(4000), 10050), false, 'an earlier heard key counts even though the present matches');
  const fov = { ...timeline(), poseAt: (t) => ({ ...timeline().poseAt(t), fovYDeg: t === 5000 ? 30.001 : 30 }) };
  assert.equal(retainsHeardCamera(a, fov, 10050), false);
  const target = { ...timeline(), poseAt: (t) => ({ ...timeline().poseAt(t), targetM: t === 5000 ? [.01, 400, -5000] : [0, 400, -5000] }) };
  assert.equal(retainsHeardCamera(a, target, 10050), false);
  assert.equal(retainsHeardCamera(a, timeline(), 59990), true, 'support clips at the song end');
});

// Break caught: a refinement after a rewind re-planning what was already heard.
test('a refinement after a rewind commits the heard high-water, not the playhead', async () => {
  const commits = [];
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async (l, m, o) => { commits.push(o.committedThroughMs); return timeline(); } });
  const m = mgr();
  tours.setSong({ mgr: m, views: [view('a')], generation: 1 });
  await settle(); await settle();
  m.tSec = 50; tours.reach(50000);
  m.tSec = 12; tours.reach(12000);
  m.sections = [...m.sections];
  tours.refine(m);
  await settle(); await settle();
  assert.deepEqual(commits, [-1, 50000]);
});

test('a late reply that rewrites a heard key is held and retried, even if the present matches', async () => {
  let next = timeline(), held;
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: () => new Promise((r) => { held = r; }) });
  const m = mgr();
  tours.setSong({ mgr: m, views: [view('a')], generation: 1 });
  await settle(); held(next); await settle();
  const first = tours.timeline('a');
  m.sections = [...m.sections]; tours.refine(m);
  tours.reach(40000); m.tSec = 20; // heard to 40 s, rewound to 20 s while the worker ran
  held(keyed(30000)); await settle();
  assert.equal(tours.timeline('a'), first);
  assert.equal(tours.status().a.refinement.state, 'held');
  let asked = false; const original = tours._plan;
  tours._plan = (...args) => { asked = true; return original(...args); };
  tours.refine(m);
  assert.equal(asked, true, 'the held refinement retries from the newer horizon');
  held(keyed(40300)); await settle();
  assert.equal(tours.status().a.refinement.state, 'applied');
});

test('a continued rebuild never gives up heard history to a failed, late or fallback plan', async () => {
  const committed = timeline();
  const continuation = { timelines: new Map([['a', committed]]), committedThroughMs: 30000 };
  const replies = [async () => { throw new Error('worker died'); }, async () => ({ ...timeline(), fallback: 'no feasible sequence' }), async () => keyed(20000)];
  for (const plan of replies) {
    const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan });
    tours.setSong({ mgr: mgr(), views: [view('a')], generation: 2, continuation });
    await settle(); await settle();
    assert.equal(tours.timeline('a'), committed);
    assert.equal(tours.settled('a'), true);
    assert.equal(tours.status().a.state, 'ready');
    assert.equal(tours.status().a.refinement.state, 'held');
  }
  let now = 0;
  const slow = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: () => new Promise(() => {}), now: () => now });
  slow.setSong({ mgr: mgr(), views: [view('a')], generation: 2, continuation });
  await settle();
  now = SHOT_PLAN_TIMEOUT_MS + 1;
  assert.equal(slow.settled('a'), true);
  assert.equal(slow.timeline('a'), committed);
});

// A tour with a settled camera whose planner the test scripts reply by reply.
const replanning = async (reply) => {
  let now = 0, calls = [];
  const plan = (lib, m, options) => { calls.push(options); return reply(calls.length, options); };
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan, now: () => now });
  const m = mgr(), committed = timeline();
  const continuation = { timelines: new Map([['a', committed]]), committedThroughMs: 30000 };
  return { tours, m, committed, calls, continuation, advance: (ms) => { now += ms; } };
};
const newSections = (m) => { m.sections = [...m.sections]; };
const failed = async () => { throw new Error('worker died'); };

test('a failed or timed-out continued plan is replanned from the newer horizon', async () => {
  const fixed = keyed(50000);
  const r = await replanning((n) => (n === 1 ? failed() : Promise.resolve(fixed)));
  r.tours.setSong({ mgr: r.m, views: [view('a')], generation: 2, continuation: r.continuation });
  await settle(); await settle();
  assert.equal(r.tours.timeline('a'), r.committed);
  assert.equal(r.calls.length, 1);
  r.tours.refine(r.m);
  assert.equal(r.calls.length, 1, 'a retry waits out its delay');
  r.advance(SHOT_REPLAN_RETRY_MS); r.tours.reach(35000);
  r.tours.refine(r.m);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].committedThroughMs, 35000);
  assert.equal(r.calls[1].previous, r.committed);
  await settle(); await settle();
  assert.equal(r.tours.timeline('a'), fixed);
  assert.equal(r.tours.status().a.refinement.state, 'applied');

  const late = await replanning((n) => (n === 1 ? new Promise(() => {}) : Promise.resolve(fixed)));
  late.tours.setSong({ mgr: late.m, views: [view('a')], generation: 2, continuation: late.continuation });
  await settle();
  late.advance(SHOT_PLAN_TIMEOUT_MS + 1);
  assert.equal(late.tours.settled('a'), true);
  late.advance(SHOT_REPLAN_RETRY_MS);
  late.tours.refine(late.m);
  assert.equal(late.calls.length, 2);
});

test('replan retries are bounded, and new sections reopen them', async () => {
  for (const reply of [failed, async () => ({ ...timeline(), fallback: 'no feasible sequence' })]) {
    const r = await replanning(reply);
    r.tours.setSong({ mgr: r.m, views: [view('a')], generation: 2, continuation: r.continuation });
    await settle(); await settle();
    for (let i = 0; i < SHOT_REPLAN_RETRIES + 3; i++) {
      r.advance(SHOT_REPLAN_RETRY_MS); r.tours.refine(r.m);
      await settle(); await settle();
    }
    assert.equal(r.calls.length, SHOT_REPLAN_RETRIES + 1);
    assert.equal(r.tours.timeline('a'), r.committed);
    assert.equal(r.tours.status().a.refinement.retrying, false);
    newSections(r.m); r.tours.refine(r.m);
    assert.equal(r.calls.length, SHOT_REPLAN_RETRIES + 2);
  }
});

test('a refinement that never replies times out, holds the camera and retries', async () => {
  const fixed = keyed(50000);
  const r = await replanning((n) => (n === 1 ? Promise.resolve(r.committed) : n === 2 ? new Promise(() => {}) : Promise.resolve(fixed)));
  r.tours.setSong({ mgr: r.m, views: [view('a')], generation: 1 });
  await settle(); await settle();
  newSections(r.m); r.tours.refine(r.m);
  r.tours.refine(r.m);
  assert.equal(r.tours.status().a.refinement.state, 'pending');
  r.advance(SHOT_PLAN_TIMEOUT_MS + 1); r.tours.refine(r.m);
  assert.equal(r.tours.status().a.refinement.state, 'held');
  assert.equal(r.calls.length, 2);
  r.advance(SHOT_REPLAN_RETRY_MS); r.tours.refine(r.m);
  assert.equal(r.calls.length, 3);
  await settle(); await settle();
  assert.equal(r.tours.timeline('a'), fixed);
});

test('sections refined while the first plan is still running are planned once it lands', async () => {
  let release;
  const r = await replanning((n) => (n === 1 ? new Promise((done) => { release = done; }) : Promise.resolve(keyed(50000))));
  r.tours.setSong({ mgr: r.m, views: [view('a')], generation: 1 });
  await settle(); await settle();
  newSections(r.m); r.tours.refine(r.m);
  assert.equal(r.calls.length, 1, 'a view still planning is not refined yet');
  release(r.committed); await settle(); await settle();
  r.tours.refine(r.m);
  assert.equal(r.calls.length, 2);
  r.tours.refine(r.m);
  assert.equal(r.calls.length, 2, 'the change is replanned once');
});

test('a second rebuild before the first plan replies still carries heard history and horizon', async () => {
  const committed = timeline(), seen = [];
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: (l, m, o) => { seen.push([o.previous, o.committedThroughMs]); return new Promise(() => {}); } });
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 2, continuation: { timelines: new Map([['a', committed]]), committedThroughMs: 30000 } });
  await settle();
  const carried = tours.continuation(12000);
  assert.equal(carried.timelines.get('a'), committed);
  assert.equal(carried.committedThroughMs, 30000);
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 3, continuation: carried });
  await settle();
  assert.deepEqual(seen, [[committed, 30000], [committed, 30000]]);
});

test('a committed timeline of another length is not treated as heard history', async () => {
  const seen = [];
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async (l, m, o) => { seen.push(o.previous); return timeline(); } });
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 2,
    continuation: { timelines: new Map([['a', { ...timeline(), durationMs: 50000 }]]), committedThroughMs: 30000 } });
  await settle(); await settle();
  assert.deepEqual(seen, [null]);
  assert.equal(tours.status().a.state, 'ready');
});

test('export frames never commit heard time', async () => {
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => timeline() });
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 1, exportMode: true });
  tours.reach(40000);
  assert.equal(tours.heardThroughMs, 0);
});

// The real worker: every pose heard before a rewind survives a refinement
// requested after it, off the key lattice and through interpolation.
test('poses through the high-water are identical after a worker refinement requested from a rewind', async () => {
  const lib = { ...shotLibraryFixture(), terrainManifestSha256: sha }, song = anthemSong();
  const curves = { globalEnergy: (t) => song.energy[Math.round(t / 100)] };
  const m = { sections: song.sections, durationMs: song.durationMs, energyCurves: curves, songSeed: 0, tSec: 0 };
  const plan = async (l, g, { signal: _signal, ...options }) => {
    const { message } = handleShotMessage(structuredClone(shotPlanRequest(l, g, options)));
    assert.ok(message.timeline, message.error);
    return restoreShotTimeline(message.timeline);
  };
  const v = view('a');
  // Heard history, not the camera choice, is under test: this fixture's tour
  // is mostly transit and the default gate would keep its rail.
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library: lib }), plan, gate: null });
  tours.setSong({ mgr: m, views: [v], generation: 1 });
  await settle(); await settle();
  const before = tours.timeline('a');
  assert.ok(before?.fov, tours.status().a.reason);
  tours.reach(70000);
  m.tSec = 20;
  const moved = song.sections.map((s, i) => ({ ...s, startMs: i ? s.startMs + (i % 2 ? 1500 : -1500) : 0 }));
  m.sections = moved.map((s, i) => ({ ...s, endMs: moved[i + 1]?.startMs ?? song.durationMs }));
  tours.refine(m);
  await settle(); await settle();
  assert.equal(tours.status().a.refinement.state, 'applied');
  const after = tours.timeline('a');
  for (let t = 0; t <= 70000; t += 37.3) {
    const a = before.poseAt(t), b = after.poseAt(t);
    assert.deepEqual([a.eyeM, a.targetM, a.fovYDeg], [b.eyeM, b.targetM, b.fovYDeg], `pose at ${t}`);
  }
});
