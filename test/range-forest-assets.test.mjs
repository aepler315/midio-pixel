// Natural-rendering Task 2: near conifers are irregular branch sprays with
// deterministic family/variant assignment, not stacked star whorls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildConiferAsset, coniferAssetCatalog, familyFor, variantFor, forestAssetBytes,
  FOREST_FAMILIES, FOREST_VARIANTS } from '../src/world/alpine/ForestSpeciesAssets.js';
import { coniferGeometry, createForest } from '../src/world/alpine/ForestGL.js';
import { forestKeepFraction } from '../src/world/alpine/ForestCover.js';

const each = (fn) => { for (let lod = 0; lod < 2; lod++) for (let family = 0; family < FOREST_FAMILIES; family++) for (let variant = 0; variant < FOREST_VARIANTS; variant++) fn({ lod, family, variant }); };

test('every asset is finite, indexed within budget, bounded and deterministic', () => {
  each(({ lod, family, variant }) => {
    const a = buildConiferAsset({ lod, family, variant });
    assert.ok([...a.position, ...a.normal, ...a.branch].every(Number.isFinite));
    assert.equal(a.branch.length / 4, a.position.length / 3);
    assert.ok(a.index.every(i => i < a.stats.vertices));
    // Detail goes where it has pixels: the mesh ring stays an order lighter.
    assert.ok(a.stats.triangles <= (lod === 0 ? 2400 : 360), `lod ${lod} triangles ${a.stats.triangles}`);
    assert.ok(a.stats.bounds.min[1] >= -0.001 && a.stats.bounds.max[1] <= 1.0001, 'stays between the crown base and the top');
    assert.ok(Math.max(...a.stats.bounds.max.map(Math.abs), ...a.stats.bounds.min.map(Math.abs)) <= 1.15, 'within the species envelope');
    for (let i = 0; i < a.normal.length; i += 3) assert.ok(Math.abs(Math.hypot(a.normal[i], a.normal[i + 1], a.normal[i + 2]) - 1) < 1e-5);
    assert.deepEqual(buildConiferAsset({ lod, family, variant }).position, a.position, 'same inputs, same asset');
  });
});

test('trunks are tapered prisms wound outward like their normals', () => {
  each(({ lod, family, variant }) => {
    const g = coniferGeometry(THREE, { lod, family, variant });
    try {
      const p = g.attributes.position, b = g.attributes.aBranch;
      const sides = [...Array(p.count).keys()].filter(i => b.getW(i) === 0).length / 2;
      assert.ok(sides >= 6);
      for (let i = 0; i < sides * 6; i += 3) {
        const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, g.index.getX(i + k)));
        const face = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0]));
        const centre = v.reduce((sum, x) => sum.add(x), new THREE.Vector3()); centre.y = 0;
        assert.ok(face.dot(centre) > 0);
      }
    } finally { g.dispose(); }
  });
});

test('foliage is irregular sprays with negative space, not regular star whorls', () => {
  each(({ lod, family, variant }) => {
    const a = buildConiferAsset({ lod, family, variant });
    const branches = new Map();
    for (let i = 0; i < a.stats.vertices; i++) {
      if (a.branch[i * 4 + 3] !== 1) continue;
      const key = a.branch[i * 4].toFixed(5);
      if (!branches.has(key)) branches.set(key, []);
      branches.get(key).push([a.position[i * 3], a.position[i * 3 + 1], a.position[i * 3 + 2]]);
    }
    assert.ok(branches.size >= (lod === 0 ? 30 : 12), 'many separately keyed branches');
    // Branch lengths vary (no identical spokes) and azimuths are not a
    // regular n-gon within a tier.
    const lengths = [...branches.values()].map(ps => Math.max(...ps.map(([x, , z]) => Math.hypot(x, z))));
    const spread = Math.max(...lengths) - Math.min(...lengths);
    assert.ok(spread > 0.15, `branch lengths vary (${spread.toFixed(3)})`);
    // Tiers hold differing numbers of sprays (a star whorl repeats one
    // count at every tier).
    assert.ok(new Set(a.stats.tierBranches).size > 1, `tier counts vary: ${a.stats.tierBranches}`);
    assert.equal(a.stats.tierBranches.reduce((x, y) => x + y, 0), branches.size - 2, 'every spray keyed apart (plus the leader cards)');
    if (lod === 0) assert.ok(a.stats.triangles > 900, 'detail ring has real structure');
  });
});

