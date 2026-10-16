// Range v2 scene lifecycle (review fixes): shared material loads, reservation
// before decode, generation-aware pending work, and eviction that retires a
// prepared view. Exercised on a RangeScene without a GL context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency, MiB } from '../src/render/GraphicsResidency.js';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';

const dir = path.resolve('src/assets/range/v2/materials');
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'wet-conifer.json'), 'utf8'));
const base = 'http://assets.test/v2/';
const files = new Map([[`${base}materials/wet-conifer.json`, JSON.stringify(manifest)]]);
for (const t of Object.values(manifest.textures)) files.set(new URL(t.url, `${base}materials/wet-conifer.json`).href, await fs.readFile(path.join(dir, t.url)));

function bareScene(budgetMiB = 256) {
  const s = Object.create(RangeScene.prototype);
  Object.assign(s, {
    THREE: { Texture: class { dispose() {} }, NoColorSpace: '', RepeatWrapping: 0, LinearFilter: 0, LinearMipmapLinearFilter: 0 },
    residency: new GraphicsResidency({ budgetBytes: budgetMiB * MiB }),
    prepared: new Map(), pending: new Map(), materials: new Map(), materialLoads: new Map(),
  });
  return s;
}
const view = (id) => ({ id, materialManifestUrl: 'materials/wet-conifer.json' });

async function withNet(fn, { onDecode = () => {}, onClose = () => {}, gate = null } = {}) {
  const f = globalThis.fetch, c = globalThis.createImageBitmap;
  let fetches = 0;
  globalThis.fetch = async (u, init) => {
    fetches++;
    if (gate) await gate(String(u), init);
    return files.has(String(u)) ? new Response(files.get(String(u))) : new Response('', { status: 404 });
  };
  globalThis.createImageBitmap = async (blob) => {
    onDecode();
    const n = (await blob.arrayBuffer()).byteLength;
    const t = Object.values(manifest.textures).find((x) => x.bytes === n);
    const img = { width: t.width, height: t.height, close() { onClose(img); } };
    return img;
  };
  try { return await fn(() => fetches); } finally { globalThis.fetch = f; globalThis.createImageBitmap = c; }
}

test('views sharing a material pack load it once, concurrently, without a duplicate reservation', async () => {
  await withNet(async (fetches) => {
    const s = bareScene();
    const [a, b] = await Promise.all([s._acquireMaterial(view('a'), { baseUrl: base }), s._acquireMaterial(view('b'), { baseUrl: base })]);
    assert.equal(a, b);
    assert.deepEqual([...a.users.values()].sort(), ['a', 'b']);
    const unique = new Set(Object.values(manifest.textures).map((t) => t.sha256)).size;
    assert.equal(fetches(), 1 + unique, 'one manifest and one fetch per texture');
    assert.equal(s.residency.snapshot().byOwner['range-material'].count, 1);
  });
});

test('a pack that does not fit is refused before any image is decoded', async () => {
  let decodes = 0;
  await withNet(async () => {
    const s = bareScene(1);
    await assert.rejects(s._acquireMaterial(view('a'), { baseUrl: base }), (e) => e.reason === 'budget');
    assert.equal(s.residency.usedBytes, 0);
  }, { onDecode: () => { decodes++; } });
  assert.equal(decodes, 0);
});

test('evicting a prepared view retires it from the cache and frees its CPU entry', () => {
  const s = bareScene(10);
  s._disposePrepared = () => {};
  const r = s.residency;
  const cpu = r.reserve({ key: 'cpu:v', bytes: 2 * MiB, owner: 'cpu' });
  r.commit(cpu, {});
  const p = { gpuKey: 'gpu:v', cpuKey: 'cpu:v', materialKey: null };
  r.commit(r.reserve({ key: 'gpu:v', bytes: 6 * MiB, owner: 'gpu' }), p, (x) => s._retire('v', x));
  s.prepared.set('v', p);
  // Another owner needs the room; the view is not pinned, so it goes.
  assert.ok(r.reserve({ key: 'other', bytes: 8 * MiB, owner: 'x' }));
  assert.equal(s.prepared.has('v'), false);
  assert.equal(r.snapshot().byOwner.cpu, undefined);
});

