import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';

const skyline = [.95, .15, .08, .26, .6, .75, .4, .34, .51, .72, .62, .18, .58, .31, .7, .39];
const printFor = values => ({ version: 1, skyline: values, passages: [] });
const turnDeg = (a, b) => Math.acos(Math.min(1, a.east * b.east + a.north * b.north)) * 180 / Math.PI;

test('an inland field is small, serializable and a pure function of the outline', () => {
  const input = [...skyline];
  const field = makeInlandTerrain(printFor(input));
  input[0] = 0;
  assert.deepEqual(field, makeInlandTerrain(printFor(skyline)));
  assert.deepEqual(JSON.parse(JSON.stringify(field)), field);
  assert.equal(makeInlandTerrain(printFor([.4, .2])), null);
  assert.ok(Math.abs(Math.hypot(field.east, field.north) - 1) < 1e-12);
  assert.equal(field.shape.length, 8);
});

test('a different outline turns and shapes the region', () => {
  const field = makeInlandTerrain(printFor(skyline));
  const second = makeInlandTerrain(printFor(Array.from({ length: 16 }, (_, i) => i / 15)));
  assert.ok(turnDeg(field, second) > 20, `${turnDeg(field, second).toFixed(1)} degrees`);
  assert.ok(Math.abs(field.spacingM - second.spacingM) > 1800);
  assert.ok(turnDeg(field, makeInlandTerrain(printFor(skyline.toReversed()))) > 90);
});

test('a close outline, as from another recording of the song, gives a close field', () => {
  // No hash of the outline: the field moves in proportion to the outline.
  const field = makeInlandTerrain(printFor(skyline));
  let previous = 0;
  for (const amount of [1e-6, 1e-3, .01, .03]) {
    const near = makeInlandTerrain(printFor(skyline.map((v, i) => Math.min(1, Math.max(0, v + amount * Math.sin(2.3 * i + 1))))));
    const turn = turnDeg(field, near);
    assert.ok(turn < 400 * amount + 1e-3, `${amount}: ${turn.toFixed(4)} degrees`);
    assert.ok(turn >= previous - 1e-9);
    assert.ok(Math.abs(near.reliefM - field.reliefM) < 1000 * amount + 1e-6);
    previous = turn;
  }
});
