import test from 'node:test';
import assert from 'node:assert/strict';
import { REAL_BIOMES } from '../src/world/RealBiomes.js';
import { landscapePolicy, landscapeBudget, landscapeLayerColor, landscapePasses, landscapeSnowAllowed, resolveLandscapePalette, resolveRangePresentation } from '../src/world/alpine/LandscapePolicy.js';
import { hexToRgb } from '../src/utils/color.js';

test('all real biomes have distinct, immutable landscape cover policies', () => {
  for (const { name } of REAL_BIOMES) {
    const p = landscapePolicy(name);
    assert.equal(p.key, name);
    assert.ok(Object.isFrozen(p));
    assert.ok(p.moisture >= 0 && p.moisture <= 1);
  }
  assert.equal(landscapePolicy('DESERT').moisture, 0);
  assert.ok(landscapePolicy('RAINFOREST').canopy > landscapePolicy('DESERT').canopy);
  assert.equal(landscapePolicy('CUSTOM').moisture, 0);
});

test('alpine depth is painted into each layer while other worlds keep their passes', () => {
  const base = '#314c40', sky = '#91abb2';
  const colors = ['L2', 'L3', 'L4', 'L5'].map(key => landscapeLayerColor(base, sky, key, 'RAINFOREST'));
  assert.equal(new Set(colors).size, 4);
  assert.equal(landscapePasses('alpine').scenicWire, false);
  assert.equal(landscapePasses('city').scenicWire, true);
  assert.equal(landscapePasses('alpine').connector, false);
  assert.equal(landscapePasses('alpine').shimmerSlices, false);
  assert.equal(landscapePasses('city').shimmerSlices, true);
  assert.ok(landscapeBudget(6).facetsPerLayer > 0);
});

function luma(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('live palettes stay distinct across depth, biome and night', () => {
  const day = resolveLandscapePalette({ profile: { name: 'RAINFOREST', silhouette: '#314c40' }, night01: 0, airColor: '#91abb2' });
  const night = resolveLandscapePalette({ profile: { name: 'RAINFOREST', silhouette: '#314c40' }, night01: 1, airColor: '#1a2430' });
  assert.ok(luma(day.layers.L2.base) - luma(day.layers.L5.base) >= 8);
  assert.ok(luma(night.layers.L5.base) < luma(day.layers.L5.base));
  const desert = resolveLandscapePalette({ profile: 'DESERT', night01: 0, airColor: '#d8c7a4' });
  const ice = resolveLandscapePalette({ profile: 'ICEFIELD', night01: 0, airColor: '#d8c7a4' });
  assert.notEqual(desert.ground.base, ice.ground.base);
  assert.equal(resolveLandscapePalette({ profile: 'NO-SUCH', night01: Number.NaN }).biomeKey, 'CUSTOM');
  const mid = resolveRangePresentation({ salienceSky: 0.5, voyageWeight: 0.25, quality: 6, reducedFlash: false });
  for (const key of ['spaceRidge', 'liveWeaver', 'retainedWeaver', 'ensemble', 'beams', 'ambient', 'oceanMarks', 'film']) {
    assert.ok(mid[key] >= 0 && mid[key] <= 1);
  }
  assert.equal(mid.oceanRows, landscapeBudget(6).oceanRows);
  assert.deepEqual(
    resolveRangePresentation({ night01: 0.2, salienceSky: 0.4, voyageWeight: 0.1, quality: 1, reducedFlash: true }),
    resolveRangePresentation({ night01: 0.2, salienceSky: 0.4, voyageWeight: 0.1, quality: 1, reducedFlash: true }),
  );
  assert.equal(resolveRangePresentation({ salienceSky: 0.2, voyageWeight: 1, reducedFlash: true }).spaceRidge, 1,
    'the Range signature remains present while ambient sky yields');
});

test('dry cover excludes snow while high wet mountain cover permits it', () => {
  assert.equal(landscapeSnowAllowed('DESERT', .99), false);
  assert.equal(landscapeSnowAllowed('ICEFIELD', .7), true);
  assert.equal(landscapeSnowAllowed('RAINFOREST', .8), false);
  assert.equal(landscapeSnowAllowed('RAINFOREST', .94), true);
});

test('pale daytime air preserves rainforest color in the lit far face', () => {
  const profile = REAL_BIOMES.find(b => b.name === 'RAINFOREST');
  const palette = resolveLandscapePalette({ profile, night01: 0, airColor: '#b4c2be' });
  const lit = hexToRgb(palette.layers.L2.faceLight);
  assert.ok(lit.g > lit.r + 4 && lit.g > lit.b + 2,
    `forest highlight became neutral: ${palette.layers.L2.faceLight}`);
});

test('distant forest cover shares the ridge depth instead of foreground contrast', () => {
  const palette = resolveLandscapePalette({ profile: 'RAINFOREST', night01: 0, airColor: '#b4c2be' });
  assert.equal(typeof palette.layers.L2.cover, 'string');
  assert.ok(luma(palette.layers.L2.cover) > luma(palette.layers.L4.cover) + 20);
  assert.ok(luma(palette.layers.L2.base) - luma(palette.layers.L2.cover) < 35,
    'far vegetation must not read as dark holes in a pale ridge');
});
