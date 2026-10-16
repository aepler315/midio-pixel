import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { drawTiledStrip } from '../src/world/SilhouetteGenerator.js';

const strip = { width: 200, height: 300,
  ridge: { heights: new Float32Array([0.5, 0.5, 0.5]), step: 100,
    baseline: 0.7, amplitude: 0.6, height: 300, anchor: 'ground' } };
const canvas = { width: 320, height: 720 };

for (const kick of [0, 1]) for (const growth of [0, 1]) for (const pullback of [0, 1]) for (const colW of [4, 16, 64]) {
  test(`static shading aligns with the bitmap: growth ${growth}, pullback ${pullback}, columns ${colW}, kick ${kick}`, () => {
    const mgr = Object.assign(Object.create(BiomeManager.prototype), {
      orogenyGrowth: growth, pullback01: pullback, tSec: 3,
      _danceKickMs: 2950, _danceKickAmp: kick, _danceGroove: 1, _danceSustain: 1,
      _eqSmoothed: [1, 1, 1, 1, 1, 1, 1], _geoFeatures: [],
      _perf: { danceColumnWidth: colW }, groundY: 600, h: 720,
    });
    for (const scroll of [-250.5, 0, 73.25, 450]) {
      const draws = [];
      drawTiledStrip({ drawImage: (s, x, y) => draws.push({ x, y }) }, strip, scroll, canvas.width, canvas.height, 12);
      const geom = mgr._crestPoints(canvas, strip, scroll, 12, 'L4', 1, 1, 'static');
      assert.equal(geom.dh, 300);
      assert.equal(geom.bottomY, 732);
      assert.ok(Math.abs(geom.pts[0].x - draws[0].x) < 1e-9);
      for (const p of geom.pts) assert.equal(p.y, 552); // 720-300+12 + (210-90)
    }
  });
}

test('static shading uses fitted bake vertices and closes non-divisible tiles at the foot', () => {
  const fitted = { width: 210, height: 300, ridge: { ...strip.ridge,
    ridgeYs: [80, 130, 90] } };
  const mgr = Object.create(BiomeManager.prototype);
  const geom = mgr._crestPoints(canvas, fitted, 0, 12, 'L2', 1, 1, 'static');
  assert.deepEqual(geom.pts.slice(0, 5).map(({ x, y }) => [x, y]),
    [[0, 512], [100, 562], [200, 522], [210, 732], [210, 512]]);
  assert.equal(geom.bakedCrestY, 512);
});
