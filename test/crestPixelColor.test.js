import test from 'node:test';
import assert from 'node:assert/strict';
import * as colors from '../src/render/CrestPixelColors.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { RangeCrest } from '../src/world/alpine/RangeCrest.js';

// A small software canvas checks copy/compositing semantics without GPU work.
function canvas(width, height, pixel = null) {
  const target = { width, height, pixels: null, copies: [] };
  const ctx = { canvas: target, globalAlpha: 1, globalCompositeOperation: 'source-over',
    setTransform() {}, clearRect() { target.pixels = new Uint8ClampedArray(target.width * target.height * 4); },
    getImageData() { throw new Error('output CPU readback is forbidden'); },
    drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
      assert.equal(sw, dw); assert.equal(sh, dh);
      target.copies.push([sx, sy, sw, sh, dx, dy, dw, dh, this.globalAlpha, this.globalCompositeOperation]);
      if (!target.pixels || target.pixels.length !== target.width * target.height * 4) this.clearRect();
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const rgba = source.pixel(sx + x, sy + y), i = ((dy + y) * target.width + dx + x) * 4;
        const a = this.globalAlpha;
        for (let c = 0; c < 4; c++) target.pixels[i + c] = this.globalCompositeOperation === 'copy' ? rgba[c] : Math.round(rgba[c] * a + target.pixels[i + c] * (1 - a));
      }
    },
    createPattern(source, repeat) { return { source, repeat, setTransform(matrix) { this.matrix = matrix; } }; },
  };
  target.pixel = (x, y) => pixel ? pixel(x, y) : Array.from(target.pixels.subarray((y * target.width + x) * 4, (y * target.width + x) * 4 + 4));
  target.getContext = () => ctx;
  return target;
}
const geometry = (xs, ys) => ({ x: Float32Array.from(xs), y: Float32Array.from(ys), count: xs.length });
const fit = { x: 0, y: 0, width: 20, height: 20, scale: 1 };
const point = (pattern, x, y) => pattern.source.pixel(x - pattern.matrix.e, y - pattern.matrix.f);
function setup(width = 20, height = 20, pixel = (x, y) => [x * 2, y * 2, 40, 255], budgetBytes = 1e6) {
  assert.equal(typeof colors.CrestColorPattern, 'function', 'provide the GPU-copy color owner');
  const output = canvas(width, height, pixel), made = [];
  const residency = new GraphicsResidency({ budgetBytes });
  const owner = new colors.CrestColorPattern({ residency, makeCanvas(w, h) { const c = canvas(w, h); made.push(c); return c; } });
  return { output, made, residency, owner };
}

test('GPU copies blend the actual physical pixel above/below into an opaque unsnapped pattern without readback', () => {
  const { output, made, owner } = setup(20, 20, (x, y) => y < 8 ? [20 + x * 2, 40, 240, 255] : [100, 100 + x * 2, 20, 255]);
  const pattern = owner.prepare(output.getContext(), fit, [geometry([4.5, 8.5], [8, 8])]);
  assert.ok(pattern);
  assert.deepEqual(point(pattern, 4, 8), [64, 74, 130, 255]);
  assert.deepEqual(point(pattern, 8, 8), [68, 78, 130, 255]);
  assert.equal(made[0].copies.length, 2, 'one above copy and one half-opacity below copy');
  assert.equal(made[0].copies[0].at(-2), 1);
  assert.equal(made[0].copies[1].at(-2), .5);
  assert.equal(pattern.repeat, 'no-repeat');
  owner.release();
});

test('physical output offset/capture scale map the pattern back to the same output pixels', () => {
  const { output, owner } = setup(80, 60);
  const pattern = owner.prepare(output.getContext(), { x: 12, y: 9, scale: 2, width: 40, height: 40 }, [geometry([10.25], [7.25])]);
  assert.deepEqual(point(pattern, 32, 23), [64, 46, 40, 255]);
  assert.ok(pattern.matrix.e > 0 && pattern.matrix.f > 0, 'bounded scratch keeps a nonzero physical origin');
  owner.release();
});

test('fresh corrected output is captured before strokes, even when a scratch canvas is reused', () => {
  let land = [100, 120, 140, 255];
  const { output, made, owner } = setup(20, 20, (_, y) => y < 8 ? [20, 40, 60, 255] : land);
  const geo = [geometry([4.5, 8.5], [8, 8])];
  const first = owner.prepare(output.getContext(), fit, geo);
  assert.deepEqual(point(first, 4, 8), [60, 80, 100, 255]);
  land = [180, 200, 220, 255];
  const next = owner.prepare(output.getContext(), fit, geo);
  assert.deepEqual(point(next, 4, 8), [100, 120, 140, 255]);
  assert.equal(made.length, 1);
  owner.release();
});

