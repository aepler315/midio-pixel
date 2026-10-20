import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

const forbidden = () => { assert.fail('removed landscape overlay entered its legacy painter'); };

test('Landscape never paints synthetic equalizer mountains, ocean overlays or foreground ovals', () => {
  const manager = Object.assign(Object.create(BiomeManager.prototype), { world: { kind: 'alpine' },
    _massifGeometry: forbidden, _rotated: forbidden, stripsFor: forbidden, _zoomedGroundY: forbidden,
    flood: { active: true, level01: 1 }, pullback01: 1, _perf: { heavyPostFx: true } });
  const ctx = new Proxy({}, { get: () => forbidden });
  const canvas = { width: 1280, height: 720 };
  for (const method of ['_drawHorizonEQ', '_drawSpectrumMassif', '_drawDistantWave', '_drawOcean', '_drawFlood', '_drawForegroundSwell', 'drawForeground']) {
    manager[method](ctx, canvas, 0, {}, {}, 0);
  }
});

test('the real terrain partitions need no synthetic crest glow or synchronous skyline readback', () => {
  const calls = [];
  const manager = Object.assign(Object.create(BiomeManager.prototype), {
    rangePresentation: { drawPartition(_, band) { calls.push(band); } },
    _rotated: x => x, lerpCache: { get: x => x }, _drawCrestLight: forbidden,
    _drawFarVignettes() {}, _drawMidDepthLife() {},
  });
  manager._drawRangeV2Scenic({}, {}, {}, { A: { silhouette: '#555555' }, B: { silhouette: '#555555' },
    skyHorizonNight: '#000000', worldX: 0, originX: 0, t: 0 });
  assert.deepEqual(calls, ['far', 'mid', 'near']);
});
