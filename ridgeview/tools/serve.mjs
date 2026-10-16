// Static dev server for Ridgeview, plus an optional caching proxy for
// elevation tiles at /tiles/terrarium/{z}/{x}/{y}.png. The page talks to
// AWS directly unless it is opened with ?proxy=1; the proxy exists so tests
// and repeat sessions can run from a local disk cache.
//   node tools/serve.mjs [port]        (HOST env to bind elsewhere)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTile } from './tile-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8090);
const host = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const SERVED = ['index.html', 'src/', 'vendor/', 'data/', 'assets/'];

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const tile = url.pathname.match(/^\/tiles\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (tile) {
        const [z, x, y] = tile.slice(1).map(Number);
        const bytes = await fetchTile(z, x, y);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400', 'access-control-allow-origin': '*' });
        res.end(bytes);
        return;
      }
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (rel === '') rel = 'index.html';
      if (!SERVED.some((p) => rel === p || rel.startsWith(p)) || rel.includes('..')) {
        res.writeHead(404).end('not found');
        return;
      }
      const file = path.join(root, rel);
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch (err) {
      const code = err?.code === 'ENOENT' ? 404 : err?.status || 500;
      res.writeHead(code).end(String(err?.message || err));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(port, host, () => console.log(`Ridgeview: http://${host}:${port}/`));
}
