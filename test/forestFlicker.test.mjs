import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flickerStats, compareFlickerReports } from '../tools/lib/forest-flicker.mjs';

test('flicker measures absolute changes of crop mean brightness, without cancelling opposite steps', () => {
  const s = flickerStats([10, 12, 9, 10]);
  assert.equal(s.meanStepChange, 2);
  assert.equal(s.maxStepChange, 3);
  assert.equal(s.brightnessRange, 3);
  assert.equal(s.meanBrightness, 10.25);
  assert.equal(s.relativeMeanStepChange, 2 / 10.25);
  for (const values of [[], [1], [1, NaN], [1, Infinity]]) assert.throws(() => flickerStats(values));
});

const fixture = luma => ({ audioSha256: 'same', params: { seed: '315', rangeTour: 'tetons' }, constructionSeed: 315,
  width: 1920, height: 1080, browser: 'same', environment: { renderer: 'SwiftShader', vendor: 'same', crossOriginIsolated: true }, errors: [],
  frames: [{ crop: { x: 94, y: 144, width: 512, height: 512 } }],
  flicker: { timeMs: 40000, steps: 16, referenceDepthM: 6000, pauseParity: true, frames: Array.from({ length: 17 }, (_, i) => ({
    index: i, offsetPx: i / 16, offsetM: i / 16, actualMs: 40000, heardMs: 40000, windowIndex: 5,
    renderedCamera: { eyeM: [i / 16, 0, 0], forward: [0, 0, -1], fovYDeg: 40, aspect: 16 / 9 }, meanBrightness: luma(i),
  })) } });

test('fixed-pose gate accepts equal or lower flicker and rejects a larger change', () => {
  const b = fixture(i => 90 + i % 2), lower = fixture(i => 60 + .5 * (i % 2)), higher = fixture(i => 90 + 2 * (i % 2));
  assert.equal(compareFlickerReports(b, b).pass, true);
  assert.equal(compareFlickerReports(b, lower).pass, true);
  assert.equal(compareFlickerReports(b, higher).pass, false);
});

test('flicker gate rejects changed crop, advancing time, unequal camera movement and incomplete captures', () => {
  const base = fixture(i => 90 + i % 2);
  for (const mutate of [
    r => { r.frames[0].crop.x++; },
    r => { r.flicker.frames[1].heardMs++; },
    r => { r.flicker.frames[1].renderedCamera.eyeM[0]++; },
    r => { r.flicker.frames.pop(); },
    r => { r.errors.push('shader error'); },
    r => { r.flicker.frames[1].meanBrightness = NaN; },
  ]) {
    const candidate = structuredClone(base); mutate(candidate);
    assert.throws(() => compareFlickerReports(base, candidate));
  }
});
