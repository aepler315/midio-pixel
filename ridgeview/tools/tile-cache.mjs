// Disk-cached download of AWS Terrain Tiles (terrarium encoding). Shared by
// the dev server's proxy and the offline viewpoint calculator.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = process.env.RIDGEVIEW_TILE_CACHE || path.join(root, '.tile-cache');
export const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const inflight = new Map();

export async function fetchTile(z, x, y, { retries = 4 } = {}) {
  const key = `${z}/${x}/${y}`;
  const file = path.join(CACHE_DIR, 'terrarium', String(z), String(x), `${y}.png`);
  try { return await fs.readFile(file); } catch { /* not cached */ }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
        const bytes = Buffer.from(await res.arrayBuffer());
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
        return bytes;
      } catch (err) {
        lastErr = err;
        if (err.status === 404) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr;
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}
