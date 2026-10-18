// Range v2 Task 8: the presentation boundary. Pass order inside the Range's
// draw, one terrain owner per pass, and explicit legacy fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { RangePresentation, resolveRangeMode } from '../src/world/alpine/RangePresentation.js';

/** A 2D context that accepts every call and records nothing. */
function anyCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const handler = {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, transformPoint: (p) => p });
      if (/^create(Linear|Radial|Conic)Gradient$/.test(key)) return () => grad;
      if (key === 'createPattern') return () => ({ setTransform: noop });
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key === 'canvas') return { width: 1408, height: 848 };
      return noop;
    },
    set(target, key, value) { target[key] = value; return true; },
  };
  return new Proxy({}, handler);
}

function manager() {
  const m = new BiomeManager({
    conductor: { barGrid: [], onBar: () => () => {}, on: () => () => {} },
    durationMs: 60000, canvasWidth: 1280, canvasHeight: 720, groundY: 625, songSeed: 3, worldId: 'range',
  });
  const calls = [];
  const rec = (name) => function () { calls.push(name); };
  for (const name of ['_drawSky', '_drawSpectrumMassif', '_drawHorizonEQ', '_drawCrestLight', '_drawFarVignettes', '_drawMidDepthLife',
    '_drawGround', '_drawTerrainFooting', '_drawFlood', '_drawForegroundSwell', '_drawTransitionOverlays',
    '_drawFarShore', '_drawOcean', '_drawOceanLife', '_drawFataMorgana', 'drawDeepSky', '_drawCelestial', '_drawMoon']) {
    m[name] = rec(name);
  }
  const legacy = m._drawLegacyScenic;
  m._drawLegacyScenic = function (...args) { calls.push('_drawLegacyScenic'); void legacy; return '#334455'; };
  m.spaceRidge.drawAurora = rec('spaceRidge');
  m.stripsFor = () => ({});
  return { m, calls };
}

function fakePresentation({ ready = true } = {}) {
  const passes = [];
  return {
    passes,
    enabled: true,
    beginScenic() { return ready; },
    drawPartition(ctx, pass) { passes.push(pass); return true; },
  };
}

const groundView = { stage: { width: 1408, height: 848 }, apply() {} };

test('v2 draws its partitions at the retained pass boundaries, legacy scenery not at all', () => {
  const { m, calls } = manager();
  const pres = fakePresentation();
  m.rangePresentation = pres;
  const order = [];
  pres.drawPartition = (ctx, pass) => { order.push(`gpu:${pass}`); calls.push(`gpu:${pass}`); return true; };
  m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
  const seq = calls.filter((c) => /gpu:|_draw(HorizonEQ|CrestLight|SpectrumMassif|FarVignettes|MidDepthLife|Ground|LegacyScenic)|spaceRidge|_drawSky/.test(c));
  assert.deepEqual(seq, ['_drawSky', 'spaceRidge', '_drawSpectrumMassif', 'gpu:far', '_drawCrestLight', '_drawFarVignettes',
    'gpu:mid', '_drawMidDepthLife', 'gpu:near']);
  assert.ok(!calls.includes('_drawLegacyScenic'), 'no double-painted terrain');
  assert.equal(calls.filter((c) => c === '_drawCrestLight').length, 1, 'the Dancing Ridge lights the far range exactly once');
  assert.ok(!calls.includes('_drawHorizonEQ'), 'its drawn line belongs to the legacy stack only');
  assert.equal(m._rangeV2Active, true);
  m.dispose();
});

test('when v2 is not ready the legacy stack draws, with the ridge in its original place', () => {
  const { m, calls } = manager();
  m.rangePresentation = fakePresentation({ ready: false });
  m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
  const seq = calls.filter((c) => /gpu:|_draw(HorizonEQ|SpectrumMassif|LegacyScenic|Ground)/.test(c));
  assert.deepEqual(seq, ['_drawHorizonEQ', '_drawSpectrumMassif', '_drawLegacyScenic']);
  assert.equal(m._rangeV2Active, false);
  m.dispose();
});

test('ordinary v2 ocean remains behind every terrain partition without needing a hazard', () => {
  const { m, calls } = manager();
  m._activeWithdrawal = () => 0;
  m._activeTsunami = () => null;
  const pres = fakePresentation();
  m.rangePresentation = pres;
  pres.drawPartition = (ctx, pass) => { calls.push(`gpu:${pass}`); return true; };
  m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
  assert.equal(calls.filter((c) => c === '_drawOcean').length, 1);
  for (const pass of ['far', 'mid', 'near']) {
    assert.ok(calls.indexOf('_drawOcean') < calls.indexOf(`gpu:${pass}`), `${pass} terrain occludes sea`);
  }
  assert.ok(!calls.includes('_drawOceanLife'), 'inland scene keeps legacy sea fauna off');
  m.dispose();
});

test('an inland catalog view drops the legacy sea strip; an explicit sea horizon keeps it behind the terrain', () => {
  for (const [view, drawn] of [[{ id: 'teton-jackson-lake' }, false], [{ id: 'coast', seaHorizon: true }, true]]) {
    const { m, calls } = manager();
    m._activeWithdrawal = () => 0;
    m._activeTsunami = () => null;
    const pres = fakePresentation();
    pres.captionViewFor = () => view;
    m.rangePresentation = pres;
    pres.drawPartition = (ctx, pass) => { calls.push(`gpu:${pass}`); return true; };
    m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
    assert.equal(calls.includes('_drawOcean'), drawn, view.id);
    if (drawn) for (const pass of ['far', 'mid', 'near']) assert.ok(calls.indexOf('_drawOcean') < calls.indexOf(`gpu:${pass}`));
    m.dispose();
  }
});

