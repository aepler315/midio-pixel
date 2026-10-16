import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc } from '../src/lyrics/LyricsClient.js';
import { toBlocks, labelBlocks } from '../src/lyrics/LyricStructure.js';
import { fuseSections } from '../src/lyrics/SectionFusion.js';

const durationMs = 60000;
const novelty = [{ startMs: 0, endMs: durationMs, profile: 'A' }];
const span = (startMs, endMs, text = 'line') => ({
  startMs, endMs, lines: [text], text, kind: 'verse', confidence: 0.8,
  intensity: 0.4, valence: 0,
});
const ranges = (sections) => sections.map(({ startMs, endMs }) => [startMs, endMs]);

function assertIntervals(sections, duration = durationMs) {
  let end = 0;
  for (const section of sections) {
    assert.ok(Number.isFinite(section.startMs) && Number.isFinite(section.endMs), 'finite times');
    assert.ok(section.startMs >= end, 'sorted and nonoverlapping');
    assert.ok(section.startMs < section.endMs && section.endMs <= duration, 'nonempty and duration-bounded');
    end = section.endMs;
  }
}

test('WP09: real 60s no-bar LRC pipeline omits the 70s line without inventing duration', () => {
  const sections = labelBlocks(toBlocks(parseLrc('[00:00.00]first\n[01:10.00]late'), { synced: true }), { durationMs });
  assertIntervals(sections);
  assert.ok(sections.every((s) => s.text !== 'late'));
  const fused = fuseSections(novelty, sections, [], durationMs);
  assert.deepEqual(ranges(fused), [[0, 8000], [8000, durationMs]]);
  assertIntervals(fused);
});

test('WP09: offsets omit negative onsets rather than moving distinct pre-song lines to zero', () => {
  assert.deepEqual(parseLrc('[offset:+1000]\n[00:00.00]before\n[00:00.50]before too\n[00:01.00]opening\n[00:03.00]valid'), [
    { tMs: 0, text: 'opening' }, { tMs: 2000, text: 'valid' },
  ]);
  assert.deepEqual(parseLrc('[offset:-1000]\n[00:00.50]later'), [{ tMs: 1500, text: 'later' }]);
  for (const input of [NaN, Infinity, 12, {}, []]) assert.deepEqual(parseLrc(input), []);
  assert.deepEqual(parseLrc(`[offset:${'9'.repeat(400)}]\n[00:01.00]bad`), []);
});

test('WP09: public synced lines reject nonnumeric stamps and preserve simultaneous distinct words', () => {
  const lines = [
    { tMs: 5000, text: 'last' }, { tMs: 0, text: 'first' },
    { tMs: 0, text: 'second voice' }, { tMs: 0, text: 'first' },
    ...[-1, NaN, Infinity, -Infinity, '1000', null, undefined].map((tMs) => ({ tMs, text: 'bad' })),
    null,
  ];
  const blocks = toBlocks(lines, { synced: true });
  assert.deepEqual(blocks.flatMap((b) => b.lines), ['first', 'second voice', 'last']);
  assertIntervals(blocks);
  assert.deepEqual(toBlocks([{ tMs: NaN, text: 'bad' }], { synced: true }), []);
});

test('WP09: LRC exact duplicates are omitted even between simultaneous distinct voices', () => {
  assert.deepEqual(parseLrc('[00:00.00]first\n[00:00.00]second voice\n[00:00.00]first'), [
    { tMs: 0, text: 'first' }, { tMs: 0, text: 'second voice' },
  ]);
});

test('WP09: label admission clips intersecting spans and omits exact-end, late, inverted and empty spans', () => {
  const blocks = [span(59000, 70000, 'closing'), span(-1000, 1000, 'opening'), span(59000, 65000, 'duplicate'),
    span(60000, 65000, 'exact end'), span(70000, 75000, 'late'), span(4000, 4000, 'empty'),
    span(8000, 7000, 'backward'), ...[NaN, Infinity, '2000'].map((x) => span(x, 3000, 'bad'))];
  const labeled = labelBlocks(blocks, { durationMs });
  assertIntervals(labeled);
  assert.deepEqual(labeled.filter((s) => s.text).map((s) => [s.startMs, s.endMs, s.text]), [
    [0, 1000, 'opening'], [59000, durationMs, 'closing'],
  ]);
});

