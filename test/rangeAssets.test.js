// Range v2 Task 7: verified, cancelable, budgeted terrain preparation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { prepareTerrainAssets, loadTerrainPackage, RangeAssetError } from '../src/world/alpine/RangeAssets.js';
import { GraphicsResidency, MiB } from '../src/render/GraphicsResidency.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const W = 129;
const heightsM = new Float32Array(W * W).map((_, i) => 1000 + 300 * Math.sin((i % W) / 17) * Math.cos(Math.floor(i / W) / 23));
const grid = { width: W, height: W, cellSizeM: 10, originM: [-640, -640], heightsM, valid: new Uint8Array(W * W).fill(1),
  horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 10, outputSpacingM: 10 };
const camera = { eyeStartM: [0, 1800, 900], eyeEndM: [100, 1800, 900], targetStartM: [0, 1000, 0], targetEndM: [100, 1000, 0], fovYDeg: 35 };
const baked = await bakeTerrain(grid, { id: 'v1', camera });
const manifestText = JSON.stringify(baked.manifest);
const base = 'http://assets.test/v2/';
const view = { id: 'v1', terrainManifestUrl: 'terrain/v1.terrain.json',
  terrainManifestSha256: createHash('sha256').update(manifestText).digest('hex') };

function server(overrides = {}) {
  const files = {
    [`${base}terrain/v1.terrain.json`]: () => new Response(manifestText),
    [`${base}terrain/v1.terrain.bin.gz`]: () => new Response(baked.payload),
    ...overrides,
  };
  const log = [];
  const fetchImpl = async (url) => { log.push(url); const f = files[url]; return f ? f() : new Response('nope', { status: 404 }); };
  return { fetchImpl, log };
}
const ledger = (mb = 64) => new GraphicsResidency({ budgetBytes: mb * MiB });

test('WP01 owned terrain stays charged until preparation releases it after generation cancellation', async () => {
  const r = ledger(), owner = {};
  const cpu = await prepareTerrainAssets(view, { baseUrl: base, residency: r, generation: 9, fetchImpl: server().fetchImpl, owner });
  const bytes = r.usedBytes;
  r.cancelGeneration(9);
  assert.equal(r.has(cpu.key), true, 'executing consumers still own decoded lanes');
  assert.equal(r.usedBytes, bytes);
  assert.equal(owner.retired, false);
  owner.release();
  assert.equal(r.usedBytes, 0);
});

test('WP01 explicit scene release retires only its CPU owner, preserving a second consumer', async () => {
  const r = ledger(), first = { holderKey: 'gpu:first' }, other = {};
  const options = { baseUrl: base, residency: r, fetchImpl: server().fetchImpl };
  const cpu = await prepareTerrainAssets(view, { ...options, owner: first });
  await prepareTerrainAssets(view, { ...options, owner: other });
  const p = { cpuKey: cpu.key, gpuKey: first.holderKey, cpuOwner: first };
  const scene = Object.assign(Object.create(RangeScene.prototype), { residency: r, prepared: new Map([[view.id, p]]) });
  scene._disposePrepared = () => {};
  scene._releaseMaterial = () => {};
  r.commit(r.reserve({ key: p.gpuKey, bytes: 40 }), p, value => scene._retire(view.id, value));
  scene.release(view.id);
  assert.equal(r.has(cpu.key), true);
  assert.equal(other.retired, false);
  assert.equal(cpu.owners.size, 1);
  other.release();
  assert.equal(r.usedBytes, 0);
});

test('a valid package prepares, commits once and is reused', async () => {
  const r = ledger();
  const { fetchImpl, log } = server();
  const a = await prepareTerrainAssets(view, { baseUrl: base, residency: r, generation: 1, fetchImpl });
  assert.equal(a.viewId, 'v1');
  assert.ok(a.data.tiles.size > 0);
  assert.ok(r.liveBytes > 0 && r.pendingBytes === 0);
  const again = await prepareTerrainAssets(view, { baseUrl: base, residency: r, generation: 1, fetchImpl });
  assert.equal(again, a);
  assert.equal(log.length, 2, 'reuse does not refetch');
});

