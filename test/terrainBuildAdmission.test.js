import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { shareTerrainLanes } from '../src/world/alpine/TerrainWindowWorker.js';
import { buildTerrainGeometry } from '../src/world/alpine/TerrainMesh.js';
import { TourWindowCache } from '../src/world/alpine/TerrainWindow.js';

function fixture(budgetBytes = 1e9) {
  const tile = { id: '0', ix: 0, iz: 0, samples: 2, stride: 1, visible: true, band: 'far', minY: 100, maxY: 100,
    heightsM: new Float32Array([100, 100, 100, 100]), flowBytes: new Uint8Array(4), validMask: new Uint8Array([1, 1, 1, 1]) };
  const data = { tiles: new Map([['0', tile]]), byIndex: new Map([['0,0', tile]]), cells: 1, grid: { originM: [0, 0], cellSizeM: 100, width: 2, height: 2 }, manifest: {} };
  const tour = { durationMs: 32000, poseAt: () => ({ eyeM: [50, 200, 500], targetM: [50, 100, 0], fovYDeg: 50 }) };
  const p = { view: { id: 'v', tour }, data, rules: { treelineM: 3000 }, windowIndex: 0, generation: 7,
    uniforms: {}, windowOptions: {}, windowCache: { generation: 0, resident: new Map(), closed: false }, rawAhead: new Map() };
  const scene = Object.assign(Object.create(RangeScene.prototype), { THREE, residency: new GraphicsResidency({ budgetBytes }), prepared: new Map([['v', p]]) });
  return { scene, p, data, tile };
}
function raw(data) {
  return { built: buildTerrainGeometry(data, { strides: new Map([['0', 1]]) }), placed: { meshDetail: new Float32Array(), mesh: new Float32Array(), billboard: new Float32Array(), stride: 8, count: 0 }, plan: {} };
}
test('shared lane conversion denies before replacing the first source backing', async () => {
  const { scene, data, tile } = fixture(1); const original = tile.heightsM;
  await assert.rejects(shareTerrainLanes(data, { residency: scene.residency }), /room|budget/i);
  assert.equal(tile.heightsM, original); assert.equal(scene.residency.usedBytes, 0);
});
test('current and next window builds admit before worker dispatch', async () => {
  const { scene, p } = fixture(1); let builds = 0;
  p.windowWorker = { build: () => { builds++; return Promise.resolve(raw(p.data)); } };
  for (const index of [0, 1, 2, 25]) await assert.rejects(scene._buildTourWindow(p, index), /room|budget/i);
  assert.equal(builds, 0); assert.equal(scene.residency.usedBytes, 0);
});
test('cancelled executing window retains its reservation until returned output is discarded', async () => {
  const { scene, p } = fixture(); let finish;
  p.windowWorker = { build: () => new Promise(resolve => { finish = resolve; }) };
  const job = scene._buildTourWindow(p, 1); const admitted = scene.residency.usedBytes;
  assert.ok(admitted > 0);
  p.windowCache.closed = true; scene.residency.cancelGeneration(p.generation);
  assert.equal(scene.residency.usedBytes, admitted);
  finish(raw(p.data)); await assert.rejects(job, /ended|cancel/i);
  assert.equal(scene.residency.usedBytes, 0);
});
test('window ownership shrinks from build peak to retained buffers and releases on disposal', async () => {
  const { scene, p } = fixture();
  let admitted;
  p.windowWorker = { build: () => { admitted = scene.residency.usedBytes; return Promise.resolve(raw(p.data)); } };
  const window = await scene._buildTourWindow(p, 1);
  assert.ok(admitted > scene.residency.usedBytes);
  assert.equal(scene.residency.snapshot().byOwner['range-tour-window'].count, 1);
  window.dispose(); assert.equal(scene.residency.usedBytes, 0);
});

