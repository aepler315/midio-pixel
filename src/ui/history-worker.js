import { parseHistoryRequest, historyMime, portableHistoryText } from './src/ui/HistoryFiles.js';
const root = new URL('./', self.location.href);
const maps = new Map();
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
async function fileMap(id) {
  if (!maps.has(id)) {
    const pending = fetch(new URL(`versions/maps/${id}.json`, root), { cache: 'no-cache' }).then(async response => {
      if (!response.ok) throw new Error('Version map unavailable.');
      const map = await response.json();
      if (!map || typeof map !== 'object' || !Object.values(map).every(hash => /^[a-f0-9]{40}$/.test(hash))) throw new Error('Invalid version map.');
      return map;
    }).catch(error => { maps.delete(id); throw error; });
    maps.set(id, pending);
  }
  return maps.get(id);
}
self.addEventListener('fetch', event => {
  const parsed = parseHistoryRequest(event.request.url, root);
  if (!parsed || !['GET', 'HEAD'].includes(event.request.method)) return;
  event.respondWith((async () => {
    try {
      const map = await fileMap(parsed.id), hash = map[parsed.file];
      if (!hash) return new Response('File absent in this historical version.', { status: 404 });
      const response = await fetch(new URL(`versions/objects/${hash}`, root));
      if (!response.ok) throw new Error('Historical file unavailable.');
      const type = historyMime(parsed.file);
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
      if (event.request.method === 'HEAD') return new Response(null, { headers });
      if (/\.(?:html|js|mjs|css)$/.test(parsed.file)) {
        const base = new URL(`versions/run/${parsed.id}/`, root).pathname;
        return new Response(portableHistoryText(await response.text(), parsed.file, base, parsed.id), { headers });
      }
      return new Response(response.body, { headers });
    } catch (error) { return new Response(error.message, { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
  })());
});