// A composition variant names its source with terrainSourceId and pins the
// source's manifest; the package inside still says viewId: <source>.
const variant = { ...view, id: 'v1-coherent', terrainSourceId: 'v1' };

test('a composition variant prepares its source terrain under its own identity', async () => {
  const r = ledger();
  const cpu = await prepareTerrainAssets(variant, { baseUrl: base, residency: r, fetchImpl: server().fetchImpl });
  assert.equal(cpu.viewId, 'v1-coherent');
  assert.equal(cpu.key, 'range:terrain-cpu:v1-coherent');
  assert.ok(cpu.data.tiles.size > 0);
});

test('the terrain identity gate still refuses a package for another view', async () => {
  for (const wrong of [{ ...view, id: 'v2' }, { ...variant, terrainSourceId: 'v2' }]) {
    await assert.rejects(prepareTerrainAssets(wrong, { baseUrl: base, residency: ledger(), fetchImpl: server().fetchImpl }),
      (e) => e instanceof RangeAssetError && e.reason === 'manifest' && /manifest is for v1, not v2/.test(e.message));
  }
});

test('a live source preparation never lets a variant skip its own manifest pin', async () => {
  const r = ledger(), sourceOwner = {}, variantOwner = {};
  const { fetchImpl, log } = server();
  const source = await prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl, owner: sourceOwner });
  const badPin = { ...variant, terrainManifestSha256: '0'.repeat(64) };
  await assert.rejects(prepareTerrainAssets(badPin, { baseUrl: base, residency: r, fetchImpl, owner: {} }),
    (e) => e.reason === 'hash');
  assert.equal(r.has(source.key), true, 'the refused variant does not disturb the live source');
  // Two holders of distinct entries: releasing one never retires the other.
  const before = log.length;
  const alias = await prepareTerrainAssets(variant, { baseUrl: base, residency: r, fetchImpl, owner: variantOwner });
  assert.notEqual(alias, source);
  assert.ok(log.length > before, 'the variant verifies and loads its own bytes');
  variantOwner.release();
  assert.equal(r.has(alias.key), false);
  assert.equal(r.has(source.key), true);
  assert.equal(sourceOwner.retired, false);
  sourceOwner.release();
  assert.equal(r.usedBytes, 0);
});

test('every catalog view, composition variants included, prepares from the shipped assets', async () => {
  const root = new URL('../src/assets/range/v2/', import.meta.url);
  const fetchImpl = async (url) => {
    try { return new Response(await fs.readFile(fileURLToPath(url))); } catch { return new Response('missing', { status: 404 }); }
  };
  assert.ok(catalog.views.some((v) => v.terrainSourceId), 'the catalog still carries a composition variant');
  const failures = [];
  for (const v of catalog.views) {
    try {
      const cpu = await prepareTerrainAssets(v, { baseUrl: root.href, fetchImpl });
      assert.equal(cpu.viewId, v.id);
    } catch (error) { failures.push(`${v.id}: ${error.message}`); }
  }
  assert.deepEqual(failures, []);
});

test('missing assets fail explicitly', async () => {
  const { fetchImpl } = server({ [`${base}terrain/v1.terrain.bin.gz`]: () => new Response('x', { status: 404 }) });
  const r = ledger();
  await assert.rejects(prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl }), (e) => e instanceof RangeAssetError && e.reason === 'http');
  assert.equal(r.usedBytes, 0, 'the failed reservation is released');
});

