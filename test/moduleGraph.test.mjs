// Every module the browser can load from src/ must parse and link. The #70
// merge kept both sides of an import conflict in RangeScene.js, so
// `ACTOR_IDS` was declared twice and Landscape died with "Could not prepare
// the landscape: runtime-unavailable: Identifier 'ACTOR_IDS' has already been
// declared". tools/module-graph-check.mjs catches that whole class with
// V8's own parser and linker; vm.SourceTextModule needs a flag, so it runs in
// a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECKER = path.join(ROOT, 'tools', 'module-graph-check.mjs');

function check(root, ...flags) {
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', CHECKER, '--json', ...flags, root],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 << 20 });
  assert.ok(run.stdout, `checker printed nothing (status ${run.status}):\n${run.stderr}`);
  return { status: run.status, ...JSON.parse(run.stdout) };
}

const describe = (problems) => problems.map(p => `${p.file}${p.line ? `:${p.line}` : ''} [${p.kind}] ${p.message}`).join('\n');
const sites = (result) => result.problems.map(p => `${p.file}:${p.line ?? '-'} ${p.kind}`).sort();

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'module graph '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [rel, code] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), code);
  }
  return root;
}

const ACTORS = 'export const ACTOR_IDS = [];\nexport const ACTOR_HUES = [];\nexport const ACTOR_NOTE_AGE_CAP_MS = 1;\n';

test('every module under src/ parses and links the way the browser loads it', () => {
  const result = check(ROOT);
  assert.deepEqual(result.problems, [], `modules that cannot load in the browser:\n${describe(result.problems)}`);
  assert.equal(result.status, 0);
  assert.ok(result.modules > 400, `walked only ${result.modules} modules`);
});

