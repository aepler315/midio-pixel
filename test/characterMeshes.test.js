import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shardMesh, hexagramMesh, BABY_STAR_MESH } from '../src/render/meshes.js';

test('shardMesh builds ring + sparse spokes + braces with correct indexing', () => {
  const m = shardMesh({ x: 0, y: 0 }, [
    { x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }, { x: 0, y: -10 },
  ], { spokeEvery: 2, braces: [[0, 2]] });
  assert.equal(m.vertices.length, 5);
  // 4 ring edges + 2 spokes (rim 0 and 2) + 1 brace.
  assert.equal(m.edges.length, 7);
  for (const [i, j] of m.edges) assert.ok(i < 5 && j < 5);
});

test('a hexagram is two closed triangles sharing no edges, with valid indices', () => {
  for (const mesh of [hexagramMesh(8.5), BABY_STAR_MESH]) {
    const tris = [mesh.edges.slice(0, 3), mesh.edges.slice(3, 6)];
    const key = ([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`;
    const a = new Set(tris[0].map(key)), b = new Set(tris[1].map(key));
    for (const k of a) assert.ok(!b.has(k), 'the two triangles share no edge');
    for (const [i, j] of mesh.edges) assert.ok(i < mesh.vertices.length && j < mesh.vertices.length);
  }
});