test('WP09: final fusion guards alternate timed producers without bars', () => {
  const lyrics = [span(60000, 61000, 'exact end'), span(70000, 80000, 'late'), span('5000', 6000, 'string'),
    span(NaN, 9000, 'nan'), span(Infinity, Infinity, 'infinite'), span(4000, 4000, 'empty'), span(8000, 7000, 'backward')];
  const fused = fuseSections(novelty, lyrics, null, durationMs);
  assert.deepEqual(ranges(fused), [[0, durationMs]]);
  assert.equal(fused[0].kind, undefined);
  assertIntervals(fused);
});

test('WP09: empty, single, plain and invalid-duration inputs retain honest timing', () => {
  assert.deepEqual(labelBlocks([], { durationMs }), []);
  const single = labelBlocks(toBlocks([{ tMs: 59999, text: 'closing' }], { synced: true }), { durationMs });
  assertIntervals(single);
  assert.equal(single.at(-1).endMs, durationMs);
  assert.equal(single.at(-1).text, 'closing');
  const plain = labelBlocks(toBlocks(['untimed', '', 'another']));
  assert.ok(plain.every((s) => s.startMs === undefined && s.confidence === 0.4));
  assert.ok(fuseSections(novelty, plain, [], durationMs).every((s) => s.lyricConfidence === 0.4));
  for (const invalid of [0, -1, NaN, Infinity, '60000', null, undefined]) {
    assert.deepEqual(fuseSections(novelty, [span(0, 1000)], [], invalid), []);
  }
});

test('WP09: malformed novelty is normalized even with empty or plain lyrics, without mutating input', () => {
  const source = [span(10000, 30000, 'later'), span(-1000, 20000, 'opening'), span(10000, 25000, 'duplicate'),
    span(40000, 80000, 'closing'), span(NaN, 1000), span('5000', 6000), span(60000, 80000)];
  const original = structuredClone(source);
  for (const lyrics of [null, [], [{ kind: 'verse', confidence: 0.4 }]]) {
    const fused = fuseSections(source, lyrics, [], durationMs);
    assertIntervals(fused);
    assert.deepEqual(ranges(fused), [[0, 10000], [10000, 30000], [40000, durationMs]]);
  }
  assert.deepEqual(source, original);
  assert.equal(fuseSections(novelty, [], [], durationMs), novelty, 'valid no-lyrics schedule keeps its reference');
});

test('WP09: valid timing, profile and boundary evidence survive free-time and ordinary bars', () => {
  const source = [{ startMs: 0, endMs: 30000, profile: 'A', provenance: 'musical', boundaryEvidence: { onset: 1 } },
    { startMs: 30000, endMs: durationMs, profile: 'B', provenance: 'musical', boundaryEvidence: { onset: 2 } }];
  const lyrics = [span(0, 12345), span(12345, 30000), span(30000, 50000), span(50000, durationMs)];
  for (const grid of [[], Array.from({ length: 31 }, (_, i) => ({ ms: i * 2000 }))]) {
    const fused = fuseSections(source, lyrics, grid, durationMs);
    assertIntervals(fused);
    assert.deepEqual(fused.map((s) => s.startMs), [0, grid.length ? 12000 : 12345, 30000, 50000]);
    const retained = fused.find((s) => s.startMs === 30000);
    assert.equal(retained.profile, 'B');
    assert.equal(retained.boundaryEvidence, source[1].boundaryEvidence);
    assert.equal(fused[1].provenance, 'decorative');
    assert.equal(fused[1].boundaryEvidence, null);
  }
});

test('WP09: seeded mixed producer schedules stay bounded for missing and irregular bar grids', () => {
  let state = 315;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const malformed = [NaN, Infinity, -Infinity, '1000', null, undefined];
  for (let trial = 0; trial < 100; trial++) {
    const source = [span(0, durationMs)];
    const lyrics = [];
    for (let i = 0; i < 12; i++) {
      const start = random() < 0.3 ? malformed[Math.floor(random() * malformed.length)] : Math.floor(random() * 90000) - 15000;
      const end = random() < 0.3 ? malformed[Math.floor(random() * malformed.length)] : Math.floor(random() * 90000) - 15000;
      const item = span(start, end);
      source.push(item);
      lyrics.push(item);
    }
    const bars = [null, { ms: NaN }, { ms: Infinity }, { ms: '2000' }, { ms: 60000 }, { ms: 90000 },
      { ms: 27000 }, { ms: 0 }, { ms: -1000 }, { ms: 10000 }, { ms: 10000 }];
    for (const grid of [null, [], bars]) {
      for (const input of [null, [], lyrics, [{ kind: 'verse', confidence: 0.4 }]]) {
        assertIntervals(fuseSections(source, input, grid, durationMs));
      }
    }
  }
});
