#!/usr/bin/env node
// A minimal music file server for the "browser with no file chooser" case.
//
// WHY THIS IS NEEDED AT ALL. Fermata's built-in browser never implements
// `WebChromeClient.onShowFileChooser()`, so `<input type="file">` cannot
// open a chooser there and the page has no way to read a file off the
// device (see docs/chooserless-webviews.md). The way in that remains is a
// URL -- but a page can only read a cross-origin response if the server
// sends `Access-Control-Allow-Origin`, and the ordinary options
// (`python3 -m http.server`, most Android file-manager "share over HTTP"
// features) do not send it. Their bytes arrive and are then unreadable.
//
// So this serves a music folder with the two things the page needs: CORS,
// and a listing it can turn into a browsable list.
//
// Run it on the SAME device as the browser. An https page may not fetch
// http:// URLs, with one exception: loopback (127.0.0.1, localhost, ::1)
// counts as a potentially-trustworthy origin and is not treated as mixed
// content. So `http://127.0.0.1:8088` is readable from
// https://supermaudio.com, while `http://192.168.1.50:8088` is blocked. On
// a phone that runs both Fermata and the music, loopback is exactly right.
//
//   node tools/music-server.mjs ~/Music            # then load http://127.0.0.1:8088/
//   node tools/music-server.mjs ~/Music 9000       # a different port
//   MUSIC_HOST=0.0.0.0 node tools/music-server.mjs ~/Music
//   MUSIC_ALLOW_HOST=phone.local ...    # also answer to a name (default:
//                                       # loopback and IP addresses only)
//
// On Android this runs under Termux (`pkg install nodejs`).
//
// SCOPE. Read-only, GET/HEAD/OPTIONS only, and every request is confined to
// the one directory given on the command line -- `..`, dotfiles and
// symlinks to hidden or outside-root targets are refused. It binds loopback by default,
// so nothing is exposed to the network unless MUSIC_HOST says otherwise.
// It is a local convenience, not a public file server: it has no
// authentication, so do not bind it to a public interface.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { hostList, requestHostAllowed } from './lib/request-host.mjs';

// Canonicalised, not merely resolved. Containment is checked by comparing
// against `fsp.realpath()` of each request path, so if ROOT is itself a
// symlink the two live in different trees and EVERY request -- `/` included
// -- looks like an escape and 403s. That is not hypothetical: on the
// documented Termux setup, shared-storage music paths are normally reached
// through exactly such a symlink.
const ROOT_ARG = path.resolve(process.argv[2] || process.env.MUSIC_DIR || process.cwd());
let ROOT;
try {
  ROOT = fs.realpathSync(ROOT_ARG);
} catch {
  console.error(`music-server: cannot read ${ROOT_ARG}`);
  process.exit(1);
}
const PORT = Number(process.argv[3] || process.env.MUSIC_PORT) || 8088;
const HOST = process.env.MUSIC_HOST || '127.0.0.1';

const MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
};
// No .mid/.midi: the page's URL loader sends everything to decodeAudioData
// and has no MIDI ingest path, so listing one would advertise a song that
// cannot play. See the note in src/net/UrlAudioSource.js.
const AUDIO_EXTENSIONS = new Set(Object.keys(MIME));

function isAudio(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Resolves a request path inside ROOT, or null if it tries to leave.
 *  Rejecting `..` and dotfiles per segment before resolving avoids the
 *  same-prefix sibling trap a string check on the resolved path has
 *  (`/music` must not admit `/music-private`). */
function safePath(reqPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath.split('?')[0]);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null;
  const full = path.resolve(ROOT, ...segments);
  const relative = path.relative(ROOT, full);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return full;
}

/** Apply containment and hidden-segment policy after following symlinks.
 *  A visible alias cannot make a hidden local target public. The caller still
 *  judges the audio extension by the alias name, allowing visible blobs. */
async function realPathInRoot(full) {
  const real = await fsp.realpath(full);
  const relative = path.relative(ROOT, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep).some(segment => segment.startsWith('.'))) return null;
  return real;
}

// WHICH PAGES MAY READ THIS. An allowlist, not `*`.
//
// Binding to loopback keeps other machines out, but it does NOT keep other
// *websites* out: this server exists precisely so that a page can fetch it
// from 127.0.0.1, and every other site open in any browser on this device
// can do exactly the same. With `Access-Control-Allow-Origin: *`, any of
// them could read the directory listing and download the music while the
// server runs. The origin is echoed back only when it is one we expect.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://supermaudio.com',
  'https://www.supermaudio.com',
];

/** Extra origins for development, e.g.
 *  MUSIC_ALLOW_ORIGIN="http://127.0.0.1:8080,http://localhost:8080" */
const EXTRA_ALLOWED_ORIGINS = (process.env.MUSIC_ALLOW_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);
const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.has('*');

