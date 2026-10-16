// Loading a song from a URL instead of a file picker.
//
// WHY THIS EXISTS. An `<input type="file">` only opens a chooser if the
// browser implements one. An Android WebView does not implement it itself --
// it calls `WebChromeClient.onShowFileChooser()` and the *host app* decides.
// An app that never overrides that method gets no chooser at all, and the
// tap that should have opened one instead leaves the hidden input focused,
// so Android raises the soft keyboard. That is the whole bug as a player
// sees it: "the upload button just opens the keyboard".
//
// Fermata (github.com/AndreyPavlenko/Fermata) is one such app. Its
// `FermataChromeClient` overrides the JS dialogs, fullscreen, geolocation
// and permission callbacks and nothing else -- `onShowFileChooser` and
// `FileChooserParams` appear nowhere in that repository. No markup or
// script this page can serve will make a chooser appear there, and the File
// System Access API (`showOpenFilePicker`) does not exist in a WebView
// either. The button is not fixable from our side; it needs a different
// route to the bytes.
//
// So: a URL. `loadAudioFiles()` in main.js wants objects with `name`,
// `size` and `arrayBuffer()`, which is exactly a `File` -- so a fetched
// blob wrapped as a File plays, analyses and caches identically to a drop,
// and nothing downstream of the picker changes. (`JamendoSource.js` already
// reaches the pipeline this way.)
//
// MIXED CONTENT, AND WHY LOOPBACK IS THE USEFUL CASE. supermaudio.com is
// https, and an https page may not fetch http:// subresources. The one
// carve-out is loopback: 127.0.0.0/8, `localhost` and `[::1]` count as
// "potentially trustworthy" origins, so they are not treated as mixed
// content. That carve-out is what makes this feature worth having on a
// phone -- a file-server app running on the same phone as Fermata is
// reachable at `http://127.0.0.1:<port>`, and its music is the music the
// player actually wants. A plain LAN address (http://192.168.x.x) is *not*
// exempt and will be blocked, so `classifyUrl` rejects it up front with an
// explanation rather than letting fetch fail opaquely.
//
// CORS IS STILL REQUIRED and cannot be worked around from a page. A
// `no-cors` fetch yields an opaque response whose bytes are unreadable, so
// it is useless for decoding. The server has to send
// `Access-Control-Allow-Origin`. `tools/music-server.mjs` in this repo is a
// minimal one that does; `docs/chooserless-webviews.md` covers the setup.
import {
  AUDIO_LOAD_LIMITS, validateAudioBytes,
} from '../audio/loadLimits.js';
import { AUDIO_EXTENSIONS as LIBRARY_AUDIO_EXTENSIONS } from '../library/LibraryScanner.js';

const LISTING_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 45000;

// What counts as audio, taken from the library scanner rather than
// restated here. A second hand-maintained list drifts: this one was missing
// .aif/.aiff/.wma, so a folder the normal library workflow shows in full
// appeared with tracks silently absent when browsed by URL.
//
// `.mid`/`.midi` are absent from that list too, which is correct for this
// path: everything here goes to `handleFiles()` and on to
// `audioEngine.decodeFile()` -- `decodeAudioData` -- and the page has no
// MIDI ingest at all (`MidiAdapter` is reachable only from the tests), so a
// listed MIDI file would advertise a song that fails to decode every time.
const AUDIO_EXTENSIONS = LIBRARY_AUDIO_EXTENSIONS.map((ext) => `.${ext}`);

const MIME_BY_EXTENSION = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
};

export class UrlAudioError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'UrlAudioError';
    if (Number.isInteger(status)) this.status = status;
    if (code) this.code = code;
  }
}

/** True for the loopback hosts the mixed-content rules treat as secure.
 *  The whole 127.0.0.0/8 block qualifies, not just 127.0.0.1, and an IPv6
 *  literal arrives from `URL` still wrapped in its brackets. */
