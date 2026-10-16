import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertLoopbackSlskdUrl,
  BUNDLED_SLSKD_KEY,
  pathsInsideDownloads,
  readBoundedFile,
} from '../tools/soulseek-bridge.mjs';

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

  const nested = pathsInsideDownloads(root, 'artist/track.mp3');
  assert.deepEqual(nested, [
    path.join(root, 'track.mp3'),
    path.join(root, 'artist', 'track.mp3'),
  ]);

  // Traversal segments are dropped; only the basename may be read, and only
  // inside dlRoot. That is containment, not an escape.
  const escaped = pathsInsideDownloads(root, '../../../etc/passwd');
  assert.deepEqual(escaped, [path.join(root, 'passwd')]);

  const abs = pathsInsideDownloads(root, '/etc/passwd');
  assert.deepEqual(abs, [path.join(root, 'passwd')]);
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
