import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSceneMaterial, sceneUniforms, SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

const origin = [-12345, -8765];
function fixture() {
  const target = new THREE.WebGLRenderTarget(80, 60, { depthBuffer: false });
  target.texture.userData.materialFeatures = { version: 1, mode: 'warp', width: 80, height: 60,
    originCell: [Math.floor(origin[0] / 600) - 1, Math.floor(origin[1] / 600 - 19.7) - 1] };
  const uniforms = sceneUniforms(THREE, { uGridOrigin: { value: new THREE.Vector2(...origin) } });
  uniforms.tSoil.value = target.texture;
  uniforms.sSoil.value = target.texture.userData.materialFeatures.originCell[0];
  uniforms.sCanopy.value = target.texture.userData.materialFeatures.originCell[1];
  return { target, uniforms };
}

test('material feature sampling is default, validated and shares the exact vertex path', () => {
  const { target, uniforms } = fixture();
  const reference = createSceneMaterial(THREE, uniforms, { materialFeatures: 'reference' });
  const cached = createSceneMaterial(THREE, uniforms);
  try {
    assert.equal(reference.userData.materialFeatures, 'reference');
    assert.equal(reference.defines.MATERIAL_FEATURE_CACHE, undefined);
    assert.equal(cached.userData.materialFeatures, 'warp');
    assert.equal(cached.defines.MATERIAL_FEATURE_CACHE, 1);
    assert.equal(cached.vertexShader, reference.vertexShader);
    assert.equal(cached.fragmentShader, reference.fragmentShader);
    assert.deepEqual(Object.keys(cached.uniforms), Object.keys(reference.uniforms));
    assert.match(SCENE_FRAG, /detailPosition = cachedMaterialDetailPosition\(vWorld\)/);
  } finally { reference.dispose(); cached.dispose(); target.dispose(); }
});

test('ordinary soil images and wrong-origin feature maps cannot enable the cache', () => {
  const { target, uniforms } = fixture();
  const invalid = [new THREE.Texture(), null, target.texture];
  target.texture.userData.materialFeatures.originCell[0]++;
  try {
    for (const texture of invalid) {
      const material = createSceneMaterial(THREE, { ...uniforms, tSoil: { value: texture } }, { materialFeatures: 'warp' });
      try {
        assert.equal(material.userData.materialFeatures, 'reference');
        assert.equal(material.defines.MATERIAL_FEATURE_CACHE, undefined);
      } finally { material.dispose(); }
    }
  } finally { invalid[0].dispose(); target.dispose(); }
});

test('the cache composes with mobile pixel and river materials without extra samplers', () => {
  const { target, uniforms } = fixture();
  const material = createSceneMaterial(THREE, uniforms, { materialFeatures: 'warp', pixelated: true,
    riverSurface: true, budget: 'mobile' });
  try {
    assert.equal(material.defines.MATERIAL_FEATURE_CACHE, 1);
    assert.equal(material.defines.PIXEL_MATERIAL_SKIP, 1);
    assert.equal(material.defines.RIVER_SURFACE, 1);
    assert.equal(material.defines.FAR_FOREST_KMAX, 4);
    const names = [...SCENE_FRAG.matchAll(/uniform\s+sampler2D\s+(\w+)/g)].map(m => m[1]);
    assert.equal(names.length, 13);
    assert.equal(new Set(names).size, 13);
  } finally { material.dispose(); target.dispose(); }
});

test('feature format and uploaded integer-origin values must match the bake contract', () => {
  for (const change of [
    f => { f.uniforms.sSoil.value++; }, f => { f.uniforms.sCanopy.value--; },
    f => { f.target.texture.type = THREE.FloatType; },
    f => { f.target.texture.format = THREE.RedFormat; },
    f => { f.target.texture.colorSpace = THREE.SRGBColorSpace; },
    f => { f.target.texture.generateMipmaps = true; },
  ]) {
    const f = fixture(); change(f);
    const material = createSceneMaterial(THREE, f.uniforms, { materialFeatures: 'warp' });
    try {
      assert.equal(material.userData.materialFeatures, 'reference');
      assert.equal(material.defines.MATERIAL_FEATURE_CACHE, undefined);
    } finally { material.dispose(); f.target.dispose(); }
  }
});