test('the module-graph check catches each way a module fails to load', async (t) => {
  const root = await fixture(t, {
    'index.html': '<script type="module" src="./src/scene.js"></script>\n',
    'src/actors.js': ACTORS,
    'src/data.json': '{"ok": true}\n',
    'src/broken.json': '{"ok": tru\n',
    // The #70 shape: both sides of the conflict kept.
    'src/scene.js': [
      "import { ACTOR_IDS, ACTOR_HUES } from './actors.js';",
      "import { ACTOR_IDS, ACTOR_HUES, ACTOR_NOTE_AGE_CAP_MS } from './actors.js';",
      'export const n = ACTOR_IDS.length + ACTOR_HUES.length + ACTOR_NOTE_AGE_CAP_MS;',
    ].join('\n'),
    // Importers of a module that does not parse report nothing of their own.
    'src/uses-scene.js': "import { n } from './scene.js';\nexport default n;\n",
    'src/missing-export.js': "// header\nimport { ACTOR_LOOK } from './actors.js';\nexport default ACTOR_LOOK;\n",
    // Imports the same module and mentions the same name, but is not at fault.
    'src/innocent.js': "import { ACTOR_IDS } from './actors.js';\nexport const ACTOR_LOOK = ACTOR_IDS;\n",
    // Two bad imports in one graph are both reported in one run.
    'src/sibling-a.js': "import { ACTOR_A } from './actors.js';\nexport default ACTOR_A;\n",
    'src/sibling-b.js': "import { ACTOR_B } from './actors.js';\nexport default ACTOR_B;\n",
    'src/both.js': "import a from './sibling-a.js';\nimport b from './sibling-b.js';\nexport default [a, b];\n",
    // In one graph, the error is pinned on the import that names the export,
    // not on a neighbour that merely mentions the name.
    'src/mixed.js': "import './neighbour.js';\nimport './culprit.js';\n",
    'src/neighbour.js': "import { ACTOR_IDS } from './actors.js';\nexport const ACTOR_GONE = ACTOR_IDS;\n",
    'src/culprit.js': "\n\nimport { ACTOR_HUES,\n  ACTOR_GONE } from './actors.js';\nexport default [ACTOR_HUES, ACTOR_GONE];\n",
    'src/no-default.js': "import actors from './actors.js';\nexport default actors;\n",
    // A missing dependency is blamed on its importer only, not on the
    // files that import the importer.
    'src/shared.js': "import gone from './gone.js';\nexport default gone;\n",
    'src/uses-shared-1.js': "import s from './shared.js';\nexport default s;\n",
    'src/uses-shared-2.js': "import s from './shared.js';\nexport default s;\n",
    'src/wrong-case.js': "import { ACTOR_IDS } from './Actors.js';\nexport default ACTOR_IDS;\n",
    'src/bare.js': "import * as THREE from 'three';\nexport default THREE;\n",
    'src/outside.js': "import x from '../tools/helper.js';\nexport default x;\n",
    'tools/helper.js': 'export default 1;\n',
    'src/json-ok.js': "import data from './data.json' with { type: 'json' };\nexport default data;\n",
    'src/json-bad.js': "import data from './broken.json' with { type: 'json' };\nexport default data;\n",
    'src/json-untyped.js': "import data from './data.json';\nexport default data;\n",
    'src/markers.js': '<<<<<<< ours\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> theirs\n',
    // Still parses: the markers sit inside a shader string.
    'src/shader.js': 'export const FRAG = `\nvoid main() {\n<<<<<<< ours\n  gl_FragColor = vec4(1.0);\n=======\n  gl_FragColor = vec4(0.0);\n>>>>>>> theirs\n}`;\n',
    'src/dynamic.js': [
      "/** @param {import('./not-here.js').Thing} thing  (a type, not a load) */",
      "export const ok = () => import('./actors.js');",
      "export const gone = () => import('./gone.js');",
      "// export const old = () => import('./also-gone.js');",
      "export const bare = () => import('three');",
      'export const unknown = (name) => import(name);',
      "const SCENE_URL = new URL('./actors.js', import.meta.url).href;",
      "const LOST_URL = new URL('./lost.js', import.meta.url).href;",
      "const retry = (url, n) => (n ? `${url}?retry=${n}` : url);",
      'export const followed = (n) => import(retry(SCENE_URL, n));',
      'export const lost = (n) => import(retry(LOST_URL, n));',
    ].join('\n'),
    'src/worker.js': "import { ACTOR_IDS } from './actors.js';\nself.onmessage = () => postMessage(ACTOR_IDS);\n",
    // Module-only syntax that a line-start regex would miss.
    'src/banner-worker.js': '/* banner */ export const x = 1;\nself.onmessage = () => postMessage(x);\n',
    'src/classic-worker.js': 'self.onmessage = () => postMessage(1);\n',
    'src/worker-consts.js': [
      "const SCRIPT = '/src/worker.js';",
      "const GONE = '/src/gone-worker.js';",
      "const CLASSIC = '/src/classic-worker.js';",
      "export const a = () => new Worker(SCRIPT, { type: 'module' });",
      'export const b = () => new Worker(GONE);',
      'export const c = () => new Worker(CLASSIC);',
      "export const d = () => new Worker(new URL('./banner-worker.js', import.meta.url));",
      'export const e = (pick) => new Worker(pick());',
    ].join('\n'),
    // A page: its module script must exist, and an inline module is checked
    // like a file, with lines counted in the page.
    'src/page.html': [
      '<!doctype html>',
      '<script type="module" src="./missing-entry.js"></script>',
      '<script type="module">',
      "  import { ACTOR_IDS } from './actors.js';",
      "  import { ACTOR_NOPE } from './actors.js';",
      '</script>',
      '<script>console.log("classic, not checked")</script>',
    ].join('\n'),
    // Dev pages run under tool servers that serve the whole checkout.
    'src/dev/review.html': "<script type=\"module\">\n  import x from '../../tools/helper.js';\n  console.log(x);\n</script>\n",
    // The versions site's index.html: its ./src/ paths start at the root.
    'src/ui/history-shell.html': '<script type="module" src="./src/ui/picker.js"></script>\n',
    'src/worker-client.js': [
      "export const good = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
      "export const bad = () => new Worker(new URL('./no-worker.js', import.meta.url), { type: 'module' });",
      "export const data = new URL('./config/absent.json', import.meta.url);",
      "export const classic = () => new Worker(new URL('./worker.js', import.meta.url));",
      "export const busted = (v) => new Worker(new URL(`./missing-worker.js?v=${v}`, import.meta.url), { type: 'module' });",
      "export const docRelative = () => new Worker('src/nowhere.js', { type: 'module' });",
      "const HERE = new URL('./', import.meta.url);",
      "export const viaBase = () => new SharedWorker(new URL('worker.js', HERE), { type: 'module' });",
    ].join('\n'),
    // Served from the site root (tools/stage-history.mjs), so ./src/ is right.
    'src/ui/history-worker.js': "import { ACTOR_IDS } from './src/actors.js';\nexport default ACTOR_IDS;\n",
    'src/ui/picker.js': [
      "const root = new URL('../../', import.meta.url);",
      "export const ok = (sha) => navigator.serviceWorker.register(new URL(`history-worker.js?build=${sha}`, root), { type: 'module' });",
      "export const wrong = () => navigator.serviceWorker.register(new URL('./history-worker.js', import.meta.url), { type: 'module' });",
    ].join('\n'),
  });

  const result = check(root);
  assert.equal(result.status, 1);
  assert.deepEqual(sites(result), [
    'src/bare.js:1 import',
    'src/culprit.js:3 link',
    'src/dynamic.js:3 dynamic import',
    'src/dynamic.js:5 dynamic import',
    'src/dynamic.js:6 dynamic import',
    'src/dynamic.js:8 module URL',
    'src/json-bad.js:1 import',
    'src/json-untyped.js:1 import',
    'src/markers.js:1 conflict marker',
    'src/markers.js:1 parse',
    'src/missing-export.js:2 link',
    'src/no-default.js:1 link',
    'src/outside.js:1 import',
    'src/page.html:2 html',
    'src/page.html:5 link',
    'src/scene.js:2 parse',
    'src/shader.js:3 conflict marker',
    'src/shared.js:1 import',
    'src/sibling-a.js:1 link',
    'src/sibling-b.js:1 link',
    'src/ui/picker.js:3 module URL',
    'src/worker-client.js:2 module URL',
    'src/worker-client.js:4 worker',
    'src/worker-client.js:5 module URL',
    'src/worker-client.js:6 worker',
    'src/worker-consts.js:5 worker',
    'src/worker-consts.js:7 worker',
    'src/worker-consts.js:8 worker',
    'src/wrong-case.js:1 import',
  ], describe(result.problems));
  const message = (file, kind) => result.problems.find(p => p.file === file && (!kind || p.kind === kind)).message;
  assert.equal(message('src/scene.js'), "SyntaxError: Identifier 'ACTOR_IDS' has already been declared");
  assert.match(message('src/missing-export.js'), /does not provide an export named 'ACTOR_LOOK'/);
  assert.match(message('src/culprit.js'), /does not provide an export named 'ACTOR_GONE'/);
  assert.match(message('src/no-default.js'), /does not provide an export named 'default'/);
  assert.match(message('src/wrong-case.js'), /src\/Actors\.js does not exist/);
  assert.match(message('src/bare.js'), /"three".*import map/);
  assert.match(message('src/outside.js'), /outside src\//);
  assert.match(message('src/worker-client.js', 'worker'), /classic script.*type: 'module'/);
  assert.match(message('src/ui/picker.js'), /served at \/history-worker\.js/);
  assert.match(message('src/json-untyped.js'), /type: 'json'/);
  assert.match(message('src/page.html', 'html'), /missing-entry\.js.*does not exist/);
  assert.match(message('src/page.html', 'link'), /does not provide an export named 'ACTOR_NOPE'/);
  const worker = (line) => result.problems.find(p => p.file === 'src/worker-consts.js' && p.line === line).message;
  assert.match(worker(5), /src\/gone-worker\.js does not exist/);
  assert.match(worker(7), /starts src\/banner-worker\.js as a classic script/);
  assert.match(worker(8), /cannot follow/);
});

test('the module-graph check can require every module to be tracked by git', async (t) => {
  const root = await fixture(t, {
    'src/main.js': "import { ACTOR_IDS } from './actors.js';\nexport default ACTOR_IDS;\n",
    'src/actors.js': ACTORS,
  });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } });
  git('init', '-q');
  git('add', 'src/main.js');
  assert.deepEqual(check(root).problems, [], 'without --tracked the working tree is what counts');
  const tracked = check(root, '--tracked');
  assert.deepEqual(sites(tracked), ['src/main.js:1 import'], describe(tracked.problems));
  assert.match(tracked.problems[0].message, /src\/actors\.js is not tracked by git/);
  git('add', 'src/actors.js');
  assert.deepEqual(check(root, '--tracked').problems, []);
});

test('the module-graph check knows where the history worker and shell are served from', async () => {
  // tools/module-graph-check.mjs SERVED_AT resolves the history worker's and
  // shell's imports from the site root, where tools/stage-history.mjs copies
  // them. If those copies move, update SERVED_AT with them.
  const stage = await fs.readFile(path.join(ROOT, 'tools', 'stage-history.mjs'), 'utf8');
  assert.match(stage, /'src\/ui\/history-worker\.js'\),\s*path\.join\(staged, 'history-worker\.js'\)/);
  assert.match(stage, /'src\/ui\/history-shell\.html'\),\s*path\.join\(staged, 'index\.html'\)/);
});
