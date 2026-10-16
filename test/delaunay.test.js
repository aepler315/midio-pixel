import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delaunayTriangulate, poissonDiscSample } from '../src/utils/delaunay.js';
import { mulberry32 } from '../src/utils/math.js';

function triArea(points, t) {
  const [a, b, c] = t.map((i) => points[i]);
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

test('delaunayTriangulate: a square gives exactly 2 non-degenerate triangles', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const tris = delaunayTriangulate(points);
  assert.equal(tris.length, 2);
  for (const t of tris) assert.ok(triArea(points, t) > 0);
});

test('delaunayTriangulate: triangles cover the input area without huge overlaps (sum of areas ~ convex hull area)', () => {
  const rand = mulberry32(5);
  const points = Array.from({ length: 40 }, () => ({ x: rand() * 500, y: rand() * 400 }));
  const tris = delaunayTriangulate(points);
  assert.ok(tris.length > 0);
  let totalArea = 0;
  for (const t of tris) {
    const a = triArea(points, t);
    assert.ok(a > 0, 'every triangle must have positive area');
    totalArea += a;
  }
  // Bounding box is 500x400=200000; convex hull area must be <= that, and the
  // triangulated area should be a large, sane fraction of the point spread
  // (loose bounds -- this just catches gross triangulation bugs).
  assert.ok(totalArea > 10000 && totalArea < 200000);
});

test('delaunayTriangulate handles the minimum 3-point case', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }];
  const tris = delaunayTriangulate(points);
  assert.equal(tris.length, 1);
});

test('poissonDiscSample keeps points within bounds and roughly radius-separated', () => {
  const rand = mulberry32(3);
  const pts = poissonDiscSample(400, 300, 40, rand);
  assert.ok(pts.length > 10);
  for (const p of pts) {
    assert.ok(p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 300);
  }
  // Spot-check no two points are absurdly close (allow a little slack vs. radius).
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < Math.min(pts.length, i + 5); j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      assert.ok(d > 30);
    }
  }
});
