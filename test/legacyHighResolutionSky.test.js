import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

test('legacy sky replays at destination transform and preserves canvas state', () => {
  const calls = [];
  const ctx = Object.fromEntries(['save', 'restore', 'setTransform', 'translate', 'scale']
    .map(name => [name, (...args) => calls.push([name, ...args])]));
  const manager = Object.assign(Object.create(BiomeManager.prototype), {
    highResolutionSky: true,
    rangeSkyLayer: { width: 320, height: 180, skyLens: 2, drawLegacySky: target => calls.push(['draw', target === ctx]) },
  });
  assert.equal(manager.drawHighResolutionSky(ctx, {}, { transform: [4, 0, 0, 4, 20, 30] }), true);
  assert.deepEqual(calls, [
    ['save'], ['setTransform', 4, 0, 0, 4, 20, 30], ['translate', 160, 90],
    ['scale', .5, .5], ['translate', -160, -90], ['draw', true], ['restore'],
  ]);
  assert.equal(manager._highResolutionSkyRenderer, undefined);
});

test('legacy sky uses smooth stars only while replaying, even after a paint error', () => {
  const ctx = Object.fromEntries(['save', 'restore', 'setTransform', 'translate', 'scale'].map(name => [name, () => {}]));
  const manager = Object.assign(Object.create(BiomeManager.prototype), {
    highResolutionSky: true,
    rangeSkyLayer: { width: 320, height: 180, skyLens: 1, drawLegacySky: () => {
      assert.equal(manager._smoothLegacySky, true);
      throw Error('paint failed');
    } },
  });
  assert.throws(() => manager.drawHighResolutionSky(ctx, {}), /paint failed/);
  assert.equal(manager._smoothLegacySky, false);
});

test('smooth star points keep a constant output size at different terrain scales', () => {
  const radii = [];
  for (const scale of [2, 4]) {
    const ctx = { save() {}, restore() {}, beginPath() {}, fill() {}, moveTo() {},
      arc(_x, _y, radius) { radii.push(radius * scale); },
      rect() { assert.fail('smooth stars should not be drawn as square blocks'); },
      getTransform() { return { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }; } };
    const manager = { world: { kind: 'alpine' }, _smoothLegacySky: true,
      openingGain: 1, tSec: 0, stars: [{ xFrac: .2, yFrac: .1, bright: 1, layer: 2, phase: 0, hue: 0 }],
      planets: [], dustLanes: [], deepSky: [], _starBuckets: new Map(),
      _rangeSky: { starBrightnessAt: () => 1 } };
    BiomeManager.prototype._drawStarfield.call(manager, ctx, { width: 320, height: 180 }, { fx: '' }, { fx: '' }, 0, 1, { atmosphere: false });
  }
  assert.deepEqual(radii, [.8, .8]);
});

test('smooth legacy water preserves mirage, surface and ocean life order', () => {
  const calls = [];
  const manager = {
    _drawFataMorgana: () => calls.push('mirage'),
    _drawOcean: (_ctx, _canvas, _x, _a, _b, _t, _full, night) => calls.push(`water:${night}`),
    _drawOceanLife: () => calls.push('life'),
  };
  const ctx = { save() {}, restore() {}, globalAlpha: 1 };
  BiomeManager.prototype._drawLegacyWaterBackground.call(manager, ctx, {},
    { worldX: 0, A: {}, B: {}, t: 0, phenomenaFull: true, night: .8 });
  assert.deepEqual(calls, ['mirage', 'water:0.8', 'life']);
});