test('the view a frame draws is pinned and survives the same pressure', () => {
  const s = bareScene(10);
  s._disposePrepared = () => {};
  const r = s.residency;
  const p = { gpuKey: 'gpu:v', cpuKey: 'cpu:v', materialKey: null };
  r.commit(r.reserve({ key: 'gpu:v', bytes: 6 * MiB, owner: 'gpu' }), p, (x) => s._retire('v', x));
  s.prepared.set('v', p);
  s.pinView('v');
  assert.equal(r.reserve({ key: 'other', bytes: 8 * MiB, owner: 'x' }), null);
  assert.equal(s.prepared.has('v'), true);
});

test('a new generation never inherits an older generation\'s pending rejection', async () => {
  const s = bareScene();
  let rejectOld;
  const old = new Promise((_, rej) => { rejectOld = rej; });
  old.catch(() => {});
  s.pending.set('v', { generation: 1, job: old });
  const real = s.prepare.bind(s);
  const out = real({ id: 'v' }, { generation: 2 });
  // Same generation shares the pending job.
  assert.equal(real({ id: 'v' }, { generation: 1 }), old);
  s.prepare = async (v, o) => ({ fresh: true, generation: o.generation });
  rejectOld(Object.assign(new Error('stale'), { reason: 'stale' }));
  assert.deepEqual(await out, { fresh: true, generation: 2 });
});

test('a preparation that straddles a context loss or restore never publishes; none starts while lost', async () => {
  const s = bareScene();
  s.contextLost = false;
  s.contextEpoch = 0;
  // The decoded terrain is already resident, so prepare goes straight to
  // the GPU stage; the material step is where the context goes away.
  const cpuKey = 'range:terrain-cpu:a';
  s.residency.commit(s.residency.reserve({ key: cpuKey, bytes: MiB, owner: 'range-terrain-cpu' }), { key: cpuKey, data: {}, manifest: {} });
  let released = 0;
  s._acquireMaterial = async () => { s.contextLost = true; s.contextEpoch++; return { pack: { manifest: { rules: {} } } }; };
  s._releaseMaterial = () => { released++; };
  await assert.rejects(s.prepare(view('a'), { baseUrl: base }), (e) => e.reason === 'context-lost');
  assert.equal(s.prepared.has('a'), false);
  assert.equal(released, 1, 'the material hold is returned');
  // While lost, nothing new starts.
  await assert.rejects(s.prepare(view('b'), { baseUrl: base }), (e) => e.reason === 'context-lost');
  assert.equal(s.pending.has('b'), false);
});

test('WP01 terrain stays charged throughout the material await and failed preparation releases its lease', async () => {
  const s = bareScene();
  s.budget = 'desktop'; s.contextLost = false; s.contextEpoch = 0;
  const key = 'range:terrain-cpu:a';
  const cpu = { key, data: { retained: new Float32Array(10) }, manifest: {} };
  s.residency.commit(s.residency.reserve({ key, bytes: 40, owner: 'range-terrain-cpu' }), cpu);
  s.residency.budgetBytes = 100;
  s._acquireMaterial = async () => {
    assert.equal(s.residency.reserve({ key: 'pressure', bytes: 61 }), null,
      'preparing data cannot outlive its CPU charge');
    throw new Error('injected material failure');
  };
  await assert.rejects(s.prepare(view('a'), { baseUrl: base }), /injected material failure/);
  assert.equal(s.residency.usedBytes, 0);
  assert.equal(s.pending.size, 0);
});

test('no foreground never builds ground, and shared target release clears ownership on resize/context cleanup', () => {
  const s = bareScene();
  s.prepared.set('none', { view: { composition: { foreground: 'none', nearLedgeMaxFrac: 0 } } });
  s.contextLost = false;
  const frame = { compositions: { none: { foreground: 'none', nearLedgeMaxFrac: 0 } } };
  assert.equal(s.renderGround(frame, 'none'), null, 'no viewport/GL access when no foreground');
  let disposed = 0;
  s.groundTarget = { dispose() { disposed++; } };
  const r = s.residency.reserve({ key: 'range:ground-target', bytes: 1024, owner: 'range-targets' });
  s.residency.commit(r, s.groundTarget, t => t.dispose());
  s.releaseGroundTarget(); s.releaseGroundTarget();
  assert.equal(s.groundTarget, null);
  assert.equal(disposed, 1);
  assert.equal(s.residency.snapshot().liveBytes, 0);
});

