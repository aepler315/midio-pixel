// A URL is the only way into a browser that has no file chooser, so the
// rules about which URLs can possibly work are load-bearing: getting them
// wrong means the player is told "could not load" by a page that never
// tried, or watches a request that the browser was always going to block.
//
// These tests hold the three that decide it -- the loopback carve-out in
// mixed-content blocking, what counts as audio, and that a directory index
// off an untrusted server contributes links and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUrl, isLoopbackHost, isAudioName, extensionOf, audioNameFromUrl,
  parseListing, parseJsonListing, fetchAudioAsFile, openAudioUrl, UrlAudioError,
} from '../src/net/UrlAudioSource.js';
import { AUDIO_LOAD_LIMITS } from '../src/audio/loadLimits.js';

const HTTPS_PAGE = 'https://supermaudio.com/';
const HTTP_PAGE = 'http://localhost:8080/';

test('loopback hosts are recognised across the whole 127/8 block and IPv6', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '127.255.255.255', 'localhost', 'LOCALHOST', 'app.localhost', '[::1]', '::1']) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
  }
  for (const host of ['192.168.1.5', '10.0.0.1', '128.0.0.1', 'example.com', '', '127.0.0.256', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), false, `${host} should not be loopback`);
  }
});

test('an https page may load http from loopback but not from a LAN address', () => {
  // This is the whole reason the feature is usable on a phone: the file
  // server runs on the same device as the browser, so it is loopback.
  const loopback = classifyUrl('http://127.0.0.1:8088/song.mp3', HTTPS_PAGE);
  assert.equal(loopback.ok, true);

  const lan = classifyUrl('http://192.168.1.5:8088/song.mp3', HTTPS_PAGE);
  assert.equal(lan.ok, false);
  assert.equal(lan.code, 'mixed-content');
  // The message has to name the way out, not just the refusal.
  assert.match(lan.message, /mixed content/i);
  assert.match(lan.message, /127\.0\.0\.1/);
});

test('an http page is not subject to the mixed-content rule at all', () => {
  const lan = classifyUrl('http://192.168.1.5:8088/song.mp3', HTTP_PAGE);
  assert.equal(lan.ok, true);
});

test('https is always allowed, loopback or not', () => {
  assert.equal(classifyUrl('https://example.com/a.flac', HTTPS_PAGE).ok, true);
  assert.equal(classifyUrl('https://127.0.0.1/a.flac', HTTPS_PAGE).ok, true);
});

test('a bare host:port is treated as http, which is what someone types on a car screen', () => {
  const verdict = classifyUrl('127.0.0.1:8088/song.mp3', HTTPS_PAGE);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url, 'http://127.0.0.1:8088/song.mp3');
});

test('file:// is refused with the reason, not as a generic bad URL', () => {
  const verdict = classifyUrl('file:///sdcard/Music/song.mp3', HTTPS_PAGE);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'scheme');
  // Reaching for file:// is the first thing anyone tries once the chooser
  // fails, so this message is the one that has to teach something.
  assert.match(verdict.message, /cannot read file:\/\//);
});

test('empty and unparseable input are distinguished', () => {
  assert.equal(classifyUrl('', HTTPS_PAGE).code, 'empty');
  assert.equal(classifyUrl('   ', HTTPS_PAGE).code, 'empty');
  assert.equal(classifyUrl('http://', HTTPS_PAGE).code, 'invalid');
});

test('audio is recognised by extension, case-insensitively, and video is not', () => {
  for (const name of ['a.mp3', 'a.MP3', 'a.flac', 'a.m4a', 'a.opus', 'a.oga', 'a.wav', 'a.aac']) {
    assert.equal(isAudioName(name), true, name);
  }
  for (const name of ['a.mp4', 'a.jpg', 'cover.png', 'a.nfo', 'a', '', 'a.cue']) {
    assert.equal(isAudioName(name), false, name);
  }
  assert.equal(extensionOf('Song.Name.FLAC'), '.flac');
});