test('truncated or tampered payloads are rejected by length/hash', async () => {
  const cut = server({ [`${base}terrain/v1.terrain.bin.gz`]: () => new Response(baked.payload.subarray(0, 100)) });
  await assert.rejects(prepareTerrainAssets(view, { baseUrl: base, residency: ledger(), fetchImpl: cut.fetchImpl }), /length|hash/);
  const tampered = Buffer.from(baked.payload); tampered[tampered.length - 20] ^= 0xff;
  const bad = server({ [`${base}terrain/v1.terrain.bin.gz`]: () => new Response(tampered) });
  await assert.rejects(prepareTerrainAssets(view, { baseUrl: base, residency: ledger(), fetchImpl: bad.fetchImpl }), /hash/);
  const otherManifest = server({ [`${base}terrain/v1.terrain.json`]: () => new Response(manifestText.replace('"version":1', '"version":1 ')) });
  await assert.rejects(prepareTerrainAssets(view, { baseUrl: base, fetchImpl: otherManifest.fetchImpl }), /catalog/);
});

test('a late response for an older generation is never published', async () => {
  const r = ledger();
  let current = 5;
  let release;
  const gate = new Promise((res) => { release = res; });
  const { fetchImpl } = server({ [`${base}terrain/v1.terrain.bin.gz`]: async () => { await gate; return new Response(baked.payload); } });
  const p = prepareTerrainAssets(view, { baseUrl: base, residency: r, generation: 5, isCurrent: (g) => g === current, fetchImpl });
  await new Promise((res) => setTimeout(res, 10));
  current = 6; // a newer song/world took over
  release();
  await assert.rejects(p, (e) => e.reason === 'stale');
  assert.equal(r.has('range:terrain-cpu:v1'), false);
  assert.equal(r.usedBytes, 0);
});

test('cancelling the generation mid-decode frees its bytes and rejects', async () => {
  const r = ledger();
  let release, requested;
  const gate = new Promise((res) => { release = res; });
  // The payload is requested only after the reservation is made, so waiting
  // for that request (not a fixed delay) puts the cancel mid-decode.
  const payloadRequested = new Promise((res) => { requested = res; });
  const { fetchImpl } = server({ [`${base}terrain/v1.terrain.bin.gz`]: async () => { requested(); await gate; return new Response(baked.payload); } });
  const p = prepareTerrainAssets(view, { baseUrl: base, residency: r, generation: 9, fetchImpl });
  await payloadRequested;
  assert.ok(r.pendingBytes > 0);
  r.cancelGeneration(9);
  assert.equal(r.pendingBytes, 0);
  release();
  await assert.rejects(p, (e) => e.reason === 'stale');
  assert.equal(r.usedBytes, 0);
});

test('an aborted load rejects as aborted', async () => {
  const ac = new AbortController();
  ac.abort();
  const { fetchImpl } = server();
  await assert.rejects(prepareTerrainAssets(view, { baseUrl: base, signal: ac.signal, fetchImpl: (u, init) => (init?.signal?.aborted ? Promise.reject(new Error('aborted')) : fetchImpl(u)) }),
    (e) => e.reason === 'aborted' || e.reason === 'stale');
});

test('budget denial throws before downloading the payload', async () => {
  const r = ledger(0.05);
  const { fetchImpl, log } = server();
  await assert.rejects(prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl }), (e) => e.reason === 'budget');
  assert.deepEqual(log, [`${base}terrain/v1.terrain.json`]);
});

test('a host that already decoded the gzip transfer is accepted by decoded identity', async () => {
  const zlib = await import('node:zlib');
  const plain = zlib.gunzipSync(baked.payload);
  const { fetchImpl } = server({ [`${base}terrain/v1.terrain.bin.gz`]: () => new Response(plain) });
  const pkg = await loadTerrainPackage(`${base}terrain/v1.terrain.json`, { fetchImpl });
  assert.equal(pkg.bytes.decoded, baked.manifest.payload.decodedByteLength);
});

