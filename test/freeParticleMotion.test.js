import assert from 'node:assert/strict';
import test from 'node:test';
import { ParticleField } from '../src/world/ParticleField.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { captureRangeParticles } from '../src/world/alpine/RangeMidEffects.js';

function drawingContext() {
  const stack = [];
  return { globalAlpha: 1, rects: [], arcs: [], transform: { a: 2, b: 0, c: 0, d: 2, e: 13, f: 5 },
    getTransform() { return this.transform; }, setTransform(a, b, c, d, e, f) { this.transform = { a, b, c, d, e, f }; },
    save() { stack.push([this.globalAlpha, this.transform]); }, restore() { [this.globalAlpha, this.transform] = stack.pop(); },
    fillRect(x, y, w, h) { this.rects.push([x, y, w, h, this.globalAlpha]); },
    arc(x, y) { this.arcs.push([x, y, this.globalAlpha]); }, beginPath() {}, fill() {},
    moveTo() {}, lineTo(x, y) { this.arcs.push([x, y, this.globalAlpha]); }, stroke() {},
  };
}

const profile = { name: 'TAIGA', celestial: { haloColor: '#fff' } };
const frame = { A: profile, B: profile, t: 0, particleMul: 1 };
const options = { mandalaColor: '#fff', worldX: 0, originX: 0, particleMul: 1 };

function fixture() {
  const field = new ParticleField({ kind: 'snow', color: '#fff', count: 2, speed: 10 }, 200, 100, 1);
  Object.assign(field.particles[0], { x: 20, y: 30, size: 2 });
  Object.assign(field.particles[1], { x: 40, y: 30, size: 2 });
  const manager = { fields: new Map([['TAIGA', field]]), openingGain: 1, unravel: 0, freePixelMotion: true,
    _perf: { rimLightEnabled: false }, _rangeSky: { decorativeAlpha: 1 }, _activeWeatherIntensity: 0,
    _rotated: x => x, lerpCache: { get: () => '#fff' } };
  return { field, manager };
}

test('direct Landscape moves crisp particles independently between native cells', () => {
  const { field, manager } = fixture();
  Object.assign(manager, { directFullResolution: true, freePixelCellPx: 4 });
  const draw = () => {
    const ctx = drawingContext();
    BiomeManager.prototype._drawMidDepthLife.call(manager, ctx, {}, { ...frame, ctx }, options);
    return ctx;
  };
  assert.deepEqual(draw().rects, [[51, 63, 4, 4, .85], [91, 63, 4, 4, .85]]);
  field.particles[0].x += .5; field.particles[1].y -= .5;
  assert.deepEqual(draw().rects, [[52, 63, 4, 4, .85], [91, 62, 4, 4, .85]]);
  manager.freePixelMotion = false;
  assert.equal(draw().arcs.length, 2);
  manager.freePixelMotion = true; manager.directFullResolution = false;
  assert.equal(draw().arcs.length, 2);
});

test('hybrid capture freezes particle motion mode and positions and fits the replay surface', () => {
  const { field, manager } = fixture();
  const paint = captureRangeParticles(manager, frame, options);
  manager.freePixelMotion = false;
  field.particles[0].x = 99;
  const ctx = drawingContext();
  paint({ ctx, cellPx: 4 });
  assert.deepEqual(ctx.rects[0], [51, 63, 4, 4, .85]);
  ctx.setTransform(0, 3, -3, 0, 120, 14);
  paint({ ctx, cellPx: 6 });
  assert.deepEqual(ctx.rects[2], [27, 71, 6, 6, .85]);
  captureRangeParticles(manager, frame, options)({ ctx, cellPx: 6 });
  assert.equal(ctx.arcs.length, 2);
});

test('free grains preserve each authored opacity through a scene fade', () => {
  for (const [kind, alpha] of [['snow', .85], ['sand', .45], ['wind', .4], ['fireflies', .27], ['pollen', .27]]) {
    const field = new ParticleField({ kind, color: '#fff', count: 1, speed: 10 }, 200, 100, 4);
    field.particles[0].alpha = .27;
    const ctx = drawingContext(); ctx.globalAlpha = .6;
    field.draw(ctx, 1, null, 0, null, 4);
    field.draw(ctx);
    assert.equal(ctx.rects[0][4], alpha * .6, kind);
    assert.equal(ctx.rects[0][4], ctx.arcs[0][2], kind);
  }
});