test('glacial inland pilot suppresses distant sea throughout a biome handoff', () => {
  const { m, calls } = manager();
  m.rangePresentation = fakePresentation();
  m.rangePresentation.captionViewFor = (name) => name === 'CONIFER' ? { glacier: {} } : {};
  for (const t of [0, .5, 1]) {
    m.currentBlend = { from: 'RAINFOREST', to: 'CONIFER', t };
    calls.length = 0;
    m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
    assert.ok(!calls.includes('_drawOcean'), 'inland pilot has its own river/lake receivers');
  }
  m.dispose();
});

test('mode resolution: v2 by default, explicit legacy opt-out and view/diagnostic flags', () => {
  assert.deepEqual(resolveRangeMode(''), { mode: 'v2', forcedViewId: null, diag: null, tour: null });
  assert.deepEqual(resolveRangeMode('?rangeRenderer=legacy'), { mode: 'legacy', forcedViewId: null, diag: null, tour: null });
  assert.equal(resolveRangeMode('?rangeRenderer=LEGACY').mode, 'legacy');
  assert.deepEqual(resolveRangeMode('?rangeRenderer=v2'), { mode: 'v2', forcedViewId: null, diag: null, tour: null });
  assert.deepEqual(resolveRangeMode('?rangeRenderer=V2&rangeView=nc-ross-lake-north&rangeDiag=markers'),
    { mode: 'v2', forcedViewId: 'nc-ross-lake-north', diag: 'markers', tour: null });
  assert.equal(resolveRangeMode('?rangeRenderer=webgl').mode, 'v2', 'unknown values take the default');
  assert.equal(resolveRangeMode('?renderer=webgl').mode, 'v2', 'the old overlay flag does not change the Range renderer');
});

const catalog = { catalogVersion: 1, views: [{
  id: 'v', regionId: 'r', biome: 'RAINFOREST', status: 'candidate', catalogVersion: 1,
  terrainManifestUrl: 'terrain/v.terrain.json', materialManifestUrl: 'materials/m.json',
  camera: { eyeStartM: [0, 1500, 0], eyeEndM: [10, 1500, 0], targetStartM: [0, 700, -9000], targetEndM: [10, 700, -9000], fovYDeg: 35 },
  characterScores: { energy: .5, rawness: .5, grandeur: .5, dominance: .5 }, evidence: { reviewPath: 'x' },
}] };

function presentationWith(scene, extra = {}) {
  return new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => scene, ...extra });
}
function fakeScene({ fail = null, reason = 'http' } = {}) {
  const prepared = new Set();
  return {
    prepared: new Map(), contextLost: false,
    isReady: (id) => prepared.has(id),
    prepare: (view) => (fail ? Promise.reject(Object.assign(new Error(fail), { reason })) : (prepared.add(view.id), Promise.resolve({}))),
    resize() {}, release() {}, snapshot: () => ({}),
    renderPartition: () => ({ width: 2, height: 2 }),
  };
}
const inputs = (biome = 'RAINFOREST') => ({
  sim: { songSeed: 1, perf: { level: 0 }, biomes: {
    currentBlend: { from: biome, to: biome, t: 1 }, sections: [{ profile: { name: biome } }], tSec: 1, durationMs: 1000,
    _profile: () => null, groundField: null, energyCurves: null, world: {},
  } },
  pose: { worldX: 0, midioX: 0, midioDrawX: 0, midioY: 0 },
  scenicViewport: { logicalWidth: 1408, logicalHeight: 848, backingWidth: 1408, backingHeight: 848 },
  groundViewport: { logicalWidth: 1408, logicalHeight: 848 },
});

test('an assigned view that is still preparing keeps the frame on legacy, then switches', async () => {
  const p = presentationWith(fakeScene());
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0], fallbackReason: null }]]) }, generation: 1 });
  p.setFrameInputs(inputs());
  assert.equal(p.beginScenic(), false);
  await p.whenReady();
  p.setFrameInputs(inputs());
  assert.equal(p.beginScenic(), true);
  assert.equal(p.snapshot().viewId, 'v');
  assert.equal(p.snapshot().forcedCandidate, false);
});

test('presentation carries each pixel-scale selection to the shared scene', async () => {
  const scene = fakeScene(), requests = [];
  scene.resize = request => requests.push(request);
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p.whenReady();
  p.pixelated = true;
  for (const pixelScale of ['depth', 'original', 'depth']) {
    p.pixelPolicy = { active: true, pixelScale };
    p.setFrameInputs(inputs());
    assert.equal(p.beginScenic(), true);
    assert.equal(requests.at(-1).pixelScale, pixelScale);
    assert.equal(requests.at(-1).pixelated, true);
  }
  p.pixelPolicy = null;
  p.setFrameInputs(inputs()); p.beginScenic();
  assert.equal(requests.at(-1).pixelScale, 'original', 'unconfigured callers keep the original rendering');
});