export function isLoopbackHost(host) {
  const name = String(host || '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '[::1]' || name === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name)
    && name.split('.').every((part) => Number(part) <= 255);
}

export function extensionOf(name) {
  const match = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return match ? match[0].toLowerCase() : '';
}

export function isAudioName(name) {
  return AUDIO_EXTENSIONS.includes(extensionOf(name));
}

/** A filename for a fetched URL. The last non-empty path segment is what a
 *  player recognises ("03 Airbag.flac"), percent-decoded because a server
 *  that had to escape a space should not surface it as `%20` in the HUD. */
export function audioNameFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url || '');
  }
  const segment = pathname.split('/').filter(Boolean).pop() || '';
  let name;
  try {
    name = decodeURIComponent(segment);
  } catch {
    name = segment; // a malformed escape is not worth failing a load over
  }
  return name || 'url-audio';
}

/**
 * Decides whether a URL is worth attempting before any request is made, so
 * the failure a player sees names the actual problem. Returns
 * `{ ok, url, code, message }`; `code` is stable for tests and for the UI.
 *
 * @param {string} raw      what the player typed
 * @param {string} pageUrl  the page's own URL (injected for testability)
 */
export function classifyUrl(raw, pageUrl = 'https://supermaudio.com/') {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, code: 'empty', message: 'Enter a URL first.' };

  let url;
  try {
    // Resolving against the page lets a bare `127.0.0.1:8080/song.mp3` work,
    // which is what someone typing on a car screen will actually enter.
    //
    // The test is for `://`, not merely `scheme:`. A bare `localhost:8088`
    // or `music.local:8088` otherwise parses as a URL whose SCHEME is
    // `localhost:`/`music.local:` -- and is then rejected by the scheme
    // check below, even though `localhost` is exactly the loopback setup
    // this feature is built around. Requiring the slashes keeps
    // `file:///...` and `http://...` recognised while treating a
    // hostname-and-port as what it is.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`, pageUrl);
  } catch {
    return { ok: false, code: 'invalid', message: `"${text}" is not a URL.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:// is the one people reach for first, and it is the one thing a
    // page can never read -- say so explicitly instead of "invalid URL".
    const extra = url.protocol === 'file:'
      ? ' A web page cannot read file:// paths; serve the folder over HTTP instead.'
      : '';
    return {
      ok: false,
      code: 'scheme',
      message: `Only http:// and https:// URLs can be loaded.${extra}`,
    };
  }

  let pageIsSecure = false;
  try {
    pageIsSecure = new URL(pageUrl).protocol === 'https:';
  } catch { /* treat an unparseable page URL as insecure: attempt the fetch */ }

  if (pageIsSecure && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      code: 'mixed-content',
      message: `This page is served over https, so it cannot load http://${url.hostname}`
        + ' -- the browser blocks it as mixed content. Loopback addresses'
        + ' (http://127.0.0.1) are exempt, so a server running on this same'
        + ' device works; anything else needs https.',
    };
  }

  return { ok: true, url: url.href, code: 'ok', message: '' };
}

/**
 * A request whose timeout covers reading the body, not just the headers.
 *
 * `fetch()` resolves as soon as the response HEADERS arrive. A helper that
 * clears its timer at that point leaves the body read -- `res.blob()`,
 * `res.text()`, `res.json()` -- with no timeout and no abort wiring at all,
 * so a server that sends headers and then stalls mid-transfer hangs the UI
 * forever: exactly the failure this helper exists to prevent. So the body is
 * consumed by `consume` INSIDE this function, under the same
 * `AbortController` and a still-live timer.
 *
 * The timer is a stall deadline, not a total budget: `consume` is handed an
 * `arm` callback to push it back whenever bytes actually arrive, so a large
 * download over a slow link is not killed for being slow while a silent
 * connection still dies on schedule.
 *
 * @param {string} url
 * @param {number} stallMs how long silence is tolerated before aborting
 * @param {AbortSignal|null} signal the caller's own cancellation
 * @param {(res: Response, arm: () => void) => Promise<any>} consume
 */
