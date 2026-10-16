// The timestamped-lyrics section pipeline, exercised end to end on real
// modules rather than one stage at a time.
//
// Every stage has its own unit tests, and they all pass -- but the failure
// this guards against is the one those cannot see: a stage quietly changing
// the SHAPE it hands the next one, so each half is individually correct and
// the chain still delivers nothing. The chain is
//
//   LRC text -> parseLrc -> toBlocks({synced}) -> labelBlocks
//            -> [main.js buildLyricSections] -> fuseSections -> sections
//
// so this drives the real functions in that order with a real LRC file and
// asserts that a synced lyric actually MOVES a section boundary onto its
// own timestamp. If it stops doing that, the feature is off, however green
// the per-module tests are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc } from '../src/lyrics/LyricsClient.js';
import { toBlocks, labelBlocks } from '../src/lyrics/LyricStructure.js';
import { fuseSections } from '../src/lyrics/SectionFusion.js';

// A short song: intro line, a verse, a chorus that repeats, an outro. Blank
// lines are the block separators toBlocks keys on.
const LRC = `[00:05.00]Walking out alone tonight
[00:07.50]The street is cold and wide

[00:20.00]I remember summer light
[00:23.00]I remember how you smiled
[00:26.00]Every road we used to ride

[00:40.00]So hold me now, hold me now
[00:43.00]We are burning bright
[00:46.00]So hold me now, hold me now

[01:00.00]I remember summer light
[01:03.00]I remember how you smiled

[01:20.00]So hold me now, hold me now
[01:23.00]We are burning bright

[01:40.00]And the street is cold and wide
`;

const DURATION_MS = 120000;
// A plain 4/4 bar grid at 120bpm (2s per bar) across the whole song.
// Entries are {ms} objects -- the shape Conductor.barGrid actually carries,
// and what nearestBarMs/barWidthMs read. A bare number array silently makes
// every snap NaN, which is worth stating here because it is exactly the kind
// of shape drift between stages this file exists to catch.
const BAR_GRID = Array.from({ length: 61 }, (_, i) => ({ ms: i * 2000 }));

/** The synced half of main.js's buildLyricSections, on the real modules. */
function buildLyricSections(lrcText, durationMs) {
  const synced = parseLrc(lrcText);
  const blocks = toBlocks(synced, { synced: true });
  return labelBlocks(blocks, { durationMs });
}

test('parseLrc reads the timestamps at all', () => {
  const synced = parseLrc(LRC);
  assert.ok(synced.length >= 12, `expected the lines back, got ${synced.length}`);
  const first = synced[0];
  assert.ok(typeof first.tMs === 'number', 'every synced line needs a time');
  assert.equal(first.tMs, 5000, `first line should be at 0:05, got ${first.tMs}`);
  assert.ok(/walking out alone/i.test(first.text));
  // Monotonic -- a shuffled timeline would fuse into nonsense downstream.
  for (let i = 1; i < synced.length; i++) {
    assert.ok(synced[i].tMs >= synced[i - 1].tMs, `line ${i} goes backwards in time`);
  }
});

test('blocks keep their timestamps through toBlocks and labelBlocks', () => {
  const sections = buildLyricSections(LRC, DURATION_MS);
  assert.ok(sections.length >= 4, `expected several blocks, got ${sections.length}`);
  for (const s of sections) {
    assert.ok(Number.isFinite(s.startMs), `a section lost its startMs: ${JSON.stringify(s)}`);
    assert.ok(Number.isFinite(s.endMs), `a section lost its endMs: ${JSON.stringify(s)}`);
    assert.ok(s.endMs > s.startMs, 'a section must have positive duration');
    assert.ok(typeof s.kind === 'string' && s.kind.length > 0, 'every block gets a kind');
  }
  // The first block starts where its first line does, not at zero.
  assert.ok(Math.abs(sections[0].startMs - 5000) < 1500,
    `first block should start near its own first line, got ${sections[0].startMs}`);
});

test('the repeated block is recognised as the same thing both times', () => {
  // "So hold me now" appears twice; whatever label it gets, it must get the
  // SAME one -- that recurrence is what makes a chorus read as a place you
  // return to rather than as two unrelated sections.
  const sections = buildLyricSections(LRC, DURATION_MS);
  const hold = sections.filter((s) => /hold me now/i.test(s.text || ''));
  assert.ok(hold.length >= 2, `expected the hook twice, found ${hold.length}`);
  assert.equal(hold[0].kind, hold[1].kind,
    `the same words got two different kinds: ${hold[0].kind} vs ${hold[1].kind}`);
});

test('fusion actually moves a boundary onto a lyric timestamp', () => {
  // THE test. A novelty read that knows nothing about the words, fused with
  // the timed lyric blocks, must end up with boundaries at the lyrics.
  const novelty = [
    { startMs: 0, endMs: 60000, profile: 'A' },
    { startMs: 60000, endMs: DURATION_MS, profile: 'B' },
  ];
  const lyricSections = buildLyricSections(LRC, DURATION_MS);
  const fused = fuseSections(novelty, lyricSections, BAR_GRID, DURATION_MS);

  assert.ok(Array.isArray(fused) && fused.length > 0, 'fusion returned nothing');
  assert.ok(fused.length > novelty.length,
    `fusion should add the lyric boundaries: ${novelty.length} -> ${fused.length}`);

  // Every fused boundary should sit near SOME lyric block start (allowing the
  // bar-grid snap fusion applies), and at least one lyric start must have
  // produced a boundary that the novelty read did not already have.
  const starts = fused.map((s) => s.startMs);
  for (const s of starts) {
    assert.ok(Number.isFinite(s), `fusion produced a non-finite boundary: ${s}`);
  }
  // Sub-bar boundaries are deliberately merged (fuseSections drops a lyric
  // start within one bar of a boundary it already has), so not every block
  // earns its own -- but the distinct block starts must be represented.
  let matched = 0;
  for (const ly of lyricSections) {
    if (starts.some((s) => Math.abs(s - ly.startMs) <= 2500)) matched++;
  }
  assert.ok(matched >= 5,
    `expected the lyric blocks to land boundaries, only ${matched}/${lyricSections.length} did`);
  // ...and a boundary the novelty read did not have must exist.
  assert.ok(starts.some((s) => s !== 0 && s !== 60000),
    'fusion added no boundary of its own');
});

test('fusion is a strict no-op without lyrics -- the guarantee the rest relies on', () => {
  const novelty = [
    { startMs: 0, endMs: 60000, profile: 'A' },
    { startMs: 60000, endMs: DURATION_MS, profile: 'B' },
  ];
  assert.equal(fuseSections(novelty, null, BAR_GRID, DURATION_MS), novelty);
  assert.equal(fuseSections(novelty, [], BAR_GRID, DURATION_MS), novelty);
});

test('an instrumental or empty result never reaches fusion as a section', () => {
  // buildLyricSections returns null for these; this pins that the stages it
  // is built from produce nothing usable, so that contract is real.
  assert.equal(toBlocks([], { synced: true }).length, 0);
  assert.equal(parseLrc('').length, 0);
  assert.equal(parseLrc('no timestamps here at all\njust prose').length, 0);
});