test('MIDI is not offered, because this page cannot decode it', () => {
  // Everything from here reaches audioEngine.decodeFile() == decodeAudioData,
  // and the page has no MIDI ingest path (MidiAdapter is test-only). Listing
  // a .mid would advertise a song that fails to decode every single time.
  assert.equal(isAudioName('song.mid'), false);
  assert.equal(isAudioName('song.midi'), false);
  const { entries } = parseListing('<ignored/>', 'http://127.0.0.1:8088/', {
    parse: fakeParser([['tune.mid', 'tune.mid'], ['real.mp3', 'real.mp3']]),
  });
  assert.deepEqual(entries.map((e) => e.name), ['real.mp3']);
});

test('a filename comes back percent-decoded, because %20 is not a song title', () => {
  assert.equal(audioNameFromUrl('http://127.0.0.1:8088/Rock/03%20Airbag.flac'), '03 Airbag.flac');
  assert.equal(audioNameFromUrl('http://127.0.0.1:8088/'), 'url-audio');
  // A malformed escape must not throw on the way to a filename.
  assert.equal(audioNameFromUrl('http://127.0.0.1:8088/bad%zz.mp3'), 'bad%zz.mp3');
});

// --- directory listings --------------------------------------------------

/** parseListing takes an injectable parser so it runs without a DOM. */
function fakeParser(links) {
  return () => ({
    querySelectorAll: () => links.map(([href, text]) => ({
      getAttribute: (name) => (name === 'href' ? href : null),
      textContent: text ?? '',
    })),
  });
}

test('a directory index yields its audio links, resolved against the folder', () => {
  const { entries } = parseListing('<ignored/>', 'http://127.0.0.1:8088/Rock/', {
    parse: fakeParser([
      ['01%20Intro.mp3', '01 Intro.mp3'],
      ['cover.jpg', 'cover.jpg'],
      ['/Jazz/So%20What.flac', 'So What.flac'],
      ['#top', 'top'],
    ]),
  });
  assert.deepEqual(entries.map((e) => e.name), ['01 Intro.mp3', 'So What.flac']);
  assert.equal(entries[0].url, 'http://127.0.0.1:8088/Rock/01%20Intro.mp3');
  // An absolute href is honoured, so a listing may point outside its folder.
  assert.equal(entries[1].url, 'http://127.0.0.1:8088/Jazz/So%20What.flac');
});

test('subfolders are offered, but the index\'s own parent link is not a subfolder', () => {
  const { folders } = parseListing('<ignored/>', 'http://127.0.0.1:8088/Rock/', {
    parse: fakeParser([
      ['Live/', 'Live/'],
      ['../', 'Parent Directory'],
      ['/', 'root'],
    ]),
  });
  // Without the descendant check, every listing shows "../" and "/" as
  // folders to open, which reads as two mystery entries in every folder.
  assert.deepEqual(folders.map((f) => f.name), ['Live']);
  assert.equal(folders[0].url, 'http://127.0.0.1:8088/Rock/Live/');
});

test('a listing link is data: its label never carries markup into the page', () => {
  // renderUrlListing uses textContent, and this is the parser half of that
  // contract -- the label is whatever the server said, as a string.
  const { entries } = parseListing('<ignored/>', 'http://127.0.0.1:8088/', {
    parse: fakeParser([['evil.mp3', '<img src=x onerror=alert(1)>']]),
  });
  // The label is not audio-looking, so the path wins; either way it is text.
  assert.equal(entries[0].name, 'evil.mp3');
  assert.equal(typeof entries[0].name, 'string');
});

test('duplicate hrefs in one index are listed once', () => {
  const { entries } = parseListing('<ignored/>', 'http://127.0.0.1:8088/', {
    parse: fakeParser([['a.mp3', 'a'], ['a.mp3', 'a again'], ['./a.mp3', 'a third time']]),
  });
  assert.equal(entries.length, 1);
});

test('the JSON listing shape music-server serves is understood', () => {
  const { entries, folders } = parseJsonListing({
    path: '/Rock/',
    folders: ['/Rock/Live/'],
    files: [{ name: '01 Intro.mp3', url: '/Rock/01%20Intro.mp3' }],
  }, 'http://127.0.0.1:8088/Rock/');
  assert.deepEqual(entries.map((e) => e.name), ['01 Intro.mp3']);
  assert.deepEqual(folders.map((f) => f.name), ['Live']);
});

