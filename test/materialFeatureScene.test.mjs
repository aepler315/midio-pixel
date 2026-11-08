import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
import { readFile } from 'node:fs/promises';

const grid = { originM: [-1200, -1200], width: 65, height: 65, cellSizeM: 20 };

const featureUniforms = (source = grid) => sceneUniforms(THREE, {
  uGridOrigin: { value: new THREE.Vector2(...source.originM) },
});

function scene({ mode = 'warp', budgetBytes = 1024 ** 2 } = {}) {
  const { gl, canvas, state } = recordingWebGL2(64, 64);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  let allocations = 0;
  let disposals = 0;
  class Target extends THREE.WebGLRenderTarget {
    constructor(...args) { super(...args); allocations++; this.addEventListener('dispose', () => { disposals++; }); }
  }
  const s = Object.assign(Object.create(RangeScene.prototype), {
    THREE: { ...THREE, WebGLRenderTarget: Target }, renderer,
    materialFeatures: mode, residency: new GraphicsResidency({ budgetBytes }),
    prepared: new Map(), pending: new Map(), contextLost: false, sideTargets: {},
  });
  return { s, gl, state, allocations: () => allocations, disposals: () => disposals };
}

test('reference material features plan no cache and allocate no target', () => {
  const { s, allocations } = scene({ mode: 'reference' });
  assert.equal(typeof s._admitMaterialFeatures, 'function');
  const admitted = s._admitMaterialFeatures(grid, 100, 100);
  assert.equal(admitted.extraBytes, 0);
  assert.equal(admitted.plan, null);
  assert.equal(s._buildMaterialFeatures(admitted, null, featureUniforms(), () => {}), null);
  assert.equal(allocations(), 0);
  assert.equal(s.residency.usedBytes, 0);
  s.renderer.dispose();
});

test('optional cache denial protects every existing owner and allocates nothing', () => {
  const { s, allocations } = scene({ budgetBytes: 500 });
  let disposed = false;
  const live = s.residency.reserve({ key: 'active', bytes: 400 });
  s.residency.commit(live, {}, () => { disposed = true; });
  const admitted = s._admitMaterialFeatures(grid, 100, 0);
  assert.equal(admitted.plan, null);
  assert.equal(admitted.status.selected, 'reference');
  assert.equal(admitted.status.reason, 'budget');
  assert.equal(s.residency.has('active'), true);
  assert.equal(disposed, false);
  assert.equal(s._buildMaterialFeatures(admitted, null, featureUniforms(), () => {}), null);
  assert.equal(allocations(), 0);
  s.renderer.dispose();
});

function admit(s, source = grid) {
  const admission = s._admitMaterialFeatures(source, 100, 0);
  const reservation = s.residency.reserve({ key: 'view', bytes: 100 + admission.extraBytes });
  const soil = new THREE.Texture(), uniforms = featureUniforms(source);
  uniforms.tSoil.value = soil;
  return { admission, reservation, soil, uniforms };
}

test('cache construction retires only build scratch and the prepared view owns target disposal', () => {
  const { s, allocations, disposals } = scene();
  const { admission, reservation, soil, uniforms } = admit(s);
  assert.equal(allocations(), 0);
  assert.equal(s.residency.usedBytes, 100 + admission.plan.bytes + admission.plan.buildBytes);
  const cache = s._buildMaterialFeatures(admission, reservation, uniforms, () => {});
  assert.ok(cache);
  assert.equal(uniforms.tSoil.value, cache.texture);
  assert.deepEqual([uniforms.sSoil.value, uniforms.sCanopy.value], admission.plan.originCell);
  assert.equal(s.residency.usedBytes, 100 + admission.plan.bytes);
  assert.equal(admission.status.selected, 'warp');
  assert.equal(admission.status.bytes, admission.plan.bytes);
  assert.equal(allocations(), 1);
  s._releaseOpaqueDepth = () => {};
  const p = { materialFeatureCache: cache };
  s._disposePrepared(p); s._disposePrepared(p);
  assert.equal(disposals(), 1, 'target disposal remains idempotent');
  s.residency.releaseReservation(reservation);
  assert.equal(s.residency.usedBytes, 0);
  soil.dispose(); s.renderer.dispose();
});

