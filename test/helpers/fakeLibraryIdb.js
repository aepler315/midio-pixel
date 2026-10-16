// An in-memory IndexedDB, enough for the library store: two keyPath stores,
// one index, multi-store transactions, and the commit event that writes wait
// on. Shared by the LibraryDB and MusicLibrary tests so both exercise the
// same storage behaviour -- including its failure modes.
export function fakeIdb({ failOpen = false, rejectPut = () => false, lateAbort = false } = {}) {
  const stores = { roots: new Map(), tracks: new Map() };
  const keyPaths = { roots: 'id', tracks: 'key' };
  // IDB returns a copy. Keep handles usable in this small fake, but never
  // let edits to an in-memory track silently edit the persisted row too.
  const copy = (row) => row ? { ...row } : row;

  const succeed = (req, value) => queueMicrotask(() => { req.result = value; req.onsuccess?.(); });
  const fail = (req) => queueMicrotask(() => req.onerror?.());

  function makeStore(name, tx) {
    const data = stores[name];
    const api = {
      get: (key) => { const r = {}; succeed(r, copy(data.get(key))); return r; },
      getAll: () => { const r = {}; succeed(r, [...data.values()].map(copy)); return r; },
      put: (row) => {
        const r = {};
        tx.pending++;
        const refusal = rejectPut(row, name);
        // A real IndexedDB refuses an unclonable value by THROWING out of
        // put(), and refuses an over-quota one later via onerror. Both are
        // reachable here, because the module has to survive both.
        if (refusal === 'throw') { tx.failed = true; tx.pending--; throw new Error('DataCloneError'); }
        if (refusal) { tx.failed = true; fail(r); }
        else { data.set(row[keyPaths[name]], copy(row)); succeed(r, undefined); }
        queueMicrotask(() => { tx.pending--; });
        return r;
      },
      delete: (key) => { const r = {}; data.delete(key); succeed(r, undefined); return r; },
      clear: () => { const r = {}; data.clear(); succeed(r, undefined); return r; },
      index: (field) => ({
        getAll: (value) => { const r = {}; succeed(r, [...data.values()].filter((v) => v[field] === value).map(copy)); return r; },
        getAllKeys: (value) => {
          const r = {};
          succeed(r, [...data.values()].filter((v) => v[field] === value).map((v) => v[keyPaths[name]]));
          return r;
        },
      }),
    };
    return api;
  }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: () => {} }),
    close: () => {},
    transaction(names) {
      const tx = { pending: 0, failed: false };
      tx.objectStore = (name) => makeStore(name, tx);
      // Commit once the queued work has drained -- a few macrotask ticks is
      // more than the module's longest chain, and firing immediately would
      // let a caller close the db before its writes landed.
      setTimeout(() => { (lateAbort ? tx.onabort : (tx.failed ? tx.onerror : tx.oncomplete))?.(); }, 0);
      void names;
      return tx;
    },
  };

  return {
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
