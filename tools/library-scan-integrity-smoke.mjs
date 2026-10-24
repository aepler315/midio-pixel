// Native IndexedDB scan integrity regressions. Only synthetic Files and an
// isolated origin-private directory are used. Every case has a fresh browser
// context; the loopback server exposes source JavaScript and one empty page.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return process.argv[index + 1];
}
const sourceRoot = path.resolve(argument('--source', repository));
const output = path.resolve(argument('--out', path.join(repository, '.smoke', `library-scan-integrity-${Date.now()}`, 'report.json')));
const selected = argument('--only')?.split(',') || null;
const timeoutMs = 15000;
const moduleNames = ['LibraryDB', 'LibraryScanner', 'MusicLibrary', 'AutoTag', 'TrackIndex']
  .map(name => `src/library/${name}.js`).concat('src/lyrics/SongIdentity.js');
// Freeze the complete import graph before launching: a source edit during a
// run cannot mix implementations or change the provenance of its report.
const modules = new Map(await Promise.all(moduleNames.map(async name =>
  [`/${name}`, await fs.readFile(path.join(sourceRoot, name))])));
const sourceSha256 = Object.fromEntries([...modules].map(([name, bytes]) =>
  [name.slice(1), createHash('sha256').update(bytes).digest('hex')]));
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta name="referrer" content="no-referrer"><title>Library scan integrity</title>');
    return;
  }
  if (!modules.has(pathname)) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(modules.get(pathname));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const checks = [], pageErrors = [];
let browser;
let launchOptions;

// These helpers run in each fresh page, with real browser IDB APIs. The queue
// blocker keeps a legal transaction alive by enqueuing its next get from the
// preceding get's success event. Observers never postpone request callbacks.
async function installFixture() {
  const db = await import('/src/library/LibraryDB.js');
  const { MusicLibrary } = await import('/src/library/MusicLibrary.js');
  const { trackRecord } = await import('/src/library/LibraryScanner.js');
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const file = (name = 'song.mp3', folder = 'Music') => {
    const result = new File([new Uint8Array(64)], name, { lastModified: 1 });
    Object.defineProperty(result, 'webkitRelativePath', { value: `${folder}/${name}` });
    return result;
  };
  const record = (rootId, path, patch = {}) => ({
    ...trackRecord({ rootId, path, file: file(path.split('/').at(-1)), nowMs: 11 }), ...patch,
  });
  const earned = { addedMs: 11, playCount: 7, lastPlayedMs: 1234, durationSec: 222.5,
    title: 'Earned title', artist: 'Earned artist', album: 'Earned album', year: 2001, tagSource: 'auto' };
  const assertEarned = row => {
    expect(!!row, 'earned row is missing');
    for (const [key, value] of Object.entries(earned)) expect(row[key] === value, `${key}: expected ${value}, got ${row[key]}`);
  };
  const seed = async (name = 'Music', paths = ['song.mp3']) => {
    const root = await db.addRoot({ name, persistable: false });
    expect(!!root, 'fixture root must commit');
    await db.putTracks(paths.map(path => record(root.id, path, earned)));
    return root;
  };
  const directory = files => ({ values: () => (async function* () {
    for (const value of files) yield { kind: 'file', name: value.name, getFile: async () => value };
  })() });
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('midio-library');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const settled = tx => new Promise(resolve => {
    tx.addEventListener('complete', () => resolve(true));
    tx.addEventListener('abort', () => resolve(false));
  });
  const blocker = async (stores = 'tracks') => {
    const connection = await open();
    const tx = connection.transaction(stores, 'readwrite'), finished = settled(tx);
    let keep = true, requests = 0;
    const store = tx.objectStore(Array.isArray(stores) ? stores[0] : stores);
    const pump = () => {
      const request = store.get('__native_queue_blocker__'); requests++;
      request.onsuccess = () => { if (keep) pump(); };
    };
    pump();
    const timer = setTimeout(() => { keep = false; }, 10000);
    return { release: async () => { keep = false; clearTimeout(timer); await finished; connection.close(); return requests; } };
  };
  const observe = (accept = () => true) => {
    const original = IDBDatabase.prototype.transaction;
    const events = [], waiters = [];
    IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
      const tx = original.call(this, stores, mode, ...rest);
      const event = { stores: Array.isArray(stores) ? [...stores] : [stores], mode: mode || 'readonly' };
      if (accept(event)) { events.push(event); for (const check of waiters) check(); }
      return tx;
    };
    return { events, wait: count => events.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push(() => { if (events.length >= count) resolve(); })),
      restore: () => { IDBDatabase.prototype.transaction = original; } };
  };
  const reload = async rootId => {
    const restored = new MusicLibrary(); await restored.init();
    return { rows: await db.listTracks(rootId), rootIds: (await db.listRoots()).map(root => root.id), restored };
  };
  window.fixture = { db, MusicLibrary, expect, file, record, earned, assertEarned, seed, directory, open, settled, blocker, observe, reload };
}