test('looser JSON shapes from other local servers still work', () => {
  // A bare array of filenames is what the simplest hand-rolled servers emit.
  const bare = parseJsonListing(['a.mp3', 'b.flac', 'cover.jpg'], 'http://127.0.0.1:8088/');
  assert.deepEqual(bare.entries.map((e) => e.name), ['a.mp3', 'b.flac']);
  assert.deepEqual(bare.folders, []);
  // And nothing usable is an empty result, not a throw.
  assert.deepEqual(parseJsonListing(null, 'http://127.0.0.1:8088/'), { entries: [], folders: [] });
});

// --- fetching ------------------------------------------------------------

function response({ ok = true, status = 200, headers = {}, blob = null, body = null, json = null }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  // A listing is read as TEXT and parsed by the module, so a `json` fixture
  // has to be serialised into the body the way a real server would send it.
  const text = body !== null ? body : (json !== null ? JSON.stringify(json) : null);
  return {
    ok,
    status,
    statusText: '',
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    blob: async () => blob,
    text: async () => text,
    json: async () => json,
  };
}

/** A stand-in for Blob/File so these tests need no browser globals. */
function fakeBlob(size, type = 'audio/mpeg') {
  return { size, type, arrayBuffer: async () => new ArrayBuffer(size) };
}

/** A response whose body streams `chunkSizes` in order, so the size cap can
 *  be observed taking effect mid-transfer rather than after the fact. */
function streamingResponse(chunkSizes, headers = {}) {
  let i = 0;
  let cancelled = false;
  const res = response({ headers });
  res.body = {
    getReader: () => ({
      read: async () => (i < chunkSizes.length
        ? { done: false, value: new Uint8Array(chunkSizes[i++]) }
        : { done: true, value: undefined }),
      cancel: async () => { cancelled = true; },
    }),
  };
  res.wasCancelled = () => cancelled;
  res.chunksRead = () => i;
  return res;
}

function withFetch(impl, run) {
  const original = globalThis.fetch;
  const originalFile = globalThis.File;
  globalThis.fetch = impl;
  // `new File([blob], name, {type})` is how the drop pipeline is reached;
  // Node has File, but not one that accepts a fake blob, so stub it.
  const originalBlob = globalThis.Blob;
  globalThis.Blob = class {
    constructor(parts = [], options = {}) {
      this.size = parts.reduce((n, p) => n + (p?.byteLength || p?.size || 0), 0);
      this.type = options.type || '';
    }
  };
  globalThis.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || '';
      this.size = parts.reduce((n, p) => n + (p?.size || 0), 0);
    }
  };
  return (async () => {
    try { return await run(); } finally {
      globalThis.fetch = original;
      globalThis.File = originalFile;
      globalThis.Blob = originalBlob;
    }
  })();
}

test('an audio URL becomes a File the drop pipeline already accepts', async () => {
  await withFetch(
    async () => response({ headers: { 'content-length': '2048', 'content-type': 'audio/flac' }, blob: fakeBlob(2048, 'audio/flac') }),
    async () => {
      const file = await fetchAudioAsFile('http://127.0.0.1:8088/Rock/03%20Airbag.flac');
      // name/size/arrayBuffer() is the entire contract loadAudioFiles needs.
      assert.equal(file.name, '03 Airbag.flac');
      assert.equal(file.size, 2048);
      assert.equal(file.type, 'audio/flac');
    },
  );
});

test('an oversized file is refused from Content-Length, before the body is read', async () => {
  let blobRead = false;
  await withFetch(
    async () => {
      const res = response({ headers: { 'content-length': String(400 * 1024 * 1024) } });
      res.blob = async () => { blobRead = true; return fakeBlob(1); };
      return res;
    },
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/huge.mp3'),
        (err) => err instanceof UrlAudioError && /over the/.test(err.message),
      );
      // The point of checking the header is not downloading it first.
      assert.equal(blobRead, false);
    },
  );
});