test('scratch is admitted before allocation, reused, and released on resize/disposal', () => {
  const denied = setup(20, 20, undefined, 1);
  assert.equal(denied.owner.prepare(denied.output.getContext(), fit, [geometry([4.5], [8])]), null);
  assert.equal(denied.made.length, 0);
  const { output, made, owner, residency } = setup();
  const geo = [geometry([4.5], [8])];
  owner.prepare(output.getContext(), fit, geo);
  assert.ok(residency.usedBytes > 0);
  const first = made[0];
  owner.prepare(output.getContext(), fit, geo);
  assert.equal(made.length, 1);
  owner.prepare(canvas(40, 40, () => [20, 40, 60, 255]).getContext(), fit, geo);
  assert.equal(made.length, 2);
  assert.equal(first.width, 0);
  owner.release(); owner.release();
  assert.equal(residency.usedBytes, 0);
  assert.equal(made[1].width, 0);
});

test('missing geometry, copy failure and unsupported patterns omit the current edge and release stale scratch', () => {
  const { output, made, owner, residency } = setup();
  const geo = [geometry([4.5], [8])];
  assert.ok(owner.prepare(output.getContext(), fit, geo));
  assert.equal(owner.prepare(output.getContext(), fit, [geometry([NaN], [8])]), null);
  assert.equal(residency.usedBytes, 0);
  assert.equal(made[0].width, 0);
  owner.prepare(output.getContext(), fit, geo);
  made.at(-1).getContext().drawImage = () => { throw new Error('copy failed'); };
  assert.equal(owner.prepare(output.getContext(), fit, geo), null);
  assert.equal(residency.usedBytes, 0);
  output.getContext().createPattern = () => null;
  assert.equal(owner.prepare(output.getContext(), fit, geo), null);
  assert.equal(residency.usedBytes, 0);
});

test('all bands share a pattern of corrected visible terrain captured before any stroke', () => {
  const events = [], strokes = [];
  let correction = 0;
  const output = canvas(20, 20, (_, y) => y < 8 ? [10, 20, 30, 255]
    : [110 + correction * 20, 120 + correction * 20, 130 + correction * 20, 255]);
  const ctx = output.getContext(), createPattern = ctx.createPattern;
  ctx.createPattern = (...args) => { events.push(`pattern:${correction}`); return createPattern(...args); };
  Object.assign(ctx, { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, closePath() {}, moveTo() {}, lineTo() {},
    stroke() { events.push('stroke'); strokes.push(this.strokeStyle); } });
  const crest = new RangeCrest({ makeCanvas: (w, h) => canvas(w, h) });
  const band = () => ({ geometry: { ...geometry([4.5, 8.5], [8, 8]), column: Int32Array.of(4, 8) },
    skip: new Uint8Array(20), skyline: new Uint8Array(20).fill(1), e: new Float32Array(20).fill(.5), vis: new Float32Array(20).fill(1),
    minNearer: new Float32Array(20).fill(NaN), line: new Float32Array(20).fill(NaN), chunks: [] });
  crest._grid = { far: band(), mid: band(), near: { ...band(), geometry: null } };
  crest.snapshot = { frameId: 1, fade: 1, grid: { width: 20, height: 20 }, splitReady: true, splitAlpha: 1, outputGeometry: true };
  crest._edges = { count: 1 }; crest._edgeFrame = 1; crest._split = {}; crest._cut = {};
  crest._drawEdges = () => { correction = 1; events.push('edges'); };
  crest._drawSplit = () => { correction = 2; events.push('split'); };
  crest._drawPockets = () => { correction = 3; events.push('pockets'); };
  crest.drawCrest(ctx, fit, 1, { cut: true });
  assert.deepEqual(events, ['edges', 'split', 'pockets', 'pattern:3', 'stroke', 'stroke']);
  assert.equal(strokes[0], strokes[1], 'freeze one pattern before all bands');
  assert.deepEqual(point(strokes[0], 4, 8), [90, 100, 110, 255]);
  crest._colorPattern.release();
});

test('color storage cannot evict terrain and every failed allocation or lost context releases ownership', () => {
  const { output, owner, residency } = setup(20, 20, undefined, 2000);
  const terrain = residency.reserve({ key: 'terrain', bytes: 1000, evictable: true });
  residency.commit(terrain, {});
  assert.equal(owner.prepare(output.getContext(), fit, [geometry([4.5], [8])]), null);
  assert.equal(residency.has('terrain'), true);
  assert.equal(residency.usedBytes, 1000);
  residency.release('terrain');
  owner.makeCanvas = () => { throw new Error('allocation interrupted'); };
  assert.equal(owner.prepare(output.getContext(), fit, [geometry([4.5], [8])]), null);
  assert.equal(residency.usedBytes, 0);
  output.getContext().isContextLost = () => true;
  assert.equal(owner.prepare(output.getContext(), fit, [geometry([4.5], [8])]), null);
  assert.equal(residency.usedBytes, 0);
});

test('the pattern covers a visible steep segment entering from an offscreen endpoint', () => {
  const { output, owner } = setup();
  const pattern = owner.prepare(output.getContext(), fit, [geometry([5.5, 6.5], [-8, 10])]);
  assert.ok(pattern);
  assert.equal(pattern.matrix.f, 1, 'include the visible segment up to the first row with both neighbours');
  assert.deepEqual(point(pattern, 6, 3), [12, 6, 40, 255]);
  assert.equal(owner.prepare(output.getContext(), fit, [geometry([5.5, 6.5], [-10, -8])]), null);
  owner.release();
});