async function run(name, execute) {
  if (selected && !selected.includes(name)) return;
  // Chromium's incognito FileSystemHandle/IDB path can crash the browser.
  // The native handle control uses a new disposable regular profile, which
  // also exercises the handle's real structured-clone and reload behavior.
  const profile = name.includes('native-handle')
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'midio-library-native-handle-')) : null;
  const context = profile ? await chromium.launchPersistentContext(profile, launchOptions) : await browser.newContext();
  context.on('page', opened => opened.on('pageerror', error => pageErrors.push({ case: name, error: error.message })));
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  await page.goto(origin);
  await page.evaluate(installFixture);
  try {
    const detail = await Promise.race([execute({ context, page }), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`case exceeded ${timeoutMs}ms`)), timeoutMs); timer.unref();
    })]);
    checks.push({ name, passed: true, profile: profile ? 'fresh temporary persistent' : 'fresh incognito', ...detail });
  } catch (error) {
    const evidence = await page.evaluate(() => window.caseEvidence || null).catch(() => null);
    checks.push({ name, passed: false, error: error.message, ...(evidence ? { evidence } : {}) });
  }
  finally { await context.close(); if (profile) await fs.rm(profile, { recursive: true, force: true }); }
  const check = checks.at(-1);
  console.log(`${check.passed ? 'PASS' : 'FAIL'} ${name}${check.error ? `: ${check.error}` : ''}`);
}