test('a lying Content-Length does not get past the check on the real bytes', async () => {
  await withFetch(
    async () => response({
      headers: { 'content-length': '1024' },
      blob: fakeBlob(400 * 1024 * 1024),
    }),
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/liar.mp3'),
        (err) => err instanceof UrlAudioError,
      );
    },
  );
});

test('an unreachable host reports the missing CORS header, the likeliest cause', async () => {
  // fetch reports a CORS rejection, a refused connection and a wrong port
  // identically ("Failed to fetch") so a page cannot probe the network. For
  // a local music server the missing header is overwhelmingly likeliest, so
  // the message has to say so rather than leaving the player with nothing.
  await withFetch(
    async () => { throw new TypeError('Failed to fetch'); },
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/a.mp3'),
        (err) => err instanceof UrlAudioError && /Access-Control-Allow-Origin/.test(err.message),
      );
    },
  );
});

test('an HTTP error is reported with its status', async () => {
  await withFetch(
    async () => response({ ok: false, status: 404 }),
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/gone.mp3'),
        (err) => err instanceof UrlAudioError && /HTTP 404/.test(err.message),
      );
    },
  );
});

test('an empty response is an error, not a zero-byte song to decode', async () => {
  await withFetch(
    async () => response({ headers: { 'content-length': '0' }, blob: fakeBlob(0) }),
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/empty.mp3'),
        (err) => err instanceof UrlAudioError && /empty/.test(err.message),
      );
    },
  );
});

test('openAudioUrl blocks a LAN http URL without making a request', async () => {
  let requested = false;
  await withFetch(
    async () => { requested = true; return response({ blob: fakeBlob(1) }); },
    async () => {
      await assert.rejects(
        () => openAudioUrl('http://192.168.1.5:8088/a.mp3', { pageUrl: HTTPS_PAGE }),
        (err) => err instanceof UrlAudioError && /mixed content/i.test(err.message),
      );
      assert.equal(requested, false);
    },
  );
});

test('openAudioUrl fetches an audio path directly -- one request, no probe', async () => {
  const urls = [];
  await withFetch(
    async (url) => {
      urls.push(url);
      return response({ headers: { 'content-type': 'audio/mpeg' }, blob: fakeBlob(64) });
    },
    async () => {
      const result = await openAudioUrl('http://127.0.0.1:8088/a.mp3', { pageUrl: HTTPS_PAGE });
      assert.equal(result.kind, 'audio');
      assert.equal(urls.length, 1);
    },
  );
});

test('openAudioUrl turns a folder into a browsable listing', async () => {
  await withFetch(
    async () => response({
      headers: { 'content-type': 'application/json' },
      json: { folders: ['/Rock/'], files: [{ name: 'a.mp3', url: '/a.mp3' }] },
    }),
    async () => {
      const result = await openAudioUrl('http://127.0.0.1:8088/', { pageUrl: HTTPS_PAGE });
      assert.equal(result.kind, 'listing');
      assert.deepEqual(result.entries.map((e) => e.name), ['a.mp3']);
      assert.deepEqual(result.folders.map((f) => f.name), ['Rock']);
    },
  );
});

test('a folder with subfolders but no songs is a listing, not an error', async () => {
  // The top of a music tree usually has only artist folders in it; erroring
  // there would make the whole browse path unusable at its entry point.
  await withFetch(
    async () => response({
      headers: { 'content-type': 'application/json' },
      json: { folders: ['/Rock/', '/Jazz/'], files: [] },
    }),
    async () => {
      const result = await openAudioUrl('http://127.0.0.1:8088/', { pageUrl: HTTPS_PAGE });
      assert.equal(result.kind, 'listing');
      assert.equal(result.entries.length, 0);
      assert.equal(result.folders.length, 2);
    },
  );
});

