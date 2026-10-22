import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneCaptionFor, rangeCaptionFor, CAPTION_DELAY_MS, CAPTION_FADE_MS, CAPTION_HOLD_MS } from '../src/ui/RangeCaption.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { pixelGrid } from '../src/render/PixelRenderPolicy.js';

const pixelCaption = await import('../src/ui/PixelCaption.js').catch(() => ({}));
const pixelFont = await import('../src/ui/PixelFont.js').catch(() => ({}));
const grid = pixelGrid(), holdStart = CAPTION_DELAY_MS + CAPTION_FADE_MS;
function layout(caption, localMs = 4500) {
  assert.equal(typeof pixelCaption.layoutPixelCaption, 'function');
  return pixelCaption.layoutPixelCaption(caption, { grid, localMs });
}
function allLines(caption) {
  const first = layout(caption);
  return Array.from({ length: first.pageCount }, (_, i) => layout(caption, holdStart + (i + .5) * CAPTION_HOLD_MS / first.pageCount).lines)
    .flat().map(line => line.text).join(' ');
}
function inside(result) {
  assert.ok(result.bounds.x >= 6 && result.bounds.y >= 0);
  assert.ok(result.bounds.x + result.bounds.width <= grid.width - 6);
  assert.ok(result.bounds.y + result.bounds.height <= grid.height - 6);
  assert.ok(result.bounds.height <= 54);
  for (const line of result.lines) {
    assert.ok([line.x, line.y, line.width].every(Number.isInteger));
    assert.ok(line.width <= 308);
  }
}
test('v2 names and full attribution wrap at a seven-pixel glyph minimum', () => {
  const caption = sceneCaptionFor(catalog.views[0]);
  const result = layout(caption);
  inside(result);
  assert.equal(pixelFont.PIXEL_GLYPH_HEIGHT, 7);
  assert.ok(allLines(caption).includes(caption.rows[0].name));
  assert.ok(allLines(caption).includes(caption.credit));
});
test('legacy multi-range cast and longest shipped attribution appear across bounded pages', () => {
  const range = n => ({ name: `${n} Mountain Range`, region: 'British Columbia, Canada', source: 'discovered' });
  const caption = rangeCaptionFor(range('Far'), 'alpine', { lengthKm: 400, speedMps: 120 },
    { horizon: range('Horizon'), massif: range('Massif'), mid: range('Middle'), near: range('Front') },
    { title: 'Mountain Conifer Forest', ecoregion: 'Northern Rockies conifer forests' });
  assert.ok(layout(caption).pageCount > 1);
  const text = allLines(caption);
  for (const row of caption.rows) assert.ok(text.includes(row.name));
  assert.ok(text.includes(caption.credit));
  const longest = catalog.views.reduce((a, b) => a.credit.length >= b.credit.length ? a : b);
  const scenic = sceneCaptionFor(longest, { horizon: range('Horizon'), massif: range('Massif') }, { title: 'Desert', ecoregion: 'Optional region' });
  assert.ok(allLines(scenic).includes(scenic.credit));
  for (let t = holdStart; t < holdStart + CAPTION_HOLD_MS; t += 250) inside(layout(scenic, t));
  assert.ok(layout(caption).accessibleText.includes(caption.stats));
  assert.ok(layout(caption).accessibleText.includes(caption.biome.ecoregion));
});
test('spaces normalize and long unbroken names split without truncation', () => {
  const caption = { rows: [{ name: '  Grand   Teton  ' }], credit: 'Elevation:   USGS  3DEP' };
  assert.match(allLines(caption), /Grand Teton/);
  assert.match(allLines(caption), /Elevation: USGS 3DEP/);
  const name = 'Abc'.repeat(150);
  const long = { rows: [{ name }], credit: 'Credit' };
  const first = layout(long);
  const pages = Array.from({ length: first.pageCount }, (_, i) => layout(long, holdStart + (i + .5) * CAPTION_HOLD_MS / first.pageCount));
  assert.ok(pages.flatMap(p => p.lines).map(l => l.text).join('').includes(name));
  pages.forEach(inside);
});
test('caption paging is a pure function of caption-local song time through pause and back-seek', () => {
  const caption = { rows: Array.from({ length: 12 }, (_, i) => ({ name: `Mountain ${i}` })), credit: 'Credit' };
  const first = layout(caption, 4000);
  assert.deepEqual(layout(caption, 4000), first);
  assert.ok(layout(caption, 8500).pageIndex > first.pageIndex);
  assert.deepEqual(layout(caption, 4000), first);
  assert.equal(layout(caption, holdStart + CAPTION_HOLD_MS - 1).pageIndex, layout(caption).pageCount - 1);
});
test('punctuation, shipped diacritics and explicit Unicode fallbacks draw integral pixels', () => {
  assert.equal(typeof pixelCaption.drawPixelCaption, 'function');
  const caption = { rows: [{ name: 'Iztaccíhuatl – México (48°) / Élan & Ås' }], credit: '© AWS · CC BY 4.0' };
  const calls = [];
  const ctx = { save() {}, restore() {}, fillRect(...args) { calls.push(args); } };
  const result = pixelCaption.drawPixelCaption(ctx, [{ atMs: 2000, caption }], 6500, { grid });
  assert.deepEqual(result, layout(caption, 4500));
  assert.ok(calls.length > 50);
  assert.ok(calls.every(rect => rect.every(Number.isInteger)));
  assert.ok(layout({ rows: [{ name: '東京' }] }).accessibleText.includes('東京'));
  assert.match(allLines({ rows: [{ name: '東京' }] }), /\[U\+6771\].*\[U\+4EAC\]/);
});
test('absent and invisible captions draw nothing', () => {
  assert.equal(typeof pixelCaption.drawPixelCaption, 'function');
  assert.equal(layout(null), null);
  const ctx = { fillRect() { assert.fail('no caption'); } };
  assert.equal(pixelCaption.drawPixelCaption(ctx, null, 4500, { grid }), null);
  assert.equal(pixelCaption.drawPixelCaption(ctx, { rows: [{ name: 'Teton' }] }, 500, { grid }), null);
});
test('accessible details retain original names, optional data and attribution', () => {
  assert.equal(typeof pixelCaption.setCaptionDetails, 'function');
  const body = { textContent: '' }, element = { hidden: false, querySelector: () => body };
  const caption = { biome: { title: 'Forest', ecoregion: 'Northern Rockies' }, rows: [{ name: 'México', label: 'VIEW', region: 'Wyoming' }], stats: '21 mi', credit: 'USGS 3DEP' };
  pixelCaption.setCaptionDetails(element, caption);
  for (const value of ['México', 'Northern Rockies', 'Wyoming', '21 mi', 'USGS 3DEP']) assert.ok(body.textContent.includes(value));
  assert.equal(element.hidden, false);
  pixelCaption.setCaptionDetails(element, null);
  assert.equal(element.hidden, true);
});
test('Detailed doubles glyph bodies, margins and line advance without changing pages', () => {
  const caption = sceneCaptionFor(catalog.views[0]);
  const classic = layout(caption), detailed = pixelCaption.layoutPixelCaption(caption, { grid: pixelGrid('detailed'), localMs: 4500 });
  assert.equal(detailed.pageCount, classic.pageCount);
  assert.equal(detailed.lines[0].y, classic.lines[0].y * 2);
  assert.equal(detailed.bounds.height, classic.bounds.height * 2);
  assert.equal(detailed.bounds.x, classic.bounds.x * 2);
});
for (const gridId of ['classicPlus', 'medium', 'mediumPlus']) test(`${gridId} draws captions on whole grid pixels`, () => {
  const caption = sceneCaptionFor(catalog.views[0]), grid = pixelGrid(gridId);
  const l = pixelCaption.layoutPixelCaption(caption, { grid, localMs: 4500 });
  for (const v of [l.bounds.x, l.bounds.y, l.bounds.width, l.bounds.height, ...l.lines.flatMap(line => [line.x, line.y])]) assert.ok(Number.isInteger(v), `${v}`);
  assert.ok(l.bounds.x >= 0 && l.bounds.y >= 0 && l.bounds.x + l.bounds.width <= grid.width);
});
