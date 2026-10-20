import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudDensity, cloudSample, buildCloudTexture } from '../src/world/alpine/RangeCloudTexture.js';

const seeds = [41, 315, 386, 457, 528, 599, 670,
  ...Array.from({ length: 6 }, (_, i) => 3888190242 + i * 71)];
const deviation = values => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};
const sampleGrid = seed => Array.from({ length: 64 }, (_, y) =>
  Array.from({ length: 96 }, (_, x) => cloudDensity(x / 95, y / 63, seed)));

test('side-view cloud silhouettes have a coherent base beneath varied upper billows', () => {
  for (const seed of seeds) {
    const grid = sampleGrid(seed), tops = [], bases = [];
    for (let x = 24; x < 72; x++) {
      const occupied = grid.flatMap((row, y) => row[x] > .2 ? [y / 63] : []);
      if (occupied.length) { tops.push(occupied[0]); bases.push(occupied.at(-1)); }
    }
    assert.ok(deviation(bases) < .045 && deviation(bases) < deviation(tops) * .6,
      `seed ${seed}: base variation ${deviation(bases)} must be smaller than upper variation ${deviation(tops)}`);
    assert.ok(tops.length >= 44, `seed ${seed}: connected central body`);
    // Individual banks can be flatter; require resolved upper variation
    // while the relative bound above distinguishes them from radial masks.
    assert.ok(deviation(tops) > .015, `seed ${seed}: visibly varied upper silhouette`);
  }
});

test('dense upper billows receive more light than dense undersides', () => {
  for (const seed of seeds) {
    const upper = [], lower = [];
    for (let x = 24; x < 72; x++) {
      const column = Array.from({ length: 64 }, (_, y) => cloudSample(x / 95, y / 63, seed))
        .filter(point => point.density > .65);
      if (column.length < 8) continue;
      upper.push(...column.slice(0, 4).map(point => point.light));
      lower.push(...column.slice(-4).map(point => point.light));
    }
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    assert.ok(upper.length > 100);
    assert.ok(mean(upper) > mean(lower) + .15, `seed ${seed}: lit billows, shaded base`);
  }
});

test('bounded RGBA textures are deterministic, retain lit interior variation and have transparent borders', () => {
  const first = buildCloudTexture(315), repeated = buildCloudTexture(315);
  assert.ok(first instanceof Uint8ClampedArray);
  assert.equal(first.length, 192 * 128 * 4);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, buildCloudTexture(386));
  const lights = [];
  for (let y = 0; y < 128; y++) for (let x = 0; x < 192; x++) {
    const i = (y * 192 + x) * 4;
    if (!x || !y || x === 191 || y === 127) assert.equal(first[i + 3], 0);
    if (first[i + 3] > 220) lights.push(first[i]);
  }
  assert.ok(Math.max(...lights) - Math.min(...lights) > 60, 'opaque interiors retain volume lighting');
  for (const [w, h] of [[0, 128], [192, 0], [193, 128], [192, 129], [NaN, 128]]) {
    assert.throws(() => buildCloudTexture(315, w, h), RangeError);
  }
  assert.equal(buildCloudTexture(315, 16, 12).length, 16 * 12 * 4);
});

test('cloud density has a connected opaque body with feathered edges and transparent sprite borders', () => {
  for (const seed of seeds) {
    const grid = sampleGrid(seed), seen = new Set(), components = [];
    let opaque = 0, edge = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      const value = grid[y][x];
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
      if (!x || !y || x === 95 || y === 63) assert.equal(value, 0);
      if (value > .65) opaque++;
      if (value > .01 && value < .2) edge++;
      const key = y * 96 + x;
      if (value <= .2 || seen.has(key)) continue;
      const queue = [[x, y]]; seen.add(key);
      for (let i = 0; i < queue.length; i++) {
        const [px, py] = queue[i];
        for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
          const next = ny * 96 + nx;
          if (nx < 0 || nx >= 96 || ny < 0 || ny >= 64 || grid[ny][nx] <= .2 || seen.has(next)) continue;
          seen.add(next); queue.push([nx, ny]);
        }
      }
      components.push(queue.length);
    }
    assert.ok(opaque > 200, `seed ${seed}: meaningful dense interior`);
    assert.ok(edge > 80, `seed ${seed}: soft density transitions`);
    assert.ok(Math.max(...components) / seen.size > .98, `seed ${seed}: one connected cloud mass`);
  }
});

test('cloud opacity varies through the body instead of flattening into an outlined constant-alpha cutout', () => {
  for (const seed of [315, 3888190242]) {
    const pixels = buildCloudTexture(seed), histogram = new Map();
    let occupied = 0, translucent = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      const alpha = pixels[i];
      if (alpha < 3) continue;
      occupied++;
      histogram.set(alpha, (histogram.get(alpha) || 0) + 1);
      if (alpha >= 12 && alpha <= 180) translucent++;
    }
    assert.ok(Math.max(...histogram.values()) / occupied < .12,
      `seed ${seed}: a single alpha level cannot dominate the cloud interior`);
    assert.ok(translucent / occupied > .3, `seed ${seed}: a broad optically thin envelope must survive`);
  }
});
