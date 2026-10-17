import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createSceneMaterial, SCENE_FRAG, SCENE_VERT } from '../src/world/alpine/TerrainMaterial.js';
import { terrainShadingMode, terrainShadingForView, moranTerrainFragment } from '../src/world/alpine/TerrainShadingExperiment.js';

test('Moran shading explicitly selects a distinct shader without changing terrain geometry', () => {
  const baseline = createSceneMaterial(THREE, {});
  const candidate = createSceneMaterial(THREE, {}, { terrainShading: 'moran' });
  assert.notEqual(candidate.fragmentShader, baseline.fragmentShader, 'opt-in must reach the terrain shader');
  assert.equal(candidate.vertexShader, SCENE_VERT, 'silhouette/deformation must stay unchanged');
  assert.equal(baseline.fragmentShader, SCENE_FRAG);
  baseline.dispose(); candidate.dispose();
});

test('the URL opt-in is strict, view-local and independent of pixel scaling', () => {
  for (const scale of ['original', 'depth']) {
    assert.equal(terrainShadingMode(`?pixelScale=${scale}`), 'off');
    const mode = terrainShadingMode(`?pixelScale=${scale}&terrainShading=moran`);
    assert.equal(terrainShadingForView(mode, 'teton-jackson-lake'), 'moran');
    for (const view of ['teton-range-tour', 'teton-jackson-lake-coherent', 'nc-ross-lake-north', undefined])
      assert.equal(terrainShadingForView(mode, view), 'off');
  }
  for (const value of ['1', 'true', 'MORAN', 'off', 'strong'])
    assert.equal(terrainShadingMode(`?terrainShading=${value}`), 'off');
});

test('a drifted shader fails explicitly instead of silently capturing an unchanged candidate', () => {
  assert.throws(() => moranTerrainFragment(SCENE_FRAG.replace('      nShade = normalize(n + detail);', '')), /anchor/);
});

test('off and unsupported shading choices use the original shader and uniforms', () => {
  const uniforms = { existing: { value: 7 } };
  for (const terrainShading of [undefined, 'off', 'stronger', true]) {
    const m = createSceneMaterial(THREE, uniforms, { terrainShading });
    assert.equal(m.fragmentShader, SCENE_FRAG);
    assert.equal(m.uniforms, uniforms, 'no experimental textures or uniforms allocated');
    assert.deepEqual(m.defines, { FAR_FOREST_KMAX: 8 });
    m.dispose();
  }
});
