// Lyrics as symbolism, in both the ambient constellations and Midasus's
// sky voyages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLYPH_SHAPES, glyphTracePath, normalizeGlyphShape } from '../src/world/LyricGlyph.js';
import { scanLine, dominantSymbol } from '../src/lyrics/LyricLexicon.js';

const same = (a, b) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

test('the glyphs that were cut off half-drawn are whole again', () => {
  // infinity, ghost, rocket, alien and wings were each exactly eight dots and
  // stopped mid-shape: infinity never closed its right loop, the ghost had
  // no left side. Each now closes back on its first dot.
  for (const id of ['infinity', 'ghost', 'rocket', 'alien', 'wings']) {
    const { outline } = normalizeGlyphShape(GLYPH_SHAPES[id]);
    assert.ok(same(outline[0], outline[outline.length - 1]), `${id} closes`);
    assert.ok(outline.length > 8, `${id} has more than the old eight dots`);
  }
  // A true figure-eight crosses its own centre mid-way.
  const inf = normalizeGlyphShape(GLYPH_SHAPES.infinity).outline;
  assert.ok(inf.slice(1, -1).some((d) => same(d, inf[0])), 'infinity crosses its centre');
});

test('every lexicon symbol has a glyph to draw', () => {
  const lines = ['love', 'time', 'free', 'secret', 'rose', 'sun', 'tears', 'roots', 'anchor', 'prison',
    'night', 'burning', 'death', 'pray', 'shine', 'sea', 'climb'];
  for (const line of lines) {
    const hit = scanLine(line);
    assert.ok(hit, `"${line}" matches a symbol`);
    assert.ok(GLYPH_SHAPES[hit.glyphId], `${hit.glyphId} exists as a glyph`);
  }
});

test('themes map to their symbols', () => {
  const cases = {
    'I will love you till the end': 'heart',
    'Running out of time': 'hourglass',
    'Set me free': 'bird',
    'These tears keep falling': 'tear',
    'Trapped inside this prison': 'chain',
    'Keep your secrets': 'key',
    'Waiting for the dawn': 'sun',
  };
  for (const [line, id] of Object.entries(cases)) assert.equal(scanLine(line)?.glyphId, id, line);
});

test('generic lines still draw nothing', () => {
  // The lexicon's own rule: a false positive is worse than a miss.
  for (const line of ['High hopes', 'I know you feel it too', 'We go on and on', 'Tell me what you want']) {
    assert.equal(scanLine(line), null, line);
  }
});

test('dominantSymbol picks the motif a passage returns to, not one passing mention', () => {
  assert.equal(dominantSymbol('Time slips away\nI love you\nYour love\nLove is all'), 'heart');
  assert.equal(dominantSymbol(['nothing here', 'nor here']), null);
  assert.equal(dominantSymbol(null), null);
});

test('glyphTracePath turns a glyph into one pen path, lifting between strokes', () => {
  const path = glyphTracePath('anchor');
  const shape = normalizeGlyphShape(GLYPH_SHAPES.anchor);
  const strokes = shape.interior.length;
  assert.equal(path.filter((p) => p.gap).length, strokes, 'one pen-lift per interior stroke');
  assert.equal(path[0].gap, false, 'the outline starts with the pen down');
  for (const p of path) assert.ok(Math.abs(p.x) <= 1.001 && Math.abs(p.y) <= 1.001, 'within unit extent');
  assert.deepEqual(glyphTracePath('no-such-glyph'), []);
});

