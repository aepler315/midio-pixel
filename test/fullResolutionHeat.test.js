import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';

function heatDraws(scale) {
  const draws = [];
  const canvas = { width: 1280 * scale, height: 720 * scale };
  const scratchCtx = { drawImage() {} };
  const scratch = { width: canvas.width, height: canvas.height, getContext: () => scratchCtx };
  const ctx = { canvas, save() {}, restore() {}, drawImage(...args) { draws.push(args.slice(1)); } };
  const renderer = Object.create(Renderer.prototype);
  renderer.pixelPolicy = null;
  renderer._postBuffers = { ensure: () => scratch };
  renderer._drawHeatDistortion(ctx, canvas, { fire: { active: true, intensity01: 1 }, timeMs: 1000 }, null,
    { width: 1280, height: 720 }, { x: 0, y: 0, width: canvas.width, height: canvas.height }, scale);
  return draws;
}

test('full-resolution heat preserves its normalized pattern and displacement at recording sizes', () => {
  const full = heatDraws(1), half = heatDraws(.5);
  assert.ok(full.length > 0);
  assert.equal(half.length, full.length);
  for (let i = 0; i < full.length; i++) for (let j = 0; j < full[i].length; j++) {
    assert.ok(Math.abs(half[i][j] * 2 - full[i][j]) < 1e-6);
  }
});

test('heat runs on heard time: equal heard times give identical offsets whatever the dispatch clock', () => {
  const run = (sim) => {
    const draws = [];
    const canvas = { width: 1280, height: 720 };
    const scratch = { width: 1280, height: 720, getContext: () => ({ drawImage() {} }) };
    const ctx = { canvas, save() {}, restore() {}, drawImage(...args) { draws.push(args.slice(1)); } };
    const renderer = Object.create(Renderer.prototype);
    renderer.pixelPolicy = null;
    renderer._postBuffers = { ensure: () => scratch };
    renderer._drawHeatDistortion(ctx, canvas, sim, { midioDrawX: 400 }, { width: 1280, height: 720 });
    return draws;
  };
  // Ambient (a visible wildfire in a non-alpine world) and a performer drop.
  const base = { fire: { active: true, intensity01: 1 }, biomes: { world: { kind: 'unregistered-kind' }, currentFxAlpha: () => 0 },
    midio: { groundY: 625 }, presentation: { performers: true }, hype: { dropAtMs: 4950 } };
  const a = run({ ...base, timeMs: 5000, heardTimeMs: 5000 });
  const b = run({ ...base, timeMs: 5300, heardTimeMs: 5000 });
  assert.ok(a.length > 10);
  assert.deepEqual(b, a);
  assert.notDeepEqual(run({ ...base, timeMs: 5300, heardTimeMs: 5100 }), a, 'heard time does move the pattern');
});

test('deferred optical effects draw the HUD after film at the destination resolution', () => {
  const order = [], renderer = Object.create(Renderer.prototype);
  const ctx = { canvas: {}, save() {}, restore() {}, setTransform() {}, beginPath() {}, rect() {}, clip() {} };
  renderer._deferredPostEffects = { sim: {}, viewStage: { width: 1280, height: 720 },
    film: true, hud: { width: 1280, height: 720 } };
  renderer._drawBloom = () => order.push('bloom');
  renderer._drawHeatDistortion = () => order.push('heat');
  renderer._drawFilmFinish = () => order.push('film');
  renderer._drawComposerHud = (_, stage) => order.push(['hud', stage.width, stage.height]);
  renderer.drawDeferredPostEffects(ctx, { x: 0, y: 0, width: 640, height: 360 });
  assert.deepEqual(order, ['bloom', 'heat', 'film', ['hud', 1280, 720]]);
});
