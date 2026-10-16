// Where a chosen music folder is remembered.
//
// "Upload without leaving the device" is the File System Access API: the
// picker hands back a FileSystemDirectoryHandle, which is structured-
// cloneable and therefore storable in IndexedDB. Nothing is copied, nothing
// is read until a track is actually played -- the handle is a durable
// permission-bearing reference to a folder the player already has on disk.
// localStorage could not hold one at all (string-only), which settles the
// storage question before size does.
//
// Two stores, because they have different lifetimes: a root outlives any
// particular scan of it, and a rescan replaces every track under a root
// without touching the root itself.
//
// Every method degrades to a no-op rather than throwing. Node, private
// browsing and old browsers all say no to IndexedDB, and a library is an
// enhancement -- dropping a file on the page must keep working when this
// whole module is unavailable.
const DB_NAME = 'midio-library';
const DB_VERSION = 1;
const ROOTS = 'roots';
const TRACKS = 'tracks';

function idbFactory(scope) {
  return scope?.indexedDB || null;
}

/** Is there anywhere to keep a library? */
export function libraryDbSupported(scope = (typeof globalThis !== 'undefined' ? globalThis : null)) {
  return !!idbFactory(scope);
}

/** Can this browser hand back a folder that survives a reload? Chromium can;
 *  Firefox and Safari expose `webkitdirectory` on <input> but no persistable
 *  handle, so the library there is remembered but needs the folder re-picked
 *  before anything can be played from it. That distinction is the caller's
 *  to surface, not to paper over. */
export function directoryHandlesSupported(scope = (typeof globalThis !== 'undefined' ? globalThis : null)) {
  return typeof scope?.showDirectoryPicker === 'function';
}

function open(scope) {
  const idb = idbFactory(scope);
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req;
    try { req = idb.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROOTS)) {
        db.createObjectStore(ROOTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TRACKS)) {
        const store = db.createObjectStore(TRACKS, { keyPath: 'key' });
        // Every read path is either "this root" or "everything", and a
        // rescan deletes by root -- one index covers all three.
        store.createIndex('rootId', 'rootId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function wrap(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Did the write land? A `put`'s result is void, so `wrap` cannot tell a
 *  quota failure from success -- the same trap AnalysisCache documents. */
function wrapOk(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
  });
}

/** Resolve when every write queued on `tx` has been committed. Callers that
 *  close the db as soon as the last `put` resolves can race the commit. */