test('a failed asset takes the legacy path with a recorded reason and no retry storm', async () => {
  const scene = fakeScene({ fail: 'invalid manifest', reason: 'manifest' });
  let tries = 0;
  const prepare = scene.prepare;
  scene.prepare = (...a) => { tries++; return prepare(...a); };
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0], fallbackReason: null }]]) }, generation: 1 });
  await p.whenReady();
  for (let i = 0; i < 5; i++) { p.setFrameInputs(inputs()); assert.equal(p.beginScenic(), false); }
  assert.match(p.snapshot().reason, /manifest/);
  assert.equal(tries, 1);
});

test('no WebGL2: the runtime fails once and legacy continues', async () => {
  const p = new RangePresentation({ mode: 'v2', catalog, sceneFactory: async () => { throw new Error('WebGL2 unavailable'); } });
  p.setFrameInputs(inputs());
  p.beginScenic();
  await p.whenReady();
  p.setFrameInputs(inputs());
  assert.equal(p.beginScenic(), false);
  assert.match(p.snapshot().reason, /WebGL2 unavailable/);
  assert.equal(p.snapshot().runtime, 'failed');
});

test('a failed renderer download is retried with a fresh module URL, and Three.js is fetched once', async () => {
  const runtimeCalls = [], sceneCalls = [];
  class RangeScene { constructor() { Object.assign(this, fakeScene()); } }
  const p = new RangePresentation({
    mode: 'v2', catalog, retryDelaysMs: [0, 0],
    loadRuntime: async (attempt) => { runtimeCalls.push(attempt); return {}; },
    loadScene: async (attempt) => {
      sceneCalls.push(attempt);
      if (attempt < 2) throw new TypeError('Failed to fetch dynamically imported module: RangeScene.js');
      return { RangeScene };
    },
  });
  await p.whenReady();
  assert.equal(p.snapshot().runtime, 'ready');
  assert.deepEqual(sceneCalls, [0, 1, 2]);
  assert.deepEqual(runtimeCalls, [0]);
  assert.equal(p.snapshot().runtimeAttempts, 3);
});

test('a download that fails every attempt is tried again by live playback after the cooldown', async () => {
  let online = false, changed = 0;
  class RangeScene { constructor() { Object.assign(this, fakeScene()); } }
  const p = new RangePresentation({
    mode: 'v2', catalog, retryDelaysMs: [0], cooldownMs: 0,
    loadRuntime: async () => ({}),
    loadScene: async () => { if (!online) throw new TypeError('Failed to fetch dynamically imported module'); return { RangeScene }; },
  });
  p.onAvailabilityChange = () => { changed++; };
  await p.whenReady();
  assert.equal(p.snapshot().runtime, 'failed');
  assert.match(p.snapshot().reason, /runtime-unavailable: Failed to fetch/);
  assert.equal(changed, 1);
  online = true;
  p.setFrameInputs(inputs());
  p.beginScenic();
  await p.whenReady();
  assert.equal(p.snapshot().runtime, 'ready');
  assert.equal(changed, 2, 'captions refresh once the renderer arrives');
});

test('a renderer that downloads but cannot start is not retried', async () => {
  let built = 0;
  class RangeScene { constructor() { built++; throw new Error('WebGL2 unavailable'); } }
  const p = new RangePresentation({ mode: 'v2', catalog, retryDelaysMs: [0], cooldownMs: 0, loadRuntime: async () => ({}), loadScene: async () => ({ RangeScene }) });
  await p.whenReady();
  for (let i = 0; i < 3; i++) { p.setFrameInputs(inputs()); assert.equal(p.beginScenic(), false); }
  await p.whenReady();
  assert.equal(built, 1);
  assert.equal(p.snapshot().runtime, 'failed');
});

test('a biome without an approved view stays legacy with its fallback reason', async () => {
  const p = presentationWith(fakeScene());
  p.setSong({ terrain: { sceneByBiome: new Map([['DESERT', { view: null, fallbackReason: 'no-view-for-biome' }]]) }, generation: 1 });
  await p.whenReady();
  p.setFrameInputs(inputs('DESERT'));
  assert.equal(p.beginScenic(), false);
  assert.equal(p.snapshot().reason, 'no-view-for-biome');
});

test('a forced candidate is drawn and labelled; legacy mode never starts a GPU context', async () => {
  const forced = presentationWith(fakeScene(), { forcedViewId: 'v' });
  forced.setSong({ terrain: null, generation: 1 });
  await forced.whenReady();
  forced.setFrameInputs(inputs('DESERT'));
  assert.equal(forced.beginScenic(), true);
  assert.equal(forced.snapshot().forcedCandidate, true);
  let built = false;
  const legacy = new RangePresentation({ mode: 'legacy', catalog, sceneFactory: async () => { built = true; } });
  legacy.setFrameInputs(inputs());
  assert.equal(legacy.beginScenic(), false);
  await legacy.whenReady();
  assert.equal(built, false);
});