test('a body that fails after the headers is a classified asset error', async () => {
  const ac = new AbortController();
  const dropped = async () => ({ ok: true, arrayBuffer: async () => { throw new TypeError('connection reset'); } });
  await assert.rejects(loadTerrainPackage(`${base}terrain/v1.terrain.json`, { fetchImpl: dropped }), (e) => e.reason === 'http');
  const aborting = async () => ({ ok: true, arrayBuffer: async () => { ac.abort(); throw new DOMException('aborted', 'AbortError'); } });
  await assert.rejects(loadTerrainPackage(`${base}terrain/v1.terrain.json`, { fetchImpl: aborting, signal: ac.signal }), (e) => e.reason === 'aborted');
});

test('WP01 cached terrain is held before its Promise handoff, and shared holders release independently', async () => {
  const r = ledger();
  const { fetchImpl } = server();
  const firstOwner = { holderKey: 'gpu:first' };
  const cpu = await prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl, owner: firstOwner });
  const bytes = r.usedBytes;
  r.budgetBytes = bytes + 10;
  const secondOwner = { holderKey: 'gpu:second' };
  const handoff = prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl, owner: secondOwner });
  assert.equal(r.reserve({ key: 'pressure', bytes: 11 }), null, 'cached acquisition already owns a lease');
  assert.equal(await handoff, cpu);
  firstOwner.release();
  firstOwner.release();
  assert.equal(r.get(cpu.key), cpu, 'another consumer still owns the CPU bytes');
  secondOwner.release();
  assert.equal(r.has(cpu.key), false);
  assert.equal(r.usedBytes, 0);
});

test('WP01 stale terrain cleanup does not release a replacement reservation', async () => {
  const r = ledger();
  let requested, resume;
  const started = new Promise(resolve => { requested = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const { fetchImpl } = server({ [`${base}terrain/v1.terrain.bin.gz`]: async () => {
    requested(); await gate; return new Response(baked.payload);
  } });
  let current = true;
  const job = prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl, isCurrent: () => current });
  await started;
  const key = 'range:terrain-cpu:v1';
  r.release(key);
  const replacement = r.reserve({ key, bytes: 10, generation: 2 });
  current = false;
  resume();
  await assert.rejects(job, error => error.reason === 'stale');
  assert.equal(r.entries.get(key).id, replacement.id);
});

test('WP01 published holders retire as a dependency closure without permanent pinning', async () => {
  const r = ledger();
  const { fetchImpl } = server();
  const owner = { holderKey: 'gpu:view' };
  const cpu = await prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl, owner });
  const cpuBytes = r.usedBytes;
  let retired = 0;
  const gpu = r.reserve({ key: owner.holderKey, bytes: 40 });
  r.commit(gpu, { data: cpu.data }, () => { retired++; owner.release(); });
  r.budgetBytes = cpuBytes + 50;
  r.pin([owner.holderKey]);
  assert.equal(r.reserve({ key: 'pressure', bytes: 11 }), null, 'CPU-only pressure protects live GPU data');
  assert.equal(r.get(cpu.key), cpu);
  r.pin([]);
  assert.ok(r.reserve({ key: 'pressure', bytes: cpuBytes + 50 }));
  assert.equal(retired, 1);
  assert.equal(r.has(cpu.key), false);
  owner.release();
  assert.equal(retired, 1);
});

test('WP01 forced CPU retirement notifies its owners and old release preserves replacement', async () => {
  const r = ledger();
  const { fetchImpl } = server();
  let retired = 0;
  const owner = { onRetire: () => { retired++; } };
  const cpu = await prepareTerrainAssets(view, { baseUrl: base, residency: r, fetchImpl, owner });
  r.release(cpu.key);
  assert.equal(owner.retired, true);
  assert.equal(owner.lease, null);
  assert.equal(retired, 1);
  const next = r.reserve({ key: cpu.key, bytes: 10 });
  owner.release();
  assert.equal(r.entries.get(cpu.key).id, next.id);
});
