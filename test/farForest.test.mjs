import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as material from '../src/world/alpine/TerrainMaterial.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import * as THREE from '../src/vendor/range/three-range.module.js';

test('expected vertical-tree cover matches overhead area and saturates at grazing angles', () => {
  assert.equal(typeof material.expectedForestCover, 'function');
  const args = { forest: .7, radius: 3.5, crownHeight: 20, normal: [0, 1, 0] };
  const above = material.expectedForestCover({ ...args, toEye: [0, 1, 0] });
  assert.ok(Math.abs(above - (1 - Math.exp(-.7 / 169 * Math.PI * 3.5 ** 2))) < 1e-12);
  let previous = 1;
  for (let i = 0; i <= 100; i++) {
    // The prescribed .05 incidence floor bounds the grazing singularity;
    // test monotonicity where that floor no longer controls the denominator.
    const angle = Math.asin(.05) + i / 100 * (Math.PI / 2 - Math.asin(.05));
    const cover = material.expectedForestCover({ ...args, toEye: [Math.cos(angle), Math.sin(angle), 0] });
    assert.ok(cover <= previous + 1e-12); previous = cover;
  }
  assert.ok(material.expectedForestCover({ ...args, toEye: [1, 0, 0] }) > .99);
  assert.equal(material.expectedForestCover({ ...args, forest: 0, toEye: [1, 0, 0] }), 0);
});

test('mean crown traits follow Phase 2 vigor, species mix, mats, scale and tour cap', () => {
  assert.equal(typeof material.meanForestTraits, 'function');
  assert.ok(material.meanForestTraits({ below: 1000, slopeDeg: 10 }).height > 20);
  const tall = material.meanForestTraits({ below: 1000, slopeDeg: 10 });
  const scaled = material.meanForestTraits({ below: 1000, slopeDeg: 10, scale: .5 });
  assert.ok(Math.abs(scaled.height - tall.height * .5) < 1e-12);
  const mat = material.meanForestTraits({ below: 100, slopeDeg: 10 });
  assert.equal(mat.height, 4);
  assert.ok(Math.abs(mat.radius - 1.7) < 1e-12);
  assert.ok(material.meanForestTraits({ below: 1000, slopeDeg: 10, scale: 5, cap: 35 }).height <= 35);
});

test('ring handoff disables for absent, coarse, empty or narrative-hidden trees and uses every LOD', () => {
  assert.equal(typeof RangeScene.prototype._setFarForest, 'function');
  for (const kind of ['billboard', 'mesh', 'meshDetail']) {
    const p = { uniforms: material.sceneUniforms(THREE, {}), rules: { treeScale: .5 }, view: { tour: {} }, forest: { counts: { [kind]: 1 } } };
    RangeScene.prototype._setFarForest.call({}, p, { qualityLevel: 0 });
    assert.deepEqual(p.uniforms.uFarForest.value.toArray(), [6500, 7800, .5, 8]);
    for (const overrides of [{ forest: null }, { forest: { counts: { [kind]: 0 } } }, { activeWindow: { coarse: true } }]) {
      RangeScene.prototype._setFarForest.call({}, { ...p, ...overrides }, { qualityLevel: 0 });
      assert.deepEqual(p.uniforms.uFarForest.value.toArray().slice(0, 2), [0, 0]);
    }
    RangeScene.prototype._setFarForest.call({}, p, { qualityLevel: 0, narrative: { materials: .01 } });
    assert.deepEqual(p.uniforms.uFarForest.value.toArray().slice(0, 2), [0, 0]);
  }
});