test('blending toward a biome with no view fades the outgoing view out over legacy; arriving there draws legacy', async () => {
  const p = presentationWith(fakeScene());
  p.setSong({ terrain: { sceneByBiome: new Map([
    ['RAINFOREST', { view: catalog.views[0], fallbackReason: null }],
    ['DESERT', { view: null, fallbackReason: 'no-view-for-biome' }],
  ]) }, generation: 1 });
  await p.whenReady();
  const at = (t) => {
    const i = inputs();
    i.sim.biomes.currentBlend = { from: 'RAINFOREST', to: 'DESERT', t };
    p.setFrameInputs(i);
    return p.beginScenic();
  };
  assert.equal(at(0), true, 'before the blend starts the outgoing view draws');
  assert.equal(p.arrival, 1);
  // Not a one-frame cut: the outgoing view keeps drawing, fading out over
  // the legacy stack as the blend proceeds.
  assert.equal(at(0.25), true);
  const early = p.arrival;
  assert.equal(p.snapshot().viewId, catalog.views[0].id);
  assert.ok(p.arriving, 'legacy scenery draws underneath');
  assert.equal(at(0.75), true);
  assert.ok(p.arrival < early && early < 1, `fades out: ${early} -> ${p.arrival}`);
  assert.equal(at(1), false);
  assert.equal(p.snapshot().reason, 'no-view-for-biome');
});

test('a view that fails to prepare asks for the captions to be rebuilt', async () => {
  const p = presentationWith(fakeScene({ fail: 'invalid manifest', reason: 'manifest' }));
  let refreshed = 0;
  p.onAvailabilityChange = () => { refreshed++; };
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0], fallbackReason: null }]]) }, generation: 1 });
  await p.whenReady();
  assert.equal(refreshed, 1);
  assert.equal(p.captionViewFor('RAINFOREST'), null, 'the failed view is no longer named');
});

// Budget: a song's views compete for one residency budget.
const views4 = ['RAINFOREST', 'CONIFER', 'TUNDRA', 'TAIGA'].map((biome, i) => ({ ...catalog.views[0], id: `v${i}`, biome }));
const song4 = () => ({ sceneByBiome: new Map(views4.map((v) => [v.biome, { view: v, fallbackReason: null }])) });
/** A scene with room for `cap` views (prepared or still preparing). */
function budgetScene(cap) {
  const prepared = new Set(), jobs = new Map(), calls = [];
  const s = {
    cap, calls, prepared: new Map(), contextLost: false,
    isReady: (id) => prepared.has(id),
    prepare(view) {
      calls.push(view.id);
      if (jobs.has(view.id)) return jobs.get(view.id);
      if (prepared.size + jobs.size >= s.cap) return Promise.reject(Object.assign(new Error(`no GPU room for ${view.id}`), { reason: 'budget' }));
      const job = new Promise((r) => setTimeout(() => { jobs.delete(view.id); prepared.add(view.id); r({}); }, 5));
      jobs.set(view.id, job);
      return job;
    },
    evict(id) { prepared.delete(id); },
    pinView() {}, resize() {}, release() {}, snapshot: () => ({}), renderPartition: () => ({ width: 2, height: 2 }),
  };
  return s;
}

test('whenReady prepares views in song order and stops at the first that does not fit', async () => {
  const scene = budgetScene(2);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  p.setSong({ terrain: song4(), generation: 1 });
  await p.whenReady();
  assert.ok(scene.isReady('v0') && scene.isReady('v1'), 'the opening views are prepared');
  assert.ok(!scene.isReady('v2') && !scene.isReady('v3'));
  assert.deepEqual(scene.calls, ['v0', 'v1', 'v2'], 'one at a time, in song order; v3 is left for later');
  // A refusal is not a failure: the biome is still v2's (no legacy strips).
  assert.deepEqual(p.snapshot().failures, {});
  assert.ok(p.coversBiome('TUNDRA'));
});

