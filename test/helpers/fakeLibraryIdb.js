// A small transactional IndexedDB double shared by library tests. Requests
// are asynchronous, conflicting transactions serialize, and aborts discard
// their private writes. Browser smoke tests separately cover native IDB.
export function fakeIdb({ failOpen = false, rejectPut = () => false, lateAbort = false } = {}) {
  const stores = { roots: new Map(), tracks: new Map() };
  const keyPaths = { roots: 'id', tracks: 'key' };
  const copy = row => row ? { ...row } : row;
  const transactions = [];
  let active = null;

  function pump() {
    if (active || !transactions.length) return;
    const tx = active = transactions.shift();
    tx.data = Object.fromEntries(tx.names.map(name => [name, new Map(stores[name])]));
    tx.started = true;
    drain(tx);
  }

  function finish(tx, aborted = false) {
    if (tx.finished) return;
    tx.finished = true;
    if (!aborted && tx.mode === 'readwrite') {
      for (const name of tx.names) stores[name] = tx.data[name];
    }
    if (active === tx) active = null;
    else {
      const index = transactions.indexOf(tx);
      if (index >= 0) transactions.splice(index, 1);
    }
    (aborted ? tx.onabort : tx.oncomplete)?.();
    pump();
  }

  function drain(tx) {
    if (!tx.started || tx.finished || tx.aborting || tx.draining) return;
    tx.draining = true;
    queueMicrotask(() => {
      tx.draining = false;
      if (tx.finished || tx.aborting) return;
      const operation = tx.queue.shift();
      if (!operation) {
        tx.timer = setTimeout(() => {
          if (tx.queue.length) drain(tx);
          else finish(tx, lateAbort && tx.mode === 'readwrite');
        }, 0);
        return;
      }
      const { request, run } = operation;
      try {
        request.result = run();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
        finish(tx, true);
        return;
      }
      drain(tx);
    });
  }

  function request(tx, run) {
    if (tx.finished || tx.aborting) throw new Error('TransactionInactiveError');
    clearTimeout(tx.timer);
    const req = {};
    tx.queue.push({ request: req, run });
    drain(tx);
    return req;
  }

  function makeStore(name, tx) {
    const values = () => [...tx.data[name].values()];
    return {
      get: key => request(tx, () => copy(tx.data[name].get(key))),
      getAll: () => request(tx, () => values().map(copy)),
      put(row) {
        const refusal = rejectPut(row, name);
        // DataCloneError is synchronous and does not itself abort a tx.
        if (refusal === 'throw') throw new Error('DataCloneError');
        return request(tx, () => {
          if (refusal) throw new Error('QuotaExceededError');
          tx.data[name].set(row[keyPaths[name]], copy(row));
        });
      },
      delete: key => request(tx, () => { tx.data[name].delete(key); }),
      clear: () => request(tx, () => { tx.data[name].clear(); }),
      index: field => ({
        getAll: value => request(tx, () => values().filter(row => row[field] === value).map(copy)),
        getAllKeys: value => request(tx, () => values().filter(row => row[field] === value).map(row => row[keyPaths[name]])),
      }),
    };
  }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: () => {} }),
    close: () => {},
    transaction(names, mode = 'readonly') {
      const tx = { names: Array.isArray(names) ? names : [names], mode, queue: [] };
      tx.objectStore = name => makeStore(name, tx);
      tx.abort = () => {
        if (tx.finished) throw new Error('InvalidStateError');
        // Native abort dispatches events asynchronously, including queued tx.
        tx.aborting = true;
        queueMicrotask(() => finish(tx, true));
      };
      transactions.push(tx);
      queueMicrotask(pump);
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