function corsHeaders(req) {
  const origin = req?.headers?.origin;
  const headers = {
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,Content-Type',
    // A cross-origin reader only sees these response headers if they are
    // explicitly exposed; Content-Length is how the page refuses an
    // oversized file before downloading it.
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
    // The response now differs per origin, so it must not be cached as if
    // it were the same for everyone.
    Vary: 'Origin',
  };
  if (ALLOW_ANY_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  // No header at all for an origin we do not know: the browser then refuses
  // to hand the bytes to that page. A same-origin or non-browser request
  // (curl, an <audio> element) sends no Origin and is unaffected.
  return headers;
}

async function sendListing(req, res, dir, urlPath) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const base = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
  const folders = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    let { isDir, isFile } = { isDir: entry.isDirectory(), isFile: entry.isFile() };
    if (entry.isSymbolicLink()) {
      // A symlink Dirent is NEITHER isDirectory() nor isFile(), so without
      // this a symlinked album or track vanishes from the listing -- even
      // though a direct request for it succeeds, since that path resolves
      // through realPathInRoot(). Symlinks are how shared storage is
      // normally organised on the documented Termux setup, so this made
      // whole sections of a collection undiscoverable.
      const target = await realPathInRoot(path.join(dir, entry.name)).catch(() => null);
      if (!target) continue; // unreadable, or it escapes ROOT: not ours to serve
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat) continue;
      isDir = stat.isDirectory();
      isFile = stat.isFile();
    }
    if (isDir) folders.push(`${base}${encodeURIComponent(entry.name)}/`);
    else if (isFile && isAudio(entry.name)) {
      files.push({ name: entry.name, url: `${base}${encodeURIComponent(entry.name)}` });
    }
  }
  folders.sort();
  files.sort((a, b) => a.name.localeCompare(b.name));
  res.writeHead(200, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ path: base, folders, files }));
}

/** Streams a file to the response without letting a read error kill the
 *  process. `pipe()` does not forward a SOURCE error, so an unreadable file
 *  -- deleted, unmounted, or on storage that went away between stat() and
 *  the open, all ordinary on a phone -- becomes an unhandled 'error' event
 *  and takes the whole server down instead of failing one request.
 *  `pipeline()` handles both ends and destroys the other on failure. */
function streamToResponse(stream, res, label) {
  pipeline(stream, res, (err) => {
    if (!err) return;
    // The headers are already sent by this point, so there is no status left
    // to change: log it and drop the connection so the client sees a
    // truncated transfer rather than a silent, permanent stall.
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'EPIPE') {
      console.error(`music-server: read failed for ${label}: ${err.message}`);
    }
    res.destroy();
  });
}

/** The last path segment as the client asked for it, decoded. A symlink's
 *  TARGET is the wrong thing to judge by: `song.mp3 -> blob` is listed as
 *  audio (the listing reads the link's own name) and would then 404 on the
 *  canonical `blob`, so the listing could advertise a song that never
 *  plays. The realpath still decides containment and supplies the bytes. */
function requestedName(urlPath) {
  try {
    return decodeURIComponent(urlPath).split('/').filter(Boolean).pop() || '';
  } catch {
    return urlPath.split('/').filter(Boolean).pop() || '';
  }
}

function sendFile(req, res, file, size, name = file) {
  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const headers = {
    ...corsHeaders(req),
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
  };

  // Range support: the page reads whole files, but a plain <audio> element
  // pointed at the same URL will ask for ranges and misbehave without it.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : size - 1;
    if (!range[1]) start = Math.max(0, size - Number(range[2])); // suffix range
    if (!range[1]) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { ...corsHeaders(req), 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    streamToResponse(fs.createReadStream(file, { start, end }), res, file);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(size) });
  if (req.method === 'HEAD') { res.end(); return; }
  streamToResponse(fs.createReadStream(file), res, file);
}

// WHICH NAMES MAY REACH THIS. The origin allowlist above does not stop DNS
// rebinding: a page that re-resolves its own name to 127.0.0.1 reads this
// server as same-origin and sends no Origin at all. Its Host header still
// names the attacker's domain, so only loopback names, IP literals (a LAN
// address under MUSIC_HOST=0.0.0.0) and names listed in MUSIC_ALLOW_HOST
// are served.
const EXTRA_ALLOWED_HOSTS = hostList(process.env.MUSIC_ALLOW_HOST);

const server = http.createServer(async (req, res) => {
  if (!requestHostAllowed(req.headers.host, { allowIpLiterals: true, extraHosts: EXTRA_ALLOWED_HOSTS })) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Host not allowed (set MUSIC_ALLOW_HOST to serve it by name)');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...corsHeaders(req), Allow: 'GET, HEAD, OPTIONS' });
    res.end();
    return;
  }

  const urlPath = (req.url || '/').split('?')[0] || '/';
  const full = safePath(urlPath);
  if (!full) {
    res.writeHead(403, { ...corsHeaders(req), 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const real = await realPathInRoot(full);
    if (!real) {
      res.writeHead(403, { ...corsHeaders(req), 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    const stat = await fsp.stat(real);
    if (stat.isDirectory()) await sendListing(req, res, real, urlPath);
    else if (stat.isFile() && isAudio(requestedName(urlPath))) {
      // Same name the listing judged by, so a listed song is always fetchable.
      sendFile(req, res, real, stat.size, requestedName(urlPath));
    }
    else {
      res.writeHead(404, { ...corsHeaders(req), 'Content-Type': 'text/plain' });
      res.end('Not an audio file');
    }
  } catch {
    res.writeHead(404, { ...corsHeaders(req), 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`music-server: serving ${ROOT}`);
  // An IPv6 literal must be bracketed or the result is not a URL: bare
  // `http://::1:8088/` is rejected by the loader it is meant to be pasted
  // into, and ::1 is a loopback host this server explicitly supports.
  const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  const authority = shown.includes(':') && !shown.startsWith('[') ? `[${shown}]` : shown;
  console.log(`  http://${authority}:${PORT}/`);
  console.log('  Paste that into Midio\'s "Load from a URL" field.');
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('  NOTE: bound to a non-loopback address. An https page cannot');
    console.log('  fetch http:// from a LAN address -- only loopback is exempt.');
  }
});
