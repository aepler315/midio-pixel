import test from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';

const camera = { eyeStartM: [0, 1000, 0], eyeEndM: [0, 1000, 0],
  targetStartM: [0, 2000, -10000], targetEndM: [0, 2000, -10000], fovYDeg: 40 };

function fixture(signature = true) {
  const fallback = { id: 'catalog', biome: 'CONIFER', status: 'approved', camera };
  const view = { id: 'stage', biome: 'CONIFER', status: 'candidate', experimental: true, camera,
    ...(signature ? { signaturePerformance: 'dual-summits' } : {}) };
  const choice = { view, songRange: true, fallback: { view: fallback } };
  const terrain = { sceneByBiome: new Map([['CONIFER', choice]]) };
  const scene = {
    accept: false, contextLost: false, prepared: new Map(),
    isReady(id) { return this.prepared.has(id); },
    prepare(v) {
      if (!this.accept) return Promise.reject(Object.assign(new Error('No room for terrain'), { reason: 'budget' }));
      const prepared = { view: v };
      this.prepared.set(v.id, prepared);
      return Promise.resolve(prepared);
    },
  };
  const p = new RangePresentation({ mode: 'v2', shots: false, catalog: { views: [fallback] } });
  p.setSong({ terrain, generation: 1 });
  p.scene = scene;
  p.runtimeState = 'ready';
  return { p, scene, terrain, view, fallback };
}

async function attempt(p, view) {
  p._prepare(view, p.deferred.get(view.id) ?? Date.now());
  await new Promise(resolve => setTimeout(resolve, 0));
}

function frameInputs() {
  return {
    sim: { songSeed: 1, perf: { level: 0 }, biomes: {
      currentBlend: { from: 'CONIFER', to: 'CONIFER', t: 1 }, sections: [{ profile: { name: 'CONIFER' } }],
      tSec: 1, durationMs: 1000, _profile: () => null, groundField: null, energyCurves: null, world: {},
    } },
    pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
    scenicViewport: { logicalWidth: 1408, logicalHeight: 848, backingWidth: 1408, backingHeight: 848 },
    groundViewport: { logicalWidth: 1408, logicalHeight: 848 },
  };
}

test('a ready signature denied its render target three times releases selection and pins to the catalog fallback', async () => {
  const { p, scene, view, fallback } = fixture();
  scene.accept = true;
  await attempt(p, view);
  let pinned = [];
  scene.pinView = ids => { pinned = [].concat(ids); };
  scene.resize = () => { throw Object.assign(new Error('No render target room'), { reason: 'budget' }); };
  let availabilityChanges = 0;
  p.onAvailabilityChange = () => { availabilityChanges++; };
  for (let i = 0; i < 3; i++) {
    p.setFrameInputs(frameInputs());
    assert.equal(p.beginScenic(), false);
  }
  assert.equal(p.captionViewFor('CONIFER'), fallback, 'a resident stage must not block its cheaper fallback forever');
  assert.match(p.failures.get(view.id), /^budget:/);
  assert.equal(availabilityChanges, 1);
  p.setFrameInputs(frameInputs());
  p.beginScenic();
  assert.equal(p._wants[0].id, fallback.id);
  assert.deepEqual(pinned, [fallback.id], 'the next attempt unpins the failed stage so its memory is evictable');
});

test('a successful signature scenic frame resets temporary render-target budget pressure', async () => {
  const { p, scene, view } = fixture();
  scene.accept = true;
  await attempt(p, view);
  let refuses = true;
  scene.resize = () => {
    if (refuses) throw Object.assign(new Error('No render target room'), { reason: 'budget' });
  };
  const begin = () => { p.setFrameInputs(frameInputs()); return p.beginScenic(); };
  assert.equal(begin(), false);
  assert.equal(begin(), false);
  refuses = false;
  assert.equal(begin(), true);
  refuses = true;
  assert.equal(begin(), false);
  assert.equal(begin(), false);
  assert.equal(p.failures.has(view.id), false, 'a recovered frame starts a fresh refusal allowance');
  refuses = false;
  assert.equal(begin(), true);
});

test('ordinary ready views keep their render-target retry behavior after repeated budget refusals', async () => {
  const { p, scene, view } = fixture(false);
  scene.accept = true;
  await attempt(p, view);
  scene.resize = () => { throw Object.assign(new Error('No render target room'), { reason: 'budget' }); };
  for (let i = 0; i < 5; i++) {
    p.setFrameInputs(frameInputs());
    assert.equal(p.beginScenic(), false);
  }
  assert.equal(p.failures.has(view.id), false);
  assert.equal(p.captionViewFor('CONIFER'), view);
});

test('three signature budget refusals hand the view to its catalog fallback', async () => {
  const { p, view, fallback } = fixture();
  let availabilityChanges = 0;
  p.onAvailabilityChange = () => { availabilityChanges++; };
  await attempt(p, view);
  await attempt(p, view);
  assert.equal(p.captionViewFor('CONIFER'), view, 'temporary pressure still retries the signature');
  await attempt(p, view);
  assert.match(p.failures.get(view.id), /^budget:/);
  assert.equal(p.deferred.has(view.id), false, 'the failed signature has no further budget retry');
  assert.equal(p._preparing.has(view.id), false, 'preparation ownership retires after the rejection');
  assert.equal(p.captionViewFor('CONIFER'), fallback);
  assert.equal(p._viewForOccurrence({ viewId: view.id }), fallback);
  assert.equal(availabilityChanges, 1);
  await attempt(p, view);
  assert.equal(availabilityChanges, 1, 'the failed generation cannot start another retry loop');
});

test('temporary signature budget pressure recovers and successful preparation resets its refusal count', async () => {
  const { p, scene, view } = fixture();
  await attempt(p, view);
  await attempt(p, view);
  scene.accept = true;
  await attempt(p, view);
  assert.equal(scene.isReady(view.id), true);
  assert.equal(p.failures.has(view.id), false);
  scene.prepared.delete(view.id);
  scene.accept = false;
  await attempt(p, view);
  await attempt(p, view);
  assert.equal(p.failures.has(view.id), false, 'two new refusals do not inherit the pressure before success');
  scene.accept = true;
  await attempt(p, view);
  assert.equal(scene.isReady(view.id), true);
});

test('a new generation receives its own bounded signature budget attempts', async () => {
  const { p, view, terrain } = fixture();
  await attempt(p, view);
  await attempt(p, view);
  p.setSong({ terrain, generation: 2 });
  await attempt(p, view);
  await attempt(p, view);
  assert.equal(p.failures.has(view.id), false);
  await attempt(p, view);
  assert.match(p.failures.get(view.id), /^budget:/);
});

test('ordinary views keep retrying budget refusals and recover when room becomes available', async () => {
  const { p, scene, view } = fixture(false);
  for (let i = 0; i < 5; i++) await attempt(p, view);
  assert.equal(p.failures.has(view.id), false);
  assert.equal(p.deferred.has(view.id), true);
  assert.equal(p.captionViewFor('CONIFER'), view);
  scene.accept = true;
  await attempt(p, view);
  assert.equal(scene.isReady(view.id), true);
  assert.equal(p.deferred.has(view.id), false);
});
