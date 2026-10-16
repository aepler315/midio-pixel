// Timed lyric grounding: the ladder of identities tried against a lyrics
// provider until one lands.
//
// The failure this exists to fix is not a broken request -- it is that real
// uploads carry tags written by whoever ripped them, while a provider indexes
// the canonical release. A single lookup on raw tags misses constantly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripTitleModifiers, stripArtistModifiers, stripAllBrackets, splitPackedTitle,
  groundingAttempts, groundLyrics, hasUsableLyrics,
} from '../src/lyrics/LyricGrounding.js';

test('title modifiers come off, in brackets or after a dash', () => {
  const cases = [
    ['Song (Instrumental)', 'Song'],
    ['Song (Guitar Track)', 'Song'],
    ['Song [Drum Track]', 'Song'],
    ['Wish You Were Here - 2011 Remaster', 'Wish You Were Here'],
    ['Wish You Were Here (2011 Remaster)', 'Wish You Were Here'],
    ['Hey Jude (Live at Wembley)', 'Hey Jude'],
    ['Track (Official Music Video)', 'Track'],
    ['Track - Radio Edit', 'Track'],
    ['Song (feat. Someone) [Explicit]', 'Song'],
    ['Song (Karaoke Version)', 'Song'],
  ];
  for (const [raw, want] of cases) {
    assert.equal(stripTitleModifiers(raw), want, `stripping ${JSON.stringify(raw)}`);
  }
});

test('a clean title is returned untouched, and a title that is ALL modifier survives', () => {
  assert.equal(stripTitleModifiers('Paranoid Android'), 'Paranoid Android');
  // Stripping to nothing would make the query worse than not trying.
  assert.equal(stripTitleModifiers('Instrumental'), 'Instrumental');
  assert.equal(stripTitleModifiers(''), '');
  assert.equal(stripTitleModifiers(null), '');
});

test('artist reduces to the primary act', () => {
  assert.equal(stripArtistModifiers('Pink Floyd feat. David Gilmour'), 'Pink Floyd');
  assert.equal(stripArtistModifiers('Jay-Z & Kanye West'), 'Jay-Z');
  assert.equal(stripArtistModifiers('Artist, Other Artist'), 'Artist');
  assert.equal(stripArtistModifiers('Some Band - Topic'), 'Some Band');
  assert.equal(stripArtistModifiers('Radiohead'), 'Radiohead');
  // A name that is only "modifier" words must not vanish.
  assert.equal(stripArtistModifiers('The The'), 'The The');
});

test('"Artist - Title" packed into one field is unpacked', () => {
  assert.deepEqual(splitPackedTitle('Radiohead - Creep'), { artist: 'Radiohead', title: 'Creep' });
  assert.deepEqual(splitPackedTitle('A - B - C'), { artist: 'A', title: 'B - C' });
  assert.equal(splitPackedTitle('Creep'), null);
  assert.equal(splitPackedTitle('Creep-ish'), null, 'a hyphen inside a word is not a split');
});

test('stripAllBrackets is the blunt fallback for modifiers we did not name', () => {
  assert.equal(stripAllBrackets('Song (Kompletely Made Up Tag)'), 'Song');
  assert.equal(stripAllBrackets('Song'), 'Song');
  assert.equal(stripAllBrackets('(Only Brackets)'), '(Only Brackets)', 'never strips to nothing');
});

