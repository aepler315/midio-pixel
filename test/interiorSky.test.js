import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

const canvas = { width: 1280, height: 720 };
const palette = { sky: ['#102030', '#203040', '#304050'], fx: 'starTwinkle' };

function paintSky(draw, phenomenaFull, fx = 'starTwinkle', kind = undefined) {
  const colors = { ...palette, fx };
  const draws = [], stack = [];
  const gradient = kind => ({ kind, addColorStop() {} });
  const ctx = {
    globalAlpha: 1, fillStyle: '', globalCompositeOperation: 'source-over',
    save() { stack.push([this.globalAlpha, this.fillStyle, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.fillStyle, this.globalCompositeOperation] = stack.pop(); },
    createLinearGradient: () => gradient('linear'),
    createRadialGradient: () => gradient('radial'),
    fillRect(...rect) { draws.push({ rect, style: this.fillStyle }); },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    translate() {}, rotate() {}, scale() {}, stroke() {},
    fill() { draws.push({ style: this.fillStyle }); },
  };
  const mgr = Object.assign(Object.create(BiomeManager.prototype), {
    world: kind ? { id: 'custom', kind } : undefined,
    tSec: 5, openingGain: 1, calmLevel: 0,
    _perf: { phenomenaFull }, _rotated: x => x, lerpCache: { get: a => a },
    stars: [{ xFrac: 0.4, yFrac: 0.3, size: 1, layer: 0, bright: 0.8, phase: 0, hue: 0 }],
    _starBuckets: new Map(), dustLanes: [], deepSky: [], planets: [],
  });
  if (draw) {
    // Stop at the first foreground pass; keep the real world -> sky -> stars path.
    const complete = new Error('sky complete');
    mgr._drawCelestial = () => { throw complete; };
    assert.throws(() => draw(mgr, { ctx, canvas, A: colors, B: colors, t: 0,
      dn: { sunAlt: 0.6 }, phenomenaFull }), error => error === complete);
  } else {
    mgr._drawSky(ctx, canvas, colors, colors, 0, 1);
  }
  return draws;
}

test('the default open sky still paints astronomical layers', () => {
  assert.ok(paintSky(null, true).length > 4);
});