test('a failed optional bake restores reference texture and returns all cache allowance', () => {
  const { s, disposals } = scene();
  const { admission, reservation, soil, uniforms } = admit(s);
  const originalScales = [uniforms.sSoil.value, uniforms.sCanopy.value];
  s.renderer.render = () => { throw new Error('injected draw failure'); };
  assert.equal(s._buildMaterialFeatures(admission, reservation, uniforms, () => {}), null);
  assert.equal(uniforms.tSoil.value, soil);
  assert.deepEqual([uniforms.sSoil.value, uniforms.sCanopy.value], originalScales);
  assert.equal(s.residency.usedBytes, 100);
  assert.equal(admission.extraBytes, 0);
  assert.equal(admission.status.selected, 'reference');
  assert.match(admission.status.reason, /injected draw failure/);
  assert.equal(disposals(), 1);
  soil.dispose(); s.renderer.dispose();
});

test('stale preparation after a completed bake disposes the cache and propagates retirement', () => {
  const { s, disposals } = scene();
  const { admission, reservation, soil, uniforms } = admit(s);
  let checks = 0;
  const stale = Object.assign(new Error('owner retired'), { reason: 'stale' });
  assert.throws(() => s._buildMaterialFeatures(admission, reservation, uniforms, () => {
    if (++checks > 1) throw stale;
  }), error => error === stale);
  assert.equal(uniforms.tSoil.value, soil);
  assert.equal(s.residency.usedBytes, 100);
  assert.equal(disposals(), 1);
  soil.dispose(); s.renderer.dispose();
});

test('context loss during the bake cannot silently publish a reference fallback', () => {
  const { s, gl, disposals } = scene();
  const { admission, reservation, soil, uniforms } = admit(s);
  s.renderer.render = () => { gl.isContextLost = () => true; };
  assert.throws(() => s._buildMaterialFeatures(admission, reservation, uniforms, () => {}), error => error.reason === 'context-lost');
  assert.equal(uniforms.tSoil.value, soil);
  assert.equal(s.residency.usedBytes, 100);
  assert.equal(disposals(), 1);
  soil.dispose(); s.renderer.dispose();
});

test('a replaced reservation survives stale feature-cache cleanup unchanged', () => {
  const { s, disposals } = scene();
  const { admission, reservation, soil, uniforms } = admit(s);
  s.renderer.render = () => {
    s.residency.releaseReservation(reservation);
    s.residency.reserve({ key: reservation.key, bytes: 777 });
  };
  assert.throws(() => s._buildMaterialFeatures(admission, reservation, uniforms, () => {}), error => error.reason === 'stale');
  assert.equal(s.residency.usedBytes, 777);
  assert.equal(disposals(), 1);
  soil.dispose(); s.renderer.dispose();
});

test('cache construction without a residency ledger still publishes and disposes normally', () => {
  const { s, disposals } = scene();
  s.residency = null;
  const admission = s._admitMaterialFeatures(grid, 100, 0), uniforms = featureUniforms();
  const cache = s._buildMaterialFeatures(admission, null, uniforms, () => {});
  assert.ok(cache);
  assert.equal(admission.status.selected, 'warp');
  cache.dispose(); assert.equal(disposals(), 1);
  s.renderer.dispose();
});

test('cache construction refuses missing or insufficient admission before allocating a target', () => {
  for (const missing of [true, false]) {
    const { s, allocations } = scene();
    const admission = s._admitMaterialFeatures(grid, 100, 0);
    const reservation = missing ? null : s.residency.reserve({ key: 'view', bytes: 100 });
    const uniforms = featureUniforms();
    assert.equal(s._buildMaterialFeatures(admission, reservation, uniforms, () => {}), null);
    assert.equal(allocations(), 0);
    assert.equal(s.residency.usedBytes, missing ? 0 : 100);
    s.renderer.dispose();
  }
});