test('a budget refusal is retried once room is freed, never dropped to legacy for the song', async () => {
  const scene = budgetScene(0);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  p.setSong({ terrain: song4(), generation: 1 });
  await p._ensureRuntime();
  p.setFrameInputs(inputs('RAINFOREST'));
  assert.equal(p.beginScenic(), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(p.snapshot().deferred, ['v0']);
  // Within the retry interval the view is not asked for again every frame.
  p.setFrameInputs(inputs('RAINFOREST'));
  p.beginScenic();
  assert.equal(scene.calls.length, 1);
  // Room appears (views no longer on screen were evicted); after the
  // interval the next frame asks again and the view arrives.
  scene.cap = 1;
  p._prepare(views4[0], Date.now() + 2000);
  await new Promise((r) => setTimeout(r, 20));
  p.setFrameInputs(inputs('RAINFOREST'));
  assert.equal(p.beginScenic(), true);
  assert.equal(p.snapshot().viewId, 'v0');
});

test('export: settle waits for the view a frame lacked and asks for the same instant again', async () => {
  const scene = budgetScene(1);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  p.setSong({ terrain: song4(), generation: 1, exportMode: true });
  await p.whenReady();
  assert.ok(scene.isReady('v0'));
  // The song reaches CONIFER: its view is not prepared and there is no room
  // until the previous view is evicted (the ledger does that once it is no
  // longer pinned).
  p.setFrameInputs(inputs('CONIFER'));
  assert.equal(p.beginScenic(), false);
  scene.evict('v0');
  assert.equal(await p.settle(), true, 'it waited: the caller redraws the frame');
  p.setFrameInputs(inputs('CONIFER'));
  assert.equal(p.beginScenic(), true);
  assert.equal(p.snapshot().viewId, 'v1');
  assert.equal(await p.settle(), false, 'nothing lacking: no redraw');
});

/** budgetScene whose reservations evict the oldest unpinned view (as the
 *  residency ledger does) before refusing. */
function evictingScene(cap) {
  const s = budgetScene(cap);
  const order = [];
  let pinned = new Set();
  const base = s.prepare;
  s.pinView = (ids) => { pinned = new Set([].concat(ids)); };
  s.ensureSide = () => true;
  s.prepare = (view) => {
    if (!s.isReady(view.id)) {
      const victim = order.find((id) => s.isReady(id) && !pinned.has(id));
      if (victim && order.filter((id) => s.isReady(id)).length >= s.cap) { s.evict(victim); order.splice(order.indexOf(victim), 1); }
    }
    const job = base(view);
    job.then(() => { if (!order.includes(view.id)) order.push(view.id); }, () => {});
    return job;
  };
  return s;
}

test('a completed section releases the old view before admitting its replacement under a one-view budget', async () => {
  const scene = evictingScene(1);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  p.setSong({ terrain: song4(), generation: 1 });
  await p.whenReady();
  p.setFrameInputs(inputs('RAINFOREST'));
  assert.equal(p.beginScenic(), true);
  p.deferred.set('v1', 0); // The prefetch refusal's cooldown has elapsed.
  p.setFrameInputs(inputs('CONIFER'));
  p.beginScenic();
  await new Promise(resolve => setTimeout(resolve, 20));
  p.setFrameInputs(inputs('CONIFER'));
  assert.equal(p.beginScenic(), true, 'the previous section must not remain pinned while its replacement waits');
  assert.equal(p.snapshot().viewId, 'v1');
  assert.equal(p.deferred.size, 0);
});

test('export: settling a travel keeps the side already prepared while the other is built', async () => {
  const scene = evictingScene(2);
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => anyCtx() });
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 }, makeCanvas });
  p.setSong({ terrain: song4(), generation: 1, exportMode: true });
  await p.whenReady(); // v0 then v1 prepared, in song order
  assert.ok(scene.isReady('v0') && scene.isReady('v1'));
  // A travel from TUNDRA (v2, not prepared) to RAINFOREST (v0, prepared).
  const travel = inputs('TUNDRA');
  travel.sim.biomes.currentBlend = { from: 'TUNDRA', to: 'RAINFOREST', t: 0.5 };
  p.setFrameInputs(travel);
  p.beginScenic();
  assert.equal(await p.settle(), true);
  assert.ok(scene.isReady('v2') && scene.isReady('v0'), 'the unrelated v1 was evicted, not the incoming v0');
  p.setFrameInputs(travel);
  assert.equal(p.beginScenic(), true);
  assert.equal(p.snapshot().incomingViewId, 'v0');
});

test('export: settle waits for a view still being built even after earlier refusals', async () => {
  const scene = budgetScene(0);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  p.setSong({ terrain: song4(), generation: 1, exportMode: true });
  await p._ensureRuntime();
  p.setFrameInputs(inputs('RAINFOREST'));
  p.beginScenic();
  // Refused twice, then room appears while settle retries.
  let refusals = 0;
  const prepare = scene.prepare;
  scene.prepare = (v) => { if (++refusals === 3) scene.cap = 1; return prepare(v); };
  assert.equal(await p.settle({ attempts: 3 }), true);
  assert.ok(scene.isReady('v0'), 'the attempt that got room was waited for');
});

test('a budget refusal asks the owner to free fallback scenery; only covered biomes lose their strips', async () => {
  const scene = budgetScene(0);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  const asked = [];
  p.onBudgetRefusal = (id) => asked.push(id);
  p.setSong({ terrain: song4(), generation: 1 });
  await p._ensureRuntime();
  p.setFrameInputs(inputs('RAINFOREST'));
  p.beginScenic();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked, ['v0']);
  // The owner's side: BiomeManager drops the strip sets v2 covers (a legacy
  // frame re-bakes on demand) and keeps the rest.
  const { m } = manager();
  const kept = [];
  m.strips = { entries: new Map([['RAINFOREST', {}], ['DESERT', {}]]), delete(k) { this.entries.delete(k); } };
  m.rangePresentation = { coversBiome: (b) => b === 'RAINFOREST' };
  assert.equal(m.dropCoveredStrips(), 1);
  kept.push(...m.strips.entries.keys());
  assert.deepEqual(kept, ['DESERT']);
});

test('settle does not wait while the GPU context is lost', async () => {
  const scene = budgetScene(0);
  const p = presentationWith(scene, { catalog: { ...catalog, views: views4 } });
  p.setSong({ terrain: song4(), generation: 1, exportMode: true });
  await p._ensureRuntime();
  p.setFrameInputs(inputs('RAINFOREST'));
  p.beginScenic();
  scene.contextLost = true;
  const t0 = Date.now();
  assert.equal(await p.settle({ timeoutMs: 5000 }), false);
  assert.ok(Date.now() - t0 < 200, 'returned at once');
});

