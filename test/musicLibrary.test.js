// The sequencing layer: choose a folder, scan it, get back from a stored
// path to a playable file, and learn things (a duration, a tag) after the
// fact. The behaviours worth pinning are the ones that span two modules --
// what survives a reload, what survives a rescan, and what a browser that
// cannot keep a folder handle is honestly told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicLibrary } from '../src/library/MusicLibrary.js';
import { addRoot, listRoots, listTracks, updateTrack } from '../src/library/LibraryDB.js';
import { displayTitle } from '../src/library/TrackIndex.js';
import { fakeIdb } from './helpers/fakeLibraryIdb.js';

function fakeFile(name, { lastModified = 1 } = {}) {
  const bytes = new Uint8Array(64);
  return {
    name,
    size: bytes.length,
    lastModified,
    slice: () => ({ arrayBuffer: async () => bytes.slice().buffer }),
  };
}

/** A directory handle over a flat `{ 'a/b.mp3': File }` map. */
function fakeDirHandle(name, files, { permission = 'granted' } = {}) {
  function nodeFor(prefix) {
    const entries = new Map();
    for (const [path, file] of Object.entries(files)) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const head = rest.split('/')[0];
      if (!head) continue;
      const childPath = prefix ? `${prefix}/${head}` : head;
      if (rest.includes('/')) entries.set(head, { kind: 'directory', name: head, childPath });
      else entries.set(head, { kind: 'file', name: head, file });
    }
    return {
      kind: 'directory',
      name: prefix ? prefix.split('/').pop() : name,
      queryPermission: async () => permission,
      requestPermission: async () => 'granted',
      values() {
        return (async function* () {
          for (const entry of entries.values()) {
            if (entry.kind === 'directory') yield nodeFor(entry.childPath);
            else yield { kind: 'file', name: entry.name, getFile: async () => entry.file };
          }
        })();
      },
      async getDirectoryHandle(child) {
        const entry = entries.get(child);
        if (!entry || entry.kind !== 'directory') throw new Error('NotFoundError');
        return nodeFor(entry.childPath);
      },
      async getFileHandle(child) {
        const entry = entries.get(child);
        if (!entry || entry.kind !== 'file') throw new Error('NotFoundError');
        return { getFile: async () => entry.file };
      },
    };
  }
  return nodeFor('');
}

function scopeWith(handle, { permission = 'granted' } = {}) {
  const scope = fakeIdb();
  scope.showDirectoryPicker = async () => handle;
  void permission;
  return scope;
}

test('choosing a folder scans it and remembers it for next time', async () => {
  const handle = fakeDirHandle('Music', {
    'Radiohead/Kid A/1.flac': fakeFile('1.flac'),
    'loose.mp3': fakeFile('loose.mp3'),
    'cover.jpg': fakeFile('cover.jpg'),
  });
  const scope = scopeWith(handle);

  const first = new MusicLibrary({ scope });
  assert.equal(first.supported, true);
  assert.equal(first.persistable, true);
  await first.pickFolder();
  assert.deepEqual(first.tracks.map((t) => t.path).sort(), ['Radiohead/Kid A/1.flac', 'loose.mp3']);

  // A whole new session, as after a reload: no picker, no prompt, and the
  // library is simply there.
  const second = await new MusicLibrary({ scope }).init();
  assert.equal(second.root.name, 'Music');
  assert.equal(second.tracks.length, 2);
  assert.equal(second.playable, true);
});

test('a chosen folder remains playable for the session when storage is unavailable', async () => {
  const handle = fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') });
  const scope = { showDirectoryPicker: async () => handle };
  const lib = new MusicLibrary({ scope });
  const tracks = await lib.pickFolder();
  assert.equal(tracks.length, 1);
  assert.equal(lib.root.persistable, false);
  assert.equal(lib.handle, handle);
  assert.equal(lib.playable, true);
  assert.ok(await lib.openFile(tracks[0]));
});

test('a folder whose permission lapsed lists but does not claim to be playable', async () => {
  const handle = fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') }, { permission: 'prompt' });
  const scope = fakeIdb();
  scope.showDirectoryPicker = async () => handle;
  await new MusicLibrary({ scope }).pickFolder();

  const next = await new MusicLibrary({ scope }).init();
  // There is no user gesture on load, so re-requesting would be rejected by
  // the browser anyway. The library shows what it remembers and waits.
  assert.equal(next.tracks.length, 1);
  assert.equal(next.playable, false);
  assert.equal(await next.openFile(next.tracks[0]), null);

  assert.equal(await next.grantAccess(), true);
  assert.equal(next.playable, true);
  assert.ok(await next.openFile(next.tracks[0]));
});

