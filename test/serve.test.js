import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
    const rebinding = await fetch(`${baseUrl}/api/soulseek/status`, {
      headers: { Host: `audit.invalid:${port}`, Origin: `http://audit.invalid:${port}` },
    });
    assert.equal(rebinding.status, 401);
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
