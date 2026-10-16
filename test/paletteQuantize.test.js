// The 256-color (R3G3B2) palette pass behind "8-bit intensive".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeImageData, quantizeCanvas } from '../src/render/PaletteQuantize.js';

function makeImageData(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = fill(i % width, Math.floor(i / width));
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { data, width, height };
}

const solid = (r, g, b, a = 255) => () => [r, g, b, a];

test('the whole frame lands in the 256-color R3G3B2 palette', () => {
  // A full-range gradient in every channel: whatever comes out the far side
  // must be drawn from at most 8 reds, 8 greens and 4 blues.
  const img = makeImageData(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2, 255]);
  quantizeImageData(img);
  const reds = new Set(), greens = new Set(), blues = new Set();
  for (let i = 0; i < img.data.length; i += 4) {
    reds.add(img.data[i]); greens.add(img.data[i + 1]); blues.add(img.data[i + 2]);
  }
  assert.ok(reds.size <= 8, `red used ${reds.size} levels, 3-bit allows 8`);
  assert.ok(greens.size <= 8, `green used ${greens.size} levels, 3-bit allows 8`);
  assert.ok(blues.size <= 4, `blue used ${blues.size} levels, 2-bit allows 4`);
  // 8 x 8 x 4 = 256. That product IS the mode's claim.
  assert.ok(reds.size * greens.size * blues.size <= 256);
});

test('black stays black and white stays white', () => {
  // Truncating instead of expanding back across the full range would darken
  // every frame by up to 31/255 -- a wash, not a palette.
  const black = makeImageData(8, 8, solid(0, 0, 0));
  quantizeImageData(black);
  for (let i = 0; i < black.data.length; i += 4) {
    assert.equal(black.data[i], 0);
    assert.equal(black.data[i + 1], 0);
    assert.equal(black.data[i + 2], 0);
  }
  const white = makeImageData(8, 8, solid(255, 255, 255));
  quantizeImageData(white);
  for (let i = 0; i < white.data.length; i += 4) {
    assert.equal(white.data[i], 255);
    assert.equal(white.data[i + 1], 255);
    assert.equal(white.data[i + 2], 255);
  }
});

// Alpha is deliberately left alone; see quantizeImageData's own note for
// what that costs on a partially-transparent frame and why it is still the
// right default.
test('alpha is never touched', () => {
  const img = makeImageData(8, 8, (x) => [x * 30, 120, 200, 137]);
  quantizeImageData(img);
  for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 137);
});

test('dithering breaks a flat mid-tone into neighbouring palette levels', () => {
  // The whole reason the dither exists: this game's frames are mostly large
  // smooth gradients, and naive quantization turns a sky into hard stripes.
  // A value sitting between two palette levels must resolve to a mix of
  // both across the 4x4 cell, not to one flat band.
  const img = makeImageData(4, 4, solid(100, 100, 100));
  quantizeImageData(img);
  const seen = new Set();
  for (let i = 0; i < img.data.length; i += 4) seen.add(img.data[i]);
  assert.ok(seen.size >= 2, `a mid-tone quantized to a single flat level (${[...seen]})`);
});

test('dithering is ordered, not random: the same input always gives the same frame', () => {
  // A random dither would crawl and shimmer in motion. Two identical frames
  // must quantize identically, or a still scene would fizz.
  const a = makeImageData(16, 16, (x, y) => [x * 15, y * 15, 100, 255]);
  const b = makeImageData(16, 16, (x, y) => [x * 15, y * 15, 100, 255]);
  quantizeImageData(a);
  quantizeImageData(b);
  assert.deepEqual([...a.data], [...b.data]);
});

test('dithering does not shift the frame lighter or darker on average', () => {
  // The Bayer offsets are centered on zero for this reason: a biased dither
  // would visibly lift or crush the whole image.
  for (const level of [40, 100, 160, 220]) {
    const img = makeImageData(32, 32, solid(level, level, level));
    quantizeImageData(img);
    let sum = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) { sum += img.data[i]; n++; }
    const mean = sum / n;
    assert.ok(
      Math.abs(mean - level) < 12,
      `mean drifted from ${level} to ${mean.toFixed(1)} -- the dither is biased`,
    );
  }
});

test('quantizeCanvas reports failure instead of throwing when the pixels cannot be read', () => {
  // A tainted canvas throws on getImageData. Losing the effect is fine;
  // killing the render loop is not.
  const throwingCtx = {
    getImageData() { throw new Error('tainted canvas'); },
    putImageData() { throw new Error('should not be reached'); },
  };
  assert.equal(quantizeCanvas(throwingCtx, { width: 320, height: 180 }), false);
});

test('quantizeCanvas skips a zero-sized canvas rather than asking for 0 pixels', () => {
  let asked = false;
  const ctx = { getImageData() { asked = true; }, putImageData() {} };
  assert.equal(quantizeCanvas(ctx, { width: 0, height: 0 }), false);
  assert.equal(asked, false);
});

test('quantizeCanvas round-trips the frame through get/putImageData', () => {
  const img = makeImageData(4, 4, solid(100, 100, 100));
  let written = null;
  const ctx = {
    getImageData: () => img,
    putImageData: (d, x, y) => { written = { d, x, y }; },
  };
  assert.equal(quantizeCanvas(ctx, { width: 4, height: 4 }), true);
  assert.equal(written.x, 0);
  assert.equal(written.y, 0);
  assert.equal(written.d, img, 'the quantized buffer must be the one written back');
});
