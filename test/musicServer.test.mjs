// Exercise the actual optional music server against an isolated synthetic
// root. Symlinks are fixture-owned; no user library or live server is used.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawRequest } from './helpers/raw-http.mjs';

const serverFile = fileURLToPath(new URL('../tools/music-server.mjs', import.meta.url));
const blob = Buffer.from('0123456789abcdef');
const visible = Buffer.from('VISIBLE AUDIO');
const album = Buffer.from('ALBUM AUDIO');
const allowedOrigin = 'https://supermaudio.com';
const extraOrigin = 'http://library.example.test:8080';
let fixture, child, baseUrl;

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function stopServer() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
  try { await exited; } finally { clearTimeout(timer); }
}

before(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-music-server-'));
  const root = path.join(fixture, 'music');
  const selected = path.join(fixture, 'selected-music');
  await Promise.all(['.private', 'public', 'albums'].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })));
  await fs.mkdir(path.join(fixture, 'music-private'));
  await Promise.all([
    fs.writeFile(path.join(root, 'blob'), blob),
    fs.writeFile(path.join(root, 'visible.mp3'), visible),
    fs.writeFile(path.join(root, 'albums', 'live.mp3'), album),
    fs.writeFile(path.join(root, '.hidden.mp3'), 'SYNTHETIC HIDDEN FILE'),
    fs.writeFile(path.join(root, '.private', 'secret.mp3'), 'SYNTHETIC HIDDEN DIRECTORY'),
    fs.writeFile(path.join(fixture, 'outside.mp3'), 'SYNTHETIC OUTSIDE FILE'),
    fs.writeFile(path.join(fixture, 'music-private', 'outside.mp3'), 'SYNTHETIC OUTSIDE DIRECTORY'),
  ]);
  const links = [
    ['track.mp3', 'blob', 'file'],
    ['visible-alias.mp3', 'visible.mp3', 'file'],
    ['chain.mp3', 'track.mp3', 'file'],
    ['album-alias', 'albums', 'dir'],
    ['hidden-file-alias.mp3', '.hidden.mp3', 'file'],
    ['hidden-child-alias.mp3', '.private/secret.mp3', 'file'],
    ['nested-hidden-alias.mp3', 'hidden-file-alias.mp3', 'file'],
    ['hidden-dir-alias', '.private', 'dir'],
    ['nested-dir-alias', 'hidden-dir-alias', 'dir'],
    ['public/secret-alias.mp3', '../hidden-file-alias.mp3', 'file'],
    ['public/hidden-album', '../hidden-dir-alias', 'dir'],
    ['public/visible-track.mp3', '../blob', 'file'],
    ['outside-alias.mp3', '../outside.mp3', 'file'],
    ['escape-dir', '../music-private', 'dir'],
    ['up-to-parent', '..', 'dir'],
    ['broken.mp3', 'missing.mp3', 'file'],
    ['loop-a.mp3', 'loop-b.mp3', 'file'],
    ['loop-b.mp3', 'loop-a.mp3', 'file'],
  ];
  for (const [name, target, type] of links) await fs.symlink(target, path.join(root, name), type);
  await fs.symlink(root, selected, 'dir');

  const port = await freePort(); baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverFile, selected, String(port)], {
    env: { ...process.env, MUSIC_HOST: '127.0.0.1', MUSIC_ALLOW_ORIGIN: extraOrigin, MUSIC_ALLOW_HOST: 'music.lan.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let log = '', settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.off('error', finish); child.off('exit', exited); child.stdout.off('data', output);
      if (error) reject(error); else resolve();
    };
    const exited = code => finish(new Error(`fixture music server exited ${code}: ${log}`));
    const output = data => {
      log += data.toString();
      if (log.includes(`${baseUrl}/`)) finish();
    };
    const timer = setTimeout(() => finish(new Error(`fixture music server startup timed out: ${log}`)), 25_000);
    child.once('error', finish); child.once('exit', exited); child.stdout.on('data', output);
    child.stderr.on('data', data => { log += data.toString(); });
  });
});