test('WP02 completed window stays protected across the actual cache Promise adoption boundary', async () => {
  const { scene, p } = fixture();
  p.windowWorker = { build: async () => raw(p.data) };
  p.windowCache = new TourWindowCache({ build: index => scene._buildTourWindow(p, index) });
  p.windowCache.current = 1;
  let resource, pressure;
  const create = scene._tourWindowResource.bind(scene);
  scene._tourWindowResource = (...args) => { resource = create(...args); return resource; };
  const job = p.windowCache.request(1);
  queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
    assert.equal(p.windowCache.resident.has(1), false, 'pressure lands after commit but before adoption');
    assert.equal(scene.residency.entries.get(resource.key)?.state, 'live');
    pressure = scene.residency.reserve({ key: 'pressure', bytes: 1e9 });
  })));
  const result = await job;
  assert.equal(pressure, null);
  assert.equal(scene.residency.has(result.key), true);
  assert.equal(p.windowCache.resident.get(1), result);
  p.windowCache.dispose();
  assert.equal(scene.residency.usedBytes, 0);
});

test('WP02 cache rejects a completed window if its song cancels before adoption', async () => {
  const { scene, p } = fixture();
  p.windowWorker = { build: async () => raw(p.data) };
  p.windowCache = new TourWindowCache({ build: index => scene._buildTourWindow(p, index) });
  p.windowCache.current = 1;
  const job = p.windowCache.request(1);
  queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => scene.residency.cancelGeneration(p.generation))));
  assert.equal(await job, null);
  assert.equal(p.windowCache.resident.size, 0);
  assert.equal(scene.residency.usedBytes, 0);
});

test('ahead prefetch denial uses its own larger plan and never dispatches', () => {
  const { scene, p } = fixture(1); let builds = 0;
  p.activeWindow = { index: 0, key: 'active' };
  p.windowCache.resident.set(0, p.activeWindow);
  p.windowCache.resident.set(1, { index: 1, key: 'next' });
  p.windowCache.prune = () => {};
  p.windowCache.request = () => Promise.resolve();
  p.windowWorker = { build: () => { builds++; return Promise.resolve(raw(p.data)); } };
  p.lastWindowBytes = 0;
  scene._ensureTourWindow(p, 0);
  assert.equal(builds, 0); assert.equal(p.rawAhead.size, 0);
  assert.match(p.windowNote, /room/);
});
test('discarding ahead work keeps executing bytes until output disposal and releases completed output', async () => {
  const { scene, p } = fixture(); let finish;
  p.windowWorker = { build: () => new Promise(resolve => { finish = resolve; }) };
  const entry = scene._requestTourRaw(p, 2); const job = entry.job;
  const bytes = scene.residency.usedBytes;
  scene._dropTourRaw(entry);
  assert.equal(scene.residency.usedBytes, bytes);
  finish(raw(p.data)); await assert.rejects(job, /ended/);
  assert.equal(scene.residency.usedBytes, 0);
  const done = scene._requestTourRaw(p, 2);
  finish(raw(p.data)); await done.job;
  scene._dropTourRaw(done);
  assert.equal(done.job, null); assert.equal(scene.residency.usedBytes, 0);
});
test('a larger tile lattice increases admission independently of previous-window byte counts', () => {
  const { scene, p } = fixture();
  const first = scene._admitTerrainBuild(p, 0);
  scene.residency.releaseReservation(first.reservation);
  p.lastWindowBytes = 1; p.data.grid.cellSizeM = 2000;
  const bigger = scene._admitTerrainBuild(p, 1);
  assert.ok(bigger.bytes > first.bytes);
  scene.residency.releaseReservation(bigger.reservation);
});
test('shared lane conversion preserves aliases and charges a shared backing once', async () => {
  const { scene, data, tile } = fixture();
  const source = new ArrayBuffer(32);
  tile.heightsM = new Float32Array(source, 0, 4); tile.flowBytes = new Uint8Array(source, 16, 4); tile.validMask = new Uint8Array(source, 20, 4);
  tile.heightsM.set([1, 2, 3, 4]); tile.flowBytes.set([5, 6, 7, 8]);
  assert.equal(await shareTerrainLanes(data, { residency: scene.residency }), true);
  assert.equal(tile.heightsM.buffer, tile.flowBytes.buffer);
  assert.equal(tile.flowBytes.buffer, tile.validMask.buffer);
  assert.deepEqual([...tile.heightsM], [1, 2, 3, 4]); assert.deepEqual([...tile.flowBytes], [5, 6, 7, 8]);
  assert.equal(scene.residency.peakBytes, 32); assert.equal(scene.residency.usedBytes, 0);
});

