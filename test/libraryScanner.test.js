// The scan is the promise that choosing a folder is cheap: a few thousand
// songs become a browsable library in seconds because nothing is decoded and
// no whole file is read. These tests hold that -- how much of each file is
// touched, what counts as a track, and that one unreadable file cannot take
// the folder down with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAudioName, extensionOf, folderOf, walkAudioFiles, readTags, trackRecord,
  scanDirectory, ensureReadPermission, resolveFile, scanFileList, AUDIO_EXTENSIONS,
} from '../src/library/LibraryScanner.js';

function syncsafe(n) { return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0xff & 0x7f]; }
function beBytes(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function frame(id, str) {
  const data = [0, ...Array.from(str, (c) => c.charCodeAt(0))];
  return [...Array.from(id, (c) => c.charCodeAt(0)), ...beBytes(data.length), 0, 0, ...data];
}
/** An ID3v2.3 tag followed by `padBytes` of pretend audio. */
function id3v2File(tags, padBytes = 0) {
  const body = Object.entries(tags).flatMap(([id, v]) => frame(id, v));
  return new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(body.length), ...body, ...new Uint8Array(padBytes)]);
}
function id3v1Tail(title, artist) {
  const buf = new Uint8Array(128);
  buf.set([0x54, 0x41, 0x47]); // "TAG"
  for (let i = 0; i < title.length; i++) buf[3 + i] = title.charCodeAt(i);
  for (let i = 0; i < artist.length; i++) buf[33 + i] = artist.charCodeAt(i);
  return buf;
}

/** A File that counts how many bytes anyone asked it for -- the scan's cost
 *  is the thing under test, so it has to be observable. */
function fakeFile(name, bytes, { lastModified = 1000 } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const file = {
    name,
    size: data.length,
    lastModified,
    bytesRead: 0,
    slice(start = 0, end = data.length) {
      const from = start < 0 ? Math.max(0, data.length + start) : Math.min(start, data.length);
      const to = Math.min(end, data.length);
      const part = data.subarray(from, Math.max(from, to));
      return { arrayBuffer: async () => { file.bytesRead += part.length; return part.slice().buffer; } };
    },
  };
  return file;
}

/** A directory handle shaped like the File System Access API, built from a
 *  plain `{ name: fileOrDirObject }` tree. */
function dir(name, entries) {
  return {
    kind: 'directory',
    name,
    values() {
      return (async function* () {
        for (const [key, value] of Object.entries(entries)) {
          if (value && value.kind) { yield value; continue; }
          yield { kind: 'file', name: key, getFile: async () => (value instanceof Error ? Promise.reject(value) : value) };
        }
      })();
    },
  };
}
function file(name, bytes) { return fakeFile(name, bytes); }

async function collect(iter) {
  const out = [];
  for await (const item of iter) out.push(item);
  return out;
}

test('a track is what the decoder can open, and nothing else in the folder is', () => {
  for (const ext of AUDIO_EXTENSIONS) assert.ok(isAudioName(`song.${ext}`), ext);
  assert.ok(isAudioName('SONG.MP3'));
  // Artwork, cue sheets and stray video are in every ripped folder and are
  // not tracks. A library that lists cover.jpg has lied about itself.
  for (const name of ['cover.jpg', 'album.cue', 'notes.txt', 'video.mp4', 'noextension']) {
    assert.ok(!isAudioName(name), name);
  }
  assert.equal(extensionOf('a.b.FLAC'), 'flac');
  assert.equal(extensionOf('none'), '');
});

test('the folder of a path is everything before the last slash', () => {
  assert.equal(folderOf('a/b/c.mp3'), 'a/b');
  assert.equal(folderOf('c.mp3'), '');
  assert.equal(folderOf(''), '');
});

test('the walk recurses, keeps relative paths, and skips what is not music', async () => {
  const tree = dir('Music', {
    'loose.mp3': file('loose.mp3'),
    'cover.jpg': file('cover.jpg'),
    Radiohead: dir('Radiohead', {
      'Kid A': dir('Kid A', { '1.flac': file('1.flac') }),
      'live.m4a': file('live.m4a'),
    }),
  });
  const found = (await collect(walkAudioFiles(tree))).map((f) => f.path);
  assert.deepEqual(found.sort(), ['Radiohead/Kid A/1.flac', 'Radiohead/live.m4a', 'loose.mp3']);
});