test('an extensionless URL that serves audio anyway is still playable', async () => {
  await withFetch(
    async () => response({ headers: { 'content-type': 'audio/mpeg' }, blob: fakeBlob(128, 'audio/mpeg') }),
    async () => {
      const result = await openAudioUrl('http://127.0.0.1:8088/stream/7', { pageUrl: HTTPS_PAGE });
      assert.equal(result.kind, 'audio');
      // Decoding is by content sniffing, but a name with no extension breaks
      // the library's own audio filters, so one is supplied.
      assert.match(result.file.name, /\.mp3$/);
    },
  );
});

test('a page of prose is reported as such, not decoded as audio', async () => {
  await withFetch(
    async () => response({ headers: { 'content-type': 'text/plain' }, body: 'nope' }),
    async () => {
      await assert.rejects(
        () => openAudioUrl('http://127.0.0.1:8088/readme', { pageUrl: HTTPS_PAGE }),
        (err) => err instanceof UrlAudioError && /neither audio nor a folder/.test(err.message),
      );
    },
  );
});


// --- the size cap during transfer ---------------------------------------

test('a lying Content-Length is cut off mid-transfer, not buffered in full', async () => {
  // The header check cannot be trusted, so the bytes are counted as they
  // arrive. Without this, a server declaring 1KB and streaming gigabytes
  // would exhaust the tab before anyone noticed.
  const oneMib = 1024 * 1024;
  const res = streamingResponse(new Array(600).fill(oneMib), { 'content-length': '1024' });
  await withFetch(
    async () => res,
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/liar.mp3'),
        (err) => err instanceof UrlAudioError && /understated its size/.test(err.message),
      );
      // Cut off, not drained: the reader was cancelled part-way through.
      assert.equal(res.wasCancelled(), true);
      assert.ok(res.chunksRead() < 600, 'should stop before reading every chunk');
    },
  );
});

test('a streamed file within the limit arrives whole', async () => {
  const res = streamingResponse([1000, 2000, 48], { 'content-type': 'audio/flac' });
  await withFetch(
    async () => res,
    async () => {
      const file = await fetchAudioAsFile('http://127.0.0.1:8088/ok.flac');
      assert.equal(file.size, 3048);
      assert.equal(res.wasCancelled(), false);
    },
  );
});

test('the extensionless branch refuses an oversized declared length too', async () => {
  // This branch used to call blob() before applying the limit, so it would
  // buffer the whole response where the direct path refused it outright.
  let bodyRead = false;
  await withFetch(
    async () => {
      const res = response({
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(400 * 1024 * 1024) },
      });
      res.blob = async () => { bodyRead = true; return fakeBlob(1); };
      return res;
    },
    async () => {
      await assert.rejects(
        () => openAudioUrl('http://127.0.0.1:8088/stream/7', { pageUrl: HTTPS_PAGE }),
        (err) => err instanceof UrlAudioError && /over the/.test(err.message),
      );
      assert.equal(bodyRead, false, 'must refuse from the header, before reading');
    },
  );
});

test('a body that stalls after the headers is abandoned, not waited on forever', async () => {
  // fetch() resolves on headers, so a helper that clears its timer there
  // leaves the body read unbounded and un-abortable. This is that hang.
  await withFetch(
    async (url, { signal }) => {
      const res = response({ headers: { 'content-type': 'audio/mpeg' } });
      res.body = {
        getReader: () => ({
          // Never resolves on its own; only the abort signal ends it.
          read: () => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }),
          cancel: async () => {},
        }),
      };
      return res;
    },
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/stalls.mp3', {
          limits: AUDIO_LOAD_LIMITS, stallMs: 20,
        }),
        (err) => err instanceof UrlAudioError && /stopped sending data/.test(err.message),
      );
    },
  );
});

test("a caller's own abort is not reported as a timeout", async () => {
  const controller = new AbortController();
  await withFetch(
    async (url, { signal }) => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      void signal;
      throw err;
    },
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/a.mp3', { signal: controller.signal }),
        // Rethrown as-is so the UI can tell "superseded" from "failed".
        (err) => err.name === 'AbortError' && !(err instanceof UrlAudioError),
      );
    },
  );
});