test('a stored path finds its file again, and a moved one reports itself', async () => {
  const target = fakeFile('1.flac');
  const scope = scopeWith(fakeDirHandle('Music', { 'Radiohead/Kid A/1.flac': target }));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();
  assert.equal(await lib.openFile(lib.tracks[0]), target);
  assert.equal(await lib.openFile({ path: 'Nowhere/x.mp3' }), null);
  assert.equal(await lib.openFile(null), null);
});

test('a rescan picks up what changed on disk without losing the play history', async () => {
  const files = { 'a.mp3': fakeFile('a.mp3'), 'b.mp3': fakeFile('b.mp3') };
  const scope = scopeWith(fakeDirHandle('Music', files));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();

  const a = lib.tracks.find((t) => t.path === 'a.mp3');
  await lib.notePlayed(a, 212.5);
  assert.equal(a.playCount, 1);

  // b is gone, c has appeared.
  delete files['b.mp3'];
  files['c.mp3'] = fakeFile('c.mp3');
  lib.handle = fakeDirHandle('Music', files);
  await lib.rescan();

  assert.deepEqual(lib.tracks.map((t) => t.path).sort(), ['a.mp3', 'c.mp3']);
  const again = lib.tracks.find((t) => t.path === 'a.mp3');
  assert.equal(again.playCount, 1);
  // The duration is the one field a scan cannot know; losing it on every
  // rescan would quietly break sorting by length and the auto-tag's own
  // length check.
  assert.equal(again.durationSec, 212.5);
});

test('a browser with no persistable handle gets a library and an honest caveat', async () => {
  const scope = fakeIdb(); // no showDirectoryPicker
  const lib = new MusicLibrary({ scope });
  assert.equal(lib.persistable, false);
  assert.equal(await lib.pickFolder(), null);

  const withPath = (relative) => Object.assign(fakeFile(relative.split('/').pop()), { webkitRelativePath: relative });
  await lib.adoptFileList([withPath('My Music/x/1.mp3'), withPath('My Music/art.png')]);
  assert.equal(lib.root.name, 'My Music');
  assert.equal(lib.root.persistable, false);
  assert.deepEqual(lib.tracks.map((t) => t.path), ['x/1.mp3']);
  // Playable this session, because the File objects are still in hand.
  assert.ok(await lib.openFile(lib.tracks[0]));

  // Next session the listing survives; the way back to the files does not.
  const next = await new MusicLibrary({ scope }).init();
  assert.equal(next.tracks.length, 1);
  assert.equal(next.playable, false);
});

test('folder import remains playable when IndexedDB is unavailable', async () => {
  const lib = new MusicLibrary({ scope: {}, fetchFn: null });
  const file = Object.assign(fakeFile('sample.wav'), { webkitRelativePath: 'Music/sample.wav' });
  await lib.adoptFileList([file], { name: 'Music' });
  assert.equal(lib.tracks.length, 1);
  assert.equal(lib.sessionFiles.size, 1);
  assert.equal(lib.scanning, false);
  assert.equal(await lib.openFile(lib.tracks[0]), file);
});

test('identically named file selections remain separately playable with their original labels', async (t) => {
  for (const [name, scope] of [['stored', fakeIdb()], ['session', {}]]) {
    await t.test(name, async () => {
      const files = [new File(['first song'], 'Artist - Song.mp3'), new File(['second song'], 'Artist - Song.mp3')];
      const lib = new MusicLibrary({ scope, fetchFn: null });
      await lib.adoptFileList(files);

      assert.equal(lib.tracks.length, 2);
      assert.equal(new Set(lib.tracks.map((track) => track.path)).size, 2);
      assert.equal(lib.sessionFiles.size, 2);
      for (let i = 0; i < files.length; i++) {
        assert.equal(await lib.openFile(lib.tracks[i]), files[i]);
        assert.equal(lib.tracks[i].name, 'Artist - Song.mp3');
        assert.equal(displayTitle(lib.tracks[i]), 'Song');
      }
    });
  }
});

