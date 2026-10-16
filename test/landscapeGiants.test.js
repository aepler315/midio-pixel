import { test } from 'node:test';
import assert from 'node:assert/strict';
import { giantMaskBytes, giantMaskData, giantAmounts, mirrorGiantSpan, aheadOfEye } from '../src/world/alpine/LandscapeGiants.js';
import { rangeQuality } from '../src/world/alpine/RangeQuality.js';
import { rangeActorsAt } from '../src/world/alpine/RangeActors.js';
test('cast peaks never enable giant shadows, clouds or reflections', () => {
  const frame = { actors: { presence: 1, midio: { peak: 1 }, broshi: { peak: .5 }, midasus: { peak: 0 } }, qualityLevel: 0 };
  assert.deepEqual(giantAmounts(frame), [0, 0, 0]);
  assert.deepEqual(giantAmounts({ ...frame, qualityLevel: 4 }), [0, 0, 0]);
  assert.equal(rangeQuality(3).landscapeGiants, true);
  assert.equal(rangeQuality(4).landscapeGiants, false);
  assert.deepEqual(giantAmounts({ ...frame, actors: null }), [0, 0, 0]);
});
test('a held individual peak never forces the other instrument lanes', () => {
  const sim = { biomes: { actorPeakOverride: { midio: 1, broshi: 0, midasus: 0 } }, rangeNarrative: { durationMs: 20000, sample: () => ({ sources: {} }) } };
  const a = rangeActorsAt(sim, 10000);
  assert.equal(a.midio.peak, 1); assert.equal(a.broshi.peak, 0); assert.equal(a.midasus.peak, 0);
});
test('world material masks have bounded residency and soft silhouette edges in every channel', () => {
  const data = giantMaskData();
  assert.equal(data.length, giantMaskBytes());
  for (let c = 0; c < 3; c++) {
    let full = 0, soft = 0;
    for (let i = c; i < data.length; i += 4) { if (data[i] === 255) full++; if (data[i] > 0 && data[i] < 255) soft++; }
    assert.ok(full > 40 && soft > 40, `channel ${c}: ${full} solid, ${soft} soft`);
  }
  assert.deepEqual(giantMaskData(), data);
});

// Clouds must not corrupt the terrain alpha consumed by crest light and
// the sampled mountain skyline; the atmosphere uses a separate copy pass.
test('giant atmosphere hook remains empty at cast peaks', async () => {
  const { RangeScene } = await import('../src/world/alpine/RangeScene.js');
  const frame = { qualityLevel: 0, actors: { presence: 1, midio: { peak: 1 }, midasus: { peak: 1 } } };
  assert.equal(RangeScene.prototype.renderSkyGiants.call({}, frame, 'view'), null);
});

test("Midio's mirrored sheet fills the lake from the far shore to the frame's lower edge", () => {
  // Eye 400 m above the lake, the frame's lower edge dipping 1 in 10, the
  // sheet 6 km out: the edge ray meets the lake 4 km out, and the lowered
  // mirror eye (lift .5) sees through it to (6000 * .1 - 400) * .5 = 100 m.
  assert.equal(mirrorGiantSpan([0, 2400, 0], [0, -.1, 1], [0, 2000, 6000], 2000, .5, 9999), 100 / .9);
  assert.equal(mirrorGiantSpan([0, 2400, 0], [0, .1, 1], [0, 2000, 6000], 2000, .5, 9999), 9999, 'no lake below the frame');
  assert.equal(mirrorGiantSpan([0, 2400, 0], [0, -.1, 1], [0, 2000, 3000], 2000, .5, 9999), 9999, 'sheet nearer than the frame edge');
});
test("Midio's giant keeps his open eye", () => {
  const data = giantMaskData(), red = (x, y) => data[(y * 128 + x) * 4];
  let hole = 0;
  for (let y = 0; y < 128; y++) for (let x = 40; x < 88; x++) {
    if (red(x, y) === 0 && red(x, y - 12) === 255 && red(x, y + 12) === 255) hole++;
  }
  assert.ok(hole > 10, `eye socket pixels: ${hole}`);
});

test("a listener's zoom never dollies past Midio's mirrored sheet", () => {
  const sheet = [0, 2000, 4000], forward = [0, 0, 1];
  assert.equal(aheadOfEye(sheet, [0, 2400, 0], forward, 600), sheet, 'unzoomed: untouched');
  assert.deepEqual(aheadOfEye(sheet, [50, 2300, 3700], forward, 600), [0, 2000, 4300]);
});
