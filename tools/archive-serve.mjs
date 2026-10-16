// Version archive: every commit on main, runnable, served straight out of git.
// Usage: node tools/archive-serve.mjs [port] [ref] [--open]
//
// The app has no build step, so a commit's tree is already a deployable site.
// Nothing is checked out or copied: each request is answered from the object
// database (`<sha>:<path>`), which costs no disk and makes every version
// available the moment it is committed.
//
// Each version is served from its own origin, http://<sha>.localhost:<port>/.
// Browsers resolve *.localhost to loopback, and the separate origin matters
// twice over: versions do not share localStorage/IndexedDB (an old build
// opening a newer build's database throws VersionError), and the early
// commits' absolute `/src/...` URLs resolve because each version sits at `/`.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8090;
const SEP = '\x1f';
const END = '\x1e';

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
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.sf2': 'application/octet-stream',
  '.zip': 'application/zip',
};

function git(repo, args, input) {
  const result = spawnSync('git', args, {
    cwd: repo, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout;
}

/**
 * One long-lived `git cat-file --batch`. A page load is hundreds of module
 * requests; a process per request crawls on Windows, where spawn is slow.
 * Answers come back in request order, so a FIFO of waiters is enough.
 */
function openBlobReader(repo) {
  let child = null;
  let waiters = [];
  let chunks = [];
  let total = 0;
  let need = 0;

  function fail(error) {
    const failed = waiters;
    waiters = []; chunks = []; total = 0; need = 0; child = null;
    for (const waiter of failed) waiter.reject(error);
  }

  function pump() {
    if (total < need) return;
    let buffered = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    while (waiters.length) {
      const lineEnd = buffered.indexOf(10);
      if (lineEnd < 0) { need = 0; break; }
      const header = buffered.toString('utf8', 0, lineEnd);
      // "<oid> <type> <size>", or "<name> missing" when the path is absent.
      const found = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
      if (!found) {
        buffered = buffered.subarray(lineEnd + 1);
        waiters.shift().resolve(null);
        continue;
      }
      const bodyEnd = lineEnd + 1 + Number(found[3]);
      if (buffered.length < bodyEnd + 1) { need = bodyEnd + 1; break; }
      const body = buffered.subarray(lineEnd + 1, bodyEnd);
      buffered = buffered.subarray(bodyEnd + 1);
      need = 0;
      waiters.shift().resolve({ oid: found[1], type: found[2], body });
    }
    chunks = buffered.length ? [buffered] : [];
    total = buffered.length;
  }

  function start() {
    child = spawn('git', ['cat-file', '--batch'], { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'] });
    const self = child;
    child.stdout.on('data', (chunk) => {
      if (child !== self) return;
      chunks.push(chunk);
      total += chunk.length;
      pump();
    });
    child.on('error', (error) => { if (child === self) fail(error); });
    child.on('close', () => { if (child === self) fail(new Error('git cat-file exited')); });
    child.stdin.on('error', () => {});
  }

  return {
    read(spec) {
      return new Promise((resolve, reject) => {
        if (!child) start();
        waiters.push({ resolve, reject });
        child.stdin.write(`${spec}\n`);
      });
    },
    // Resolves once git has exited: on Windows a live process pins its
    // working directory, so the caller cannot remove the repo before then.
    close() {
      const closing = child;
      child = null;
      if (!closing) return Promise.resolve();
      return new Promise((resolve) => {
        closing.once('close', resolve);
        closing.stdin.end();
      });
    },
  };
}

/** Oldest first, so a version's number is its position in the project's life. */
export function listVersions(repo, ref) {
  const format = ['%H', '%aI', '%s', '%D', '%b'].join(SEP) + END;
  const log = git(repo, [
    'log', '--first-parent', '--decorate-refs=refs/tags/*', `--format=${format}`, ref, '--',
  ]);
  const commits = log.split(END).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [sha, date, subject, refs, body = ''] = entry.split(SEP);
    // Squash merges end "(#12)". Merge commits say only which branch landed;
    // GitHub puts the pull request's title on the first line of the body.
    const merge = /^Merge pull request #(\d+)/.exec(subject);
    const pr = merge || /\(#(\d+)\)$/.exec(subject);
    const described = merge && body.split('\n').map((line) => line.trim()).find(Boolean);
    return {
      sha,
      date,
      subject,
      title: described ? `${described} (#${merge[1]})` : subject,
      pr: pr ? Number(pr[1]) : null,
      tags: (refs || '').split(',').map((name) => name.trim().replace(/^tag: /, '')).filter(Boolean),
    };
  }).reverse();

  let idLength = 7;
  while (idLength < 40 && new Set(commits.map((c) => c.sha.slice(0, idLength))).size < commits.length) {
    idLength += 1;
  }
  // The first commits predate the app; they stay on the timeline, marked.
  const checks = git(repo, ['cat-file', '--batch-check'],
    commits.map((c) => `${c.sha}:index.html`).join('\n') + '\n').split('\n');
  return commits.map((commit, index) => ({
    ...commit,
    id: commit.sha.slice(0, idLength),
    number: index + 1,
    runnable: / blob \d+$/.test(checks[index] || ''),
  }));
}

function repoWebUrl(repo) {
  try {
    const remote = git(repo, ['remote', 'get-url', 'origin']).trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    return match ? `https://github.com/${match[1]}` : null;
  } catch {
    return null;
  }
}

function decodeRequestPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(rawUrl).split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/') || /[\0\r\n\\]/.test(pathname)) return null;
  const segments = pathname.slice(1).split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  return segments.filter(Boolean).join('/');
}

// --- Code that runs in the page. Written as real functions so the linter
// --- sees it, then serialised into the response.

function navClient(nav) {
  const go = (target) => {
    // Carry ?query and #hash across, so a song loaded by URL follows you.
    if (target) location.href = target + location.search + location.hash;
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    nav { display:flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px;
      font:12px/1.2 system-ui,sans-serif; color:#e8e8f0; background:rgba(12,12,20,.82);
      border:1px solid rgba(255,255,255,.18); opacity:.4; transition:opacity .15s;
      max-width:92vw; white-space:nowrap; }
    nav:hover, nav:focus-within { opacity:1; }
    button { all:unset; cursor:pointer; padding:2px 8px; border-radius:999px; }
    button:hover:not(:disabled), button:focus-visible { background:rgba(255,255,255,.16); }
    button:disabled { opacity:.3; cursor:default; }
    .label { overflow:hidden; text-overflow:ellipsis; max-width:46vw; }
    .tag { color:#ffd166; font-weight:600; }
  `;
  const bar = document.createElement('nav');
  const button = (text, title, action, disabled) => {
    const el = document.createElement('button');
    el.textContent = text;
    el.title = title;
    el.disabled = Boolean(disabled);
    el.addEventListener('click', action);
    return el;
  };
  const label = document.createElement('span');
  label.className = 'label';
  label.title = nav.title;
  if (nav.tags.length) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = nav.tags.join(' ') + ' ';
    label.append(tag);
  }
  label.append(`${nav.number}/${nav.total} · ${nav.date.slice(0, 10)} · ${nav.id} · ${nav.title}`);
  const toggle = () => { host.hidden = !host.hidden; };
  bar.append(
    button('‹ older', 'Previous version (Alt+,)', () => go(nav.prev), !nav.prev),
    label,
    button('newer ›', 'Next version (Alt+.)', () => go(nav.next), !nav.next),
    button('all', 'All versions (Alt+L)', () => { location.href = nav.home; }),
    button('×', 'Hide this bar (Alt+H brings it back)', toggle),
  );
  root.append(style, bar);
  (document.body || document.documentElement).append(host);

  // The app ignores Alt chords in every version, so these never collide.
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const action = {
      Comma: () => go(nav.prev),
      Period: () => go(nav.next),
      KeyL: () => { location.href = nav.home; },
      KeyH: toggle,
    }[event.code];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }, true);
}

function timelineClient() {
  const list = document.getElementById('list');
  const search = document.getElementById('search');
  const prsOnly = document.getElementById('prs');
  const summary = document.getElementById('summary');
  const jumps = document.getElementById('jumps');
  const LAST = 'archive:last';
  let versions = [];
  let repoUrl = null;
  let last = null;
  try { last = localStorage.getItem(LAST); } catch { /* storage is a convenience */ }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function render() {
    const needle = search.value.trim().toLowerCase();
    const shown = versions.filter((v) => (!prsOnly.checked || v.pr || v.tags.length)
      && (!needle || `${v.title} ${v.subject} ${v.sha} ${v.date} ${v.tags.join(' ')} #${v.pr || ''} v${v.number}`
        .toLowerCase().includes(needle)));
    summary.textContent = `${shown.length} of ${versions.length} versions`;
    const fragment = document.createDocumentFragment();
    let day = null;
    for (const v of shown.slice().reverse()) {
      if (v.date.slice(0, 10) !== day) {
        day = v.date.slice(0, 10);
        fragment.append(el('h2', null, day));
      }
      const row = el('a', 'row' + (v.runnable ? '' : ' empty') + (v.sha === last ? ' last' : ''));
      row.href = v.url;
      row.id = v.id;
      row.addEventListener('click', () => {
        try { localStorage.setItem(LAST, v.sha); } catch { /* see above */ }
      });
      row.append(el('span', 'num', String(v.number)), el('code', null, v.id));
      const subject = el('span', 'subject');
      for (const tag of v.tags) subject.append(el('span', 'badge tag', tag));
      subject.append(v.title);
      if (!v.runnable) subject.append(el('span', 'badge', 'no app yet'));
      if (v.sha === last) subject.append(el('span', 'badge', 'last viewed'));
      row.append(subject);
      fragment.append(row);
      if (repoUrl) {
        const source = el('a', 'source', 'diff');
        source.href = `${repoUrl}/commit/${v.sha}`;
        source.target = '_blank';
        source.rel = 'noopener';
        fragment.append(source);
      } else {
        fragment.append(el('span'));
      }
    }
    list.replaceChildren(fragment);
  }

  function jump(text, version) {
    if (!version) return;
    const link = el('a', 'chip', text);
    link.href = version.url;
    jumps.append(link);
  }

  fetch('/versions.json').then((response) => response.json()).then((data) => {
    versions = data.versions;
    repoUrl = data.repoUrl;
    const runnable = versions.filter((v) => v.runnable);
    jump('First', runnable[0]);
    for (const v of versions) for (const tag of v.tags) jump(tag, v);
    jump('Latest', runnable.at(-1));
    jump('Last viewed', versions.find((v) => v.sha === last));
    render();
    // Coming back from a version lands on its row.
    const from = location.hash && document.getElementById(location.hash.slice(1));
    if (from) {
      from.scrollIntoView({ block: 'center' });
      from.focus();
    }
  });
  search.addEventListener('input', render);
  prsOnly.addEventListener('change', render);
  window.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });
}

const TIMELINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Version archive</title>
<style>
  :root { color-scheme: dark; --fg:#e8e8f0; --dim:#8b8ba0; --line:#26263a; --accent:#ffd166; }
  body { margin:0; background:#0c0c14; color:var(--fg); font:14px/1.45 system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:1; background:#0c0c14ee; backdrop-filter:blur(6px);
    border-bottom:1px solid var(--line); padding:12px 16px; }
  header > div { max-width:1100px; margin:0 auto; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  h1 { font-size:16px; margin:0 8px 0 0; }
  input[type=search] { flex:1 1 220px; min-width:0; padding:6px 10px; border-radius:6px;
    border:1px solid var(--line); background:#14141f; color:inherit; font:inherit; }
  label, #summary { color:var(--dim); white-space:nowrap; }
  .chip { padding:3px 10px; border:1px solid var(--line); border-radius:999px; color:var(--fg);
    text-decoration:none; }
  .chip:hover { border-color:var(--accent); color:var(--accent); }
  #jumps { display:flex; flex-wrap:wrap; gap:6px; }
  main { max-width:1100px; margin:0 auto; padding:0 16px 48px;
    display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:12px; }
  h2 { grid-column:1 / -1; font-size:12px; color:var(--dim); font-weight:600;
    margin:20px 0 4px; letter-spacing:.04em; }
  .row { display:grid; grid-template-columns:3.5ch 9ch minmax(0,1fr); gap:10px; align-items:baseline;
    padding:5px 8px; border-radius:6px; color:inherit; text-decoration:none; }
  .row:hover, .row:focus-visible { background:#1a1a2a; outline:none; }
  .row.empty { color:var(--dim); }
  .row.last { box-shadow:inset 2px 0 var(--accent); }
  .num { color:var(--dim); text-align:right; font-variant-numeric:tabular-nums; }
  code { color:var(--dim); font:12px ui-monospace,Consolas,monospace; }
  .subject { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { font-size:11px; padding:1px 6px; margin:0 6px; border-radius:999px;
    border:1px solid var(--line); color:var(--dim); }
  .badge.tag { margin:0 6px 0 0; border-color:var(--accent); color:var(--accent); font-weight:600; }
  .source { align-self:center; font-size:12px; color:var(--dim); text-decoration:none; }
  .source:hover { color:var(--accent); }
  @media (max-width:600px) { .row { grid-template-columns:3.5ch minmax(0,1fr); } .row code { display:none; } }
</style>
</head>
<body>
<header><div>
  <h1>Version archive</h1>
  <input id="search" type="search" placeholder="Filter by words, date, sha, #PR  ( / )" autofocus />
  <label><input id="prs" type="checkbox" /> PRs and releases only</label>
  <span id="summary"></span>
  <span id="jumps"></span>
</div></header>
<main id="list"></main>
<script>(${timelineClient})();</script>
</body>
</html>
`;

function placeholderPage(version) {
  const safe = (text) => String(text).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${safe(version.id)} - no app yet</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0c14;
color:#8b8ba0;font:14px/1.5 system-ui,sans-serif;text-align:center}b{color:#e8e8f0}</style></head>
<body><p>Version ${version.number} has no <code>index.html</code>, so there is nothing to run.<br />
<b>${safe(version.title)}</b></p>
<script src="/__archive/nav.js" defer></script></body></html>
`;
}

function injectNav(html) {
  const tag = '<script src="/__archive/nav.js" defer></script>';
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

export async function startArchive({
  repo = path.join(__dirname, '..'), ref = 'HEAD', port = DEFAULT_PORT, host = '127.0.0.1',
} = {}) {
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const repoUrl = repoWebUrl(root);
  const blobs = openBlobReader(root);
  let versions = [];
  let byId = new Map();
  let listenPort = port;

  const origin = (version) => `http://${version.id}.localhost:${listenPort}/`;
  function refresh() {
    versions = listVersions(root, ref);
    byId = new Map(versions.map((version, index) => [version.id, index]));
  }
  refresh();

  function send(res, status, type, body, cache = 'no-store') {
    res.writeHead(status, {
      'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': cache,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  }
  const text = (res, status, message) => send(res, status, 'text/plain; charset=utf-8', message);

  function serveTimeline(res, pathname) {
    if (pathname === '') {
      refresh(); // New commits appear on reload, without a restart.
      return send(res, 200, MIME['.html'], TIMELINE_HTML);
    }
    if (pathname === 'versions.json') {
      return send(res, 200, MIME['.json'], JSON.stringify({
        ref, repoUrl, versions: versions.map((version) => ({ ...version, url: origin(version) })),
      }));
    }
    return text(res, 404, 'Not found');
  }

  // Files git never had: user-dropped SoundFonts are gitignored, so no commit
  // contains them. Serve today's copy to every version.
  async function readUntracked(pathname) {
    if (!pathname.startsWith('soundfonts/')) return null;
    try {
      const base = await fs.realpath(path.join(root, 'soundfonts'));
      const real = await fs.realpath(path.join(root, pathname));
      if (!real.startsWith(base + path.sep)) return null;
      return await fs.readFile(real);
    } catch {
      return null;
    }
  }

  async function serveVersion(res, index, pathname) {
    const version = versions[index];
    if (pathname === '__archive/nav.js') {
      const prev = versions[index - 1];
      const next = versions[index + 1];
      const nav = {
        id: version.id, number: version.number, total: versions.length, date: version.date,
        title: version.title, tags: version.tags,
        prev: prev ? origin(prev) : null,
        next: next ? origin(next) : null,
        home: `http://localhost:${listenPort}/#${version.id}`,
      };
      return send(res, 200, MIME['.js'], `(${navClient})(${JSON.stringify(nav)});\n`);
    }

    // Soundfont auto-discovery, as in tools/serve.js: the page asks which
    // fonts were dropped into the folder, then fetches them (readUntracked).
    if (pathname === 'soundfonts') {
      const entries = await fs.readdir(path.join(root, 'soundfonts')).catch(() => []);
      const fonts = entries.filter((name) => /\.(sf2|zip)$/i.test(name)).sort();
      return send(res, 200, MIME['.json'], JSON.stringify(fonts));
    }

    let file = pathname || 'index.html';
    let object = await blobs.read(`${version.sha}:${file}`);
    if (object?.type === 'tree') {
      file = `${file}/index.html`;
      object = await blobs.read(`${version.sha}:${file}`);
    }
    if (object?.type !== 'blob') {
      if (file === 'index.html') return send(res, 200, MIME['.html'], placeholderPage(version));
      const untracked = await readUntracked(file);
      if (!untracked) return text(res, 404, 'Not found');
      return send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', untracked);
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (file === 'index.html') {
      return send(res, 200, type, injectNav(object.body.toString('utf8')));
    }
    // A blob at a commit never changes.
    return send(res, 200, type, object.body, 'public, max-age=31536000, immutable');
  }

  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
      // Only names that can mean this machine: a rebinding site cannot read
      // the repository through a hostname of its own.
      const name = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      const match = /^(?:([0-9a-f]{7,40})\.)?localhost$/.exec(name);
      if (!match && name !== '127.0.0.1' && name !== '[::1]') return text(res, 400, 'Bad host');
      const pathname = decodeRequestPath(req.url);
      if (pathname == null) return text(res, 400, 'Bad request');
      if (!match?.[1]) return serveTimeline(res, pathname);
      const index = byId.get(match[1]);
      if (index == null) return text(res, 404, 'Unknown version');
      return serveVersion(res, index, pathname);
    }).catch((error) => {
      console.error(error);
      if (!res.headersSent) text(res, 500, 'Archive error');
      else res.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  listenPort = server.address().port;
  return {
    port: listenPort,
    url: `http://localhost:${listenPort}/`,
    get versions() { return versions; },
    async close() {
      server.closeAllConnections();
      await Promise.all([blobs.close(), new Promise((resolve) => server.close(resolve))]);
    },
  };
}

function openInBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const port = Number(process.env.PORT || positional[0]) || DEFAULT_PORT;
  startArchive({ port, ref: positional[1] || 'HEAD' }).then((archive) => {
    const runnable = archive.versions.filter((version) => version.runnable);
    console.log(`Version archive: ${archive.versions.length} versions, ${runnable.length} runnable`);
    console.log(`  ${archive.url}`);
    console.log('  In a version: Alt+, older   Alt+. newer   Alt+L all versions   Alt+H hide bar');
    if (args.includes('--open')) openInBrowser(archive.url);
  }).catch((error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is in use. Try: npm run archive -- ${port + 1}` : error.message);
    process.exitCode = 1;
  });
}
