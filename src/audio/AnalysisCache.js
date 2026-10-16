import { ANALYSIS_REVISION } from './AnalysisRevision.js';
import { fingerprintBuffer } from './SongFingerprint.js';

// Where analysed songs are remembered.
//
// A bundle is a few hundred kilobytes and takes tens of seconds of CPU to
// produce, which makes it exactly the wrong thing to throw away when the tab
// closes. IndexedDB rather than localStorage: localStorage is synchronous
// (so a large write janks the frame it happens on), string-only, and capped
// around 5MB, which is a handful of songs.
//
// This is the local half of what a shared database would do. The lookup path
// -- fingerprint the audio, ask for a bundle, fall back to analysing -- is
// identical whether the answer comes from this store or one day from a
// server, so the seam is already in the right place.
//
// Eviction is least-recently-USED, not least-recently-added: the songs a
// person replays are the ones worth keeping, and insertion order says nothing
// about that.
//
// Bundles may carry a SongProfile snapshot (tempo/key/section confidence).
// This cache does not interpret it: a profile version the current build
// cannot read is dropped at unpack, and the analysis is still valid.
const DB_NAME = 'midio-analysis';
const DB_VERSION = 1;
const STORE = 'bundles';
/** Roughly a hundred songs at typical bundle size. Far under any browser
 *  quota, and past this the hit rate stops improving. */
export const MAX_ENTRIES = 100;

function idbFactory(scope) {
  return scope?.indexedDB || null;
}

/** Is there anywhere to store this? Node, private modes and old browsers all
 *  say no, and every method below degrades to a no-op rather than throwing. */
export function analysisCacheSupported(scope = (typeof globalThis !== 'undefined' ? globalThis : null)) {
  return !!idbFactory(scope);
}

function open(scope) {
  const idb = idbFactory(scope);
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req;
    try { req = idb.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('usedMs', 'usedMs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    // A blocked or failing open is not worth surfacing to a player: the only
    // consequence is that this song gets analysed again.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function wrap(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Did the request succeed? Separate from `wrap` because a write's result is
 *  void: a failed write and a successful one both come back as nothing
 *  through `wrap`, so using it for `put` reported a quota failure as
 *  success and left the caller believing a bundle was stored when it was
 *  not. */
function wrapOk(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

async function writeCommitted(db, operation) {
  const transaction = db.transaction(STORE, 'readwrite');
  const committed = transactionDone(transaction);
  const request = operation(transaction.objectStore(STORE));
  const requestOk = await wrapOk(request);
  return requestOk && await committed;
}

/**
 * Look up a bundle by fingerprint key.
 *
 * Touches `usedMs` on a hit, which is what makes eviction least-recently-used
 * rather than least-recently-stored.
 */
export async function getBundle(key, scope = globalThis) {
  if (!key) return null;
  const db = await open(scope);
  if (!db) return null;
  try {
    const row = await wrap(tx(db, 'readonly').get(key));
    if (!row) return null;
    row.usedMs = Date.now();
    try { tx(db, 'readwrite').put(row); } catch { /* the read still succeeded */ }
    return row.bundle || null;
  } finally {
    db.close();
  }
}

/** Store a bundle, then evict down to MAX_ENTRIES. */
export async function putBundle(key, bundle, scope = globalThis) {
  if (!key || !bundle) return false;
  const db = await open(scope);
  if (!db) return false;
  try {
    const ok = await writeCommitted(db,
      (store) => store.put({ key, bundle, usedMs: Date.now() }));
    if (!ok) return false;
    await evict(db);
    return true;
  } catch {
    // A quota error is the expected failure here and is not worth a banner:
    // the song still plays, it just gets analysed again next time.
    return false;
  } finally {
    db.close();
  }
}

async function evict(db) {
  const rows = await wrap(tx(db, 'readonly').getAll());
  if (!rows || rows.length <= MAX_ENTRIES) return;
  rows.sort((a, b) => (a.usedMs || 0) - (b.usedMs || 0));
  const store = tx(db, 'readwrite');
  for (let i = 0; i < rows.length - MAX_ENTRIES; i++) store.delete(rows[i].key);
}

/** Every stored bundle's metadata, newest use first. For a future "songs this
 *  device knows" view, and for contributing a corpus upward. */
export async function listBundles(scope = globalThis) {
  const db = await open(scope);
  if (!db) return [];
  try {
    const rows = (await wrap(tx(db, 'readonly').getAll())) || [];
    return rows
      .map((r) => ({
        key: r.key,
        usedMs: r.usedMs || 0,
        name: r.bundle?.name || '',
        identity: r.bundle?.identity || null,
        durationMs: r.bundle?.durationMs || 0,
      }))
      .sort((a, b) => b.usedMs - a.usedMs);
  } finally {
    db.close();
  }
}

export async function clearBundles(scope = globalThis) {
  const db = await open(scope);
  if (!db) return false;
  try {
    return await writeCommitted(db, (store) => store.clear());
  } finally {
    db.close();
  }
}

/** Analysis depends on both the recording and the inputs that cast/classify it.
 * Keep the acoustic fingerprint in the bundle; namespace the storage lookup by
 * analysis inputs. Null means the audio lacks a trustworthy fingerprint. */
export function analysisCacheKey(fingerprint, { stems = [], groove = null } = {}) {
  if (!fingerprint?.key) return null;
  const stemKeys = stems.map(({ name, buffer }) => {
    const fp = fingerprintBuffer(buffer);
    return { name, key: fp.key, durationMs: fp.durationMs, signal: fp.signal };
  });
  if (stemKeys.some((stem) => !stem.key)) return null;
  return JSON.stringify([ANALYSIS_REVISION, fingerprint.key, fingerprint.durationMs, fingerprint.signal,
    stemKeys, groove?.toJSON() ?? null]);
}