test('uncomposed tour views without a foreground stage never allocate a ground target', () => {
  const s = bareScene();
  s.prepared.set('tour', { view: { id: 'tour' }, stageGL: null });
  s.contextLost = false;
  assert.equal(s.renderGround({ compositions: { tour: null } }, 'tour'), null);
  assert.equal(s.residency.snapshot().liveBytes, 0);
});

// --- G2: material cache lifetime matches ledger residency -------------------
const materialKey = `range:material:${manifest.id}`;
const materialUrl = `${base}materials/wet-conifer.json`;

test('a material the ledger released leaves the cache; reacquiring loads a distinct, ledger-owned entry', async () => {
  const closes = new Map();
  await withNet(async () => {
    const s = bareScene();
    const owner = { viewId: 'a' };
    const first = await s._acquireMaterial(view('a'), { baseUrl: base, owner });
    assert.equal(s.residency.get(materialKey), first);
    // The ledger lets it go (eviction, owner release, cancellation).
    s.residency.release(materialKey);
    assert.equal(s.materials.has(materialUrl), false, 'the dead entry is not a cache hit');
    assert.ok([...closes.values()].every((n) => n === 1) && closes.size > 0, 'old images close exactly once');
    assert.equal(owner.lease, null, 'the user\'s lease went with it');
    const second = await s._acquireMaterial(view('a'), { baseUrl: base, owner: { viewId: 'a' } });
    assert.notEqual(second, first);
    assert.equal(s.residency.get(materialKey), second, 'the new entry is the ledger\'s live resource');
    s.residency.release(materialKey);
    assert.ok([...closes.values()].every((n) => n === 1), 'releasing the new entry never closes the old images again');
  }, { onClose: (img) => closes.set(img, (closes.get(img) || 0) + 1) });
});

test('views sharing a pack retain it against pressure from terrain and scratch reservations', async () => {
  await withNet(async () => {
    const s = bareScene(64);
    const a = { viewId: 'a' }, b = { viewId: 'b' };
    const [ma, mb] = await Promise.all([
      s._acquireMaterial(view('a'), { baseUrl: base, owner: a }),
      s._acquireMaterial(view('b'), { baseUrl: base, owner: b })]);
    assert.equal(ma, mb);
    const used = s.residency.usedBytes;
    s.residency.pin([]); // neither view is drawing this frame
    const room = s.residency.budgetBytes - used;
    assert.equal(s.residency.reserve({ key: 'range:surface-scratch:c', bytes: room + 1, owner: 'range-scratch' }), null,
      'a retained pack is not evicted to make room');
    assert.equal(s.residency.get(materialKey), ma);
    s._releaseMaterial('a', a);
    assert.equal(s.residency.get(materialKey), ma, 'one view leaving keeps the pack for the other');
    s._releaseMaterial('a', a);
    assert.equal(s.residency.get(materialKey), ma, 'an old view\'s repeated release never drops another\'s hold');
    s._releaseMaterial('b', b);
    assert.equal(s.residency.has(materialKey), false);
    assert.deepEqual([s.residency.liveBytes, s.residency.pendingBytes], [0, 0], 'ledger back to baseline');
  });
});

test('a ledger release retires the prepared views still drawing the pack', async () => {
  await withNet(async () => {
    const s = bareScene();
    s._disposePrepared = () => {};
    const owner = { viewId: 'v' };
    const mat = await s._acquireMaterial(view('v'), { baseUrl: base, owner });
    const p = { gpuKey: 'gpu:v', cpuKey: 'cpu:v', materialKey: mat.key, materialOwner: owner };
    s.residency.commit(s.residency.reserve({ key: 'gpu:v', bytes: MiB, owner: 'gpu' }), p, (x) => s._retire('v', x));
    s.prepared.set('v', p);
    // A replacement preparation of the same view id holds its own token.
    s.residency.release(materialKey);
    assert.equal(s.prepared.has('v'), false, 'no cached view keeps dead material');
    assert.equal(s.residency.has('gpu:v'), false);
    assert.deepEqual([s.residency.liveBytes, s.residency.pendingBytes], [0, 0]);
  });
});

