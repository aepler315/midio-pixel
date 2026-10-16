import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendSections, medianBeatSec, sectionIndexAt } from '../src/world/BiomeSchedule.js';

const sections = [
  { startMs: 0, profile: 'alpine', transition: 'fade', barMs: 500 },
  { startMs: 1000, profile: 'city', transition: 'cut', barMs: 500, heightMul: 1.2 },
];

test('BiomeSchedule keeps beat and section timing pure and renderer-free', () => {
  assert.equal(medianBeatSec([{ ms: 0, numerator: 4 }, { ms: 2000 }, { ms: 4000 }]), 0.5);
  assert.equal(medianBeatSec([]), null);
  assert.equal(sectionIndexAt(sections, 0), 0);
  assert.equal(sectionIndexAt(sections, 1500), 1);
  assert.equal(sectionIndexAt([], 0), -1);
});

test('BiomeSchedule blends section height metadata with the same transition envelope', () => {
  const before = blendSections(sections, 1000);
  assert.equal(before.from, 'alpine');
  assert.equal(before.to, 'city');
  assert.equal(before.fromHeightMul, 1);
  assert.equal(before.toHeightMul, 1.2);
  assert.ok(before.t >= 0 && before.t < 1);

  const after = blendSections(sections, 2000);
  assert.deepEqual(after, {
    from: 'city', to: 'city', t: 1,
    fromHeightMul: 1.2, toHeightMul: 1.2,
    fromSnowLine01: 1, toSnowLine01: 1,
  });
});