test('auto-tagging writes only what it found, and only over guesses', async () => {
  const scope = scopeWith(fakeDirHandle('Music', {
    'Aphex Twin - Xtal.mp3': fakeFile('Aphex Twin - Xtal.mp3'),
    'unknown-1.mp3': fakeFile('unknown-1.mp3'),
  }));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();

  lib.fetchFn = async (url) => ({
    ok: true,
    json: async () => (url.includes('Xtal')
      ? { recordings: [{ score: 98, title: 'Xtal', length: null, 'artist-credit': [{ name: 'Aphex Twin' }], releases: [{ title: 'Selected Ambient Works 85-92', date: '1992-11-09' }] }] }
      : { recordings: [] }),
  });

  const emits = [];
  lib.subscribe(() => emits.push(lib.tracks.map((t) => t.tagSource).join(',')));
  const tagged = await lib.autoTag();
  assert.equal(tagged, 1);

  const xtal = lib.tracks.find((t) => t.path.includes('Xtal'));
  assert.equal(xtal.album, 'Selected Ambient Works 85-92');
  assert.equal(xtal.year, 1992);
  assert.equal(xtal.tagSource, 'auto');
  // The one that came back empty keeps the filename it had -- an unfindable
  // track is left alone, never blanked.
  const unknown = lib.tracks.find((t) => t.path.includes('unknown'));
  assert.equal(unknown.tagSource, 'filename');
  assert.ok(unknown.title);
  // Results land one at a time so the list visibly fills in.
  assert.ok(emits.length >= 1);

  // The tags outlive the session they were fetched in.
  const next = await new MusicLibrary({ scope }).init();
  assert.equal(next.tracks.find((t) => t.path.includes('Xtal')).artist, 'Aphex Twin');
});

test('a second auto-tag run has nothing left to ask about', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'x.mp3': fakeFile('x.mp3') }));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();
  lib.tracks[0].tagSource = 'tags';
  let asked = 0;
  lib.fetchFn = async () => { asked++; return { ok: true, json: async () => ({ recordings: [] }) }; };
  assert.equal(await lib.autoTag(), 0);
  assert.equal(asked, 0);
});

test('forgetting a folder leaves nothing behind', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') }));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();
  await lib.forget();
  assert.equal(lib.root, null);
  assert.deepEqual(lib.tracks, []);
  assert.equal((await new MusicLibrary({ scope }).init()).tracks.length, 0);
});

test('with no storage at all the library is inert rather than broken', async () => {
  const lib = await new MusicLibrary({ scope: {} }).init();
  assert.equal(lib.supported, false);
  assert.deepEqual(lib.tracks, []);
  assert.equal(await lib.pickFolder(), null);
  assert.equal(await lib.openFile({ path: 'a' }), null);
  await lib.notePlayed({ key: 'k' }, 10);
  assert.equal(await lib.autoTag(), 0);
});

/** A folder of `count` files, for watching a scan unfold. */
function bigFolder(count) {
  const files = {};
  for (let i = 0; i < count; i++) files[`t${String(i).padStart(4, '0')}.mp3`] = fakeFile(`t${i}.mp3`);
  return files;
}

test('the library fills in while the folder is being read, not after', async () => {
  // The reported bug: choosing a folder showed nothing at all for minutes,
  // then everything at once. Subscribers must see it growing.
  const scope = scopeWith(fakeDirHandle('Music', bigFolder(120)));
  const lib = new MusicLibrary({ scope });
  const seen = [];
  lib.subscribe(() => seen.push({ n: lib.tracks.length, scanning: lib.scanning }));

  let rootChosenAt = null;
  await lib.pickFolder({ onRootChosen: () => { rootChosenAt = lib.tracks.length; } });

  // The caller is told about the folder BEFORE any track has been read --
  // that is the moment the library opens, so it opens empty and fills.
  assert.equal(rootChosenAt, 0);
  const growing = seen.filter((s) => s.scanning && s.n > 0);
  assert.ok(growing.length >= 2, `expected several partial emissions, saw ${JSON.stringify(seen.map((s) => s.n))}`);
  // Strictly increasing while scanning: no emission ever goes backwards.
  for (let i = 1; i < growing.length; i++) assert.ok(growing[i].n >= growing[i - 1].n);
  // And the last word is the complete, finished library.
  assert.equal(seen.at(-1).scanning, false);
  assert.equal(seen.at(-1).n, 120);
  assert.equal(lib.scanning, false);
});

