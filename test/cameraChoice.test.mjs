import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TOUR_GATE, tourMetrics, tourBeatsRail, autoGateEnabled } from '../src/world/alpine/CameraChoice.js';
import { RangeShotTours } from '../src/world/alpine/RangeShotTours.js';
import { shotTourControlState } from '../src/ui/RangeTourControl.js';
import { SHOT_KEY_MS } from '../src/world/terrain/ShotTimeline.js';

// A 60 s timeline whose keys are links where `isLink(t)` holds.
function planned({ isLink = () => false, payoffs = [{ plannedMs: 30000, actualMs: 30000 }], diagnostics = {}, notes = [], fallback = null } = {}) {
  const durationMs = 60000, keys = durationMs / SHOT_KEY_MS + 1, meta = new Uint8Array(keys * 4);
  for (let k = 0; k < keys; k++) meta[k * 4 + 1] = isLink(k * SHOT_KEY_MS) ? 1 : 0;
  return { durationMs, meta, payoffs, diagnostics, notes, fallback, items: [{}, {}],
    poseAt: (t) => ({ eyeM: [t / 100, 500, 0], targetM: [0, 400, -5000], fovYDeg: 30, tour: true }), stateAt: () => ({ kind: 'shot' }) };
}

test('transit share is measured only over the time the view is on screen', () => {
  const tl = planned({ isLink: (t) => t < 30000 });
  assert.ok(Math.abs(tourMetrics(tl).transitShare - 0.5) < 0.01);
  assert.equal(tourMetrics(tl, [{ startMs: 30000, endMs: 60000 }]).transitShare, 0);
  assert.equal(tourMetrics(tl, [{ startMs: 0, endMs: 20000 }]).transitShare, 1);
  assert.equal(tourMetrics(tl, [{ startMs: 0, endMs: 20000 }]).payoffs, 0, 'a payoff off screen does not count');
});

test('a tour beats the rail only with a timed payoff, little transit and comfortable motion', () => {
  assert.deepEqual(tourBeatsRail(planned()).ok, true);
  assert.match(tourBeatsRail(planned({ isLink: (t) => t < 40000 })).reason, /67% in transit/);
  assert.match(tourBeatsRail(planned({ payoffs: [] })).reason, /no shot lands/);
  assert.match(tourBeatsRail(planned({ payoffs: [{ plannedMs: 30000, actualMs: 33000 }] })).reason, /misses its moment by 3.0 s/);
  assert.match(tourBeatsRail(planned({ payoffs: [{ plannedMs: 30000, actualMs: null }] })).reason, /misses/);
  assert.match(tourBeatsRail(planned({ diagnostics: { maxFlowRatio: 1.4 } })).reason, /image flow 1.40x/);
  assert.match(tourBeatsRail(planned({ notes: ['eye acceleration 3.10 m/s2 over the limit'] })).reason, /over the limit/);
  assert.equal(tourBeatsRail(planned({ fallback: 'no shots' })).ok, false);
  assert.equal(tourBeatsRail(null).ok, false);
  const loose = { ...AUTO_TOUR_GATE, maxTransitShare: 0.8 };
  assert.equal(tourBeatsRail(planned({ isLink: (t) => t < 40000 }), null, loose).ok, true);
});

test('?rangeTourGate=off is the only way to skip the comparison', () => {
  assert.equal(autoGateEnabled(''), true);
  assert.equal(autoGateEnabled('?rangeTourGate=on'), true);
  assert.equal(autoGateEnabled('?rangeTourGate=off'), false);
});

const sha = 'a'.repeat(64);
const view = (id) => ({ id, status: 'approved', shotsManifestUrl: `tour/${id}.shots.json`, shotsManifestSha256: sha,
  terrainManifestSha256: sha, baseViewSha256: sha,
  shotTour: { status: 'approved', identity: { shotsManifestSha256: sha, terrainManifestSha256: sha, baseViewSha256: sha },
    approval: { shotsManifestSha256: sha, terrainManifestSha256: sha, baseViewSha256: sha, date: '2026-11-03', evidence: ['review.md'] } } });
const library = { terrainManifestSha256: sha, shots: [], links: [] };
const mgr = () => ({ durationMs: 60000, sections: [{ startMs: 0, endMs: 60000, profile: { name: 'CONIFER' } }], songSeed: 7, tSec: 0 });
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

test('Auto keeps the rail for a song whose tour is mostly transit, and says why', async () => {
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => planned({ isLink: (t) => t < 45000 }) });
  tours.setSong({ mgr: mgr(), views: [view('a')], generation: 1 });
  await settle();
  assert.equal(tours.timeline('a'), null);
  assert.equal(tours.settled('a'), true, 'a rail verdict settles the view: it can be drawn');
  const status = tours.status().a;
  assert.equal(status.state, 'rail');
  assert.match(status.reason, /^rail kept: the tour spends 75% in transit/);
  assert.equal(status.choice.ok, false);
  const control = shotTourControlState({ shotTours: { enabled: true, views: { a: status } }, viewId: 'a', active: true }, { running: true, worldKind: 'alpine' });
  assert.equal(control.state, 'rail');
  assert.match(control.text, /authored rail beats this song's tour \(the tour spends 75% in transit\)/);

  const ungated = new RangeShotTours({ assetBase: 'http://x/', gate: null, load: async () => ({ library }), plan: async () => planned({ isLink: (t) => t < 45000 }) });
  ungated.setSong({ mgr: mgr(), views: [view('a')], generation: 1 });
  await settle();
  assert.ok(ungated.timeline('a'), 'without the gate every planned tour plays');
});

test('a good plan plays; a refinement that loses to the rail is held, the playing tour stays', async () => {
  let next = planned();
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => next });
  const m = mgr();
  tours.setSong({ mgr: m, views: [view('a')], generation: 1 });
  await settle();
  const first = tours.timeline('a');
  assert.ok(first);
  assert.equal(tours.status().a.choice.ok, true);
  next = planned({ isLink: (t) => t > 10000 });
  m.sections = [...m.sections];
  tours.refine(m);
  await settle();
  assert.equal(tours.timeline('a'), first);
  assert.equal(tours.status().a.refinement.state, 'held');
  assert.match(tours.status().a.refinement.reason, /loses to the rail/);
});

test('an in-place rebuild keeps a rail verdict and a playing tour: no camera swap mid-song', async () => {
  let next = planned({ isLink: () => true });
  const tours = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => next });
  tours.setSong({ mgr: mgr(), views: [view('a'), view('b')], generation: 1 });
  await settle();
  assert.equal(tours.status().a.state, 'rail');
  const continuation = tours.continuation(20000);
  assert.ok(continuation.railKept.has('a'));
  next = planned(); // would now pass, but the view is already on its rail
  tours.setSong({ mgr: mgr(), views: [view('a'), view('b')], generation: 2, continuation });
  await settle();
  assert.equal(tours.status().a.state, 'rail');
  assert.equal(tours.timeline('a'), null);

  // A tour that was already playing continues even if it would fail now.
  const playing = new RangeShotTours({ assetBase: 'http://x/', load: async () => ({ library }), plan: async () => next });
  playing.setSong({ mgr: mgr(), views: [view('a')], generation: 1 });
  await settle();
  const cont = playing.continuation(20000);
  next = planned({ isLink: () => true });
  playing.setSong({ mgr: mgr(), views: [view('a')], generation: 2, continuation: cont });
  await settle();
  assert.ok(playing.timeline('a'));
});
