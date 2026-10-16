import test from 'node:test';
import assert from 'node:assert/strict';
import { RANGE32_COLORS, RANGE32_RAMPS } from '../src/render/PaletteCatalog.js';
import * as catalog from '../src/render/PaletteCatalog.js';
import { pixelGrid } from '../src/render/PixelRenderPolicy.js';
import { compilePalette, quantizePalette, applyPalette } from '../src/render/PaletteQuantize.js';
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const linear = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const luminance = hex => rgb(hex).map(v => linear(v / 255)).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
test('Range32 has 32 immutable unique colors and ordered role ramps', () => {
  assert.equal(new Set(RANGE32_COLORS).size, 32);
  assert.equal(RANGE32_COLORS.length, 32);
  assert.ok(Object.isFrozen(RANGE32_COLORS));
  assert.ok(RANGE32_COLORS.includes('#000000') && RANGE32_COLORS.includes('#ffffff'));
  for (const ramp of Object.values(RANGE32_RAMPS)) for (let i = 1; i < ramp.length; i++) assert.ok(luminance(ramp[i]) > luminance(ramp[i - 1]));
});
test('every palette swatch maps to itself with alpha unchanged for all dither strengths', () => {
  const compiled = compilePalette(RANGE32_COLORS);
  assert.equal(compiled, compilePalette(RANGE32_COLORS));
  for (const dither of [0, .35, 1]) {
    const data = new Uint8ClampedArray(RANGE32_COLORS.flatMap((hex, i) => [...rgb(hex), i * 8]));
    const expected = data.slice();
    quantizePalette({ data, width: 32, height: 1 }, compiled, { dither });
    assert.deepEqual(data, expected);
  }
});
test('arbitrary input produces repeatable palette members', () => {
  const compiled = compilePalette(RANGE32_COLORS);
  const input = new Uint8ClampedArray(32 * 32 * 4).map((_, i) => (i * 43) % 256);
  for (const dither of [0, .35, 1]) {
    const a = { width: 32, height: 32, data: input.slice() }, b = { ...a, data: input.slice() };
    quantizePalette(a, compiled, { dither }); quantizePalette(b, compiled, { dither });
    assert.deepEqual(a.data, b.data);
    const members = new Set(RANGE32_COLORS.map(hex => rgb(hex).join(',')));
    for (let i = 0; i < a.data.length; i += 4) { assert.ok(members.has([...a.data.slice(i, i + 3)].join(','))); assert.equal(a.data[i + 3], input[i + 3]); }
  }
});
test('oversized and empty frames do no readback work', () => {
  const ctx = { getImageData() { assert.fail('unbounded readback'); } };
  assert.equal(applyPalette(ctx, { width: 1920, height: 1080 }).reason, 'oversize');
  assert.equal(applyPalette(ctx, { width: 0, height: 180 }).reason, 'empty');
});
test('Chroma32 has 32 frozen unique colors with exact teal and blue swatches', () => {
  assert.equal(catalog.CHROMA32_COLORS?.length, 32);
  assert.equal(new Set(catalog.CHROMA32_COLORS).size, 32);
  assert.ok(Object.isFrozen(catalog.CHROMA32_COLORS));
  assert.ok(Object.isFrozen(catalog.PALETTES));
  for (const entry of Object.values(catalog.PALETTES)) {
    assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.colors));
  }
  const compiled = compilePalette(catalog.CHROMA32_COLORS);
  assert.equal(compiled, compilePalette(catalog.CHROMA32_COLORS));
  for (const dither of [0, .35, 1]) {
    const swatches = new Uint8ClampedArray(catalog.CHROMA32_COLORS.flatMap(hex => [...rgb(hex), 255]));
    const before = swatches.slice();
    quantizePalette({ width: 32, height: 1, data: swatches }, compiled, { dither });
    assert.deepEqual(swatches, before);
    const probe = { width: 2, height: 1, data: new Uint8ClampedArray([...rgb('#5ec8c4'), 255, ...rgb('#6f90d8'), 255]) };
    const expected = probe.data.slice(); quantizePalette(probe, compiled, { dither });
    assert.deepEqual(probe.data, expected);
  }
});
test('world palette choice is stable by world kind with deterministic custom/title fallback', () => {
  assert.equal(typeof catalog.resolvePaletteId, 'function');
  for (const kind of ['alpine', 'overgrowth']) assert.equal(catalog.resolvePaletteId('world', kind), 'range32');
  for (const kind of ['city', 'airless', 'abyssal', 'strip', 'foundry', 'nave', 'custom', null]) assert.equal(catalog.resolvePaletteId('world', kind), 'chroma32');
  for (const id of ['range32', 'chroma32', 'rgb332', 'none']) assert.equal(catalog.resolvePaletteId(id, 'alpine'), id);
});
test('Canvas palette pass resolves the Chroma catalog without a second readback', () => {
  const grid = pixelGrid(), data = new Uint8ClampedArray(grid.pixels * 4); data.set([94, 200, 196, 255]);
  const ctx = {
    getImageData() { return { width: grid.width, height: grid.height, data }; }, putImageData() {},
  };
  assert.equal(applyPalette(ctx, grid, { paletteId: 'chroma32', grid }).applied, true);
  assert.deepEqual([...data.slice(0, 4)], [94, 200, 196, 255]);
});
test('palette frames must match an allowed selected grid and the absolute pixel cap', () => {
  let reads = 0;
  const ctx = { getImageData(x, y, width, height) { reads++; return { width, height, data: new Uint8ClampedArray(width * height * 4) }; }, putImageData() {} };
  const detailed = pixelGrid('detailed');
  assert.equal(applyPalette(ctx, { width: 640, height: 360 }, { paletteId: 'chroma32', grid: detailed }).applied, true);
  assert.equal(reads, 1);
  for (const canvas of [{ width: 320, height: 720 }, { width: 800, height: 288 }, { width: 1280, height: 45 }]) assert.equal(applyPalette(ctx, canvas, { grid: detailed }).reason, 'grid-mismatch');
  assert.equal(applyPalette(ctx, { width: 640, height: 360 }, { grid: pixelGrid() }).reason, 'grid-mismatch');
  assert.equal(applyPalette(ctx, { width: 1920, height: 1080 }, { grid: detailed }).reason, 'oversize');
  assert.equal(reads, 1, 'invalid grids never read output-sized canvases');
});