test('hidden files, resource forks and OS metadata folders never become tracks', async () => {
  const tree = dir('Music', {
    '.hidden.mp3': file('.hidden.mp3'),
    '._Track.mp3': file('._Track.mp3'),
    'real.mp3': file('real.mp3'),
    __MACOSX: dir('__MACOSX', { 'ghost.mp3': file('ghost.mp3') }),
    'node_modules': dir('node_modules', { 'x.mp3': file('x.mp3') }),
  });
  const found = (await collect(walkAudioFiles(tree))).map((f) => f.path);
  // `._Track.mp3` would otherwise double every count on a macOS-written drive.
  assert.deepEqual(found, ['real.mp3']);
});

test('a folder that refuses to be listed ends that branch, not the scan', async () => {
  const hostile = { kind: 'directory', name: 'locked', values() { throw new Error('permission revoked'); } };
  const tree = dir('Music', { locked: hostile, 'ok.mp3': file('ok.mp3') });
  assert.deepEqual((await collect(walkAudioFiles(tree))).map((f) => f.path), ['ok.mp3']);
});

test('directory read failures report the affected branch and preserve readable siblings', async (t) => {
  const failures = {
    values: () => { throw new Error('listing refused'); },
    iterator: () => ({ [Symbol.asyncIterator]() { throw new Error('iterator refused'); } }),
    next: () => ({
      [Symbol.asyncIterator]() { return this; },
      async next() { throw new Error('iteration refused'); },
    }),
  };
  for (const [phase, values] of Object.entries(failures)) {
    await t.test(phase, async () => {
      const issues = [];
      const tree = dir('Music', {
        locked: { kind: 'directory', name: 'locked', values },
        'ok.mp3': file('ok.mp3'),
      });
      const tracks = await scanDirectory('r', tree, { onIssue: (issue) => issues.push(issue) });
      assert.deepEqual(tracks.map((track) => track.path), ['ok.mp3']);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].kind, 'directory-read');
      assert.equal(issues[0].path, 'locked');
      assert.equal(typeof issues[0].message, 'string');
      assert.deepEqual(Object.keys(issues[0]).sort(), ['kind', 'message', 'path']);
    });
  }
});

test('a directory iterator failure retains files already yielded and continues sibling branches', async () => {
  const partial = {
    kind: 'directory', name: 'partial',
    async *values() {
      yield { kind: 'file', name: 'first.mp3', getFile: async () => file('first.mp3') };
      throw new Error('drive disconnected');
    },
  };
  const issues = [];
  const tracks = await scanDirectory('r', dir('Music', { partial, 'last.mp3': file('last.mp3') }), {
    onIssue: (issue) => issues.push(issue),
  });
  assert.deepEqual(tracks.map((track) => track.path), ['partial/first.mp3', 'last.mp3']);
  assert.equal(issues[0].path, 'partial');
});

test('a depth limit reports that descendants could not be inspected', async () => {
  let deep = dir('level11', { 'buried.mp3': file('buried.mp3') });
  for (let level = 10; level >= 1; level--) deep = dir(`level${level}`, { child: deep });
  const issues = [];
  const tracks = await scanDirectory('r', dir('Music', { deep, 'ok.mp3': file('ok.mp3') }), {
    onIssue: (issue) => issues.push(issue),
  });
  assert.deepEqual(tracks.map((track) => track.path), ['ok.mp3']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'depth-limit');
  assert.equal(issues[0].path, 'level1/level2/level3/level4/level5/level6/level7/level8/level9/level10/level11');
});

test('healthy empty folders and intentionally skipped entries report no issues', async () => {
  const issues = [];
  assert.deepEqual(await scanDirectory('r', dir('Empty', {}), { onIssue: (issue) => issues.push(issue) }), []);
  const hidden = dir('Music', {
    '.hidden.mp3': file('.hidden.mp3'),
    __MACOSX: dir('__MACOSX', { 'ghost.mp3': file('ghost.mp3') }),
    node_modules: dir('node_modules', { 'ghost.mp3': file('ghost.mp3') }),
    'cover.jpg': file('cover.jpg'),
  });
  assert.deepEqual(await scanDirectory('r', hidden, { onIssue: (issue) => issues.push(issue) }), []);
  assert.deepEqual(issues, []);
});

