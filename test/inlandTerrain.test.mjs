import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlandHeightAt, inlandHeightBounds, makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';

const skyline = [.95, .15, .08, .26, .6, .75, .4, .34, .51, .72, .62, .18, .58, .31, .7, .39];
const printFor = values => ({ version: 1, skyline: values, passages: [] });
const datumM = 850;

test('an inland field is reusable, serializable, and tied to world coordinates', () => {
  const input = [...skyline];
  const field = makeInlandTerrain(112, printFor(input));
  const restored = JSON.parse(JSON.stringify(field));
  input[0] = 0;
  assert.deepEqual(field, makeInlandTerrain(112, printFor(skyline)));
  assert.equal(makeInlandTerrain(112, printFor([.4, .2])), null);
  const points = [[-44800, 44800], [0, 0], [213.5, -978.2], [15360, 12800]];
  const terrain = points.map(([x, z]) => inlandHeightAt(field, datumM, x, z));
  assert.deepEqual(points.toReversed().map(([x, z]) => inlandHeightAt(restored, datumM, x, z)), terrain.toReversed());
  assert.ok(Math.abs(inlandHeightAt(field, datumM + 500, 0, 0) - terrain[1] - 500) < 1e-9);
});

test('measured song shape drives large ridge choices and the seed varies local detail', () => {
  const field = makeInlandTerrain(112, printFor(skyline));
  const second = makeInlandTerrain(112, printFor(Array.from({ length: 16 }, (_, i) => i / 15)));
  assert.ok(Math.abs(field.east - second.east) > .25);
  assert.ok(Math.abs(field.spacingM - second.spacingM) > 1800);
  assert.ok(Math.abs(field.reliefM - second.reliefM) > 25);
  assert.ok(Math.abs(inlandHeightAt(field, datumM, 14800, -16240)
    - inlandHeightAt(second, datumM, 14800, -16240)) > 100);
  const reseed = makeInlandTerrain(113, printFor(skyline));
  assert.deepEqual(reseed, { ...field, seed: 113 });
  assert.notEqual(inlandHeightAt(field, datumM, 14800, -16240), inlandHeightAt(reseed, datumM, 14800, -16240));
});

test('interior and horizon elevations stay dry, varied, and continuous across tile seams', () => {
  const field = makeInlandTerrain(112, printFor(skyline));
  const [lower, upper] = inlandHeightBounds(field, datumM);
  let min = Infinity, max = -Infinity;
  assert.ok(lower > datumM);
  for (let z = -44800; z <= 44800; z += 1280) {
    for (let x = -44800; x <= 44800; x += 1280) {
      const height = inlandHeightAt(field, datumM, x, z);
      min = Math.min(min, height);
      max = Math.max(max, height);
      assert.ok(Math.abs(inlandHeightAt(field, datumM, x - .01, z) - inlandHeightAt(field, datumM, x + .01, z)) < .05);
    }
  }
  assert.ok(min >= lower && max <= upper);
  assert.ok(max - min > 600);
});
