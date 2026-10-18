import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RangePresentation, resolveRangeMode } from '../src/world/alpine/RangePresentation.js';
import { rangeTourControlState } from '../src/ui/RangeTourControl.js';

const tourViewId = 'teton-range-tour';
const manager = (durationMs = 60000) => ({
  durationMs, sections: [{ startMs: 0, endMs: durationMs, profile: { name: 'CONIFER' } }],
  world: { kind: 'alpine' }, reducedMotion: false, tSec: 0,
  currentBlend: { from: 'CONIFER', to: 'CONIFER', t: 1 }, _profile: () => null,
});

const previewTour = (durationMs) => ({
  durationMs, heroes: [], notes: [], reducedMotion: false,
  previewPose: { eyeM: [0, 2000, 0], targetM: [0, 2000, -1000], fovYDeg: 35, tour: true },
});

function fakeScene() {
  const prepared = new Map();
  return {
    prepared, contextLost: false,
    isReady: id => prepared.has(id),
    prepare: async view => { prepared.set(view.id, { view }); },
    release: id => prepared.delete(id),
    resize() {}, pinView() {}, dispose() { prepared.clear(); }, snapshot: () => ({}),
  };
}

function inputs(mgr) {
  return {
    sim: { songSeed: 315, biomes: mgr, perf: { level: 0 } },
    pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
    scenicViewport: { logicalWidth: 1280, logicalHeight: 720, backingWidth: 1280, backingHeight: 720 },
    groundViewport: { logicalWidth: 1280, logicalHeight: 720 },
  };
}

async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'tour boundary did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Only the browser-owned fetch and Worker boundaries are replaced. Asset
// verification/decoding, generation ownership, frame selection and status
// all run through the real presentation code and published tour package.
function installTourBoundaries(t) {
  const previousWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
    reply(tour) { this.onmessage?.({ data: { tour } }); }
  };
  t.after(() => { globalThis.Worker = previousWorker; });
  t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(new URL(url))));
  return workers;
}

test('tour query overrides persisted on/off preferences and blocked storage stays usable', () => {
  const saved = value => ({ getItem: () => value });
  assert.equal(resolveRangeMode('', saved(null)).tour, null);
  assert.equal(resolveRangeMode('', saved('tetons')).tour, 'tetons');
  assert.equal(resolveRangeMode('?rangeTour=off', saved('tetons')).tour, null);
  assert.equal(resolveRangeMode('?rangeTour=tetons', saved(null)).tour, 'tetons');
  assert.equal(resolveRangeMode('?rangeRenderer=legacy&rangeTour=tetons', saved(null)).mode, 'v2');
  assert.equal(resolveRangeMode('?rangeTour=tetons', { getItem() { throw Error('blocked'); } }).tour, 'tetons');
});

test('a new song invalidates the previous active camera before its first frame', () => {
  const p = new RangePresentation({ mode: 'v2' });
  Object.assign(p, { active: true, viewId: tourViewId, frame: { timeMs: 12000 } });
  p.setSong({ mgr: manager() });
  assert.equal(p.snapshot().active, false);
  assert.equal(p.snapshot().viewId, null);
  assert.equal(p.frame, null);
  p.dispose();
});

test('enabling the title preference waits for a real song before downloading or planning', t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const p = new RangePresentation({ mode: 'v2' });
  t.after(() => p.dispose());
  p.setTourMode('tetons');
  assert.equal(fetch.mock.callCount(), 0, 'no zero-duration tour job before a song owns it');
  assert.equal(p.snapshot().tourPreparation.state, 'idle');
});

test('runtime-unavailable tour diagnostics preserve the real fallback reason', async () => {
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId,
    sceneFactory: async () => { throw Error('WebGL2 unavailable'); } });
  await p._ensureRuntime();
  const state = p.snapshot();
  assert.equal(state.requestedMode, 'v2');
  assert.equal(state.resolvedMode, 'legacy');
  assert.equal(state.runtimeReady, false);
  assert.equal(state.selectedViewId, tourViewId);
  assert.match(state.fallbackReason, /WebGL2 unavailable/);
  p.dispose();
});

for (const [name, mgr] of [['title', null], ['another world', { ...manager(), world: { kind: 'strip' } }]]) {
  test(`tour readiness on ${name} does not wait for a camera that this song does not own`, async t => {
    const sceneFactory = t.mock.fn(async () => fakeScene());
    const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, sceneFactory });
    t.after(() => p.dispose());
    p.setSong({ mgr });
    const value = await p.whenReady({ timeoutMs: 20 });
    assert.equal(sceneFactory.mock.callCount(), 0, 'readiness must not create an unused renderer or wait on an idle tour');
    assert.equal(value.runtime, 'idle');
    assert.equal(value.tourPreparation.state, 'idle');
  });
}