test('a scan abandoned part way leaves what it found, and a later rescan completes it', async () => {
  const files = bigFolder(200);
  const scope = scopeWith(fakeDirHandle('Music', files));
  const lib = new MusicLibrary({ scope });

  const unsubscribe = lib.subscribe(() => {
    if (lib.scanning && lib.tracks.length >= 40) lib.cancel();
  });
  await lib.pickFolder();
  unsubscribe();

  const partial = (await new MusicLibrary({ scope }).init()).tracks.length;
  assert.ok(partial >= 40 && partial < 200, `partial scan stored ${partial}`);

  // Nothing was pruned, because a partial walk does not know what is
  // missing -- only a completed one does.
  const finished = await new MusicLibrary({ scope }).init();
  await finished.grantAccess();
  await finished.rescan();
  assert.equal(finished.tracks.length, 200);
  assert.equal(finished.scanning, false);
});

test('choosing a second folder cannot be overwritten by the first scan unwinding', async () => {
  const scope = scopeWith(fakeDirHandle('Music', bigFolder(80)));
  const lib = new MusicLibrary({ scope });
  lib.root = await addRoot({ name: 'Music' }, scope);
  lib.handle = fakeDirHandle('Music', bigFolder(80));
  const slow = lib.rescan();
  // A second scan starts before the first has unwound.
  lib.handle = fakeDirHandle('Other', bigFolder(10));
  lib.root = await addRoot({ name: 'Other' }, scope);
  const fresh = await lib.rescan();
  await slow;

  assert.equal(fresh.length, 10);
  // The superseded scan must not write its 80 tracks over the new library.
  assert.equal(lib.tracks.length, 10);
});

test('a cancelled picker is silent; a broken one is not', async () => {
  const scope = fakeIdb();
  const lib = new MusicLibrary({ scope });

  scope.showDirectoryPicker = async () => {
    const err = new Error('The user aborted a request.');
    err.name = 'AbortError';
    throw err;
  };
  assert.equal(await lib.pickFolder(), null);

  // Anything else used to come back as null too, which looks exactly like
  // "the button did nothing" -- the worst way to report a failure.
  scope.showDirectoryPicker = async () => {
    const err = new Error('Must be handling a user gesture to show a file picker.');
    err.name = 'SecurityError';
    throw err;
  };
  await assert.rejects(() => lib.pickFolder(), /user gesture/);
});

// --- Streaming a scan means rows are live before the scan is done, and
// everything below is a way that can go wrong. All seven were found by
// review on the streaming change itself.

test('playing a track that arrived mid-scan does not reset its play count', () => {
  // A raw scan record carries playCount 0. Publishing those and then
  // playing one computes the next count from the zero and writes 1 over a
  // stored 7 -- silently, and permanently.
  const scope = scopeWith(fakeDirHandle('Music', bigFolder(80)));
  return (async () => {
    const first = new MusicLibrary({ scope });
    await first.pickFolder();
    const target = first.tracks[0];
    await first.notePlayed(target, 180);
    await first.notePlayed(target, 180);
    assert.equal(target.playCount, 2);

    const second = await new MusicLibrary({ scope }).init();
    await second.grantAccess();
    let seenMidScan = null;
    second.subscribe(() => {
      if (second.scanning && !seenMidScan) seenMidScan = second.tracks.find((t) => t.path === target.path) || null;
    });
    await second.rescan();
    assert.ok(seenMidScan, 'the track should have been published during the scan');
    // The row the view got is the merged one, history intact.
    assert.equal(seenMidScan.playCount, 2);
    await second.notePlayed(seenMidScan, 180);
    assert.equal(seenMidScan.playCount, 3);
  })();
});

test('a folder that stops being readable mid-walk does not leave the library scanning forever', async () => {
  const scope = fakeIdb();
  const lib = new MusicLibrary({ scope });
  lib.root = await addRoot({ name: 'Music' }, scope);
  lib.handle = {
    values() {
      return (async function* () {
        yield { kind: 'file', name: 'a.mp3', getFile: async () => fakeFile('a.mp3') };
        throw new Error('NotAllowedError: access revoked');
      })();
    },
  };
  await lib.rescan();
  assert.equal(lib.scanResult.complete, false);
  assert.ok(lib.scanResult.issues.some(issue => issue.kind === 'directory-read'));
  // Otherwise the panel stays labelled as reading, with Rescan and Auto-tag
  // disabled and no scan left to re-enable them.
  assert.equal(lib.scanning, false);
  assert.equal(lib._abort, null);
});

