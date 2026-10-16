import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLine, syllableCount, toBlocks, labelBlocks, sectionEmotion } from '../src/lyrics/LyricStructure.js';

test('normalizeLine: lowercases, strips punctuation, keeps in-word apostrophes, collapses whitespace', () => {
  assert.equal(normalizeLine("  Don't Stop, Believing!!  "), "don't stop believing");
  assert.equal(normalizeLine(''), '');
  assert.equal(normalizeLine(null), '');
});

test('syllableCount: matches the vowel-group heuristic on a handful of known words', () => {
  assert.equal(syllableCount('cat'), 1);
  assert.equal(syllableCount('happy'), 2);
  assert.equal(syllableCount('wonderful'), 3);
  assert.equal(syllableCount('the'), 1);
  assert.equal(syllableCount('little'), 2);
  assert.equal(syllableCount(''), 0);
});

test('syllableCount: a whole line sums its words\' syllables and is always >= word count', () => {
  const line = 'the cat sat on the little mat';
  const words = line.split(' ').length;
  assert.ok(syllableCount(line) >= words);
});

test('toBlocks (plain): blank lines separate paragraphs, consecutive blanks collapse', () => {
  const lines = ['Verse line one', 'Verse line two', '', '', 'Chorus line one', 'Chorus line two', ''];
  const blocks = toBlocks(lines, { synced: false });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].lines, ['Verse line one', 'Verse line two']);
  assert.deepEqual(blocks[1].lines, ['Chorus line one', 'Chorus line two']);
  assert.equal(blocks[0].startMs, undefined);
});

test('toBlocks (synced): a large gap between lines starts a new block; small gaps stay in one', () => {
  const lines = [
    { tMs: 0, text: 'a' }, { tMs: 2000, text: 'b' }, { tMs: 4000, text: 'c' },
    { tMs: 20000, text: 'd' }, { tMs: 22000, text: 'e' },
  ];
  const blocks = toBlocks(lines, { synced: true });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].lines, ['a', 'b', 'c']);
  assert.deepEqual(blocks[1].lines, ['d', 'e']);
  assert.equal(blocks[0].startMs, 0);
  // The block ends after its LAST LINE has been sung, not at the instant that
  // line begins. Its lines are 2s apart, so the last one is given 2s of its
  // own: 4000 + 2000. Ending at 4000 (the old behavior) gave the final line
  // of every block zero duration -- harmless-looking on a multi-line block,
  // fatal on a one-line one (see the next test).
  assert.equal(blocks[0].endMs, 6000);
});

test('toBlocks (synced): a ONE-LINE block still has a real duration', () => {
  // A single-line block -- a one-line hook, a spoken intro, a last line --
  // used to come out with startMs === endMs. SectionFusion's sectionAt
  // matches on `tMs >= startMs && tMs < endMs`, so a zero-width section can
  // never match anything: the block's kind, intensity and valence were all
  // computed and then silently unreachable.
  // Enough tightly-paced lines that the median gap is a real 2s -- then one
  // line stranded far past the split threshold, on its own.
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push({ tMs: i * 2000, text: `line${i}` });
  lines.push({ tMs: 40000, text: 'the one-line hook' });
  const blocks = toBlocks(lines, { synced: true });
  assert.equal(blocks.length, 2, `expected the stranded line to be its own block, got ${blocks.length}`);
  const solo = blocks[1];
  assert.deepEqual(solo.lines, ['the one-line hook']);
  assert.ok(solo.endMs > solo.startMs,
    `a one-line block must have positive duration, got ${solo.startMs}..${solo.endMs}`);
});

test('toBlocks (synced): a block never swallows the silence after it', () => {
  // The last line's duration is capped by the real gap to whatever comes
  // next, so labelBlocks still sees long gaps and can still fill them with
  // instrumental sections.
  const lines = [
    { tMs: 0, text: 'a' }, { tMs: 2000, text: 'b' },
    { tMs: 60000, text: 'c' }, { tMs: 62000, text: 'd' },
  ];
  const [first] = toBlocks(lines, { synced: true });
  assert.ok(first.endMs <= 60000, `block ran into the next block's start: ${first.endMs}`);
  assert.ok(first.endMs - first.startMs < 30000, 'and did not span the whole gap');
});

