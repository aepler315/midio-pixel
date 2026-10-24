import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertLoopbackSlskdUrl,
  BUNDLED_SLSKD_KEY,
  findTransfer,
  isTerminalTransfer,
  locateSlskdDownload,
  pathsInsideDownloads,
  readBoundedFile,
  realFileInsideDownloads,
  transfersFor,
} from '../tools/soulseek-bridge.mjs';
import { contentDisposition } from '../tools/lib/content-disposition.mjs';

test('bundled slskd does not fall back to a repository-shipped API key', () => {
  assert.equal(BUNDLED_SLSKD_KEY, '');
});

test('assertLoopbackSlskdUrl accepts only loopback http(s) hosts', () => {
  assert.equal(assertLoopbackSlskdUrl('http://127.0.0.1:5030'), 'http://127.0.0.1:5030');
  assert.equal(assertLoopbackSlskdUrl('http://localhost:5030/'), 'http://localhost:5030');
  assert.equal(assertLoopbackSlskdUrl('http://[::1]:5030'), 'http://[::1]:5030');
  assert.throws(() => assertLoopbackSlskdUrl('http://10.0.0.5:5030'), /local/);
  assert.throws(() => assertLoopbackSlskdUrl('http://example.com'), /local/);
  assert.throws(() => assertLoopbackSlskdUrl('file:///etc/passwd'), /http/);
  assert.throws(() => assertLoopbackSlskdUrl('http://user:pass@127.0.0.1:5030'), /credentials/);
  assert.throws(() => assertLoopbackSlskdUrl('http://127.0.0.1:5030/?key=secret'), /query/);
  assert.throws(() => assertLoopbackSlskdUrl('not a url'), /not valid/);
});