test('forgetting during a scan leaves nothing behind for the scan to write back', async () => {
  const scope = scopeWith(fakeDirHandle('Music', bigFolder(200)));
  const lib = new MusicLibrary({ scope });
  let forgetting = null;
  const unsubscribe = lib.subscribe(() => {
    if (lib.scanning && lib.tracks.length >= 40) { unsubscribe(); forgetting = lib.forget(); }
  });
  await lib.pickFolder();
  await forgetting;
  // A flush already under way finishes after the root is deleted; without a
  // new generation it still looks current and writes orphan rows back.
  assert.equal(lib.root, null);
  assert.deepEqual(lib.tracks, []);
  const next = await new MusicLibrary({ scope }).init();
  assert.equal(next.root, null);
  assert.deepEqual(next.tracks, []);
});

test('a scan whose writes were refused does not then decide what to delete', async () => {
  // Pruning is the destructive half. A scan that could not store everything
  // it found has no standing to say what is missing from disk.
  let refuseWrites = false;
  const scope = fakeIdb({ rejectPut: (_row, store) => refuseWrites && store === 'tracks' });
  scope.showDirectoryPicker = async () => fakeDirHandle('Music', { 'keep.mp3': fakeFile('keep.mp3') });
  const seed = new MusicLibrary({ scope });
  await seed.pickFolder();
  assert.equal(seed.tracks.length, 1);
  const lib = await new MusicLibrary({ scope }).init();
  refuseWrites = true;
  lib.handle = fakeDirHandle('Music', { 'other.mp3': fakeFile('other.mp3') });
  await lib.rescan();
  // keep.mp3 is gone from disk, but the replacement never landed, so it is
  // not this scan's place to remove it.
  const survivors = await new MusicLibrary({ scope }).init();
  assert.ok(survivors.tracks.some((t) => t.path === 'keep.mp3'), 'a refused write must not license a prune');
});

test('a scan superseded while it is finishing does not clobber the newer one', async () => {
  const scope = scopeWith(fakeDirHandle('Music', bigFolder(60)));
  const lib = new MusicLibrary({ scope });
  lib.root = await addRoot({ name: 'Music' }, scope);
  lib.handle = fakeDirHandle('Music', bigFolder(60));

  const stale = lib.rescan();
  lib.root = await addRoot({ name: 'Other' }, scope);
  lib.handle = fakeDirHandle('Other', bigFolder(8));
  const fresh = lib.rescan();
  await Promise.all([stale, fresh]);

  assert.equal(lib.tracks.length, 8);
  assert.equal(lib.scanning, false);
  // The stale scan must not have cleared the newer scan's abort controller
  // on its way out, which would leave the new one uncancellable.
  assert.equal(lib._abort, null);
});

test('a webkitdirectory row is playable the moment it appears, not when the scan ends', async () => {
  // The one path where the File is already in hand. Holding the session map
  // back until the end meant every row that appeared during a long scan
  // reported "pick the folder again" when clicked.
  const scope = fakeIdb();
  const lib = new MusicLibrary({ scope });
  const withPath = (i) => Object.assign(fakeFile(`${i}.mp3`), { webkitRelativePath: `My Music/${i}.mp3` });
  const files = Array.from({ length: 90 }, (_, i) => withPath(i));

  let playableMidScan = null;
  lib.subscribe(async () => {
    if (!lib.scanning || playableMidScan !== null || !lib.tracks.length) return;
    playableMidScan = !!await lib.openFile(lib.tracks[0]);
  });
  await lib.adoptFileList(files);
  assert.equal(playableMidScan, true);
});

test('playing through a stale row increments the stored count and reconciles the current row', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') }));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();
  const stale = { ...lib.tracks[0] };
  await lib.notePlayed(lib.tracks[0], 180);
  assert.equal(await lib.notePlayed(stale, 181), true);
  assert.equal(stale.playCount, 2);
  assert.equal(lib.tracks[0].playCount, 2);
  assert.equal(lib.tracks[0].durationSec, 181);
  assert.equal((await listTracks(lib.root.id, scope))[0].playCount, 2);
});

