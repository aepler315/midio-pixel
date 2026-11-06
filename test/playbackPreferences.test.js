import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PLAYBACK_PREFS, readPlaybackPrefs, writePlaybackPrefs } from '../src/ui/PlaybackPreferences.js';
const storage = initial => {
  const data = new Map(initial === undefined ? [] : [['midio.playback.v1', initial]]);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('playback defaults enable shuffle and leave continuous playback off', () => {
  assert.deepEqual(DEFAULT_PLAYBACK_PREFS, { shuffle: true, continuous: false });
  assert.deepEqual(readPlaybackPrefs(storage()), DEFAULT_PLAYBACK_PREFS);
});

test('boolean playback preferences round trip under a namespaced version key', () => {
  const store = storage();
  assert.equal(writePlaybackPrefs(store, { shuffle: false, continuous: true }), true);
  assert.deepEqual(readPlaybackPrefs(store), { shuffle: false, continuous: true });
  assert.deepEqual([...store.data.keys()], ['midio.playback.v1']);
});

test('malformed stored preferences fall back without throwing or modifying storage', () => {
  for (const value of ['{broken', 'null', '[]', 'false', '123', '"shuffle"']) {
    const store = storage(value);
    assert.deepEqual(readPlaybackPrefs(store), DEFAULT_PLAYBACK_PREFS, value);
    assert.equal(store.data.get('midio.playback.v1'), value);
  }
});

test('only booleans override defaults and unknown fields are ignored', () => {
  const store = storage(JSON.stringify({ shuffle: 'false', continuous: true, other: 'discard' }));
  assert.deepEqual(readPlaybackPrefs(store), { shuffle: true, continuous: true });
  assert.equal(writePlaybackPrefs(store, { shuffle: false, continuous: 1, other: 'discard' }), true);
  assert.deepEqual(JSON.parse(store.data.get('midio.playback.v1')), { shuffle: false, continuous: false });
});

test('missing and blocked storage never prevents changing playback in the current session', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  for (const store of [undefined, null, {}, blocked]) {
    assert.deepEqual(readPlaybackPrefs(store), DEFAULT_PLAYBACK_PREFS);
    assert.equal(writePlaybackPrefs(store, { shuffle: false, continuous: true }), false);
  }
});

test('preference reads return independent values and writes do not mutate their input', () => {
  const store = storage(), first = readPlaybackPrefs(store);
  first.shuffle = false;
  assert.deepEqual(readPlaybackPrefs(store), { shuffle: true, continuous: false });
  const prefs = Object.freeze({ shuffle: false, continuous: true });
  assert.equal(writePlaybackPrefs(store, prefs), true);
  assert.deepEqual(prefs, { shuffle: false, continuous: true });
});
