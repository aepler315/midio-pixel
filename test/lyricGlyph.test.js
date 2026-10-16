import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLYPH_SHAPES, layoutTextPath, placeGlyph, normalizeGlyphShape } from '../src/world/LyricGlyph.js';

function assertPointInUnitSquare(id, label, d) {
  assert.ok(d.x >= 0 && d.x <= 1, `${id} ${label} x out of range: ${d.x}`);
  assert.ok(d.y >= 0 && d.y <= 1, `${id} ${label} y out of range: ${d.y}`);
}

test('GLYPH_SHAPES: every outline has at least 3 dots with x,y in [0,1], every interior stroke has at least 2', () => {
  for (const [id, raw] of Object.entries(GLYPH_SHAPES)) {
    const shape = normalizeGlyphShape(raw);
    assert.ok(shape.outline.length >= 3, `${id} outline has fewer than 3 dots`);
    for (const d of shape.outline) assertPointInUnitSquare(id, 'outline', d);
    for (const [i, stroke] of shape.interior.entries()) {
      assert.ok(stroke.length >= 2, `${id} interior stroke ${i} has fewer than 2 points`);
      for (const d of stroke) assertPointInUnitSquare(id, `interior[${i}]`, d);
    }
  }
});

test('normalizeGlyphShape: a flat dot array becomes {outline, interior: []}', () => {
  const dots = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }];
  const shape = normalizeGlyphShape(dots);
  assert.deepEqual(shape.outline, dots);
  assert.deepEqual(shape.interior, []);
});

test('normalizeGlyphShape: an {outline, interior} object passes through, missing fields default to []', () => {
  const raw = { outline: [{ x: 0, y: 0 }] };
  const shape = normalizeGlyphShape(raw);
  assert.deepEqual(shape.outline, raw.outline);
  assert.deepEqual(shape.interior, []);
});

test('normalizeGlyphShape: null/undefined input returns null', () => {
  assert.strictEqual(normalizeGlyphShape(null), null);
  assert.strictEqual(normalizeGlyphShape(undefined), null);
});

test('the two-image combo glyphs (ship_wave, heart_break, phoenix, moon_tide) each carry at least one interior stroke', () => {
  for (const id of ['ship_wave', 'heart_break', 'phoenix', 'moon_tide']) {
    const shape = normalizeGlyphShape(GLYPH_SHAPES[id]);
    assert.ok(shape.interior.length >= 1, `${id} should have interior detail confirming the second image`);
  }
});

test('common glyphs (star, diamond, skull, eye) also carry interior detail, not just the combos', () => {
  for (const id of ['star', 'diamond', 'skull', 'eye']) {
    const shape = normalizeGlyphShape(GLYPH_SHAPES[id]);
    assert.ok(shape.interior.length >= 1, `${id} should have interior detail`);
  }
});

test('layoutTextPath: returns non-empty array for a word', () => {
  const path = layoutTextPath('HELLO');
  assert.ok(Array.isArray(path));
  assert.ok(path.length > 0);
  for (const p of path) {
    assert.ok(typeof p.x === 'number');
    assert.ok(typeof p.y === 'number');
  }
});

test('layoutTextPath: single character produces points', () => {
  const path = layoutTextPath('A');
  assert.ok(path.length > 0);
});

test('layoutTextPath: empty string returns empty array', () => {
  const path = layoutTextPath('');
  assert.ok(Array.isArray(path));
  assert.strictEqual(path.length, 0);
});

test('layoutTextPath: path is roughly centered (x range spans around 0)', () => {
  const path = layoutTextPath('TEST');
  const xs = path.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  assert.ok(minX < 0, 'path should extend left of center');
  assert.ok(maxX > 0, 'path should extend right of center');
});

function assertInBounds(d, bounds, label) {
  assert.ok(d.x >= bounds.xMin && d.x <= bounds.xMax, `${label} x ${d.x} outside bounds`);
  assert.ok(d.y >= bounds.yMin && d.y <= bounds.yMax, `${label} y ${d.y} outside bounds`);
}

test('placeGlyph: returns an outline within bounds for a plain dot-chain glyph, and no interior', () => {
  const bounds = { xMin: 100, xMax: 500, yMin: 50, yMax: 400 };
  const shape = placeGlyph('heart', 300, 200, 80, bounds);
  assert.ok(shape.outline.length >= 3);
  for (const d of shape.outline) assertInBounds(d, bounds, 'outline');
  assert.deepEqual(shape.interior, []);
});

test('placeGlyph: an {outline, interior} glyph places and bounds-clamps both parts', () => {
  const bounds = { xMin: 100, xMax: 500, yMin: 50, yMax: 400 };
  const shape = placeGlyph('heart_break', 300, 200, 80, bounds);
  assert.ok(shape.outline.length >= 3);
  assert.ok(shape.interior.length >= 1);
  for (const d of shape.outline) assertInBounds(d, bounds, 'outline');
  for (const stroke of shape.interior) for (const d of stroke) assertInBounds(d, bounds, 'interior');
});

test('placeGlyph: unknown glyph returns null', () => {
  const shape = placeGlyph('nonexistent', 300, 200, 80, { xMin: 0, xMax: 1280, yMin: 0, yMax: 720 });
  assert.strictEqual(shape, null);
});
