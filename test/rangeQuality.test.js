// Range v2 quality ladder (Task 16): the order the GPU scene sheds work in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeQuality, easeRungAmount, RUNG_FADE_SEC } from '../src/world/alpine/RangeQuality.js';
import { MIST_SAMPLES } from '../src/world/alpine/RangeAtmosphere.js';

test('the ladder sheds foliage first, then fog sampling, then pool reflections; level 0 is full quality', () => {
  const q = [0, 1, 2, 3, 4, 5, 6].map(rangeQuality);
  assert.deepEqual(q[0], { level: 0, forestKeep: 1, nearDetail: true, mistSteps: MIST_SAMPLES, poolReflections: true, sunShafts: true, landscapeGiants: true, waterMirror: true,
    cloudShadows: true });
  for (let i = 0; i < q.length; i++) assert.equal(q[i].cloudShadows, i < 4, 'cloud shadows go with the lake mirror');
  for (let i = 1; i < q.length; i++) {
    assert.ok(q[i].forestKeep <= q[i - 1].forestKeep, 'foliage never returns while shedding');
    assert.ok(q[i].mistSteps <= q[i - 1].mistSteps, 'fog sampling never returns while shedding');
  }
  // The forest's first saving is a cheaper representation of the same
  // trees; thinning follows, never before it.
  const firstForest = q.findIndex((x) => x.forestKeep < 1 || !x.nearDetail);
  const firstThin = q.findIndex((x) => x.forestKeep < 1);
  assert.ok(q.findIndex((x) => !x.nearDetail) < firstThin, 'representation before deletion');
  for (let i = q.findIndex((x) => !x.nearDetail); i < q.length; i++) assert.equal(q[i].nearDetail, false);
  const firstFog = q.findIndex((x) => x.mistSteps < MIST_SAMPLES);
  const firstReflection = q.findIndex((x) => !x.poolReflections);
  assert.ok(firstForest < firstFog && firstFog < firstReflection, `${firstForest} < ${firstFog} < ${firstReflection}`);
  const firstMirror = q.findIndex((x) => !x.waterMirror);
  assert.ok(firstFog < firstMirror && firstMirror < firstReflection, 'the lake mirror goes after fog, before pool reflections');
  for (let i = firstMirror; i < q.length; i++) assert.equal(q[i].waterMirror, false);
  assert.ok(q[6].mistSteps >= 2, 'fog thins, never vanishes');
});

test('levels outside the governor range clamp', () => {
  assert.deepEqual(rangeQuality(-3), rangeQuality(0));
  assert.deepEqual(rangeQuality(99), rangeQuality(6));
});

test('a rung fade eases monotonically, holds while paused and snaps on a seek', () => {
  assert.equal(RUNG_FADE_SEC, 1.5);
  let v = 1, t = 0;
  const seen = [];
  while (t < 1.5 + 1e-9) { v = easeRungAmount(v, 0, 1 / 60); t += 1 / 60; seen.push(v); }
  assert.ok(seen.every((x, i) => i === 0 || x <= seen[i - 1]), 'monotone down');
  assert.equal(v, 0, 'reaches the target within sec');
  assert.ok(seen[44] > 0 && seen[44] < 1, 'intermediate values while fading');
  v = 0; for (let i = 0; i < 91; i++) { const next = easeRungAmount(v, 1, 1 / 60); assert.ok(next >= v); v = next; }
  assert.equal(v, 1);
  assert.equal(easeRungAmount(.4, 1, 0), .4, 'paused: holds');
  assert.equal(easeRungAmount(.4, 0, 3), 0, 'seek forward: snaps');
  assert.equal(easeRungAmount(.4, 1, -.1), 1, 'seek back: snaps');
  assert.equal(easeRungAmount(.4, 1, NaN), 1);
  assert.equal(easeRungAmount(undefined, 1, 1 / 60), 1, 'first frame snaps');
  assert.equal(easeRungAmount(NaN, 0, 1 / 60), 0);
  assert.equal(easeRungAmount(.8, 0, 1 / 60, { down: 'snap' }), 0, 'a snap-down shed drops at once');
  assert.ok(Math.abs(easeRungAmount(.2, 1, .1, { down: 'snap' }) - (.2 + .1 / 1.5)) < 1e-12, 'and still eases up');
  assert.ok(Math.abs(easeRungAmount(.5, 1, .3, { sec: 3 }) - .6) < 1e-12);
});
