import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A workflow or npm script that names a deleted tool, test or fixture fails
// only when someone runs it, with a misleading error. pixel.yml ran a test
// deleted weeks earlier and failed every dispatch. Catch that here.
const root = fileURLToPath(new URL('..', import.meta.url));
const PATH = /(?:^|[\s"'=(])((?:tools|test)\/[\w./-]+\.(?:mjs|js|json|ya?ml|sh))(?=$|[\s"')`;,])/g;

function referencedPaths(text) {
  return [...text.matchAll(PATH)].map((m) => m[1]).filter((p) => !p.includes('*'));
}

test('every tools/ and test/ path named by a workflow or npm script exists', () => {
  const sources = { 'package.json': fs.readFileSync(path.join(root, 'package.json'), 'utf8') };
  const workflows = path.join(root, '.github', 'workflows');
  for (const name of fs.readdirSync(workflows).filter((n) => /\.ya?ml$/.test(n))) {
    sources[`.github/workflows/${name}`] = fs.readFileSync(path.join(workflows, name), 'utf8');
  }
  const missing = [];
  let checked = 0;
  for (const [source, text] of Object.entries(sources)) {
    for (const rel of referencedPaths(text)) {
      checked++;
      if (!fs.existsSync(path.join(root, rel))) missing.push(`${source}: ${rel}`);
    }
  }
  assert.ok(checked > 20, `expected to check many paths, checked ${checked}`);
  assert.deepEqual(missing, []);
});

test('the path scanner finds the shapes workflows use', () => {
  assert.deepEqual(referencedPaths('run: node --test test/pixelDepthShader.test.mjs'), ['test/pixelDepthShader.test.mjs']);
  assert.deepEqual(referencedPaths('"lint": "eslint src tools test",'), []);
  assert.deepEqual(referencedPaths('npm run visual:eval -- --manifest test/fixtures/a.json --out .smoke/x'), ['test/fixtures/a.json']);
  assert.deepEqual(referencedPaths('"start": "node tools/serve.js"'), ['tools/serve.js']);
});