test('the ladder runs most-specific first and never repeats a query', () => {
  const attempts = groundingAttempts({
    artist: 'Pink Floyd feat. David Gilmour',
    title: 'Wish You Were Here (2011 Remaster)',
    album: 'Echoes: The Best Of',
    durationSec: 334,
  });
  assert.ok(attempts.length >= 6, `expected a real ladder, got ${attempts.length}`);
  // First rung is the tags exactly as they came, duration included.
  assert.equal(attempts[0].title, 'Wish You Were Here (2011 Remaster)');
  assert.equal(attempts[0].artist, 'Pink Floyd feat. David Gilmour');
  assert.equal(attempts[0].durationSec, 334);
  // The cleaned identity must appear somewhere later.
  assert.ok(attempts.some((a) => a.title === 'Wish You Were Here' && a.artist === 'Pink Floyd'),
    'the stripped identity has to be on the ladder');
  // The risky swap is last, not first.
  const swapIdx = attempts.findIndex((a) => /swapped/.test(a.why));
  assert.equal(swapIdx, attempts.length - 1, 'the swap would produce confident wrong answers early');
  // No duplicates.
  const keys = attempts.map((a) => `${a.artist}|${a.title}|${a.album}|${a.durationSec}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate queries waste a request each');
  // Every rung explains itself.
  for (const a of attempts) assert.ok(a.why && a.why.length > 0);
});

test('no usable title means no requests at all', () => {
  assert.deepEqual(groundingAttempts({ artist: 'Someone' }), []);
  assert.deepEqual(groundingAttempts({}), []);
  assert.deepEqual(groundingAttempts({ title: '   ' }), []);
});

test('grounding stops at the first rung that lands', async () => {
  const synced = { synced: [{ tMs: 0, text: 'hi' }] };
  const calls = [];
  const { result, attempt, tried } = await groundLyrics(
    { artist: 'A', title: 'T (Instrumental)' },
    async (a) => { calls.push(a.why); return a.title === 'T' ? synced : null; },
  );
  assert.equal(result, synced);
  assert.ok(/stripped/.test(attempt.why), `landed via: ${attempt.why}`);
  assert.equal(tried, calls.length);
  assert.ok(calls.length < 12, 'should not have walked the whole ladder after a hit');
});

test('a synced result beats a plain one found earlier -- timestamps are the point', async () => {
  const plain = { plain: ['a line'] };
  const synced = { synced: [{ tMs: 0, text: 'a line' }] };
  const { result, attempt } = await groundLyrics(
    { artist: 'A', title: 'T (Live)' },
    async (a) => (a.title === 'T (Live)' ? plain : (a.title === 'T' ? synced : null)),
  );
  assert.equal(result, synced, 'must keep climbing past plain text to find timestamps');
  assert.ok(/stripped/.test(attempt.why));
});

test('...but a plain result is kept if nothing better ever turns up', async () => {
  const plain = { plain: ['a line'] };
  const { result } = await groundLyrics(
    { artist: 'A', title: 'T (Live)' },
    async (a) => (a.title === 'T (Live)' ? plain : null),
  );
  assert.equal(result, plain, 'plain lyrics are better than none');
});

test('an instrumental or empty answer is not a landing', async () => {
  assert.equal(hasUsableLyrics({ instrumental: true, plain: ['x'] }), false);
  assert.equal(hasUsableLyrics({ plain: [] }), false);
  assert.equal(hasUsableLyrics(null), false);
  const { result, tried } = await groundLyrics(
    { artist: 'A', title: 'T' },
    async () => ({ instrumental: true }),
  );
  assert.equal(result, null);
  assert.ok(tried > 1, 'a "marked instrumental" answer should not stop the ladder');
});

test('a thrown request is a missed rung, not a failed grounding', async () => {
  const synced = { synced: [{ tMs: 0, text: 'hi' }] };
  let n = 0;
  const { result } = await groundLyrics({ artist: 'A', title: 'T (Live)' }, async () => {
    if (++n === 1) throw new Error('network');
    return synced;
  });
  assert.equal(result, synced, 'one failed request must not abort the whole ladder');
});

test('it can be capped and cancelled', async () => {
  let n = 0;
  const capped = await groundLyrics({ artist: 'A', title: 'T (Live)' },
    async () => { n++; return null; }, { maxAttempts: 3 });
  assert.equal(capped.tried, 3);
  assert.equal(n, 3);

  let m = 0;
  const stopped = await groundLyrics({ artist: 'A', title: 'T (Live)' },
    async () => { m++; return null; }, { cancelled: () => m >= 2 });
  assert.equal(m, 2, 'stops between attempts once cancelled');
  assert.equal(stopped.result, null);
});

test('progress is reportable, so a UI can say what it is trying', async () => {
  const seen = [];
  await groundLyrics({ artist: 'A', title: 'T (Live)' }, async () => null, {
    onAttempt: (a, i, total) => seen.push([i, total, a.why]),
  });
  assert.ok(seen.length > 1);
  assert.equal(seen[0][0], 0);
  assert.ok(seen.every(([, total]) => total === seen.length));
});