test('cancelling one consumer keeps the shared fetch for the other; cancelling all aborts it', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const signals = [];
  await withNet(async () => {
    const s = bareScene();
    const ca = new AbortController(), cb = new AbortController();
    const pa = s._acquireMaterial(view('a'), { baseUrl: base, signal: ca.signal, owner: { viewId: 'a' } });
    const pb = s._acquireMaterial(view('b'), { baseUrl: base, signal: cb.signal, owner: { viewId: 'b' } });
    ca.abort();
    await assert.rejects(pa, (e) => e.reason === 'aborted');
    assert.equal(signals[0].aborted, false, 'the shared fetch continues for b');
    release();
    const mb = await pb;
    assert.deepEqual([...mb.users.values()], ['b']);
    assert.equal(s.residency.get(materialKey), mb);
  }, { gate: async (u, init) => { if (u === materialUrl) { signals.push(init.signal); await held; } } });

  // Every consumer gone: the fetch is aborted and nothing stays reserved.
  let go;
  const wait = new Promise((r) => { go = r; });
  const seen = [];
  await withNet(async () => {
    const s = bareScene();
    const ca = new AbortController();
    const pa = s._acquireMaterial(view('a'), { baseUrl: base, signal: ca.signal, owner: { viewId: 'a' } });
    const load = s.materialLoads.get(materialUrl);
    ca.abort();
    await assert.rejects(pa, (e) => e.reason === 'aborted');
    assert.equal(seen[0].aborted, true, 'no consumer left: the shared fetch is aborted');
    assert.equal(s.materialLoads.has(materialUrl), false);
    // A newer load for the same URL starts and finishes first...
    const fresh = await s._acquireMaterial(view('b'), { baseUrl: base, owner: { viewId: 'b' } });
    // ...then the abandoned one completes late (its fetch ignored the abort).
    go();
    await load.promise.catch(() => {});
    assert.equal(s.materials.get(materialUrl), fresh, 'a late old completion never replaces the newer load');
    assert.equal(s.residency.get(materialKey), fresh);
    assert.equal(s.residency.snapshot().byOwner['range-material'].count, 1);
  }, { gate: async (u, init) => { if (u === materialUrl) { seen.push(init.signal); if (seen.length === 1) await wait; } } });
});

// --- G3: late runtime initialization never revives a disposed runtime -------
const runtimeCatalog = { catalogVersion: 1, views: [] };
function deferredRuntime() {
  const calls = [];
  const factory = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  const scene = (name) => ({ name, disposed: 0, dispose() { this.disposed++; }, snapshot: () => ({}) });
  return { calls, factory, scene };
}

test('disposing during runtime load drops the late scene, disposing it exactly once', async () => {
  const d = deferredRuntime();
  const p = new RangePresentation({ mode: 'v2', catalog: runtimeCatalog, sceneFactory: d.factory });
  const loading = p._ensureRuntime();
  assert.equal(p.runtimeState, 'loading');
  p.dispose();
  const late = d.scene('late');
  d.calls[0].resolve(late);
  await loading;
  assert.equal(p.scene, null, 'a disposed runtime is not revived');
  assert.equal(p.runtimeState, 'idle');
  assert.equal(late.disposed, 1);
});

for (const order of ['old-first', 'new-first']) {
  test(`dispose then reload: only the current load publishes (${order})`, async () => {
    const d = deferredRuntime();
    const p = new RangePresentation({ mode: 'v2', catalog: runtimeCatalog, sceneFactory: d.factory });
    const first = p._ensureRuntime();
    p.dispose();
    const second = p._ensureRuntime();
    const oldScene = d.scene('old'), newScene = d.scene('new');
    if (order === 'old-first') { d.calls[0].resolve(oldScene); await first; d.calls[1].resolve(newScene); await second; }
    else { d.calls[1].resolve(newScene); await second; d.calls[0].resolve(oldScene); await first; }
    assert.equal(p.scene, newScene);
    assert.equal(p.runtimeState, 'ready');
    assert.equal(oldScene.disposed, 1);
    assert.equal(newScene.disposed, 0);
  });
}

test('an obsolete rejection after a newer success leaves the runtime ready', async () => {
  const d = deferredRuntime();
  const p = new RangePresentation({ mode: 'v2', catalog: runtimeCatalog, sceneFactory: d.factory });
  const warn = console.warn; console.warn = () => {};
  try {
    const first = p._ensureRuntime();
    p.dispose();
    const second = p._ensureRuntime();
    const current = d.scene('current');
    d.calls[1].resolve(current);
    await second;
    d.calls[0].reject(new Error('WebGL2 unavailable'));
    await first;
    assert.equal(p.scene, current);
    assert.equal(p.runtimeState, 'ready');
    assert.doesNotMatch(String(p.reason), /runtime-unavailable/);
  } finally { console.warn = warn; }
});