test('a failed play save keeps the session edit and marks it unsaved', async () => {
  const scope = fakeIdb({ rejectPut: (row, store) => store === 'tracks' && row.playCount > 0 });
  const lib = new MusicLibrary({ scope });
  await lib.adoptFileList([Object.assign(fakeFile('a.mp3'), { webkitRelativePath: 'Music/a.mp3' })]);
  const target = lib.tracks[0];
  assert.equal(await lib.notePlayed(target, 180), false);
  assert.equal(target.playCount, 1);
  assert.equal(target.durationSec, 180);
  assert.equal(target.unsaved, true);
  assert.equal((await listTracks(lib.root.id, scope))[0].playCount, 0);
});

test('failed tag saves stay marked after a different field commits successfully', async () => {
  let refuseTags = true;
  const scope = fakeIdb({ rejectPut: (row, store) => store === 'tracks' && refuseTags && row.tagSource === 'auto' });
  const lib = new MusicLibrary({ scope, fetchFn: async () => ({
    ok: true,
    json: async () => ({ recordings: [{ score: 98, title: 'Xtal', 'artist-credit': [{ name: 'Aphex Twin' }], releases: [{ title: 'Fetched album' }] }] }),
  }) });
  await lib.adoptFileList([Object.assign(fakeFile('Aphex Twin - Xtal.mp3'), { webkitRelativePath: 'Music/Aphex Twin - Xtal.mp3' })]);
  assert.equal(await lib.autoTag(), 1);
  const target = lib.tracks[0];
  assert.equal(target.album, 'Fetched album');
  assert.equal(target.unsaved, true);
  assert.equal((await listTracks(lib.root.id, scope))[0].tagSource, 'filename');
  refuseTags = false;
  assert.equal(await lib.notePlayed(target, 180), true);
  assert.equal(target.unsaved, true, 'committing a play must not claim the failed tags were saved');
  assert.equal((await listTracks(lib.root.id, scope))[0].tagSource, 'filename');
});

test('a failed rescan carries session history forward and marks the displayed rows unsaved', async () => {
  let refuseScan = false;
  const scope = fakeIdb({ rejectPut: (row, store) => store === 'tracks' && refuseScan });
  const lib = new MusicLibrary({ scope });
  lib.root = await addRoot({ name: 'Music' }, scope);
  lib.handle = fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') });
  await lib.rescan();
  await lib.notePlayed(lib.tracks[0], 180);
  refuseScan = true;
  await lib.rescan();
  assert.equal(lib.tracks[0].playCount, 1);
  assert.equal(lib.tracks[0].durationSec, 180);
  assert.equal(lib.tracks[0].unsaved, true);
  assert.equal((await listTracks(lib.root.id, scope))[0].playCount, 1);
});

test('storage-free scan, tag and play edits are explicitly session-only', async () => {
  const lib = new MusicLibrary({ scope: {}, fetchFn: async () => ({
    ok: true,
    json: async () => ({ recordings: [{ score: 98, title: 'Xtal', 'artist-credit': [{ name: 'Aphex Twin' }] }] }),
  }) });
  await lib.adoptFileList([Object.assign(fakeFile('Aphex Twin - Xtal.mp3'), { webkitRelativePath: 'Music/Aphex Twin - Xtal.mp3' })]);
  assert.equal(lib.tracks[0].unsaved, true);
  await lib.autoTag();
  assert.equal(lib.tracks[0].tagSource, 'auto');
  assert.equal(lib.tracks[0].unsaved, true);
  assert.equal(await lib.notePlayed(lib.tracks[0], 180), false);
  assert.equal(lib.tracks[0].playCount, 1);
  assert.equal(lib.tracks[0].unsaved, true);
});