test('toBlocks (synced): realistic verse/chorus breathing gaps now split -- regression for songs collapsing into one giant block', () => {
  // 8 song parts, each 5 lines ~2s apart (typical lyric pacing), separated
  // by a 6s breath between parts. The old MUL=4 threshold (~8s off a ~2s
  // median) never split on a 6s breath, so a real song's lyrics could
  // collapse into a single block regardless of length.
  const lines = [];
  let t = 0;
  for (let part = 0; part < 8; part++) {
    for (let i = 0; i < 5; i++) {
      lines.push({ tMs: t, text: `part${part}-line${i}` });
      t += 2000;
    }
    t += 6000 - 2000; // the last in-part step already advanced 2000; land on a 6s gap
  }
  const blocks = toBlocks(lines, { synced: true });
  assert.equal(blocks.length, 8, `expected one block per song part, got ${blocks.length}`);
});

test('toBlocks (synced): a block longer than the duration cap splits even with no single large gap', () => {
  // 20 lines at a steady ~3s pace (57s total) -- no individual gap is large
  // enough to trip the breathing-gap threshold, but the whole run is well
  // past MAX_BLOCK_DURATION_MS and must still be split.
  const lines = [];
  let t = 0;
  for (let i = 0; i < 20; i++) {
    lines.push({ tMs: t, text: `line${i}` });
    t += (i === 9) ? 3100 : 3000; // one marginally larger gap gives a clean split point
  }
  const blocks = toBlocks(lines, { synced: true });
  assert.ok(blocks.length >= 2, `expected the oversized block to split, got ${blocks.length} block(s)`);
  for (const b of blocks) {
    assert.ok(b.endMs - b.startMs <= 40000, `block spans ${b.endMs - b.startMs}ms, expected <=40000ms`);
  }
});

test('toBlocks (synced): equally-spaced lines split into balanced halves, not six single-line blocks plus one oversized one', () => {
  // The audit's own reproduction: 20 lines at an exact 3s pace tie on every
  // internal gap. Always taking the first tied gap used to strip lines off
  // the front one at a time (six 1-line blocks, then one 14-line, 42s
  // block). Picking the tie closest to the middle instead bisects cleanly.
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push({ tMs: i * 3000, text: `line${i}` });
  const blocks = toBlocks(lines, { synced: true });
  assert.equal(blocks.length, 2, `expected a clean balanced bisection, got ${blocks.length} block(s)`);
  for (const b of blocks) {
    assert.equal(b.lines.length, 10, 'each half should carry an equal share of the lines');
    assert.ok(b.endMs - b.startMs <= 40000, `block spans ${b.endMs - b.startMs}ms, expected <=40000ms`);
  }
});

test('toBlocks (synced): the duration cap counts the final line\'s own estimated duration, not just its onset', () => {
  // Onset-to-onset span is 36000ms (under the 40000ms cap), but the lines
  // are paced 4500ms apart, so the last line's own estimated duration pushes
  // the true end to ~40500ms -- past the cap even though raw onset span
  // alone says otherwise. The old cap check (onset span only) never split
  // this; the true end must.
  const lines = [];
  for (let i = 0; i < 9; i++) lines.push({ tMs: i * 4500, text: `line${i}` });
  const blocks = toBlocks(lines, { synced: true });
  assert.ok(blocks.length >= 2, `expected the block to split on true estimated end, got ${blocks.length} block(s)`);
  for (const b of blocks) {
    assert.ok(b.endMs - b.startMs <= 40000, `block spans ${b.endMs - b.startMs}ms, expected <=40000ms`);
  }
});

test('toBlocks: empty/degenerate input never throws', () => {
  assert.deepEqual(toBlocks([], { synced: true }), []);
  assert.deepEqual(toBlocks(null, { synced: false }), []);
});

test('labelBlocks (plain, no timing): a repeated block is CHORUS, one-off blocks are VERSE, and a late-song one-off is BRIDGE', () => {
  const verse1 = ['Walking down this empty road', 'Nothing left to say'];
  const chorus = ['We rise together now', 'We rise together now'];
  const verse2 = ['Another day another fight', 'Nothing left to say twice'];
  const bridgeText = ['Everything falls apart tonight', 'A different kind of truth'];
  // Realistic shape: verse/chorus/verse/chorus/bridge/chorus -- the bridge
  // sits before a final repeat, not at the very last position (a bridge
  // as literally the last block of the song is not the typical case this
  // heuristic targets).
  const blocks = toBlocks(
    [...verse1, '', ...chorus, '', ...verse2, '', ...chorus, '', ...bridgeText, '', ...chorus, ''],
    { synced: false },
  );
  const sections = labelBlocks(blocks);
  const kinds = sections.map((s) => s.kind);
  assert.equal(kinds.filter((k) => k === 'chorus').length, 3, 'all three chorus repeats must be labeled chorus');
  assert.equal(kinds[4], 'bridge', 'the late, unique block should read as the bridge');
  assert.equal(kinds[0], 'verse');
});

