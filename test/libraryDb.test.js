// The library store's job is to make a folder choice survive a reload, and
// to make re-scanning that folder free. The second is the one with teeth:
// a rescan replaces every track under a root, so everything the player
// earned -- plays, auto-tags, cached durations -- has to be carried across
// deliberately or it is silently destroyed every time the folder is opened.
//
// Tested against an in-memory IndexedDB. The module takes its `scope` as an
// argument for exactly this reason, the same way AnalysisCache does.
import { test } from 'node:test';
import * as DB from '../src/library/LibraryDB.js';
import assert from 'node:assert/strict';
import {
  libraryDbSupported, directoryHandlesSupported, rootIdFor, addRoot, listRoots, removeRoot,
  replaceTracks, listTracks, updateTrack, updateTracks, carryForward,
  putTracks, pruneTracks,
} from '../src/library/LibraryDB.js';
import { fakeIdb } from './helpers/fakeLibraryIdb.js';

function track(over = {}) {
  const rootId = over.rootId || 'r';
  const path = over.path || 'a.mp3';
  return {
    rootId, path, folder: '', name: 'a.mp3',
    ext: 'mp3', size: 100, lastModified: 5, addedMs: 1, title: null, artist: null, album: null,
    year: null, tagSource: 'filename', durationSec: null, playCount: 0, lastPlayedMs: 0,
    ...over,
    key: `${rootId}\u0000${path}`,
  };
}

test('no storage means no library, and no throwing either', async () => {
  const none = {};
  assert.equal(libraryDbSupported(none), false);
  assert.equal(libraryDbSupported(null), false);
  assert.equal(await addRoot({ name: 'Music' }, none), null);
  assert.deepEqual(await listRoots(none), []);
  assert.deepEqual(await listTracks(null, none), []);
  assert.equal(await replaceTracks('r', [track()], none), 0);
  assert.equal(await updateTrack('k', { playCount: 1 }, none), false);
  assert.equal(await removeRoot('r', none), false);
});

test('a failing open is the same as no storage', async () => {
  const scope = fakeIdb({ failOpen: true });
  assert.equal(await addRoot({ name: 'Music' }, scope), null);
  assert.deepEqual(await listTracks(null, scope), []);
});

test('a failed replacement never prunes the previously stored library', async () => {
  const scope = fakeIdb({ rejectPut: (row, store) => store === 'tracks' && row.path === 'b.mp3' });
  await replaceTracks('r', [track({ path: 'a.mp3' })], scope);
  assert.equal(await replaceTracks('r', [track({ path: 'b.mp3' })], scope), 0);
  assert.deepEqual((await listTracks('r', scope)).map((row) => row.path), ['a.mp3']);
});

test('only a browser that can hand back a persistable folder claims to', () => {
  assert.equal(directoryHandlesSupported({ showDirectoryPicker: () => {} }), true);
  // Firefox and Safari have webkitdirectory but no handle to store, and
  // the library must say so rather than promise a folder it cannot reopen.
  assert.equal(directoryHandlesSupported({}), false);
  assert.equal(directoryHandlesSupported(null), false);
});

function directoryHandle(name, identity, { comparisonFails = false } = {}) {
  return {
    name,
    identity,
    async isSameEntry(other) {
      if (comparisonFails) throw new Error('comparison unavailable');
      return other?.identity === identity;
    },
  };
}

test('the same folder chosen twice is one library, not two', async () => {
  const scope = fakeIdb();
  assert.equal(rootIdFor('Music'), rootIdFor('music'));
  const firstHandle = directoryHandle('Music', 'same');
  const refreshedHandle = directoryHandle('Music', 'same');
  const first = await addRoot({ name: 'Music', handle: firstHandle }, scope);
  const refreshed = await addRoot({ name: 'Music', handle: refreshedHandle }, scope);
  const roots = await listRoots(scope);
  assert.equal(roots.length, 1);
  assert.equal(refreshed.id, first.id);
  // The newer handle wins: it is the one the player just granted.
  assert.equal(roots[0].handle.identity, 'same');
  assert.equal(roots[0].persistable, true);
});

test('two unrelated folders with the same display name remain distinct', async () => {
  const scope = fakeIdb();
  const first = await addRoot({ name: 'Music', handle: directoryHandle('Music', 'one') }, scope);
  const second = await addRoot({ name: 'Music', handle: directoryHandle('Music', 'two') }, scope);
  assert.notEqual(first.id, second.id);
  assert.equal((await listRoots(scope)).length, 2);
});