test('reading a tag reads a slice, not the file', async () => {
  // 40MB of pretend FLAC behind a tag at the head. The whole promise of the
  // scan is that this costs a quarter megabyte, not forty.
  const big = fakeFile('x.flac', id3v2File({ TIT2: 'Weird Fishes', TPE1: 'Radiohead' }, 40 * 1024 * 1024));
  const tags = await readTags(big);
  assert.equal(tags.title, 'Weird Fishes');
  assert.equal(tags.artist, 'Radiohead');
  assert.equal(tags.source, 'tags');
  assert.ok(big.bytesRead <= 256 * 1024, `read ${big.bytesRead} bytes`);
});

test('an ID3v1 tag at the tail is found, but only when the head came back empty', async () => {
  const HEAD = 256 * 1024;
  // Bigger than the head slice on purpose: a file small enough to be read
  // whole has its v1 tail inside the head already, and would prove nothing
  // about the second read.
  const padding = new Uint8Array(HEAD + 4096);

  const withV2 = fakeFile('x.mp3', new Uint8Array([...id3v2File({ TIT2: 'From The Head' }), ...padding]));
  assert.equal((await readTags(withV2)).title, 'From The Head');
  // A tag at the head -- nearly every file in a modern library -- never
  // pays for the tail read.
  assert.equal(withV2.bytesRead, HEAD);

  const withV1 = fakeFile('x.mp3', new Uint8Array([...padding, ...id3v1Tail('From The Tail', 'Someone')]));
  const tags = await readTags(withV1);
  assert.equal(tags.title, 'From The Tail');
  assert.equal(tags.artist, 'Someone');
  assert.equal(withV1.bytesRead, HEAD + 128);
});

test('an untagged file falls back to its filename rather than to nothing', async () => {
  const tags = await readTags(fakeFile('Aphex Twin - Xtal.mp3', new Uint8Array(2048)));
  assert.equal(tags.artist, 'Aphex Twin');
  assert.equal(tags.title, 'Xtal');
  assert.equal(tags.source, 'filename');
});

test('an unreadable file is a null tag, never a throw', async () => {
  const hostile = { name: 'x.mp3', size: 500, slice: () => ({ arrayBuffer: async () => { throw new Error('gone'); } }) };
  assert.equal((await readTags(hostile)).title, null);
  assert.equal((await readTags(null)).title, null);
});

test('tag read failures are distinguishable from readable files without tags', async () => {
  const issues = [];
  const unreadable = { name: 'x.mp3', size: 500, slice: () => ({ arrayBuffer: async () => { throw new Error('gone'); } }) };
  await readTags(unreadable, { path: 'Album/x.mp3', onIssue: (issue) => issues.push(issue) });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'tag-read');
  assert.equal(issues[0].path, 'Album/x.mp3');
  await readTags(fakeFile('Artist - Untagged.mp3', new Uint8Array(500)), { onIssue: (issue) => issues.push(issue) });
  assert.equal(issues.length, 1);
});

test('both scanner inputs omit unreadable tags rather than publishing empty replacement metadata', async () => {
  const unreadable = { name: 'tagged.mp3', size: 500, slice: () => ({ arrayBuffer: async () => { throw new Error('read failed'); } }) };
  const readable = file('Artist - Untagged.mp3', new Uint8Array(500));
  for (const scan of [
    (onIssue) => scanDirectory('r', dir('Music', { 'tagged.mp3': unreadable, [readable.name]: readable }), { onIssue }),
    async (onIssue) => (await scanFileList('r', [unreadable, readable], { onIssue })).tracks,
  ]) {
    const issues = [];
    const tracks = await scan((issue) => issues.push(issue));
    assert.deepEqual(tracks.map((track) => track.title), ['Untagged']);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'tag-read');
    assert.equal(issues[0].path, 'tagged.mp3');
  }
});