try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
    || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null);
  launchOptions = { headless: true, ...(executablePath ? { executablePath } : {}), args: ['--mute-audio'] };
  browser = await chromium.launch(launchOptions);

  await run('native-getfile-failure', ({ page }) => page.evaluate(async () => {
    const { seed, MusicLibrary, assertEarned, reload, expect } = window.fixture;
    const root = await seed();
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle('getfile-fixture', { create: true });
    const handle = await dir.getFileHandle('song.mp3', { create: true });
    await dir.removeEntry('song.mp3'); // Native handle remains; native getFile now rejects.
    let nativeError;
    try { await handle.getFile(); } catch (error) { nativeError = error.name; }
    expect(nativeError === 'NotFoundError', `native getFile failure missing: ${nativeError}`);
    const lib = new MusicLibrary(); lib.root = root; lib.tracks = (await reload(root.id)).rows;
    lib.handle = { values: () => (async function* () { yield handle; })() };
    await lib.rescan();
    const durable = (await reload(root.id)).rows;
    window.caseEvidence = { nativeError, durable, memory: lib.tracks };
    assertEarned(durable[0]); assertEarned(lib.tracks[0]);
    return { nativeError, durableRows: durable.length, memoryRows: lib.tracks.length, earnedFields: Object.keys(window.fixture.earned).length };
  }));

  for (const kind of ['synchronous', 'native-iterator']) await run(`unreadable-directory-${kind}`, ({ page }) => page.evaluate(async kind => {
    const { seed, MusicLibrary, assertEarned, reload, expect } = window.fixture;
    const root = await seed('Music', ['Album/song.mp3']);
    let unreadable, nativeError = null;
    if (kind === 'native-iterator') {
      const opfs = await navigator.storage.getDirectory();
      unreadable = await opfs.getDirectoryHandle('Album', { create: true });
      await opfs.removeEntry('Album', { recursive: true });
      try { for await (const entry of unreadable.values()) void entry; } catch (error) { nativeError = error.name; }
      expect(nativeError === 'NotFoundError', `native iterator failure missing: ${nativeError}`);
    } else unreadable = { kind: 'directory', name: 'Album', values() { throw new DOMException('Fixture permission revoked', 'NotAllowedError'); } };
    const lib = new MusicLibrary(); lib.root = root; lib.tracks = (await reload(root.id)).rows;
    lib.handle = { values: () => (async function* () { yield unreadable; })() };
    let error = null;
    try { await lib.rescan(); } catch (failure) { error = failure.name; }
    const durable = (await reload(root.id)).rows;
    window.caseEvidence = { nativeError, serviceError: error, durable, memory: lib.tracks };
    assertEarned(durable[0]); assertEarned(lib.tracks[0]);
    expect(!lib.scanning, 'scan must unwind after directory failure');
    return { nativeError, serviceError: error, durableRows: durable.length, memoryRows: lib.tracks.length };
  }, kind));

  await run('old-read-new-write-old-delete', ({ page }) => page.evaluate(async () => {
    const { seed, MusicLibrary, file, directory, blocker, observe, reload, assertEarned } = window.fixture;
    const root = await seed();
    const lib = new MusicLibrary(); lib.root = root; lib.tracks = (await reload(root.id)).rows;
    let block, observed, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    lib.handle = { values: () => (async function* () {
      block = await blocker(); observed = observe(event => event.stores.includes('tracks')); entered(); yield* [];
    })() };
    const oldScan = lib.rescan(); await ready; await observed.wait(1);
    lib.cancel(); lib.handle = directory([file()]);
    const currentScan = lib.rescan(); await observed.wait(2);
    const blockerRequests = await block.release();
    await Promise.all([oldScan, currentScan]); observed.restore();
    const rows = (await reload(root.id)).rows;
    window.caseEvidence = { blockerRequests, transactions: observed.events, durable: rows, memory: lib.tracks };
    assertEarned(rows[0]); assertEarned(lib.tracks[0]);
    return { blockerRequests, transactions: observed.events, durableRows: rows.length, memoryRows: lib.tracks.length };
  }));

  await run('cancel-queued-prune', ({ page }) => page.evaluate(async () => {
    const { seed, MusicLibrary, blocker, observe, reload, assertEarned } = window.fixture;
    const root = await seed();
    const lib = new MusicLibrary(); lib.root = root; lib.tracks = (await reload(root.id)).rows;
    let block, observed, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    lib.handle = { values: () => (async function* () {
      block = await blocker(); observed = observe(event => event.stores.includes('tracks')); entered(); yield* [];
    })() };
    const scan = lib.rescan(); await ready; await observed.wait(1); lib.cancel();
    const blockerRequests = await block.release(); await scan; observed.restore();
    const rows = (await reload(root.id)).rows;
    window.caseEvidence = { blockerRequests, transactions: observed.events, durable: rows };
    assertEarned(rows[0]);
    return { blockerRequests, transactions: observed.events, durableRows: rows.length };
  }));

  await run('two-instance-latest-scan-owner', ({ page }) => page.evaluate(async () => {
    const { seed, MusicLibrary, file, directory, reload, assertEarned, expect } = window.fixture;
    const root = await seed('Music', ['old.mp3', 'new.mp3']);
    let release, reading;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reading = resolve; });
    const old = new MusicLibrary(); old.root = root;
    old.handle = { values: () => (async function* () { yield { kind: 'file', name: 'old.mp3', getFile: async () => { reading(); await gate; return file('old.mp3'); } }; })() };
    const oldScan = old.rescan(); await ready;
    const current = new MusicLibrary(); current.root = root; current.handle = directory([file('new.mp3')]);
    await current.rescan(); release(); await oldScan;
    const rows = (await reload(root.id)).rows;
    expect(rows.length === 1 && rows[0].path === 'new.mp3', `superseded scan changed durable owner: ${JSON.stringify(rows)}`);
    assertEarned(rows[0]);
    return { durablePaths: rows.map(row => row.path), currentPaths: current.tracks.map(row => row.path) };
  }));

  await run('removed-root-rejects-late-scan', ({ page }) => page.evaluate(async () => {
    const { seed, MusicLibrary, file, reload, expect } = window.fixture;
    const root = await seed();
    let release, reading;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reading = resolve; });
    const old = new MusicLibrary(); old.root = root;
    old.handle = { values: () => (async function* () { yield { kind: 'file', name: 'song.mp3', getFile: async () => { reading(); await gate; return file(); } }; })() };
    const scan = old.rescan(); await ready;
    const other = new MusicLibrary(); other.root = root; await other.forget();
    release(); await scan;
    const state = await reload(root.id);
    expect(state.rows.length === 0 && !state.rootIds.includes(root.id), `late scan created orphans: ${JSON.stringify({ rows: state.rows, rootIds: state.rootIds })}`);
    return { durableRows: state.rows.length, durableRoots: state.rootIds.length };
  }));

  for (const kind of ['file-list', 'native-handle']) await run(`root-save-abort-session-${kind}`, ({ page }) => page.evaluate(async kind => {
    const { db, MusicLibrary, file, expect } = window.fixture;
    const selected = file('session.mp3');
    let handle;
    if (kind === 'native-handle') {
      const opfs = await navigator.storage.getDirectory();
      handle = await opfs.getDirectoryHandle('SessionMusic', { create: true });
      const nativeFile = await handle.getFileHandle('session.mp3', { create: true });
      const writer = await nativeFile.createWritable(); await writer.write(new Uint8Array(64)); await writer.close();
    }
    let abortedRootWrites = 0;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (this.name === 'roots') request.addEventListener('success', () => {
        abortedRootWrites++; this.transaction.abort();
      });
      return request;
    };
    const lib = new MusicLibrary({ scope: { indexedDB, crypto, navigator,
      ...(handle ? { showDirectoryPicker: async () => handle } : {}) } });
    try { if (handle) await lib.pickFolder(); else await lib.adoptFileList([selected]); }
    finally { IDBObjectStore.prototype.put = original; }
    window.caseEvidence = { abortedRootWrites, root: lib.root, tracks: lib.tracks, scanResult: lib.scanResult, playable: lib.playable };
    expect(abortedRootWrites >= 2, `both actual root reservations must abort: ${abortedRootWrites}`);
    expect(lib.root?.id.startsWith('session:') && lib.tracks.length === 1 && lib.playable,
      `failed root save discarded session library: ${JSON.stringify(window.caseEvidence)}`);
    const opened = await lib.openFile(lib.tracks[0]);
    expect(opened instanceof File && opened.name === 'session.mp3' && opened.size === 64, 'session source must still open as an actual File');
    if (!handle) expect(opened === selected, 'file-list fallback must retain the selected File');
    expect(lib.scanResult.complete && !lib.scanResult.stored && !lib.scanResult.stale, `session status: ${JSON.stringify(lib.scanResult)}`);
    const saved = await lib.notePlayed(lib.tracks[0], 99);
    expect(saved === false && lib.tracks[0].playCount === 1 && lib.tracks[0].durationSec === 99 && lib.tracks[0].unsaved,
      `session play must remain usable and marked unsaved: ${JSON.stringify(lib.tracks[0])}`);
    expect((await db.listRoots()).length === 0 && (await db.listTracks()).length === 0, 'failed root reservations must not create roots or orphan tracks');
    return { abortedRootWrites, actualFile: true, sessionRows: lib.tracks.length, sessionPlayCount: lib.tracks[0].playCount, markedUnsaved: true, durableRoots: 0, durableRows: 0 };
  }, kind));

  await run('stale-instance-cannot-start-scan-of-reused-root-id', ({ page }) => page.evaluate(async () => {
    const { db, seed, MusicLibrary, file, directory, reload, assertEarned, expect, earned } = window.fixture;
    const original = await seed('Music', ['old.mp3']);
    const old = new MusicLibrary(); old.root = original; old.handle = directory([file('old.mp3')]); old.tracks = (await reload(original.id)).rows;
    const other = new MusicLibrary(); other.root = original; await other.forget();
    const replacement = new MusicLibrary(); await replacement.adoptFileList([file('replacement.mp3')]);
    expect(replacement.root.id === original.id, `fixture must reuse legacy ID: ${original.id} => ${replacement.root.id}`);
    expect(replacement.root.identityRevision !== original.identityRevision, 'replacement must have a different physical root identity');
    await db.updateTrack(replacement.tracks[0].key, earned);
    await old.rescan(); // The stale instance asks for a NEW token after replacement.
    const rows = (await reload(replacement.root.id)).rows;
    window.caseEvidence = { originalIdentity: original.identityRevision, replacementIdentity: replacement.root.identityRevision,
      durable: rows, oldScanResult: old.scanResult };
    expect(rows.length === 1 && rows[0].path === 'replacement.mp3', `stale instance overwrote replacement: ${JSON.stringify(window.caseEvidence)}`);
    assertEarned(rows[0]); expect(old.scanResult.stale && !old.scanResult.stored, `stale root obtained new scan ownership: ${JSON.stringify(old.scanResult)}`);
    return { reusedRootId: original.id, distinctIdentityRevisions: true, durablePaths: rows.map(row => row.path), oldScanStale: old.scanResult.stale };
  }));

  await run('completed-scan-prunes-genuinely-missing-file', ({ page }) => page.evaluate(async () => {
    const { seed, MusicLibrary, file, directory, reload, assertEarned, expect } = window.fixture;
    const root = await seed('Music', ['song.mp3', 'removed.mp3']);
    const lib = new MusicLibrary(); lib.root = root; lib.handle = directory([file()]);
    await lib.rescan();
    const rows = (await reload(root.id)).rows;
    expect(rows.length === 1 && rows[0].path === 'song.mp3', `completed scan failed to prune: ${JSON.stringify(rows)}`);
    assertEarned(rows[0]); assertEarned(lib.tracks[0]);
    return { durablePaths: rows.map(row => row.path), removedPaths: ['removed.mp3'] };
  }));

  // Actual independent same-origin pages, not two objects in one JS realm.
  for (const scenario of ['concurrent-same-name', 'sequential-same-name', 'concurrent-different-name', 'concurrent-same-native-handle']) {
    await run(`two-tabs-${scenario}`, async ({ context, page: coordinator }) => {
      const a = await context.newPage(), b = await context.newPage();
      await Promise.all([a.goto(origin), b.goto(origin)]);
      await Promise.all([a.evaluate(installFixture), b.evaluate(installFixture)]);
      await coordinator.evaluate(async () => {
        const root = await window.fixture.seed('Initializer', []); await window.fixture.db.removeRoot(root.id);
      });
      const concurrent = scenario.startsWith('concurrent');
      if (concurrent) await coordinator.evaluate(async () => { window.rootBlocker = await window.fixture.blocker('roots'); });
      for (const tab of [a, b]) await tab.evaluate(() => {
        window.rootObserver = window.fixture.observe(event => event.stores.includes('roots'));
        window.lib = new window.fixture.MusicLibrary();
      });
      const start = (tab, filename, folder, native) => tab.evaluate(async ({ filename, folder, native }) => {
        if (native) {
          const opfs = await navigator.storage.getDirectory();
          const handle = await opfs.getDirectoryHandle('SharedMusic', { create: true });
          await handle.getFileHandle('shared.mp3', { create: true });
          window.lib = new window.fixture.MusicLibrary({ scope: { indexedDB, crypto, navigator, showDirectoryPicker: async () => handle } });
          window.adoption = window.lib.pickFolder();
        } else window.adoption = window.lib.adoptFileList([window.fixture.file(filename, folder)]);
      }, { filename, folder, native });
      const native = scenario === 'concurrent-same-native-handle';
      await start(a, 'a.mp3', 'Music', native);
      if (!concurrent) await a.evaluate(() => window.adoption.then(() => true));
      await start(b, 'b.mp3', scenario === 'concurrent-different-name' ? 'OtherMusic' : 'Music', native);
      if (concurrent) {
        await Promise.all([a.evaluate(() => window.rootObserver.wait(1)), b.evaluate(() => window.rootObserver.wait(1))]);
        await coordinator.evaluate(() => window.rootBlocker.release());
      }
      const capture = tab => tab.evaluate(async native => {
        await window.adoption; window.rootObserver.restore(); const lib = window.lib;
        const playable = await Promise.all(lib.tracks.map(async row => !!await lib.openFile(row)));
        // Two scans of one physical root have one durable owner. A superseded
        // tab may retain an empty view until reload; live tab sync is outside
        // this control. Distinct file-list picks each own a complete view.
        window.fixture.expect(playable.every(Boolean) && (native ? lib.tracks.length <= 1 : lib.tracks.length === 1),
          `adopted view is not playable: ${JSON.stringify({ paths: lib.tracks.map(row => row.path), playable })}`);
        if (lib.tracks[0]) await window.fixture.db.updateTrack(lib.tracks[0].key, window.fixture.earned);
        return { rootId: lib.root.id, paths: lib.tracks.map(row => row.path),
          actualFile: lib.tracks[0] ? (await lib.openFile(lib.tracks[0])) instanceof File : null };
      }, native);
      const [left, right] = await Promise.all([capture(a), capture(b)]);
      if (native) assert.ok(left.actualFile || right.actualFile, 'the current native scan must have an actual File');
      else { assert.equal(left.actualFile, true); assert.equal(right.actualFile, true); }
      await coordinator.reload(); await coordinator.evaluate(installFixture);
      const durable = await coordinator.evaluate(async () => {
        const roots = await window.fixture.db.listRoots(), rows = await window.fixture.db.listTracks();
        for (const row of rows) window.fixture.assertEarned(row);
        const restored = new window.fixture.MusicLibrary(); await restored.init();
        return { rootIds: roots.map(root => root.id), rows: rows.map(row => ({ rootId: row.rootId, path: row.path })), restoredRows: restored.tracks.length,
          persistedNativeHandles: roots.filter(root => root.persistable && root.handle instanceof FileSystemDirectoryHandle).length };
      });
      if (native) {
        assert.equal(left.rootId, right.rootId, 'same native handle must have one identity');
        assert.equal(durable.rootIds.length, 1); assert.equal(durable.rows.length, 1);
        assert.equal(durable.persistedNativeHandles, 1);
      } else {
        assert.notEqual(left.rootId, right.rootId, 'independent folder picks must have distinct identities');
        assert.equal(durable.rootIds.length, 2); assert.equal(durable.rows.length, 2);
        assert.ok(durable.rows.some(row => row.rootId === left.rootId && row.path === 'a.mp3'));
        assert.ok(durable.rows.some(row => row.rootId === right.rootId && row.path === 'b.mp3'));
      }
      return { independentPages: 2, nativeDirectoryHandles: native, left, right, durable };
    });
  }

  for (const operation of ['batch', 'prune', 'begin']) await run(`native-late-abort-${operation}`, ({ page }) => page.evaluate(async operation => {
    const { db, seed, record, expect, reload, assertEarned } = window.fixture;
    expect(typeof db.beginRootScan === 'function', 'durable scan protocol is unavailable');
    const root = await seed(), begun = await db.beginRootScan(root.id);
    expect(begun.status === 'committed', JSON.stringify(begun));
    const original = IDBObjectStore.prototype[operation === 'prune' ? 'delete' : 'put'];
    const method = operation === 'prune' ? 'delete' : 'put';
    let aborted = false;
    IDBObjectStore.prototype[method] = function (...args) {
      const request = original.apply(this, args);
      if (this.name === (operation === 'begin' ? 'roots' : 'tracks')) {
        request.addEventListener('success', () => { if (!aborted) { aborted = true; this.transaction.abort(); } });
      }
      return request;
    };
    let result;
    try {
      result = operation === 'begin' ? await db.beginRootScan(root.id)
        : operation === 'prune' ? await db.pruneScanTracks(begun.token, [])
          : await db.putScanTracks(begun.token, [record(root.id, 'song.mp3', { album: 'Must roll back' })]);
    } finally { IDBObjectStore.prototype[method] = original; }
    expect(aborted && result.status === 'unavailable', `abort must report unavailable: ${JSON.stringify(result)}`);
    assertEarned((await reload(root.id)).rows[0]);
    return { abortedAfterRequestSuccess: aborted, status: result.status, durableRows: 1 };
  }, operation));

  await run('native-queued-batch-cancellation', ({ page }) => page.evaluate(async () => {
    const { db, seed, record, blocker, observe, reload, assertEarned, expect } = window.fixture;
    expect(typeof db.beginRootScan === 'function', 'durable scan protocol is unavailable');
    const root = await seed(), begun = await db.beginRootScan(root.id);
    const block = await blocker(), observed = observe(event => event.stores.includes('tracks'));
    const controller = new AbortController();
    const pending = db.putScanTracks(begun.token, [record(root.id, 'song.mp3', { album: 'Must not commit' })], globalThis, { signal: controller.signal });
    await observed.wait(1); controller.abort();
    const blockerRequests = await block.release(), result = await pending; observed.restore();
    expect(result.status === 'stale', `cancelled queued write reported ${JSON.stringify(result)}`);
    assertEarned((await reload(root.id)).rows[0]);
    return { status: result.status, blockerRequests, durableRows: 1 };
  }));

  await run('native-scan-clone-failure-rolls-back-batch', ({ page }) => page.evaluate(async () => {
    const { db, seed, record, reload, assertEarned, expect } = window.fixture;
    expect(typeof db.beginRootScan === 'function', 'durable scan protocol is unavailable');
    const root = await seed('Music', ['song.mp3', 'other.mp3']), begun = await db.beginRootScan(root.id);
    const result = await db.putScanTracks(begun.token, [
      record(root.id, 'song.mp3', { album: 'Must roll back' }), record(root.id, 'other.mp3', { uncloneable: () => {} }),
    ]);
    expect(result.status === 'unavailable', `clone failure reported ${JSON.stringify(result)}`);
    const rows = (await reload(root.id)).rows; rows.forEach(assertEarned);
    return { status: result.status, durableRows: rows.length, rolledBackEarlierWrite: true };
  }));

  await run('v1-upgrade-preserves-earned-metadata', ({ page }) => page.evaluate(async () => {
    const { expect, record, earned, assertEarned } = window.fixture;
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('midio-library', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('roots', { keyPath: 'id' });
        database.createObjectStore('tracks', { keyPath: 'key' }).createIndex('rootId', 'rootId');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const connection = request.result, tx = connection.transaction(['roots', 'tracks'], 'readwrite');
        tx.objectStore('roots').put({ id: 'root:legacy', name: 'Legacy Music', handle: null, persistable: false, addedMs: 3, lastSelectedMs: 4 });
        tx.objectStore('tracks').put(record('root:legacy', 'legacy.mp3', earned));
        tx.oncomplete = () => { connection.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    });
    const { db, MusicLibrary } = window.fixture;
    const lib = new MusicLibrary(); await lib.init();
    expect(lib.root?.id === 'root:legacy' && lib.root.addedMs === 3, `legacy root changed: ${JSON.stringify(lib.root)}`);
    assertEarned(lib.tracks[0]);
    expect(typeof db.beginRootScan === 'function', 'durable scan protocol is unavailable');
    const begun = await db.beginRootScan(lib.root.id); expect(begun.status === 'committed', JSON.stringify(begun));
    const oldVersionError = await new Promise(resolve => {
      const request = indexedDB.open('midio-library', 1);
      request.onerror = () => resolve(request.error.name);
      request.onsuccess = () => { request.result.close(); resolve(null); };
    });
    expect(oldVersionError === 'VersionError', `old version must be fenced: ${oldVersionError}`);
    assertEarned((await db.listTracks(lib.root.id))[0]);
    return { originalRootId: lib.root.id, originalAddedMs: lib.root.addedMs, oldVersionError, durableRows: 1 };
  }));

  await run('blocked-upgrade-closes-late-success', ({ page }) => page.evaluate(async () => {
    const { db, expect } = window.fixture;
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open('midio-library', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('roots', { keyPath: 'id' });
        request.result.createObjectStore('tracks', { keyPath: 'key' }).createIndex('rootId', 'rootId');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const originalOpen = IDBFactory.prototype.open, originalClose = IDBDatabase.prototype.close;
    let blocked, succeeded, lateConnection;
    const blockedEvent = new Promise(resolve => { blocked = resolve; });
    const lateSuccess = new Promise(resolve => { succeeded = resolve; });
    const closed = new Set();
    IDBFactory.prototype.open = function (name, version) {
      const request = originalOpen.call(this, name, version);
      if (version === 2) {
        request.addEventListener('blocked', blocked);
        request.addEventListener('success', () => { lateConnection = request.result; succeeded(); });
      }
      return request;
    };
    IDBDatabase.prototype.close = function () { closed.add(this); return originalClose.call(this); };
    try {
      const pending = db.listRoots(); await blockedEvent;
      expect((await pending).length === 0, 'blocked upgrade must return its unavailable fallback');
      legacy.close(); await lateSuccess;
      const version3 = await new Promise((resolve, reject) => {
        const request = indexedDB.open('midio-library', 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('late-success connection blocks a subsequent upgrade'));
      });
      expect(closed.has(lateConnection), 'a success arriving after blocked fallback leaked its connection');
      version3.close();
      return { blockedFallback: true, lateSuccessClosed: true, subsequentVersion3Opened: true };
    } finally {
      legacy.close(); IDBFactory.prototype.open = originalOpen; IDBDatabase.prototype.close = originalClose;
    }
  }));

  const report = { passed: checks.length > 0 && checks.every(check => check.passed) && pageErrors.length === 0,
    browser: await browser.version(), runtime: process.version, sourceRoot, sourceSha256,
    scope: 'Headless Chromium native IndexedDB, synthetic Files, isolated OPFS, independent same-origin pages; no picker, user audio, app rendering, or physical device.',
    queueOrdering: 'Native requests and native callbacks; keepalive gets enqueue only from native success handlers. No delayed/replaced IDB request callbacks.',
    checks, pageErrors };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Chromium ${report.browser}: ${checks.filter(check => check.passed).length}/${checks.length} checks passed. Report: ${output}`);
  assert.deepEqual(pageErrors, []); assert.equal(report.passed, true, 'library scan integrity regression failed');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