test('a failed handle comparison never guesses identity from the name', async () => {
  const scope = fakeIdb();
  const first = await addRoot({ name: 'Music', handle: directoryHandle('Music', 'one') }, scope);
  const second = await addRoot({
    name: 'Music', handle: directoryHandle('Music', 'one', { comparisonFails: true }),
  }, scope);
  assert.notEqual(first.id, second.id);
  assert.equal((await listRoots(scope)).length, 2);
});

test('roots are restored in most-recently-selected order', async () => {
  const scope = fakeIdb();
  const a = directoryHandle('A', 'a');
  const b = directoryHandle('B', 'b');
  await addRoot({ name: 'A', handle: a }, scope);
  await addRoot({ name: 'B', handle: b }, scope);
  assert.equal((await listRoots(scope))[0].name, 'B');
  await addRoot({ name: 'A', handle: a }, scope);
  assert.equal((await listRoots(scope))[0].name, 'A');
});

test('a handle the browser refuses to store still leaves a remembered library', async () => {
  // A listing that needs the folder re-picked beats having no library at
  // all -- and the refusal arrives in two different shapes. A quota error
  // comes back later as an error event; an unclonable handle is thrown
  // straight out of put(). Both have to reach the same fallback.
  for (const refusal of [true, 'throw']) {
    const scope = fakeIdb({ rejectPut: (row, name) => (name === 'roots' && row.handle ? refusal : false) });
    const root = await addRoot({ name: 'Music', handle: { weird: true } }, scope);
    assert.ok(root, `refusal: ${refusal}`);
    assert.equal(root.handle, null);
    assert.equal(root.persistable, false);
    assert.equal((await listRoots(scope)).length, 1);
  }
});

test('a root request success followed by transaction abort reports failure', async () => {
  const scope = fakeIdb({ lateAbort: true });
  assert.equal(await addRoot({ name: 'Music', handle: { h: 1 } }, scope), null);
});

test('a rescan drops files that are gone from disk', async () => {
  const scope = fakeIdb();
  await replaceTracks('r', [track({ path: 'a.mp3' }), track({ path: 'b.mp3' })], scope);
  assert.equal((await listTracks('r', scope)).length, 2);
  await replaceTracks('r', [track({ path: 'a.mp3' })], scope);
  assert.deepEqual((await listTracks('r', scope)).map((t) => t.path), ['a.mp3']);
});

test('a rescan keeps what the player earned and what the network paid for', async () => {
  const scope = fakeIdb();
  await replaceTracks('r', [track({ path: 'a.mp3' })], scope);
  await updateTrack('r\u0000a.mp3', {
    playCount: 7, lastPlayedMs: 500, durationSec: 210,
    title: 'Real Title', artist: 'Real Artist', tagSource: 'auto',
  }, scope);

  // The scanner knows nothing about any of that -- it re-reads the file and
  // offers a filename guess, as it did the first time.
  await replaceTracks('r', [track({ path: 'a.mp3', title: null, tagSource: 'filename' })], scope);
  const [row] = await listTracks('r', scope);
  assert.equal(row.playCount, 7);
  assert.equal(row.lastPlayedMs, 500);
  assert.equal(row.durationSec, 210);
  assert.equal(row.title, 'Real Title');
  assert.equal(row.tagSource, 'auto');
  assert.equal(row.addedMs, 1);
});

test('a file that changed on disk is re-tagged, not remembered', () => {
  const prior = { size: 100, lastModified: 5, tagSource: 'auto', title: 'Old Auto', artist: 'Old', album: 'Old', playCount: 3, addedMs: 9, durationSec: 100 };
  // Whatever edited the file also edited its tags, so the fresh read wins.
  const edited = carryForward(prior, { size: 120, lastModified: 9, tagSource: 'filename', title: 'New', artist: null, album: null, durationSec: null });
  assert.equal(edited.title, 'New');
  assert.equal(edited.tagSource, 'filename');
  // The play history is the player's, not the file's, and survives either way.
  assert.equal(edited.playCount, 3);
  assert.equal(edited.addedMs, 9);
  assert.equal(edited.durationSec, 100);

  // A real embedded tag always beats a remembered auto-tag.
  const retagged = carryForward(prior, { size: 100, lastModified: 5, tagSource: 'tags', title: 'Proper', artist: 'Proper', album: 'Proper' });
  assert.equal(retagged.title, 'Proper');
  assert.equal(retagged.tagSource, 'tags');
});

