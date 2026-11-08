import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { createSceneMaterial, sceneUniforms } from '../src/world/alpine/TerrainMaterial.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { recordingWebGL2 } from './helpers/recordingWebGL2.mjs';

function preparedUniforms() {
  const target = new THREE.WebGLRenderTarget(40, 24, { depthBuffer: false });
  target.texture.userData.materialFeatures = { version: 1, mode: 'warp', width: 40, height: 24, originCell: [-1, -21] };
  const uniforms = sceneUniforms(THREE, { uGridOrigin: { value: new THREE.Vector2() } });
  uniforms.tSoil.value = target.texture; uniforms.sSoil.value = -1; uniforms.sCanopy.value = -21;
  return { target, uniforms };
}

test('ordinary scene construction enables every distillation path without URL switches', () => {
  const { canvas } = recordingWebGL2(64, 64);
  const scene = new RangeScene({ THREE, canvas, residency: new GraphicsResidency({ budgetBytes: 512 * 1024 ** 2 }) });
  try {
    assert.equal(scene.deformationGradient, 'factored');
    assert.equal(scene.materialFeatures, 'warp');
    assert.equal(scene.canopySummary, true);
  } finally { scene.dispose(); }
});

test('a prepared default material combines gradients, cached features and canopy summaries', () => {
  const { target, uniforms } = preparedUniforms();
  const active = createSceneMaterial(THREE, uniforms);
  const reference = createSceneMaterial(THREE, uniforms, { deformationGradient: 'reference', materialFeatures: 'reference', canopySummary: false });
  try {
    for (const key of ['FACTORED_DEFORM_GRAD', 'MATERIAL_FEATURE_CACHE', 'CANOPY_SUMMARY']) {
      assert.equal(active.defines[key], 1, key);
      assert.equal(reference.defines[key], undefined, key);
    }
    assert.equal(active.vertexShader, reference.vertexShader);
    assert.deepEqual(Object.keys(active.uniforms), Object.keys(reference.uniforms));
  } finally { active.dispose(); reference.dispose(); target.dispose(); }
});

test('a missing feature cache keeps the other default optimizations active', () => {
  const material = createSceneMaterial(THREE, sceneUniforms(THREE, {}));
  try {
    assert.equal(material.defines.FACTORED_DEFORM_GRAD, 1);
    assert.equal(material.defines.CANOPY_SUMMARY, 1);
    assert.equal(material.defines.MATERIAL_FEATURE_CACHE, undefined);
    assert.equal(material.userData.materialFeatures, 'reference');
  } finally { material.dispose(); }
});