test('a broken listing is reported as such, not as a CORS or connectivity failure', async () => {
  // Once the response has arrived, a thrown error is the consumer's problem.
  // Blaming CORS for malformed JSON sends someone to fix response headers
  // when the actual fault is the body.
  await withFetch(
    async () => {
      // An HTML error page served with a JSON content-type: the parse, not
      // the network, is what fails.
      return response({ headers: { 'content-type': 'application/json' }, body: '<html>nope</html>' });
    },
    async () => {
      await assert.rejects(
        () => openAudioUrl('http://127.0.0.1:8088/', { pageUrl: HTTPS_PAGE }),
        (err) => err instanceof UrlAudioError
          && /answered, but its response could not be read/.test(err.message)
          && !/Access-Control-Allow-Origin/.test(err.message),
      );
    },
  );
});

test('a server that never answers is still reported as unreachable, naming CORS', async () => {
  // The other half of that split: nothing came back, so the CORS advice is
  // the useful guess and must survive.
  await withFetch(
    async () => { throw new TypeError('Failed to fetch'); },
    async () => {
      await assert.rejects(
        () => openAudioUrl('http://127.0.0.1:8088/', { pageUrl: HTTPS_PAGE }),
        (err) => err instanceof UrlAudioError && /Access-Control-Allow-Origin/.test(err.message),
      );
    },
  );
});

test('a timeout before any response reads differently from one mid-transfer', async () => {
  await withFetch(
    async (url, { signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    }),
    async () => {
      await assert.rejects(
        () => fetchAudioAsFile('http://127.0.0.1:8088/silent.mp3', { stallMs: 20 }),
        (err) => err instanceof UrlAudioError && /did not answer within/.test(err.message),
      );
    },
  );
});


// --- what the third review round turned up -------------------------------

test('a bare host:port works even when the host starts with a letter', () => {
  // `localhost:8088` parses as a URL whose SCHEME is `localhost:`, so a
  // scheme check that only looked for `x:` rejected the single most likely
  // thing anyone types -- while `isLoopbackHost` explicitly supports it.
  for (const raw of ['localhost:8088/a.mp3', '127.0.0.1:8088/a.mp3']) {
    const verdict = classifyUrl(raw, HTTPS_PAGE);
    assert.equal(verdict.ok, true, raw);
    assert.equal(verdict.url.startsWith('http://'), true, raw);
  }
  assert.equal(classifyUrl('localhost:8088/a.mp3', HTTPS_PAGE).url, 'http://localhost:8088/a.mp3');

  // A non-loopback bare host is now read as a HOST rather than a scheme,
  // and is then refused for the right reason. Before, it came back as
  // `scheme` -- "only http:// and https:// can be loaded" -- about an
  // address that was already http.
  assert.equal(classifyUrl('music.local:8088/a.mp3', HTTPS_PAGE).code, 'mixed-content');
  assert.equal(classifyUrl('music.local:8088/a.mp3', HTTP_PAGE).ok, true);
});

test('requiring :// does not break the schemes that carry meaning', () => {
  // file:// must still be recognised so it gets its own explanation
  // rather than being turned into http://file://...
  assert.equal(classifyUrl('file:///sdcard/a.mp3', HTTPS_PAGE).code, 'scheme');
  assert.equal(classifyUrl('https://example.com/a.flac', HTTPS_PAGE).ok, true);
  // A scheme with no slashes is not a host, and must not become one.
  assert.equal(classifyUrl('javascript:alert(1)', HTTPS_PAGE).ok, false);
  assert.equal(classifyUrl('mailto:a@b.com', HTTPS_PAGE).ok, false);
});

test('an explicit listing name survives an extensionless download URL', () => {
  // The row is admitted BECAUSE of its name (the URL has no extension), so
  // discarding that name right afterwards labels the track "download".
  const { entries } = parseJsonListing({
    files: [{ name: 'Pretty Song.flac', url: 'download?id=1' }],
  }, 'http://127.0.0.1:8088/');
  assert.equal(entries[0].name, 'Pretty Song.flac');
});

