import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import * as THREE from '../src/vendor/range/three-range.module.js';

function fixture({ ink = 0, actor = false, shafts = false } = {}) {
  const camera = new THREE.PerspectiveCamera(), draws = [];
  const p = { view: {}, uniforms: sceneUniforms(THREE, {}), forest: { counts: { billboard: 1 } },
    actors: { groups: { light: { visible: actor } } }, depthScene: 'depth',
    scenes: { far: 'far', mid: 'mid', near: 'near' } };
  p.uniforms.uNarrativeInk.value = ink;
  const renderer = { setRenderTarget() {}, setClearColor() {}, clear() {},
    render(scene, cam) { draws.push([scene, cam.layers.mask]); } };
  const s = Object.assign(Object.create(RangeScene.prototype), { camera, renderer, target: {}, canvas: {},
    size: { width: 256, height: 256 }, prepared: new Map([['probe', p]]), depthCache: { A: { frame: -1 } },
    stats: { depthPasses: 0 }, _copy: { mesh: { material: { uniforms: { uColor: {} } } }, scene: 'copy', camera },
    _setCamera() {}, _setUniforms() {}, _prepareMirror() {}, _setCanvasSize() {} });
  if (shafts) s.shafts = { render() { draws.push(['shafts', 0]); }, compositeToScreen() {} };
  return { s, draws };
}
const frame = { frameId: 1, qualityLevel: 0, light: { celestial: { body: 'sun', visibility: 1, intensity: 1, xFrac: .5, yFrac: .2 } } };

function snapshotFixture({ budgetBytes = 1024 ** 2, ...options } = {}) {
  const f = fixture({ actor: true, ...options }), { s } = f;
  s.THREE = THREE;
  s.singleStage = s.pixelated = true;
  s.contextEpoch = 0;
  s.residency = new GraphicsResidency({ budgetBytes });
  let bound = null;
  const copied = [], states = [], allocated = [];
  const target = () => ({ width: 256, height: 256, samples: 0, texture: {},
    depthTexture: { isDepthTexture: true, pixels: [] }, disposed: false,
    dispose() { this.disposed = true; } });
  s.target = target();
  s._scenicTarget = () => {
    assert.ok(s.residency.pendingBytes > 0, 'reserve before creating a snapshot target');
    const created = target(); allocated.push(created); return created;
  };
  s.renderer.setRenderTarget = t => { bound = t; };
  s.renderer.initRenderTarget = () => { bound = null; };
  s.renderer.copyTextureToTexture = (source, destination) => {
    destination.pixels = [...source.pixels]; copied.push([source, destination]); bound = null;
  };
  const render = s.renderer.render;
  s.renderer.render = (scene, camera) => {
    if (scene !== 'copy') assert.equal(bound, s.target, 'the copy helper must rebind the active scenic target');
    const layer = camera.layers.mask;
    if (scene === 'depth') bound.depthTexture.pixels = layer === 1 ? [0x123456, 0xabcdef] : [0x111111, 0xaaaaaa];
    else if (scene !== 'copy') states.push([scene, layer, [...bound.depthTexture.pixels]]);
    render(scene, camera);
  };
  return { ...f, copied, states, allocated, target };
}

test('native bands restore exact opaque depth while retaining every soft crown and hard forest pass', () => {
  const baseline = snapshotFixture();
  baseline.s.reuseOpaqueDepth = false;
  const cached = snapshotFixture();
  for (const f of [baseline, cached]) for (const pass of ['far', 'mid', 'near']) f.s.renderPartition(frame, pass, 'probe');
  assert.deepEqual(cached.states, baseline.states, 'each colour pass sees the identical opaque or forest depth values');
  assert.equal(cached.s.stats.depthPasses, 1);
  assert.deepEqual(cached.draws.filter(([scene, mask]) => scene === 'depth' && mask === 4), Array(3).fill(['depth', 4]));
  assert.equal(cached.s.stats.opaqueDepthSaves, 1);
  assert.equal(cached.s.stats.opaqueDepthRestores, 2);
  assert.equal(cached.copied.length, 3);
  assert.equal(cached.allocated.length, 1);
});

test('opaque snapshots never restore a different song, occurrence, view, context, target or prepared geometry', () => {
  for (const change of [
    (f, next) => { next.generation = 2; },
    (f, next) => { next.frameId++; },
    (f, next) => { next.occurrenceId = 'return'; },
    f => { f.s.contextEpoch++; },
    f => { f.s.target = f.target(); },
    f => { f.s.prepared.set('probe', { ...f.s.prepared.get('probe') }); },
    f => { f.s.prepared.set('other', f.s.prepared.get('probe')); return 'other'; },
  ]) {
    const f = snapshotFixture();
    f.s.renderPartition({ ...frame, generation: 1 }, 'far', 'probe');
    const next = { ...frame, generation: 1 };
    const view = change(f, next) || 'probe';
    f.s.renderPartition(next, 'mid', view);
    assert.equal(f.s.stats.depthPasses, 2);
    assert.equal(f.s.stats.opaqueDepthRestores || 0, 0);
  }
});

