import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';

const skyline = [.95, .15, .08, .26, .6, .75, .4, .34, .51, .72, .62, .18, .58, .31, .7, .39];
const printFor = values => ({ version: 1, skyline: values, passages: [] });

test('an inland field is small, serializable and a pure function of seed and outline', () => {
  const input = [...skyline];
  const field = makeInlandTerrain(112, printFor(input));
  input[0] = 0;
  assert.deepEqual(field, makeInlandTerrain(112, printFor(skyline)));
  assert.deepEqual(JSON.parse(JSON.stringify(field)), field);
  assert.equal(makeInlandTerrain(112, printFor([.4, .2])), null);
  assert.ok(Math.abs(Math.hypot(field.east, field.north) - 1) < 1e-12);
});

test('the outline and the seed both turn and shape the region', () => {
  const field = makeInlandTerrain(112, printFor(skyline));
  const second = makeInlandTerrain(112, printFor(Array.from({ length: 16 }, (_, i) => i / 15)));
  assert.ok(Math.abs(field.east - second.east) > .25 || Math.abs(field.north - second.north) > .25);
  assert.ok(Math.abs(field.spacingM - second.spacingM) > 1800);
  const reseed = makeInlandTerrain(1913, printFor(skyline));
  assert.equal(reseed.reliefM, field.reliefM);
  assert.ok(Math.abs(reseed.east - field.east) > .05 || Math.abs(reseed.north - field.north) > .05);
});
