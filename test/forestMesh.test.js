import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
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
    assert.equal(f.bytes, 3 * 7 * 4 + 8, 'seven floats per tree and two detail-batch scalars');
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


test('real Three forest releases obsolete placement records while retained geometry stays byte-identical', () => {
  const script = `
    import assert from 'node:assert/strict';
    import crypto from 'node:crypto';
    import * as THREE from 'three';
    import { createForest } from './src/world/alpine/ForestGL.js';
    const hash = a => crypto.createHash('sha256').update(a).digest('hex');
    const snapshot = forest => {
      const seen = new Set(), out = [];
      for (const meshes of [...Object.values(forest.byBand), forest.depth, ...Object.values(forest.depthByBand)]) for (const mesh of meshes) {
        const geo = mesh.geometry; if (seen.has(geo)) continue; seen.add(geo);
        out.push({ count: geo.instanceCount, index: geo.index ? hash(geo.index.array) : null,
          attributes: Object.fromEntries(Object.entries(geo.attributes).map(([name, a]) => [name, { itemSize: a.itemSize, count: a.count, hash: hash(a.array) }])) });
      }
      return out;
    };
    function build() {
      const count = 3000, arrays = Array.from({ length: 3 }, (_, kind) => {
        const a = new Float32Array(count * 8);
        for (let i = 0; i < count; i++) a.set([i % 100, 1000, Math.floor(i / 100), 20, 6, kind % 3, (i % 31) / 31, i % 3], i * 8);
        return a;
      });
      const placed = { meshDetail: arrays[0], mesh: arrays[1], billboard: arrays[2], count: count * 3, stride: 8 };
      const refs = arrays.map(a => ({ array: new WeakRef(a), backing: new WeakRef(a.buffer) }));
      const forest = createForest(THREE, placed, {});
      return { forest, refs, before: snapshot(forest), counts: { ...forest.counts }, bytes: forest.bytes };
    }
    const fixture = build();
    for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
    assert.equal(fixture.refs.filter(r => r.array.deref() || r.backing.deref()).length, 0, 'returned methods cannot retain original placement buffers');
    assert.deepEqual(snapshot(fixture.forest), fixture.before);
    assert.deepEqual(fixture.forest.counts, fixture.counts); assert.equal(fixture.forest.bytes, fixture.bytes);
    fixture.forest.dispose();
    console.log('obsolete record arrays/backings collected; geometry bytes unchanged');
  `;
  const result = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000 });
  assert.match(result, /obsolete record arrays\/backings collected; geometry bytes unchanged/);
});