test('forgetting a folder forgets its tracks and only its tracks', async () => {
  const scope = fakeIdb();
  await addRoot({ name: 'A', handle: {} }, scope);
  await addRoot({ name: 'B', handle: {} }, scope);
  await replaceTracks(rootIdFor('A'), [track({ rootId: rootIdFor('A'), path: 'a.mp3' })], scope);
  await replaceTracks(rootIdFor('B'), [track({ rootId: rootIdFor('B'), path: 'b.mp3' })], scope);

  assert.equal(await removeRoot(rootIdFor('A'), scope), true);
  assert.deepEqual((await listRoots(scope)).map((r) => r.name), ['B']);
  assert.deepEqual((await listTracks(null, scope)).map((t) => t.path), ['b.mp3']);
});

test('a batch of patches merges into the rows it names and skips the rest', async () => {
  const scope = fakeIdb();
  await replaceTracks('r', [track({ path: 'a.mp3' }), track({ path: 'b.mp3' })], scope);
  const n = await updateTracks([
    { key: 'r\u0000a.mp3', artist: 'Tagged', tagSource: 'auto' },
    { key: 'r\u0000missing.mp3', artist: 'Nobody' },
  ], scope);
  assert.equal(n, 1);
  const rows = await listTracks('r', scope);
  assert.equal(rows.find((t) => t.path === 'a.mp3').artist, 'Tagged');
  // A patch must merge, not replace: nothing else about the row moved.
  assert.equal(rows.find((t) => t.path === 'a.mp3').path, 'a.mp3');
  assert.equal(rows.find((t) => t.path === 'b.mp3').artist, null);
  assert.equal(await updateTracks([], scope), 0);
  assert.equal(await updateTrack('r\u0000missing.mp3', { artist: 'x' }, scope), false);
});

test('a batch written mid-scan merges with what the library already knew', async () => {
  const scope = fakeIdb();
  await replaceTracks('r', [track({ path: 'a.mp3' })], scope);
  await updateTrack('r\u0000a.mp3', { playCount: 4, tagSource: 'auto', title: 'Fetched' }, scope);

  // The scanner knows none of that and offers a plain filename guess, the
  // same as on a first scan.
  // Returns the MERGED rows, which is what a streaming caller must publish
  // -- a raw scan record carries playCount 0 and would overwrite history.
  const merged = await putTracks([track({ path: 'a.mp3', title: null, tagSource: 'filename' })], scope);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].playCount, 4);
  assert.equal(merged[0].title, 'Fetched');
  const [row] = await listTracks('r', scope);
  assert.equal(row.playCount, 4);
  assert.equal(row.title, 'Fetched');
  assert.deepEqual(await putTracks([], scope), []);
  assert.deepEqual(await putTracks(null, scope), []);
  // Null, not an empty array: "nowhere to store this" and "nothing to
  // store" are different answers, and a streaming scan has to be able to
  // tell them apart before it prunes.
  assert.equal(await putTracks([track()], {}), null);
});

test('pruning removes only what a completed scan did not find, and only in its root', async () => {
  const scope = fakeIdb();
  await putTracks([
    track({ rootId: 'A', path: 'keep.mp3' }),
    track({ rootId: 'A', path: 'gone.mp3' }),
    track({ rootId: 'B', path: 'other.mp3' }),
  ], scope);

  assert.equal(await pruneTracks('A', ['keep.mp3'], scope), 1);
  assert.deepEqual((await listTracks('A', scope)).map((t) => t.path), ['keep.mp3']);
  // A different root's tracks are none of this scan's business.
  assert.deepEqual((await listTracks('B', scope)).map((t) => t.path), ['other.mp3']);
  // Nothing stale is a no-op, and a Set is accepted as readily as an array.
  assert.equal(await pruneTracks('A', new Set(['keep.mp3']), scope), 0);
});

test('a half-finished scan leaves a half-populated library, not an empty one', async () => {
  // The point of writing batches as they are found: a walk abandoned part
  // way is still worth something on the next visit.
  const scope = fakeIdb();
  await putTracks([track({ path: '1.mp3' }), track({ path: '2.mp3' })], scope);
  // No prune, because the walk never finished and the path set is partial.
  assert.equal((await listTracks('r', scope)).length, 2);
});

