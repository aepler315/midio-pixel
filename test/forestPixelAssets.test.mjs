import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildConiferAsset, coniferAssetCatalog, forestAssetBytes } from '../src/world/alpine/ForestSpeciesAssets.js';
import { createForest } from '../src/world/alpine/ForestGL.js';

const vertex = (a, i) => JSON.stringify([...a.position.subarray(i * 3, i * 3 + 3),
  ...a.normal.subarray(i * 3, i * 3 + 3), ...a.branch.subarray(i * 4, i * 4 + 4)]);

test('pixel-lite crowns retain every full-detail branch and crossed spray while reducing subdivisions', () => {
  for (let family = 0; family < 2; family++) for (let variant = 0; variant < 3; variant++) {
    const full = buildConiferAsset({ lod: 0, family, variant });
    const lite = buildConiferAsset({ lod: 2, family, variant });
    assert.equal(lite.stats.lod, 2);
    assert.equal(lite.stats.branches, full.stats.branches, 'pixel reduction cannot delete sprays or their upright cross sections');
    assert.deepEqual(lite.stats.tierBranches, full.stats.tierBranches);
    const fullVertices = new Set(Array.from({ length: full.stats.vertices }, (_, i) => vertex(full, i)));
    for (let i = 0; i < lite.stats.vertices; i++) assert.ok(fullVertices.has(vertex(lite, i)), 'same layout, lighting normals and branch phase');
    assert.ok(lite.stats.triangles < full.stats.triangles * .6 && lite.stats.triangles > full.stats.triangles * .45);
    assert.ok(lite.index.every(i => i < lite.stats.vertices));
  }
  assert.equal(coniferAssetCatalog().length, 18);
  assert.equal(forestAssetBytes(), coniferAssetCatalog().reduce((sum, asset) => sum + asset.bytes, 0));
});

test('pixel grid selection uses the crown-preserving asset and quality caps retain their authored coarse mesh', () => {
  const forest = createForest(THREE, { meshDetail: new Float32Array([0, 0, -180, 20, 6, 1, .5, 2]),
    mesh: new Float32Array(), billboard: new Float32Array(), stride: 8, count: 1 }, {});
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 1, 150000); camera.updateMatrixWorld();
  const lite = forest.byBand.near.find(mesh => mesh.userData.nearLod === 'lite').geometry;
  const placement = lite.attributes.iPos;
  try {
    forest.updateDetailView({ camera, width: 160, height: 90, pixelated: true, nearDetail: true });
    assert.equal(lite.userData.asset.lod, 2);
    forest.updateDetailView({ camera, width: 160, height: 90, pixelated: true, nearDetail: false });
    assert.equal(lite.userData.asset.lod, 1, 'governor cap retains its existing cost/appearance');
    forest.updateDetailView({ camera, width: 320, height: 180, pixelated: false, nearDetail: true });
    assert.equal(lite.userData.asset.lod, 1);
    assert.equal(lite.attributes.iPos, placement);
  } finally { forest.dispose(); }
});
