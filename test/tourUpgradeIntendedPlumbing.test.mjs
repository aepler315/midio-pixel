import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RangePresentation, resolveRangeMode } from '../src/world/alpine/RangePresentation.js';
import { prepareTourTimeline } from '../src/world/terrain/TourRuntime.js';
import { buildTourTimeline, replanTour } from '../src/world/terrain/TourTimeline.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';

// Intended upgrades replace an accepted subject, so every layer keeps them
// off unless asked, and a refinement keeps the setting its tour was planned with.

test('only ?rangeTourIntended=1 requests intended upgrades', () => {
  assert.equal(resolveRangeMode('').upgradeIntended, false);
  assert.equal(resolveRangeMode('?rangeTour=tetons').upgradeIntended, false);
  for (const value of ['0', 'true', 'yes', '']) assert.equal(resolveRangeMode(`?rangeTourIntended=${value}`).upgradeIntended, false, value);
  assert.equal(resolveRangeMode('?rangeTour=tetons&rangeTourIntended=1').upgradeIntended, true);
  assert.equal(resolveRangeMode('?rangeTourIntended=1', { getItem() { throw Error('blocked'); } }).upgradeIntended, true);
});

function captureWorker(t) {
  const previous = globalThis.Worker, messages = [];
  globalThis.Worker = class {
    postMessage(message) {
      messages.push(message);
      queueMicrotask(() => this.onmessage({ data: { tour: { previewPose: { eyeM: [0, 1, 0], targetM: [0, 1, -1], fovYDeg: 35 } } } }));
    }
    terminate() {}
  };
  t.after(() => { globalThis.Worker = previous; });
  return messages;
}

test('the runtime posts the request and the previous tour setting to the worker', async t => {
  const messages = captureWorker(t), mgr = { durationMs: 1000, sections: [] };
  await prepareTourTimeline({}, mgr);
  await prepareTourTimeline({}, mgr, { upgradeIntended: true });
  const previous = { durationMs: 1000, eye: new Float32Array(6), target: new Float32Array(6), fov: new Float32Array(2),
    meta: new Uint16Array(8), heroes: [], notes: [], upgradeIntended: true };
  await prepareTourTimeline({}, mgr, { previous, upgradeIntended: true });
  assert.deepEqual(messages.map(m => m.upgradeIntended), [false, true, true]);
  assert.equal(messages[2].previous.upgradeIntended, true, 'a deferred refinement returns the serialized previous setting');
});

test('the worker plans and refines with the requested setting and reports it', async () => {
  const priorSelf = globalThis.self, messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import('../src/world/terrain/tour-worker.js');
    const request = upgradeIntended => ({ data: tourFixture(), durationMs: 20000, energy: new Float32Array(81).fill(.5),
      sections: [{ startMs: 0, endMs: 20000, role: 'outro', relEnergy01: .5 }], roles: [],
      previous: null, committedThroughMs: 0, ...(upgradeIntended === undefined ? {} : { upgradeIntended }) });
    for (const flag of [undefined, false, true]) globalThis.self.onmessage({ data: request(flag) });
    assert.deepEqual(messages.map(m => [m.error, m.tour?.upgradeIntended]), [[undefined, false], [undefined, false], [undefined, true]]);
    const previous = messages[2].tour;
    globalThis.self.onmessage({ data: { ...request(true), previous, committedThroughMs: 4000 } });
    assert.equal(messages[3].error, undefined);
    assert.equal(messages[3].tour.upgradeIntended, true, 'a refinement keeps the requested setting');
  } finally { globalThis.self = priorSelf; }
});

// The static route of tourMonotoneComposition.test.mjs: a 40 degree
// alternative the first pass accepts, and an intended subject at 170 degrees
// reachable only by the rate-limited upgrade.
function upgradeScenario() {
  const data = tourFixture();
  data.points = data.points.slice(0, 6);
  const [road, intended, alternative, held] = data.points;
  road.role = 'road'; road.localM = [0, 1137, -5000];
  data.points.slice(1).forEach((point, index) => { point.role = `subject-${index}`; });
  const place = (point, bearing) => { point.localM = [5000 * Math.sin(bearing * Math.PI / 180), 1137, -5000 * Math.cos(bearing * Math.PI / 180)]; };
  place(intended, 170); place(alternative, 40); place(held, 2);
  alternative.role = intended.role;
  const plan = {
    durationMs: 22000, previewPointId: road.id, notes: [], segments: [],
    heroes: [{ pointId: held.id, timeMs: 4000, passedAtRange: true }, { pointId: intended.id, timeMs: 15000, passedAtRange: true }],
    routeAt: () => ({ posM: [0, 0], floorY: 100, ceilY: 2000, speedMps: 0, pointId: road.id, role: 'intro', headingDeg: 0 }),
  };
  return { data, plan, intended, alternative };
}
const shot = (tour, point) => tour.heroFraming.find(hero => hero.timeMs === 15000 && hero.pointId === point.id);