test('an incomplete rescan retains unreadable earned rows until a healthy complete deletion', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'keep.mp3': fakeFile('keep.mp3'), 'blocked.mp3': fakeFile('blocked.mp3') }));
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();
  const earned = lib.tracks.find(row => row.path === 'blocked.mp3');
  await lib.notePlayed(earned, 217);
  await updateTrack(earned.key, { album: 'Earned album', title: 'Earned title', tagSource: 'auto' }, scope);
  lib.handle = { values: async function* () {
    yield { kind: 'file', name: 'keep.mp3', getFile: async () => fakeFile('keep.mp3') };
    yield { kind: 'file', name: 'blocked.mp3', getFile: async () => { throw new Error('NotReadableError'); } };
    yield { kind: 'file', name: 'new.mp3', getFile: async () => fakeFile('new.mp3') };
  } };
  await lib.rescan();
  assert.deepEqual(lib.tracks.map(row => row.path).sort(), ['blocked.mp3', 'keep.mp3', 'new.mp3']);
  const stored = (await listTracks(lib.root.id, scope)).find(row => row.path === 'blocked.mp3');
  assert.equal(stored.playCount, 1); assert.equal(stored.durationSec, 217); assert.equal(stored.album, 'Earned album');
  assert.equal(lib.scanResult.complete, false);
  assert.ok(lib.scanResult.issues.some(issue => issue.kind === 'file-read'));
  lib.handle = fakeDirHandle('Music', { 'keep.mp3': fakeFile('keep.mp3'), 'new.mp3': fakeFile('new.mp3') });
  await lib.rescan();
  assert.deepEqual((await listTracks(lib.root.id, scope)).map(row => row.path).sort(), ['keep.mp3', 'new.mp3']);
  assert.equal(lib.scanResult.complete, true);
});

test('an unreadable root keeps its durable listing and the service view', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'earned.mp3': fakeFile('earned.mp3') }));
  const lib = new MusicLibrary({ scope }); await lib.pickFolder();
  await lib.notePlayed(lib.tracks[0], 171);
  lib.handle = { values() { throw new Error('NotAllowedError'); } };
  await lib.rescan();
  assert.equal(lib.tracks.length, 1); assert.equal(lib.tracks[0].playCount, 1);
  assert.equal((await listTracks(lib.root.id, scope))[0].durationSec, 171);
  assert.equal(lib.scanning, false); assert.equal(lib.scanResult.complete, false);
});

test('a tag read failure cannot replace stored earned metadata with empty guesses', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'earned.mp3': fakeFile('earned.mp3') }));
  const lib = new MusicLibrary({ scope }); await lib.pickFolder();
  await updateTrack(lib.tracks[0].key, { title: 'Stored tags', album: 'Stored album', tagSource: 'tags' }, scope);
  lib.handle = fakeDirHandle('Music', { 'earned.mp3': { ...fakeFile('earned.mp3'),
    slice: () => ({ arrayBuffer: async () => { throw new Error('read failed'); } }) } });
  await lib.rescan();
  assert.equal(lib.tracks[0].title, 'Stored tags');
  assert.equal((await listTracks(lib.root.id, scope))[0].album, 'Stored album');
  assert.equal(lib.scanResult.complete, false);
});

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a scan in another instance supersedes stale writes and pruning for the same root', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'old.mp3': fakeFile('old.mp3'), 'shared.mp3': fakeFile('shared.mp3') }));
  const old = new MusicLibrary({ scope }); await old.pickFolder();
  await old.notePlayed(old.tracks.find(row => row.path === 'shared.mp3'), 190);
  const entered = deferred(), release = deferred();
  old.handle = { values: async function* () {
    yield { kind: 'file', name: 'old.mp3', getFile: async () => fakeFile('old.mp3') };
    entered.resolve(); await release.promise;
  } };
  const pending = old.rescan(); await entered.promise;
  const current = await new MusicLibrary({ scope }).init();
  current.handle = fakeDirHandle('Music', { 'shared.mp3': fakeFile('shared.mp3'), 'new.mp3': fakeFile('new.mp3') });
  await current.rescan(); release.resolve(); await pending;
  const rows = await listTracks(current.root.id, scope);
  assert.deepEqual(rows.map(row => row.path).sort(), ['new.mp3', 'shared.mp3']);
  assert.equal(rows.find(row => row.path === 'shared.mp3').playCount, 1);
});

test('forget in another instance prevents an old scan from recreating orphan tracks', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'old.mp3': fakeFile('old.mp3') }));
  const old = new MusicLibrary({ scope }); await old.pickFolder();
  const entered = deferred(), release = deferred();
  old.handle = { values: async function* () { entered.resolve(); await release.promise;
    yield { kind: 'file', name: 'old.mp3', getFile: async () => fakeFile('old.mp3') };
  } };
  const pending = old.rescan(); await entered.promise;
  const other = await new MusicLibrary({ scope }).init(); await other.forget();
  release.resolve(); await pending;
  assert.deepEqual(await listRoots(scope), []); assert.deepEqual(await listTracks(null, scope), []);
});

