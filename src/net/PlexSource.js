import { AUDIO_LOAD_LIMITS, throwIfAborted } from '../audio/loadLimits.js';
import { normalizeSourceMetadata } from '../audio/SourceMetadata.js';
import { fetchAudioAsFile, isLoopbackHost, UrlAudioError } from './UrlAudioSource.js';

const PREFIX = '/api/plex/v1';
const ID = /^\d+$/;
const OPAQUE = /^[a-zA-Z0-9._:-]{1,256}$/;
const CONTAINER = /^[a-z0-9]{1,12}$/;
const ERROR_MESSAGES = {
  INVALID_CONFIG: 'Plex library configuration is invalid.',
  INVALID_INPUT: 'The Plex library request is invalid.',
  INVALID_RESPONSE: 'Plex library returned an invalid response.',
  LIBRARY_UNAVAILABLE: 'Plex library unavailable. Try again later.',
  MEDIA_UNAVAILABLE: 'This recording is unavailable. Select another track.',
  NOT_FOUND: 'This library item is unavailable.',
  RESOURCE_LIMIT: 'This recording exceeds the audio loading limits.',
  UNSUPPORTED_MEDIA: 'This recording is not a supported original audio file.',
  CAPACITY: 'Plex library is busy. Try again shortly.',
  REVISION_CHANGED: 'This recording changed. Select it again to load the current version.',
  TIMEOUT: 'Plex library stopped responding. Try again.',
};

export class PlexSourceError extends Error {
  constructor(code, { status, retryable = false } = {}) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.LIBRARY_UNAVAILABLE);
    this.name = 'PlexSourceError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
    this.retryable = retryable;
  }
}

function invalidResponse() { return new PlexSourceError('INVALID_RESPONSE', { status: 502 }); }
function requireId(value) {
  if (typeof value !== 'string' || !ID.test(value) || value.length > 32) throw new PlexSourceError('INVALID_INPUT');
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new PlexSourceError('INVALID_INPUT');
  return value;
}
function label(value) { return typeof value === 'string' ? value.trim().slice(0, 512) || null : null; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function optionalInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function statusCode(status) {
  return ({ 400: 'INVALID_INPUT', 404: 'NOT_FOUND', 409: 'REVISION_CHANGED', 413: 'RESOURCE_LIMIT', 415: 'UNSUPPORTED_MEDIA', 429: 'CAPACITY', 502: 'INVALID_RESPONSE', 504: 'TIMEOUT' })[status] || 'LIBRARY_UNAVAILABLE';
}
function httpError(status, payload) {
  const code = payload?.error?.code;
  return new PlexSourceError(Object.hasOwn(ERROR_MESSAGES, code) ? code : statusCode(status), {
    status, retryable: payload?.error?.retryable === true || [409, 429, 503, 504].includes(status),
  });
}

function validateApiBase(raw) {
  if (typeof raw !== 'string' || raw.trim() !== raw || !raw) throw new PlexSourceError('INVALID_CONFIG');
  try {
    const url = new URL(raw);
    // Inspect the raw pathname as well: URL canonicalization erases dot segments.
    const rawPath = /^[a-z]+:\/\/[^/?#]+([^?#]*)/i.exec(raw)?.[1];
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname)))
      || url.username || url.password || url.search || url.hash
      || ![PREFIX, PREFIX + '/'].includes(rawPath)
      || ![PREFIX, PREFIX + '/'].includes(url.pathname)) throw new Error();
    return url.origin + PREFIX;
  } catch { throw new PlexSourceError('INVALID_CONFIG'); }
}

