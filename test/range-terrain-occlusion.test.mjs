// Natural-rendering Task 4: the baked terrain horizon shades lee slopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bakeHorizon, bakeHorizonAsync, horizonGrid, horizonBytes, horizonAt, sunVisibility, createHorizonTexture,
  encodeHorizon, decodeHorizon, HORIZON_AZIMUTHS, HORIZON_MAX_RAD } from '../src/world/alpine/TerrainOcclusion.js';

// A synthetic 10 km package: a 1500 m north-south ridge at x = 0 (wall),
// flat ground either side, and a hole of missing data.
const grid = { width: 101, height: 101, cellSizeM: 100, originM: [-5000, -5000] };
const ridge = (x, z) => {
  if (Math.hypot(x - 3000, z - 3000) < 400) return NaN;
  return 1500 * Math.max(0, 1 - Math.abs(x) / 600);
};
const data = { grid };
const bake = bakeHorizon(data, { sample: ridge, maxSize: 101, minCellM: 100 });
const texel = (x, z) => [Math.round((x - grid.originM[0]) / 100), Math.round((z - grid.originM[1]) / 100)];
const az = (deg) => deg * Math.PI / 180;

test('the grid spans the package with a bounded size and byte cost', () => {
  const g = horizonGrid({ width: 2241, height: 2241, cellSizeM: 20, originM: [0, 0] });
  assert.ok(g.width <= 256 && g.height <= 256);
  assert.deepEqual(g.extentM, [44800, 44800]);
  assert.equal(horizonBytes({ width: 2241, height: 2241, cellSizeM: 20, originM: [0, 0] }), g.width * g.height * HORIZON_AZIMUTHS);
  assert.equal(bake.data.length, bake.width * bake.height * HORIZON_AZIMUTHS);
});

test('ground beside a ridge sees a high horizon toward it and an open one away from it', () => {
  const [i, j] = texel(-1500, 0); // west of the ridge
  const east = horizonAt(bake, i, j, az(0)), west = horizonAt(bake, i, j, az(180));
  assert.ok(east > 0.35, `ridge to the east rises above the eye (${east})`);
  assert.ok(west < 0.02, `open ground to the west (${west})`);
  // Low morning sun from the east: in shadow; the same sun high: lit.
  assert.ok(sunVisibility(east, 0.15) < 0.05);
  assert.ok(sunVisibility(east, 1.2) > 0.95);
  // Afternoon sun from the west: lit.
  assert.ok(sunVisibility(west, 0.15) > 0.95);
  // Farther from the ridge the horizon is lower (relief, not a flat cutoff).
  const [i2, j2] = texel(-4000, 0);
  assert.ok(horizonAt(bake, i2, j2, az(0)) < east);
});

test('missing data never occludes; the crest sees open sky', () => {
  const [i, j] = texel(3000, 3000);
  for (let k = 0; k < HORIZON_AZIMUTHS; k++) assert.equal(bake.data[(j * bake.width + i) * HORIZON_AZIMUTHS + k], 0);
  const [ci, cj] = texel(0, 0);
  for (const deg of [0, 90, 180, 270]) assert.ok(horizonAt(bake, ci, cj, az(deg)) < 0.05);
});

test('encoding, interpolation and the visibility edge are monotone and bounded', () => {
  assert.equal(encodeHorizon(-0.3), 0);
  assert.equal(encodeHorizon(10), 255);
  assert.ok(Math.abs(decodeHorizon(encodeHorizon(0.3)) - 0.3) < HORIZON_MAX_RAD / 255);
  let last = -1;
  for (let e = -0.2; e <= 0.5; e += 0.01) { const v = sunVisibility(0.15, e); assert.ok(v >= last - 1e-12 && v >= 0 && v <= 1); last = v; }
  // Between two baked azimuths the horizon blends linearly.
  const [i, j] = texel(-1500, 0);
  const a = horizonAt(bake, i, j, az(0)), b = horizonAt(bake, i, j, az(45)), mid = horizonAt(bake, i, j, az(22.5));
  assert.ok(Math.abs(mid - (a + b) / 2) < 1e-9);
});

test('the async bake matches the synchronous one, and textures pack the azimuths', async () => {
  const again = await bakeHorizonAsync(data, { sample: ridge, maxSize: 101, minCellM: 100, sliceMs: 0, yieldTo: async () => {} });
  assert.deepEqual(again.data, bake.data);
  const { texture, bytes } = createHorizonTexture(THREE, bake);
  try {
    // One texture, two halves: azimuths 0-3 left, 4-7 right.
    assert.equal(bytes, bake.width * bake.height * 8);
    assert.equal(texture.image.width, bake.width * 2);
    const row = 3, col = 7, W = bake.width, src = (row * W + col) * HORIZON_AZIMUTHS;
    assert.equal(texture.image.data[(row * W * 2 + col) * 4 + 2], bake.data[src + 2]);
    assert.equal(texture.image.data[(row * W * 2 + W + col) * 4 + 1], bake.data[src + 5]);
  } finally { texture.dispose(); }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bakeHorizonAsync(data, { sample: ridge, maxSize: 101, minCellM: 100, sliceMs: 0, yieldTo: async () => {}, signal: controller.signal }));
});
