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
// The additive version fence prevents an older release reopening v1 and
// pruning without scan ownership. Existing IDs, rows and stores are retained.
const DB_VERSION = 2;
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
    let settled = false;
    const unavailable = () => { settled = true; resolve(null); };
    req.onsuccess = () => {
      const db = req.result;
      // A blocked request may later succeed after its caller has moved on.
      // It still owns a connection, which must not block future upgrades.
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = unavailable;
    req.onblocked = unavailable;
  });
}

function wrap(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Resolve when every write queued on `tx` has been committed. Callers that
 *  close the db as soon as the last `put` resolves can race the commit. */
function done(tx) {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    // An error event precedes abort; wait for rollback to finish.
    tx.onerror = () => {};
    tx.onabort = () => resolve(false);
  });
}

function abortTransaction(tx) {
  try { tx.abort(); } catch { /* already committed or aborted */ }
}

function abortWithSignal(tx, signal) {
  const abort = () => abortTransaction(tx);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return () => signal?.removeEventListener('abort', abort);
}

/** The legacy base ID is retained when free. Same-name roots receive a
 *  reserved suffix; directory identity is established by isSameEntry. */
export function rootIdFor(name) {
  return `root:${String(name || 'music').toLowerCase()}`;
}

let revisionSequence = 0;
function uniqueRevision(scope) {
  for (const crypto of [scope?.crypto, globalThis.crypto]) {
    try {
      if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
      if (typeof crypto?.getRandomValues === 'function') {
        return [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, '0')).join('');
      }
    } catch { /* an unavailable crypto source can use the next source */ }
  }
  // Last-resort support for older embedded browsers. The per-context counter
  // also prevents collisions when their clocks and random sources repeat.
  return `${Date.now().toString(36)}-${(++revisionSequence).toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function collisionSafeRootId(base, roots, scope) {
  if (!roots.some(root => root.id === base)) return base;
  let id;
  do { id = `${base}:${uniqueRevision(scope)}`; } while (roots.some(root => root.id === id));
  return id;
}

async function sameDirectory(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (typeof a.isSameEntry !== 'function') return false;
  try { return !!await a.isSameEntry(b); } catch { return false; }
}

function sameRootIdentities(before, current) {
  if (before.length !== current.length) return false;
  const identities = new Map(before.map(root => [root.id, root.identityRevision]));
  return current.every(root => identities.has(root.id) && identities.get(root.id) === root.identityRevision);
}

async function readRoots(db) {
  const tx = db.transaction(ROOTS, 'readonly');
  const committed = done(tx);
  const roots = await wrap(tx.objectStore(ROOTS).getAll());
  return await committed ? roots : null;
}

/** Compare directory handles outside a transaction, then reserve against
 *  that exact identity snapshot in a write transaction. A concurrent picker
 *  makes us retry comparison; it can never replace another root by name. */
export async function addRoot({ name, handle = null, persistable = true }, scope = globalThis, { signal } = {}) {
  if (signal?.aborted) return null;
  const db = await open(scope);
  if (!db) return null;
  let withoutHandle = false;
  try {
    for (;;) {
      if (signal?.aborted) return null;
      const snapshot = await readRoots(db);
      if (!snapshot || signal?.aborted) return null;
      let priorId = null;
      if (handle) {
        for (const candidate of snapshot) {
          const same = await sameDirectory(handle, candidate.handle);
          if (signal?.aborted) return null;
          if (same) { priorId = candidate.id; break; }
        }
      }
      const tx = db.transaction(ROOTS, 'readwrite');
      const committed = done(tx);
      const detach = abortWithSignal(tx, signal);
      let record = null;
      let retry = false;
      const abort = () => { try { tx.abort(); } catch { /* already aborted */ } };
      const store = tx.objectStore(ROOTS);
      const request = store.getAll();
      request.onerror = abort;
      request.onsuccess = () => {
        try {
          if (signal?.aborted) { abort(); return; }
          const roots = request.result;
          if (!sameRootIdentities(snapshot, roots)) { retry = true; return; }
          const prior = roots.find(root => root.id === priorId);
          const now = Date.now();
          record = {
            ...prior,
            id: prior?.id || collisionSafeRootId(rootIdFor(name), roots, scope),
            name: String(name || 'Music'),
            handle: withoutHandle ? null : handle,
            persistable: !withoutHandle && !!persistable && !!handle,
            addedMs: prior?.addedMs ?? now,
            lastSelectedMs: Math.max(now, ...roots.map(root => (root.lastSelectedMs || root.addedMs || 0) + 1)),
            identityRevision: uniqueRevision(scope),
          };
          store.put(record);
        } catch { abort(); }
      };
      const stored = await committed;
      detach();
      if (signal?.aborted) return null;
      if (stored) {
        if (retry) continue;
        return record;
      }
      // Both synchronous clone failures and asynchronous quota failures
      // roll back first, then reserve the fallback under a fresh snapshot.
      if (withoutHandle) return null;
      withoutHandle = true;
    }
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
    const committed = done(tx);
    tx.objectStore(ROOTS).delete(rootId);
    const keys = await wrap(tx.objectStore(TRACKS).index('rootId').getAllKeys(rootId));
    const store = tx.objectStore(TRACKS);
    for (const key of keys || []) store.delete(key);
    return await committed;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Start durable scan ownership. A unique revision also prevents an old
 *  token matching a removed root whose legacy ID was later reused. */
export async function beginRootScan(rootId, scope = globalThis, { signal, expectedRoot } = {}) {
  return scanTransaction(rootId, null, scope, signal, (root, store) => {
    // A caller may have waited before claiming its first scan token. The
    // same legacy ID can now refer to a replacement/reselected root.
    // Undefined identities still match an unchanged legacy record.
    if (expectedRoot && root.identityRevision !== expectedRoot.identityRevision) return { status: 'stale' };
    const token = { rootId, revision: uniqueRevision(scope) };
    store.put({ ...root, scanRevision: token.revision });
    return { status: 'committed', token };
  });
}

/** Commit a batch only while its root and revision still own the scan.
 *  Ownership, existing metadata and writes share the same transaction. */
export async function putScanTracks(token, tracks, scope = globalThis, { signal } = {}) {
  const list = [...(tracks || [])].filter(Boolean);
  if (!token?.rootId || !token.revision || list.some(track => track.rootId !== token.rootId)) {
    return { status: 'stale' };
  }
  return scanTransaction(token.rootId, token, scope, signal, (_root, _roots, store, guard) => {
    const groups = new Map();
    for (const track of list) {
      if (!groups.has(track.key)) groups.set(track.key, []);
      groups.get(track.key).push(track);
    }
    const rows = new Map();
    for (const [key, fresh] of groups) {
      const request = store.get(key);
      request.onerror = guard.abort;
      request.onsuccess = () => {
        if (!guard.current()) return;
        try {
          let row = request.result || null;
          // A malformed key must never replace a different root's row.
          if (row && row.rootId !== token.rootId) { guard.stale(); return; }
          for (const track of fresh) row = row ? carryForward(row, track) : track;
          store.put(row);
          rows.set(key, row);
        } catch { guard.abort(); }
      };
    }
    return { status: 'committed', get tracks() { return [...groups.keys()].map(key => rows.get(key)).filter(Boolean); } };
  });
}

/** Only a completed traversal may call this. The revision and the rows to
 *  delete are read under the same write lock as the deletions themselves. */
export async function pruneScanTracks(token, keepPaths, scope = globalThis, { signal } = {}) {
  if (!token?.rootId || !token.revision) return { status: 'stale' };
  const keep = keepPaths instanceof Set ? keepPaths : new Set(keepPaths || []);
  return scanTransaction(token.rootId, token, scope, signal, (_root, _roots, store, guard) => {
    let count = 0;
    const request = store.index('rootId').getAll(token.rootId);
    request.onerror = guard.abort;
    request.onsuccess = () => {
      if (!guard.current()) return;
      try {
        for (const row of request.result || []) {
          if (!keep.has(row.path)) { store.delete(row.key); count++; }
        }
      } catch { guard.abort(); }
    };
    return { status: 'committed', get count() { return count; } };
  });
}

async function scanTransaction(rootId, token, scope, signal, mutate) {
  if (signal?.aborted) return { status: 'stale' };
  const db = await open(scope);
  if (!db) return { status: 'unavailable' };
  try {
    if (signal?.aborted) return { status: 'stale' };
    const tx = db.transaction([ROOTS, TRACKS], 'readwrite');
    const committed = done(tx);
    const detach = abortWithSignal(tx, signal);
    let result = { status: 'unavailable' };
    let failed = false;
    let stale = false;
    const guard = {
      abort() { failed = true; abortTransaction(tx); },
      stale() { stale = true; abortTransaction(tx); },
      current() {
        if (signal?.aborted) { guard.stale(); return false; }
        return !failed && !stale;
      },
    };
    try {
      const roots = tx.objectStore(ROOTS);
      const tracks = tx.objectStore(TRACKS);
      const request = roots.get(rootId);
      request.onerror = guard.abort;
      request.onsuccess = () => {
        if (!guard.current()) return;
        const root = request.result;
        if (!root) { result = { status: token ? 'stale' : 'missing' }; return; }
        if (token && root.scanRevision !== token.revision) { result = { status: 'stale' }; return; }
        try { result = mutate(root, roots, tracks, guard); } catch { guard.abort(); }
      };
    } catch { guard.abort(); }
    const stored = await committed;
    detach();
    if (signal?.aborted || stale) return { status: 'stale' };
    // Materialize batch/prune getters only after their queued requests and
    // commit completed, never after a put request's provisional success.
    return stored && !failed ? { ...result } : { status: 'unavailable' };
  } catch {
    return { status: signal?.aborted ? 'stale' : 'unavailable' };
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
    // Read and delete in one transaction. Splitting these lets a newer
    // writer replace a row between our snapshot and its deletion.
    const tx = db.transaction(TRACKS, 'readwrite');
    const committed = done(tx);
    const store = tx.objectStore(TRACKS);
    let count = 0;
    const request = store.index('rootId').getAll(rootId);
    request.onsuccess = () => {
      for (const row of request.result || []) {
        if (!keep.has(row.path)) { store.delete(row.key); count++; }
      }
    };
    return await committed ? count : 0;
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
    ...prior,
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
