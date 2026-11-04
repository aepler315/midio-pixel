// Parse and link every module the browser can load from src/, without
// running any of it, so a module graph that cannot load fails here instead of
// only in the browser.
//
// Why: the #70 merge kept both sides of an import conflict in RangeScene.js.
// Two imports of `ACTOR_IDS` is an early SyntaxError, so the dynamic import
// of RangeScene.js rejected and every Landscape view fell back with "Could
// not prepare the landscape: runtime-unavailable: Identifier 'ACTOR_IDS' has
// already been declared". The conflict was resolved in GitHub's editor, so
// the pre-push gate never ran.
//
// Parsing and linking use V8's own vm.SourceTextModule, so the messages are
// the ones the browser shows. Checked:
//   - every .js/.mjs file under src/ parses as a module (duplicate
//     declarations, any syntax error);
//   - every static import is a ./, ../ or / path (there is no import map)
//     to a file under src/, which is all tools/serve.js and the site serve
//     for modules. The name must match exactly, case included: Windows and
//     macOS forgive a wrong case, the published site does not. A JSON import
//     needs `with { type: 'json' }`, and the JSON must parse;
//   - every imported name is exported (V8's link step);
//   - every dynamic import() names its target in a way this check can
//     follow: a string literal, or a `new URL('….js', import.meta.url)`
//     constant. Every such URL, and every Worker, SharedWorker or service
//     worker script (a literal, a string constant or a URL), names a module
//     that exists. A worker whose script only compiles as a module (import,
//     export, import.meta) is started with { type: 'module' };
//   - every <script type="module"> in index.html and the pages under src/
//     loads: a src= must name a module that exists, and an inline script is
//     parsed, resolved and linked like a file;
//   - no file under src/ (shaders inside template literals included) and
//     no index.html keeps a conflict marker line.
// Not checked: evaluation. A module that throws while it runs (a TDZ read in
// an import cycle, a top-level DOM call) passes here. Lint's no-undef and the
// tests that import modules cover most of that.
//
// Usage: node --experimental-vm-modules tools/module-graph-check.mjs [--json] [--tracked] [root]
//   --tracked  also require every module target to be tracked by git, so a
//              file that exists here but was never added fails (pre-push).
// Exit status 1 when anything fails. test/moduleGraph.test.mjs runs it.
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';

// Modules the site serves somewhere other than their place in src/.
// Relative imports resolve against the served URL, so they are checked
// from there, and a reference to the src/ copy is an error.
export const SERVED_AT = new Map([
  // tools/stage-history.mjs copies both to the root of the versions site:
  // the worker is registered from there by src/ui/HistoryPicker.js, and the
  // shell becomes that site's index.html. Their paths start with ./src/.
  ['src/ui/history-worker.js', 'history-worker.js'],
  ['src/ui/history-shell.html', 'index.html'],
]);
// Pages under src/dev/ are opened by tool harnesses (tools/lib/scenic-render.mjs
// and others) whose servers serve the whole checkout, so the modules they
// reach may live outside src/.
const DEV_PAGES = 'src/dev/';

const SITE = new URL('https://site.invalid/');
const MODULE_FILE = /\.m?js$/;
// Served path -> module, for the module entries of SERVED_AT.
const SERVED_FROM = new Map([...SERVED_AT].filter(([rel]) => MODULE_FILE.test(rel)).map(([rel, at]) => [at, rel]));
const TEXT_FILE = /\.(?:m?js|html|css|json|glsl|svg)$/;
const SPECIFIER_PATH = /^\.{0,2}\//; // module specifiers that are URL paths
const CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?:[ \t].*)?$|^={7}$/;
// test/serve.test.js creates and removes src/server-test-* during the suite.
const SKIP_DIR = /^server-test-/;
const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module' };

const servedUrl = (rel) => new URL(SERVED_AT.get(rel) ?? rel, SITE);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOf = (code, index) => (index < 0 ? undefined : code.slice(0, index).split('\n').length);

