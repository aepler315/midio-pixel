import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';

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

test('view disposal retires both drainage textures once', () => {
  const { scene, p } = fixture();
  scene._releaseOpaqueDepth = () => {};
  const disposed = [];
  p.mistFlow.texture.addEventListener('dispose', () => disposed.push('rail'));
  p.tourMistFlow.texture.addEventListener('dispose', () => disposed.push('tour'));
  scene._disposePrepared(p);
  assert.deepEqual(disposed, ['rail', 'tour']);
});