test('duplicate-key patches compose in input order and count one committed row', async () => {
  const scope = fakeIdb();
  await putTracks([track()], scope);
  const n = await updateTracks([
    { key: 'r\u0000a.mp3', title: 'First title' },
    { key: 'r\u0000a.mp3', artist: 'Fetched artist' },
    { key: 'r\u0000a.mp3', title: 'Last title' },
  ], scope);
  assert.equal(n, 1);
  const [row] = await listTracks('r', scope);
  assert.equal(row.title, 'Last title');
  assert.equal(row.artist, 'Fetched artist');
});

test('duplicate scan records carry earlier earned fields into the final committed row', async () => {
  const scope = fakeIdb();
  const rows = await putTracks([
    track({ title: 'Fetched title', tagSource: 'auto', playCount: 4, durationSec: 125 }),
    track({ title: 'Filename guess', addedMs: 50 }),
  ], scope);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Fetched title');
  assert.equal(rows[0].playCount, 4);
  assert.equal(rows[0].durationSec, 125);
  assert.deepEqual(await listTracks('r', scope), rows);
});


test('concurrent same-name directory selections reserve distinct durable roots', async () => {
  const scope = fakeIdb();
  const [one, two] = await Promise.all([
    addRoot({ name: 'Music', handle: directoryHandle('Music', 'one') }, scope),
    addRoot({ name: 'Music', handle: directoryHandle('Music', 'two') }, scope),
  ]);
  assert.notEqual(one.id, two.id);
  assert.equal((await listRoots(scope)).length, 2);
});

test('concurrent selections of the same physical directory converge on one root', async () => {
  const scope = fakeIdb();
  const roots = await Promise.all(Array.from({ length: 3 }, () =>
    addRoot({ name: 'Music', handle: directoryHandle('Music', 'same') }, scope)));
  assert.equal(new Set(roots.map(root => root.id)).size, 1);
  assert.equal((await listRoots(scope)).length, 1);
});

test('concurrent file-list selections with the same name remain separate roots', async () => {
  const scope = fakeIdb();
  const roots = await Promise.all(Array.from({ length: 3 }, () =>
    addRoot({ name: 'Music', persistable: false }, scope)));
  assert.equal(new Set(roots.map(root => root.id)).size, 3);
  assert.equal((await listRoots(scope)).length, 3);
});

test('scan revisions reject a superseded batch and prune without changing newer rows', async () => {
  const scope = fakeIdb();
  const root = await addRoot({ name: 'Music' }, scope);
  assert.equal(typeof DB.beginRootScan, 'function');
  const first = await DB.beginRootScan(root.id, scope);
  assert.equal(first.status, 'committed');
  await DB.putScanTracks(first.token, [track({ rootId: root.id, path: 'old.mp3' })], scope);
  const next = await DB.beginRootScan(root.id, scope);
  assert.notEqual(next.token.revision, first.token.revision);
  await DB.putScanTracks(next.token, [track({ rootId: root.id, path: 'new.mp3' })], scope);
  assert.deepEqual(await DB.putScanTracks(first.token, [track({ rootId: root.id, path: 'late.mp3' })], scope), { status: 'stale' });
  assert.deepEqual(await DB.pruneScanTracks(first.token, ['old.mp3'], scope), { status: 'stale' });
  assert.deepEqual((await listTracks(root.id, scope)).map(row => row.path).sort(), ['new.mp3', 'old.mp3']);
  assert.deepEqual(await DB.pruneScanTracks(next.token, ['new.mp3'], scope), { status: 'committed', count: 1 });
});

test('an aborted scan transaction rolls back its batch and reports stale ownership', async () => {
  const controller = new AbortController();
  const scope = fakeIdb({ rejectPut: (row, name) => {
    if (name === 'tracks' && row.path === 'cancel.mp3') controller.abort();
    return false;
  } });
  const root = await addRoot({ name: 'Music' }, scope);
  assert.equal(typeof DB.beginRootScan, 'function');
  const begun = await DB.beginRootScan(root.id, scope);
  const result = await DB.putScanTracks(begun.token, [
    track({ rootId: root.id, path: 'first.mp3' }), track({ rootId: root.id, path: 'cancel.mp3' }),
  ], scope, { signal: controller.signal });
  assert.deepEqual(result, { status: 'stale' });
  assert.deepEqual(await listTracks(root.id, scope), []);
});