test('a new song preserves a persistent renderer failure until the runtime recovers', async () => {
  const p = new RangePresentation({ mode: 'v2', sceneFactory: async () => { throw Error('WebGL2 unavailable'); } });
  await p.whenReady();
  p.setSong({ mgr: manager() });
  assert.equal(p.snapshot().runtime, 'failed');
  assert.match(p.snapshot().fallbackReason, /runtime-unavailable: WebGL2 unavailable/);
  p.dispose();
});

test('tour preparation reports download, planning, ready, and actual rendered activity', async t => {
  const workers = installTourBoundaries(t), scene = fakeScene(), mgr = manager();
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, sceneFactory: async () => scene });
  t.after(() => p.dispose());
  p.setSong({ mgr });
  assert.equal(p.snapshot().tourPreparation?.state, 'loading');
  await waitFor(() => workers.length === 1);
  assert.equal(p.snapshot().tourPreparation.state, 'planning');
  workers[0].reply(previewTour(mgr.durationMs));
  await p._tourPromise;
  assert.equal(p.snapshot().tourPreparation.state, 'ready');
  assert.equal(p.snapshot().active, false, 'a completed plan is not a drawn tour');
  await p.whenReady();
  p.setFrameInputs(inputs(mgr));
  assert.equal(p.beginScenic(), true);
  assert.equal(p.snapshot().active, true);
  assert.equal(p.snapshot().resolvedMode, 'v2');
  assert.equal(p.snapshot().viewId, tourViewId);
});

test('a corrupt tour asset exposes failure and cannot claim the camera is active', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId });
  t.after(() => p.dispose());
  p.setSong({ mgr: manager() });
  await p._tourPromise;
  const state = p.snapshot();
  assert.equal(state.tourPreparation?.state, 'failed');
  assert.match(state.tourPreparation.reason, /hash mismatch/);
  assert.match(state.fallbackReason, /hash mismatch/);
  assert.equal(state.active, false);
});

test('late preparation from the previous song cannot replace the current song or its diagnostics', async t => {
  const workers = installTourBoundaries(t), p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId });
  t.after(() => p.dispose());
  p.setSong({ mgr: manager(60000) });
  await waitFor(() => workers.length === 1);
  const oldPromise = p._tourPromise;
  p.setSong({ mgr: manager(90000) });
  const currentGeneration = p.generation;
  await waitFor(() => workers.length === 2);
  workers[1].reply(previewTour(90000));
  await p._tourPromise;
  workers[0].reply(previewTour(60000));
  await oldPromise;
  assert.equal(workers[0].terminated, true);
  assert.equal(p.tour.durationMs, 90000);
  assert.equal(p.snapshot().tourPreparation?.generation, currentGeneration);
  assert.equal(p.snapshot().tourPreparation.state, 'ready');
});

test('a lost planning reservation cannot publish a ready tour', async t => {
  const workers = installTourBoundaries(t);
  const residency = {
    reserve: options => options, commit: () => false, releaseReservation() {},
    release() {}, cancelGeneration() {}, snapshot: () => ({}),
  };
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, residency });
  t.after(() => p.dispose());
  p.setSong({ mgr: manager() });
  await waitFor(() => workers.length === 1);
  workers[0].reply(previewTour(60000));
  await p._tourPromise;
  assert.equal(p.tour, null, 'a plan without its owned memory is not available to the camera');
  assert.equal(p.snapshot().tourPreparation.state, 'failed');
  assert.match(p.snapshot().fallbackReason, /memory|reservation/i);
});