test('a denied or unsupported opaque snapshot keeps the complete native draw path', () => {
  for (const unavailable of [
    f => { f.s.residency.budgetBytes = 0; },
    f => { f.s.renderer.copyTextureToTexture = undefined; },
    f => { f.s.renderer.initRenderTarget = undefined; },
    f => { f.s.target.samples = 4; },
    f => { f.s.singleStage = false; },
    f => { f.s.pixelated = false; },
  ]) {
    const f = snapshotFixture(); unavailable(f);
    for (const pass of ['far', 'mid', 'near']) f.s.renderPartition(frame, pass, 'probe');
    assert.equal(f.s.stats.depthPasses, 3);
    assert.equal(f.allocated.length, 0);
    assert.equal(f.states.length, 9);
  }
});

test('a failed depth copy rebuilds opaque depth and retires its snapshot', () => {
  const baseline = snapshotFixture(); baseline.s.reuseOpaqueDepth = false;
  for (const pass of ['far', 'mid', 'near']) baseline.s.renderPartition(frame, pass, 'probe');
  for (const failedCopy of [1, 2]) {
    const f = snapshotFixture(), copy = f.s.renderer.copyTextureToTexture;
    let attempts = 0;
    f.s.renderer.copyTextureToTexture = (...args) => {
      if (++attempts === failedCopy) throw Error('copy unavailable');
      copy(...args);
    };
    for (const pass of ['far', 'mid', 'near']) f.s.renderPartition(frame, pass, 'probe');
    assert.deepEqual(f.states, baseline.states);
    assert.ok(f.s.stats.depthPasses >= 2);
    assert.equal(f.allocated[0].disposed, true);
    assert.equal(f.s.residency.pendingBytes, 0);
  }
});

test('snapshot eviction rebuilds the next partition and native travel keeps its own scoped depth', () => {
  const f = snapshotFixture();
  f.s.renderPartition(frame, 'far', 'probe');
  f.s.residency.release('range:opaque-depth-A');
  f.s.renderPartition(frame, 'mid', 'probe');
  assert.equal(f.s.stats.depthPasses, 2);
  assert.equal(f.allocated[0].disposed, true);
  const travel = snapshotFixture();
  travel.s.prepared.get('probe').depthScenes = {};
  travel.s._travelFringe = () => {};
  travel.s._travelDepth = (_p, target) => {
    travel.s.renderer.setRenderTarget(target);
    target.depthTexture.pixels = travel.s.camera.layers.mask === 1 ? [0x123456, 0xabcdef] : [0x111111, 0xaaaaaa];
  };
  for (const pass of ['far', 'mid', 'near']) travel.s.renderPartition(frame, pass, 'probe', { bandColumns: {} });
  assert.equal(travel.allocated.length, 0);
  assert.equal(travel.states.length, 9);
});

test('a native frame without hard forest consumers allocates no depth snapshot', () => {
  const f = snapshotFixture({ actor: false });
  for (const pass of ['far', 'mid', 'near']) f.s.renderPartition(frame, pass, 'probe');
  assert.equal(f.s.stats.depthPasses, 1);
  assert.equal(f.allocated.length, 0);
});

test('context invalidation and scene disposal release opaque snapshots', () => {
  for (const lifecycle of ['_invalidateContext', 'dispose']) {
    const f = snapshotFixture();
    f.s.renderPartition(frame, 'far', 'probe');
    for (const method of ['releaseCrestProbe', 'releaseWaterTarget', 'releaseShafts', 'releaseBackdrop', 'releaseMirror', 'releaseGroundTarget']) f.s[method] = () => {};
    f.s.release = id => f.s.prepared.delete(id);
    f.s._copy.mesh.geometry = { dispose() {} };
    f.s._copy.mesh.material.dispose = () => {};
    f.s.renderer.dispose = () => {};
    f.s.depthCache.B = { frame: -1 };
    f.s.sideTargets = { B: null };
    f.s[lifecycle]();
    assert.equal(f.s.residency.usedBytes, 0);
    assert.equal(f.allocated[0].disposed, true);
    assert.equal(f.s.opaqueDepth.A, null);
  }
});