/** Anonymous client for the dedicated public adapter; never accepts PMS keys or URLs. */
export class PlexSource {
  constructor({ apiBase, fetchImpl = globalThis.fetch, limits = AUDIO_LOAD_LIMITS,
    metadataMaxBytes = 1024 * 1024, stallMs = 15000, downloadStallMs = 45000 } = {}) {
    this.apiBase = validateApiBase(apiBase);
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(metadataMaxBytes) || metadataMaxBytes < 1
      || !Number.isFinite(stallMs) || stallMs <= 0 || !Number.isFinite(downloadStallMs) || downloadStallMs <= 0) {
      throw new PlexSourceError('INVALID_CONFIG');
    }
    this.fetchImpl = fetchImpl;
    this.limits = { ...AUDIO_LOAD_LIMITS, ...limits };
    this.metadataMaxBytes = metadataMaxBytes;
    this.stallMs = stallMs;
    this.downloadStallMs = downloadStallMs;
  }

  artworkUrl(path) {
    if (typeof path !== 'string' || !/^\/api\/plex\/v1\/artwork\/\d{1,32}$/.test(path)) return null;
    return new URL(path, this.apiBase).href;
  }

  async _json(path, signal) {
    throwIfAborted(signal);
    const controller = new AbortController();
    let timer;
    let reader;
    let response;
    let completed = false;
    let rejectAbort;
    const abortPromise = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      reader?.cancel().catch(() => {});
      rejectAbort(new DOMException('Plex request cancelled', 'AbortError'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const outerAbort = () => controller.abort();
    signal?.addEventListener('abort', outerAbort, { once: true });
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), this.stallMs); };
    arm();
    try {
      // Native Window.fetch rejects a PlexSource receiver (Illegal invocation).
      const fetchImpl = this.fetchImpl;
      response = await Promise.race([fetchImpl(this.apiBase + path, {
        signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' },
      }), abortPromise]);
      arm();
      const declared = Number(response.headers?.get('content-length'));
      if (Number.isFinite(declared) && declared > this.metadataMaxBytes) throw invalidResponse();
      if (response.ok && !(response.headers?.get('content-type') || '').toLowerCase().includes('application/json')) throw invalidResponse();
      let text = '';
      let size = 0;
      const decoder = new TextDecoder();
      if (response.body?.getReader) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), abortPromise]);
          if (done) break;
          size += value.byteLength;
          if (size > this.metadataMaxBytes) throw invalidResponse();
          arm();
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await Promise.race([response.text(), abortPromise]);
        if (new TextEncoder().encode(text).byteLength > this.metadataMaxBytes) throw invalidResponse();
      }
      throwIfAborted(signal);
      if (controller.signal.aborted) throw new PlexSourceError('TIMEOUT', { status: 504, retryable: true });
      let payload;
      try { payload = text ? JSON.parse(text) : null; }
      catch { if (!response.ok) throw httpError(response.status); throw invalidResponse(); }
      if (!response.ok) throw httpError(response.status, payload);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidResponse();
      completed = true;
      return payload;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof PlexSourceError) throw error;
      if (controller.signal.aborted) throw new PlexSourceError('TIMEOUT', { status: 504, retryable: true });
      throw new PlexSourceError('LIBRARY_UNAVAILABLE', { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', outerAbort);
      controller.signal.removeEventListener('abort', onAbort);
      if (!completed) controller.abort();
      if (reader) {
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* response may already be closed */ }
        reader.releaseLock();
      } else if (!completed) {
        // Invalid headers may reject before a body reader is acquired.
        try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* already torn down */ }
      }
    }
  }

  _item(value, kind) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !OPAQUE.test(value.id)
      || typeof value.ratingKey !== 'string' || !ID.test(value.ratingKey) || value.ratingKey.length > 32
      || typeof value.libraryId !== 'string' || !ID.test(value.libraryId)) throw invalidResponse();
    const item = {
      id: value.id, ratingKey: value.ratingKey, libraryId: value.libraryId,
      title: label(value.title), artist: label(value.artist), album: label(value.album), albumArtist: label(value.albumArtist),
      artworkPath: this.artworkUrl(value.artworkPath) ? value.artworkPath : null,
    };
    if (kind === 'track' || value.revision !== undefined) {
      if (typeof value.loadability?.allowed !== 'boolean'
        || !((typeof value.revision === 'string' && OPAQUE.test(value.revision))
          || (value.loadability.allowed === false && value.revision === null))) throw invalidResponse();
      const container = typeof value.container === 'string' && CONTAINER.test(value.container) ? value.container : null;
      const extension = container;
      const fileName = typeof value.fileName === 'string' && value.fileName.length <= 255
        && !/[\\/]/.test(value.fileName) && ![...value.fileName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        && extension && value.fileName.toLowerCase().endsWith('.' + extension) ? value.fileName : `track-${value.ratingKey}.${extension || 'audio'}`;
      Object.assign(item, {
        durationMs: number(value.durationMs), discNumber: optionalInteger(value.discNumber), trackNumber: optionalInteger(value.trackNumber),
        revision: value.revision, fileName, container, audioCodec: label(value.audioCodec), sizeBytes: optionalInteger(value.sizeBytes),
        loadability: { allowed: value.loadability.allowed, ...(value.loadability.allowed ? {} : { reason: label(value.loadability.reason) || 'Unsupported media shape' }) },
      });
    }
    return item;
  }

  async status({ signal } = {}) {
    const value = await this._json('/status', signal);
    if (typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean') throw invalidResponse();
    const capabilities = {};
    const limits = {};
    for (const key of ['browse', 'search', 'originalAudio', 'artwork']) if (typeof value.capabilities?.[key] === 'boolean') capabilities[key] = value.capabilities[key];
    for (const key of Object.keys(AUDIO_LOAD_LIMITS)) if (number(value.limits?.[key]) !== null) limits[key] = value.limits[key];
    return { enabled: value.enabled, available: value.available, access: 'public-read-only', capabilities, limits };
  }

  async listLibraries({ signal } = {}) {
    const value = await this._json('/libraries', signal);
    if (!Array.isArray(value.items)) throw invalidResponse();
    return { items: value.items.map((item) => {
      if (!item || typeof item.id !== 'string' || !ID.test(item.id)) throw invalidResponse();
      return { id: item.id, title: label(item.title) };
    }) };
  }

  async listItems({ libraryId, kind, parentId = null, offset = 0, limit = 50, signal } = {}) {
    requireId(libraryId);
    if (!['artist', 'album', 'track'].includes(kind)) throw new PlexSourceError('INVALID_INPUT');
    integer(offset, 0, Number.MAX_SAFE_INTEGER);
    integer(limit, 1, 100);
    const params = new URLSearchParams({ libraryId, kind, offset: String(offset), limit: String(limit) });
    if (parentId !== null) params.set('parentId', requireId(parentId));
    const value = await this._json('/items?' + params, signal);
    if (!Array.isArray(value.items) || !Number.isSafeInteger(value.offset) || value.offset < 0
      || (value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset <= value.offset))
      || (value.total !== null && (!Number.isSafeInteger(value.total) || value.total < 0))) throw invalidResponse();
    return { items: value.items.map((item) => this._item(item, kind)), offset: value.offset, nextOffset: value.nextOffset, total: value.total };
  }

  async search({ libraryId, query, limit = 20, signal } = {}) {
    requireId(libraryId);
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length < 2 || q.length > 200) throw new PlexSourceError('INVALID_INPUT');
    integer(limit, 1, 50);
    const value = await this._json('/search?' + new URLSearchParams({ libraryId, q, limit: String(limit) }), signal);
    if (!['artists', 'albums', 'tracks'].every((key) => Array.isArray(value[key])) || typeof value.truncated !== 'boolean') throw invalidResponse();
    return { artists: value.artists.map((item) => this._item(item, 'artist')), albums: value.albums.map((item) => this._item(item, 'album')), tracks: value.tracks.map((item) => this._item(item, 'track')), truncated: value.truncated };
  }

  async getTrack(ratingKey, { signal } = {}) {
    requireId(ratingKey);
    const value = this._item(await this._json('/tracks/' + ratingKey, signal), 'track');
    if (value.ratingKey !== ratingKey) throw invalidResponse();
    return value;
  }

  async loadTrack(ratingKey, { signal, onProgress } = {}) {
    requireId(ratingKey);
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      const track = await this.getTrack(ratingKey, { signal });
      if ((track.sizeBytes !== null && track.sizeBytes > this.limits.maxFileBytes)
        || (track.durationMs !== null && track.durationMs > this.limits.maxDurationSeconds * 1000)) {
        throw new PlexSourceError('RESOURCE_LIMIT', { status: 413 });
      }
      if (!track.loadability.allowed || !track.container) throw new PlexSourceError('UNSUPPORTED_MEDIA', { status: 415 });
      throwIfAborted(signal);
      try {
        const file = await fetchAudioAsFile(this.apiBase + '/tracks/' + ratingKey + '/audio?' + new URLSearchParams({ revision: track.revision }), {
          signal, name: track.fileName, limits: this.limits, fetchImpl: this.fetchImpl,
          credentials: 'omit', redirect: 'error', requireAudioContentType: true, onProgress, stallMs: this.downloadStallMs,
        });
        throwIfAborted(signal);
        return { file, sourceMetadata: normalizeSourceMetadata({ ...track, provider: 'plex', artworkUrl: this.artworkUrl(track.artworkPath) }) };
      } catch (error) {
        throwIfAborted(signal);
        if (error?.name === 'AbortError') throw error;
        if (error instanceof UrlAudioError && error.status === 409 && attempt === 0) continue;
        if (error instanceof UrlAudioError) {
          if (error.code === 'RESOURCE_LIMIT') throw new PlexSourceError('RESOURCE_LIMIT', { status: 413 });
          if (error.code === 'TIMEOUT') throw new PlexSourceError('TIMEOUT', { status: 504, retryable: true });
          if (error.status) throw httpError(error.status);
        }
        throw new PlexSourceError('LIBRARY_UNAVAILABLE', { retryable: true });
      }
    }
  }
}
