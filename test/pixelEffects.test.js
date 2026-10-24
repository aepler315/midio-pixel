import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasBuffers } from '../src/render/CanvasResidency.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { pixelRenderPolicy } from '../src/render/PixelRenderPolicy.js';
import { Renderer } from '../src/render/Renderer.js';
import { TitleBackdrop } from '../src/ui/TitleBackdrop.js';
const effects = await import('../src/render/PixelEffects.js').catch(() => ({}));
function surface(width = 320, height = 180) {
  const draws = [], stack = [], rects = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true,
    setTransform() {}, clearRect() {}, fillRect(...args) { rects.push({ args, color: this.fillStyle, op: this.globalCompositeOperation }); },
    drawImage(...args) { draws.push({ args, alpha: this.globalAlpha, op: this.globalCompositeOperation, smooth: this.imageSmoothingEnabled, filter: this.filter }); },
    createRadialGradient: () => ({ addColorStop() {} }),
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled] = stack.pop(); },
    beginPath() {}, arc() { assert.fail('pixel stars use rectangles'); }, fill() {},
    getImageData() { assert.fail('pixel effects never read back'); },
  };
  return { width, height, draws, rects, getContext: () => ctx };
}
test('pixel heat offsets are integral and bounded', () => {
  assert.equal(typeof effects.pixelHeatOffset, 'function');
  for (const unit of [1, 2]) for (const value of [-99, -.6, 0, .6, 99, NaN, Infinity]) {
    const offset = effects.pixelHeatOffset(value, { unit });
    assert.ok(Number.isInteger(offset) && Math.abs(offset) <= unit);
  }
});
test('pixel star footprints are deterministic and bounded integer clusters', () => {
  assert.equal(typeof effects.pixelStarShape, 'function');
  for (const unit of [1, 2]) for (let id = 0; id < 140; id++) {
    const shape = effects.pixelStarShape(id, .9, unit);
    assert.deepEqual(shape, effects.pixelStarShape(id, .9, unit));
    assert.ok(shape.length >= 1 && shape.length <= 5);
    for (const p of shape) assert.ok([p.x, p.y, p.size].every(Number.isInteger) && Math.abs(p.x) <= unit && Math.abs(p.y) <= unit && p.size === unit);
  }
});
test('glow takes one owned snapshot and uses nearest-neighbor copies with bounded flash strength', () => {
  assert.equal(typeof effects.drawPixelGlow, 'function');
  const residency = new GraphicsResidency({ budgetBytes: 1000000 });
  const buffers = new CanvasBuffers({ residency, makeCanvas: () => surface(0, 0) });
  const source = surface(), ctx = source.getContext();
  assert.equal(effects.drawPixelGlow(ctx, source, { buffers, unit: 1, strength: 1 }), true);
  const scratch = buffers.buffers.get('pixel-glow').canvas;
  assert.equal(scratch.draws.filter(d => d.args[0] === source).length, 1);
  assert.equal(source.draws.length, 4);
  assert.ok(source.draws.every(d => d.args[0] === scratch && d.smooth === false && d.op === 'screen'));
  assert.ok(source.draws.reduce((sum, d) => sum + d.alpha, 0) <= .10);
  assert.equal(residency.usedBytes, 320 * 180 * 4);
  buffers.dispose(); assert.equal(scratch.width, 0); assert.equal(residency.usedBytes, 0);
});
test('denied glow admission allocates nothing and safely skips the optional effect', () => {
  assert.equal(typeof effects.drawPixelGlow, 'function');
  const residency = new GraphicsResidency({ budgetBytes: 1 });
  const buffers = new CanvasBuffers({ residency, makeCanvas() { assert.fail('admission first'); } });
  const source = surface();
  assert.equal(effects.drawPixelGlow(source.getContext(), source, { buffers, unit: 1, strength: .1 }), false);
  assert.equal(source.draws.length, 0); assert.equal(residency.usedBytes, 0);
});
test('pixel title star positions and footprints stay fixed while brightness twinkles', () => {
  const backdrop = new TitleBackdrop({ seed: 315, width: 320, height: 180 });
  const draw = time => {
    const canvas = surface(); backdrop.draw(canvas.getContext(), time, { pixelPolicy: pixelRenderPolicy({ pixelated: true }) });
    return canvas.rects.filter(r => r.op === 'lighter');
  };
  const a = draw(3), b = draw(7);
  assert.ok(a.length >= 140 && a.length <= 700);
  assert.deepEqual(a.map(r => r.args), b.map(r => r.args));
  assert.notDeepEqual(a.map(r => r.color), b.map(r => r.color));
  assert.ok(a.every(r => r.args.every(Number.isInteger)));
});
test('pixel heat uses eight-pixel cells, heard time, and source-over coverage', () => {
  const canvas = surface(), renderer = new Renderer(canvas);
  renderer._postBuffers.makeCanvas = () => surface(0, 0);
  renderer.pixelPolicy = pixelRenderPolicy({ pixelated: true });
  const sim = { timeMs: 1000, heardTimeMs: 5000, perf: { heavyPostFx: true }, presentation: { performers: false },
    biomes: { world: { kind: 'unregistered-kind' }, currentFxAlpha: () => 1 }, midio: { groundY: 625 } };
  const draw = timeMs => {
    canvas.draws.length = 0; sim.timeMs = timeMs;
    renderer._drawHeatDistortion(canvas.getContext(), canvas, sim, { midioDrawX: 220 }, { width: 1280, height: 720 });
    return canvas.draws.map(d => ({ ...d, args: d.args.slice(1) }));
  };
  const first = draw(1000);
  assert.ok(first.length > 20);
  assert.ok(first.every(d => d.op === 'source-over' && d.smooth === false && d.args[2] === 10));
  for (const d of first) assert.ok(Number.isInteger(d.args[4] - d.args[0]) && Math.abs(d.args[4] - d.args[0]) <= 1);
  assert.deepEqual(draw(2000), first, 'heard time controls the distortion phase');
  renderer.dispose();
});
test('pixel bloom owns only its glow scratch and releases it on shedding or Alpine', () => {
  const canvas = surface(), renderer = new Renderer(canvas);
  renderer._postBuffers.makeCanvas = () => surface(0, 0);
  renderer.pixelPolicy = pixelRenderPolicy({ pixelated: true });
  const sim = { hype: { slam: 1, surge: 1 }, perf: { bloomEnabled: true }, biomes: { world: { kind: 'unregistered-kind' } } };
  renderer._drawBloom(canvas.getContext(), canvas, sim);
  assert.ok(renderer._postBuffers.buffers.has('pixel-glow'));
  assert.equal(renderer._postBuffers.buffers.has('bloom'), false);
  sim.perf.bloomEnabled = false; renderer._drawBloom(canvas.getContext(), canvas, sim);
  assert.equal(renderer._postBuffers.buffers.has('pixel-glow'), false);
  sim.perf.bloomEnabled = true; sim.biomes.world.kind = 'alpine'; renderer._drawBloom(canvas.getContext(), canvas, sim);
  assert.equal(renderer._postBuffers.buffers.size, 0);
  renderer.dispose();
});
