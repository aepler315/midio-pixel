/**
 * Soulseek / free-music bridge for Midio.
 *
 * Smooth UX defaults:
 *   • Free music (SoundHelix + Internet Archive) always works — no login, no API keys.
 *   • Bundled slskd (docker compose) auto-detected at 127.0.0.1:5030 with an optional operator key.
 *   • Optional Soulseek username/password (direct or via slskd) for the full network.
 *
 * Backends:
 *   1. Runtime UI config (POST /api/soulseek/config)
 *   2. Auto-detected local slskd (docker compose up -d slskd)
 *   3. Env SLSK_USER + SLSK_PASS → direct
 *   4. Env SLSKD_URL + SLSKD_API_KEY → slskd
 *   5. Free catalog (default when nothing else is ready)
 *
 * Result shape: { id, title, artist, album, lengthSec, lengthLabel, filename, size,
 *   bitrate, speed, slots, user, source, ext, versionKey, baseTitle }
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parsePathMetadata,
  formatLength,
  dedupeResults,
  enrichWithMusicBrainz,
  AUDIO_EXT,
  basename as metaBasename,
} from './song-meta.mjs';
import {
  DEMO_CATALOG,
  MAX_DOWNLOAD_BYTES,
  searchFreeMusic,
  downloadFreeTrack,
  searchDemoCatalog,
} from './free-music.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Guard against SSRF: the slskd URL (whether bundled, env-configured, or
 * supplied by the UI via setConfig) must point at a loopback host. Returns
 * the normalized (no trailing slash) URL string, or throws.
 */
export function assertLoopbackSlskdUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch {
    throw new Error(`"${input}" is not valid: not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`slskd URL must use http/https, got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('slskd URL must not contain credentials, query parameters, or fragments');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!isLoopback) {
    throw new Error(`slskd URL host "${hostname}" is not a local/loopback address`);
  }
  return parsed.toString().replace(/\/$/, '');
}

/** Optional operator-supplied key; never ship a shared credential in source. */
export const BUNDLED_SLSKD_KEY = process.env.SLSKD_API_KEY || '';
export const BUNDLED_SLSKD_URL = assertLoopbackSlskdUrl(
  process.env.SLSKD_URL || 'http://127.0.0.1:5030',
);
export const DEFAULT_SLSKD_DOWNLOADS =
  process.env.SLSKD_DOWNLOADS ||
  process.env.SLSKD_DOWNLOAD_DIR ||
  path.join(ROOT, 'data', 'slskd-downloads');

/**
 * Guard against path traversal when resolving a slskd-reported download
 * filename against the local downloads root. Returns the set of candidate
 * absolute paths to check, all guaranteed to stay inside `root`. Traversal
 * segments ('..') and absolute paths are collapsed to just the basename so
 * they can never escape `root`; a genuine relative sub-path (no traversal)
 * also yields a nested candidate.
 */
export function pathsInsideDownloads(root, relPath) {
  const normalized = String(relPath).replace(/\\/g, '/');
  const base = path.basename(normalized);
  const primary = path.join(root, base);
  const isAbsolute = normalized.startsWith('/');
  const segments = normalized.split('/').filter(Boolean);
  const hasTraversal = segments.some((seg) => seg === '..' || seg === '.');

  const candidates = [primary];
  if (!isAbsolute && !hasTraversal && segments.length > 1) {
    const nested = path.join(root, ...segments);
    if (nested !== primary) candidates.push(nested);
  }
  return candidates;
}

const searches = new Map();
const MAX_SEARCHES = 128;
const SEARCH_TTL_MS = 5 * 60 * 1000;

function pruneSearches(now = Date.now()) {
  for (const [id, search] of searches) {
    if (now - search.createdAt > SEARCH_TTL_MS) searches.delete(id);
  }
}

function rememberSearch(id, search) {
  pruneSearches();
  while (searches.size >= MAX_SEARCHES) {
    const oldest = searches.keys().next().value;
    if (oldest === undefined) break;
    searches.delete(oldest);
  }
  searches.set(id, search);
}
let runtimeConfig = null;
let directClient = null;
let directClientPromise = null;
/** Last direct-mode login failure message, cleared on success — lets
 *  getStatus() say "login failed: X" instead of pretending connected. */
