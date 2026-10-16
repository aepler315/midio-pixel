// Real Chromium IndexedDB isolation and rollback regression. The server serves
// only source modules and an empty page; the browser context owns synthetic
// library rows and Files, with no access to a user's database or audio.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const output = outIndex >= 0 ? process.argv[outIndex + 1] : null;
if (outIndex >= 0 && !output) throw new Error('--out needs a report path');
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Library transaction regression</title>');
    return;
  }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}/src/`) || !file.endsWith('.js')) {
    res.writeHead(404); res.end(); return;
  }
  try {
    const source = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(source);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
    || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const report = await page.evaluate(async () => {
    const db = await import('/src/library/LibraryDB.js');
    const { MusicLibrary } = await import('/src/library/MusicLibrary.js');
    const checks = [];
    const connections = { opened: 0, closed: 0, active: 0, peak: 0 };
    const live = new WeakSet();
    const originalOpen = IDBFactory.prototype.open;
    const originalClose = IDBDatabase.prototype.close;
    IDBFactory.prototype.open = function (...args) {
      const request = originalOpen.apply(this, args);
      request.addEventListener('success', () => {
        live.add(request.result);
        connections.opened++; connections.active++;
        connections.peak = Math.max(connections.peak, connections.active);
      });
      return request;
    };
    IDBDatabase.prototype.close = function (...args) {
      if (live.delete(this)) { connections.closed++; connections.active--; }
      return originalClose.apply(this, args);
    };
    const expect = (condition, detail) => { if (!condition) throw new Error(detail); };
    const run = async (name, work) => {
      try { checks.push({ name, passed: true, detail: await work() }); }
      catch (error) { checks.push({ name, passed: false, error: error.message }); }
    };
    const track = (path, fields = {}) => ({
      key: `regression\u0000${path}`, rootId: 'regression', path, folder: '', name: path,
      ext: 'mp3', size: 64, lastModified: 1, addedMs: 1,
      title: 'Fixture Song', artist: null, album: null, year: null,
      tagSource: 'filename', durationSec: null, playCount: 0, lastPlayedMs: 0, ...fields,
    });
    const stored = async key => (await db.listTracks()).find(row => row.key === key);
    const seed = async row => {
      expect((await db.putTracks([row]))?.length === 1, 'synthetic row must commit before the regression');
      return { ...row };
    };
    const directory = file => ({
      name: 'Regression', queryPermission: async () => 'granted',
      values: async function* () { yield { kind: 'file', name: file.name, getFile: async () => file }; },
      getFileHandle: async name => {
        if (name !== file.name) throw new Error('NotFoundError');
        return { getFile: async () => file };
      },
    });
    const tagFetch = async () => ({ ok: true, json: async () => ({ recordings: [{
      score: 98, title: 'Fixture Song', 'artist-credit': [{ name: 'Fetched artist' }],
      releases: [{ title: 'Fetched album', date: '1999-01-01' }],
    }] }) });
    const abortAfterPut = async work => {
      const original = IDBObjectStore.prototype.put;
      let injected = 0;
      IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === 'tracks' && !injected) {
          injected++;
          request.addEventListener('success', () => this.transaction.abort(), { once: true });
        }
        return request;
      };
      try {
        const result = await work();
        expect(injected === 1, 'late abort must follow a real put success');
        return result;
      } finally { IDBObjectStore.prototype.put = original; }
    };
    await run('single/single disjoint patches survive 10 races', async () => {
      for (let i = 0; i < 10; i++) {
        const row = await seed(track(`single-${i}.mp3`));
        const results = await Promise.all([
          db.updateTrack(row.key, { title: `Title ${i}` }),
          db.updateTrack(row.key, { artist: `Artist ${i}` }),
        ]);
        const actual = await stored(row.key);
        expect(results.every(Boolean) && actual.title === `Title ${i}` && actual.artist === `Artist ${i}`,
          `race ${i}: ${JSON.stringify({ results, title: actual.title, artist: actual.artist })}`);
      }
      return { races: 10 };
    });
    await run('single/batch disjoint patches survive 10 races', async () => {
      for (let i = 0; i < 10; i++) {
        const row = await seed(track(`batch-${i}.mp3`));
        const results = await Promise.all([
          db.updateTrack(row.key, { durationSec: 100 + i }),
          db.updateTracks([{ key: row.key, album: `Album ${i}` }]),
        ]);
        const actual = await stored(row.key);
        expect(results[0] === true && results[1] === 1 && actual.durationSec === 100 + i && actual.album === `Album ${i}`,
          `race ${i}: ${JSON.stringify({ results, durationSec: actual.durationSec, album: actual.album })}`);
      }
      return { races: 10 };
    });
    await run('scan/tag/play reducers preserve earned fields in 10 races', async () => {
      for (let i = 0; i < 10; i++) {
        const row = await seed(track(`scan-${i}.mp3`, { playCount: 4 }));
        const lib = new MusicLibrary(); lib.tracks = [row];
        await Promise.all([
          db.updateTracks([{ key: row.key, title: 'Fixture Song', artist: 'Fetched artist', album: 'Fetched album', tagSource: 'auto' }]),
          db.putTracks([track(row.path)]),
          lib.notePlayed(row, 213.5),
        ]);
        const actual = await stored(row.key);
        expect(actual.playCount === 5 && actual.durationSec === 213.5 && actual.artist === 'Fetched artist' && actual.album === 'Fetched album' && actual.tagSource === 'auto',
          `race ${i}: ${JSON.stringify(actual)}`);
      }
      return { races: 10 };
    });
    await run('actual rescan/autotag/play overlap reconciles current memory', async () => {
      const file = new File([new Uint8Array(64)], 'Fixture Song.mp3', { lastModified: 1 });
      const row = track(file.name, { rootId: 'actual-scan', key: `actual-scan\u0000${file.name}`, playCount: 7 });
      const stale = await seed(row);
      const lib = new MusicLibrary({ fetchFn: tagFetch });
      lib.root = { id: row.rootId, name: 'Regression' }; lib.handle = directory(file); lib.tracks = [{ ...stale }];
      const before = [...new Uint8Array(await file.arrayBuffer())];
      await Promise.all([lib.autoTag(), lib.rescan(), lib.notePlayed(stale, 222)]);
      const actual = await stored(row.key), current = lib.tracks[0];
      expect(actual.playCount === 8 && actual.durationSec === 222 && actual.album === 'Fetched album' && actual.tagSource === 'auto', JSON.stringify(actual));
      expect(current.playCount === actual.playCount && current.durationSec === actual.durationSec && current.album === actual.album && !current.unsaved,
        `memory disagrees: ${JSON.stringify(current)}`);
      expect(JSON.stringify(before) === JSON.stringify([...new Uint8Array(await file.arrayBuffer())]), 'scanner must leave source audio unchanged');
      return { playCount: actual.playCount, album: actual.album, sourceBytesUnchanged: true };
    });
    await run('two plays through separate stale rows increment twice', async () => {
      const row = await seed(track('two-plays.mp3', { playCount: 7 }));
      const lib = new MusicLibrary(); lib.tracks = [{ ...row }];
      const a = { ...row }, b = { ...row };
      const results = await Promise.all([lib.notePlayed(a, 100), lib.notePlayed(b, 101)]);
      const actual = await stored(row.key);
      expect(actual.playCount === 9 && lib.tracks[0].playCount === 9 && results.every(value => value === true),
        JSON.stringify({ results, stored: actual.playCount, memory: lib.tracks[0].playCount }));
      return { stored: actual.playCount, memory: lib.tracks[0].playCount };
    });
    await run('duplicate patches compose in input order', async () => {
      const row = await seed(track('duplicate-patches.mp3'));
      const count = await db.updateTracks([
        { key: row.key, title: 'First' }, { key: row.key, artist: 'Fetched' }, { key: row.key, title: 'Last' },
      ]);
      const actual = await stored(row.key);
      expect(count === 1 && actual.title === 'Last' && actual.artist === 'Fetched', JSON.stringify({ count, actual }));
      return { count, title: actual.title, artist: actual.artist };
    });
    await run('duplicate scan records return one final committed row', async () => {
      const rows = await db.putTracks([
        track('duplicate-scan.mp3', { title: 'Fetched', tagSource: 'auto', playCount: 3 }),
        track('duplicate-scan.mp3'),
      ]);
      const actual = await stored(rows[0].key);
      expect(rows.length === 1 && rows[0].title === 'Fetched' && actual.title === 'Fetched' && actual.playCount === 3,
        JSON.stringify({ rows, actual }));
      return { rows: rows.length, playCount: actual.playCount };
    });
    for (const kind of ['single', 'batch', 'scan']) await run(`${kind} late abort reports failure and rolls back`, async () => {
      const row = await seed(track(`abort-${kind}.mp3`));
      const result = await abortAfterPut(() => kind === 'single'
        ? db.updateTrack(row.key, { album: 'Rolled back' })
        : kind === 'batch' ? db.updateTracks([{ key: row.key, album: 'Rolled back' }])
          : db.putTracks([{ ...row, album: 'Rolled back' }]));
      const actual = await stored(row.key);
      expect(result === (kind === 'single' ? false : kind === 'batch' ? 0 : null) && JSON.stringify(actual) === JSON.stringify(row),
        JSON.stringify({ result, album: actual.album }));
      return { result, unchanged: true };
    });
    for (const kind of ['batch', 'scan']) await run(`${kind} synchronous clone failure rolls back earlier queued writes`, async () => {
      const a = await seed(track(`clone-${kind}-a.mp3`)), b = await seed(track(`clone-${kind}-b.mp3`));
      const result = kind === 'batch'
        ? await db.updateTracks([{ key: a.key, album: 'Rolled back' }, { key: b.key, bad: () => {} }])
        : await db.putTracks([{ ...a, album: 'Rolled back' }, { ...b, bad: () => {} }]);
      expect(result === (kind === 'batch' ? 0 : null) && (await stored(a.key)).album === null && (await stored(b.key)).album === null,
        JSON.stringify({ result, firstAlbum: (await stored(a.key)).album }));
      return { result, unchanged: true };
    });
    await run('aborted play retains a marked session edit', async () => {
      const row = await seed(track('memory-play.mp3'));
      const lib = new MusicLibrary(); lib.tracks = [row];
      const result = await abortAfterPut(() => lib.notePlayed(row, 180));
      const actual = await stored(row.key);
      expect(result === false && actual.playCount === 0 && row.playCount === 1 && row.unsaved === true,
        JSON.stringify({ result, stored: actual.playCount, memory: row.playCount, unsaved: row.unsaved }));
      return { result, stored: actual.playCount, memory: row.playCount, unsaved: row.unsaved };
    });
    await run('aborted autotag remains marked after a committed play', async () => {
      const row = await seed(track('memory-tags.mp3'));
      const lib = new MusicLibrary({ fetchFn: tagFetch }); lib.tracks = [row];
      await abortAfterPut(() => lib.autoTag());
      const actual = await stored(row.key);
      expect(row.album === 'Fetched album' && row.unsaved === true && actual.album === null,
        JSON.stringify({ memory: row.album, unsaved: row.unsaved, stored: actual.album }));
      await lib.notePlayed(row, 180);
      expect(row.unsaved === true && (await stored(row.key)).album === null, 'a committed play must not clear unsaved tags');
      return { memory: row.album, unsaved: row.unsaved, stored: actual.album };
    });
    await run('aborted rescan preserves history and a playable marked row', async () => {
      const file = new File([new Uint8Array(64)], 'Failed scan.mp3', { lastModified: 1 });
      const row = await seed(track(file.name, { rootId: 'failed-scan', key: `failed-scan\u0000${file.name}`, playCount: 7, durationSec: 150 }));
      const lib = new MusicLibrary(); lib.root = { id: row.rootId }; lib.handle = directory(file); lib.tracks = [row];
      await abortAfterPut(() => lib.rescan());
      const current = lib.tracks[0], actual = await stored(row.key);
      expect(current.playCount === 7 && current.durationSec === 150 && current.unsaved === true && actual.playCount === 7 && lib.scanning === false,
        JSON.stringify({ memory: current, stored: actual }));
      expect(await lib.openFile(current) === file, 'the failed-save row must still open its source File');
      return { playCount: current.playCount, unsaved: current.unsaved, scanning: lib.scanning, playable: true };
    });
    await run('all opened library connections close after success and failure', async () => {
      expect(connections.opened > 0 && connections.opened === connections.closed && connections.active === 0, JSON.stringify(connections));
      return connections;
    });
    IDBFactory.prototype.open = originalOpen; IDBDatabase.prototype.close = originalClose;
    return { checks, connections };
  });
  report.browser = await browser.version(); report.pageErrors = pageErrors;
  report.passed = report.checks.every(check => check.passed) && pageErrors.length === 0;
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  for (const check of report.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.error ? `: ${check.error}` : ''}`);
  console.log(`Chromium ${report.browser}: ${report.checks.filter(check => check.passed).length}/${report.checks.length} checks passed; ${report.connections.opened} opens, ${report.connections.closed} closes.`);
  assert.deepEqual(pageErrors, []);
  assert.equal(report.passed, true, 'library transaction browser regression failed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