test('snapshot reports actual material selection and compiled-renderer fallback', () => {
  const { s } = scene();
  s.prepared.set('cached', { view: { id: 'cached' }, materialFeatureStatus: { selected: 'warp', bytes: 400, width: 10, height: 10 }, material: { userData: { materialFeatures: 'warp' } } });
  s.prepared.set('compiled', { view: { id: 'compiled' }, compiled: { representation: 'compiled' } });
  s.prepared.set('rejected', { view: { id: 'rejected' }, materialFeatureStatus: { selected: 'warp', bytes: 400 }, material: { userData: { materialFeatures: 'reference' } } });
  const snapshot = s.snapshot().materialFeatures;
  assert.equal(snapshot.requested, 'warp');
  assert.equal(snapshot.drawn.cached.selected, 'warp');
  assert.equal(snapshot.drawn.cached.material, 'warp');
  assert.equal(snapshot.drawn.compiled.selected, 'reference');
  assert.equal(snapshot.drawn.compiled.reason, 'compiled-terrain');
  assert.equal(snapshot.drawn.rejected.selected, 'reference');
  assert.equal(snapshot.drawn.rejected.reason, 'shader-reference');
  s.renderer.dispose();
});

test('fractional grid boundaries transfer the exact planned integer cache origin', () => {
  const { s } = scene();
  const source = { ...grid, originM: [599.99999, -640] };
  const { admission, reservation, soil, uniforms } = admit(s, source);
  assert.equal(Math.fround(source.originM[0]), 600, 'GPU coordinate rounding crosses this cell boundary');
  assert.notEqual(Math.floor(Math.fround(source.originM[0]) / 600) - 1, admission.plan.originCell[0]);
  const cache = s._buildMaterialFeatures(admission, reservation, uniforms, () => {});
  assert.ok(cache);
  assert.deepEqual([uniforms.sSoil.value, uniforms.sCanopy.value], admission.plan.originCell);
  assert.deepEqual([Math.fround(uniforms.sSoil.value), Math.fround(uniforms.sCanopy.value)], admission.plan.originCell);
  cache.dispose(); soil.dispose(); s.renderer.dispose();
});

