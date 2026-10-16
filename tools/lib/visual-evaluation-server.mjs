import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// A frozen public tree prevents a wrong/stale server or edits during capture
// from changing the bytes behind an already-recorded commit label.
export async function snapshotSource(root) {
  const files = new Map();
  const walk = async relative => {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.set('/' + name, await fs.readFile(path.join(root, name)));
      else throw new Error(`unsupported public source entry ${name}`);
    }
  };
  files.set('/index.html', await fs.readFile(path.join(root, 'index.html')));
  await walk('src');
  const hashes = Object.fromEntries([...files].map(([file, bytes]) => [file.slice(1), sha256(bytes)]));
  return { files, hashes, digest: sha256(JSON.stringify(hashes)) };
}

export async function serveSnapshot(snapshot) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.gz': 'application/gzip', '.wasm': 'application/wasm' };
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
    if (req.method !== 'GET' || pathname.includes('\\') || pathname.split('/').some(p => p.startsWith('.'))) { res.writeHead(404).end(); return; }
    if (pathname === '/soundfonts/') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]'); return; }
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = pathname === '/' ? '/index.html' : pathname;
    const bytes = snapshot.files.get(file);
    if (!bytes) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve()); server.closeAllConnections();
  }) };
}
