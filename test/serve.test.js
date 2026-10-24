import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, symlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rawRequest } from './helpers/raw-http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = resolve(root, 'tools/serve.js');

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch { /* the child is still binding */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('development server did not start');
}

test('development server rejects traversal, malformed URLs, and arbitrary download URLs without dying', async (t) => {
  const links = mkdtempSync(resolve(root, 'src/server-test-'));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  symlinkSync(resolve(root, 'package.json'), resolve(links, 'private.json'));
  writeFileSync(resolve(links, '100%.js'), '/* public */');
  const linkPath = '/src/' + links.split(/[\\/]/).at(-1) + '/private.json';
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverFile, String(port)], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  try {
    await waitForServer(baseUrl);
    assert.equal((await fetch(baseUrl)).status, 200);
    const crossOrigin = await fetch(`${baseUrl}/api/soulseek/status`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossOrigin.status, 401);
    assert.equal((await fetch(`${baseUrl}/%ZZ`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/..%2fpackage.json`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);
    assert.equal((await fetch(baseUrl + linkPath)).status, 403);
    assert.equal((await fetch(baseUrl + linkPath.replace('private.json', '100%25.js'))).status, 200);
    assert.equal((await fetch(`${baseUrl}/src/x%5c..%5c..%5c.env`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/src/main.js%00`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/soulseek/search/%25`)).status, 404);

    const download = await fetch(`${baseUrl}/api/soulseek/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { source: 'free', url: 'http://127.0.0.1:9/not-a-catalog-track' } }),
    });
    assert.equal(download.status, 500);
    assert.match(await download.text(), /No free download URL/);

    // A rejected request is never allowed to take down the dev server.
    assert.equal((await fetch(`${baseUrl}/src/main.js`)).status, 200);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('Soulseek bridge requires the configured token even on loopback', async (t) => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverFile, String(port)], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', MIDIO_BRIDGE_TOKEN: 'test-bridge-token' },
    stdio: 'ignore',
  });
  try {
    await waitForServer(baseUrl);
    const denied = await fetch(`${baseUrl}/api/soulseek/status`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${baseUrl}/api/soulseek/status`, {
      headers: { 'X-Midio-Bridge-Token': 'test-bridge-token' },
    });
    assert.notEqual(allowed.status, 401);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('tokenless bridge rejects untrusted Host headers and never returns configured credentials', async (t) => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverFile, String(port)], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', SLSK_USER: 'synthetic-user', SLSK_PASS: 'synthetic-password' },
    stdio: 'ignore',
  });
  try {
    await waitForServer(baseUrl);
    // rawRequest, not fetch: fetch silently replaces a Host header.
    const rebinding = await rawRequest(`${baseUrl}/api/soulseek/status`, {
      headers: { Host: `audit.invalid:${port}`, Origin: `http://audit.invalid:${port}` },
    });
    assert.equal(rebinding.status, 401);
    // A DNS-rebound page is same-origin with its own name, and names that
    // merely start like loopback are attacker-controlled DNS names.
    for (const host of [`audit.invalid:${port}`, `127.evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.attacker.example:${port}`, `127.1:${port}x`]) {
      const forged = await rawRequest(`${baseUrl}/api/soulseek/demo`, { headers: { Host: host } });
      assert.equal(forged.status, 401, host);
      const forgedSameOrigin = await rawRequest(`${baseUrl}/api/soulseek/demo`, { headers: { Host: host, Origin: `http://${host}` } });
      assert.equal(forgedSameOrigin.status, 401, host);
    }
    // The real loopback spellings, with and without a matching Origin.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `app.localhost:${port}`]) {
      const plain = await rawRequest(`${baseUrl}/api/soulseek/demo`, { headers: { Host: host } });
      assert.equal(plain.status, 200, host);
      const sameOrigin = await rawRequest(`${baseUrl}/api/soulseek/demo`, { headers: { Host: host, Origin: `http://${host}` } });
      assert.equal(sameOrigin.status, 200, host);
      const crossOrigin = await rawRequest(`${baseUrl}/api/soulseek/demo`, { headers: { Host: host, Origin: 'https://evil.example' } });
      assert.equal(crossOrigin.status, 401, host);
    }
    const config = await fetch(`${baseUrl}/api/soulseek/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });
    assert.equal(config.status, 200);
    const body = await config.text();
    assert.doesNotMatch(body, /synthetic-password/);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});

/**
 * A stub slskd 0.26.1 for one user. Before the enqueue it holds an older
 * finished record of the same remote file (no timestamps); the enqueue
 * creates the new transfer, which is queued on the first poll and succeeds
 * on the next, when its file lands as slskd's renamed copy beside the old
 * file. `withId: false` answers the enqueue the way an older slskd did,
 * without the transfer, so the bridge has to rely on its snapshot.
 */
async function stubSlskd(t, { downloads, remote, name, bytes, withId }) {
  const old = { id: 'old-transfer', filename: remote, state: 'Completed, Succeeded', size: 31 };
  let enqueued = false, polls = 0;
  const server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url !== '/api/v0/transfers/downloads/peer') return json(404, {});
    if (req.method === 'POST') {
      enqueued = true;
      return json(201, withId ? { enqueued: [{ id: 'new-transfer', filename: remote, state: 'Queued, Locally', size: bytes.length }], failed: [] } : {});
    }
    const files = [old, { id: 'x', filename: `@@share\\Other\\${name}`, state: 'Completed, Errored', size: 5 }];
    if (enqueued) {
      polls++;
      const done = polls >= 2;
      if (done && polls === 2) writeFileSync(resolve(downloads, 'Björk', name.replace('.flac', '_638655301234567890.flac')), bytes);
      files.push({ id: 'new-transfer', filename: remote, state: done ? 'Completed, Succeeded' : 'Queued, Remotely', size: bytes.length });
    }
    return json(200, { username: 'peer', directories: [{ directory: '@@share\\Artists\\Björk', files }] });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  return server;
}

for (const withId of [true, false]) {
  test(`a finished slskd download reaches the page intact (${withId ? 'enqueued id' : 'snapshot fallback'})`, async (t) => {
    const downloads = mkdtempSync(resolve(tmpdir(), 'midio-serve-slskd-'));
    t.after(() => rmSync(downloads, { recursive: true, force: true }));
    const name = 'Björk – Jóga.flac';
    const remote = `@@share\\Artists\\Björk\\${name}`;
    const bytes = 'the requested transfer, all of it';
    mkdirSync(resolve(downloads, 'Björk'));
    // The earlier transfer's file under the same name, and a root decoy.
    const stale = new Date(Date.now() - 120_000);
    for (const file of [resolve(downloads, 'Björk', name), resolve(downloads, name)]) {
      writeFileSync(file, 'an earlier transfer of this name'); utimesSync(file, stale, stale);
    }
    const slskd = await stubSlskd(t, { downloads, remote, name, bytes, withId });
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverFile, String(port)], {
      cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', SLSK_USER: '', SLSK_PASS: '', MIDIO_BRIDGE_TOKEN: '',
        SLSKD_URL: `http://127.0.0.1:${slskd.address().port}`, SLSKD_API_KEY: 'fixture-key', SLSKD_DOWNLOADS: downloads },
      stdio: 'ignore',
    });
    try {
      await waitForServer(baseUrl);
      const response = await fetch(`${baseUrl}/api/soulseek/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { source: 'slskd', user: 'peer', filename: remote, size: bytes.length } }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await response.text(), bytes, 'this transfer, not the older record or same-named file');
      const disposition = response.headers.get('content-disposition');
      assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
      assert.equal(decodeURIComponent(response.headers.get('x-filename')), name);
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    }
  });
}

test('development server refuses a non-loopback bind without a bridge token', async (t) => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [serverFile, String(port)], {
    cwd: root,
    env: { ...process.env, HOST: '0.0.0.0', MIDIO_BRIDGE_TOKEN: '' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGTERM'));
  const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  assert.notEqual(exit, 0);
});
