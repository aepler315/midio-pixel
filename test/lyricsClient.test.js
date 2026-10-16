import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, fetchLyrics, fetchLyricsCached } from '../src/lyrics/LyricsClient.js';

test('parseLrc: handles stacked timestamps, sorts, and dedups exact repeats', () => {
  const lrc = '[00:15.00][00:45.00]La la la\n[00:00.50]Is this the real life?\nnot a lyric line at all\n[00:00.50]Is this the real life?';
  const lines = parseLrc(lrc);
  assert.deepEqual(lines.map((l) => l.tMs), [500, 15000, 45000]);
  assert.equal(lines[0].text, 'Is this the real life?');
  assert.equal(lines[1].text, 'La la la');
});

test('parseLrc: an [offset:ms] tag shifts every stamp earlier by that amount', () => {
  const lrc = '[offset:+500]\n[00:10.00]Hello';
  const lines = parseLrc(lrc);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tMs, 10000 - 500);
});

test('parseLrc: malformed/empty input never throws and yields an empty list', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc(null), []);
  assert.doesNotThrow(() => parseLrc('garbage\n[not-a-stamp]text'));
});

function fakeResponse(ok, body) {
  return { ok, json: async () => body };
}

test('fetchLyrics: a direct /api/get hit with synced lyrics returns parsed lines + meta, no search call', () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    assert.ok(url.includes('/api/get'), 'must try the direct lookup first');
    return fakeResponse(true, {
      trackName: 'Bohemian Rhapsody', artistName: 'Queen', albumName: 'A Night At The Opera', duration: 352,
      instrumental: false, plainLyrics: 'Is this the real life?', syncedLyrics: '[00:00.67]Is this the real life?',
    });
  };
  return fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody', durationSec: 354 }, fetchFn).then((result) => {
    assert.equal(calls, 1);
    assert.equal(result.instrumental, false);
    assert.equal(result.synced.length, 1);
    assert.equal(result.synced[0].tMs, 670);
    assert.equal(result.meta.artist, 'Queen');
  });
});

test('fetchLyrics: an instrumental record reports instrumental:true with no lyric text', async () => {
  const fetchFn = async () => fakeResponse(true, { trackName: 'Interlude', artistName: 'Band', duration: 90, instrumental: true, plainLyrics: null, syncedLyrics: null });
  const result = await fetchLyrics({ artist: 'Band', title: 'Interlude', durationSec: 90 }, fetchFn);
  assert.equal(result.instrumental, true);
  assert.equal(result.synced, null);
  assert.equal(result.plain, null);
});

test('fetchLyrics: falls back to /api/search on a 404 get, picking the closest-duration/best-named candidate', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('/api/get')) return fakeResponse(false, null);
    return fakeResponse(true, [
      { trackName: 'Bohemian Rhapsody', artistName: 'Queen Cover Band', duration: 200, plainLyrics: 'wrong one', syncedLyrics: null },
      { trackName: 'Bohemian Rhapsody', artistName: 'Queen', duration: 353, plainLyrics: 'Is this the real life?', syncedLyrics: null },
    ]);
  };
  const result = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody', durationSec: 352 }, fetchFn);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('/api/search'));
  assert.equal(result.plain[0], 'Is this the real life?');
  assert.equal(result.meta.artist, 'Queen');
});

test('fetchLyrics: search candidates outside the duration tolerance are excluded even if better-named', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/api/get')) return fakeResponse(false, null);
    return fakeResponse(true, [
      { trackName: 'Song', artistName: 'Artist', duration: 100, plainLyrics: 'far off duration', syncedLyrics: null },
    ]);
  };
  const result = await fetchLyrics({ artist: 'Artist', title: 'Song', durationSec: 300 }, fetchFn);
  assert.equal(result, null);
});

test('fetchLyrics: network failure/thrown fetch resolves to null, never rejects', async () => {
  const fetchFn = async () => { throw new Error('offline'); };
  const result = await fetchLyrics({ artist: 'A', title: 'B', durationSec: 100 }, fetchFn);
  assert.equal(result, null);
});

test('fetchLyrics: no title at all short-circuits to null without calling fetch', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return fakeResponse(true, {}); };
  const result = await fetchLyrics({ artist: 'A' }, fetchFn);
  assert.equal(result, null);
  assert.equal(called, false);
});

test('fetchLyricsCached: caches a successful result and skips the network on the next call', async (t) => {
  const store = new Map();
  const g = globalThis;
  const hadLS = 'localStorage' in g;
  const savedLS = hadLS ? g.localStorage : undefined;
  g.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  t.after(() => { if (hadLS) g.localStorage = savedLS; else delete g.localStorage; });

  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    if (url.includes('/api/get')) {
      return fakeResponse(true, { trackName: 'X', artistName: 'Y', duration: 100, instrumental: false, plainLyrics: 'la', syncedLyrics: null });
    }
    return fakeResponse(false, null);
  };
  const id = { artist: 'Y', title: 'X', durationSec: 100 };
  const first = await fetchLyricsCached(id, fetchFn);
  assert.equal(calls, 1);
  assert.ok(first.plain);
  const second = await fetchLyricsCached(id, fetchFn);
  assert.equal(calls, 1, 'the second call must be served from cache, not the network');
  assert.deepEqual(second, first);
});

for (const [title, artist] of [['Unrelated', 'Someone Else'], ['Song', 'Someone Else'], ['Unrelated', 'Artist']]) {
  test(`search rejects identity mismatch: ${title} / ${artist}`, async () => {
    const result = await fetchLyrics({ title: 'Song', artist: 'Artist', durationSec: 180 },
      async (url) => url.includes('/api/get') ? fakeResponse(false, null) : fakeResponse(true,
        [{ trackName: title, artistName: artist, duration: 180, plainLyrics: 'wrong' }]));
    assert.equal(result, null);
  });
}

test('search compares non-Latin identities without treating all names as empty', async () => {
  const result = await fetchLyrics({ title: '夜空', artist: '歌手', durationSec: 180 },
    async (url) => url.includes('/api/get') ? fakeResponse(false, null) : fakeResponse(true,
      [{ trackName: '海辺', artistName: '別人', duration: 180, plainLyrics: 'wrong' }]));
  assert.equal(result, null);
});
