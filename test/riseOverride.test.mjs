import test from 'node:test';
import assert from 'node:assert/strict';
import { riseOverrideFrom, compileLandscapeScore } from '../src/world/alpine/LandscapeScore.js';
import { parseReviewArgs, makeReviewManifest } from '../tools/landscape-review.mjs';

test('?rangeRise reads a height in 0..1 and ignores anything else', () => {
  assert.equal(riseOverrideFrom(''), null);
  assert.equal(riseOverrideFrom('?rangeRise=0.5'), 0.5);
  assert.equal(riseOverrideFrom('?rangeRise=0'), 0);
  assert.equal(riseOverrideFrom('?rangeRise=1'), 1);
  for (const bad of ['?rangeRise=', '?rangeRise=1.5', '?rangeRise=-0.1', '?rangeRise=x']) assert.equal(riseOverrideFrom(bad), null, bad);
});

test('a held rise replaces the musical climb at every heard time; previews stay complete', () => {
  const curves = { globalEnergyNorm: () => 0.5 };
  const free = compileLandscapeScore({ energyCurves: curves, durationMs: 180000, riseOverride: null });
  const held = compileLandscapeScore({ energyCurves: curves, durationMs: 180000, riseOverride: 2 / 3 });
  assert.ok(free.at(1000).rise01 < 0.5);
  for (const t of [0, 1000, 60000, 179000]) assert.equal(held.at(t).rise01, 2 / 3);
  assert.equal(held.at(1000, { preview: true }).rise01, 1);
});

test('the review tool passes --rise through as a diagnostic URL switch', () => {
  const a = parseReviewArgs(['--out', '.smoke/x', '--view', 'teton-jackson-lake', '--rise', '0.333']);
  assert.equal(a.rise, 0.333);
  const m = makeReviewManifest(a, 'detailed');
  assert.deepEqual(m.settings.debug, { rangeRise: 0.333 });
  assert.throws(() => parseReviewArgs(['--out', '.smoke/x', '--rise', '2']), /rise must be/);
  assert.equal(makeReviewManifest(parseReviewArgs(['--out', '.smoke/x']), 'detailed').settings.debug, undefined);
});