test('setTourMode reuses the presentation: the next load publishes normally', async () => {
  const d = deferredRuntime();
  const p = new RangePresentation({ mode: 'v2', catalog: runtimeCatalog, sceneFactory: d.factory });
  const first = p._ensureRuntime();
  const a = d.scene('a');
  d.calls[0].resolve(a);
  await first;
  p.setTourMode(false);
  assert.equal(a.disposed, 1);
  assert.equal(p.runtimeState, 'idle');
  const again = p._ensureRuntime();
  const b = d.scene('b');
  d.calls[1].resolve(b);
  await again;
  assert.equal(p.scene, b);
  assert.equal(p.runtimeState, 'ready');
});

function admissionTerrain() {
  return { cells: 1, grid: { originM: [0, 0], cellSizeM: 100 }, tiles: new Map(), byIndex: new Map() };
}
function admissionTour() {
  return { durationMs: 40000, poseAt: () => ({ eyeM: [0, 100, 100], targetM: [0, 0, 0], fovYDeg: 50 }) };
}

test('late tour-prefetch failure cannot release a newer reservation or map entry (M9)', async () => {
  const s = bareScene(100); s._swapTourWindow = () => {};
  let reject;
  const window = { key: 'w0', coarse: false }, next = { key: 'w1', coarse: false };
  const p = { view: { id: 'tour', tour: admissionTour() }, data: admissionTerrain(), rules: {}, generation: 1,
    activeWindow: window, lastWindowBytes: MiB,
    windowCache: { resident: new Map([[0, window], [1, next]]), request: () => Promise.resolve(), prune() {} },
    windowWorker: { build: () => new Promise((resolve, fail) => { reject = fail; }) }, windowOptions: {}, rawAhead: new Map() };
  s._ensureTourWindow(p, 0);
  const old = p.rawAhead.get(2), key = old.key;
  s.residency.release(key);
  const fresh = s.residency.reserve({ key, bytes: 2 * MiB, generation: 1 });
  const newer = { key, job: Promise.resolve({}), reservation: fresh };
  p.rawAhead.set(2, newer);
  reject(new Error('worker failed late'));
  await old.job.catch(() => {});
  assert.equal(p.rawAhead.get(2), newer);
  assert.equal(s.residency.entries.get(key).id, fresh.id);
});

test('tour windows reserve both retained CPU arrays and uploaded geometry/forest buffers (M7)', async () => {
  const s = bareScene();
  const raw = { built: { bands: { far: { positions: new Float32Array(12), indices: new Uint32Array(6), fringe: new Uint32Array(3) } } }, placed: { count: 100 } };
  const p = { view: { id: 'tour', tour: admissionTour() }, data: admissionTerrain(), rules: {}, generation: 1, windowCache: { generation: 1, resident: new Map() }, windowWorker: { build: async () => raw }, windowOptions: {} };
  s.prepared.set('tour', p);
  let bytes;
  s.residency.reserve = args => { bytes = args.bytes; return null; };
  await assert.rejects(s._buildTourWindow(p, 0), e => e.reason === 'budget');
  assert.ok(bytes >= 2 * (raw.built.bands.far.positions.byteLength + raw.built.bands.far.indices.byteLength + raw.built.bands.far.fringe.byteLength + 100 * 7 * 4));
});

test('a cached RangeScene holder retires and releases its material when it can make a new view fit (R1)', async () => {
  await withNet(async () => {
    const s = bareScene(100); s._disposePrepared = () => {};
    const owner = { viewId: 'v', holderKey: 'gpu:v' };
    const mat = await s._acquireMaterial(view('v'), { baseUrl: base, owner });
    const bytes = s.residency.entries.get(mat.key).bytes;
    const p = { gpuKey: 'gpu:v', cpuKey: 'cpu:v', materialKey: mat.key, materialOwner: owner };
    s.residency.commit(s.residency.reserve({ key: 'gpu:v', bytes: 50 * MiB }), p, x => s._retire('v', x));
    s.prepared.set('v', p);
    // New view needs some of the material's bytes as well as all view bytes.
    assert.ok(s.residency.reserve({ key: 'new', bytes: 100 * MiB - bytes / 2 }));
    assert.equal(s.prepared.has('v'), false); assert.equal(mat.dead, true);
    assert.equal(s.residency.has(mat.key), false); assert.equal(s.residency.overcommits || 0, 0);
  });
});