for (const [outcome, reason] of [
  ['deferral', 'Refinement deferred: no safe road continuation before the end'],
  ['error', 'Tour route has no rate-limited altitude corridor'],
]) test(`a motion refinement ${outcome} reports the retained setting and clears its reason after success`, async t => {
  const workers = installTourBoundaries(t), mgr = manager(), scene = fakeScene();
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, sceneFactory: async () => scene });
  t.after(() => p.dispose());
  p.setSong({ mgr });
  await waitFor(() => workers.length === 1);
  workers[0].reply(previewTour(mgr.durationMs));
  await p.whenReady();
  p.setFrameInputs(inputs(mgr));
  p.beginScenic();
  const before = p.tour.poseAt(12000);
  mgr.tSec = 12;
  mgr.reducedMotion = true;
  p.beginScenic();
  if (outcome === 'deferral') workers[1].reply({ ...previewTour(mgr.durationMs), notes: [reason] });
  else workers[1].onmessage({ data: { error: reason } });
  await p._replanPromise;
  const held = p.snapshot();
  assert.deepEqual(p.tour.poseAt(12000), before, 'a deferred request keeps the owned camera');
  assert.equal(held.tourPreparation.requestedReducedMotion, true);
  assert.equal(held.tourPreparation.effectiveReducedMotion, false);
  assert.equal(held.tourPreparation.refinement.state, 'held');
  assert.equal(held.tourPreparation.refinement.reason, reason);
  const control = rangeTourControlState(held, { running: true, worldKind: 'alpine', paused: true });
  assert.equal(control.state, 'active');
  assert.match(control.text, /motion change unavailable/i);
  assert.equal(control.reason, reason);

  // A later request still owns a new worker; success must clear the hold.
  mgr.reducedMotion = false;
  p.beginScenic();
  workers[2].reply(previewTour(mgr.durationMs));
  await p._replanPromise;
  mgr.reducedMotion = true;
  p.beginScenic();
  workers[3].reply({ ...previewTour(mgr.durationMs), reducedMotion: true });
  await p._replanPromise;
  const applied = p.snapshot();
  assert.equal(applied.tourPreparation.requestedReducedMotion, true);
  assert.equal(applied.tourPreparation.effectiveReducedMotion, true);
  assert.equal(applied.tourPreparation.refinement.state, 'applied');
  assert.equal(applied.tourPreparation.refinement.reason, null);
  assert.match(rangeTourControlState(applied, { running: true, worldKind: 'alpine', paused: true }).text, /Active — reduced motion/);
});

test('a sections-only deferral is held but historical refinement notes do not mark a later success held', async t => {
  const workers = installTourBoundaries(t), mgr = manager(), scene = fakeScene();
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, sceneFactory: async () => scene });
  t.after(() => p.dispose());
  const note = 'Refinement deferred: no safe road continuation before the end';
  p.setSong({ mgr });
  await waitFor(() => workers.length === 1);
  workers[0].reply({ ...previewTour(mgr.durationMs), notes: [note] });
  await p.whenReady();
  p.setFrameInputs(inputs(mgr));
  p.beginScenic();
  mgr.sections = [...mgr.sections];
  p.beginScenic();
  // Repeating a prior reason is still a new deferral when appended anew.
  workers[1].reply({ ...previewTour(mgr.durationMs), notes: [note, note] });
  await p._replanPromise;
  assert.equal(p.status().tourPreparation.refinement.state, 'held');
  assert.equal(p.status().tourPreparation.refinement.reason, note);
  assert.equal(p.status().tourPreparation.requestedReducedMotion, false);
  assert.equal(p.status().tourPreparation.effectiveReducedMotion, false);
  mgr.sections = [...mgr.sections];
  p.beginScenic();
  workers[2].reply({ ...previewTour(mgr.durationMs), notes: [note, note] });
  await p._replanPromise;
  assert.equal(p.status().tourPreparation.refinement.state, 'applied');
  assert.equal(p.status().tourPreparation.refinement.reason, null);
});

test('disposing the tour clears its active status even when paused between frames', () => {
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId });
  Object.assign(p, { active: true, viewId: tourViewId, frame: { timeMs: 12000 } });
  p.dispose();
  assert.equal(p.snapshot().active, false);
  assert.equal(p.snapshot().viewId, null);
});


test('a late refinement cannot replace the camera after its committed horizon has passed', async t => {
  const workers = installTourBoundaries(t), mgr = manager(), scene = fakeScene();
  const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, sceneFactory: async () => scene });
  t.after(() => p.dispose());
  p.setSong({ mgr });
  await waitFor(() => workers.length === 1);
  workers[0].reply(previewTour(mgr.durationMs));
  await p.whenReady();
  p.setFrameInputs(inputs(mgr)); p.beginScenic();
  const committed = p.tour;
  mgr.tSec = 10;
  mgr.sections = [...mgr.sections]; p.setFrameInputs(inputs(mgr)); p.beginScenic();
  await waitFor(() => workers.length === 2);
  mgr.tSec = 20;
  const late = previewTour(mgr.durationMs); late.previewPose.eyeM[0] = 2000;
  workers[1].reply(late); await p._replanPromise;
  assert.equal(p.tour, committed, 'the current camera stays on the committed route');
  assert.equal(p.status().tourPreparation.refinement.state, 'held');
  p.beginScenic();
  await waitFor(() => workers.length === 3);
  assert.equal(workers[2].message.committedThroughMs, 20000, 'retry begins from the current heard time');
  workers[2].reply(previewTour(mgr.durationMs)); await p._replanPromise;
  assert.equal(p.status().tourPreparation.refinement.state, 'applied');
});
