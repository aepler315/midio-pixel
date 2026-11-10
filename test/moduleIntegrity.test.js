// Regression guard for the PR #7 UTF-16 corruption (null-byte garbage) that
// broke the module parse of these files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('modules once corrupted by PR #7 hold no null bytes and read as ES module source', () => {
  for (const rel of [
    'src/core/ParamBus.js',
    'src/render/Renderer.js',
    'src/world/BiomeManager.js',
    'src/main.js',
  ]) {
    const buf = readFileSync(join(root, rel));
    assert.equal(buf.includes(0), false, `${rel} must not contain null bytes`);
    const text = buf.toString('utf8');
    // main.js only imports; the others also export.
    assert.ok(
      text.includes('export ') || text.includes('import '),
      `${rel} should be valid ES module source`,
    );
  }
});