test('a removed and re-added root never accepts its old scan token', async () => {
  const scope = fakeIdb();
  const root = await addRoot({ name: 'Music' }, scope);
  assert.equal(typeof DB.beginRootScan, 'function');
  const old = await DB.beginRootScan(root.id, scope);
  await removeRoot(root.id, scope);
  assert.deepEqual(await DB.putScanTracks(old.token, [track({ rootId: root.id })], scope), { status: 'stale' });
  const replacement = await addRoot({ name: 'Music' }, scope);
  assert.equal(replacement.id, root.id);
  const current = await DB.beginRootScan(replacement.id, scope);
  assert.notEqual(current.token.revision, old.token.revision);
  assert.deepEqual(await DB.pruneScanTracks(old.token, [], scope), { status: 'stale' });
  assert.deepEqual(await listTracks(root.id, scope), []);
});

test('guarded scans distinguish missing roots, unavailable storage and committed empty batches', async () => {
  assert.equal(typeof DB.beginRootScan, 'function');
  assert.deepEqual(await DB.beginRootScan('missing', fakeIdb()), { status: 'missing' });
  assert.deepEqual(await DB.beginRootScan('r', {}), { status: 'unavailable' });
  const scope = fakeIdb();
  const root = await addRoot({ name: 'Music' }, scope);
  const { token } = await DB.beginRootScan(root.id, scope);
  assert.deepEqual(await DB.putScanTracks(token, [], scope), { status: 'committed', tracks: [] });
  assert.deepEqual(await DB.putScanTracks(token, [track({ rootId: 'other' })], scope), { status: 'stale' });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await DB.beginRootScan(root.id, scope, { signal: controller.signal }), { status: 'stale' });
  assert.deepEqual(await DB.pruneScanTracks(token, [], scope, { signal: controller.signal }), { status: 'stale' });
});

test('a failed guarded batch rolls back all rows and never reports committed', async () => {
  const scope = fakeIdb({ rejectPut: (row, name) => name === 'tracks' && row.path === 'bad.mp3' });
  const root = await addRoot({ name: 'Music' }, scope);
  assert.equal(typeof DB.beginRootScan, 'function');
  const { token } = await DB.beginRootScan(root.id, scope);
  assert.deepEqual(await DB.putScanTracks(token, [track({ rootId: root.id }), track({ rootId: root.id, path: 'bad.mp3' })], scope), { status: 'unavailable' });
  assert.deepEqual(await listTracks(root.id, scope), []);
});

test('a rescan preserves unknown earned fields while refreshing filesystem fields', () => {
  const merged = carryForward(track({ customRating: 5, folder: 'old', name: 'old.mp3' }), track({ folder: 'new', name: 'new.mp3' }));
  assert.equal(merged.customRating, 5);
  assert.equal(merged.folder, 'new');
  assert.equal(merged.name, 'new.mp3');
});

test('a canceled root selection cannot persist after an awaited identity comparison', async () => {
  const scope = fakeIdb();
  await addRoot({ name: 'Music', handle: directoryHandle('Music', 'original') }, scope);
  const controller = new AbortController();
  const handle = { async isSameEntry() { controller.abort(); return false; } };
  assert.equal(await addRoot({ name: 'Other', handle }, scope, { signal: controller.signal }), null);
  assert.deepEqual((await listRoots(scope)).map(root => root.name), ['Music']);
});

test('reselecting a directory preserves its current scan revision and unknown root fields', async () => {
  const scope = fakeIdb();
  const handle = directoryHandle('Music', 'same');
  const root = await addRoot({ name: 'Music', handle }, scope);
  const { token } = await DB.beginRootScan(root.id, scope);
  const request = scope.indexedDB.open('midio-library', 2);
  const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
  const tx = db.transaction('roots', 'readwrite');
  const finished = new Promise(resolve => { tx.oncomplete = resolve; });
  const get = tx.objectStore('roots').get(root.id);
  get.onsuccess = () => tx.objectStore('roots').put({ ...get.result, customColor: 'violet' });
  await finished;
  db.close();
  const refreshed = await addRoot({ name: 'Music', handle }, scope);
  assert.equal(refreshed.id, root.id);
  assert.equal(refreshed.scanRevision, token.revision);
  assert.equal(refreshed.customColor, 'violet');
  assert.equal((await DB.putScanTracks(token, [track({ rootId: root.id })], scope)).status, 'committed');
});