async function requestWithTimeout(url, stallMs, signal, consume, { fetchImpl = fetch, credentials, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), stallMs);
  };
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  arm();
  // Whether the response ever arrived. Once it has, a thrown error is the
  // consumer's problem (malformed JSON, an oversized body) and NOT a
  // network or CORS failure -- telling someone to check their CORS headers
  // because their directory index is invalid JSON sends them to fix the
  // wrong thing entirely.
  let responded = false;
  let response;
  let completed = false;
  try {
    const res = response = await fetchImpl(url, { signal: controller.signal, redirect, ...(credentials === undefined ? {} : { credentials }) });
    responded = true;
    arm(); // headers arrived; the body gets its own fresh stall window
    const result = await consume(res, arm, controller.signal);
    completed = true;
    return result;
  } catch (err) {
    if (signal?.aborted) throw err; // the caller's own cancellation, not ours
    if (err instanceof UrlAudioError) throw err; // already explained by consume
    if (err?.name === 'AbortError') {
      throw new UrlAudioError(responded
        ? `${url} stopped sending data for ${Math.round(stallMs / 1000)}s, so the transfer was cancelled.`
        : `${url} did not answer within ${Math.round(stallMs / 1000)}s.`, { code: 'TIMEOUT' });
    }
    if (responded) {
      // Reached, read, and then unusable. Name what actually broke.
      throw new UrlAudioError(
        `${url} answered, but its response could not be read:`
        + ` ${err?.message || err}. If that is a folder listing, check that`
        + ' the server is serving valid JSON or HTML.',
      );
    }
    // Nothing came back. A CORS rejection, a refused connection and a wrong
    // port are indistinguishable here by design -- fetch reports "Failed to
    // fetch" for all three so a page cannot probe the network. Since a
    // missing CORS header is overwhelmingly the likeliest cause for a local
    // file server, name it first rather than leaving the player with nothing.
    throw new UrlAudioError(
      `Could not reach ${url}. Either nothing is listening there, or the`
      + ' server did not send an Access-Control-Allow-Origin header (a page'
      + ' cannot read a response without it).',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
    if (!completed) {
      controller.abort();
      // Header rejection can occur before a reader exists. Dispose that body too.
      try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* already torn down */ }
    }
  }
}

/** The size limit as a human-readable megabyte count, for error messages. */
function megabytes(bytes) { return Math.round(bytes / (1024 * 1024)); }

/** Refuses an oversized response from its own `Content-Length`, before a
 *  byte of the body is read. A header is only a claim, so `readBody` below
 *  re-checks the bytes that actually arrive -- but honouring the claim when
 *  it is present avoids pulling down a disk image to find out. */
function checkDeclaredLength(res, name, limits) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limits.maxFileBytes) {
    throw new UrlAudioError(
      `${name} is ${megabytes(declared)}MB, over the ${megabytes(limits.maxFileBytes)}MB limit.`, { code: 'RESOURCE_LIMIT' },
    );
  }
}

/**
 * Reads a response body as a Blob, enforcing the size cap as the bytes
 * arrive rather than after they are all in memory.
 *
 * This is what makes a lying `Content-Length` harmless: a server that
 * declares 1KB and then streams gigabytes is cut off at the limit instead
 * of being buffered in full first.
 *
 * Where the response has no streaming body -- an older browser, or a test
 * double -- it falls back to a one-shot read, which is still bounded by the
 * stall timer and still cap-checked once it lands.
 */
/** A listing is text, not audio, and does not need the audio budget -- but
 *  it does need a bound, so a server streaming an endless index cannot fill
 *  memory. */
const LISTING_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Reads a listing body as text, re-arming the stall deadline per chunk.
 *
 * `res.json()` and `res.text()` read the whole body internally and never
 * call back, so using them turned the documented stall deadline into a
 * total-duration one: a large index arriving steadily over more than the
 * listing timeout was aborted even though bytes never stopped.
 */
