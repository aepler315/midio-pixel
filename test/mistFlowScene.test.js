import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { SiteLights } from '../src/world/alpine/ActorsGL.js';
import { createForest } from '../src/world/alpine/ForestGL.js';

function fixture() {
  const scene = Object.create(RangeScene.prototype);
  const make = (min, max, distanceM) => ({ texture: new THREE.Texture(), field: { heightRange: [min, max], distanceM } });
  const p = { uniforms: sceneUniforms(THREE, {}), mistFlow: make(200, 1800, 4000),
    tourMistFlow: make(100, 2600, 9000), terrainMode: 'rail' };
  return { scene, p };
}

test('mist binds the active rail/tour drainage field and decodes height as minimum plus span', () => {
  const { scene, p } = fixture();
  assert.equal(scene._setMistFlow(p), p.mistFlow.field);
  assert.equal(p.uniforms.uMistFlow.value, p.mistFlow.texture);
  assert.deepEqual(p.uniforms.uMistFlowHeight.value.toArray(), [200, 1600]);
  assert.equal(p.uniforms.uMistFlowDistanceM.value, 4000);
  assert.equal(p.uniforms.uMistFlowOn.value, 1);
  p.terrainMode = 'tour';
  assert.equal(scene._setMistFlow(p), p.tourMistFlow.field);
  assert.equal(p.uniforms.uMistFlow.value, p.tourMistFlow.texture);
  assert.deepEqual(p.uniforms.uMistFlowHeight.value.toArray(), [100, 2500]);
  assert.equal(p.uniforms.uMistFlowDistanceM.value, 9000);
});

test('missing drainage binds a clear fallback without a stale texture or camera-relative slab', () => {
  const { scene, p } = fixture();
  scene._setMistFlow(p);
  p.mistFlow = null;
  assert.equal(scene._setMistFlow(p), null);
  assert.equal(p.uniforms.uMistFlow.value, null);
  assert.equal(p.uniforms.uMistFlowOn.value, 0);
});

test('one packed mist-flow value follows the shared CPU references in main and reflected draws', () => {
  const { scene, p } = fixture(), u = p.uniforms;
  assert.ok(u.uMistFlowParams, 'flow metadata has no compact GPU value');
  const packed = u.uMistFlowParams.value;
  const lights = new SiteLights(THREE, u);
  const forest = createForest(THREE, { mesh: new Float32Array(), billboard: new Float32Array(), stride: 8, count: 0 }, u);
  for (const key of ['uMistFlowHeight', 'uMistFlowDistanceM', 'uMistFlowOn', 'uMistFlowParams']) {
    assert.equal(lights.uniforms[key], u[key], `lights keep ${key} by reference`);
    assert.equal(forest.uniforms[key], u[key], `forest keeps ${key} by reference`);
  }
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 100000);
  camera.position.set(300, 2600, 3000); camera.lookAt(0, 200, 0); camera.updateMatrixWorld();
  const mirror = { target: { texture: new THREE.Texture(), width: 320, height: 180 }, matrix: new THREE.Matrix4(), frame: -1 };
  let expected, reflectedDraws = 0;
  Object.assign(scene, { THREE, camera, mirrorCamera: new THREE.PerspectiveCamera(), size: { width: 640, height: 360 }, stats: {},
    _ensureMirror: () => mirror, renderer: { setRenderTarget() {}, setClearColor() {}, clear() {}, render(_surface, reflected) {
      assert.notEqual(reflected, camera, 'the production mirror really uses the reflected camera');
      assert.deepEqual(u.uMistFlowParams.value.toArray(), expected);
      assert.equal(u.uMistFlowParams.value, packed, 'the upload reuses its vector');
      reflectedDraws++;
    } } });
  Object.assign(p, { mirrorLevelM: 200, depthScene: {}, scenes: { far: {}, mid: {}, near: {} } });
  for (const [mode, want] of [['rail', [200, 1600, 4000, 1]], ['tour', [100, 2500, 9000, 1]]]) {
    p.terrainMode = mode; expected = want; scene._setMistFlow(p);
    assert.deepEqual(u.uMistFlowParams.value.toArray(), want, 'the main draw sees the selected field');
    scene._prepareMirror(p, { qualityLevel: 0, frameId: reflectedDraws + 1 }, 'A', 'view');
    assert.deepEqual(u.uMistFlowParams.value.toArray(), want, 'the main value survives mirror restoration');
  }
  assert.ok(reflectedDraws >= 8, 'both fields reached the reflected depth and color draws');
  // Direct CPU consumers may still edit the original uniform objects.
  u.uMistFlowHeight.value.set(-50, 300); u.uMistFlowDistanceM.value = 700; u.uMistFlowOn.value = 0;
  assert.deepEqual(u.uMistFlowParams.value.toArray(), [-50, 300, 700, 0]);
  p.mistFlow = p.tourMistFlow = null; scene._setMistFlow(p);
  assert.deepEqual(u.uMistFlowParams.value.toArray(), [0, 1, 1, 0], 'missing data clears every packed lane');
  forest.dispose(); lights.dispose(); mirror.target.texture.dispose();
});

test('view disposal retires both drainage textures once', () => {
  const { scene, p } = fixture();
  scene._releaseOpaqueDepth = () => {};
  const disposed = [];
  p.mistFlow.texture.addEventListener('dispose', () => disposed.push('rail'));
  p.tourMistFlow.texture.addEventListener('dispose', () => disposed.push('tour'));
  scene._disposePrepared(p);
  assert.deepEqual(disposed, ['rail', 'tour']);
});
