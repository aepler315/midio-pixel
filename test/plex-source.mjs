import test from 'node:test';
import assert from 'node:assert/strict';
import { PlexSource, PlexSourceError } from '../src/net/PlexSource.js';
import { fetchAudioAsFile, UrlAudioError } from '../src/net/UrlAudioSource.js';

const apiBase = 'https://music.example/api/plex/v1';
const track = {
  id: 'server:41', ratingKey: '41', libraryId: '2', title: 'Real Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist',
  durationMs: 90000, discNumber: 1, trackNumber: 3, revision: 'revision-a', fileName: 'track-41.flac', container: 'flac', audioCodec: 'flac',
  sizeBytes: 4, artworkPath: '/api/plex/v1/artwork/41', loadability: { allowed: true },
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const audio = (chunks = [[1, 2], [3, 4]], contentType = 'audio/flac') => new Response(new ReadableStream({
  start(controller) { for (const bytes of chunks) controller.enqueue(new Uint8Array(bytes)); controller.close(); },
}), { headers: { 'content-type': contentType } });
const make = (fetchImpl, options = {}) => new PlexSource({ apiBase, fetchImpl, ...options });

test('track-becomes-one-file-with-correct-extension', async () => {
  const source = make(async (url) => url.includes('/audio?') ? audio() : json(track));
  const { file, sourceMetadata } = await source.loadTrack('41');
  assert.ok(file instanceof File);
  assert.equal(file.name, 'track-41.flac');
  assert.equal(file.type, 'audio/flac');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(sourceMetadata.id, 'server:41');
  assert.equal(sourceMetadata.artworkUrl, 'https://music.example/api/plex/v1/artwork/41');
});

test('browser-requests-omit-credentials', async () => {
  const requests = [];
  const source = make(async (url, options) => {
    requests.push({ url, ...options });
    return url.includes('/audio?') ? audio() : url.endsWith('/status') ? json({ enabled: true, available: true }) : json(track);
  });
  await source.status();
  await source.loadTrack('41');
  assert.equal(requests.length, 3);
  for (const req of requests) {
    assert.equal(req.credentials, 'omit');
    assert.equal(req.redirect, 'error');
    assert.equal(new Headers(req.headers).has('authorization'), false);
    assert.equal(new Headers(req.headers).has('x-plex-token'), false);
  }
});

test('progress-counts-received-bytes', async () => {
  const source = make(async (url) => url.includes('/audio?') ? audio() : json(track));
  const progress = [];
  await source.loadTrack('41', { onProgress: (value) => progress.push(value) });
  assert.deepEqual(progress, [{ receivedBytes: 2, totalBytes: null }, { receivedBytes: 4, totalBytes: null }]);
});

test('bad-audio-content-type-is-rejected', async () => {
  for (const type of ['text/html', 'application/json', 'audio/x-mpegurl', 'application/vnd.apple.mpegurl', '']) {
    await assert.rejects(make(async (url) => url.includes('/audio?') ? audio(undefined, type) : json(track)).loadTrack('41'),
      (error) => error instanceof PlexSourceError && error.code === 'UNSUPPORTED_MEDIA' && error.status === 415);
  }
});

test('revision-refresh-retries-only-once', async () => {
  const urls = [];
  const source = make(async (url) => {
    urls.push(url);
    if (url.includes('/audio?')) return json({ error: { code: 'REVISION_CHANGED', message: 'changed', retryable: true } }, 409);
    return json({ ...track, revision: urls.length < 3 ? 'revision-a' : 'revision-b' });
  });
  await assert.rejects(source.loadTrack('41'), (error) => error.status === 409 && error.code === 'REVISION_CHANGED');
  assert.deepEqual(urls, [apiBase + '/tracks/41', apiBase + '/tracks/41/audio?revision=revision-a', apiBase + '/tracks/41', apiBase + '/tracks/41/audio?revision=revision-b']);
});

test('retry-obeys-cancel', async () => {
  const controller = new AbortController();
  let count = 0;
  const source = make(async (url) => {
    count++;
    if (url.includes('/audio?')) { controller.abort(); return json({ error: { code: 'REVISION_CHANGED' } }, 409); }
    return json(track);
  });
  await assert.rejects(source.loadTrack('41', { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(count, 2);
});

test('metadata-is-not-a-Plex-url', async () => {
  const source = make(async () => json({ ...track, token: 'private', key: '/library/metadata/41', file: 'C:/private.flac', pmsUrl: 'http://private:32400' }));
  const value = await source.getTrack('41');
  assert.equal(value.token, undefined);
  assert.equal(value.key, undefined);
  assert.equal(value.file, undefined);
  assert.equal(value.pmsUrl, undefined);
  assert.equal(value.id, 'server:41');
});

test('limits-apply-without-content-length', async () => {
  const source = make(async (url) => url.includes('/audio?') ? audio([[1, 2], [3, 4]]) : json({ ...track, sizeBytes: null }), { limits: { maxFileBytes: 3, maxDurationSeconds: 1200 } });
  await assert.rejects(source.loadTrack('41'), (error) => error.status === 413 && error.code === 'RESOURCE_LIMIT');
});

test('apiBase and artwork cannot send visitors to private or arbitrary routes', () => {
  for (const base of ['http://music.example/api/plex/v1', 'https://token:secret@music.example/api/plex/v1', apiBase + '?token=secret', apiBase + '#token', 'https://music.example/library', 'https://music.example/api/plex/v1/../v1', 'https://music.example/api/plex/v1%2F']) {
    assert.throws(() => new PlexSource({ apiBase: base }), (error) => error.code === 'INVALID_CONFIG');
  }
  const source = make(async () => json(track));
  for (const path of ['https://elsewhere.example/api/plex/v1/artwork/41', '//elsewhere.example/api/plex/v1/artwork/41', '/library/metadata/41/thumb', '/api/plex/v1/artwork/41?token=secret', '/api/plex/v1/artwork/../41', '/api/plex/v1/artwork/%34%31']) {
    assert.equal(source.artworkUrl(path), null);
  }
  assert.equal(source.artworkUrl('/api/plex/v1/artwork/41'), apiBase + '/artwork/41');
  assert.equal(new PlexSource({ apiBase: 'http://127.0.0.1:8787/api/plex/v1' }).apiBase, 'http://127.0.0.1:8787/api/plex/v1');
});

test('catalog uses validated query fields and sanitized results', async () => {
  const urls = [];
  const source = make(async (url) => {
    urls.push(url);
    if (url.includes('/libraries')) return json({ items: [{ id: '2', title: 'Music', token: 'secret' }] });
    if (url.includes('/search')) return json({ artists: [], albums: [], tracks: [track], truncated: true });
    return json({ items: [track], offset: 0, nextOffset: null, total: 1 });
  });
  assert.deepEqual(await source.listLibraries(), { items: [{ id: '2', title: 'Music' }] });
  assert.equal((await source.listItems({ libraryId: '2', kind: 'track' })).items[0].title, 'Real Song');
  assert.equal((await source.search({ libraryId: '2', query: ' two & words ' })).tracks[0].id, 'server:41');
  assert.equal(urls[2], apiBase + '/search?libraryId=2&q=two+%26+words&limit=20');
  await assert.rejects(source.getTrack('../41'), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(source.listItems({ libraryId: '2', kind: '__proto__' }), (error) => error.code === 'INVALID_INPUT');
});

test('metadata response bounds apply while consuming body and malformed JSON is classified', async () => {
  await assert.rejects(make(async () => json(track), { metadataMaxBytes: 100 }).getTrack('41'), (error) => error.code === 'INVALID_RESPONSE');
  await assert.rejects(make(async () => new Response('{', { headers: { 'content-type': 'application/json' } })).getTrack('41'), (error) => error.code === 'INVALID_RESPONSE');
});

test('metadata stalled body and cancellation stop consumption', async () => {
  const stalled = () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(make(async () => stalled(), { stallMs: 15 }).getTrack('41'), (error) => error.code === 'TIMEOUT');
  const controller = new AbortController();
  const pending = make(async () => stalled()).getTrack('41', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('status and code classify HTTP failures without echoing upstream messages', async () => {
  await assert.rejects(make(async () => json({ error: { code: 'LIBRARY_UNAVAILABLE', message: 'secret Plex token at http://private', retryable: true } }, 503)).status(),
    (error) => error.code === 'LIBRARY_UNAVAILABLE' && error.status === 503 && error.retryable && !error.message.includes('secret'));
  let downloads = 0;
  await assert.rejects(make(async (url) => {
    if (url.includes('/audio?')) { downloads++; return new Response('', { status: 429 }); }
    return json(track);
  }).loadTrack('41'), (error) => error.code === 'CAPACITY' && error.status === 429);
  assert.equal(downloads, 1);
});

test('known size, duration and loadability violations reject before audio request', async () => {
  for (const override of [{ sizeBytes: 268435457 }, { durationMs: 1200001 }, { loadability: { allowed: false, reason: 'Unsupported media shape' } }]) {
    let requests = 0;
    await assert.rejects(make(async () => { requests++; return json({ ...track, ...override }); }).loadTrack('41'), (error) => error.status === 413 || error.status === 415);
    assert.equal(requests, 1);
  }
});

test('URL helper opt-in options reach injected fetch and HTTP errors expose status', async () => {
  let options;
  const progress = [];
  const file = await fetchAudioAsFile('https://music.example/download', { name: 'track.flac', fetchImpl: async (_url, opts) => { options = opts; return audio(); }, credentials: 'omit', requireAudioContentType: true, onProgress: (value) => progress.push(value) });
  assert.equal(file.size, 4);
  assert.equal(options.credentials, 'omit');
  assert.equal(progress.at(-1).receivedBytes, 4);
  await assert.rejects(fetchAudioAsFile('https://music.example/download', { fetchImpl: async () => new Response('', { status: 409 }) }), (error) => error instanceof UrlAudioError && error.status === 409);
});

test('URL download defaults retain legacy content-type and credentials behavior', async () => {
  let request;
  const file = await fetchAudioAsFile('https://music.example/track.flac', {
    fetchImpl: async (_url, options) => { request = options; return audio([[1, 2]], 'text/html'); },
  });
  assert.equal(file.type, 'audio/flac');
  assert.equal(request.credentials, undefined);
  assert.equal(request.redirect, 'follow');
});

test('revision refresh succeeds with current metadata after one stale response', async () => {
  let metadataReads = 0;
  const source = make(async (url) => {
    if (url.includes('/audio?revision=revision-a')) return new Response('', { status: 409 });
    if (url.includes('/audio?revision=revision-b')) return audio();
    metadataReads++;
    return json({ ...track, revision: metadataReads === 1 ? 'revision-a' : 'revision-b', title: metadataReads === 1 ? 'Old Song' : 'Current Song' });
  });
  const result = await source.loadTrack('41');
  assert.equal(result.sourceMetadata.revision, 'revision-b');
  assert.equal(result.sourceMetadata.title, 'Current Song');
  assert.equal(metadataReads, 2);
});

test('audio stalled body and cancelled body reject without returning partial files', async () => {
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), { headers: { 'content-type': 'audio/flac' } });
  await assert.rejects(make(async (url) => url.includes('/audio?') ? stalled() : json(track), { downloadStallMs: 15 }).loadTrack('41'), (error) => error.code === 'TIMEOUT');
  const controller = new AbortController();
  const source = make(async (url) => url.includes('/audio?') ? stalled() : json(track));
  await assert.rejects(source.loadTrack('41', { signal: controller.signal, onProgress: () => controller.abort() }), (error) => error.name === 'AbortError');
});

test('nonstring public identity is rejected and unsafe file names are synthetic', async () => {
  await assert.rejects(make(async () => json({ ...track, id: 41 })).getTrack('41'), (error) => error.code === 'INVALID_RESPONSE');
  const source = make(async (url) => url.includes('/audio?') ? audio() : json({ ...track, fileName: 'C:/Music/private.flac' }));
  assert.equal((await source.loadTrack('41')).file.name, 'track-41.flac');
});

test('unloadable track with no media revision stays browsable and rejects playback', async () => {
  const unavailable = { ...track, revision: null, container: null, fileName: 'plex-41.bin', loadability: { allowed: false, reason: 'No original media' } };
  const source = make(async (url) => url.includes('/items?') ? json({ items: [unavailable], offset: 0, nextOffset: null, total: 1 }) : json(unavailable));
  const page = await source.listItems({ libraryId: '2', kind: 'track' });
  assert.equal(page.items[0].revision, null);
  assert.equal(page.items[0].loadability.allowed, false);
  await assert.rejects(source.loadTrack('41'), (error) => error.code === 'UNSUPPORTED_MEDIA');
});

test('native browser fetch gets a valid receiver for metadata and audio', async () => {
  // Chromium's native Window.fetch throws Illegal invocation with a PlexSource receiver.
  const fetchImpl = function (url) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    if (url.endsWith('/status')) return Promise.resolve(json({ enabled: true, available: true }));
    return Promise.resolve(url.includes('/audio?') ? audio() : json(track));
  };
  const source = make(fetchImpl);
  assert.equal((await source.status()).available, true);
  assert.equal((await source.loadTrack('41')).file.size, 4);
});

test('URL download failed exits cancel unread response bodies and abort request signal', async () => {
  for (const fixture of [
    { status: 200, type: 'text/html' },
    { status: 200, type: 'audio/flac', length: '100' },
    { status: 503, type: 'application/json' },
  ]) {
    let cancelled = false;
    let requestSignal;
    const fetchImpl = async (_url, options) => {
      requestSignal = options.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }), {
        status: fixture.status, headers: { 'content-type': fixture.type, ...(fixture.length ? { 'content-length': fixture.length } : {}) },
      });
    };
    await assert.rejects(fetchAudioAsFile(apiBase + '/tracks/41/audio', { fetchImpl, requireAudioContentType: true, limits: { maxFileBytes: 10 } }), (error) => error instanceof UrlAudioError);
    assert.equal(cancelled, true, JSON.stringify(fixture));
    assert.equal(requestSignal.aborted, true, JSON.stringify(fixture));
  }
});

test('Plex metadata failed exits cancel unread response bodies and abort request signal', async () => {
  for (const fixture of [
    { status: 200, type: 'text/html' },
    { status: 200, type: 'application/json', length: '1000' },
    { status: 503, type: 'application/json', length: '1000' },
  ]) {
    let cancelled = false;
    let requestSignal;
    const source = make(async (_url, options) => {
      requestSignal = options.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }), {
        status: fixture.status, headers: { 'content-type': fixture.type, ...(fixture.length ? { 'content-length': fixture.length } : {}) },
      });
    }, { metadataMaxBytes: 100 });
    await assert.rejects(source.status(), (error) => error instanceof PlexSourceError);
    assert.equal(cancelled, true, JSON.stringify(fixture));
    assert.equal(requestSignal.aborted, true, JSON.stringify(fixture));
  }
});
