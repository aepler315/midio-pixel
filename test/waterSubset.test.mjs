import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wetTexelMask, waterIndexSubset } from '../src/world/alpine/WaterSubset.js';
import { contourCoverage } from './helpers/waterContourOracle.mjs';

// Seeded so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// TerrainMaterial's waterCoverageAt: bilinear membership of fully wet texels,
// sampled at texel = (p - origin) / cell (see WaterSubset.js).
function coverage(rgba, w, h, tx, tz) {
  const cx = Math.floor(tx), cz = Math.floor(tz), fx = tx - cx, fz = tz - cz;
  const at = (x, z) => rgba[(Math.min(h - 1, Math.max(0, z)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + 3] === 255 ? 1 : 0;
  const top = at(cx, cz) * (1 - fx) + at(cx + 1, cz) * fx;
  const bottom = at(cx, cz + 1) * (1 - fx) + at(cx + 1, cz + 1) * fx;
  return top * (1 - fz) + bottom * fz;
}

function scene(seed, { w = 48, h = 40, lakes = 2, triangles = 3000 } = {}) {
  const r = rng(seed);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba[i + 3] = Math.floor(r() * 250); // dry flow bytes
  for (let l = 0; l < lakes; l++) {
    const x0 = Math.floor(r() * w), z0 = Math.floor(r() * h), rad = 1 + r() * 4;
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++)
      if ((x - x0) ** 2 + (z - z0) ** 2 <= rad * rad) rgba[(z * w + x) * 4 + 3] = 255;
  }
  const grid = { originM: [1000, -500], cellSizeM: 20, width: w, height: h };
  const positions = new Float32Array(triangles * 9);
  const index = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    // Mixed sizes: near tiles span under a texel, far ones many.
    const size = (r() < .8 ? .3 + r() * 1.5 : 2 + r() * 10) * grid.cellSizeM;
    const bx = grid.originM[0] + r() * (w - 1) * grid.cellSizeM, bz = grid.originM[1] + r() * (h - 1) * grid.cellSizeM;
    for (let v = 0; v < 3; v++) {
      positions.set([bx + (r() - .5) * size, r() * 3000, bz + (r() - .5) * size], (t * 3 + v) * 3);
      index[t * 3 + v] = t * 3 + v;
    }
  }
  return { rgba, w, h, grid, positions, index };
}

test('every triangle that can shade a water fragment is kept, in order', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s = scene(seed);
    const keep = waterIndexSubset(s.positions, s.index, s.grid, wetTexelMask(s.rgba, s.w, s.h), { maxShare: 1 });
    assert.ok(keep instanceof Uint32Array);
    const kept = new Set();
    for (let i = 0; i < keep.length; i += 3) kept.add(keep[i] / 3);
    // Order is preserved (depth ties resolve as in the full draw).
    for (let i = 3; i < keep.length; i += 3) assert.ok(keep[i] > keep[i - 3]);
    const r = rng(seed * 7919);
    let wetTriangles = 0;
    for (let t = 0; t < s.index.length / 3; t++) {
      const p = k => [s.positions[(t * 3 + k) * 3], s.positions[(t * 3 + k) * 3 + 2]];
      const [a, b, c] = [p(0), p(1), p(2)];
      let wet = false;
      for (let n = 0; n < 200 && !wet; n++) {
        let u = r(), v = r();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const x = a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]), z = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
        wet = coverage(s.rgba, s.w, s.h, (x - s.grid.originM[0]) / s.grid.cellSizeM, (z - s.grid.originM[1]) / s.grid.cellSizeM) > .5;
      }
      if (wet) { wetTriangles++; assert.ok(kept.has(t), `seed ${seed}: wet triangle ${t} was dropped`); }
    }
    assert.ok(wetTriangles > 0, `seed ${seed} exercised no water`);
    assert.ok(kept.size < s.index.length / 3, `seed ${seed} dropped nothing`);
  }
});

test('a dry view keeps no triangles; an overfull subset falls back to the full index', () => {
  const s = scene(3, { lakes: 0 });
  const empty = waterIndexSubset(s.positions, s.index, s.grid, wetTexelMask(s.rgba, s.w, s.h));
  assert.equal(empty.length, 0);
  const flooded = new Uint8Array(s.rgba); for (let i = 3; i < flooded.length; i += 4) flooded[i] = 255;
  assert.equal(waterIndexSubset(s.positions, s.index, s.grid, wetTexelMask(flooded, s.w, s.h)), null);
});

test('Uint16 indices stay Uint16', () => {
  const s = scene(5, { triangles: 200 });
  const keep = waterIndexSubset(s.positions, Uint16Array.from(s.index), s.grid, wetTexelMask(s.rgba, s.w, s.h), { maxShare: 1 });
  assert.ok(keep instanceof Uint16Array);
});

test('rounded source contours stay inside the existing conservative water subset', () => {
  for (const seed of [2, 5, 9]) {
    const s = scene(seed, { triangles: 1000 });
    const keep = waterIndexSubset(s.positions, s.index, s.grid, wetTexelMask(s.rgba, s.w, s.h), { maxShare: 1 });
    const kept = new Set(Array.from({ length: keep.length / 3 }, (_, i) => keep[i * 3] / 3));
    const r = rng(seed * 7919);
    for (let t = 0; t < s.index.length / 3; t++) {
      const p = k => [s.positions[(t * 3 + k) * 3], s.positions[(t * 3 + k) * 3 + 2]];
      const [a, b, c] = [p(0), p(1), p(2)];
      for (let n = 0; n < 80; n++) {
        let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const x = a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]);
        const z = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
        if (contourCoverage(s.rgba, s.w, s.h, (x - s.grid.originM[0]) / s.grid.cellSizeM,
          (z - s.grid.originM[1]) / s.grid.cellSizeM).coverage > .5) {
          assert.ok(kept.has(t), `rounded wet triangle ${t} was omitted in seed ${seed}`); break;
        }
      }
    }
  }
});

test('sliced subsets match the single pass', async () => {
  const { waterIndexSubsetAsync } = await import('../src/world/alpine/WaterSubset.js');
  const s = scene(9, { triangles: 5000 });
  const mask = wetTexelMask(s.rgba, s.w, s.h);
  let pauses = 0;
  const sliced = await waterIndexSubsetAsync(s.positions, s.index, s.grid, mask, { maxShare: 1, sliceTriangles: 700, pause: async () => { pauses++; } });
  assert.deepEqual(sliced, waterIndexSubset(s.positions, s.index, s.grid, mask, { maxShare: 1 }));
  assert.ok(pauses >= 7);
  assert.equal(await waterIndexSubsetAsync(s.positions, s.index, s.grid, mask, { maxShare: 0.0001, sliceTriangles: 700 }), null);
});