test('a record carries the path, the folder, and where its tag came from', () => {
  const rec = trackRecord({
    rootId: 'root:music',
    path: 'Radiohead/Kid A/1.flac',
    file: fakeFile('1.flac', new Uint8Array(10), { lastModified: 42 }),
    identity: { title: 'Everything', artist: 'Radiohead', album: 'Kid A', source: 'tags' },
    nowMs: 99,
  });
  assert.equal(rec.key, 'root:music\u00001.flac'.replace('1.flac', 'Radiohead/Kid A/1.flac'));
  assert.equal(rec.folder, 'Radiohead/Kid A');
  assert.equal(rec.ext, 'flac');
  assert.equal(rec.size, 10);
  assert.equal(rec.lastModified, 42);
  assert.equal(rec.addedMs, 99);
  assert.equal(rec.tagSource, 'tags');
  // Nothing is decoded during a scan, so nothing knows a duration yet.
  assert.equal(rec.durationSec, null);
  assert.equal(rec.playCount, 0);
});

test('one file that vanishes mid-scan does not take the folder with it', async () => {
  const tree = dir('Music', {
    'gone.mp3': new Error('NotFoundError'),
    'here.mp3': file('here.mp3', id3v2File({ TIT2: 'Here' })),
  });
  const tracks = await scanDirectory('root:music', tree);
  assert.deepEqual(tracks.map((t) => t.title), ['Here']);
});

test('a file that cannot be opened reports incompleteness without exposing its handle', async () => {
  const issues = [];
  const tree = dir('Music', { Album: dir('Album', { 'gone.mp3': new Error('file vanished') }), 'ok.mp3': file('ok.mp3') });
  const tracks = await scanDirectory('r', tree, { onIssue: (issue) => issues.push(issue) });
  assert.deepEqual(tracks.map((track) => track.path), ['ok.mp3']);
  assert.deepEqual(issues, [{ kind: 'file-read', path: 'Album/gone.mp3', message: 'file vanished' }]);
});

test('both scanner inputs report an abort while returning and flushing their partial tracks', async () => {
  const files = [file('first.mp3'), file('second.mp3')];
  for (const scan of [
    (options) => scanDirectory('r', dir('Music', { 'first.mp3': files[0], 'second.mp3': files[1] }), options),
    async (options) => (await scanFileList('r', files, options)).tracks,
  ]) {
    const signal = { aborted: false };
    const issues = [];
    const batches = [];
    const tracks = await scan({
      signal,
      onProgress: () => { signal.aborted = true; },
      onIssue: (issue) => issues.push(issue),
      onBatch: (batch) => batches.push(...batch),
    });
    assert.deepEqual(tracks.map((track) => track.path), ['first.mp3']);
    assert.deepEqual(batches.map((track) => track.path), ['first.mp3']);
    assert.deepEqual(issues.map((issue) => issue.kind), ['aborted']);
  }
});

test('an already aborted scan reports an issue even for an empty folder', async () => {
  const issues = [];
  await scanDirectory('r', dir('Music', {}), { signal: { aborted: true }, onIssue: (issue) => issues.push(issue) });
  assert.deepEqual(issues.map((issue) => issue.kind), ['aborted']);
});

test('an aborted scan stops listing directories before the next audio file is found', async () => {
  const signal = { aborted: false };
  const issues = [];
  const unreadable = { kind: 'directory', name: 'locked', values() { throw new Error('must not be listed after abort'); } };
  const tracks = await scanDirectory('r', dir('Music', { 'first.mp3': file('first.mp3'), unreadable }), {
    signal,
    onProgress: () => { signal.aborted = true; },
    onIssue: (issue) => issues.push(issue),
  });
  assert.deepEqual(tracks.map((track) => track.path), ['first.mp3']);
  assert.deepEqual(issues.map((issue) => issue.kind), ['aborted']);

  issues.length = 0;
  await scanDirectory('r', unreadable, { signal, onIssue: (issue) => issues.push(issue) });
  assert.deepEqual(issues.map((issue) => issue.kind), ['aborted']);
});

