// The library view's whole mind lives in TrackIndex: what a row is called
// when nobody tagged it, what "sorted by artist" does to the untagged, and
// what typing into the box is allowed to match. The panel just paints the
// answers, so this is where the behaviour is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayTitle, displayArtist, sortTracks, parseQuery, matchesQuery, filterTracks,
  folderContents, breadcrumbs, formatDuration, recentlyPlayed, untaggedTracks, SORTS,
} from '../src/library/TrackIndex.js';

function track(over = {}) {
  return {
    key: over.path || 'k', path: 'a.mp3', folder: '', name: 'a.mp3', ext: 'mp3',
    title: null, artist: null, album: null, size: 0, lastModified: 0,
    addedMs: 0, playCount: 0, lastPlayedMs: 0, durationSec: null, tagSource: 'none',
    ...over,
  };
}

test('an untagged track is named after its file, never left blank', () => {
  assert.equal(displayTitle(track({ name: '04 Weird Fishes.flac' })), '04 Weird Fishes');
  assert.equal(displayTitle(track({ name: '04 Weird Fishes.flac', title: 'Weird Fishes' })), 'Weird Fishes');
  // A tag that is nothing but whitespace is not a tag.
  assert.equal(displayTitle(track({ name: 'x.mp3', title: '   ' })), 'x');
  assert.equal(displayTitle(track({ name: '' })), 'Untitled');
  assert.equal(displayArtist(track()), 'Unknown artist');
});

test('sorting is numeric and case-blind, so track 2 precedes track 10', () => {
  const tracks = [
    track({ path: 'c', name: '10 Ten.mp3' }),
    track({ path: 'a', name: '2 Two.mp3' }),
    track({ path: 'b', name: 'abba.mp3' }),
    track({ path: 'd', name: 'ABBA Gold.mp3' }),
  ];
  const names = sortTracks(tracks, 'title').map((t) => displayTitle(t));
  assert.deepEqual(names, ['2 Two', '10 Ten', 'abba', 'ABBA Gold']);
});

test('reversing a sort reverses the tagged tracks, it does not promote the blanks', () => {
  const tracks = [
    track({ path: 'a', artist: 'Aphex Twin' }),
    track({ path: 'b', artist: null }),
    track({ path: 'c', artist: 'Zappa' }),
  ];
  const asc = sortTracks(tracks, 'artist', false).map((t) => t.path);
  const desc = sortTracks(tracks, 'artist', true).map((t) => t.path);
  assert.deepEqual(asc, ['a', 'c', 'b']);
  // The untagged row stays at the bottom in BOTH directions -- the whole
  // point of the sort is to see names, and a reversal that fills the top of
  // the list with blanks has answered a different question.
  assert.deepEqual(desc, ['c', 'a', 'b']);
});

test('sort order is total, so two identical titles never swap between renders', () => {
  const tracks = [
    track({ path: 'z/same.mp3', title: 'Same' }),
    track({ path: 'a/same.mp3', title: 'Same' }),
  ];
  const once = sortTracks(tracks, 'title').map((t) => t.path);
  const again = sortTracks([...tracks].reverse(), 'title').map((t) => t.path);
  assert.deepEqual(once, ['a/same.mp3', 'z/same.mp3']);
  assert.deepEqual(again, once);
});

test('every offered sort actually sorts and is reversible', () => {
  const tracks = [
    track({ path: 'a', title: 'B', artist: 'B', album: 'B', folder: 'b', addedMs: 2, lastPlayedMs: 2, playCount: 2, durationSec: 200 }),
    track({ path: 'b', title: 'A', artist: 'A', album: 'A', folder: 'a', addedMs: 1, lastPlayedMs: 1, playCount: 1, durationSec: 100 }),
  ];
  for (const sort of SORTS) {
    const asc = sortTracks(tracks, sort.key, false).map((t) => t.path);
    const desc = sortTracks(tracks, sort.key, true).map((t) => t.path);
    assert.deepEqual(asc, ['b', 'a'], `${sort.key} ascending`);
    assert.deepEqual(desc, ['a', 'b'], `${sort.key} descending`);
  }
});