test('family and variant follow species and id deterministically, independent of the quality subset', () => {
  assert.equal(familyFor(0), 0);
  for (const s of [1, 2, 3]) assert.equal(familyFor(s), 1);
  const ids = Array.from({ length: 6000 }, (_, i) => (i + 0.5) / 6000);
  const counts = new Array(FOREST_VARIANTS).fill(0);
  for (const id of ids) { const v = variantFor(id); assert.ok(v >= 0 && v < FOREST_VARIANTS); counts[v]++; assert.equal(variantFor(id), v); }
  for (const c of counts) assert.ok(Math.abs(c / ids.length - 1 / FOREST_VARIANTS) < 0.03, 'variants evenly used');
  // The trees a degraded rung keeps (id < keep) still use all variants evenly.
  const keep = forestKeepFraction(6), kept = ids.filter(id => id < keep), kc = new Array(FOREST_VARIANTS).fill(0);
  for (const id of kept) kc[variantFor(id)]++;
  for (const c of kc) assert.ok(Math.abs(c / kept.length - 1 / FOREST_VARIANTS) < 0.05);
  assert.equal(variantFor(NaN), 0);
});

test('forests batch by family/variant without regenerating or reordering trees', () => {
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push(i * 13, 0, 100, 20, 6, i % 4, (i + 0.5) / 24, 2);
  const data = new Float32Array(rows);
  const f = createForest(THREE, { meshDetail: data, mesh: new Float32Array(), billboard: new Float32Array(), count: 24, stride: 8 }, {});
  try {
    assert.equal(f.counts.meshDetail, 24);
    assert.ok(f.batches.meshDetail > 1 && f.batches.meshDetail <= FOREST_FAMILIES * FOREST_VARIANTS);
    // Each instance appears in exactly one batch, with its own root/size/id.
    const seen = [];
    for (const m of f.byBand.near.filter(m => m.layers.mask === 2 && m.visible)) {
      const p = m.geometry.attributes.iPos, v = m.geometry.attributes.iVar;
      for (let i = 0; i < p.count; i++) {
        seen.push(p.getX(i));
        const row = rows.indexOf(p.getX(i));
        assert.equal(familyFor(v.getX(i)), m.geometry.index === null ? null : familyFor(rows[row + 5]));
      }
    }
    assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i * 13));
    assert.ok(f.assets.some(a => a.lod === 0) && f.assets.some(a => a.lod === 1), 'detail assets plus their lighter twins');
    // The rung's representation switch shows exactly one of the two, over
    // the very same instance attributes (no regeneration, no extra bytes).
    const all = [...f.byBand.near, ...f.depth, ...f.depthByBand.near];
    const lite = all.filter(m => m.userData.nearLod === 'lite'), detail = all.filter(m => m.userData.nearLod === 'detail');
    assert.ok(lite.length && lite.length === detail.length);
    for (const m of lite) assert.ok(detail.some(d => d.geometry.attributes.iPos === m.geometry.attributes.iPos));
    f.setNearDetail(false);
    assert.ok(lite.every(m => m.visible) && detail.every(m => !m.visible));
    f.setNearDetail(true);
    assert.ok(lite.every(m => !m.visible) && detail.every(m => m.visible));
    // Hiding and re-showing the forest (narrative materials) never brings
    // both representations back together.
    f.applyVisibility({ shown: false });
    assert.ok(all.every(m => !m.visible));
    f.applyVisibility({ shown: true, nearDetail: false });
    assert.ok(lite.every(m => m.visible) && detail.every(m => !m.visible));
    assert.ok(all.filter(m => !m.userData.nearLod).every(m => m.visible));
    assert.equal(f.bytes, 24 * 7 * 4, 'per-instance GPU data unchanged');
  } finally { f.dispose(); }
  const total = coniferAssetCatalog().reduce((n, a) => n + a.bytes, 0);
  assert.equal(forestAssetBytes(), total);
  assert.ok(total < 2 * 1024 * 1024, 'the whole asset set stays small');
});