test('a caller callback failure propagates rather than becoming a directory issue', async () => {
  const issues = [];
  const failure = new Error('storage programming error');
  await assert.rejects(scanDirectory('r', dir('Music', { 'ok.mp3': file('ok.mp3') }), {
    batchSize: 1,
    onBatch: () => { throw failure; },
    onIssue: (issue) => issues.push(issue),
  }), (error) => error === failure);
  assert.deepEqual(issues, []);
});

test('a scan reports progress and can be abandoned part-way', async () => {
  const entries = {};
  for (let i = 0; i < 6; i++) entries[`${i}.mp3`] = file(`${i}.mp3`, new Uint8Array(16));
  const signal = { aborted: false };
  const seen = [];
  const tracks = await scanDirectory('r', dir('M', entries), {
    signal,
    onProgress: (count, path) => { seen.push(path); if (count === 3) signal.aborted = true; },
  });
  // Closing the panel over a ten-thousand-track drive must actually stop
  // the walk, not merely stop showing it.
  assert.equal(tracks.length, 3);
  assert.equal(seen.length, 3);
});

test('permission is checked before reading and only re-requested on a gesture', async () => {
  const calls = [];
  const handle = (state) => ({
    queryPermission: async () => { calls.push('query'); return state; },
    requestPermission: async () => { calls.push('request'); return 'granted'; },
  });
  assert.equal(await ensureReadPermission(handle('granted')), true);
  // On load there is no user gesture, so a lapsed grant must report itself
  // rather than fire a prompt the browser would reject anyway.
  calls.length = 0;
  assert.equal(await ensureReadPermission(handle('prompt')), false);
  assert.deepEqual(calls, ['query']);

  calls.length = 0;
  assert.equal(await ensureReadPermission(handle('prompt'), { interactive: true }), true);
  assert.deepEqual(calls, ['query', 'request']);

  // A handle from a browser without the permissions API has nothing to
  // refuse -- treating that as denied would lock those browsers out.
  assert.equal(await ensureReadPermission({}), true);
  assert.equal(await ensureReadPermission({ queryPermission: async () => { throw new Error('x'); } }), false);
});

test('a file is found again from its path, and a missing one says so', async () => {
  const target = fakeFile('1.flac', new Uint8Array(4));
  const root = {
    getDirectoryHandle: async (name) => {
      if (name !== 'Kid A') throw new Error('NotFoundError');
      return { getFileHandle: async (n) => (n === '1.flac' ? { getFile: async () => target } : Promise.reject(new Error('gone'))) };
    },
  };
  assert.equal(await resolveFile(root, 'Kid A/1.flac'), target);
  // A moved or deleted file is null, not a throw: the right answer upstream
  // is to offer a rescan, not to show a decode error.
  assert.equal(await resolveFile(root, 'Kid A/2.flac'), null);
  assert.equal(await resolveFile(root, 'Gone/1.flac'), null);
  assert.equal(await resolveFile(null, 'x'), null);
  assert.equal(await resolveFile(root, ''), null);
});

test('a webkitdirectory pick produces the same paths the handle walk would', async () => {
  const withPath = (name, relative) => Object.assign(fakeFile(name, id3v2File({ TIT2: name })), { webkitRelativePath: relative });
  const { tracks, handles } = await scanFileList('r', [
    withPath('1.flac', 'Music/Radiohead/Kid A/1.flac'),
    withPath('cover.jpg', 'Music/Radiohead/Kid A/cover.jpg'),
    withPath('.hidden.mp3', 'Music/.hidden.mp3'),
    withPath('ghost.mp3', 'Music/.cache/ghost.mp3'),
    withPath('loose.mp3', 'Music/loose.mp3'),
  ]);
  // The chosen folder's own name is stripped: paths are relative to the
  // library root either way in, so a folder view looks the same in both.
  assert.deepEqual(tracks.map((t) => t.path), ['Radiohead/Kid A/1.flac', 'loose.mp3']);
  assert.equal(tracks[0].folder, 'Radiohead/Kid A');
  assert.ok(handles.get('loose.mp3'));
});

