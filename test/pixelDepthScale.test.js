import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { SunShaftGL } from '../src/world/alpine/SunShaftGL.js';

function scene() {
  const s = Object.create(RangeScene.prototype);
  Object.assign(s, { THREE, pixelated: true, pixelScale: 'depth', target: null, sideTargets: { B: null },
    size: { width: 320, height: 180 }, edge: { samples: 0, capability: 4 }, ownership: { A: null, B: null },
    depthCache: { A: { frame: -1 }, B: { frame: -1 } }, mirrors: { A: null, B: null }, prepared: new Map(),
    renderer: { render() {}, setRenderTarget() {}, clear() {}, setClearColor() {}, setSize() {}, setPixelRatio() {} },
    camera: new THREE.PerspectiveCamera(35, 16 / 9, 20, 150000),
  });
  s._copy = s._createCopy();
  return s;
}

test('single-sample scenic targets own independent sampleable depth before shafts exist', () => {
  const s = scene();
  s.target = s._scenicTarget(320, 180);
  assert.ok(s.target.depthTexture?.isDepthTexture);
  assert.equal(s.target.depthTexture.minFilter, THREE.NearestFilter);
  assert.equal(s.target.depthTexture.magFilter, THREE.NearestFilter);
  assert.ok(s.ensureSide('B'));
  assert.ok(s.sideTargets.B.depthTexture?.isDepthTexture);
  assert.notEqual(s.target.depthTexture, s.sideTargets.B.depthTexture);
  const msaa = s._scenicTarget(320, 180, 4);
  assert.equal(msaa.depthTexture, null, 'preserve the existing multisample target path');
  msaa.dispose(); s.releaseSide(); s.target.dispose();
});

test('shaft lifetime borrows scenic depth without disposing or detaching it', () => {
  const s = scene(), targets = { A: s._scenicTarget(320, 180), B: s._scenicTarget(320, 180) };
  const depths = Object.values(targets).map(t => t.depthTexture);
  const disposed = [];
  Object.values(targets).forEach((t, i) => t.addEventListener('dispose', () => disposed.push(i)));
  for (let i = 0; i < 3; i++) {
    const effect = new SunShaftGL(THREE, targets);
    effect.dispose();
    assert.deepEqual(Object.values(targets).map(t => t.depthTexture), depths);
    assert.equal(disposed.length, 0, 'optional shafts never invalidate shared scenic FBOs');
  }
  Object.values(targets).forEach(t => t.dispose());
  assert.deepEqual(disposed, [0, 1], 'each base target is released by its owner once');
});

test('every copy resets depth state and only eligible scenic targets enable it', () => {
  const s = scene(), target = s._scenicTarget(320, 180);
  const u = s._copy.mesh.material.uniforms;
  s._copyTexture(target.texture, null, { target, camera: s.camera });
  assert.equal(u.uPixelDepthEnabled?.value, 1);
  assert.equal(u.uPixelDepth.value, target.depthTexture);
  assert.deepEqual(u.uPixelDepthSize.value.toArray(), [320, 180]);
  assert.deepEqual(u.uPixelCameraRange.value.toArray(), [20, 150000]);
  for (const opt of [null, { target: { ...target, depthTexture: null }, camera: s.camera },
    { target, camera: { near: 0, far: 150000 } }]) {
    s._copyTexture(target.texture, null, opt);
    assert.equal(u.uPixelDepthEnabled.value, 0);
    assert.equal(u.uPixelDepth.value, null);
    assert.deepEqual(u.uPixelDepthSize.value.toArray(), [1, 1]);
    assert.deepEqual(u.uPixelCameraRange.value.toArray(), [1, 2]);
  }
  for (const [pixelated, pixelScale] of [[true, 'original'], [false, 'depth']]) {
    s.pixelated = pixelated; s.pixelScale = pixelScale;
    s._copyTexture(target.texture, null, { target, camera: s.camera });
    assert.equal(u.uPixelDepthEnabled.value, 0);
  }
  target.dispose();
});