test('retiring a view releases its opaque snapshot before a treeless or travel view follows', () => {
  for (const retirement of ['release', 'evict', 'dispose']) {
    const f = snapshotFixture(), { s } = f, p = s.prepared.get('probe');
    s._releaseMaterial = () => {};
    p.forest.dispose = p.actors.dispose = () => {};
    p.gpuKey = 'probe-gpu';
    const reservation = s.residency.reserve({ key: p.gpuKey, bytes: 1, owner: 'range-terrain-gpu' });
    s.residency.commit(reservation, p, retired => s._retire('probe', retired));
    s.renderPartition(frame, 'far', 'probe');
    assert.equal(s.opaqueDepth.A.prepared, p);
    if (retirement === 'release') s.release('probe');
    else if (retirement === 'evict') s.residency.release(p.gpuKey);
    else s._disposePrepared(p);
    assert.equal(s.opaqueDepth.A, null, `${retirement} drops the prepared view reference`);
    assert.equal(s.residency.has('range:opaque-depth-A'), false);
    assert.equal(f.allocated[0].disposed, true);
    const next = { ...p, forest: { counts: {} } };
    s.prepared.set('next', next);
    s.renderPartition({ ...frame, frameId: 2 }, 'far', 'next', retirement === 'evict' ? { bandColumns: {} } : {});
    assert.equal(s.opaqueDepth.A, null);
    assert.equal(f.allocated.length, 1);
  }
});

test('a smooth cast cannot reuse depth from another occurrence of the same view', () => {
  const { s } = fixture({ actor: true });
  s.castInBands = false;
  const first = { ...frame, occurrenceId: 'first' };
  s.renderPartition(first, 'near', 'probe');
  assert.equal(s.renderCast({ ...frame, occurrenceId: 'return' }, 'probe'), null);
  assert.equal(s.renderCast(first, 'probe'), s.canvas);
});

test('empty post-forest stages retain opaque depth across all three partitions', () => {
  const { s, draws } = fixture();
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
  assert.equal(s.stats.depthPasses, 1);
  assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), [['depth', 1]]);
});

test('actor lights and visible ink invalidate combined depth before the next partition', () => {
  for (const options of [{ actor: true }, { ink: .005 }]) {
    const { s, draws } = fixture(options);
    for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
    assert.equal(s.stats.depthPasses, 3);
    assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), Array.from({ length: 3 }, () => [['depth', 1], ['depth', 4]]).flat());
  }
});

test('solar scattering sees hard forest depth, then the next partition rebuilds opaque depth', () => {
  const { s, draws } = fixture({ shafts: true });
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
  assert.equal(s.stats.depthPasses, 2);
  assert.deepEqual(draws.filter(([scene]) => ['depth', 'shafts'].includes(scene)), [['depth', 1], ['depth', 4], ['shafts', 0], ['depth', 1]]);
});

test('discarded ink and a disabled solar quality rung do not poison reusable opaque depth', () => {
  const { s, draws } = fixture({ ink: .004, shafts: true });
  for (const pass of ['far', 'mid', 'near']) s.renderPartition({ ...frame, qualityLevel: 6 }, pass, 'probe');
  assert.equal(s.stats.depthPasses, 1);
  assert.deepEqual(draws.filter(([scene]) => ['depth', 'shafts'].includes(scene)), [['depth', 1]]);
});

test('a stand containing only either mesh LOD uses soft coverage and hard depth for ink', () => {
  for (const kind of ['mesh', 'meshDetail']) {
    const { s, draws } = fixture({ ink: .02 });
    s.prepared.get('probe').forest.counts = { billboard: 0, mesh: 0, meshDetail: 0, [kind]: 1 };
    s.renderPartition(frame, 'near', 'probe');
    // Layer 3 (ink), with the cast (layers 4 and 5) where no smooth cast pass takes it.
    assert.deepEqual(draws.filter(([scene]) => scene === 'near'), [['near', 1], ['near', 2], ['near', 8 | 16 | 32]]);
    assert.deepEqual(draws.filter(([scene]) => scene === 'depth'), [['depth', 1], ['depth', 4]]);
  }
});

