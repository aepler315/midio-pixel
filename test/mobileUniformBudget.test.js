import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

// Conservative vector allocation: arrays consume a vector per element,
// even for scalar/vec2 values. Include Three's fragment prefix (mat4 + vec3 + bool).
function uniformVectors(source) {
  let vectors = 6;
  const declarations=source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'');
  for (const [, type, names] of declarations.matchAll(/uniform\s+(\w+)\s+([^;]+);/g)) {
    for (const name of names.split(',')) {
      const array = name.match(/\[(\d+)\]/);
      vectors += Number(array?.[1] || 1) * ({ mat2: 2, mat3: 3, mat4: 4 }[type] || 1);
    }
  }
  return vectors;
}

test('uniform-budget scanning ignores prose and commented declarations',()=>{
  assert.equal(uniformVectors('// uniform when one derivative vanishes, and another;\nuniform vec4 active;'),7);
  assert.equal(uniformVectors('/* uniform vec4 unused[1000]; */ uniform mat3 matrix; uniform vec2 pair[2];'),11);
});

test('terrain fragment uniforms fit the Adreno 256-vector limit with headroom', () => {
  const vectors=uniformVectors(SCENE_FRAG);
  assert.ok(vectors <= 248, `terrain requires at most ${vectors} vectors; Adreno limit is 256`);
});

test('all 64 cloud shapes retain radius and opacity in paired vector slots', async () => {
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const { cloudUniforms, cloudPuffs } = await import('../src/world/alpine/CloudOcclusion.js');
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 100000);
  camera.lookAt(0, 0, 100); camera.updateMatrixWorld();
  const banks = [{ x: 320, y: 80, w: 400, h: 20, alpha: .4, puffs: 64 }];
  const options = { width: 640, height: 360 };
  const u = cloudUniforms(THREE);
  RangeScene.prototype._setCloudUniforms.call({ camera, skyClouds: { banks, options } }, { uniforms: u }, { light: { celestial: { body: 'moon' } } });
  assert.equal(u.uCloudCount.value, 64);
  assert.equal(u.uCloudShape.value.length, 32);
  const e = camera.matrixWorld.elements;
  const forward = [-e[8], -e[9], -e[10]], eyeM = camera.position.toArray();
  const expected = cloudPuffs(banks, { ...options, pose: { eyeM, targetM: eyeM.map((v,k) => v + forward[k]), fovYDeg: camera.fov } });
  for (let i = 0; i < 64; i++) {
    const v = u.uCloudShape.value[Math.floor(i / 2)];
    assert.equal(v.getComponent((i % 2) * 2), expected[i].radiusYM);
    assert.equal(v.getComponent((i % 2) * 2 + 1), expected[i].opacity);
  }
});

test('packed water gusts preserve every forest age, strength and direction', async () => {
  const THREE = await import('../src/vendor/range/three-range.module.js');
  const { sceneUniforms, syncGustUniforms } = await import('../src/world/alpine/TerrainMaterial.js');
  const u = sceneUniforms(THREE, {});
  assert.equal(typeof syncGustUniforms, 'function');
  for (let i = 0; i < u.uGustAge.value.length; i++) {
    u.uGustAge.value[i] = i * .7 - 2;
    u.uGustAmp.value[i] = i / 5;
    u.uGustDir.value[i] = i % 2 ? -1 : 1;
  }
  syncGustUniforms(u);
  for (let i = 0; i < u.uGustAge.value.length; i++) {
    assert.deepEqual(u.uWaterGust.value[i].toArray(), [u.uGustAge.value[i], u.uGustAmp.value[i], u.uGustDir.value[i]]);
  }
});