/** Where a served URL lives in the repo, or why it can't load from there. */
function siteFile(url, { anywhere = false } = {}) {
  if (url.origin !== SITE.origin) return { error: `${url.href} is not on the site` };
  let served = url.pathname.slice(1);
  try { served = decodeURIComponent(served); } catch { /* keep it encoded */ }
  if (SERVED_FROM.has(served)) return { rel: SERVED_FROM.get(served) };
  if (SERVED_AT.has(served)) {
    return { error: `${served} is served at /${SERVED_AT.get(served)}, and its own imports only resolve from there` };
  }
  if (!anywhere && !served.startsWith('src/')) return { error: `${served} is outside src/, which is all the site serves for modules` };
  return { rel: served };
}

async function entryKind(root, rel, entry) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return null;
  const stat = await fs.stat(path.join(root, rel)).catch(() => null);
  return stat?.isFile() ? 'file' : stat?.isDirectory() ? 'link-dir' : null;
}

async function walk(root, dir, out) {
  let entries;
  try { entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return out; // removed while we walked
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    const kind = await entryKind(root, rel, entry);
    // Linked directories are not walked (no loops); their modules are still
    // checked when something imports them.
    if (kind === 'dir') { if (!SKIP_DIR.test(entry.name)) await walk(root, rel, out); }
    else if (kind === 'file') out.push(rel);
  }
  return out;
}

/** Whether a repo-relative path names an existing file spelled exactly so. */
function exactFileChecker(root) {
  const listings = new Map();
  const list = (dir) => {
    if (!listings.has(dir)) {
      listings.set(dir, fs.readdir(path.join(root, dir), { withFileTypes: true })
        .then(entries => new Map(entries.map(e => [e.name, e])), () => new Map()));
    }
    return listings.get(dir);
  };
  return async (rel) => {
    const parts = rel.split('/');
    let dir = '';
    for (const [i, part] of parts.entries()) {
      const entry = (await list(dir)).get(part);
      if (!entry) return false;
      const kind = await entryKind(root, dir ? `${dir}/${part}` : part, entry);
      if (i === parts.length - 1) return kind === 'file';
      if (kind !== 'dir' && kind !== 'link-dir') return false;
      dir = dir ? `${dir}/${part}` : part;
    }
    return false;
  };
}

function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return new Set(out.split('\0').filter(Boolean));
}

/** V8 reports a module parse error without its position; espree (ESLint's
 *  parser, which raises the same early errors) says where it is. */
function parseErrorLine(linter, code, rel) {
  return linter.verify(code, [{ files: ['**/*'], languageOptions: PARSE_OPTIONS }], { filename: rel })
    .find(m => m.fatal)?.line;
}

// Leading text of a string expression: a literal, a template, or a `+`
// chain. A part after a dynamic piece is unknown, so only a prefix that
// ends at a query or hash is usable (`./w.js?v=${BUILD}`).
function leading(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return { text: node.value, complete: true };
  if (node?.type === 'TemplateLiteral') return { text: node.quasis[0].value.cooked ?? '', complete: node.expressions.length === 0 };
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = leading(node.left);
    if (!left?.complete) return left;
    const right = leading(node.right);
    return right ? { text: left.text + right.text, complete: right.complete } : { text: left.text, complete: false };
  }
  return null;
}
function stringValue(node) {
  const lead = leading(node);
  if (!lead) return null;
  if (lead.complete) return lead.text;
  const cut = lead.text.search(/[?#]/);
  return cut >= 0 ? lead.text.slice(0, cut) : null;
}

const isMetaUrl = (node) => node?.type === 'MemberExpression' && node.object?.type === 'MetaProperty'
  && node.object.meta?.name === 'import' && node.object.property?.name === 'meta' && node.property?.name === 'url';
const isUrlCall = (node) => node?.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL';
const memberName = (node) => (node?.type === 'MemberExpression' && !node.computed ? node.property.name : null);

function* children(node) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (const v of value) if (v?.type) yield v; }
    else if (value.type) yield value;
  }
}
function* subtree(node) {
  yield node;
  for (const child of children(node)) yield* subtree(child);
}

const propertyNamed = (object, name) => object?.type === 'ObjectExpression'
  ? object.properties.find(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === name) : null;

/** The `with: { type }` of an import() options argument. */
function importType(options) {
  if (!options) return {};
  const attrs = propertyNamed(options, 'with');
  if (!attrs) return options.type === 'ObjectExpression' ? {} : { unreadable: true };
  const type = propertyNamed(attrs.value, 'type');
  if (attrs.value.type !== 'ObjectExpression') return { unreadable: true };
  if (!type) return {};
  return type.value.type === 'Literal' && typeof type.value.value === 'string' ? { type: type.value.value } : { unreadable: true };
}