test('frame timings sum every pass of a frame and restart with the next frame', async () => {
  const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } };
  const scene = fakeScene();
  scene.renderPartition = () => { spin(3); return { width: 2, height: 2 }; };
  scene.renderGround = () => { throw new Error('the removed ground pass cannot contribute frame time'); };
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0], fallbackReason: null }]]) }, generation: 1 });
  await p.whenReady();
  const ctx = { save() {}, restore() {}, drawImage() {} };
  const stage = { width: 2, height: 2 };
  const frame = () => {
    p.setFrameInputs(inputs());
    assert.equal(p.beginScenic(), true);
    const measured = [];
    for (const pass of ['far', 'mid', 'near']) {
      assert.equal(p.drawPartition(ctx, pass, stage), true);
      measured.push(p.timings.lastPartitionMs);
    }
    assert.equal(p.drawGround(ctx, stage), true);
    assert.equal(p.timings.frameRenderMs, measured.reduce((sum, ms) => sum + ms, 0), 'totals contain only this frame\'s measured passes');
    return { ...p.timings };
  };
  const a = frame();
  assert.ok(a.frameRenderMs >= 9, `three 3 ms terrain passes summed, got ${a.frameRenderMs}`);
  assert.ok(a.lastPartitionMs < a.frameRenderMs, 'the last pass alone is not the frame');
  const b = frame();
  assert.equal(b.frameId, a.frameId + 1);
});

test('a view built across a context loss is retried, not failed; a refused render target asks for room', async () => {
  const scene = fakeScene();
  let tries = 0;
  scene.prepare = () => { tries++; return Promise.reject(Object.assign(new Error('context changed'), { reason: 'context-lost' })); };
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0], fallbackReason: null }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 50 });
  assert.equal(p.failures.has('v'), false, 'a context change is not the view failing');
  // A playing frame asks again; the refusal defers the next try.
  p.setFrameInputs(inputs());
  assert.equal(p.beginScenic(), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.failures.has('v'), false);
  assert.ok(p.deferred.has('v'), 'retried after a short delay');
  assert.ok(tries >= 1);

  const s2 = fakeScene();
  s2.resize = () => { throw new Error('no room for the render target'); };
  const q = presentationWith(s2);
  let refusals = 0;
  q.onBudgetRefusal = () => { refusals++; };
  q.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0], fallbackReason: null }]]) }, generation: 1 });
  await q.whenReady();
  q.setFrameInputs(inputs());
  assert.equal(q.beginScenic(), false);
  assert.match(q.snapshot().reason, /budget/);
  assert.equal(refusals, 1);
});

test('migrated no-stage final manager path suppresses opaque foreground painters even during arrival', () => {
  for (const arriving of [false, true]) for (const groundAvailable of [false, true]) {
    const { m, calls } = manager();
    m.groundField = { visibleBars: () => [{ x: 0, width: 1408, y: 500 }] };
    m._groundReceivers = { wetMasks: ['stale'] };
    m._lakeReflectGroundY = 500;
    m.rangePresentation = { ...fakePresentation(), arriving, hasViewComposition: true,
      stage: null, drawGround: () => groundAvailable, groundReceivers: () => null };
    m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
    for (const painter of ['_drawGround', '_drawTerrainFooting', '_drawFlood', '_drawForegroundSwell']) {
      assert.ok(!calls.includes(painter), `${painter} cannot cover revealed terrain`);
    }
    assert.equal(m._groundReceivers, null);
    assert.equal(m._lakeReflectGroundY, null);
    assert.equal(calls.filter(c => c === '_drawTransitionOverlays').length, 1);
    m.dispose();
  }
});

test('Range never paints a foreground ground bar, including fallback and uncomposed views', () => {
  for (const ready of [false, true]) for (const arriving of [false, true]) {
    const { m, calls } = manager();
    m.groundField = { visibleBars: () => [{ x: 0, width: 1408, y: 500 }] };
    m._groundReceivers = { wetMasks: ['stale'] };
    m._lakeReflectGroundY = 500;
    let gpuGroundDraws = 0;
    m.rangePresentation = { ...fakePresentation({ ready }), arriving, hasViewComposition: false,
      drawGround: () => { gpuGroundDraws++; return true; }, groundReceivers: () => null };
    m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
    assert.equal(calls.includes('_drawGround'), false, `legacy ground: ready=${ready}, arriving=${arriving}`);
    assert.equal(calls.includes('_drawTerrainFooting'), false);
    assert.equal(gpuGroundDraws, 0);
    assert.equal(m._groundReceivers, null);
    assert.equal(m._lakeReflectGroundY, null);
    m.dispose();
  }
});

test('a view that composes its own foreground takes neither the veil nor the landmark occluders, fading with its arrival', () => {
  // [owned, arrival, expected legacy presence]
  for (const [owned, arrival, presence] of [[false, 1, 1], [true, 1, 0], [true, .25, .75], [true, 0, 1]]) {
    const { m } = manager();
    m.currentBlend = { from: 'TAIGA', to: 'TAIGA', t: 1 };
    m.calmLevel = 0;
    const ctx = anyCtx();
    const landmarks = [], discs = [];
    m.nearField.draw = (c) => { c.globalAlpha = 1; landmarks.push(ctx.globalAlpha); };
    ctx.ellipse = () => { discs.push(ctx.globalAlpha); };
    m.rangePresentation = { hasViewComposition: owned, arrival };
    m.drawForeground(ctx, { width: 1408, height: 848 }, 0, true);
    assert.deepEqual(landmarks.map(a => +a.toFixed(3)), presence ? [presence] : []);
    assert.deepEqual(discs.map(a => +a.toFixed(3)), presence ? [.1, .1, .1].map(a => +(a * presence).toFixed(3)) : []);
    m.dispose();
  }
});