test('a guarded batch returns the committed metadata merge and composes duplicate keys', async () => {
  const scope = fakeIdb();
  const root = await addRoot({ name: 'Music' }, scope);
  await putTracks([track({ rootId: root.id, customRating: 5 })], scope);
  await updateTracks([{ key: `${root.id}\u0000a.mp3`, playCount: 7, title: 'Paid for', tagSource: 'auto' }], scope);
  const { token } = await DB.beginRootScan(root.id, scope);
  const result = await DB.putScanTracks(token, [track({ rootId: root.id }), track({ rootId: root.id, folder: 'new' })], scope);
  assert.equal(result.status, 'committed');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].playCount, 7);
  assert.equal(result.tracks[0].title, 'Paid for');
  assert.equal(result.tracks[0].customRating, 5);
  assert.equal(result.tracks[0].folder, 'new');
  assert.deepEqual(result.tracks, await listTracks(root.id, scope));
});

test('a prune cannot delete a row refreshed by a concurrent writer after its snapshot', async () => {
  const scope = fakeIdb();
  await putTracks([track({ path: 'old.mp3' })], scope);
  const open = scope.indexedDB.open;
  let armed = true;
  scope.indexedDB.open = (...args) => {
    const request = open(...args);
    const outward = {};
    request.onerror = () => outward.onerror?.();
    request.onsuccess = () => {
      const db = request.result;
      outward.result = new Proxy(db, {
        get(target, property) {
          if (property !== 'transaction') return target[property];
          return (names, mode) => {
            const tx = target.transaction(names, mode);
            if (!armed || names !== 'tracks') return tx;
            const objectStore = tx.objectStore;
            tx.objectStore = name => {
              const store = objectStore(name);
              const index = store.index;
              store.index = field => {
                const api = index(field);
                const getAll = api.getAll;
                api.getAll = value => {
                  const rows = getAll(value);
                  let handler;
                  Object.defineProperty(rows, 'onsuccess', {
                    set(fn) { handler = fn; },
                    get() { return () => {
                      if (armed) {
                        armed = false;
                        const newer = target.transaction('tracks', 'readwrite');
                        // Refresh the same key into the path this prune keeps.
                        newer.objectStore('tracks').put({ ...track({ path: 'kept.mp3' }), key: 'r\u0000old.mp3' });
                      }
                      handler?.();
                    }; },
                  });
                  return rows;
                };
                return api;
              };
              return store;
            };
            return tx;
          };
        },
      });
      outward.onsuccess?.();
    };
    return outward;
  };
  await pruneTracks('r', ['kept.mp3'], scope);
  const rows = await listTracks('r', scope);
  assert.ok(rows.some(row => row.key === 'r\u0000old.mp3' && row.path === 'kept.mp3'));
});

test('a scan waiting to begin rejects a replaced root identity', async () => {
  const scope = fakeIdb();
  const old = await addRoot({ name: 'Music' }, scope);
  await removeRoot(old.id, scope);
  const replacement = await addRoot({ name: 'Music' }, scope);
  assert.equal(replacement.id, old.id);
  assert.deepEqual(await DB.beginRootScan(old.id, scope, { expectedRoot: old }), { status: 'stale' });
  assert.equal((await DB.beginRootScan(replacement.id, scope, { expectedRoot: replacement })).status, 'committed');
});

test('an unchanged legacy root can begin a guarded scan without identity migration', async () => {
  const scope = fakeIdb();
  const legacy = { id: 'root:legacy', name: 'Legacy', addedMs: 1, customColor: 'green' };
  const request = scope.indexedDB.open('midio-library', 2);
  const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
  const tx = db.transaction('roots', 'readwrite');
  const finished = new Promise(resolve => { tx.oncomplete = resolve; });
  tx.objectStore('roots').put(legacy);
  await finished;
  db.close();
  const begun = await DB.beginRootScan(legacy.id, scope, { expectedRoot: legacy });
  assert.equal(begun.status, 'committed');
  const [stored] = await listRoots(scope);
  assert.equal(stored.id, 'root:legacy');
  assert.equal(stored.identityRevision, undefined);
  assert.equal(stored.customColor, 'green');
});