test('WP02 shared-lane conversion stops allocating at its yield when the CPU owner retires', async () => {
  const { scene, data, tile } = fixture();
  data.tiles = new Map(Array.from({ length: 65 }, (_, i) => [String(i), { ...tile,
    heightsM: new Float32Array(4), flowBytes: new Uint8Array(4), validMask: new Uint8Array(4) }]));
  const NativeShared = globalThis.SharedArrayBuffer;
  let allocations = 0, current = true;
  globalThis.SharedArrayBuffer = class extends NativeShared { constructor(bytes) { super(bytes); allocations++; } };
  try {
    const job = shareTerrainLanes(data, { residency: scene.residency, isCurrent: () => current });
    const before = allocations;
    assert.equal(before, 32 * 3, 'fixture reaches the first cooperative yield');
    assert.ok(scene.residency.usedBytes > 0, 'conversion remains charged at the yield');
    current = false;
    await assert.rejects(job, /cancel|retir/i);
    assert.equal(allocations, before);
    assert.equal(scene.residency.usedBytes, 0);
  } finally { globalThis.SharedArrayBuffer = NativeShared; }
});

test('worker errors terminate execution before its jobs reject and release their admission', async () => {
  const { TerrainWindowWorker } = await import('../src/world/alpine/TerrainWindowWorker.js');
  const prior = globalThis.Worker; let terminated = false;
  globalThis.Worker = class { postMessage() {} terminate() { terminated = true; } };
  try {
    const { p } = fixture(); const worker = new TerrainWindowWorker({ data: p.data, tour: p.view.tour, view: p.view, rules: p.rules });
    const job = worker.build(0, {});
    worker.worker.onerror({ message: 'failed worker' });
    await assert.rejects(job, /failed worker/);
    assert.equal(terminated, true);
    await assert.rejects(worker.build(1, {}), /cancel|closed/i);
  } finally { globalThis.Worker = prior; }
});

test('initial prepare refuses forest/worker allocation after CPU admission under pressure', async () => {
  const { bakeTerrain } = await import('../tools/lib/terrain-bake.mjs');
  const { RULE_DEFAULTS } = await import('../src/world/alpine/MaterialPackage.js');
  const width = 65;
  const grid = { width, height: width, cellSizeM: 10, originM: [-320, -320], heightsM: new Float32Array(width * width).fill(1000), valid: new Uint8Array(width * width).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 10, outputSpacingM: 10 };
  const camera = { eyeStartM: [0, 1800, 900], eyeEndM: [100, 1800, 900], targetStartM: [0, 1000, 0], targetEndM: [100, 1000, 0], fovYDeg: 35 };
  const baked = await bakeTerrain(grid, { id: 'admission', camera });
  const originalFetch = globalThis.fetch, OriginalFloat = globalThis.Float32Array, OriginalWorker = globalThis.Worker;
  let chunks = 0, workers = 0;
  globalThis.fetch = async url => new Response(String(url).endsWith('.json') ? JSON.stringify(baked.manifest) : baked.payload);
  globalThis.Float32Array = class extends OriginalFloat { constructor(...args) { super(...args); if (args[0] === 1 << 16) chunks++; } };
  globalThis.Worker = class { constructor() { workers++; } };
  try {
    for (const tour of [null, fixture().p.view.tour]) {
      const scene = Object.assign(Object.create(RangeScene.prototype), { budget: 'desktop', THREE,
        residency: new GraphicsResidency({ budgetBytes: 100 * 1024 ** 2 }), prepared: new Map(), pending: new Map(), contextEpoch: 0 });
      scene._acquireMaterial = async () => {
        // CPU already decoded. Allow sharing and the worker descriptor, but
        // refuse the initial build before Worker construction or FloatChunks.
        scene.residency.budgetBytes = scene.residency.usedBytes + (tour ? 2 * 1024 ** 2 : 1);
        return { key: 'test-material', pack: { manifest: { rules: RULE_DEFAULTS } } };
      };
      scene._releaseMaterial = () => {};
      await assert.rejects(scene.prepare({ id: 'admission', camera, tour, terrainManifestUrl: 'admission.json' }, { baseUrl: 'http://test/', generation: 88 }), e => e.reason === 'budget');
      assert.equal(scene.residency.usedBytes, 0);
    }
    assert.equal(chunks, 0); assert.equal(workers, 0);
  } finally { globalThis.fetch = originalFetch; globalThis.Float32Array = OriginalFloat; globalThis.Worker = OriginalWorker; }
});