let directLoginError = null;
/** @type {null | { ok: boolean, url: string, checkedAt: number, loggedIn?: boolean }} */
let slskdProbe = null;

// ── Config resolution ──────────────────────────────────────────────────────

async function probeSlskd(url = BUNDLED_SLSKD_URL, key = BUNDLED_SLSKD_KEY) {
  const now = Date.now();
  if (slskdProbe && slskdProbe.url === url && now - slskdProbe.checkedAt < 8_000) {
    return slskdProbe;
  }
  try {
    const res = await fetch(`${url}/api/v0/application`, {
      headers: { Accept: 'application/json', 'X-API-Key': key },
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) {
      slskdProbe = { ok: false, url, checkedAt: now };
      return slskdProbe;
    }
    const data = await res.json().catch(() => ({}));
    const loggedIn = !!(
      data?.server?.isConnected ||
      data?.server?.isLoggedIn ||
      data?.state?.isConnected ||
      data?.soulseek?.isConnected
    );
    slskdProbe = { ok: true, url, key, checkedAt: now, loggedIn, raw: data };
    return slskdProbe;
  } catch {
    slskdProbe = { ok: false, url, checkedAt: now };
    return slskdProbe;
  }
}

function activeConfigSync() {
  if (runtimeConfig) return runtimeConfig;
  if (process.env.SLSK_USER && process.env.SLSK_PASS) {
    return {
      mode: 'direct',
      slskUser: process.env.SLSK_USER,
      slskPass: process.env.SLSK_PASS,
    };
  }
  if (process.env.SLSKD_URL && process.env.SLSKD_API_KEY) {
    return {
      mode: 'slskd',
      slskdUrl: assertLoopbackSlskdUrl(process.env.SLSKD_URL),
      slskdKey: process.env.SLSKD_API_KEY,
    };
  }
  // Prefer auto-detected bundled slskd when last probe succeeded
  if (slskdProbe?.ok) {
    return {
      mode: 'slskd',
      slskdUrl: slskdProbe.url,
      slskdKey: BUNDLED_SLSKD_KEY,
      auto: true,
    };
  }
  // Default: free music — works with zero setup
  return { mode: 'free' };
}

function activeConfig() {
  return activeConfigSync();
}

export async function setConfig(cfg) {
  const resetDirect = () => {
    directClient = null;
    directClientPromise = null;
    directLoginError = null;
  };
  if (!cfg || typeof cfg !== 'object') {
    runtimeConfig = null;
    resetDirect();
    return activeConfigSync();
  }
  const mode = String(cfg.mode || '').toLowerCase();
  if (mode === 'off' || mode === 'clear' || mode === 'auto') {
    runtimeConfig = null;
    resetDirect();
    return activeConfigSync();
  }
  if (mode === 'demo' || mode === 'free') {
    runtimeConfig = { mode: 'free' };
    resetDirect();
    return { mode: 'free', connected: true };
  }
  if (mode === 'slskd') {
    const rawUrl = String(cfg.slskdUrl || cfg.url || BUNDLED_SLSKD_URL).trim();
    if (!rawUrl) throw new Error('slskd mode needs a URL');
    const url = assertLoopbackSlskdUrl(rawUrl);
    // API key is optional for a loopback-only slskd configured without auth.
    const key = String(cfg.slskdKey || cfg.apiKey || BUNDLED_SLSKD_KEY).trim();
    runtimeConfig = { mode: 'slskd', slskdUrl: url, slskdKey: key };
    resetDirect();
    slskdProbe = null;
    return { mode: 'slskd', slskdUrl: url, connected: true };
  }
  if (mode === 'direct') {
    const user = String(cfg.slskUser || cfg.user || '').trim();
    const pass = String(cfg.slskPass || cfg.pass || cfg.password || '').trim();
    if (!user || !pass) throw new Error('Soulseek login needs username and password');
    runtimeConfig = { mode: 'direct', slskUser: user, slskPass: pass };
    resetDirect();
    // Actually attempt the login now, so the response tells the truth:
    // connected:true only once server.slsknet.org accepted the credentials.
    // Previously this returned connected:true unconditionally, so the UI
    // said "Connected" right up until the first search failed.
    try {
      await getDirectClient(runtimeConfig);
      return { mode: 'direct', user, connected: true, note: `Soulseek login as ${user}` };
    } catch (err) {
      return {
        mode: 'direct',
        user,
        connected: false,
        note: err.message || String(err),
      };
    }
  }
  throw new Error(`Unknown Soulseek mode: ${mode}`);
}

export async function getStatus() {
  // Always probe bundled slskd so we can upgrade free → slskd silently
  const probe = await probeSlskd();
  const cfg = activeConfigSync();
  const mode = cfg.mode;
  const connected =
    mode === 'free' ||
    mode === 'demo' ||
    (mode === 'slskd' && !!cfg.slskdUrl) ||
    (mode === 'direct' && !!directClient);
  const needsLogin = false; // free mode always works; Soulseek is optional upgrade
  const slskdReady = !!probe.ok;
  const slskdLoggedIn = !!probe.loggedIn;

  let note;
  if (mode === 'slskd' && cfg.auto) {
    note = slskdLoggedIn
      ? 'Connected via local slskd — searching the Soulseek network.'
      : 'Local slskd is up. Add your Soulseek account in Connect (or set SLSK_USER/SLSK_PASS) to search the network. Free music works now.';
  } else if (mode === 'slskd') {
    note = `Proxying through slskd at ${cfg.slskdUrl}`;
  } else if (mode === 'direct') {
    note = directClient
      ? `Soulseek login as ${cfg.slskUser}`
      : directLoginError
        ? directLoginError
        : `Soulseek account ${cfg.slskUser} — connecting`;
  } else {
    note = slskdReady
      ? 'Free music ready. Local slskd detected — optional: add Soulseek login for the full network.'
      : 'Free music ready (no account needed). Optional: docker compose up -d slskd + Soulseek login for the network.';
  }

  return {
    mode,
    defaultMode: 'free',
    connected,
    needsLogin,
    slskdReady,
    slskdLoggedIn,
    slskdUrl: mode === 'slskd' ? cfg.slskdUrl : slskdReady ? BUNDLED_SLSKD_URL : null,
    user: mode === 'direct' ? cfg.slskUser || null : null,
    demoTracks: DEMO_CATALOG.length,
    freeSearch: true,
    note,
  };
}

function basename(p) {
  return metaBasename(p);
}

function formatBytes(n) {
  if (!n || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a local Soulseek result without a stat/read TOCTOU allocation gap. */
export function readBoundedFile(filePath, label = 'Soulseek download') {
  const fd = fs.openSync(filePath, 'r');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_DOWNLOAD_BYTES - total + 1));
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error(`${label} exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
      }
      chunks.push(chunk.subarray(0, bytes));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeFile(raw, source) {
  const filename = raw.filename || raw.file || raw.name || 'unknown';
  const size = Number(raw.size || 0);
  const bitrate = Number(raw.bitRate || raw.bitrate || 0) || null;
  const meta = parsePathMetadata(filename, {
    size,
    bitrate,
    bitRate: bitrate,
    length: raw.length || raw.duration || raw.lengthSeconds,
    artist: raw.artist,
    album: raw.album,
    title: raw.title,
  });
  return {
    id: raw.id || `${source}:${raw.user || raw.username || 'x'}:${filename}`,
    title: meta.title,
    baseTitle: meta.baseTitle,
    versionKey: meta.versionKey,
    versionLabel: meta.versionLabel,
    artist: meta.artist,
    album: meta.album,
    lengthSec: meta.lengthSec,
    lengthLabel: formatLength(meta.lengthSec),
    filename,
    size,
    sizeLabel: formatBytes(size),
    bitrate,
    speed: Number(raw.speed || raw.uploadSpeed || 0) || null,
    slots: raw.slots !== false && raw.hasFreeUploadSlot !== false,
    user: raw.user || raw.username || 'unknown',
    source,
    ext: meta.ext,
    _file: filename,
    _code: raw.code,
  };
}

function finalizeResults(files) {
  return dedupeResults(files).slice(0, 60);
}

function demoSearch(query) {
  return searchDemoCatalog(query);
}


// ── slskd proxy ────────────────────────────────────────────────────────────
async function slskdFetch(cfg, apiPath, opts = {}) {
  const url = `${cfg.slskdUrl}/api/v0${apiPath}`;
  const headers = {
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  if (cfg.slskdKey) headers['X-API-Key'] = cfg.slskdKey;
  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`slskd ${opts.method || 'GET'} ${apiPath} → ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.arrayBuffer();
}

async function startSlskdSearch(cfg, query) {
  const id = randomUUID();
  const body = {
    id,
    searchText: query,
    fileLimit: 400,
    filterResponses: true,
    minimumPeerUploadSpeed: 0,
    minimumResponseFileCount: 1,
    responseLimit: 80,
    searchTimeout: 12_000,
  };
  await slskdFetch(cfg, '/searches', { method: 'POST', body });
  rememberSearch(id, {
    mode: 'slskd',
    query,
    status: 'inProgress',
    results: [],
    createdAt: Date.now(),
  });
  pollSlskdSearch(cfg, id).catch((err) => {
    const s = searches.get(id);
    if (s) {
      s.status = 'error';
      s.error = err.message;
    }
  });
  return id;
}

async function pollSlskdSearch(cfg, id) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(900);
    let responses;
    try {
      responses = await slskdFetch(cfg, `/searches/${id}/responses`);
    } catch {
      const state = await slskdFetch(cfg, `/searches/${id}`).catch(() => null);
      if (state?.isComplete) break;
      continue;
    }
    const files = [];
    for (const resp of responses || []) {
      const user = resp.username || resp.user;
      const speed = resp.uploadSpeed || resp.speed || 0;
      const freeSlot = resp.hasFreeUploadSlot ?? resp.freeUploadSlots > 0;
      for (const f of resp.files || []) {
        const name = f.filename || f.file || '';
        if (!AUDIO_EXT.test(name)) continue;
        // slskd attributes: bitRate, length, etc. may be on f.attributes array
        let length = f.length || f.duration;
        let bitrate = f.bitRate || f.bitrate;
        if (Array.isArray(f.attributes)) {
          for (const a of f.attributes) {
            if (/bit ?rate/i.test(a.key || a.name || '')) bitrate = bitrate || Number(a.value);
            if (/length|duration/i.test(a.key || a.name || '')) length = length || Number(a.value);
          }
        }
        files.push(
          normalizeFile(
            {
              ...f,
              filename: name,
              user,
              speed,
              slots: freeSlot,
              bitrate,
              length,
            },
            'slskd',
          ),
        );
      }
    }
    const s = searches.get(id);
    if (!s) return;
    s.results = finalizeResults(files);
    // Fire-and-forget enrichment (album/length gaps)
    enrichWithMusicBrainz(s.results, { limit: 10 }).catch(() => {});
    const state = await slskdFetch(cfg, `/searches/${id}`).catch(() => null);
    if (state?.isComplete || state?.state === 'Completed') {
      s.status = 'completed';
      await enrichWithMusicBrainz(s.results, { limit: 12 }).catch(() => {});
      return;
    }
  }
  const s = searches.get(id);
  if (s && s.status === 'inProgress') {
    s.status = 'completed';
    await enrichWithMusicBrainz(s.results, { limit: 12 }).catch(() => {});
  }
}

