import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as forest from '../src/world/alpine/ForestGL.js';

test('species crowns remain continuous, narrow and asymmetric across branch wraps', () => {
  assert.equal(typeof forest.crownHalfWidth, 'function');
  const ranges = [[.24, .32], [.32, .40], [.22, .28], [.36, .44]];
  for (let species = 0; species < 4; species++) for (const id of [0, .17, .5, .83, .999]) {
    let peak = 0, difference = 0, previous = [0, 0];
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000, sides = [-1, 1].map(side => forest.crownHalfWidth(species, v, id, side));
      assert.ok(sides.every(x => Number.isFinite(x) && x >= 0));
      if (i) sides.forEach((x, j) => assert.ok(Math.abs(x - previous[j]) <= .02, `species ${species} at ${v}`));
      peak = Math.max(peak, sides[0] + sides[1]);
      difference += Math.abs(sides[0] - sides[1]);
      previous = sides;
    }
    assert.ok(peak >= ranges[species][0] && peak <= ranges[species][1], `species ${species} W/H ${peak}`);
    assert.ok(difference > .1, `species ${species} is mirrored`);
    assert.equal(forest.crownHalfWidth(species, 1, id, 1), 0, 'leader tapers to its tip');
    assert.ok(forest.crownHalfWidth(species, .96, id, 1) > 0, 'thin leader remains above the crown');
  }
  assert.equal(forest.crownHalfWidth(0, .25, .5, 1), 0, 'lodgepole lower bole has no foliage');
  assert.ok(forest.crownHalfWidth(2, .05, .5, 1) > 0, 'fir branches reach nearly to the ground');
});

test('partitioned forest colour blends coverage beneath narrative ink', () => {
  const placed = { mesh: new Float32Array([0, 0, 0, 20, 10, 0, .5, 2]),
    billboard: new Float32Array([2000, 0, 0, 20, 10, 1, .6, 1]), stride: 8, count: 2 };
  const trees = forest.createForest(THREE, placed, {}), standalone = forest.createForest(THREE, placed, {}, { partitioned: false });
  try {
    const board = trees.byBand.mid[0], mat = board.material;
    assert.equal(mat.transparent, true);
    assert.equal(mat.blending, THREE.CustomBlending);
    assert.equal(mat.blendSrc, THREE.OneFactor);
    assert.equal(mat.blendDst, THREE.OneMinusSrcAlphaFactor);
    assert.equal(mat.blendSrcAlpha, THREE.OneFactor);
    assert.equal(mat.blendDstAlpha, THREE.OneMinusSrcAlphaFactor);
    assert.equal(mat.depthWrite, false);
    assert.equal(board.renderOrder, 1);
    assert.equal(trees.depth.find(m => m.geometry === board.geometry).material.transparent, false);
    assert.equal(trees.byBand.near.find(m => m.layers.mask === 2).material.transparent, true, 'near mesh edges share staged coverage');
    assert.equal(standalone.byBand.mid[0].material.transparent, false);
    assert.equal(standalone.byBand.mid[0].material.depthWrite, true);
    assert.equal(trees.bytes, 56, 'seven GPU floats per tree');
  } finally { trees.dispose(); standalone.dispose(); }
});
