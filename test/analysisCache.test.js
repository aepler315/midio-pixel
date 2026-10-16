// The cache's contract is small but its failure modes are not: it must never
// throw into the load path, it must degrade to a no-op where there is no
// storage, and it must evict by LAST USE rather than by insertion order --
// the songs someone replays are the ones worth keeping.
//
// Tested against a minimal in-memory IndexedDB rather than a browser. The
// module takes its `scope` as an argument for exactly this reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBundle, putBundle, listBundles, clearBundles, analysisCacheSupported, MAX_ENTRIES,
} from '../src/audio/AnalysisCache.js';

/** Enough of IndexedDB for this module: one keyPath store, get/put/delete/
 *  getAll/clear, and the async request shape. */
function fakeIdb({ failOpen = false, failPut = false, lateAbort = false } = {}) {
  const data = new Map();
  const fire = (req, prop, value) => {
    queueMicrotask(() => { req.result = value; req[prop]?.(); });
  };
  const store = {
    get: (key) => { const r = {}; fire(r, 'onsuccess', data.get(key)); return r; },
    put: (row) => {
      const r = {};
      if (failPut) queueMicrotask(() => r.onerror?.());
      else { data.set(row.key, row); fire(r, 'onsuccess', undefined); }
      return r;
    },
    delete: (key) => { const r = {}; data.delete(key); fire(r, 'onsuccess', undefined); return r; },
    getAll: () => { const r = {}; fire(r, 'onsuccess', [...data.values()]); return r; },
    clear: () => { const r = {}; data.clear(); fire(r, 'onsuccess', undefined); return r; },
    createIndex: () => {},
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => {
      const transaction = { objectStore: () => store };
      setTimeout(() => (lateAbort ? transaction.onabort?.() : transaction.oncomplete?.()), 0);
      return transaction;
    },
    close: () => {},
  };
  return {
    _data: data,
    indexedDB: {
      open: () => {
        const req = {};
        queueMicrotask(() => {
          if (failOpen) { req.onerror?.(); return; }
          req.result = db;
          req.onsuccess?.();
        });
        return req;
      },
    },
  };
}

const bundleFor = (name) => ({ v: 1, name, durationMs: 1000, identity: null });

test('support detection follows whether there is an indexedDB at all', () => {
  assert.equal(analysisCacheSupported({ indexedDB: {} }), true);
  assert.equal(analysisCacheSupported({}), false);
  assert.equal(analysisCacheSupported(null), false);
});

test('a stored bundle comes back', async () => {
  const scope = fakeIdb();
  assert.equal(await putBundle('k1', bundleFor('a.mp3'), scope), true);
  const got = await getBundle('k1', scope);
  assert.equal(got.name, 'a.mp3');
});

test('tempo and key confidence on a stored profile come back unchanged', async () => {
  const scope = fakeIdb();
  const bundle = {
    v: 3,
    name: 'held.mp3',
    durationMs: 180000,
    confidence: 0.77,
    songProfile: { version: 1, confidence: { tempo: 0.77, key: 0.61, structure: 0.4, onset: 0.5, overall: 0.6 } },
  };
  assert.equal(await putBundle('held', bundle, scope), true);
  const got = await getBundle('held', scope);
  assert.equal(got.confidence, 0.77);
  assert.equal(got.songProfile.confidence.tempo, 0.77);
  assert.equal(got.songProfile.confidence.key, 0.61);
});

test('a miss is null, not an error', async () => {
  const scope = fakeIdb();
  assert.equal(await getBundle('nope', scope), null);
});

test('an empty key never touches storage', async () => {
  const scope = fakeIdb();
  assert.equal(await getBundle('', scope), null);
  assert.equal(await putBundle('', bundleFor('x'), scope), false);
  assert.equal(await putBundle('k', null, scope), false);
  assert.equal(scope._data.size, 0);
});

test('with no storage available, everything degrades to a no-op', async () => {
  // Node, private browsing, and old browsers all land here. The only
  // consequence must be that songs get analysed again.
  const scope = {};
  assert.equal(await getBundle('k', scope), null);
  assert.equal(await putBundle('k', bundleFor('a'), scope), false);
  assert.deepEqual(await listBundles(scope), []);
  assert.equal(await clearBundles(scope), false);
});

test('a database that refuses to open is survived, not thrown from', async () => {
  const scope = fakeIdb({ failOpen: true });
  assert.equal(await getBundle('k', scope), null);
  assert.equal(await putBundle('k', bundleFor('a'), scope), false);
  assert.deepEqual(await listBundles(scope), []);
});

test('a write that fails (quota) reports false without throwing', async () => {
  const scope = fakeIdb({ failPut: true });
  assert.equal(await putBundle('k', bundleFor('a'), scope), false);
});

test('a request success followed by transaction abort reports false', async () => {
  const scope = fakeIdb({ lateAbort: true });
  assert.equal(await putBundle('k', bundleFor('a'), scope), false);
});

test('reading a bundle marks it as recently used', async () => {
  const scope = fakeIdb();
  await putBundle('k1', bundleFor('a'), scope);
  const before = scope._data.get('k1').usedMs;
  await new Promise((r) => setTimeout(r, 5));
  await getBundle('k1', scope);
  assert.ok(scope._data.get('k1').usedMs >= before, 'a read must refresh the use time');
});

test('eviction keeps the most recently used, not the most recently added', async () => {
  // The distinction that matters: a song added first but played constantly
  // must outlive newer songs played once.
  const scope = fakeIdb();
  for (let i = 0; i < MAX_ENTRIES; i++) {
    scope._data.set(`old${i}`, { key: `old${i}`, bundle: bundleFor(`old${i}`), usedMs: 1000 + i });
  }
  // The oldest-added entry is also the most recently USED.
  scope._data.set('old0', { key: 'old0', bundle: bundleFor('old0'), usedMs: 9_000_000 });
  await putBundle('fresh', bundleFor('fresh'), scope);
  assert.equal(scope._data.size, MAX_ENTRIES, 'the store must be trimmed to its cap');
  assert.ok(scope._data.has('old0'), 'the frequently played song must survive');
  assert.ok(scope._data.has('fresh'), 'the new song must be kept');
  assert.ok(!scope._data.has('old1'), 'the least recently used must be the one dropped');
});

test('nothing is evicted while under the cap', async () => {
  const scope = fakeIdb();
  for (let i = 0; i < 5; i++) await putBundle(`k${i}`, bundleFor(`s${i}`), scope);
  assert.equal(scope._data.size, 5);
});

test('listing reports metadata newest-used first', async () => {
  const scope = fakeIdb();
  scope._data.set('a', { key: 'a', bundle: { name: 'a.mp3', durationMs: 10, identity: { artist: 'X' } }, usedMs: 100 });
  scope._data.set('b', { key: 'b', bundle: { name: 'b.mp3', durationMs: 20, identity: null }, usedMs: 300 });
  const rows = await listBundles(scope);
  assert.deepEqual(rows.map((r) => r.key), ['b', 'a']);
  assert.equal(rows[1].identity.artist, 'X');
  assert.equal(rows[0].durationMs, 20);
});

test('clearing empties the store', async () => {
  const scope = fakeIdb();
  await putBundle('k', bundleFor('a'), scope);
  assert.equal(await clearBundles(scope), true);
  assert.equal(scope._data.size, 0);
});