async function downloadViaSlskd(cfg, item) {
  const username = item.user;
  const filePayload = [
    {
      filename: item._file || item.filename,
      size: item.size || 0,
    },
  ];
  await slskdFetch(cfg, `/transfers/downloads/${encodeURIComponent(username)}`, {
    method: 'POST',
    body: filePayload,
  });

  const deadline = Date.now() + 120_000;
  const target = basename(item._file || item.filename).toLowerCase();
  while (Date.now() < deadline) {
    await sleep(1500);
    const downloads = await slskdFetch(
      cfg,
      `/transfers/downloads/${encodeURIComponent(username)}`,
    ).catch(() => null);
    const dirs = Array.isArray(downloads) ? downloads : downloads ? [downloads] : [];
    for (const dir of dirs) {
      for (const f of dir.files || []) {
        const name = basename(f.filename || '').toLowerCase();
        if (name !== target && !(f.filename || '').toLowerCase().endsWith(target)) continue;
        const state = String(f.state || f.transferState || '').toLowerCase();
        if (state.includes('complete') && !state.includes('incomplete')) {
          const localPath = f.filename || item.filename;
          const dlRoot =
            process.env.SLSKD_DOWNLOADS ||
            process.env.SLSKD_DOWNLOAD_DIR ||
            DEFAULT_SLSKD_DOWNLOADS;
          if (dlRoot) {
            const tryPaths = pathsInsideDownloads(dlRoot, localPath);
            for (const p of tryPaths) {
              if (fs.existsSync(p)) {
                const stat = fs.statSync(p);
                if (!stat.isFile() || stat.size > MAX_DOWNLOAD_BYTES) {
                  throw new Error(`slskd download exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
                }
                return {
                  buffer: readBoundedFile(p, 'slskd download'),
                  filename: basename(localPath),
                  contentType: mimeFor(basename(localPath)),
                };
              }
            }
          }
          throw new Error(
            `Download completed in slskd for "${basename(localPath)}" but file bytes are not reachable from Midio. ` +
              `Set SLSKD_DOWNLOADS to your slskd downloads folder, or drop the file manually.`,
          );
        }
        if (state.includes('fail') || state.includes('error') || state.includes('cancel')) {
          throw new Error(`slskd transfer failed: ${state}`);
        }
      }
    }
  }
  throw new Error('Timed out waiting for slskd download');
}

// ── Direct Soulseek (slsk-client) ──────────────────────────────────────────
async function getDirectClient(cfg) {
  if (directClient) return directClient;
  if (directClientPromise) return directClientPromise;
  if (!cfg.slskUser || !cfg.slskPass) {
    throw new Error('Sign in with your Soulseek username and password first.');
  }
  // slsk-client unconditionally mkdirs '/tmp/slsk' (non-recursively), which
  // resolves to C:\tmp\slsk on Windows and ENOENTs when C:\tmp doesn't exist.
  // Pre-create it so connect() can't crash on a stock machine.
  try {
    fs.mkdirSync(path.resolve('/tmp/slsk'), { recursive: true });
  } catch {
    /* best effort — POSIX always has /tmp */
  }
  const attempt = new Promise((resolve, reject) => {
    let slsk;
    try {
      slsk = require('slsk-client');
    } catch {
      reject(new Error('slsk-client is not installed. Run: npm install slsk-client'));
      return;
    }
    slsk.connect(
      {
        user: cfg.slskUser,
        pass: cfg.slskPass,
        // slsk-client's login watchdog defaults to a brutal 2000ms — a slow
        // handshake to server.slsknet.org fails with "timeout login" even
        // with valid credentials. Allow a realistic round-trip.
        timeout: 15_000,
        ...(process.env.SLSK_HOST ? { host: process.env.SLSK_HOST } : {}),
        ...(process.env.SLSK_PORT ? { port: Number(process.env.SLSK_PORT) } : {}),
      },
      (err, client) => {
        if (err) {
          reject(new Error(`Soulseek login failed: ${err.message || err}`));
          return;
        }
        directClient = client;
        resolve(client);
      },
    );
  });
  directClientPromise = attempt;
  attempt
    .then(() => {
      directLoginError = null;
    })
    .catch((err) => {
      directLoginError = err.message || String(err);
      // Clear the cache on failure so the NEXT search retries instead of
      // replaying this rejection forever (the old code kept a rejected
      // promise cached until process restart — one "not installed" error
      // poisoned every search after it).
      if (directClientPromise === attempt) directClientPromise = null;
    });
  return attempt;
}

async function startDirectSearch(cfg, query) {
  if (cfg.needsLogin || !cfg.slskUser) {
    throw new Error('Sign in with your Soulseek account (Connect → Soulseek login).');
  }
  const id = randomUUID();
  rememberSearch(id, {
    mode: 'direct',
    query,
    status: 'inProgress',
    results: [],
    createdAt: Date.now(),
  });
  (async () => {
    try {
      const client = await getDirectClient(cfg);
      const res = await new Promise((resolve, reject) => {
        client.search({ req: query, timeout: 10000 }, (err, data) => {
          if (err) reject(err);
          else resolve(data || []);
        });
      });
      const files = (res || [])
        .filter((r) => AUDIO_EXT.test(r.file || r.filename || ''))
        .map((r) =>
          normalizeFile(
            {
              filename: r.file,
              size: r.size,
              bitrate: r.bitrate,
              speed: r.speed,
              slots: r.slots,
              user: r.user,
              length: r.length,
            },
            'direct',
          ),
        );
      const s = searches.get(id);
      if (s) {
        s.results = finalizeResults(files);
        s.status = 'completed';
        s._rawList = res.filter((r) => AUDIO_EXT.test(r.file || ''));
        await enrichWithMusicBrainz(s.results, { limit: 12 }).catch(() => {});
      }
    } catch (err) {
      const s = searches.get(id);
      if (s) {
        s.status = 'error';
        s.error = err.message || String(err);
      }
    }
  })();
  return id;
}

async function downloadViaDirect(cfg, item) {
  const client = await getDirectClient(cfg);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midio-slsk-'));
  const outPath = path.join(tmpDir, basename(item.filename).replace(/[^\w.\- ()[\]]+/g, '_'));
  const fileObj = {
    user: item.user,
    file: item._file || item.filename,
    size: item.size,
    slots: item.slots !== false,
    bitrate: item.bitrate || 0,
    speed: item.speed || 0,
  };
  try {
    await new Promise((resolve, reject) => {
      client.download({ file: fileObj, path: outPath }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    const stat = fs.statSync(outPath);
    if (!stat.isFile() || stat.size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Soulseek download exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
    }
    const buffer = readBoundedFile(outPath);
    return {
      buffer,
      filename: basename(item.filename),
      contentType: mimeFor(basename(item.filename)),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


function mimeFor(name) {
  const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  return (
    {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      opus: 'audio/opus',
      mid: 'audio/midi',
      midi: 'audio/midi',
    }[ext] || 'application/octet-stream'
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


// ── Public API ─────────────────────────────────────────────────────────────
export async function startSearch(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Empty search query');
  if (q.length > 200) throw new Error('Query too long');

  await probeSlskd();
  const cfg = activeConfigSync();

  // Prefer live Soulseek when the user (or auto-detected slskd) is ready
  if (cfg.mode === 'slskd' && cfg.slskdUrl) {
    const probe = slskdProbe;
    const canSearchNetwork = !cfg.auto || probe?.loggedIn !== false;
    if (canSearchNetwork) {
      try {
        const id = await startSlskdSearch(cfg, q);
        return { id, mode: 'slskd' };
      } catch {
        // fall through to free music
      }
    }
  } else if (cfg.mode === 'direct' && cfg.slskUser) {
    try {
      const id = await startDirectSearch(cfg, q);
      return { id, mode: 'direct' };
    } catch {
      // fall through to free music
    }
  }

  // Free music — always available, no keys / no sign-in
  const id = randomUUID();
  rememberSearch(id, {
    mode: 'free',
    query: q,
    status: 'inProgress',
    results: [],
    createdAt: Date.now(),
  });
  (async () => {
    try {
      const results = await searchFreeMusic(q);
      const s = searches.get(id);
      if (s) {
        s.results = results;
        s.status = 'completed';
      }
    } catch (err) {
      const s = searches.get(id);
      if (s) {
        s.status = 'error';
        s.error = err.message || String(err);
      }
    }
  })();
  return { id, mode: 'free' };
}

export function getSearch(id) {
  pruneSearches();
  const s = searches.get(id);
  if (!s) return null;
  return {
    id,
    query: s.query,
    status: s.status,
    mode: s.mode,
    error: s.error || null,
    results: s.results || [],
    resultCount: (s.results || []).length,
  };
}

export async function downloadResult(item) {
  if (!item || typeof item !== 'object') throw new Error('Missing download item');
  const advertisedSize = Number(item.size);
  if (Number.isFinite(advertisedSize) && advertisedSize > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Requested download exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
  }
  const cfg = activeConfigSync();
  const source = item.source || cfg.mode;

  if (source === 'slskd') {
    const slskdCfg =
      cfg.mode === 'slskd'
        ? cfg
        : { slskdUrl: BUNDLED_SLSKD_URL, slskdKey: BUNDLED_SLSKD_KEY };
    return downloadViaSlskd(slskdCfg, item);
  }
  if (source === 'direct') {
    return downloadViaDirect(cfg.mode === 'direct' ? cfg : activeConfigSync(), item);
  }
  // free | demo | archive | anything else
  return downloadFreeTrack(item, DEMO_CATALOG);
}

export function listDemoCatalog() {
  return demoSearch('');
}

export { probeSlskd, BUNDLED_SLSKD_URL as defaultSlskdUrl };