test('more words narrow the list, and a field prefix scopes one of them', () => {
  const tracks = [
    track({ path: 'a', title: 'Live Forever', artist: 'Oasis', album: 'Definitely Maybe' }),
    track({ path: 'b', title: 'Live and Let Die', artist: 'Wings', album: 'Live' }),
  ];
  assert.equal(filterTracks(tracks, 'live').length, 2);
  assert.equal(filterTracks(tracks, 'live oasis').length, 1);
  assert.equal(filterTracks(tracks, 'artist:wings').length, 1);
  // A field prefix must not also match the free-text haystack: "Live" is
  // the album of b, so an unscoped "live" finds both, and album:live must
  // find only the one whose ALBUM says so.
  assert.deepEqual(filterTracks(tracks, 'album:live').map((t) => t.path), ['b']);
});

test('a quoted phrase stays one term', () => {
  const terms = parseQuery('artist:"nine inch nails" hurt');
  assert.deepEqual(terms, [{ field: 'artist', value: 'nine inch nails' }, { field: null, value: 'hurt' }]);
  // An unknown prefix is not a field -- it is part of what they typed.
  assert.deepEqual(parseQuery('bpm:120'), [{ field: null, value: 'bpm:120' }]);
  assert.deepEqual(parseQuery('   '), []);
});

test('an untagged library is still searchable by where its files are', () => {
  const t = track({ path: 'Bootlegs/1977/set1.mp3', folder: 'Bootlegs/1977' });
  assert.ok(matchesQuery(t, parseQuery('bootlegs')));
  assert.ok(matchesQuery(t, parseQuery('folder:1977')));
  assert.ok(!matchesQuery(t, parseQuery('1978')));
});

test('a folder counts everything beneath it, not just its own files', () => {
  const tracks = [
    track({ path: 'Radiohead/Kid A/1.mp3', folder: 'Radiohead/Kid A' }),
    track({ path: 'Radiohead/Kid A/2.mp3', folder: 'Radiohead/Kid A' }),
    track({ path: 'Radiohead/live.mp3', folder: 'Radiohead' }),
    track({ path: 'loose.mp3', folder: '' }),
  ];
  const root = folderContents(tracks, '');
  // Radiohead holds three tracks, only one of which is directly inside it.
  // A "1 track" label here would misdescribe an Artist/Album library.
  assert.deepEqual(root.folders, [{ name: 'Radiohead', path: 'Radiohead', count: 3 }]);
  assert.deepEqual(root.tracks.map((t) => t.path), ['loose.mp3']);

  const inside = folderContents(tracks, 'Radiohead');
  assert.deepEqual(inside.folders, [{ name: 'Kid A', path: 'Radiohead/Kid A', count: 2 }]);
  assert.deepEqual(inside.tracks.map((t) => t.path), ['Radiohead/live.mp3']);
});

test('a folder named like a sibling prefix is not swallowed by it', () => {
  const tracks = [
    track({ path: 'Rock/a.mp3', folder: 'Rock' }),
    track({ path: 'Rockabilly/b.mp3', folder: 'Rockabilly' }),
  ];
  const inside = folderContents(tracks, 'Rock');
  assert.deepEqual(inside.tracks.map((t) => t.path), ['Rock/a.mp3']);
  assert.deepEqual(inside.folders, []);
});

test('there is always a way back out of a folder', () => {
  assert.deepEqual(breadcrumbs(''), [{ name: 'Library', path: '' }]);
  assert.deepEqual(breadcrumbs('A/B'), [
    { name: 'Library', path: '' },
    { name: 'A', path: 'A' },
    { name: 'B', path: 'A/B' },
  ]);
});

test('an unknown duration reads as unknown, not as zero', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(0), '—');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3600), '60:00');
});

test('recently played is by last play and never repeats a track', () => {
  const tracks = [
    track({ path: 'a', lastPlayedMs: 30 }),
    track({ path: 'b', lastPlayedMs: 0 }),
    track({ path: 'c', lastPlayedMs: 50 }),
  ];
  assert.deepEqual(recentlyPlayed(tracks, 5).map((t) => t.path), ['c', 'a']);
  assert.equal(recentlyPlayed(tracks, 1).length, 1);
  assert.deepEqual(recentlyPlayed([], 5), []);
});

test('a filename guess still counts as untagged -- replacing it is the point', () => {
  const tracks = [
    track({ path: 'a', tagSource: 'tags' }),
    track({ path: 'b', tagSource: 'filename' }),
    track({ path: 'c', tagSource: 'none' }),
    track({ path: 'd', tagSource: 'auto' }),
  ];
  assert.deepEqual(untaggedTracks(tracks).map((t) => t.path), ['b', 'c']);
});
