import http from 'node:http';
export function syntheticWav({ durationSeconds = 0.05, sampleRate = 8000, channels = 2 } = {}) {
  const frames = Math.floor(durationSeconds * sampleRate), bytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + bytes); wav.write('RIFF'); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 12000), 44 + (i * channels + c) * 2);
  return wav;
}
export async function createFakePms({ overrides = {}, tracks = null, mediaBody = null, mediaMode = null, validateSort = false } = {}) {
  const wav = mediaBody || syntheticWav(), requests = [];
  const artist = { ratingKey: '10', key: '/library/metadata/10', type: 'artist', librarySectionID: 1, title: 'Artist <&> 🎵', thumb: '/library/metadata/10/thumb/1' };
  const album = { ratingKey: '20', type: 'album', librarySectionID: 1, parentRatingKey: '10', title: 'Fixture album', parentTitle: artist.title };
  const makeTrack = (id, extra = {}) => ({ ratingKey: id, key: `/library/metadata/${id}`, type: 'track', librarySectionID: 1, title: 'Duplicate title', grandparentTitle: artist.title, parentTitle: album.title, parentRatingKey: '20', grandparentRatingKey: '10', duration: 50, parentIndex: 1, index: Number(id) - 29, updatedAt: 123, thumb: `/library/metadata/${id}/thumb/1`, Media: [{ id: id + '0', container: 'wav', audioCodec: 'pcm', audioChannels: 2, duration: 50, Part: [{ id: id + '1', key: `/library/parts/${id}1/123/fixture.wav`, file: 'C:\\private\\fixture.wav', size: wav.length, exists: true, accessible: true }] }], ...extra });
  const entries = tracks || [makeTrack('30'), makeTrack('31', { parentIndex: 2, index: 1 }), makeTrack('90', { librarySectionID: 2 }), makeTrack('91', { librarySectionID: 3, type: 'movie' })];
  const items = new Map([artist, album, ...entries].map(x => [x.ratingKey, x]));
  const directories = [{ id: '1', key: '/library/sections/1', type: 'artist', title: 'Music' }, { id: '2', key: '/library/sections/2', type: 'artist', title: 'Private music' }, { id: '3', key: '/library/sections/3', type: 'movie', title: 'Movies' }];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } });
    if (validateSort && /\/(all|children)$/.test(url.pathname) && /(?:ratingKey|parentIndex):/.test(url.searchParams.get('sort') || '')) { res.writeHead(500); res.end('Unsupported sort field'); return; }
    if (overrides[url.pathname]) { await overrides[url.pathname](req, res, url); return; }
    const json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ MediaContainer: body })); };
    if (url.pathname === '/media/providers') return json({ machineIdentifier: 'fixture-machine-private', MediaProvider: [{ identifier: 'com.plexapp.plugins.library', protocols: 'stream', Feature: [{ type: 'content', key: '/library/sections', Directory: directories }, { type: 'metadata', key: '/library/metadata' }, { type: 'search', key: '/hubs/search' }] }] });
    if (url.pathname === '/library/sections') return json({ Directory: directories });
    if (url.pathname === '/hubs/search') return json({ Hub: [{ type: 'artist', size: 1, Metadata: [artist] }, { type: 'album', size: 1, Metadata: [album] }, { type: 'track', size: entries.length, Metadata: entries }] });
    const match = url.pathname.match(/^\/library\/metadata\/(\d+)(\/children)?$/);
    if (match) { const item = items.get(match[1]); if (!item) { res.writeHead(404); res.end(); return; } if (!match[2]) return json({ Metadata: [item] }); const children = item.type === 'artist' ? [album] : entries.filter(x => x.parentRatingKey === item.ratingKey); return page(children); }
    function page(list) { if (validateSort) list = [...list].sort((a, b) => (url.searchParams.get('sort')?.startsWith('absoluteIndex:') ? ((a.parentIndex || 1) * 1000 + (a.index || 0)) - ((b.parentIndex || 1) * 1000 + (b.index || 0)) : String(a.title || '').localeCompare(String(b.title || ''))) || Number(a.ratingKey) - Number(b.ratingKey)); const offset = Number(url.searchParams.get('X-Plex-Container-Start') || 0), size = Number(url.searchParams.get('X-Plex-Container-Size') || 50); json({ offset, totalSize: list.length, size: Math.min(size, list.length - offset), Metadata: list.slice(offset, offset + size) }); }
    if (url.pathname === '/library/sections/1/all') return page(url.searchParams.get('type') === '8' ? [artist] : url.searchParams.get('type') === '9' ? [album] : entries.filter(x => x.librarySectionID === 1 && x.type === 'track'));
    if (/^\/library\/metadata\/\d+\/thumb\/1$/.test(url.pathname)) { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from([137,80,78,71,13,10,26,10])); return; }
    if (/^\/library\/parts\//.test(url.pathname)) {
      res.setHeader('Content-Type', 'audio/wav');
      if (mediaMode === 'stall') { res.flushHeaders(); return; }
      if (mediaMode === 'chunks') { res.write(wav.subarray(0, 44)); const timer = setInterval(() => res.write(wav), 10); res.on('close', () => clearInterval(timer)); return; }
      res.setHeader('Content-Length', wav.length); res.end(wav); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, requests, tracks: entries, items, wav, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