/** Dynamic imports, module URLs and worker starts in one file, found by a
 *  real JS parser so JSDoc `import('...')` types and comments are ignored. */
function moduleReferences(linter, code, rel) {
  const urlConsts = new Map();
  const urlNodes = [];
  const imports = [];
  const workers = [];
  const base = servedUrl(rel);
  const urlOf = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (node.type === 'Identifier') return urlOf(urlConsts.get(node.name), seen);
    if (node.type === 'MemberExpression' && memberName(node) === 'href') return urlOf(node.object, seen);
    if (!isUrlCall(node)) return null;
    const [spec, from] = node.arguments;
    const text = stringValue(spec);
    const baseUrl = isMetaUrl(from) ? base : from ? urlOf(from, seen) : null;
    if (text == null || !baseUrl) return null;
    try { return new URL(text, baseUrl); } catch { return null; }
  };
  const refs = {
    create: () => ({
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init) urlConsts.set(node.id.name, node.init);
      },
      NewExpression(node) {
        if (isUrlCall(node)) urlNodes.push(node);
        if (node.callee.type === 'Identifier' && /^(?:Shared)?Worker$/.test(node.callee.name)) {
          workers.push({ node, script: node.arguments[0], options: node.arguments[1], what: `new ${node.callee.name}` });
        }
      },
      CallExpression(node) {
        const name = memberName(node.callee);
        if (name === 'register' && memberName(node.callee.object) === 'serviceWorker') {
          workers.push({ node, script: node.arguments[0], options: node.arguments[1], what: 'serviceWorker.register' });
        } else if (name === 'addModule') {
          workers.push({ node, script: node.arguments[0], options: null, what: 'addModule', alwaysModule: true });
        }
      },
      ImportExpression(node) { imports.push(node); },
    }),
  };
  linter.verify(code, [{
    files: ['**/*'],
    languageOptions: PARSE_OPTIONS,
    plugins: { graph: { rules: { refs } } },
    rules: { 'graph/refs': 'error' },
  }], { filename: rel });

  const found = [];
  for (const node of urlNodes) {
    const url = urlOf(node);
    if (url && MODULE_FILE.test(url.pathname)) found.push({ kind: 'module URL', url, line: node.loc.start.line });
  }
  for (const node of imports) {
    const spec = stringValue(node.source);
    const line = node.loc.start.line;
    if (leading(node.source)?.complete) { found.push({ kind: 'dynamic import', spec, line, ...importType(node.options) }); continue; }
    // An expression is fine when it is built from a URL constant this check
    // already follows (e.g. import(retryUrl(SCENE_URL, attempt))).
    const followed = [...subtree(node.source)]
      .some(n => (n.type === 'Identifier' || isUrlCall(n)) && MODULE_FILE.test(urlOf(n)?.pathname ?? ''));
    if (!followed) found.push({ kind: 'dynamic import', unfollowed: true, line });
  }
  // A string constant (`const SCRIPT = '/src/w.js'`) counts as its literal.
  const constString = (node, seen = new Set()) => {
    if (node?.type === 'Identifier') {
      if (seen.has(node.name)) return null;
      seen.add(node.name);
      return constString(urlConsts.get(node.name), seen);
    }
    return leading(node)?.complete ? stringValue(node) : null;
  };
  for (const w of workers) {
    const line = w.node.loc.start.line;
    let url = urlOf(w.script);
    // A URL object naming a .js file is already checked as a module URL.
    const checkExists = !(url && MODULE_FILE.test(url.pathname));
    if (!url) {
      // A plain string is document-relative; the app's document is /index.html.
      const literal = constString(w.script);
      if (literal != null) { try { url = new URL(literal, SITE); } catch { url = null; } }
    }
    if (!url) { found.push({ kind: 'worker', unfollowed: true, line, what: w.what }); continue; }
    const typeProp = w.options?.type === 'ObjectExpression'
      ? w.options.properties.find(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'type') : null;
    const isModule = w.alwaysModule || (typeProp?.value.type === 'Literal' && typeProp.value.value === 'module');
    found.push({ kind: 'worker', url, line, what: w.what, isModule, checkExists });
  }
  return found;
}

