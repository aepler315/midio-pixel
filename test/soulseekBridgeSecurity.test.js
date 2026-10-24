import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertLoopbackSlskdUrl,
  BUNDLED_SLSKD_KEY,
  findTransfer,
  pathsInsideDownloads,
  readBoundedFile,
  readSlskdDownload,
  realFileInsideDownloads,
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
});

test('a finished slskd transfer is read from inside the root only, symlinks included', async (t) => {
  const fsp = await import('node:fs/promises');
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'midio-slskd-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'downloads');
  await fsp.mkdir(path.join(root, 'B'), { recursive: true });
  await fsp.writeFile(path.join(base, 'secret.mp3'), 'outside');
  await fsp.writeFile(path.join(root, 'B', 'song.mp3'), 'right');
  await fsp.writeFile(path.join(root, 'song.mp3'), 'same name, other transfer');
  const got = readSlskdDownload(root, '@@share\\A\\B\\song.mp3');
  assert.equal(got.buffer.toString(), 'right');
  assert.equal(got.filename, 'song.mp3');

  await fsp.mkdir(path.join(root, 'Leak'));
  await fsp.symlink(path.join(base, 'secret.mp3'), path.join(root, 'Leak', 'secret.mp3'), 'file');
  assert.equal(realFileInsideDownloads(root, path.join(root, 'Leak', 'secret.mp3')), null);
  assert.throws(() => readSlskdDownload(root, 'x\\Leak\\secret.mp3'), /not reachable/);
});

test('the slskd poll matches the exact remote file, newest transfer first', () => {
  const wanted = '@@share\\Artists\\Björk\\Björk – Jóga.flac';
  const user = {
    username: 'peer',
    directories: [
      { directory: '@@share\\Other', files: [
        { filename: '@@share\\Other\\Björk – Jóga.flac', state: 'Completed, Succeeded', requestedAt: '2026-10-24T10:05:00Z' },
      ] },
      { directory: '@@share\\Artists\\Björk', files: [
        { filename: wanted, state: 'Completed, Errored', requestedAt: '2026-10-24T09:00:00Z' },
        { filename: wanted.replace(/\\/g, '/').toUpperCase(), state: 'InProgress', requestedAt: '2026-10-24T10:00:00Z' },
      ] },
    ],
  };
  const match = findTransfer(user, wanted);
  assert.equal(match.state, 'InProgress', 'the newest transfer of that exact file');
  assert.equal(findTransfer([user], 'Björk – Jóga.flac'), null, 'a basename alone is not an identity');
  assert.equal(findTransfer(null, wanted), null);
  // The flat shape some slskd builds return is accepted too.
  assert.equal(findTransfer([{ files: [{ filename: wanted, state: 'Queued' }] }], wanted).state, 'Queued');
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