test('an earlier folder picker cannot overwrite a later selection when it resolves last', async () => {
  const scope = fakeIdb(), chosen = deferred(); let calls = 0;
  scope.showDirectoryPicker = () => ++calls === 1 ? chosen.promise
    : Promise.resolve(fakeDirHandle('Later', { 'new.mp3': fakeFile('new.mp3') }));
  const lib = new MusicLibrary({ scope }); const old = lib.pickFolder();
  await lib.pickFolder(); chosen.resolve(fakeDirHandle('Earlier', { 'old.mp3': fakeFile('old.mp3') }));
  await old;
  assert.equal(lib.root.name, 'Later'); assert.deepEqual(lib.tracks.map(row => row.path), ['new.mp3']);
  assert.deepEqual((await listRoots(scope)).map(row => row.name), ['Later']);
});

test('forget cancels a pending folder identity comparison before it can remember a new root', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') }));
  const lib = new MusicLibrary({ scope }); await lib.pickFolder();
  const entered = deferred(), release = deferred();
  const next = fakeDirHandle('Other', { 'b.mp3': fakeFile('b.mp3') });
  next.isSameEntry = async () => { entered.resolve(); return release.promise; };
  scope.showDirectoryPicker = async () => next;
  const pending = lib.pickFolder(); await entered.promise;
  await lib.forget(); release.resolve(false); await pending;
  assert.equal(lib.root, null); assert.deepEqual(lib.tracks, []); assert.deepEqual(await listRoots(scope), []);
});

test('failed root saves still allow handle and file-list scans for the session', async () => {
  for (const useHandle of [false, true]) {
    const scope = fakeIdb({ rejectPut: (_row, store) => store === 'roots' });
    const handle = fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') });
    if (useHandle) scope.showDirectoryPicker = async () => handle;
    const lib = new MusicLibrary({ scope });
    if (useHandle) await lib.pickFolder();
    else await lib.adoptFileList([Object.assign(fakeFile('a.mp3'), { webkitRelativePath: 'Music/a.mp3' })]);
    assert.equal(lib.tracks.length, 1, `usable session row for handle=${useHandle}`);
    assert.ok(await lib.openFile(lib.tracks[0]));
    assert.equal(lib.tracks[0].unsaved, true);
    assert.equal(lib.scanResult.stored, false);
    assert.deepEqual(await listRoots(scope), []);
    assert.deepEqual(await listTracks(null, scope), []);
  }
});

test('a late scan cannot claim a removed root ID reused by another folder', async () => {
  const scope = scopeWith(fakeDirHandle('Music', { 'old.mp3': fakeFile('old.mp3') }));
  const old = new MusicLibrary({ scope });
  await old.pickFolder();
  const removedId = old.root.id;
  const current = await new MusicLibrary({ scope }).init();
  await current.forget();
  scope.showDirectoryPicker = async () => fakeDirHandle('Music', { 'new.mp3': fakeFile('new.mp3') });
  await current.pickFolder();
  assert.equal(current.root.id, removedId, 'legacy root ID is legitimately reusable');
  await current.notePlayed(current.tracks[0], 222);
  await old.rescan();
  const stored = await listTracks(current.root.id, scope);
  assert.deepEqual(stored.map(row => row.path), ['new.mp3']);
  assert.equal(stored[0].playCount, 1);
  assert.equal(stored[0].durationSec, 222);
  assert.equal(old.scanResult.stale, true);
});

test('permission completion cannot restore access to a forgotten root', async () => {
  const permission = deferred();
  const handle = fakeDirHandle('Music', { 'a.mp3': fakeFile('a.mp3') });
  handle.queryPermission = () => permission.promise;
  const scope = scopeWith(handle);
  const lib = new MusicLibrary({ scope });
  await lib.pickFolder();
  lib.handle = null;
  const granting = lib.grantAccess();
  await lib.forget();
  permission.resolve('granted');
  assert.equal(await granting, false);
  assert.equal(lib.root, null);
  assert.equal(lib.handle, null);
});