test('a refinement inherits the upgrade setting and keeps its committed prefix', () => {
  const { data, plan, intended, alternative } = upgradeScenario();
  const off = buildTourTimeline(data, plan), on = buildTourTimeline(data, plan, { upgradeIntended: true });
  assert.equal(off.upgradeIntended, false);
  assert.equal(on.upgradeIntended, true);
  assert.equal(shot(off, intended).framedPointId, alternative.id);
  assert.equal(shot(on, intended).reason, 'rate-limited-intended-upgrade');

  const inherited = replanTour(on, data, plan, 2000), overridden = replanTour(on, data, plan, 2000, { upgradeIntended: false });
  assert.equal(inherited.upgradeIntended, true);
  assert.equal(overridden.upgradeIntended, false);
  assert.equal(shot(inherited, intended).framedPointId, intended.id, 'the upgraded shot after the horizon survives refinement');
  assert.equal(shot(inherited, intended).reason, 'rate-limited-intended-upgrade');
  assert.equal(shot(overridden, intended).framedPointId, alternative.id, 'an explicit false refines without upgrades');
  const freeze = inherited.routeTimeOriginMs;
  assert.equal(freeze, 5000);
  for (const refined of [inherited, overridden]) {
    for (let time = 0; time <= freeze; time += 25) assert.deepEqual(refined.poseAt(time), on.poseAt(time), `committed pose at ${time} ms`);
  }
  assert.equal(replanTour(off, data, plan, 2000).upgradeIntended, false, 'a tour planned without upgrades refines without them');
});

const tourViewId = 'teton-range-tour';
const manager = () => ({ durationMs: 60000, sections: [{ startMs: 0, endMs: 60000, profile: { name: 'CONIFER' } }],
  world: { kind: 'alpine' }, tSec: 0, currentBlend: { from: 'CONIFER', to: 'CONIFER', t: 1 }, _profile: () => null });
const previewTour = upgradeIntended => ({ durationMs: 60000, heroes: [], notes: [], upgradeIntended,
  previewPose: { eyeM: [0, 2000, 0], targetM: [0, 2000, -1000], fovYDeg: 35, tour: true } });
function fakeScene() {
  const prepared = new Map();
  return { prepared, contextLost: false, isReady: id => prepared.has(id), prepare: async view => { prepared.set(view.id, { view }); },
    release: id => prepared.delete(id), resize() {}, pinView() {}, dispose() { prepared.clear(); }, snapshot: () => ({}), replaceTour() {} };
}
async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < deadline, 'tour boundary did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

for (const upgradeIntended of [false, true]) {
  test(`the presentation plans and refines with upgrades ${upgradeIntended ? 'on' : 'off'} and reports both settings`, async t => {
    const previousWorker = globalThis.Worker, workers = [];
    globalThis.Worker = class {
      constructor() { workers.push(this); }
      postMessage(message) { this.message = message; }
      terminate() {}
      reply(tour) { this.onmessage?.({ data: { tour } }); }
    };
    t.after(() => { globalThis.Worker = previousWorker; });
    t.mock.method(globalThis, 'fetch', async url => new Response(await readFile(new URL(url))));
    const scene = fakeScene(), mgr = manager();
    const p = new RangePresentation({ mode: 'v2', tour: 'tetons', forcedViewId: tourViewId, sceneFactory: async () => scene,
      ...(upgradeIntended ? { upgradeIntended } : {}) });
    t.after(() => p.dispose());
    assert.equal(p.status().tourPreparation.requestedUpgradeIntended, upgradeIntended);
    p.setSong({ mgr });
    await waitFor(() => workers.length === 1);
    assert.equal(workers[0].message.upgradeIntended, upgradeIntended);
    workers[0].reply(previewTour(upgradeIntended));
    await p.whenReady();
    assert.equal(p.status().tourPreparation.effectiveUpgradeIntended, upgradeIntended);
    p.setFrameInputs({ sim: { songSeed: 315, biomes: mgr, perf: { level: 0 } }, pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
      scenicViewport: { logicalWidth: 1280, logicalHeight: 720, backingWidth: 1280, backingHeight: 720 }, groundViewport: { logicalWidth: 1280, logicalHeight: 720 } });
    p.beginScenic();
    mgr.sections = [...mgr.sections]; mgr.tSec = 10;
    p.beginScenic();
    await waitFor(() => workers.length === 2);
    // A preview reply has no keyframes, so its previous is not serialized;
    // the runtime test covers the serialized previous setting.
    assert.equal(workers[1].message.upgradeIntended, upgradeIntended, 'a refinement is requested with the same setting');
  });
}