test('scale changes update policy without reallocating scenic targets', () => {
  const s = scene();
  const request = { widthPx: 320, heightPx: 180, pixelated: true, pixelScale: 'depth' };
  s.resize(request);
  const target = s.target;
  s.resize({ ...request, pixelScale: 'original' });
  assert.equal(s.pixelScale, 'original');
  assert.equal(s.target, target);
  s.resize(request);
  assert.equal(s.pixelScale, 'depth');
  assert.equal(s.target, target);
  target.dispose();
});

test('missing depth support keeps a working colour target and disables depth sampling', () => {
  const s = scene();
  s.THREE = { ...THREE, DepthTexture: class { constructor() { throw new Error('depth unavailable'); } } };
  const target = s._scenicTarget(320, 180);
  assert.ok(target.texture);
  assert.equal(target.depthTexture, null);
  s._copyTexture(target.texture, null, { target, camera: s.camera });
  assert.equal(s._copy.mesh.material.uniforms.uPixelDepthEnabled.value, 0);
  target.dispose();
});

test('resize and context loss release both depth-owning scenic targets once and recreate fresh attachments', () => {
  const s = scene();
  s.materials = new Map();
  s.resize({ widthPx: 320, heightPx: 180, pixelated: true }); s.ensureSide('B');
  const first = [s.target, s.sideTargets.B], released = [];
  first.forEach((t, i) => t.addEventListener('dispose', () => released.push(i)));
  const effect = new SunShaftGL(THREE, { A: s.target, B: s.sideTargets.B });
  s.shafts = effect;
  s.resize({ widthPx: 640, heightPx: 360, pixelated: true });
  assert.deepEqual(released, [0, 1]);
  assert.ok(s.target.depthTexture?.isDepthTexture);
  assert.notEqual(s.target.depthTexture, first[0].depthTexture);
  assert.equal(s.sideTargets.B, null);
  assert.equal(s.shafts, null);
  let disposalCount = 0;
  s.target.addEventListener('dispose', () => disposalCount++);
  s._invalidateContext();
  assert.equal(disposalCount, 1);
  assert.equal(s.target, null);
  s.resize({ widthPx: 320, heightPx: 180, pixelated: true });
  assert.ok(s.target.depthTexture?.isDepthTexture);
  s.target.dispose();
});

test('scenic A/B copies use that side depth and the newly set camera with no added draws', () => {
  const s = scene();
  s.target = s._scenicTarget(320, 180); s.ensureSide('B');
  const copied = [], draws = [];
  s.renderer.render = scene => draws.push(scene);
  s.stats = { depthPasses: 0, partitions: 0 };
  for (const [id, far] of [['a', 150000], ['b', 80000]]) s.prepared.set(id, {
    view: { id, far }, depthScene: { depth: id }, scenes: { far: { color: id } },
    uniforms: { uNarrativeInk: { value: 0 }, uBackdropAmount: { value: 1 }, uDiag: { value: 0 } },
  });
  s._setCamera = view => { s.camera.far = view.far; };
  s._setUniforms = () => {}; s._prepareMirror = () => {};
  const copy = s._copyTexture;
  s._copyTexture = function (...args) {
    copy.apply(this, args);
    const u = this._copy.mesh.material.uniforms;
    copied.push([u.uPixelDepth?.value, u.uPixelCameraRange?.value.y]);
  };
  const frame = { frameId: 1, qualityLevel: 3 };
  s.renderPartition(frame, 'far', 'a', { side: 'A' });
  s.renderPartition(frame, 'far', 'b', { side: 'B' });
  s.renderPartition(frame, 'far', 'a', { side: 'A' });
  assert.deepEqual(copied, [[s.target.depthTexture, 150000], [s.sideTargets.B.depthTexture, 80000], [s.target.depthTexture, 150000]]);
  assert.equal(draws.length, 8, 'two cached depth passes, three colour passes, three existing copies');
  s.releaseSide(); s.target.dispose();
});
