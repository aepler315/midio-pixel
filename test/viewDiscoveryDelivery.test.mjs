import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodePng } from '../tools/lib/terrarium.mjs';
import { validateCatalog, previewUrl } from '../src/dev/view-discovery/review-state.js';

const root = new URL('../', import.meta.url);
const assetRoot = new URL('src/assets/view-discovery/', root);

test('the shipped review queue loads with every preview and reference reachable', async () => {
  const catalog = JSON.parse(await fs.readFile(new URL('catalog.json', assetRoot), 'utf8'));
  const candidates = validateCatalog(catalog);
  const ids = new Set(candidates.map(c => c.id));
  const ready = candidates.filter(c => c.preview.status === 'ready');
  assert.equal(ready.length, catalog.generatedWith.ready);
  assert.ok(candidates.some(c => c.kind === 'reference'));
  assert.ok(new Set(candidates.filter(c => c.kind !== 'reference').map(c => c.sourceRangeId)).size >= 88);
  for (const c of candidates) {
    if (c.referenceId) assert.ok(ids.has(c.referenceId), `${c.id} reference exists`);
    assert.match(c.signature, /^[a-f0-9]{64}$/);
    if (c.preview.status !== 'ready') {
      assert.ok(c.preview.warning, `${c.id} explains its unavailable preview`);
      continue;
    }
    assert.equal(c.preview.appearance, 'landscape-study');
    assert.equal(c.preview.shape?.appearance, 'terrain-only');
    assert.equal(c.preview.coverage, c.preview.shape.coverage);
    for (const preview of [c.preview, c.preview.shape]) {
      assert.ok(previewUrl({ preview }, 'https://example.test/src/assets/view-discovery/catalog.json'));
      const payload = JSON.parse(await fs.readFile(new URL(preview.url, assetRoot), 'utf8'));
      assert.equal(preview.encoding, 'png-base64');
      const bytes = Buffer.from(payload.png, 'base64');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), preview.sha256, `${c.id} binds its image bytes`);
      const image = decodePng(bytes);
      assert.equal(image.width, preview.width);
      assert.equal(image.height, preview.height);
    }
    const style = c.provenance.style;
    assert.equal(style.preset, 'daylight');
    assert.match(style.source, /^src\/assets\/range\/v2\/materials\/[a-z-]+\.json$/);
    const material = await fs.readFile(new URL(style.source, root));
    assert.equal(createHash('sha256').update(material).digest('hex'), style.materialSha256, `${c.id} identifies its production material`);
    assert.ok(c.provenance.terrain.tileHashes.length > 0, `${c.id} records real terrain inputs`);
  }
});

test('the app exposes the reviewer without importing discovery into music playback', async () => {
  const [index, main] = await Promise.all(['index.html', 'src/main.js'].map(p => fs.readFile(new URL(p, root), 'utf8')));
  assert.match(index, /href="\.\/src\/dev\/view-discovery\.html"/);
  assert.doesNotMatch(main, /view-discovery/);
  await fs.access(new URL('src/dev/view-discovery.html', root));
});