after(async () => {
  await stopServer();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

async function request(urlPath, options = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}

test('music listing omits aliases to hidden canonical files and directories', async (t) => {
  const root = JSON.parse((await request('/')).body.toString());
  const publicFolder = JSON.parse((await request('/public/')).body.toString());
  t.diagnostic(JSON.stringify({ root, publicFolder }));
  assert.deepEqual(root.files.map(file => file.name).sort(), ['chain.mp3', 'track.mp3', 'visible-alias.mp3', 'visible.mp3'].sort());
  assert.deepEqual(root.folders.sort(), ['/album-alias/', '/albums/', '/public/'].sort());
  assert.deepEqual(publicFolder.files.map(file => file.name), ['visible-track.mp3']);
  assert.deepEqual(publicFolder.folders, []);
});

test('music serving denies direct hidden targets and visible file/directory alias chains', async (t) => {
  const paths = [
    '/.hidden.mp3', '/%2ehidden.mp3', '/.private/secret.mp3',
    '/hidden-file-alias.mp3', '/hidden-child-alias.mp3', '/nested-hidden-alias.mp3',
    '/hidden-dir-alias/', '/nested-dir-alias/secret.mp3', '/public/secret-alias.mp3', '/public/hidden-album/',
  ];
  const statuses = [];
  for (const urlPath of paths) statuses.push({ path: urlPath, status: (await request(urlPath)).status });
  t.diagnostic(JSON.stringify(statuses));
  for (const row of statuses) assert.equal(row.status, 403, row.path);
  const head = await request('/hidden-file-alias.mp3', { method: 'HEAD' });
  assert.equal(head.status, 403); assert.equal(head.body.length, 0);
});

test('music serving denies outside roots, an exact-parent directory alias, and encoded traversal', async (t) => {
  const paths = ['/outside-alias.mp3', '/escape-dir/', '/up-to-parent/', '/..%2foutside.mp3'];
  const statuses = [];
  for (const urlPath of paths) statuses.push({ path: urlPath, status: (await request(urlPath)).status });
  t.diagnostic(JSON.stringify(statuses));
  for (const row of statuses) assert.equal(row.status, 403, row.path);
});

test('visible aliases to audio and extensionless blobs work under a symlinked selected root', async () => {
  const paths = [
    ['/visible.mp3', visible], ['/visible-alias.mp3', visible], ['/track.mp3', blob],
    ['/chain.mp3', blob], ['/public/visible-track.mp3', blob], ['/album-alias/live.mp3', album],
  ];
  for (const [urlPath, expected] of paths) {
    const result = await request(urlPath);
    assert.equal(result.status, 200, urlPath); assert.deepEqual(result.body, expected, urlPath);
    assert.equal(result.headers.get('Content-Type'), 'audio/mpeg');
  }
  assert.equal((await request('/blob')).status, 404, 'audio extension policy belongs to the requested alias');
  const listing = JSON.parse((await request('/album-alias/')).body.toString());
  assert.equal(listing.files[0].url, '/album-alias/live.mp3');
});

test('broken links and symlink loops are omitted and return 404 without stopping the server', async () => {
  const listing = JSON.parse((await request('/')).body.toString());
  for (const name of ['broken.mp3', 'loop-a.mp3', 'loop-b.mp3']) {
    assert.equal(listing.files.some(file => file.name === name), false);
    assert.equal((await request(`/${name}`)).status, 404);
  }
  assert.equal((await request('/visible.mp3')).status, 200);
});

test('music aliases retain HEAD and byte-range semantics without changing source bytes', async () => {
  const head = await request('/track.mp3', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers.get('Content-Length'), String(blob.length));
  assert.equal(head.headers.get('Accept-Ranges'), 'bytes');
  const range = await request('/track.mp3', { headers: { Range: 'bytes=3-6' } });
  assert.equal(range.status, 206); assert.deepEqual(range.body, blob.subarray(3, 7));
  assert.equal(range.headers.get('Content-Range'), `bytes 3-6/${blob.length}`);
  const rangeHead = await request('/track.mp3', { method: 'HEAD', headers: { Range: 'bytes=3-6' } });
  assert.equal(rangeHead.status, 206); assert.equal(rangeHead.body.length, 0);
  assert.equal(rangeHead.headers.get('Content-Length'), '4');
  const suffix = await request('/track.mp3', { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206); assert.deepEqual(suffix.body, blob.subarray(-4));
  const unsatisfied = await request('/track.mp3', { headers: { Range: 'bytes=9999-' } });
  assert.equal(unsatisfied.status, 416); assert.equal(unsatisfied.headers.get('Content-Range'), `bytes */${blob.length}`);
  assert.deepEqual(await fs.readFile(path.join(fixture, 'music', 'blob')), blob);
});

test('music-server origin allowlist and method headers remain unchanged', async () => {
  for (const origin of [allowedOrigin, extraOrigin]) {
    const result = await request('/track.mp3', { headers: { Origin: origin } });
    assert.equal(result.status, 200); assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(result.headers.get('Vary'), 'Origin');
    assert.match(result.headers.get('Access-Control-Expose-Headers'), /Content-Range/);
  }
  const unknown = await request('/track.mp3', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(unknown.status, 200); assert.equal(unknown.headers.get('Access-Control-Allow-Origin'), null);
  const options = await request('/track.mp3', { method: 'OPTIONS', headers: { Origin: allowedOrigin } });
  assert.equal(options.status, 204); assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET,HEAD,OPTIONS');
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  const post = await request('/track.mp3', { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.get('Allow'), 'GET, HEAD, OPTIONS');
});

test('music-server refuses DNS-rebound Host names but serves loopback, IP literals and configured names', async () => {
  const port = new URL(baseUrl).port;
  // A rebinding page is same-origin and sends no Origin; only its Host gives it away.
  // rawRequest, not fetch: fetch silently replaces a Host header.
  for (const host of [`attacker.example:${port}`, `127.evil.example:${port}`, `127.0.0.1.nip.io:${port}`, 'localhost.attacker.example']) {
    const listing = await rawRequest(`${baseUrl}/`, { headers: { Host: host } });
    assert.equal(listing.status, 403, host);
    assert.doesNotMatch(listing.text, /track\.mp3/, host);
    assert.equal((await rawRequest(`${baseUrl}/track.mp3`, { headers: { Host: host } })).status, 403, host);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `192.168.1.5:${port}`, `music.lan.test:${port}`, 'MUSIC.LAN.TEST']) {
    assert.equal((await rawRequest(`${baseUrl}/track.mp3`, { headers: { Host: host } })).status, 200, host);
  }
});
