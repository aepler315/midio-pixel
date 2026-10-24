import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .gitattributes keeps every checkout LF. A clone made before that rule
// existed still holds CRLF working files until it is refreshed once, and
// then fails in confusing ways: pinned Range/vendor hashes mismatch and
// tests that slice src/main.js by '\n' find nothing. This names the cause.
const root = fileURLToPath(new URL('..', import.meta.url));
const REFRESH = 'CRLF checkout: refresh it once from a clean tree (see AGENTS.md, line endings)';

function filesUnder(dir, keep) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

function withCarriageReturns(files) {
  return files.filter((rel) => fs.readFileSync(path.join(root, rel)).includes(0x0d));
}

test('pinned Range v2 JSON and vendored runtime bytes carry no CR', () => {
  const files = [
    ...filesUnder('src/assets/range/v2', (rel) => rel.endsWith('.json')),
    ...filesUnder('src/vendor/range', () => true),
  ];
  assert.ok(files.length > 0);
  assert.deepEqual(withCarriageReturns(files), [], REFRESH);
});

test('source that tests slice by newline is checked out with LF', () => {
  assert.deepEqual(withCarriageReturns(['src/main.js', 'index.html']), [], REFRESH);
});