for (const mode of ['generation', 'forced CPU', 'signal']) {
  test(`WP01/WP02 initial tour ${mode} cancellation keeps ownership or terminates the worker`, async () => {
    const { bakeTerrain } = await import('../tools/lib/terrain-bake.mjs');
    const { RULE_DEFAULTS } = await import('../src/world/alpine/MaterialPackage.js');
    const width = 65;
    const grid = { width, height: width, cellSizeM: 10, originM: [-320, -320], heightsM: new Float32Array(width * width).fill(1000), valid: new Uint8Array(width * width).fill(1),
      horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 10, outputSpacingM: 10 };
    const camera = { eyeStartM: [0, 1800, 900], eyeEndM: [100, 1800, 900], targetStartM: [0, 1000, 0], targetEndM: [100, 1000, 0], fovYDeg: 35 };
    const baked = await bakeTerrain(grid, { id: 'cancel', camera });
    const originalFetch = globalThis.fetch, OriginalWorker = globalThis.Worker;
    let worker, started;
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async url => new Response(String(url).endsWith('.json') ? JSON.stringify(baked.manifest) : baked.payload);
    globalThis.Worker = class {
      constructor() { worker = this; this.terminated = false; }
      postMessage(message) { if (message.kind === 'init') this.data = message.data; else started(); }
      terminate() { this.terminated = true; }
    };
    const scene = Object.assign(Object.create(RangeScene.prototype), { budget: 'desktop', THREE,
      residency: new GraphicsResidency({ budgetBytes: 1e9 }), prepared: new Map(), pending: new Map(), contextEpoch: 0 });
    scene._acquireMaterial = async () => ({ key: 'test-material', pack: { manifest: { rules: RULE_DEFAULTS } } });
    scene._releaseMaterial = () => {};
    const controller = new AbortController();
    const job = scene.prepare({ id: 'cancel', camera, tour: fixture().p.view.tour, terrainManifestUrl: 'cancel.json' },
      { baseUrl: 'http://test/', generation: 88, signal: controller.signal });
    job.catch(() => {});
    try {
      await ready;
      assert.ok([...worker.data.tiles.values()].every(tile => tile.heightsM.buffer instanceof SharedArrayBuffer));
      if (mode === 'generation') {
        scene.residency.cancelGeneration(88);
        assert.equal(scene.residency.has('range:terrain-cpu:cancel'), true, 'executing shared lanes keep their CPU charge');
        controller.abort();
      } else if (mode === 'forced CPU') scene.residency.release('range:terrain-cpu:cancel');
      else controller.abort();
      assert.equal(worker.terminated, true, 'actual termination precedes ownership cleanup');
      await assert.rejects(job);
      assert.equal(scene.residency.usedBytes, 0);
    } finally {
      worker?.onerror?.({ message: 'fixture cleanup' });
      await job.catch(() => {});
      globalThis.fetch = originalFetch; globalThis.Worker = OriginalWorker;
    }
  });
}

test('scene diagnostic snapshot exposes admitted/requested build totals and peak', () => {
  const { scene, p } = fixture(1);
  Object.assign(scene, { pending: new Map(), sideTargets: {} });
  assert.throws(() => scene._admitTerrainBuild(p, 0), /room/);
  const counters = scene.snapshot().buildAdmission;
  assert.ok(counters.requestedBytes > 0); assert.equal(counters.admittedBytes, 0); assert.equal(counters.denials, 1);
  scene.residency.budgetBytes = 1e9;
  const entry = scene._admitTerrainBuild(p, 0);
  const admitted = scene.snapshot().buildAdmission;
  assert.equal(admitted.admittedBytes, entry.bytes); assert.equal(admitted.peakBytes, entry.bytes);
  scene.residency.releaseReservation(entry.reservation);
});

test('late window disposal cannot release a newer reservation under the same key', async () => {
  const { scene, p } = fixture();
  p.windowWorker = { build: async () => raw(p.data) };
  const window = await scene._buildTourWindow(p, 1);
  scene.residency.release(window.key);
  const fresh = scene.residency.reserve({ key: window.key, bytes: 123 });
  window.dispose();
  assert.equal(scene.residency.entries.get(window.key)?.id, fresh.id);
});
