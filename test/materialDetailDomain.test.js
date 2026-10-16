import test from 'node:test';
import assert from 'node:assert/strict';
import * as material from '../src/world/alpine/TerrainMaterial.js';

const domain = p => {
  assert.equal(typeof material.materialDetailPosition, 'function');
  return material.materialDetailPosition(p);
};

test('material texture phase varies across repeating tiles while remaining anchored to world coordinates', () => {
  const p = [1250, 830, -8700], tile = 150;
  assert.deepEqual(domain(p), domain(p));
  const a = domain(p), b = domain([p[0] + tile, p[1], p[2]]);
  assert.ok(Math.abs(b[0] - a[0] - tile) + Math.abs(b[2] - a[2]) > 1, 'neighbouring rock stamps must not repeat the same phase');
});

test('the detail domain stays bounded and continuous across signed world-grid boundaries', () => {
  for (const p of [[0, 0, 0], [600, 900, -600], [-600, 2300, 600], [24000, -50, -24000]]) {
    const a = domain(p);
    assert.ok(a.every((v, i) => Number.isFinite(v) && Math.abs(v - p[i]) <= 150));
    for (const axis of [0, 2]) {
      const b = domain(p.map((v, i) => v + (i === axis ? 1e-5 : 0)));
      assert.ok(Math.hypot(...b.map((v, i) => v - a[i])) < 1e-3, 'texture coordinates must not jump at patch boundaries');
    }
  }
});
