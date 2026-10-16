import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConstellationWeaver } from '../src/world/ConstellationWeaver.js';
import { layoutTextPath, GLYPH_SHAPES } from '../src/world/LyricGlyph.js';
import { scanLine } from '../src/lyrics/LyricLexicon.js';

function melodyEvt(tMs, pitch = 60, vel = 0.7) {
  return { tMs, pitch, vel, role: 'MELODY' };
}

test('ConstellationWeaver.hintGlyph: queued glyph shapes the next figure', () => {
  const w = new ConstellationWeaver(42, 1280, 720);
  w.hintGlyph('heart');
  assert.strictEqual(w._pendingGlyph.glyphId, 'heart');

  // Feed enough melody events to start + commit a figure
  for (let i = 0; i < 12; i++) {
    w.onMelody(melodyEvt(i * 800));
    w.update(i * 800, 0.8);
  }

  // After enough events, the glyph should have been consumed
  assert.strictEqual(w._pendingGlyph, null);
});

// hintGlyph used to refuse to even QUEUE a hint while the cooldown was
// active, dropping it on the floor with no way to fire once the cooldown
// cleared. It's unconditional now -- the cooldown instead gates USING the
// hint (see onMelody), so a lyric line's glyph can still land once the
// figure it's waiting behind finishes, as long as it hasn't expired.
test("ConstellationWeaver.hintGlyph: queues even during cooldown, but cooldown still blocks it from shaping a figure", () => {
  const w = new ConstellationWeaver(42, 1280, 720);
  w._glyphCooldown = 2; // simulate active cooldown
  w.hintGlyph('star', 10_000);
  assert.strictEqual(w._pendingGlyph.glyphId, 'star', 'a hint must be accepted regardless of cooldown');

  w.onMelody(melodyEvt(0));
  assert.deepEqual(w.building.interior, [], 'cooldown must still block it from shaping this figure');
  assert.strictEqual(w._pendingGlyph.glyphId, 'star', 'and the hint must survive to try again later');
});

test('SkyVoyage lyricText figure: layoutTextPath produces a walkable path', () => {
  const path = layoutTextPath('LOVE');
  assert.ok(path.length >= 4, 'path should have multiple points');

  // Verify the path can be walked (interpolated) without error
  for (let t = 0; t < 1; t += 0.05) {
    const fi = t * (path.length - 1);
    const i = Math.floor(fi);
    const frac = fi - i;
    const a = path[i];
    const b = path[Math.min(i + 1, path.length - 1)];
    assert.ok(typeof a.x === 'number' && typeof a.y === 'number');
    assert.ok(typeof b.x === 'number' && typeof b.y === 'number');
    if (!b.gap) {
      const x = a.x + (b.x - a.x) * frac;
      const y = a.y + (b.y - a.y) * frac;
      assert.ok(Number.isFinite(x));
      assert.ok(Number.isFinite(y));
    }
  }
});

test('SkyVoyage lyricText figure: gap markers separate strokes', () => {
  const path = layoutTextPath('HI');
  const gaps = path.filter((p) => p.gap);
  // H and I are separate characters, so there should be gap markers between them
  assert.ok(gaps.length > 0, 'should have gap markers between characters');
});

test('every glyph referenced in LyricLexicon exists in GLYPH_SHAPES', () => {
  const testLines = [
    'weed', 'rocket', 'alien', 'serpent', 'trident',
    'crown', 'skull', 'lightning', 'fire', 'sword',
    'diamond', 'eye', 'ghost', 'angel',
    'heart', 'star', 'moon', 'ocean', 'mountain',
    'forever', 'cross',
  ];

  for (const line of testLines) {
    const hit = scanLine(line);
    if (hit) {
      assert.ok(
        GLYPH_SHAPES[hit.glyphId],
        `glyph "${hit.glyphId}" (from "${line}") missing from GLYPH_SHAPES`,
      );
    }
  }
});