test('with a smooth cast pass the partitions leave the cast out, and it draws once after near against full depth', () => {
  const { s, draws } = fixture({ actor: true });
  s.renderer.clear = (...a) => draws.push(['clear', a.map(Number).join('')]);
  s.renderer.setRenderTarget = (t) => draws.push(['target', t === null ? 'canvas' : 'scene']);
  s.castInBands = false;
  assert.equal(s.renderCast(frame, 'probe'), null, 'nothing to draw before its near partition');
  for (const pass of ['far', 'mid', 'near']) s.renderPartition(frame, pass, 'probe');
  // The lanterns no longer cut combined depth into every partition.
  assert.equal(s.stats.depthPasses, 1);
  assert.ok(draws.every(([, mask]) => typeof mask !== 'number' || !(mask & 48)), 'no partition draws the cast layers');
  draws.length = 0;
  assert.equal(s.renderCast(frame, 'probe'), s.canvas);
  assert.deepEqual(draws, [
    ['target', 'scene'],
    ['depth', 4], // the trees' crown cut joins the opaque depth once
    ['clear', '100'], // colour only: every band's depth stays
    ['far', 32], ['mid', 32], ['near', 32], // every ribbon first (their overlaps keep the brightest)
    ['far', 16], ['mid', 16], ['near', 16], // then every light added over them
    ['target', 'canvas'], ['clear', '110'], ['copy', 9],
  ]);
  assert.equal(s.stats.castPasses, 1);
  assert.equal(s.renderCast(frame, 'probe'), null, 'one cast pass per near partition');
  // When the near partition already cut the crowns (ink), the cast reuses it.
  const inked = fixture({ actor: true, ink: .02 });
  inked.s.castInBands = false;
  for (const pass of ['far', 'mid', 'near']) inked.s.renderPartition(frame, pass, 'probe');
  inked.draws.length = 0;
  inked.s.renderCast(frame, 'probe');
  assert.deepEqual(inked.draws.filter(([scene]) => scene === 'depth'), []);
  assert.deepEqual(inked.draws.filter(([scene]) => ['far', 'mid', 'near'].includes(scene)), [['far', 32], ['mid', 32], ['near', 32], ['far', 16], ['mid', 16], ['near', 16]]);
});

test('placed lights alone (no lantern on screen) still draw after the crown cut, and a travel keeps the cast in its bands', () => {
  const { s, draws } = fixture();
  s.prepared.get('probe').actors.sites = { drawn: () => true };
  s.renderPartition(frame, 'near', 'probe');
  assert.deepEqual(draws.filter(([scene]) => scene === 'near'), [['near', 1], ['near', 2], ['near', 8 | 16 | 32]]);
  // Laid out but dark (none kindled yet, or the cast absent): no crown cut
  // and no cast pass for nothing.
  const dark = fixture();
  dark.s.prepared.get('probe').actors.sites = { drawn: () => false };
  dark.s.renderPartition(frame, 'near', 'probe');
  assert.deepEqual(dark.draws.filter(([scene]) => scene === 'depth'), [['depth', 1]]);
  dark.s.castInBands = false;
  assert.equal(dark.s.renderCast(frame, 'probe'), null);
  const smooth = fixture();
  smooth.s.castInBands = false;
  smooth.s.prepared.get('probe').actors.sites = { drawn: () => true };
  smooth.s.renderPartition(frame, 'near', 'probe');
  assert.equal(smooth.s.renderCast(frame, 'probe'), smooth.s.canvas);
  const travel = fixture({ actor: true });
  travel.s.castInBands = false;
  travel.s.prepared.get('probe').depthScenes = { far: 'depth-far', mid: 'depth-mid', near: 'depth-near' };
  travel.s._travelDepth = () => {};
  travel.s._travelFringe = () => {};
  travel.s.renderPartition(frame, 'near', 'probe', { bandColumns: { mid: [0, 1], near: [0, 1] } });
  assert.deepEqual(travel.draws.filter(([scene]) => scene === 'near').at(-1), ['near', 8 | 16 | 32]);
  assert.equal(travel.s.renderCast(frame, 'probe'), null);
});

test('the lake mirror reflects the cast with every band, soft forest or not', () => {
  for (const soft of [true, false]) {
    const { s, draws } = fixture();
    const p = s.prepared.get('probe');
    if (!soft) p.forest.counts = { billboard: 0 };
    p.mirrorLevelM = 1000;
    s.THREE = THREE;
    s.mirrorCamera = new THREE.PerspectiveCamera();
    s.camera.position.set(0, 1500, 0); s.camera.updateMatrixWorld();
    s._ensureMirror = () => ({ target: { width: 64, height: 64, texture: {} }, matrix: new THREE.Matrix4(), frame: -1, view: null });
    s._updateForestDetail = () => {};
    s.renderer.render = (scene, cam) => draws.push([scene, cam.layers.mask, cam === s.mirrorCamera]);
    RangeScene.prototype._prepareMirror.call(s, p, { ...frame, narrative: null }, 'A', 'probe');
    const mirrored = draws.filter(([scene, , mirror]) => mirror && ['far', 'mid', 'near'].includes(scene));
    assert.ok(mirrored.length >= 3);
    assert.ok(mirrored.some(([, mask]) => mask & 16), `${soft ? 'soft' : 'plain'} forest: the cast is reflected`);
  }
});
