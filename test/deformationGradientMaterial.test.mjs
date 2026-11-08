import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { createSceneMaterial, createDepthMaterial } from '../src/world/alpine/TerrainMaterial.js';

test('the default factored gradient retains an explicit reference and the exact same vertex deformation', () => {
  const reference = createSceneMaterial(THREE, {}, { deformationGradient: 'reference' });
  const candidate = createSceneMaterial(THREE, {});
  const depth = createDepthMaterial(THREE, {});
  try {
    assert.equal(reference.userData.deformationGradient, 'reference');
    assert.equal(reference.defines.FACTORED_DEFORM_GRAD, undefined);
    assert.equal(candidate.userData.deformationGradient, 'factored');
    assert.equal(candidate.defines.FACTORED_DEFORM_GRAD, 1);
    assert.equal(candidate.vertexShader, reference.vertexShader);
    assert.equal(candidate.vertexShader, depth.vertexShader);
    assert.equal(candidate.fragmentShader, reference.fragmentShader);
    assert.deepEqual(Object.keys(candidate.uniforms), Object.keys(reference.uniforms));
  } finally { reference.dispose(); candidate.dispose(); depth.dispose(); }
});

test('river and mobile pixel materials can use the pilot without changing their other variants', () => {
  const material = createSceneMaterial(THREE, {}, { deformationGradient: 'factored',
    riverSurface: true, pixelated: true, budget: 'mobile', mappedWaterOnly: true });
  try {
    assert.equal(material.defines.FACTORED_DEFORM_GRAD, 1);
    assert.equal(material.defines.RIVER_SURFACE, 1);
    assert.equal(material.defines.PIXEL_MATERIAL_SKIP, 1);
    assert.equal(material.defines.MAPPED_WATER_ONLY, 1);
    assert.equal(material.defines.FAR_FOREST_KMAX, 4);
  } finally { material.dispose(); }
});

test('unknown gradient options retain the reference material', () => {
  const material = createSceneMaterial(THREE, {}, { deformationGradient: 'unknown' });
  try {
    assert.equal(material.userData.deformationGradient, 'reference');
    assert.equal(material.defines.FACTORED_DEFORM_GRAD, undefined);
  } finally { material.dispose(); }
});