test('over a Range view the spectrum massif keeps its body but its crest cap fades with the arrival', () => {
  // [owned, arrival, expected cap presence]
  for (const [owned, arrival, presence] of [[false, 1, 1], [true, 1, 0], [true, .4, .6]]) {
    const { m } = manager();
    m.currentBlend = { from: 'TAIGA', to: 'TAIGA', t: 1 };
    const ctx = anyCtx();
    const strokes = [], fills = [];
    ctx.stroke = () => { strokes.push(ctx.globalAlpha); };
    ctx.fill = () => { fills.push(1); };
    m._massifCrest = null;
    m._massifGeometry = () => ({ ridgePts: [{ x: 0, y: 20 }, { x: 50, y: 5 }, { x: 100, y: 20 }], left: 0, massifW: 100, baseY: 40, maxH: 30 });
    m.rangePresentation = { hasViewComposition: owned, arrival };
    const A = m._profile('TAIGA');
    BiomeManager.prototype._drawSpectrumMassif.call(m, ctx, { width: 1408, height: 848 }, 0, A, A, 1);
    assert.equal(fills.length, 1, 'the massif body always draws');
    const full = 0.28 * (0.5 + 0.5 * m.budget);
    assert.deepEqual(strokes.map(a => +a.toFixed(4)), presence ? [+(full * presence).toFixed(4)] : []);
    m.dispose();
  }
});

test('transient HTTP assets retry after backoff and recover in the same song (M6)', async () => {
  const scene = fakeScene(), prepare = scene.prepare;
  let attempts = 0;
  scene.prepare = (...args) => ++attempts === 1
    ? Promise.reject(Object.assign(new Error('Failed to fetch'), { reason: 'http' })) : prepare(...args);
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p.whenReady();
  assert.equal(p.failures.has('v'), false);
  assert.ok(p.deferred.has('v'));
  p._prepare(catalog.views[0], p.deferred.get('v') - 1);
  assert.equal(attempts, 1);
  p._prepare(catalog.views[0], p.deferred.get('v'));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(attempts, 2);
  assert.equal(scene.isReady('v'), true);
});

test('persistent HTTP failures stop after three attempts without a per-frame retry storm', async () => {
  const scene = fakeScene({ fail: 'Failed to fetch' });
  let attempts = 0; const prepare = scene.prepare;
  scene.prepare = (...args) => { attempts++; return prepare(...args); };
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p.whenReady();
  for (let i = 0; i < 5; i++) {
    p._prepare(catalog.views[0], p.deferred.get('v') ?? Date.now() + 600000);
    await new Promise(r => setTimeout(r, 0));
  }
  assert.equal(attempts, 3);
  assert.match(p.failures.get('v'), /http/);
});

test('render-target refusals reclaim once per retry window (M4)', async () => {
  const scene = fakeScene();
  scene.resize = () => { throw Object.assign(new Error('No room'), { reason: 'budget' }); };
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p.whenReady();
  const refusals = [];
  p.onBudgetRefusal = (id, options) => refusals.push({ id, options });
  for (let i = 0; i < 26; i++) { p.setFrameInputs(inputs()); assert.equal(p.beginScenic(), false); }
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].options.preserveVisible, true);
});

test('budget reclamation keeps the visible legacy strips the fallback will draw', () => {
  const { m } = manager();
  m.currentBlend = { from: 'RAINFOREST', to: 'RAINFOREST', t: 1 };
  m.rangePresentation = { coversBiome: () => true };
  m.strips = { entries: new Map([['RAINFOREST', {}], ['DESERT', {}]]), delete(k) { this.entries.delete(k); }, clear() { this.entries.clear(); } };
  assert.equal(m.dropCoveredStrips({ preserveVisible: true }), 1);
  assert.deepEqual([...m.strips.entries.keys()], ['RAINFOREST']);
  m.dispose();
});

