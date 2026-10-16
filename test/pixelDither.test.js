import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePalette, quantizePalette, applyPalette } from '../src/render/PaletteQuantize.js';
import { CHROMA32_COLORS } from '../src/render/PaletteCatalog.js';
import { pixelGrid } from '../src/render/PixelRenderPolicy.js';
const dither = await import('../src/render/PixelDither.js').catch(() => ({}));
function image(width, values) {
  return { width, height: values.length / width, data: new Uint8ClampedArray(values.flatMap((v, i) => [v, v, v, (i * 29) % 256])) };
}
function weights(frame) {
  assert.equal(typeof dither.buildDitherWeights, 'function');
  const out = new Uint8Array(frame.width * frame.height);
  assert.equal(dither.buildDitherWeights(frame, out), out);
  return out;
}
test('selective weights use the exact 16/48 thresholds with one interpolation rounding', () => {
  for (const [difference, expected] of [[0, 255], [16, 255], [17, 247], [32, 128], [47, 8], [48, 0], [255, 0]]) {
    assert.deepEqual([...weights(image(2, [0, difference]))], [expected, expected]);
  }
});
test('gradient interiors and a 1×1 frame retain full dither weight', () => {
  assert.deepEqual([...weights(image(5, [32, 40, 48, 56, 64]))], [255, 255, 255, 255, 255]);
  assert.deepEqual([...weights(image(1, [123]))], [255]);
});
test('one-pixel silhouettes and borders protect all four in-bounds RGB neighbors', () => {
  const mask = weights(image(3, [0, 0, 0, 0, 80, 0, 0, 0, 0]));
  assert.deepEqual([...mask], [255, 0, 255, 0, 0, 0, 255, 0, 255]);
  const frame = image(2, [0, 0]); frame.data[6] = 48;
  assert.deepEqual([...weights(frame)], [0, 0], 'one differing blue channel protects the edge');
});
test('mask never mutates the source or considers alpha', () => {
  const frame = image(3, [60, 60, 60]), before = frame.data.slice();
  assert.deepEqual([...weights(frame)], [255, 255, 255]);
  assert.deepEqual(frame.data, before);
});
test('zero weights remove dithering; full weights match Ordered and preserve alpha/exact swatches', () => {
  const compiled = compilePalette(CHROMA32_COLORS), original = image(8, [90, 100, 120, 150, 180, 200, 220, 245]);
  const run = options => { const frame = { ...original, data: original.data.slice() }; quantizePalette(frame, compiled, options); return frame.data; };
  assert.deepEqual(run({ dither: 1, weights: new Uint8Array(8) }), run({ dither: 0 }));
  assert.deepEqual(run({ dither: 1, weights: new Uint8Array(8).fill(255) }), run({ dither: 1 }));
  const exact = { width: 2, height: 1, data: new Uint8ClampedArray([94, 200, 196, 17, 111, 144, 216, 255]) }, before = exact.data.slice();
  quantizePalette(exact, compiled, { dither: 1, weights: new Uint8Array(2) });
  assert.deepEqual(exact.data, before);
});
test('Selective builds from original neighbors before any quantization and reads once', () => {
  const grid = pixelGrid(), values = [115, 120, 125, 130, 135, 140, 145, 150];
  const frame = image(grid.width, Array.from({ length: grid.pixels }, (_, i) => values[Math.min(7, i % grid.width)])), before = frame.data.slice();
  const expected = weights(frame), output = new Uint8Array(grid.pixels);
  let reads = 0, writes = 0;
  const ctx = { getImageData() { reads++; return frame; }, putImageData() { writes++; } };
  const status = applyPalette(ctx, grid, { paletteId: 'chroma32', dither: 1, ditherMode: 'selective', weights: output, grid });
  assert.equal(status.applied, true); assert.equal(status.ditherMode, 'selective');
  assert.deepEqual(output, expected); assert.equal(reads, 1); assert.equal(writes, 1);
  for (let i = 3; i < frame.data.length; i += 4) assert.equal(frame.data[i], before[i]);
  const members = new Set(CHROMA32_COLORS.map(hex => parseInt(hex.slice(1), 16)));
  for (let i = 0; i < frame.data.length; i += 4) assert.ok(members.has(frame.data[i] << 16 | frame.data[i + 1] << 8 | frame.data[i + 2]));
});
test('Selective repeats exactly; Off and RGB332 do not build a mask', () => {
  const grid = pixelGrid(), values = [90, 100, 120, 150, 180, 200, 220, 245];
  const frame = image(grid.width, Array.from({ length: grid.pixels }, (_, i) => values[i % 8]));
  const run = (paletteId, strength) => {
    const source = { ...frame, data: frame.data.slice() }, mask = new Uint8Array(grid.pixels).fill(23);
    const status = applyPalette({ getImageData: () => source, putImageData() {} }, grid, { paletteId, dither: strength, ditherMode: 'selective', weights: mask, grid });
    return { data: source.data, mask, status };
  };
  assert.deepEqual(run('chroma32', 1).data, run('chroma32', 1).data);
  assert.ok(run('chroma32', 0).mask.every(v => v === 23));
  assert.ok(run('rgb332', 1).mask.every(v => v === 23));
  assert.equal(run('rgb332', 1).status.ditherMode, 'ordered');
});
