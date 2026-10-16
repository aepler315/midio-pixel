import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';

test('the shipped Range runtime can construct its geological line segments', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
  const lines = new THREE.LineSegments(geometry, new THREE.ShaderMaterial());
  assert.equal(lines.isLineSegments, true);
  assert.equal(lines.geometry, geometry);
  geometry.dispose();
  lines.material.dispose();
});
