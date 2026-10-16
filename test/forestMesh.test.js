import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createForest } from '../src/world/alpine/ForestGL.js';

function definedMeshDerivatives(fragment) {
  const main = fragment.slice(fragment.lastIndexOf('void main()'));
  const discard = main.indexOf('discard');
  const derivatives = [...main.matchAll(/\b(?:fwidth|dFdx|dFdy)\s*\(/g)];
  return derivatives.length > 0 && derivatives.every(hit => hit.index < discard)
    && main.indexOf('meshCoverage()') < discard;
}

test('WP10 actual assembled mesh colour variants evaluate derivatives before divergent discard', () => {
  for (const partitioned of [false, true]) {
    const row = new Float32Array([0, 0, 100, 20, 6, 2, 0.5, 2]);
    const forest = createForest(THREE, { mesh: row, billboard: new Float32Array(), count: 1, stride: 8 }, {}, { partitioned });
    try {
      const materials = [...new Set(forest.byBand.near.map(mesh => mesh.material))];
      assert.ok(materials.length > 0);
      for (const material of materials) {
        const fragment = material.fragmentShader;
        assert.equal(definedMeshDerivatives(fragment), true, `variant ${JSON.stringify(material.defines)}`);
        const line = fragment.match(/ {4}float detail = [^\n]+/)[0];
        const invalid = fragment.replace(line, '').replace('discard;', `discard;\n${line}`);
        assert.equal(definedMeshDerivatives(invalid), false, 'negative control catches the original order');
      }
    } finally { forest.dispose(); }
  }
});

// The near-asset geometry contract (trunk winding, budgets, sprays instead of
// star whorls) lives in range-forest-assets.test.mjs.
test('both mesh LODs share colour/depth geometry, staged coverage and seven GPU floats', () => {
  const row = z => new Float32Array([0, 0, z, 20, 6, 2, .5, 2]);
  const placed = { meshDetail: row(100), mesh: row(800), billboard: row(2000), count: 3, stride: 8 };
  const f = createForest(THREE, placed, {});
  try {
    assert.deepEqual(f.counts, { meshDetail: 1, mesh: 1, billboard: 1 });
    assert.equal(f.bytes, 3 * 7 * 4);
    // The detail ring also carries a hidden lighter representation of the
    // same instances (RangeQuality nearDetail); five batches draw.
    const near = f.byBand.near.filter(m => m.visible);
    assert.equal(near.length, 5);
    assert.equal(f.byBand.near.filter(m => !m.visible && m.userData.nearLod === 'lite').length, 2);
    assert.equal(new Set(near.filter(m => m.geometry.index).map(m => m.geometry.index.count)).size, 2);
    const cores = near.filter(m => m.layers.mask === 1);
    assert.equal(cores.length, 2);
    for (const m of cores) {
      assert.equal(m.material.transparent, false); assert.equal(m.material.defines.FOREST_CORE, 1);
      assert.ok(f.depth.some(d => d.geometry === m.geometry && d.visible && d.layers.mask === 1 && d.material.defines.FOREST_CORE === 1));
    }
    for (const m of near.filter(m => m.layers.mask === 2)) {
      assert.equal(m.material.transparent, true); assert.equal(m.renderOrder, 1);
      assert.equal(m.layers.mask, 2); assert.equal(m.material.blendSrc, THREE.OneFactor);
      assert.equal(m.material.blendDst, THREE.OneMinusSrcAlphaFactor);
      const depth = f.depth.find(d => d.geometry === m.geometry && d.visible && d.layers.mask === 4);
      assert.ok(depth); assert.equal(depth.layers.mask, 4);
      assert.equal(depth.material.vertexShader, m.material.vertexShader);
    }
  } finally { f.dispose(); }
  const empty = createForest(THREE, { mesh: new Float32Array(), billboard: new Float32Array(), count: 0, stride: 8 }, {});
  assert.equal(empty.counts.meshDetail, 0); empty.dispose();
});
