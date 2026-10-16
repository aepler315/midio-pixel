import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLoopbackHost } from '../src/net/UrlAudioSource.js';

/** The only configuration permitted in the published static site. */
export async function writePlexPublicConfig(outputFile, options = {}) {
  if (!options || Object.keys(options).some(key => key !== 'apiBase')) throw new Error('Only apiBase is public configuration.');
  const apiBase = options.apiBase ?? '';
  if (typeof apiBase !== 'string') throw new Error('apiBase must be a string.');
  if (apiBase) {
    let url;
    try { url = new URL(apiBase); } catch { throw new Error('Plex public endpoint must be an absolute URL.'); }
    if (url.username || url.password || url.search || url.hash
      || url.pathname !== '/api/plex/v1'
      || !/^https?:\/\/[^/?#]+\/api\/plex\/v1$/.test(apiBase)
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname)))) {
      throw new Error('Plex endpoint must be HTTPS (or loopback HTTP), ending in /api/plex/v1, without credentials, query or fragment.');
    }
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, JSON.stringify({ version: 1, apiBase }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writePlexPublicConfig(process.argv[2] || 'src/config/plex.json', {
    apiBase: process.env.MIDIO_PLEX_PUBLIC_API_BASE || '',
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
