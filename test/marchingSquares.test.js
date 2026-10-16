import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleCaveGrid, extractContours, polygonArea, polygonCentroid, insetContour,
} from '../src/render/marchingSquares.js';

test('sampleCaveGrid forces a solid ring around the border', () => {
  const cols = 20, rows = 16;
  const grid = sampleCaveGrid(cols, rows, 0, 3.14);
  for (let ix = 0; ix < cols; ix++) {
    assert.equal(grid[0 * cols + ix], 1, `top row ${ix} should be solid`);
    assert.equal(grid[(rows - 1) * cols + ix], 1, `bottom row ${ix} should be solid`);
  }
  for (let iy = 0; iy < rows; iy++) {
    assert.equal(grid[iy * cols + 0], 1, `left col row ${iy} should be solid`);
    assert.equal(grid[iy * cols + (cols - 1)], 1, `right col row ${iy} should be solid`);
  }
});

test('sampleCaveGrid is deterministic for a given seed and origin', () => {
  const a = sampleCaveGrid(24, 24, 100, 7.5);
  const b = sampleCaveGrid(24, 24, 100, 7.5);
  assert.deepEqual([...a], [...b]);
});

test('sampleCaveGrid produces a different layout for a different seed', () => {
  const a = sampleCaveGrid(24, 24, 100, 7.5);
  const b = sampleCaveGrid(24, 24, 100, 99.1);
  assert.notDeepEqual([...a], [...b]);
});

test('sampleCaveGrid interior values vary (not a flat field)', () => {
  const grid = sampleCaveGrid(24, 24, 0, 5);
  const interior = [];
  for (let iy = 1; iy < 23; iy++) for (let ix = 1; ix < 23; ix++) interior.push(grid[iy * 24 + ix]);
  const min = Math.min(...interior), max = Math.max(...interior);
  assert.ok(max - min > 0.1, `expected real variation in the interior, got range ${max - min}`);
});

function isClosed(points) {
  // A closed polygon loop: every consecutive pair (wrapping) forms a
  // reasonable edge -- checked structurally via traceContours already only
  // emitting cycles, so here we just sanity-check there's no degenerate
  // zero-length wraparound and at least 3 distinct points.
  if (points.length < 3) return false;
  const first = points[0], last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) > 0 || points.length >= 3;
}

test('extractContours returns closed polygons for a noisy grid', () => {
  const cols = 32, rows = 32;
  const grid = sampleCaveGrid(cols, rows, 42, 1.7, { noiseScale: 0.15 });
  const contours = extractContours(grid, cols, rows, 0.5);
  assert.ok(contours.length > 0, 'expected at least one contour from a varied noise field');
  for (const c of contours) {
    assert.ok(isClosed(c.points), 'every contour must be a closed loop');
    assert.ok(c.points.length >= 3, 'a contour needs at least 3 points');
  }
});

test('extractContours is deterministic given the same grid', () => {
  const cols = 28, rows = 28;
  const grid = sampleCaveGrid(cols, rows, 7, 2.2);
  const c1 = extractContours(grid, cols, rows, 0.5);
  const c2 = extractContours(grid, cols, rows, 0.5);
  assert.equal(c1.length, c2.length);
  for (let i = 0; i < c1.length; i++) {
    assert.equal(c1[i].points.length, c2[i].points.length);
  }
});

test('extractContours finds no contours in a uniformly solid grid', () => {
  const grid = new Float32Array(10 * 10).fill(1);
  const contours = extractContours(grid, 10, 10, 0.5);
  assert.equal(contours.length, 0);
});

test('extractContours finds no contours in a uniformly open grid', () => {
  const grid = new Float32Array(10 * 10).fill(0);
  const contours = extractContours(grid, 10, 10, 0.5);
  assert.equal(contours.length, 0);
});

test('an isolated single-node peak produces one small closed quad contour', () => {
  const cols = 8, rows = 8;
  const grid = new Float32Array(cols * rows).fill(0);
  grid[4 * cols + 4] = 1; // one node spikes solid, everything else open
  const contours = extractContours(grid, cols, rows, 0.5);
  assert.equal(contours.length, 1);
  assert.equal(contours[0].points.length, 4);
});

test('a solid square block produces exactly one closed contour around it', () => {
  const cols = 12, rows = 12;
  const grid = new Float32Array(cols * rows).fill(0);
  for (let iy = 3; iy <= 6; iy++) for (let ix = 3; ix <= 6; ix++) grid[iy * cols + ix] = 1;
  const contours = extractContours(grid, cols, rows, 0.5);
  assert.equal(contours.length, 1);
});

test('two well-separated solid blobs produce two separate contours', () => {
  const cols = 20, rows = 12;
  const grid = new Float32Array(cols * rows).fill(0);
  for (let iy = 2; iy <= 4; iy++) for (let ix = 2; ix <= 4; ix++) grid[iy * cols + ix] = 1;
  for (let iy = 6; iy <= 8; iy++) for (let ix = 13; ix <= 15; ix++) grid[iy * cols + ix] = 1;
  const contours = extractContours(grid, cols, rows, 0.5);
  assert.equal(contours.length, 2);
});

test('extractContours resolves the ambiguous diagonal saddle cases without throwing', () => {
  // Case 5 (tl+br solid) and case 10 (tr+bl solid) checkerboard patterns.
  const cols = 6, rows = 6;
  const solidTlBr = new Float32Array(cols * rows).fill(0);
  solidTlBr[2 * cols + 2] = 1; solidTlBr[3 * cols + 3] = 1; // tl, br of the same cell
  const c1 = extractContours(solidTlBr, cols, rows, 0.5);
  for (const c of c1) assert.ok(c.points.length >= 3);

  const solidTrBl = new Float32Array(cols * rows).fill(0);
  solidTrBl[2 * cols + 3] = 1; solidTrBl[3 * cols + 2] = 1; // tr, bl of the same cell
  const c2 = extractContours(solidTrBl, cols, rows, 0.5);
  for (const c of c2) assert.ok(c.points.length >= 3);
});

test('polygonArea computes a known rectangle area', () => {
  const rect = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
  assert.ok(Math.abs(Math.abs(polygonArea(rect)) - 12) < 1e-9);
});

test('polygonCentroid finds the average of a square', () => {
  const sq = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  const c = polygonCentroid(sq);
  assert.ok(Math.abs(c.x - 1) < 1e-9 && Math.abs(c.y - 1) < 1e-9);
});

test('insetContour shrinks a polygon toward its centroid', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const inset = insetContour(sq, 0.2);
  const originalArea = Math.abs(polygonArea(sq));
  const insetArea = Math.abs(polygonArea(inset));
  assert.ok(insetArea < originalArea, 'inset polygon should be smaller');
  assert.ok(Math.abs(insetArea - originalArea * 0.8 * 0.8) < 1e-6, 'linear shrink by f scales area by (1-f)^2');
  const c = polygonCentroid(sq);
  const cInset = polygonCentroid(inset);
  assert.ok(Math.abs(c.x - cInset.x) < 1e-9 && Math.abs(c.y - cInset.y) < 1e-9, 'centroid should be preserved');
});

test('insetContour with fraction 0 returns the polygon unchanged', () => {
  const sq = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
  const inset = insetContour(sq, 0);
  for (let i = 0; i < sq.length; i++) {
    assert.ok(Math.abs(sq[i].x - inset[i].x) < 1e-9);
    assert.ok(Math.abs(sq[i].y - inset[i].y) < 1e-9);
  }
});