/** Which file and line a link error came from. V8 names the requested
 *  specifier and the export but not the importer. */
function linkErrorSite(err, candidates) {
  const m = /requested module '([^']+)' (?:does not provide an export named|contains conflicting star exports for name) '([^']+)'/
    .exec(err?.message || '');
  if (!m) return null;
  const [, spec, name] = m;
  const from = `\\s*from\\s*(?<q>['"])${escapeRegExp(spec)}\\k<q>`;
  const named = new RegExp(`(?:^|[\\s,{])${escapeRegExp(name)}(?=[\\s,}]|$)`);
  const statement = name === 'default'
    ? new RegExp(`\\bimport\\s+[\\w$]+\\s*(?:,\\s*(?:\\{[^}]*\\}|\\*\\s*as\\s+[\\w$]+)\\s*)?${from}`, 'g')
    : new RegExp(`\\b(?:import|export)\\s*(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}${from}`, 'g');
  for (const { rel, code } of candidates) {
    for (const hit of code.matchAll(statement)) {
      if (name === 'default' || named.test(hit[1].replace(/\s+as\s+[\w$]+/g, ''))) return { file: rel, line: lineOf(code, hit.index) };
    }
  }
  return null;
}

export async function checkModuleGraph(root = process.cwd(), { srcDir = 'src', tracked = false } = {}) {
  root = path.resolve(root);
  const all = await walk(root, srcDir, []);
  const files = all.filter(rel => MODULE_FILE.test(rel));
  const isFile = exactFileChecker(root);
  const trackedSet = tracked ? trackedFiles(root) : null;
  const linter = new Linter({ configType: 'flat' });
  const problems = [];
  const seen = new Set();
  const inline = new Map(); // "page.html#module-N" -> { page, offset }
  const report = (raw) => {
    const at = inline.get(raw.file);
    const problem = at ? { ...raw, file: at.page, ...(raw.line ? { line: raw.line + at.offset } : {}) } : raw;
    const key = `${problem.file}\0${problem.line}\0${problem.message}`;
    if (!seen.has(key)) { seen.add(key); problems.push(problem); }
  };

  const sources = new Map();
  const source = async (rel) => {
    if (!sources.has(rel)) sources.set(rel, fs.readFile(path.join(root, rel), 'utf8').catch(() => null));
    return sources.get(rel);
  };

  /** Resolve a URL to a module file, or say why it can't load. */
  // Modules reached from a dev page (or from outside src/, which only a dev
  // page can reach) may import anything in the checkout.
  // A module outside src/ is only parsed when a dev page reached it; a page
  // outside src/ (index.html) is the app itself and gets no exception.
  const devOnly = (rel) => rel.startsWith(DEV_PAGES) || (MODULE_FILE.test(rel) && !rel.startsWith(`${srcDir}/`));
  const target = async (url, from = '') => {
    const site = siteFile(url, { anywhere: devOnly(from) });
    if (site.error) return site;
    if (!await isFile(site.rel)) return { error: `${site.rel} does not exist (names must match exactly, case included)` };
    if (trackedSet && !trackedSet.has(site.rel)) return { error: `${site.rel} is not tracked by git, so it is not published` };
    return { rel: site.rel };
  };

  // 0. Pages: a <script type="module" src> must load, and an inline module
  // script is checked like a file (as "page.html#module-N").
  const roots = [...files];
  for (const page of [...all.filter(r => r.endsWith('.html')), 'index.html']) {
    const html = await source(page);
    if (html == null) continue;
    let n = 0;
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const [whole, attrs, body] = m;
      if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue;
      const line = lineOf(html, m.index);
      const srcAttr = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      if (srcAttr) {
        const spec = srcAttr[1] ?? srcAttr[2] ?? srcAttr[3];
        const found = await target(new URL(spec, servedUrl(page)), page);
        if (found.error) report({ file: page, line, kind: 'html', message: `<script type="module" src="${spec}"> cannot load: ${found.error}` });
        else if (!MODULE_FILE.test(found.rel)) report({ file: page, line, kind: 'html', message: `<script type="module" src="${spec}"> is not a .js module` });
        else roots.push(found.rel);
        continue;
      }
      const id = `${page}#module-${++n}`;
      sources.set(id, Promise.resolve(body));
      inline.set(id, { page, offset: lineOf(html, m.index + whole.indexOf('>') + 1) - 1 });
      roots.push(id);
    }
  }

  // 1. Parse every module once and resolve its own imports.
  const parsed = new Map(); // rel -> { code, requests: [{ spec, type, rel }] }
  const jsonValues = new Map();
  const bad = new Set();
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const rel = queue[i];
    if (parsed.has(rel) || bad.has(rel)) continue;
    const code = await source(rel);
    let module;
    try { module = new vm.SourceTextModule(code, { identifier: rel }); } catch (err) {
      const line = parseErrorLine(linter, code, rel);
      report({ file: rel, ...(line ? { line } : {}), kind: 'parse', message: `${err.name}: ${err.message}` });
      bad.add(rel);
      continue;
    }
    const requests = [];
    for (const { specifier: spec, attributes } of module.moduleRequests) {
      const line = lineOf(code, code.search(new RegExp(`(['"])${escapeRegExp(spec)}\\1`)));
      const fail = (message) => { report({ file: rel, ...(line ? { line } : {}), kind: 'import', message }); bad.add(rel); };
      if (!SPECIFIER_PATH.test(spec)) { fail(`imports "${spec}", which is not a ./, ../ or / path; there is no import map`); continue; }
      const found = await target(new URL(spec, servedUrl(rel)), rel);
      if (found.error) { fail(`imports "${spec}", but ${found.error}`); continue; }
      const type = attributes?.type;
      if (type === 'json') {
        try { jsonValues.set(found.rel, JSON.parse(await source(found.rel))); } catch (err) { fail(`imports "${spec}" as JSON, which does not parse: ${err.message}`); continue; }
      } else if (type != null) { fail(`imports "${spec}" with type '${type}', which this check does not know`); continue; } else if (!MODULE_FILE.test(found.rel)) {
        fail(`imports "${spec}" as JavaScript; a JSON file needs \`with { type: 'json' }\``); continue;
      }
      requests.push({ spec, type, rel: found.rel });
      if (!type) queue.push(found.rel);
    }
    parsed.set(rel, { code, requests });
  }

  // 2. Link. A graph holding a module already reported is skipped, so the
  // report names each culprit once instead of every file that imports it.
  const closure = (rel, out = new Set()) => {
    if (out.has(rel)) return out;
    out.add(rel);
    for (const r of parsed.get(rel)?.requests ?? []) if (!r.type) closure(r.rel, out);
    return out;
  };
  const clean = (rel) => ![...closure(rel)].some(r => bad.has(r) || !parsed.has(r));
  let context, modules;
  const fresh = () => { context = vm.createContext({}); modules = new Map(); };
  const moduleFor = (rel, type) => {
    const key = type ? `${rel}\0${type}` : rel;
    if (!modules.has(key)) {
      const value = jsonValues.get(rel);
      modules.set(key, type === 'json'
        ? new vm.SyntheticModule(['default'], function init() { this.setExport('default', value); }, { identifier: key, context })
        : new vm.SourceTextModule(parsed.get(rel).code, { identifier: rel, context }));
    }
    return modules.get(key);
  };
  const linker = (spec, referrer, extra) => {
    const type = extra?.attributes?.type;
    const request = parsed.get(referrer.identifier).requests.find(r => r.spec === spec && r.type === type);
    return moduleFor(request.rel, request.type);
  };
  fresh();
  for (const rel of roots) {
    if (!clean(rel)) continue;
    const module = moduleFor(rel);
    if (module.status !== 'unlinked') continue;
    try {
      await module.link(linker);
    } catch (err) {
      // Only modules this link left unlinked can hold the bad import.
      const candidates = [...closure(rel)].filter(r => modules.has(r) && !['linked', 'evaluated'].includes(modules.get(r).status))
        .map(r => ({ rel: r, code: parsed.get(r).code }));
      const site = linkErrorSite(err, candidates) ?? { file: rel };
      report({ ...site, kind: 'link', message: `${err.name}: ${err.message}` });
      bad.add(site.file);
      fresh(); // a failed link leaves its graph half-linked; start over
    }
  }

  // 3. Dynamic imports, module URLs and workers. A classic worker parses its
  // script as a Script, so the browser's own question is whether V8 can
  // compile it as one (import, export, import.meta and top-level await can't).
  const classicFails = new Map();
  const needsModule = (rel) => {
    if (!classicFails.has(rel)) {
      let fails = false;
      try { void new vm.Script(parsed.get(rel).code, { filename: rel }); } catch (err) { fails = err?.name === 'SyntaxError'; }
      classicFails.set(rel, fails);
    }
    return classicFails.get(rel);
  };
  for (const rel of roots) {
    if (rel.startsWith(`${srcDir}/vendor/`)) continue; // generated bundles
    const code = parsed.get(rel)?.code;
    if (!code || !/\bimport\s*\(|\bimport\.meta\b|\bWorker\b|\.register\s*\(|\.addModule\s*\(/.test(code)) continue;
    for (const ref of moduleReferences(linter, code, rel)) {
      const at = { file: rel, line: ref.line, kind: ref.kind };
      if (ref.unfollowed) {
        report({ ...at, message: ref.kind === 'worker'
          ? `${ref.what} with a script URL this check cannot follow; use a string literal or a new URL('….js', import.meta.url) constant`
          : "import() of an expression this check cannot follow; name the target with a string literal or a new URL('….js', import.meta.url) constant" });
        continue;
      }
      if (ref.kind === 'dynamic import' && !SPECIFIER_PATH.test(ref.spec)) {
        report({ ...at, message: `import("${ref.spec}") is not a ./, ../ or / path; there is no import map` });
        continue;
      }
      const url = ref.url ?? new URL(ref.spec, servedUrl(rel));
      if (ref.kind === 'worker' && !ref.checkExists && ref.isModule) continue; // the URL itself was checked as a module URL
      const found = await target(url, rel);
      if (found.error) { if (ref.kind !== 'worker' || ref.checkExists) report({ ...at, message: `${ref.spec ? `"${ref.spec}"` : url.pathname} names a module that cannot load: ${found.error}` }); continue; }
      if (ref.kind === 'dynamic import') {
        // The same rules as a static import: JavaScript unless typed JSON.
        const call = `import("${ref.spec}")`;
        if (ref.unreadable) report({ ...at, message: `${call} has options this check cannot read; write { with: { type: '…' } } literally` });
        else if (ref.type === 'json') {
          try { JSON.parse(await source(found.rel)); } catch (err) { report({ ...at, message: `${call} loads JSON that does not parse: ${err.message}` }); }
        } else if (ref.type != null) report({ ...at, message: `${call} uses type '${ref.type}', which this check does not know` });
        else if (!MODULE_FILE.test(found.rel)) report({ ...at, message: `${call} loads ${found.rel} as JavaScript; a JSON file needs { with: { type: 'json' } }` });
        continue;
      }
      if (ref.kind === 'worker' && !ref.isModule && parsed.has(found.rel) && needsModule(found.rel)) {
        report({ ...at, message: `${ref.what} starts ${found.rel} as a classic script, but it uses import/export; pass { type: 'module' }` });
      }
    }
  }

  // 4. Conflict markers anywhere a merge could leave one, shader strings
  // inside template literals included (those still parse).
  for (const rel of [...all.filter(r => TEXT_FILE.test(r)), 'index.html']) {
    const code = await source(rel);
    if (code == null) continue;
    const lines = code.split(/\r?\n/);
    const at = lines.findIndex(l => CONFLICT_MARKER.test(l));
    if (at >= 0) report({ file: rel, line: at + 1, kind: 'conflict marker', message: `leftover merge conflict marker: ${lines[at].slice(0, 40)}` });
  }

  return { root, modules: files.length, problems };
}

export function formatProblems(problems) {
  return problems.map(p => `${p.file}${p.line ? `:${p.line}` : ''} [${p.kind}] ${p.message}`).join('\n');
}

function invokedDirectly() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const root = args.find(a => !a.startsWith('--')) || process.cwd();
  const result = await checkModuleGraph(root, { tracked: args.includes('--tracked') });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (!result.problems.length) console.log(`module graph: ${result.modules} modules under src/ parse and link`);
  else console.error(`module graph: ${result.problems.length} problem(s) in ${result.modules} modules\n${formatProblems(result.problems)}`);
  process.exitCode = result.problems.length ? 1 : 0;
}
