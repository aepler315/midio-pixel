import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotSource, serveSnapshot } from '../tools/lib/visual-evaluation-server.mjs';

test('serves immutable public bytes on an owned port and refuses private paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-server-'));
  let server;
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'index.html'), '<html>original</html>');
    await fs.writeFile(path.join(root, 'src/main.js'), 'original');
    await fs.writeFile(path.join(root, 'secret.txt'), 'private');
    const snapshot = await snapshotSource(root);
    server = await serveSnapshot(snapshot);
    await fs.writeFile(path.join(root, 'src/main.js'), 'changed');
    assert.equal(await (await fetch(`${server.url}/src/main.js`)).text(), 'original');
    assert.equal((await fetch(`${server.url}/secret.txt`)).status, 404);
    assert.equal((await fetch(`${server.url}/src/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await fetch(`${server.url}/src/.env`)).status, 404);
    assert.notEqual((await snapshotSource(root)).digest, snapshot.digest);
    assert.equal((await fetch(`${server.url}/src/main.js`)).headers.get('content-type'), 'text/javascript');
  } finally { if (server) await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
