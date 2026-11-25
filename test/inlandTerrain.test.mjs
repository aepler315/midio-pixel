import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlandCharacter, makeInlandTerrain } from '../src/world/terrain/InlandTerrain.js';

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

test('the measured outline and heard-time evidence share stable relief, roughness and activity', () => {
  const broad = Array.from({ length: 16 }, (_, i) => .25 + .45 * Math.sin(Math.PI * i / 15));
  const jagged = broad.map((_, i) => i % 2 ? .95 : .05);
  const base = makeInlandTerrain(printFor(broad));
  const near = makeInlandTerrain(printFor(broad.map((v, i) => v + .001 * Math.cos(i))));
  const different = makeInlandTerrain(printFor(jagged));
  for (const axis of ['relief', 'ruggedness', 'activity']) {
    assert.ok(Math.abs(base.character[axis] - near.character[axis]) < .006);
    assert.ok(different.character[axis] > base.character[axis] + .20);
  }
  assert.deepEqual(inlandCharacter({ skyline: broad }), base.character, 'previous fields recover their outline-only controls');
  const series = Array(40).fill(.5), timeline = { version: 1, stepMs: 2000, key: { tonic: 0, major: true, confidence: .9 },
    dynamics: .5, loudness: series, brightness: series, tension: series, novelty: series, major: series };
  const controls = changes => makeInlandTerrain({ ...printFor(broad), timeline: { ...timeline, ...changes } }).character;
  const average = controls({});
  const active = controls({ novelty: Array(40).fill(.9) });
  assert.deepEqual([active.relief, active.ruggedness], [average.relief, average.ruggedness]);
  assert.ok(active.activity > average.activity + .19);
  assert.ok(controls({ tension: Array(40).fill(.9) }).ruggedness > average.ruggedness + .17);
  assert.ok(controls({ dynamics: .9 }).relief > average.relief + .13);
  assert.deepEqual(controls({ tension: [] }), base.character, 'invalid timeline falls back to the measured outline');
  const uncertain = makeInlandTerrain({ ...printFor(broad), timeline: { ...timeline, key: { ...timeline.key, confidence: 0 } } });
  assert.equal(uncertain.east, base.east);
  assert.equal(uncertain.north, base.north);
});