async function readListingText(res, arm) {
  if (!res.body?.getReader) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arm(); // bytes arrived, so this is progress rather than a stall
    total += value.byteLength;
    if (total > LISTING_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* already torn down */ }
      throw new UrlAudioError(
        `The listing at ${res.url || 'that address'} is larger than`
        + ` ${Math.round(LISTING_MAX_BYTES / (1024 * 1024))}MB, so it was not read.`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readBody(res, arm, { name, limits, type = '', onProgress, signal }) {
  const declared = res.headers?.get?.('content-length');
  const totalBytes = declared !== null && declared !== undefined && /^\d+$/.test(declared)
    && Number.isSafeInteger(Number(declared)) ? Number(declared) : null;
  if (!res.body?.getReader) {
    const blob = await res.blob();
    if (blob.size > limits.maxFileBytes) {
      throw new UrlAudioError(
        `${name} is ${megabytes(blob.size)}MB, over the ${megabytes(limits.maxFileBytes)}MB limit.`, { code: 'RESOURCE_LIMIT' },
      );
    }
    onProgress?.({ receivedBytes: blob.size, totalBytes });
    return blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  // Cancellation must also stop injected response streams, not just native fetch.
  const onAbort = () => { Promise.resolve(reader.cancel?.()).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Audio transfer cancelled', 'AbortError');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('Audio transfer cancelled', 'AbortError');
      if (done) break;
      arm(); // bytes arrived, so this is progress rather than a stall
      total += value.byteLength;
      if (total > limits.maxFileBytes) {
        try { await reader.cancel(); } catch { /* already torn down */ }
        throw new UrlAudioError(
          `${name} exceeds the ${megabytes(limits.maxFileBytes)}MB limit`
          + ' (the server understated its size), so the transfer was stopped.', { code: 'RESOURCE_LIMIT' },
        );
      }
      chunks.push(value);
      onProgress?.({ receivedBytes: total, totalBytes });
    }
    return new Blob(chunks, type ? { type } : undefined);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

/**
 * Pulls playable audio links out of a directory index. This is the part
 * that answers "let me *see* the files" rather than "let me type one
 * path": point it at a folder on a local file server and the page shows
 * what is in it.
 *
 * The HTML is never inserted into the document -- only `href` attributes
 * are read, and each is resolved against the listing's own URL, so a
 * hostile index can contribute a link and nothing more.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {{ parse?: (html: string) => Document }} [deps]
 */
export function parseListing(html, baseUrl, deps = {}) {
  const parse = deps.parse
    || ((text) => new DOMParser().parseFromString(text, 'text/html'));
  let doc;
  try {
    doc = parse(String(html || ''));
  } catch {
    return { entries: [], folders: [] };
  }
  const seen = new Set();
  const entries = [];
  const folders = [];
  const base = safeUrl(baseUrl);
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    const resolved = safeUrl(href, baseUrl);
    if (!resolved) continue;
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);

    if (resolved.pathname.endsWith('/')) {
      // Every directory index links to its own parent; following that link
      // back up is fine, but listing it as a subfolder is not.
      if (base && !isDescendantPath(base.pathname, resolved.pathname)) continue;
      folders.push({ name: folderLabel(resolved), url: resolved.href });
      continue;
    }
    // Either the path OR the visible label may carry the extension. A
    // file-manager share commonly renders a track as
    // `<a href="download?id=1">Pretty Song.flac</a>`, and gating on the
    // pathname alone dropped that row before the label was ever read --
    // while parseJsonListing already admitted the same shape on its name.
    const label = (anchor.textContent || '').trim();
    const labelIsAudio = isAudioName(label);
    if (!isAudioName(resolved.pathname) && !labelIsAudio) continue;
    // The link text is usually the filename and is the friendlier label,
    // but an index that labels links "download" is better off with the path.
    entries.push({
      name: labelIsAudio ? label : audioNameFromUrl(resolved.href),
      url: resolved.href,
    });
  }
  return { entries, folders };
}

/** `new URL` without the try/catch at every call site. */
function safeUrl(raw, base = undefined) {
  try {
    return base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
}

function isDescendantPath(basePath, candidatePath) {
  const parent = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return candidatePath.length > parent.length && candidatePath.startsWith(parent);
}

function folderLabel(url) {
  const segment = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(segment) || '/';
  } catch {
    return segment || '/';
  }
}

/** The JSON shape `tools/music-server.mjs` serves --
 *  `{ folders: [...], files: [{name, url}] }` -- and the looser shapes
 *  other local servers emit: a bare array, or one of strings. Accepting all
 *  of them means a player can point this at whatever they already run. */
export function parseJsonListing(json, baseUrl) {
  const fileRows = Array.isArray(json) ? json : (Array.isArray(json?.files) ? json.files : []);
  const folderRows = Array.isArray(json?.folders) ? json.folders : [];
  const entries = [];
  const folders = [];

  for (const row of fileRows) {
    const rawName = typeof row === 'string' ? row : (row?.name || row?.url || '');
    const rawUrl = typeof row === 'string' ? row : (row?.url || row?.name || '');
    if (!rawName || !rawUrl) continue;
    const resolved = safeUrl(rawUrl, baseUrl);
    if (!resolved) continue;
    if (!isAudioName(resolved.pathname) && !isAudioName(rawName)) continue;
    // An explicit name wins over one derived from the URL. A row is
    // admitted on the strength of its name when the URL has no extension
    // (`download?id=1`), so discarding that name right afterwards would
    // label the track "download" everywhere it appears.
    const explicit = typeof row === 'object' && row?.name ? String(row.name) : '';
    entries.push({ name: explicit || audioNameFromUrl(resolved.href), url: resolved.href });
  }

  for (const row of folderRows) {
    const rawUrl = typeof row === 'string' ? row : (row?.url || row?.name || '');
    if (!rawUrl) continue;
    const resolved = safeUrl(rawUrl, baseUrl);
    if (!resolved) continue;
    const name = typeof row === 'object' && row?.name ? String(row.name) : folderLabel(resolved);
    folders.push({ name, url: resolved.href });
  }

  return { entries, folders };
}

/**
 * Downloads one URL and wraps it as a File the drop pipeline accepts.
 *
 * The size limit is checked against `Content-Length` *before* the body is
 * read, so a mistyped URL pointing at a disk image is refused instead of
 * being pulled down in full first; the received bytes are re-checked
 * afterwards because Content-Length is a claim, not a guarantee.
 */
export async function fetchAudioAsFile(url, {
  signal = null,
  limits = AUDIO_LOAD_LIMITS,
  // The listing may know a better filename than the URL does -- a row like
  // `{ name: "Pretty Song.flac", url: "download?id=1" }` would otherwise
  // become "download", and that name is what the HUD shows and what
  // identity resolution and caching key on.
  name: declaredName = '',
  // Injectable so tests can exercise the timeout without waiting for it.
  stallMs = DOWNLOAD_TIMEOUT_MS,
  onProgress,
  fetchImpl = fetch,
  credentials,
  requireAudioContentType = false,
  redirect = 'follow',
} = {}) {
  const name = String(declaredName || '').trim() || audioNameFromUrl(url);
  const blob = await requestWithTimeout(url, stallMs, signal, async (res, arm, bodySignal) => {
    if (!res.ok) {
      throw new UrlAudioError(`${url} returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`, { status: res.status, code: 'HTTP_ERROR' });
    }
    const contentType = (res.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (requireAudioContentType && (!contentType.startsWith('audio/') || /mpegurl|m3u/.test(contentType))) {
      throw new UrlAudioError('The response is not an original audio file.', { status: 415, code: 'UNSUPPORTED_MEDIA' });
    }
    checkDeclaredLength(res, name, limits);
    return readBody(res, arm, { name, limits, onProgress, signal: bodySignal, type: requireAudioContentType ? contentType : '' });
  }, { fetchImpl, credentials, redirect });
  try {
    validateAudioBytes(blob.size, name, limits);
  } catch (err) {
    throw new UrlAudioError(err.message, { code: 'RESOURCE_LIMIT' });
  }
  if (blob.size === 0) throw new UrlAudioError(`${name} came back empty.`);
  const type = blob.type && blob.type !== 'application/octet-stream'
    ? blob.type
    : (MIME_BY_EXTENSION[extensionOf(name)] || 'audio/mpeg');
  return new File([blob], name, { type });
}

/**
 * The one entry point the UI needs: given what the player typed, either
 * hand back a playable File or a list of what is in that folder.
 *
 * Which one is decided by the response's own Content-Type rather than by
 * guessing from the URL, because a directory index is served both with and
 * without a trailing slash and both with and without a filename.
 *
 * @returns {Promise<{ kind: 'audio', file: File }
 *   | { kind: 'listing', entries: Array<{name:string,url:string}>,
 *       folders: Array<{name:string,url:string}>, url: string }>}
 */
export async function openAudioUrl(raw, {
  pageUrl = undefined,
  signal = null,
  limits = AUDIO_LOAD_LIMITS,
  stallMs = LISTING_TIMEOUT_MS,
  downloadStallMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const verdict = pageUrl === undefined ? classifyUrl(raw) : classifyUrl(raw, pageUrl);
  if (!verdict.ok) throw new UrlAudioError(verdict.message);
  const url = verdict.url;

  // A URL that plainly names an audio file is fetched straight as audio --
  // no HEAD probe, so the common case costs exactly one request.
  if (isAudioName(new URL(url).pathname)) {
    return {
      kind: 'audio',
      file: await fetchAudioAsFile(url, { signal, limits, stallMs: downloadStallMs }),
    };
  }

  return requestWithTimeout(url, stallMs, signal, async (res, arm) => {
    if (!res.ok) {
      throw new UrlAudioError(`${url} returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`, { status: res.status, code: 'HTTP_ERROR' });
    }
    const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
    // Relative links resolve against where the listing ACTUALLY came from.
    // A conventional server redirects a typed `/music` to `/music/`, and
    // resolving `song.mp3` against the pre-redirect URL yields `/song.mp3`
    // instead of `/music/song.mp3`. The reported url is the final one too,
    // so the "Up a folder" button is derived from a real path.
    const base = res.url || url;

    if (contentType.includes('json')) {
      const text = await readListingText(res, arm);
      const { entries, folders } = parseJsonListing(JSON.parse(text), base);
      if (!entries.length && !folders.length) {
        throw new UrlAudioError(`No audio files listed at ${base}.`);
      }
      return { kind: 'listing', entries, folders, url: base };
    }
    if (contentType.includes('html')) {
      const { entries, folders } = parseListing(await readListingText(res, arm), base);
      if (!entries.length && !folders.length) {
        throw new UrlAudioError(
          `No audio links found at ${base}. If that is a folder, make sure the`
          + ' server serves a directory index.',
        );
      }
      return { kind: 'listing', entries, folders, url: base };
    }

    // Not a listing and not an audio-looking path: an extensionless URL from
    // a server that streams audio anyway. Take the bytes it already sent --
    // under the same declared-length refusal and streaming cap as the direct
    // path, so an oversized response is not buffered here either.
    if (contentType.startsWith('audio/') || contentType.includes('octet-stream') || !contentType) {
      const name = audioNameFromUrl(url);
      checkDeclaredLength(res, name, limits);
      const blob = await readBody(res, arm, { name, limits });
      try {
        validateAudioBytes(blob.size, name, limits);
      } catch (err) {
        throw new UrlAudioError(err.message, { code: 'RESOURCE_LIMIT' });
      }
      if (blob.size === 0) throw new UrlAudioError(`${url} came back empty.`);
      const withExtension = isAudioName(name) ? name : `${name}.mp3`;
      return {
        kind: 'audio',
        file: new File([blob], withExtension, { type: blob.type || 'audio/mpeg' }),
      };
    }

    throw new UrlAudioError(`${url} served ${contentType}, which is neither audio nor a folder listing.`);
  });
}