test('reduced flashing removes the full-frame cut flash over a composed v2 view (M1)', () => {
  for (const reducedFlash of [false, true]) {
    const { m } = manager(), ctx = anyCtx(), white = [];
    m.rangePresentation = { ...fakePresentation(), hasViewComposition: true, arrival: 1 };
    m._drawTransitionOverlays = BiomeManager.prototype._drawTransitionOverlays;
    m._cutFlash = 1; m.reducedFlash = reducedFlash;
    ctx.fillRect = (x, y, w, h) => { if (ctx.fillStyle === '#ffffff' && w === 1408 && h === 848) white.push(ctx.globalAlpha); };
    m.draw(ctx, { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
    assert.deepEqual(white, reducedFlash ? [] : [.35]);
    m.dispose();
  }
});

test('tour downloads retry only HTTP failures, with a bound and cancellation', async () => {
  const { retryAssetDownload } = await import('../src/world/alpine/RangePresentation.js');
  let attempts = 0;
  assert.equal(await retryAssetDownload(async () => { if (++attempts < 3) throw { reason: 'http' }; return 'loaded'; }, { delaysMs: [0, 0] }), 'loaded');
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(retryAssetDownload(async () => { attempts++; throw new Error('integrity'); }, { delaysMs: [0, 0] }), /integrity/);
  assert.equal(attempts, 1);
  const controller = new AbortController(); attempts = 0;
  const job = retryAssetDownload(async () => { attempts++; throw { reason: 'http' }; }, { signal: controller.signal, delaysMs: [10000] });
  await new Promise(r => setTimeout(r, 0)); controller.abort();
  await assert.rejects(job, /abort/i); assert.equal(attempts, 1);
});

test('one slow failed asset preparation consumes one retry attempt across many frames', async () => {
  const scene = fakeScene();
  let reject; let calls = 0;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  scene.prepare = () => { calls++; return pending; };
  const p = presentationWith(scene); await p._ensureRuntime();
  for (let frame = 0; frame < 60; frame++) p._prepare(catalog.views[0], Date.now());
  reject(Object.assign(new Error('HTTP 503'), { reason: 'http' }));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 1, 'one job, regardless of frame count');
  assert.equal(p.assetFailures.get('v'), 1, 'one failed job consumes one retry');
  assert.equal(p.failures.has('v'), false);
  assert.ok(p.deferred.get('v') > Date.now() + 1500, 'backoff starts at settlement');
});

test('a restored context prepares immediately instead of inheriting a time-based refusal', async () => {
  const scene = fakeScene(), prepare = scene.prepare;
  let calls = 0;
  scene.prepare = (...args) => {
    calls++;
    if (calls === 1) {
      scene.contextLost = true;
      return Promise.reject(Object.assign(new Error('context changed during prepare'), { reason: 'context-lost' }));
    }
    return prepare(...args);
  };
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p.whenReady();
  assert.equal(calls, 1);
  scene.contextLost = false;
  await p.whenReady();
  assert.equal(calls, 2, 'restore starts a fresh preparation without waiting a second');
  p.setFrameInputs(inputs());
  assert.equal(p.beginScenic(), true);
});

test('a known lost context starts no preparations and readiness returns without polling', async () => {
  const scene = fakeScene(); let calls = 0;
  scene.prepare = () => { calls++; return Promise.reject(Object.assign(new Error('context lost'), { reason: 'context-lost' })); };
  scene.contextLost = true;
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p.whenReady({ timeoutMs: 100 });
  p._prepare(catalog.views[0]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 0);
  assert.equal(p.deferred.size, 0, 'context availability is the gate, so no retry deadline is created');
});

test('readiness exits promptly when context is lost during tour planning', async () => {
  const scene = fakeScene(); let calls = 0;
  scene.prepare = () => { calls++; return Promise.resolve(); };
  const { GraphicsResidency } = await import('../src/render/GraphicsResidency.js');
  const residency = new GraphicsResidency(); residency.pin(['old-view']);
  const p = presentationWith(scene, { residency });
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  await p._ensureRuntime();
  p.tourMode = 'tetons';
  p._tourPromise = Promise.resolve().then(() => { scene.contextLost = true; });
  const start = performance.now();
  await p.whenReady({ timeoutMs: 500 });
  assert.ok(performance.now() - start < 200, 'context loss ends the wait instead of consuming its timeout');
  assert.equal(calls, 0);
  assert.deepEqual(residency.snapshot().pinned, []);
});

test('readiness stops polling a pending preparation when the context is lost', async () => {
  const scene = fakeScene(); let complete;
  scene.prepare = () => new Promise(resolve => { complete = resolve; setTimeout(() => { scene.contextLost = true; }, 0); });
  const p = presentationWith(scene);
  p.setSong({ terrain: { sceneByBiome: new Map([['RAINFOREST', { view: catalog.views[0] }]]) }, generation: 1 });
  const start = performance.now();
  try {
    await p.whenReady({ timeoutMs: 500 });
    assert.ok(performance.now() - start < 200, 'a still-pending asset job cannot hold readiness across context loss');
  } finally { complete(); }
});


test('the Range moon is visible during the predawn opening of a long song', async () => {
  const { songSkyClock } = await import('../src/world/DayNight.js');
  const { m, calls } = manager();
  m._dayNightCycleMs = songSkyClock(60000); m.tSec = 3;
  m.rangePresentation = fakePresentation();
  m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
  assert.ok(calls.includes('_drawMoon'), 'a long-song clock must not exclude the moon until the storm clears');
  assert.ok(m.celestialState.moon.altitude01 > 0);
  m.dispose();
});

test('the visible moon keeps its bright limb continuous across the long-song sunrise', async () => {
  const { songSkyClock } = await import('../src/world/DayNight.js');
  const { m } = manager();
  m.durationMs = 180000; m._dayNightCycleMs = songSkyClock(180000);
  m.rangePresentation = fakePresentation();
  const angles = [];
  m._drawMoon = (ctx, canvas, cy, alpha, offset, cx, sunX, sunY, phase, resolved) => {
    angles.push(Math.atan2((sunY - resolved.yFrac) * canvas.height, (sunX - resolved.xFrac) * canvas.width));
  };
  for (const tMs of [23999, 24000]) {
    m.tSec = tMs / 1000;
    m.draw(anyCtx(), { width: 1408, height: 848 }, 0, 0, null, 1, null, groundView);
  }
  assert.equal(angles.length, 2);
  const delta = Math.atan2(Math.sin(angles[1] - angles[0]), Math.cos(angles[1] - angles[0]));
  assert.ok(Math.abs(delta) < .01, 'sunrise cannot instantly rotate the lunar crescent');
  m.dispose();
});
