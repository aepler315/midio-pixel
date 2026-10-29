// Trio's ridge layers are painted offscreen (recolour, travel seams) and
// drawn into the scene with nearest sampling. Those sides used to be the
// full logical stage (1408x848) every frame for every range layer: sixteen
// pixels painted for each one shown on the Classic grid. They now follow
// the scene's device scale (twice it, capped at one pixel per logical unit)
// and are placed back over the same logical area.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager, TRAVEL_SURFACE_SUPERSAMPLE } from '../src/world/BiomeManager.js';

const stage = { width: 1408, height: 848 };
const transform = (s, e = 3, f = 4) => ({ a: s, b: 0, c: 0, d: s, e, f });

function fixture(deviceScale) {
  const mgr = Object.create(BiomeManager.prototype);
  const allocations = [], placed = [], sideCalls = [];
  const sideCtx = { globalAlpha: 1, globalCompositeOperation: 'source-over',
    setTransform(...m) { sideCalls.push(['transform', ...m]); }, clearRect(...a) { sideCalls.push(['clear', ...a]); },
    save() { sideCalls.push(['save']); }, restore() { sideCalls.push(['restore']); },
    beginPath() {}, rect(...a) { sideCalls.push(['rect', ...a]); }, clip() { sideCalls.push(['clip']); },
    drawImage(...a) { sideCalls.push(['draw', a[0].slot, ...a.slice(1)]); } };
  mgr._acquireTravelSurface = (canvas, slot, scale) => {
    allocations.push([slot, scale]);
    return { slot, width: Math.ceil(canvas.width * scale), height: Math.ceil(canvas.height * scale), getContext: () => sideCtx };
  };
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', getTransform: () => transform(deviceScale),
    save() {}, restore() {}, drawImage: (...a) => placed.push([a[0].slot, ...a.slice(1)]) };
  return { mgr, ctx, sideCtx, allocations, placed, sideCalls };
}

test('the side scale is twice the device scale, never above one pixel per logical unit', () => {
  const mgr = Object.create(BiomeManager.prototype);
  assert.equal(TRAVEL_SURFACE_SUPERSAMPLE, 2);
  assert.equal(mgr._travelSurfaceScale({ getTransform: () => transform(0.25) }), 0.5); // Classic 320x180
  assert.equal(mgr._travelSurfaceScale({ getTransform: () => transform(0.375) }), 0.75); // Medium
  assert.equal(mgr._travelSurfaceScale({ getTransform: () => transform(0.5) }), 1); // Detailed
  assert.equal(mgr._travelSurfaceScale({ getTransform: () => transform(1.5) }), 1);
  // A tilted layer keeps its scale (the rotation is not a shrink).
  const tilt = 0.1, s = 0.25;
  assert.ok(Math.abs(mgr._travelSurfaceScale({ getTransform: () => ({ a: s * Math.cos(tilt), b: s * Math.sin(tilt),
    c: -s * Math.sin(tilt), d: s * Math.cos(tilt), e: 0, f: 0 }) }) - 0.5) < 1e-12);
  assert.equal(mgr._travelSurfaceScale({}), 1, 'no transform: logical size as before');
});

test('a range layer is painted at the side scale against the logical stage and placed over it', () => {
  const { mgr, ctx, sideCtx, allocations, placed, sideCalls } = fixture(0.25);
  let painted = null;
  const drawSet = (...args) => { painted = { ctx: args[5], canvas: args[6] }; };
  const P = { name: 'SOLAR' };
  mgr._paintAlpineLayer(ctx, stage, 'L3', { drawSet, A: P, B: P, t: 1, stripsA: {}, stripsB: {},
    heightMulA: 1, heightMulB: 1, snowLineA: 1, snowLineB: 1, blend: null });
  assert.deepEqual(allocations, [['A', 0.5]]);
  assert.equal(painted.ctx, sideCtx);
  assert.equal(painted.canvas, stage, 'layout reads the logical stage, not the smaller surface');
  assert.deepEqual(sideCalls.slice(0, 3), [['transform', 1, 0, 0, 1, 0, 0], ['clear', 0, 0, 704, 424],
    ['transform', 0.5, 0, 0, 0.5, 0, 0]]);
  assert.deepEqual(placed, [['A', 0, 0, 1408, 848]]);
});

test('a travel mixes its sides pixel for pixel through logical seam clips', () => {
  const { mgr, ctx, allocations, placed, sideCalls } = fixture(0.25);
  const P = { name: 'SOLAR' }, Q = { name: 'TUNDRA' };
  mgr._paintAlpineLayer(ctx, stage, 'L3', { drawSet() {}, A: P, B: Q, t: 0.5, stripsA: {}, stripsB: {},
    heightMulA: 1, heightMulB: 1, snowLineA: 1, snowLineB: 1, blend: { travel: true, travelP: 0.5 } });
  assert.deepEqual(allocations, [['A', 0.5], ['B', 0.5], ['mix', 0.5]]);
  // Each seam clip is laid down in logical units, then the blits are 1:1.
  const clipAt = sideCalls.findIndex(c => c[0] === 'rect');
  assert.deepEqual(sideCalls[clipAt - 1], ['transform', 0.5, 0, 0, 0.5, 0, 0]);
  assert.deepEqual(sideCalls[clipAt + 2], ['transform', 1, 0, 0, 1, 0, 0]);
  const blits = sideCalls.filter(c => c[0] === 'draw');
  assert.ok(blits.length >= 2 && blits.every(c => c.length === 4 && c[2] === 0 && c[3] === 0), 'pixel-for-pixel blits');
  assert.deepEqual(placed, [['mix', 0, 0, 1408, 848]]);
});