test('pathsInsideDownloads never escapes the downloads root', () => {
  const root = path.resolve('/tmp/midio-dl-root');
  const safe = pathsInsideDownloads(root, 'track.mp3');
  assert.equal(safe.length, 1);
  assert.equal(safe[0], path.join(root, 'track.mp3'));

  // Most specific first, so a same-named file at the root never wins.
  const nested = pathsInsideDownloads(root, 'artist/track.mp3');
  assert.deepEqual(nested, [
    path.join(root, 'artist', 'track.mp3'),
    path.join(root, 'track.mp3'),
  ]);

  // Traversal segments are dropped; only the basename may be read, and only
  // inside dlRoot. That is containment, not an escape.
  const escaped = pathsInsideDownloads(root, '../../../etc/passwd');
  assert.deepEqual(escaped, [path.join(root, 'passwd')]);

  const abs = pathsInsideDownloads(root, '/etc/passwd');
  assert.deepEqual(abs, [path.join(root, 'etc', 'passwd'), path.join(root, 'passwd')]);

  for (const hostile of ['..', '.', 'a/..', 'C:\\Windows\\..', '']) {
    for (const candidate of pathsInsideDownloads(root, hostile)) {
      const relative = path.relative(root, candidate);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${hostile} -> ${candidate}`);
    }
  }
});

test('slskd remote paths resolve to the folder slskd actually writes', () => {
  const root = path.resolve('/tmp/midio-dl-root');
  // slskd stores <downloads>/<last remote directory>/<file>.
  assert.deepEqual(pathsInsideDownloads(root, '@@share\\A\\B\\file.mp3'), [
    path.join(root, 'B', 'file.mp3'),
    path.join(root, '@@share', 'A', 'B', 'file.mp3'),
    path.join(root, 'file.mp3'),
  ]);
  // ':' is an ordinary name character for slskd on Linux, and becomes '_'
  // when slskd runs on Windows; neither may drop the folder candidate.
  const colon = pathsInsideDownloads(root, '@@share\\Artist\\Album: Deluxe\\01 Intro: Live.flac');
  if (process.platform === 'win32') {
    assert.equal(colon[0], path.join(root, 'Album_ Deluxe', '01 Intro_ Live.flac'));
  } else {
    assert.equal(colon[0], path.join(root, 'Album: Deluxe', '01 Intro: Live.flac'));
  }
});

async function downloadsFixture(t) {
  const fsp = await import('node:fs/promises');
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'midio-slskd-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'downloads');
  await fsp.mkdir(path.join(root, 'CD1'), { recursive: true });
  const write = async (rel, body, ageMs = 0) => {
    const file = path.join(root, rel);
    await fsp.writeFile(file, body);
    if (ageMs) { const when = new Date(Date.now() - ageMs); await fsp.utimes(file, when, when); }
    return file;
  };
  return { fsp, base, root, write };
}

test('the located file is this transfer\'s: fresh, complete, inside the root', async (t) => {
  const { fsp, base, root, write } = await downloadsFixture(t);
  const remote = '@@b\\ArtistB\\CD1\\01 Intro.mp3';
  const startedMs = Date.now() - 1000;
  // An earlier download of a different song with the same folder and name.
  await write('CD1/01 Intro.mp3', 'ArtistA, an older transfer', 60_000);
  await write('01 Intro.mp3', 'a same-named file at the root', 60_000);
  const wantBytes = 'ArtistB, this transfer!';
  assert.equal(locateSlskdDownload(root, remote, { size: wantBytes.length, notBeforeMs: startedMs }), null,
    'nothing fresh yet: the old files never stand in');
  // slskd's default exists-strategy renames the new file beside the old one.
  const partial = await write('CD1/01 Intro_638655301234567890.mp3', wantBytes.slice(0, 7));
  assert.equal(locateSlskdDownload(root, remote, { size: wantBytes.length, notBeforeMs: startedMs }), null,
    'a file still being copied is refused by size');
  await fsp.writeFile(partial, wantBytes);
  const found = locateSlskdDownload(root, remote, { size: wantBytes.length, notBeforeMs: startedMs });
  assert.equal(await fsp.readFile(found.path, 'utf8'), wantBytes);

  // Unknown size: the file must hold still across two polls.
  const sizes = new Map();
  assert.equal(locateSlskdDownload(root, remote, { notBeforeMs: startedMs, sizes }), null);
  assert.equal(locateSlskdDownload(root, remote, { notBeforeMs: startedMs, sizes })?.path, found.path);

  // A symlink that leads out of the root is never read.
  await fsp.writeFile(path.join(base, 'secret.mp3'), 'outside');
  await fsp.mkdir(path.join(root, 'Leak'));
  await fsp.symlink(path.join(base, 'secret.mp3'), path.join(root, 'Leak', 'secret.mp3'), 'file');
  assert.equal(realFileInsideDownloads(root, path.join(root, 'Leak', 'secret.mp3')), null);
  assert.equal(locateSlskdDownload(root, 'x\\Leak\\secret.mp3', { size: 7 }), null);
});

test('the slskd poll owns only this request\'s transfer of the exact remote file', () => {
  const wanted = '@@share\\Artists\\Björk\\Björk – Jóga.flac';
  const user = (files) => ({ username: 'peer', directories: [{ directory: '@@share\\Artists\\Björk', files }] });
  const other = { id: 'x', filename: '@@share\\Other\\Björk – Jóga.flac', state: 'Completed, Succeeded', requestedAt: '2026-10-24T10:05:00Z' };
  const old = { id: 'old', filename: wanted, state: 'Completed, Succeeded' };
  const queued = { id: 'new', filename: wanted.replace(/\\/g, '/').toUpperCase(), state: 'Queued, Remotely' };

  // With the enqueued id, only that record counts, whatever the stamps say.
  assert.equal(findTransfer(user([other, old, queued]), wanted, { id: 'new' }).id, 'new');
  assert.equal(findTransfer(user([other, old]), wanted, { id: 'new' }), null, 'not visible yet: keep waiting');
  // Without an id, records finished before the enqueue are excluded...
  assert.equal(findTransfer(user([old]), wanted, { excludeIds: new Set(['old']) }), null);
  assert.equal(findTransfer(user([old, queued]), wanted, { excludeIds: new Set(['old']) }).id, 'new');
  // ...and with equal or absent stamps an unfinished record still wins.
  const sameStamp = { ...old, id: 'old2', requestedAt: '2026-10-24T10:00:00Z' };
  assert.equal(findTransfer(user([sameStamp, { ...queued, requestedAt: '2026-10-24T10:00:00Z' }]), wanted).id, 'new');
  assert.equal(findTransfer(user([old, queued]), wanted).id, 'new');

  assert.equal(findTransfer([user([old])], 'Björk – Jóga.flac'), null, 'a basename alone is not an identity');
  assert.equal(findTransfer(null, wanted), null);
  assert.equal(findTransfer([{ files: [{ filename: wanted, state: 'Queued' }] }], wanted).state, 'Queued');
  assert.equal(transfersFor(user([{ ...old, removed: true }]), wanted).length, 0, 'records slskd marked removed are gone');
});

test('only "Succeeded" is success; every other finished state is a failure', () => {
  for (const state of ['Completed, Errored', 'Completed, Cancelled', 'Completed, TimedOut', 'Completed, Rejected', 'Completed, Aborted', 'Completed, Succeeded']) {
    assert.equal(isTerminalTransfer({ state }), true, state);
  }
  for (const state of ['Queued, Remotely', 'Initializing', 'InProgress', 'Requested', 'Incomplete']) {
    assert.equal(isTerminalTransfer({ state }), false, state);
  }
});

test('download headers carry any filename without throwing', () => {
  const header = contentDisposition('Björk – Jóga "live" (1997).flac');
  assert.match(header, /^attachment; filename="Bj_rk _ J_ga _live_ \(1997\)\.flac"; filename\*=UTF-8''/);
  const encoded = header.split("filename*=UTF-8''")[1];
  assert.equal(decodeURIComponent(encoded), 'Björk – Jóga "live" (1997).flac');
  assert.doesNotMatch(encoded, /[^A-Za-z0-9%\-._~!]/);
  assert.doesNotThrow(() => new Headers({ 'Content-Disposition': header }));
});

test('local Soulseek reads are bounded independently of a stale file size', async () => {
  const fs = await import('node:fs/promises');
  const file = path.join(os.tmpdir(), `midio-bounded-${process.pid}-${Date.now()}.bin`);
  await fs.writeFile(file, Buffer.from('safe'));
  try {
    assert.deepEqual([...readBoundedFile(file)], [...Buffer.from('safe')]);
  } finally {
    await fs.rm(file, { force: true });
  }
});