function done(tx) {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** The stable id for a folder. Two pickers on the same folder should be the
 *  same root rather than two copies of the library, and the name is all the
 *  identity a handle exposes synchronously -- `isSameEntry` is async and
 *  needs both handles in hand, which the caller does not have at list time.
 *  Collisions (two different folders both called "Music") are possible and
 *  cost a merged listing, not data loss; `addRoot` keeps the newer handle. */
export function rootIdFor(name) {
  return `root:${String(name || 'music').toLowerCase()}`;
}

function collisionSafeRootId(base, roots, scope) {
  if (!roots.some((root) => root.id === base)) return base;
  const uuid = scope?.crypto?.randomUUID?.() || globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${base}:${uuid}`;
}

async function sameDirectory(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (typeof a.isSameEntry !== 'function') return false;
  try { return !!await a.isSameEntry(b); } catch { return false; }
}

/** Remember a folder. Returns the stored root record, or null if there is
 *  nowhere to store it. */
async function putRoot(db, record) {
  const tx = db.transaction(ROOTS, 'readwrite');
  const committed = done(tx);
  const request = tx.objectStore(ROOTS).put(record);
  const requestOk = await wrapOk(request);
  return requestOk && await committed;
}

export async function addRoot({ name, handle = null, persistable = true }, scope = globalThis) {
  const db = await open(scope);
  if (!db) return null;
  const roots = (await wrap(db.transaction(ROOTS, 'readonly').objectStore(ROOTS).getAll())) || [];
  let prior = null;
  if (handle) {
    for (const candidate of roots) {
      if (await sameDirectory(handle, candidate.handle)) { prior = candidate; break; }
    }
  }
  const now = Date.now();
  const selectedMs = Math.max(now, ...roots.map((root) => (root.lastSelectedMs || root.addedMs || 0) + 1));
  const baseId = rootIdFor(name);
  const record = {
    id: prior?.id || collisionSafeRootId(baseId, roots, scope),
    name: String(name || 'Music'),
    handle,
    persistable: !!persistable && !!handle,
    addedMs: prior?.addedMs || now,
    lastSelectedMs: selectedMs,
  };
  try {
    // A handle the browser refuses to structured-clone rejects the write.
    // Retry without it: a remembered listing that needs the folder
    // re-picked still beats losing the library.
    //
    // The two failure shapes are NOT the same. A quota error arrives later
    // as `onerror`; a DataCloneError is thrown out of `put()` synchronously,
    // on the line below. Catching only the first left the second escaping
    // to the outer handler, which returned null -- the fallback existed and
    // could never run.
    let stored = false;
    try {
      stored = await putRoot(db, record);
    } catch {
      stored = false;
    }
    if (stored) return record;
    const fallback = { ...record, handle: null, persistable: false };
    return (await putRoot(db, fallback)) ? fallback : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function listRoots(scope = globalThis) {
  const db = await open(scope);
  if (!db) return [];
  try {
    const roots = (await wrap(db.transaction(ROOTS, 'readonly').objectStore(ROOTS).getAll())) || [];
    return roots.sort((a, b) => (b.lastSelectedMs || b.addedMs || 0) - (a.lastSelectedMs || a.addedMs || 0));
  } finally {
    db.close();
  }
}

/** Forget a folder and everything scanned from it. */
export async function removeRoot(rootId, scope = globalThis) {
  const db = await open(scope);
  if (!db) return false;
  try {
    const tx = db.transaction([ROOTS, TRACKS], 'readwrite');
    tx.objectStore(ROOTS).delete(rootId);
    const keys = await wrap(tx.objectStore(TRACKS).index('rootId').getAllKeys(rootId));
    const store = tx.objectStore(TRACKS);
    for (const key of keys || []) store.delete(key);
    return await done(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Write a batch of scanned tracks, merging each with whatever the library
 * already knew about that path.
 *
 * This is what makes a scan streamable: a folder of ten thousand songs is
 * written in batches as it is walked, so a scan interrupted half way
 * through leaves a half-populated library rather than nothing at all.
 */
export async function putTracks(tracks, scope = globalThis) {
  const list = [...(tracks || [])].filter(Boolean);
  if (!list.length) return [];
  // Publish the committed merged rows, including history and earned tags.
  return reduceTracks(list.map(track => ({
    key: track.key,
    reduce: prior => prior ? carryForward(prior, track) : track,
  })), scope);
}

/**
 * Drop every track under `rootId` whose path is not in `keepPaths`.
 *
 * Only ever called once a scan has FINISHED, because only then is the set
 * of paths complete -- pruning against a partial walk would delete most of
 * the library and call it housekeeping.
 */
export async function pruneTracks(rootId, keepPaths, scope = globalThis) {
  const keep = keepPaths instanceof Set ? keepPaths : new Set(keepPaths || []);
  const db = await open(scope);
  if (!db) return 0;
  try {
    const rows = (await wrap(db.transaction(TRACKS, 'readonly').objectStore(TRACKS).index('rootId').getAll(rootId))) || [];
    const stale = rows.filter((row) => !keep.has(row.path));
    if (!stale.length) return 0;
    const tx = db.transaction(TRACKS, 'readwrite');
    const store = tx.objectStore(TRACKS);
    for (const row of stale) store.delete(row.key);
    return (await done(tx)) ? stale.length : 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Replace every track under `rootId` with `tracks`, in one go.
 *
 * Replace rather than merge: a rescan is the answer to "what is in this
 * folder NOW", so a file deleted on disk has to disappear from the library
 * too. What a merge would have preserved -- play counts, auto-tags, cached
 * durations -- is carried forward explicitly by `carryForward` below, so
 * re-scanning a folder never costs the player their history.
 */
export async function replaceTracks(rootId, tracks, scope = globalThis) {
  const list = [...(tracks || [])].filter(Boolean);
  const written = await putTracks(list, scope);
  if (written === null) return 0;
  await pruneTracks(rootId, list.map((t) => t.path), scope);
  return written.length;
}
/** What survives a rescan: everything the player or the network earned,
 *  never anything the filesystem is authoritative about. Exported because
 *  the rule is worth testing on its own -- it is the difference between a
 *  rescan being free and a rescan being destructive. */
export function carryForward(prior, fresh) {
  const merged = {
    ...fresh,
    addedMs: prior.addedMs || fresh.addedMs,
    playCount: prior.playCount || 0,
    lastPlayedMs: prior.lastPlayedMs || 0,
    durationSec: fresh.durationSec ?? prior.durationSec ?? null,
  };
  // A file that changed on disk has been re-tagged by whatever changed it,
  // so the fresh read wins outright. An unchanged file keeps any auto-tag
  // that was fetched for it -- that is the whole point of paying for one.
  const unchanged = prior.size === fresh.size && prior.lastModified === fresh.lastModified;
  if (unchanged && prior.tagSource === 'auto' && fresh.tagSource !== 'tags') {
    merged.title = prior.title;
    merged.artist = prior.artist;
    merged.album = prior.album;
    merged.year = prior.year ?? null;
    merged.tagSource = 'auto';
  }
  return merged;
}

/** Every track in the library, or just one root's. */
export async function listTracks(rootId = null, scope = globalThis) {
  const db = await open(scope);
  if (!db) return [];
  try {
    const store = db.transaction(TRACKS, 'readonly').objectStore(TRACKS);
    return (await wrap(rootId ? store.index('rootId').getAll(rootId) : store.getAll())) || [];
  } finally {
    db.close();
  }
}

/** Merge fields into one track. Used for the things learned after a scan:
 *  a decoded duration, an auto-tag, a play. */
export async function updateTrack(key, patch, scope = globalThis) {
  if (!key || !patch) return false;
  const rows = await reduceTracks([{ key, reduce: row => row ? { ...row, ...patch } : null }], scope);
  return !!rows?.length;
}

/** Write many patches under one transaction. Auto-tagging a folder produces
 *  hundreds of these, and a transaction each would be hundreds of commits.
 *  Returns the number of distinct rows committed; missing keys are skipped. */
export async function updateTracks(patches, scope = globalThis) {
  const list = [...(patches || [])].filter((p) => p && p.key);
  if (!list.length) return 0;
  const rows = await reduceTracks(list.map(patch => ({
    key: patch.key,
    reduce: row => row ? { ...row, ...patch } : null,
  })), scope);
  return rows?.length || 0;
}

/** Increment from the durable row, never a caller's stale play count.
 *  The returned row has committed, so the caller can reconcile its view. */
export async function recordPlay(key, durationSec = null, scope = globalThis) {
  if (!key) return null;
  const playedMs = Date.now();
  const rows = await reduceTracks([{
    key,
    reduce: row => {
      if (!row) return null;
      const next = {
        ...row,
        playCount: (row.playCount || 0) + 1,
        lastPlayedMs: Math.max(row.lastPlayedMs || 0, playedMs),
      };
      if (Number.isFinite(durationSec) && durationSec > 0) next.durationSec = durationSec;
      return next;
    },
  }], scope);
  return rows?.[0] || null;
}

/** One get/reduce/put unit per key, all within one write transaction.
 *  Reducers run synchronously in the request callback: awaiting unrelated
 *  work there lets a browser auto-close the transaction. Duplicate keys
 *  compose in input order and return one final committed row per key. */
async function reduceTracks(operations, scope) {
  const groups = new Map();
  for (const { key, reduce } of operations) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(reduce);
  }
  const db = await open(scope);
  if (!db) return null;
  try {
    const tx = db.transaction(TRACKS, 'readwrite');
    const committed = done(tx);
    const store = tx.objectStore(TRACKS);
    const rows = new Map();
    let failed = false;
    const abort = () => {
      failed = true;
      // A synchronous DataCloneError does not abort by itself. Roll back
      // earlier puts too, instead of closing a connection that will commit.
      try { tx.abort?.(); } catch { /* already finished or aborted */ }
    };
    try {
      for (const [key, reducers] of groups) {
        const request = store.get(key);
        request.onerror = abort;
        request.onsuccess = () => {
          try {
            let row = request.result || null;
            for (const reduce of reducers) row = reduce(row);
            if (!row) return;
            store.put(row);
            rows.set(key, row);
          } catch { abort(); }
        };
      }
    } catch { abort(); }
    return (await committed) && !failed
      ? [...groups.keys()].map(key => rows.get(key)).filter(Boolean) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
