import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchTracks, fetchTrackAsFile, getJamendoClientId, setJamendoClientId, JamendoError,
} from '../src/net/JamendoSource.js';

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test('client id getter/setter no-op safely with no localStorage (Node test env)', () => {
  assert.doesNotThrow(() => setJamendoClientId('abc123'));
  assert.doesNotThrow(() => getJamendoClientId());
});

test('searchTracks refuses without a client_id, without ever making a request', async () => {
  let called = false;
  await withFetch(async () => { called = true; return { ok: true, json: async () => ({ results: [] }) }; }, async () => {
    await assert.rejects(() => searchTracks('daft punk', { clientId: '' }), JamendoError);
  });
  assert.equal(called, false, 'a missing client_id must short-circuit before any network call');
});

test('searchTracks returns [] for an empty query without a request', async () => {
  let called = false;
  await withFetch(async () => { called = true; return { ok: true, json: async () => ({ results: [] }) }; }, async () => {
    const out = await searchTracks('   ', { clientId: 'x' });
    assert.deepEqual(out, []);
  });
  assert.equal(called, false);
});

test('searchTracks builds the documented request shape and parses results', async () => {
  let seenUrl = null;
  await withFetch(async (url) => {
    seenUrl = new URL(url);
    return {
      ok: true,
      json: async () => ({
        headers: { status: 'success' },
        results: [
          {
            id: '123', name: 'Song One', artist_name: 'Artist A', duration: 185,
            image: 'http://img/1.jpg', audiodownload: 'http://cdn/1.mp3',
            audiodownload_allowed: true, license_ccurl: 'http://cc/by',
          },
        ],
      }),
    };
  }, async () => {
    const out = await searchTracks('lofi', { clientId: 'my-id', limit: 5 });
    assert.equal(seenUrl.searchParams.get('client_id'), 'my-id');
    assert.equal(seenUrl.searchParams.get('search'), 'lofi');
    assert.equal(seenUrl.searchParams.get('limit'), '5');
    assert.equal(seenUrl.searchParams.get('format'), 'json');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      id: '123', name: 'Song One', artist: 'Artist A', duration: 185,
      image: 'http://img/1.jpg', audiodownload: 'http://cdn/1.mp3', licenseCcUrl: 'http://cc/by',
    });
  });
});

test('searchTracks clamps limit into [1,50]', async () => {
  let seenUrl = null;
  await withFetch(async (url) => {
    seenUrl = new URL(url);
    return { ok: true, json: async () => ({ headers: { status: 'success' }, results: [] }) };
  }, async () => {
    await searchTracks('x', { clientId: 'id', limit: 9999 });
    assert.equal(seenUrl.searchParams.get('limit'), '50');
    await searchTracks('x', { clientId: 'id', limit: 0 });
    assert.equal(seenUrl.searchParams.get('limit'), '1');
  });
});

test('searchTracks drops results the API itself marks download-forbidden or with no file', async () => {
  await withFetch(async () => ({
    ok: true,
    json: async () => ({
      headers: { status: 'success' },
      results: [
        { id: '1', name: 'Blocked', audiodownload: 'http://cdn/1.mp3', audiodownload_allowed: false },
        { id: '2', name: 'NoFile', audiodownload: '', audiodownload_allowed: true },
        { id: '3', name: 'Fine', audiodownload: 'http://cdn/3.mp3', audiodownload_allowed: true },
      ],
    }),
  }), async () => {
    const out = await searchTracks('x', { clientId: 'id' });
    assert.deepEqual(out.map((t) => t.id), ['3']);
  });
});

test('searchTracks surfaces the real Jamendo error shape (bad client_id) as a JamendoError', async () => {
  await withFetch(async () => ({
    ok: true,
    json: async () => ({
      headers: { status: 'failed', error_message: 'Jamendo Api Invalid Client Id Error: Your credential is not authorized.' },
      results: [],
    }),
  }), async () => {
    await assert.rejects(
      () => searchTracks('x', { clientId: 'bad' }),
      (err) => err instanceof JamendoError && /not authorized/.test(err.message),
    );
  });
});

test('a hung request times out as a JamendoError rather than leaving the caller waiting forever', async () => {
  await withFetch((url, { signal } = {}) => new Promise((resolve, reject) => {
    // Never resolves on its own -- only the AbortController inside
    // fetchWithTimeout can end this, exactly like an unreachable host.
    signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  }), async () => {
    await assert.rejects(
      () => searchTracks('x', { clientId: 'id', timeoutMs: 30 }),
      (err) => err instanceof JamendoError && /timed out/i.test(err.message),
    );
  });
});

test('searchTracks surfaces a non-OK HTTP response as a JamendoError', async () => {
  await withFetch(async () => ({ ok: false, status: 500 }), async () => {
    await assert.rejects(() => searchTracks('x', { clientId: 'id' }), JamendoError);
  });
});

test('searchTracks surfaces a network failure as a JamendoError', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    await assert.rejects(() => searchTracks('x', { clientId: 'id' }), JamendoError);
  });
});

test('fetchTrackAsFile wraps the downloaded audio as a File the drop pipeline already understands', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await withFetch(async (url) => {
    assert.equal(url, 'http://cdn/1.mp3');
    return { ok: true, blob: async () => new Blob([bytes], { type: 'audio/mpeg' }) };
  }, async () => {
    const file = await fetchTrackAsFile({ name: 'My: Song/Title', audiodownload: 'http://cdn/1.mp3' });
    assert.ok(file instanceof File);
    assert.equal(file.name, 'My_ Song_Title.mp3');
    assert.equal(file.type, 'audio/mpeg');
    assert.equal(file.size, bytes.length);
  });
});

test('fetchTrackAsFile surfaces a failed download as a JamendoError', async () => {
  await withFetch(async () => ({ ok: false, status: 404 }), async () => {
    await assert.rejects(() => fetchTrackAsFile({ name: 'Gone', audiodownload: 'http://cdn/x.mp3' }), JamendoError);
  });
});
