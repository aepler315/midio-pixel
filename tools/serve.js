// Zero-dependency static file server + Soulseek bridge for local dev/testing.
// Usage: node tools/serve.js [port]
// Binds loopback by default. Set HOST=0.0.0.0 only for an intentional LAN preview.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getStatus,
  setConfig,
  startSearch,
  getSearch,
  downloadResult,
  listDemoCatalog,
} from './soulseek-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.SITE_ROOT || path.join(__dirname, '..'));
const PORT = Number(process.env.PORT || process.argv[2]) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const BRIDGE_TOKEN = process.env.MIDIO_BRIDGE_TOKEN?.trim() || '';
const MAX_JSON_BODY_BYTES = 1e6;

function isLoopbackAddress(address) {
  const normalized = String(address || '').replace(/^::ffff:/i, '');
  return normalized === '::1' || normalized === '127.0.0.1' || /^127\./.test(normalized);
}

function isLoopbackHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || isLoopbackAddress(normalized);
}

function validLoopbackRequestHost(host) {
  try {
    const url = new URL(`http://${String(host || '').trim()}`);
    return !url.username && !url.password && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function sameSecret(actual, expected) {
  const actualBytes = Buffer.from(String(actual || ''));
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sameOriginRequest(req) {
  const host = String(req.headers.host || '').trim();
  if (!validLoopbackRequestHost(host)) return false;
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  try {
    return new URL(origin).origin === `http://${host}`;
  } catch {
    return false;
  }
}

/**
 * The bridge is local-only unless an explicit token is configured. When a
 * token is configured it is required even for loopback, which also protects
 * the legacy endpoints from same-origin callers that do not know the token.
 */
function bridgeRequestAuthorized(req) {
  // Loopback is not a browser-origin boundary: an arbitrary website can send
  // requests to 127.0.0.1 and, for simple JSON content types, avoid CORS
  // preflight. Require the local app's exact origin unless an operator has
  // deliberately configured a bridge token for a non-browser client.
  if (!BRIDGE_TOKEN && (
    !sameOriginRequest(req)
    || req.headers['x-forwarded-host']
    || req.headers.forwarded
  )) return false;
  const authorization = String(req.headers.authorization || '');
  const presented = String(
    req.headers['x-midio-bridge-token']
      || (authorization.startsWith('Bearer ') ? authorization.slice(7) : ''),
  ).trim();
  if (BRIDGE_TOKEN) return sameSecret(presented, BRIDGE_TOKEN);
  return isLoopbackAddress(req.socket.remoteAddress);
}

if (!isLoopbackHost(HOST) && !BRIDGE_TOKEN) {
  throw new Error('Refusing to bind the development server beyond loopback without MIDIO_BRIDGE_TOKEN');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  // Range v2 payloads are fetched as bytes and gunzipped by the page; no
  // Content-Encoding, so the browser hands over the stored gzip stream.
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.sf2': 'application/octet-stream',
  '.zip': 'application/zip',
};

const SOUNDFONTS_DIR = path.join(ROOT, 'soundfonts');

function decodeRequestPath(rawUrl) {
  const rawPath = (rawUrl || '/').split('?')[0] || '/';
  let reqPath;
  try {
    reqPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!reqPath.startsWith('/') || reqPath.includes('\\')
    || [...reqPath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  if (reqPath === '/') return '/index.html';
  // Reject traversal and dotfiles before resolving. A string-prefix check on
  // a resolved path accepts same-prefix siblings such as `app-private`.
  const segments = reqPath.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) return null;
  return reqPath;
}

function staticPath(reqPath) {
  const fullHistory = /^\/versions\/(?:maps\/v-[a-f0-9]{12}\.json|objects\/[a-f0-9]{40})$/.test(reqPath) || ['/history-worker.js', '/engine/index.html', '/versions/manifest.json', '/versions/build-report.json'].includes(reqPath);
  if (reqPath !== '/index.html' && !reqPath.startsWith('/src/') && !reqPath.startsWith('/soundfonts/') && !fullHistory) return null;
  const filePath = path.resolve(ROOT, `.${reqPath}`);
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return filePath;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// CORS + a generic 404 for any /api/* path that isn't /api/soulseek/*
// (routed away earlier in the dispatcher, see server.createServer below).
// Previously duplicated the entire soulseek route table here too -- those
// branches were unreachable dead code, since every /api/soulseek/* request
// is already intercepted by handleSoulseekRoute before handleApi ever runs.
async function handleApi(req, res, reqPath) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Midio-Bridge-Token, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (reqPath.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found', path: reqPath });
    return true;
  }
  return false;
}

async function handleRequest(req, res) {
  const reqPath = decodeRequestPath(req.url);
  if (!reqPath) {
    sendJson(res, 400, { error: 'Malformed or forbidden path' });
    return;
  }

  // Soulseek bridge API: the browser cannot speak the Soulseek TCP protocol,
  // so the dev server holds the connection. Credentials are sent to the
  // local bridge only (which forwards them to server.slsknet.org).
  if (reqPath.startsWith('/api/soulseek/')) {
    await handleSoulseekRoute(req, res, reqPath);
    return;
  }

  // Soundfont auto-discovery: the client fetches this manifest at boot so
  // dropping a .sf2/.zip into soundfonts/ "just works" without the File
  // System Access API's permission prompt. A static host with no server
  // logic simply 404s here, and the client treats that as "nothing found".
  if (await handleApi(req, res, reqPath)) return;

  // Soundfont auto-discovery
  if (reqPath === '/soundfonts/' || reqPath === '/soundfonts') {
    fs.readdir(SOUNDFONTS_DIR, (err, entries) => {
      const files = err ? [] : entries.filter((f) => /\.(sf2|zip)$/i.test(f)).sort();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(files));
    });
    return;
  }

  const filePath = staticPath(reqPath);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  fs.realpath(filePath, (realpathErr, realPath) => {
    if (realpathErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const relative = path.relative(ROOT, realPath);
    const publicPath = '/' + relative.split(path.sep).join('/');
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || publicPath.split('/').some((segment) => segment.startsWith('.'))
      || !staticPath(publicPath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    fs.readFile(realPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(realPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  handleRequest(req, res).catch((err) => {
    console.error('[request failed]', err);
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: 'Internal server error' });
  });
});

// --- Soulseek bridge API -------------------------------------------------
// GET  /api/soulseek/status                -> mode/connected/note (see getStatus)
// GET  /api/soulseek/demo                  -> {tracks}
// POST /api/soulseek/config  {mode, ...}   -> switch backend (free/slskd/direct)
// DELETE /api/soulseek/config              -> reset to free
// POST /api/soulseek/search  {query}       -> {id, mode} — poll /search/:id
// GET  /api/soulseek/search/:id            -> {status, results, error}
// POST /api/soulseek/download {item}       -> binary attachment
//
// A previous, now-removed integration (PR #64's connect-based bridge,
// tools/soulseek-bridge.js + src/net/SoulseekSource.js) mounted a second,
// incompatible client onto these same paths, disambiguated by guessing at
// each request body's shape. That was the actual bridge failure: /status
// returned one shared `connected` field that meant "free music is ready"
// to this client and "logged into the Soulseek network" to that one, so a
// page load could show "Connected" while every search then failed with
// "enter your username and password first." One bridge now owns this
// surface outright; there is no longer anything to disambiguate.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_BYTES) {
        fail(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', fail);
  });
}

/** Routes /api/soulseek/* to the zero-config bridge (slskPanel /
 *  SoulseekSearch.js): free music with no login, optional bundled slskd or
 *  a direct Soulseek account layered on top via /config. */
async function handleSoulseekRoute(req, res, reqPath) {
  if (!bridgeRequestAuthorized(req)) {
    sendJson(res, 401, { error: 'Soulseek bridge authentication required' });
    return;
  }
  const action = reqPath.slice('/api/soulseek/'.length);

  if (action === 'config') {
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        await setConfig(body || {});
        sendJson(res, 200, { ok: true, ...(await getStatus()) });
      } catch (err) {
        sendJson(res, 400, { error: err.message || String(err) });
      }
      return;
    }
    if (req.method === 'DELETE') {
      setConfig({ mode: 'clear' }).catch(() => {});
      try {
        sendJson(res, 200, { ok: true, ...(await getStatus()) });
      } catch (err) {
        sendJson(res, 500, { ok: true, error: err.message || String(err) });
      }
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (action === 'demo' && req.method === 'GET') {
    sendJson(res, 200, { tracks: listDemoCatalog() });
    return;
  }

  const searchMatch = reqPath.match(/^\/api\/soulseek\/search\/([^/]+)$/);
  if (searchMatch && req.method === 'GET') {
    const data = getSearch(searchMatch[1]);
    if (!data) {
      sendJson(res, 404, { error: 'Search not found' });
      return;
    }
    sendJson(res, 200, data);
    return;
  }

  if (req.method !== 'POST') {
    if (action === 'status' && req.method === 'GET') {
      try {
        sendJson(res, 200, await getStatus());
      } catch (err) {
        sendJson(res, 500, { mode: 'offline', connected: false, note: err.message || String(err) });
      }
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (action === 'search') {
    // Start an async search; the client polls GET /search/:id for results.
    const query = body?.query || body?.q || body?.searchText || '';
    try {
      const started = await startSearch(query);
      sendJson(res, 200, started);
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
    return;
  }

  if (action === 'download') {
    const item = body?.item || body;
    try {
      const result = await downloadResult(item);
      res.writeHead(200, {
        'Content-Type': result.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${result.filename.replace(/"/g, '')}"`,
        'X-Filename': encodeURIComponent(result.filename),
        'Cache-Control': 'no-store',
      });
      res.end(result.buffer);
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
    return;
  }

  sendJson(res, 404, { error: `Unknown action: ${action}` });
}

server.listen(PORT, HOST, async () => {
  console.log(`Super Maudio World + Soulseek at http://${HOST}:${PORT}`);
  const status = await getStatus();
  console.log(`Soulseek backend: ${status.mode} — ${status.note}`);
});