test('flat-file names stay distinct without taking another file’s original or directory path', async () => {
  const files = [
    new File(['first'], 'Artist - Song.mp3'),
    new File(['second'], 'Artist - Song.mp3'),
    new File(['literal suffix'], 'Artist - Song (2).mp3'),
    Object.assign(new File(['directory suffix'], 'Artist - Song (3).mp3'), {
      webkitRelativePath: 'Music/Artist - Song (3).mp3',
    }),
    new File(['flat collision'], 'loose.mp3'),
    Object.assign(new File(['directory collision'], 'loose.mp3'), { webkitRelativePath: 'Music/loose.mp3' }),
  ];
  const published = new Map();
  const { tracks, handles } = await scanFileList('r', files, {
    batchSize: 1,
    onBatch: (batch, batchFiles) => {
      for (const track of batch) published.set(track.path, batchFiles.get(track.path));
    },
  });

  assert.equal(new Set(tracks.map((track) => track.key)).size, 6);
  assert.equal(handles.size, 6);
  assert.equal(published.size, 6);
  for (let i = 0; i < files.length; i++) {
    assert.equal(handles.get(tracks[i].path), files[i]);
    assert.equal(published.get(tracks[i].path), files[i]);
    assert.equal(tracks[i].name, files[i].name);
  }
  assert.equal(tracks[0].title, 'Song');
  assert.equal(tracks[1].title, 'Song');
  assert.equal(tracks[2].path, 'Artist - Song (2).mp3');
  assert.equal(tracks[3].path, 'Artist - Song (3).mp3');
  assert.equal(tracks[5].path, 'loose.mp3');
});

test('tracks are handed over while the walk runs, not all at the end', async () => {
  // The bug this exists for: a real music folder takes minutes to walk, and
  // a library that shows nothing until the last file is read looks exactly
  // like one that never started.
  const entries = {};
  for (let i = 0; i < 95; i++) entries[`${i}.mp3`] = file(`${i}.mp3`, new Uint8Array(16));
  const batches = [];
  const tracks = await scanDirectory('r', dir('M', entries), {
    batchSize: 40,
    onBatch: (batch) => batches.push(batch.length),
  });
  assert.equal(tracks.length, 95);
  // Two full batches during the walk, and the remainder at the end -- the
  // trailing partial batch is the one an off-by-one would swallow.
  assert.deepEqual(batches, [40, 40, 15]);
  assert.equal(batches.reduce((a, b) => a + b, 0), tracks.length);
});

test('a slow disk still reports in, on an interval rather than a count', async () => {
  const entries = {};
  for (let i = 0; i < 6; i++) entries[`${i}.mp3`] = file(`${i}.mp3`, new Uint8Array(16));
  let clock = 0;
  const batches = [];
  // Far below the batch size, so only the interval can be flushing these.
  await scanDirectory('r', dir('M', entries), {
    batchSize: 1000,
    batchMs: 100,
    now: () => { clock += 60; return clock; },
    onBatch: (batch) => batches.push(batch.length),
  });
  assert.ok(batches.length > 1, `expected several batches, got ${JSON.stringify(batches)}`);
  assert.equal(batches.reduce((a, b) => a + b, 0), 6);
});

test('a walk that is abandoned still hands over what it found', async () => {
  const entries = {};
  for (let i = 0; i < 20; i++) entries[`${i}.mp3`] = file(`${i}.mp3`, new Uint8Array(16));
  const signal = { aborted: false };
  const batches = [];
  const tracks = await scanDirectory('r', dir('M', entries), {
    batchSize: 1000,
    onProgress: (count) => { if (count === 5) signal.aborted = true; },
    onBatch: (batch) => batches.push(...batch),
    signal,
  });
  assert.equal(tracks.length, 5);
  // Those five were still read. Throwing them away because the walk was cut
  // short is the difference between a partial library and no library.
  assert.equal(batches.length, 5);
});

test('the batch handler is awaited, so its writes cannot be lapped', async () => {
  const entries = {};
  for (let i = 0; i < 80; i++) entries[`${i}.mp3`] = file(`${i}.mp3`, new Uint8Array(16));
  let inFlight = 0;
  let overlapped = false;
  await scanDirectory('r', dir('M', entries), {
    batchSize: 20,
    onBatch: async () => {
      if (inFlight > 0) overlapped = true;
      inFlight++;
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    },
  });
  assert.equal(overlapped, false);
});
