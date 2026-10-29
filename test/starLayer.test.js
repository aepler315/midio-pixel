// The starfield's ordinary stars are composited as one additive image
// instead of a path fill per colour/alpha bucket (each a general path of
// sub-pixel rects -- the largest single GPU cost of a Trio frame). The image
// must carry the same light per pixel: colour x alpha x the area of the
// star's rect over that pixel, summed, clamped as additive canvas
// compositing clamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

class FakeImageData {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
}

function harness({ transform = { a: .25, b: 0, c: 0, d: .25, e: 0, f: 0 }, width = 32, height = 16 } = {}) {
  const puts = [], draws = [];
  const layerCtx = { putImageData(image, dx, dy, x, y, w, h) {
    // Snapshot the uploaded region (straight RGBA) as the GPU would see it.
    const pixels = new Map();
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const k = (yy * image.width + xx) * 4;
      if (image.data[k + 3]) pixels.set(`${xx},${yy}`, Array.from(image.data.subarray(k, k + 4)));
    }
    puts.push({ rect: [x, y, w, h], pixels });
  } };
  const previous = { document: globalThis.document, ImageData: globalThis.ImageData };
  globalThis.ImageData = FakeImageData;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => layerCtx }) };
  const ctx = { canvas: { width, height }, getTransform: () => transform, globalAlpha: .3, globalCompositeOperation: 'lighter',
    save() { draws.push('save'); }, restore() { draws.push('restore'); }, setTransform(...m) { draws.push(['transform', ...m]); },
    drawImage(...args) { draws.push(['draw', ...args.slice(1)]); } };
  const mgr = Object.create(BiomeManager.prototype);
  return { mgr, ctx, puts, draws, restore() { Object.assign(globalThis, previous); } };
}

const buckets = (...list) => new Map(list.map((b, i) => [i, { alpha: b.alpha, style: b.style, rects: [...b.rects] }]));

test('one image carries each star as its rect area over the pixels it covers', () => {
  const h = harness();
  try {
    // Logical 1px rects under a 0.25 device scale: a sixteenth of a pixel.
    const field = buckets({ alpha: .5, style: '#ffffff', rects: [10, 20, 1] },
      // (11.6, 24) -> device x 2.9..3.15: split 0.1 / 0.15 across two columns.
      { alpha: .8, style: 'hsl(0,100%,50%)', rects: [11.6, 24, 1] });
    assert.equal(h.mgr._blitStarBuckets(h.ctx, field), true);
    assert.ok([...field.values()].every(b => b.rects.length === 0), 'buckets consumed');
    const { pixels, rect } = h.puts[0];
    assert.deepEqual(rect, [2, 5, 2, 2]);
    assert.deepEqual(pixels.get('2,5'), [255, 255, 255, Math.round(.5 / 16 * 255)]);
    assert.deepEqual(pixels.get('2,6'), [255, 0, 0, Math.round(.8 * .1 * .25 * 255)]);
    assert.deepEqual(pixels.get('3,6'), [255, 0, 0, Math.round(.8 * .15 * .25 * 255)]);
    // Drawn once, additively, pixel for pixel, with the caller's state kept.
    assert.deepEqual(h.draws, ['save', ['transform', 1, 0, 0, 1, 0, 0], ['draw', 2, 5, 2, 2, 2, 5, 2, 2], 'restore']);
  } finally { h.restore(); }
});

test('stacked light saturates like additive compositing and the next frame starts clear', () => {
  const h = harness({ transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
  try {
    const rects = []; for (let i = 0; i < 6; i++) rects.push(4, 3, 1);
    // 6 x 0.3 = 1.8 alpha of blue-white light on one native pixel.
    assert.equal(h.mgr._blitStarBuckets(h.ctx, buckets({ alpha: .3, style: '#8080ff', rects })), true);
    const [r, g, b, a] = h.puts[0].pixels.get('4,3');
    assert.equal(a, 255);
    // Opaque, with the clamped premultiplied sum as colour: min(1, 1.8 x c)
    // -- what six additive draws of 0.3 leave behind.
    assert.deepEqual([r, g, b], [Math.round(1.8 * 128), Math.round(1.8 * 128), 255]);
    assert.equal(h.mgr._blitStarBuckets(h.ctx, buckets({ alpha: .25, style: '#ffffff', rects: [9, 9, 1] })), true);
    assert.deepEqual([...h.puts[1].pixels.keys()], ['9,9'], 'no light left over from the previous frame');
    assert.equal(h.puts[1].pixels.get('9,9')[3], Math.round(.25 * 255));
  } finally { h.restore(); }
});

test('a rotated or oversized target keeps the per-bucket rects', () => {
  const rotated = harness({ transform: { a: .24, b: .07, c: -.07, d: .24, e: 0, f: 0 } });
  try {
    const field = buckets({ alpha: .5, style: '#ffffff', rects: [10, 20, 1] });
    assert.equal(rotated.mgr._blitStarBuckets(rotated.ctx, field), false);
    assert.equal(field.get(0).rects.length, 3, 'left for the caller');
  } finally { rotated.restore(); }
  const big = harness({ width: 1920, height: 1080 });
  try { assert.equal(big.mgr._blitStarBuckets(big.ctx, buckets({ alpha: .5, style: '#fff', rects: [1, 1, 1] })), false); }
  finally { big.restore(); }
});