test('full preparation binds the admitted cache to the real terrain material and release frees its charge', async () => {
  const camera = { eyeStartM: [0, 600, 900], eyeEndM: [0, 600, 900], targetStartM: [0, 100, 0], targetEndM: [0, 100, 0], fovYDeg: 40 };
  const source = { ...grid, originM: [-640, -640], heightsM: new Float32Array(65 ** 2).fill(100), valid: new Uint8Array(65 ** 2).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const baked = await bakeTerrain(source, { id: 'feature-fixture', camera });
  const manifest = JSON.parse(await readFile(new URL('../src/assets/range/v2/materials/wet-conifer.json', import.meta.url), 'utf8'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(String(url).endsWith('.json') ? JSON.stringify(baked.manifest) : baked.payload);
  const scenes = [];
  try {
    const prepared = [];
    for (const mode of ['reference', 'warp']) {
      const fixture = scene({ mode, budgetBytes: 1e9 }), { s } = fixture;
      scenes.push(fixture);
      Object.assign(s, { budget: 'desktop', contextEpoch: 0, camera: new THREE.PerspectiveCamera(),
        _acquireMaterial: async () => ({ key: 'material', pack: { manifest: { ...manifest, rules: { ...manifest.rules, forestDensity: 0 } } }, textures: { roles: {} } }),
        _releaseMaterial: () => {} });
      prepared.push(await s.prepare({ id: 'feature-fixture', camera, terrainManifestUrl: 'fixture.json' }, { baseUrl: 'http://test/' }));
    }
    const [reference, cached] = prepared;
    assert.equal(reference.material.userData.materialFeatures, 'reference');
    assert.equal(reference.materialFeatureCache, null);
    assert.equal(cached.material.userData.materialFeatures, 'warp');
    assert.equal(cached.uniforms.tSoil.value, cached.materialFeatureCache.texture);
    assert.deepEqual([cached.uniforms.sSoil.value, cached.uniforms.sCanopy.value], cached.materialFeatureCache.plan.originCell);
    const charge = (index, p) => scenes[index].s.residency.entries.get(p.gpuKey).bytes;
    assert.equal(charge(1, cached) - charge(0, reference), cached.materialFeatureCache.bytes);
    assert.equal(scenes[1].s.snapshot().materialFeatures.drawn['feature-fixture'].selected, 'warp');
    scenes[1].s.release('feature-fixture');
    assert.equal(scenes[1].disposals(), 1);
    assert.equal(scenes[1].s.residency.usedBytes, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const { s } of scenes) { s.release('feature-fixture'); s.renderer.dispose(); }
  }
});

test('surface scratch pressure after the yield retires the optional cache before rejecting terrain', async () => {
  const camera = { eyeStartM: [0, 600, 900], eyeEndM: [0, 600, 900], targetStartM: [0, 100, 0], targetEndM: [0, 100, 0], fovYDeg: 40 };
  const source = { ...grid, originM: [-640, -640], heightsM: new Float32Array(65 ** 2).fill(100), valid: new Uint8Array(65 ** 2).fill(1),
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 20, outputSpacingM: 20 };
  const baked = await bakeTerrain(source, { id: 'feature-pressure', camera });
  const manifest = JSON.parse(await readFile(new URL('../src/assets/range/v2/materials/wet-conifer.json', import.meta.url), 'utf8'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(String(url).endsWith('.json') ? JSON.stringify(baked.manifest) : baked.payload);
  const scenes = [];
  let referenceBytes;
  try {
    for (const mode of ['reference', 'warp']) {
      const fixture = scene({ mode, budgetBytes: 1e9 }), { s } = fixture;
      scenes.push(fixture);
      Object.assign(s, { budget: 'desktop', contextEpoch: 0, camera: new THREE.PerspectiveCamera(),
        _acquireMaterial: async () => ({ key: 'material', pack: { manifest: { ...manifest, rules: { ...manifest.rules, forestDensity: 0 } } }, textures: { roles: {} } }),
        _releaseMaterial: () => {} });
      let admission, gpuReservation, scratchAttempts = 0;
      const admitFeatures = s._admitMaterialFeatures.bind(s), reserve = s.residency.reserve.bind(s.residency);
      s._admitMaterialFeatures = (...args) => { admission = admitFeatures(...args); return admission; };
      s.residency.reserve = args => {
        if (args.key.startsWith('range:surface-scratch:')) {
          scratchAttempts++;
          if (mode === 'warp' && scratchAttempts === 1) {
            assert.ok(admission.extraBytes > 0, 'cache output and build scratch are admitted before the yield');
            assert.equal(s.residency.entries.get(gpuReservation.key).bytes, referenceBytes + admission.extraBytes);
            return null;
          }
        }
        const reservation = reserve(args);
        if (args.key.startsWith('range:terrain-gpu:')) gpuReservation = reservation;
        return reservation;
      };
      const p = await s.prepare({ id: 'feature-pressure', camera, terrainManifestUrl: 'fixture.json' }, { baseUrl: 'http://test/' });
      const entry = s.residency.entries.get(p.gpuKey);
      if (mode === 'reference') referenceBytes = entry.bytes;
      assert.equal(entry.bytes, referenceBytes, 'the final terrain charge contains no optional cache allowance');
      assert.equal(entry.id, gpuReservation.id, 'the original terrain reservation still owns the prepared view');
      assert.equal(entry.resource, p);
      assert.equal(scratchAttempts, mode === 'warp' ? 2 : 1);
      assert.equal(p.materialFeatureCache, null);
      assert.equal(p.material.userData.materialFeatures, 'reference');
      assert.equal(p.materialFeatureStatus.reason, mode === 'warp' ? 'budget-after-yield' : 'off');
      assert.equal(admission.extraBytes, 0);
      assert.equal(fixture.allocations(), 0, 'the dropped cache never allocates a GPU target');
      s.release('feature-pressure');
      assert.equal(s.residency.usedBytes, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const { s } of scenes) { s.release('feature-pressure'); s.renderer.dispose(); }
  }
});