test('a fetched file can be given the name the listing declared', async () => {
  await withFetch(
    async () => response({ headers: { 'content-type': 'audio/flac' }, blob: fakeBlob(64, 'audio/flac') }),
    async () => {
      const file = await fetchAudioAsFile('http://127.0.0.1:8088/download?id=1', {
        name: 'Pretty Song.flac',
      });
      assert.equal(file.name, 'Pretty Song.flac');
      // and without one, the URL is still the fallback
      const fallback = await fetchAudioAsFile('http://127.0.0.1:8088/download?id=1');
      assert.equal(fallback.name, 'download');
    },
  );
});

test('a redirected folder resolves its links against where it landed', async () => {
  // A conventional server redirects /music to /music/. Resolving `song.mp3`
  // against the pre-redirect URL yields /song.mp3 -- a 404 on every click.
  await withFetch(
    async () => {
      const res = response({
        headers: { 'content-type': 'application/json' },
        json: { folders: [], files: [{ name: 'song.mp3', url: 'song.mp3' }] },
      });
      res.url = 'http://127.0.0.1:8088/music/'; // where fetch actually ended up
      return res;
    },
    async () => {
      const result = await openAudioUrl('http://127.0.0.1:8088/music', { pageUrl: HTTPS_PAGE });
      assert.equal(result.entries[0].url, 'http://127.0.0.1:8088/music/song.mp3');
      // The reported url is the final one too, so "Up a folder" is derived
      // from a path that actually exists.
      assert.equal(result.url, 'http://127.0.0.1:8088/music/');
    },
  );
});

test('a listing body re-arms the stall deadline as it streams', async () => {
  // res.json()/res.text() read the body internally and never call back, so
  // using them made the documented stall deadline a total-duration one: a
  // big index arriving steadily was aborted anyway.
  let arms = 0;
  const payload = JSON.stringify({ files: [{ name: 'a.mp3', url: '/a.mp3' }] });
  const bytes = new TextEncoder().encode(payload);
  await withFetch(
    async () => {
      const res = response({ headers: { 'content-type': 'application/json' } });
      let i = 0;
      res.body = {
        getReader: () => ({
          // One byte at a time, so every chunk is an observable tick.
          read: async () => (i < bytes.length
            ? { done: false, value: bytes.slice(i, ++i) }
            : { done: true, value: undefined }),
          cancel: async () => {},
        }),
      };
      return res;
    },
    async () => {
      const original = globalThis.setTimeout;
      globalThis.setTimeout = (...args) => { arms++; return original(...args); };
      try {
        const result = await openAudioUrl('http://127.0.0.1:8088/', { pageUrl: HTTPS_PAGE });
        assert.equal(result.entries.length, 1);
      } finally {
        globalThis.setTimeout = original;
      }
      // One arm per chunk, plus the initial and post-headers arms.
      assert.ok(arms >= bytes.length, `expected >= ${bytes.length} re-arms, saw ${arms}`);
    },
  );
});


test('an HTML index admits a download link by its visible filename', () => {
  // A file-manager share commonly renders a track as
  // `<a href="download?id=1">Pretty Song.flac</a>`. Gating on the pathname
  // alone dropped the row before the label was ever read -- while
  // parseJsonListing already admitted the same shape on its name.
  const { entries } = parseListing('<ignored/>', 'http://127.0.0.1:8088/', {
    parse: fakeParser([
      ['download?id=1', 'Pretty Song.flac'],
      ['download?id=2', 'readme'],
      ['plain.mp3', 'plain.mp3'],
    ]),
  });
  assert.deepEqual(entries.map((e) => e.name), ['Pretty Song.flac', 'plain.mp3']);
  // The explicit label becomes the name, since the URL has none to offer.
  assert.equal(entries[0].url, 'http://127.0.0.1:8088/download?id=1');
});

test('a label that is not audio cannot smuggle in a non-audio link', () => {
  const { entries } = parseListing('<ignored/>', 'http://127.0.0.1:8088/', {
    parse: fakeParser([['cover.jpg', 'cover.jpg'], ['notes.txt', 'notes']]),
  });
  assert.deepEqual(entries, []);
});
