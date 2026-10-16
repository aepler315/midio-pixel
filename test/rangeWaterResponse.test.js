import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { validateMaterialManifest } from '../src/world/alpine/MaterialPackage.js';
import { applyMaterial, sceneUniforms, SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../src/assets/range/v2/materials/wet-conifer.json', import.meta.url), 'utf8'));
const pack = { manifest };
const textures = { roles: {} };

test('water controls reject non-finite and out-of-range pack rules and view overrides', () => {
  for (const [key, invalid] of [['waterSkyMix', [-0.01, 1.01, NaN, Infinity, null, '0.5']],
    ['waterGlintGain', [-0.01, 3.01, NaN, Infinity, null, '1.5']]]) {
    for (const value of invalid) {
      const check = validateMaterialManifest({ ...manifest, rules: { ...manifest.rules, [key]: value } });
      assert.equal(check.ok, false, `${key}=${value} must reject the pack`);
      const uniforms = sceneUniforms(THREE, {});
      assert.throws(() => applyMaterial(uniforms, pack, textures, { [key]: value }),
        (e) => e.reason === 'manifest', `${key}=${value} must reject the view override`);
      assert.equal(uniforms.uHasMaterial.value, 0, 'invalid rules must not partially bind a material');
    }
  }
});

test('water boundaries and overrides bind without changing dry material uniforms', () => {
  const baseline = sceneUniforms(THREE, {});
  applyMaterial(baseline, pack, textures);
  assert.equal(baseline.rWaterSkyMix.value, 0.9);
  assert.equal(baseline.rWaterGlintGain.value, 3);
  for (const [sky, glint] of [[0, 0], [1, 3], [0.65, 1.5]]) {
    const uniforms = sceneUniforms(THREE, {});
    applyMaterial(uniforms, pack, textures, { waterSkyMix: sky, waterGlintGain: glint });
    assert.equal(uniforms.rWaterSkyMix.value, sky);
    assert.equal(uniforms.rWaterGlintGain.value, glint);
    for (const key of Object.keys(baseline).filter((k) => !k.startsWith('rWater'))) {
      assert.deepEqual(uniforms[key], baseline[key], `${key} changed with a water-only override`);
    }
    assert.equal(validateMaterialManifest({ ...manifest, rules: { ...manifest.rules, waterSkyMix: sky, waterGlintGain: glint } }).ok, true);
  }
});

test('omitted water rules reset the preceding view rather than retaining its audition', () => {
  const uniforms = sceneUniforms(THREE, {});
  applyMaterial(uniforms, { manifest: { ...manifest, rules: { ...manifest.rules, waterSkyMix: 0.2, waterGlintGain: 0.8 } } }, textures,
    { waterSkyMix: 0.65, waterGlintGain: 1.5 });
  assert.equal(uniforms.rWaterSkyMix.value, 0.65);
  assert.equal(uniforms.rWaterGlintGain.value, 1.5);
  applyMaterial(uniforms, pack, textures);
  assert.equal(uniforms.rWaterSkyMix.value, 0.9);
  assert.equal(uniforms.rWaterGlintGain.value, 3);
});

test('the production glint calculation emits no direct highlight with a zero key or gain', () => {
  // Execute the shader's scalar helper itself. Its operations have identical
  // scalar semantics in JS; no alternate CPU lighting implementation is used.
  const helper = SCENE_FRAG.match(/float waterGlint\(float cosine, float gain, float keyEnergy\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(helper, 'the water shader must expose its scalar highlight calculation');
  const glint = new Function('cosine', 'gain', 'keyEnergy', helper[1]
    .replace(/\bpow\(/g, 'Math.pow(').replace(/\bmax\(/g, 'Math.max('));
  assert.equal(glint(1, 3, 0), 0);
  assert.equal(glint(NaN, 3, 0), 0, 'an undefined half-vector cannot leak through a zero key');
  assert.equal(glint(NaN, 0, 1), 0);
  assert.equal(glint(1, 3, 1), 3);
  assert.equal(glint(1, 1.5, 1), 1.5);
  assert.equal(glint(-1, 3, 1), 0);
  assert.ok(glint(0.99, 3, 1) < 0.01, 'the source retains a concentrated glint');
});