test('labelBlocks (synced): inserts intro/instrumental/outro and honors durationMs for the outro check', () => {
  // Hand-built blocks (bypassing toBlocks' adaptive gap threshold, which is
  // exercised separately) so the intro/instrumental/outro boundaries are
  // exact and unambiguous.
  const blocks = [
    { lines: ['first verse line', 'still verse one'], startMs: 15000, endMs: 17000 },
    { lines: ['chorus hits here'], startMs: 40000, endMs: 42000 },
    { lines: ['closing thoughts now'], startMs: 70000, endMs: 72000 },
  ];
  const durationMs = 100000; // 28s of outro silence after the final line ends
  const sections = labelBlocks(blocks, { durationMs });
  assert.equal(sections[0].kind, 'intro', 'a >=8s lead-in before the first stamp must be an intro');
  assert.equal(sections[0].startMs, 0);
  assert.equal(sections[0].endMs, 15000);
  assert.ok(sections.some((s) => s.kind === 'instrumental'), 'a >=12s gap between blocks must read as instrumental');
  assert.equal(sections[sections.length - 1].kind, 'outro', 'the trailing silence must read as an outro');
  assert.equal(sections[sections.length - 1].startMs, 72000);
});

test('labelBlocks: an empty block list returns an empty section list', () => {
  assert.deepEqual(labelBlocks([]), []);
});

test('labelBlocks: explicit section tags override recurrence/position -- a repeated block explicitly tagged VERSE stays a verse', () => {
  const blocks = toBlocks(
    [
      '[Verse] walking down this empty road', 'nothing left to say', '',
      '[Chorus] we rise together now', '',
      '[Verse] another day another fight', '',
      '[Chorus] we rise together now', '',
      '[Verse] a familiar refrain repeats itself', '',
      '[Verse] a familiar refrain repeats itself', '',
    ],
    { synced: false },
  );
  const sections = labelBlocks(blocks);
  assert.equal(sections[0].kind, 'verse');
  assert.equal(sections[1].kind, 'chorus');
  assert.equal(sections[4].kind, 'verse', 'an explicitly tagged verse must stay a verse even though it repeats verbatim');
  assert.equal(sections[5].kind, 'verse');
  for (const s of sections) assert.ok(s.kindConfidence >= 0.9, 'an explicit tag is strong evidence of function');
  assert.ok(!sections[0].text.includes('[Verse]'), 'the tag itself must not leak into the displayed text');
  // The two identical "familiar refrain" blocks are still recognized as the
  // same recurrence family, just not promoted to CHORUS by it.
  assert.equal(sections[4].familyId, sections[5].familyId);
});

test('labelBlocks: kind hypotheses from recurrence/position carry lower kindConfidence than an explicit tag', () => {
  const verse1 = ['Walking down this empty road', 'Nothing left to say'];
  const chorus = ['We rise together now', 'We rise together now'];
  const bridgeText = ['Everything falls apart tonight', 'A different kind of truth'];
  const blocks = toBlocks(
    [...verse1, '', ...chorus, '', ...verse1, '', ...chorus, '', ...bridgeText, '', ...chorus, ''],
    { synced: false },
  );
  const sections = labelBlocks(blocks);
  const chorusSection = sections.find((s) => s.kind === 'chorus');
  const bridgeSection = sections.find((s) => s.kind === 'bridge');
  assert.ok(chorusSection.kindConfidence < 0.9);
  assert.ok(bridgeSection.kindConfidence < 0.9);
});

test('sectionEmotion: love/joy vocabulary reads positive-valence; blood/rage/scream vocabulary reads negative-valence and high-arousal', () => {
  const happy = sectionEmotion('I love this joy and happy sunshine dream together forever');
  const dark = sectionEmotion('blood rage scream kill destroy the demon nightmare fire burning');
  assert.ok(happy.valence > 0.3, `expected positive valence, got ${happy.valence}`);
  assert.ok(dark.valence < -0.3, `expected negative valence, got ${dark.valence}`);
  assert.ok(dark.intensity > 0.6, `expected high arousal for the aggressive text, got ${dark.intensity}`);
  const epicBridge = sectionEmotion('rise up now for glory and victory epic triumph legend');
  assert.ok(epicBridge.valence > 0 && epicBridge.intensity > 0.6, 'an "epic" bridge should read positive AND high-arousal');
});

test('sectionEmotion: unrecognized text reads neutral rather than throwing or defaulting to an extreme', () => {
  const neutral = sectionEmotion('the quick brown zephyr glyph');
  assert.equal(neutral.valence, 0);
  assert.ok(neutral.intensity > 0 && neutral.intensity < 1);
  assert.doesNotThrow(() => sectionEmotion(''));
});
