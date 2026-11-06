import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodePng } from '../tools/lib/view-discovery.mjs';
import { ReviewSession, PreviewCache, parseReview, previewUrl, previewForMode, validateCatalog, candidateKindLabel, MAX_REVIEW_BYTES, MAX_PREVIEW_BYTES } from '../src/dev/view-discovery/review-state.js';

const candidate = (id, extra = {}) => ({ id, signature: `sig-${id}`, kind: 'computed', name: `View ${id}`, region: id === 'c' ? 'Colorado' : 'Idaho', biome: 'CONIFER', camera: { eye: { lon: -115, lat: 44, aboveGroundM: 150 }, headingDeg: 90, pitchDeg: 0, hfovDeg: 55 }, preview: { status: 'ready', url: `previews/${id}-123456abcdef.json`, encoding: 'png-base64' }, ...extra });
const catalog = (views = ['a', 'b', 'c'].map(id => candidate(id))) => ({ schema: 'midio.view-discovery', version: 1, candidates: views });

test('reviewing an unreviewed queue advances without skipping when the current item disappears', () => {
  const s = new ReviewSession(catalog());
  assert.equal(s.current.id, 'a');
  s.decide('keep');
  assert.equal(s.current.id, 'b');
  s.decide('maybe');
  assert.equal(s.current.id, 'c');
  s.decide('pass');
  assert.equal(s.current, null);
  assert.deepEqual(s.counts, { total: 3, reviewed: 3, keep: 1, maybe: 1, pass: 1 });
  s.undo();
  assert.equal(s.current.id, 'c');
  assert.equal(s.decision('c'), null);
});

test('filters preserve the selected candidate where possible, and forward/back respects boundaries', () => {
  const s = new ReviewSession(catalog());
  s.move(1);
  s.filter({ region: 'Idaho' });
  assert.equal(s.current.id, 'b');
  s.move(1);
  assert.equal(s.current.id, 'b');
  s.move(-1);
  assert.equal(s.current.id, 'a');
  s.filter({ search: 'view c', region: '' });
  assert.equal(s.current.id, 'c');
  s.filter({ search: 'absent' });
  assert.equal(s.current, null);
});

test('place search finds specific mountains inside broadly named ranges and authored view ids', () => {
  const s = new ReviewSession(catalog([candidate('a', { name: 'Cascade Range · saved view 1', landmark: 'Mount Rainier', sourceRangeId: 'rainier' }), candidate('b', { name: 'Eastern Sierra', sourceViewId: 'sierra-whitney-east' })]));
  s.filter({ search: 'Rainier' });
  assert.equal(s.current.id, 'a');
  s.filter({ search: 'whitney' });
  assert.equal(s.current.id, 'b');
});

test('resume retains exact candidate, filter and notes, while changed signatures lose stale ratings', () => {
  const s = new ReviewSession(catalog());
  s.note('A useful foreground');
  s.decide('keep');
  s.move(1);
  s.note('Try a lower camera');
  const restored = new ReviewSession(catalog(), JSON.stringify(s.snapshot()));
  assert.equal(restored.current.id, 'c');
  assert.equal(restored.decision('a').note, 'A useful foreground');
  assert.equal(restored.decision('c').note, 'Try a lower camera');
  const changed = new ReviewSession(catalog([candidate('a', { signature: 'new-camera' }), candidate('b'), candidate('c')]), JSON.stringify(s.snapshot()));
  assert.equal(changed.decision('a'), null);
  assert.equal(changed.counts.keep, 0);
});

test('imports reject invalid envelopes and bound file sizes and notes without trusting unknown ids or prototypes', () => {
  assert.throws(() => parseReview('x'.repeat(MAX_REVIEW_BYTES + 1)), /large/);
  assert.throws(() => parseReview('{'), /JSON/);
  assert.throws(() => parseReview('{"schema":"something-else","version":1,"decisions":[]}'), /format/);
  const s = new ReviewSession(catalog());
  const result = s.import({ schema: 'midio.view-discovery-review', version: 1, decisions: [
    { id: 'a', signature: 'sig-a', verdict: 'keep', note: 'Works' },
    { id: 'a', signature: 'sig-a', verdict: 'pass', note: '' },
    { id: 'b', signature: 'old', verdict: 'keep', note: '' },
    { id: 'not-here', signature: 'sig-x', verdict: 'pass', note: '' },
    { id: '__proto__', signature: 'sig-x', verdict: 'keep', note: '' },
    { id: 'c', signature: 'sig-c', verdict: 'good', note: '' },
    { id: 'c', signature: 'sig-c', verdict: 'keep', note: 'x'.repeat(2001) },
  ] });
  assert.deepEqual(result, { accepted: 1, ignored: 6, outdated: 1 });
  assert.equal(s.decision('a').verdict, 'keep');
  assert.equal(s.counts.reviewed, 1);
  assert.equal({}.verdict, undefined);
});

test('shortlist exports exact candidate cameras and provenance without making production approvals', () => {
  const source = candidate('a', { provenance: { source: 'Terrarium' } });
  const s = new ReviewSession(catalog([source, candidate('b')]));
  s.decide('keep');
  s.decide('maybe');
  const out = s.shortlist();
  assert.equal(out.schema, 'midio.view-discovery-shortlist');
  assert.equal(out.candidates.length, 2);
  assert.deepEqual(out.candidates[0].camera, source.camera);
  assert.deepEqual(out.candidates[0].provenance, source.provenance);
  assert.equal(out.candidates[0].review.verdict, 'keep');
  assert.equal(Object.hasOwn(out.candidates[0], 'approved'), false);
});

test('importing a portable review resumes its selected view and filters in another browser', () => {
  const source = new ReviewSession(catalog());
  source.decide('keep');
  source.filter({ status: 'all', region: 'Idaho', search: 'View' });
  assert.equal(source.current.id, 'b');
  const destination = new ReviewSession(catalog());
  destination.import(JSON.stringify(source.snapshot()));
  assert.equal(destination.current.id, 'b');
  assert.deepEqual(destination.filters, source.filters);
  destination.import({ ...source.snapshot(), currentId: 'missing', filters: { status: 'all', region: 'missing' } });
  assert.equal(destination.filters.region, '');
  assert.ok(destination.current);
});

test('a full 642-view review with maximum-length multibyte notes remains portable', () => {
  const views = Array.from({ length: 642 }, (_, i) => candidate(`view-${i}`));
  const s = new ReviewSession(catalog(views));
  s.import({ schema: 'midio.view-discovery-review', version: 1, decisions: views.map(c => ({ id: c.id, signature: c.signature, verdict: 'keep', note: '景'.repeat(2000) })) });
  const exported = `${JSON.stringify(s.snapshot(), null, 2)}\n`;
  assert.ok(new TextEncoder().encode(exported).length > 2 * 1024 * 1024);
  const resumed = new ReviewSession(catalog(views), exported);
  assert.equal(resumed.restoreWarning, '');
  assert.equal(resumed.counts.keep, 642);
  assert.equal(resumed.decision('view-641').note, '景'.repeat(2000));
});

test('appearance is the default and display preference survives reloads and portable import without moving the queue', () => {
  const s = new ReviewSession(catalog());
  assert.equal(s.displayMode, 'landscape');
  s.move(1); s.setDisplayMode('shape');
  assert.equal(s.current.id, 'b');
  const restored = new ReviewSession(catalog(), JSON.stringify(s.snapshot()));
  assert.equal(restored.displayMode, 'shape');
  const imported = new ReviewSession(catalog()); imported.import(s.snapshot());
  assert.equal(imported.displayMode, 'shape');
  imported.setDisplayMode('invented');
  assert.equal(imported.displayMode, 'shape');
});

test('changed-preview decisions are counted and retained as inactive export backups while matching reviews survive', () => {
  const s = new ReviewSession(catalog());
  s.note('Keep this old note'); s.decide('keep'); s.decide('maybe');
  const changed = catalog([candidate('a', { signature: 'appearance-v2' }), candidate('b'), candidate('c')]);
  const resumed = new ReviewSession(changed, JSON.stringify(s.snapshot()));
  assert.equal(resumed.restoreReport.outdated, 1);
  assert.equal(resumed.decision('a'), null);
  assert.equal(resumed.decision('b').verdict, 'maybe');
  assert.equal(resumed.snapshot().outdatedDecisions[0].note, 'Keep this old note');
  assert.equal(resumed.shortlist().candidates.length, 1);
  const again = new ReviewSession(changed, JSON.stringify(resumed.snapshot()));
  assert.equal(again.snapshot().outdatedDecisions[0].signature, 'sig-a');
  assert.equal(again.restoreReport.outdated, 0);
});

test('appearance and terrain-shape selection use distinct records without disguising a missing shape image', () => {
  const c = candidate('a');
  c.preview.appearance = 'landscape-study';
  c.preview.shape = { status: 'ready', url: 'previews/a-shape-123456abcdef.json', encoding: 'png-base64' };
  assert.equal(previewForMode(c, 'landscape'), c.preview);
  assert.equal(previewForMode(c, 'shape'), c.preview.shape);
  assert.equal(previewForMode(candidate('b'), 'shape'), null);
});

test('preview paths stay within the catalog previews directory and only permit local encoded PNG records', () => {
  const base = 'https://example.test/midio/src/assets/view-discovery/catalog.json';
  assert.equal(previewUrl(candidate('a'), base), 'https://example.test/midio/src/assets/view-discovery/previews/a-123456abcdef.json');
  for (const url of ['javascript:alert(1)', 'https://elsewhere.test/x.json', '/previews/a.json', '../a.json', 'previews/../../a.json', 'previews/%2e%2e/a.json', 'previews/a.svg', 'previews/a.png', 'previews/a-123456abcdef.json?x=1']) {
    assert.equal(previewUrl(candidate('a', { preview: { status: 'ready', url, encoding: 'png-base64' } }), base), null, url);
  }
  assert.equal(previewUrl(candidate('a', { preview: { status: 'unavailable' } }), base), null);
});

const pixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1YQAAAAASUVORK5CYII=';
test('preview loader validates bounded PNG data and caches at most the configured number of decoded URLs', async () => {
  let fetches = 0;
  const cache = new PreviewCache({ maxEntries: 2, fetchImpl: async () => { fetches++; return new Response(JSON.stringify({ png: pixelPng })); } });
  assert.equal(await cache.load('a', { width: 1, height: 1 }), `data:image/png;base64,${pixelPng}`);
  await cache.load('a', { width: 1, height: 1 });
  assert.equal(fetches, 1);
  await cache.load('b'); await cache.load('c');
  assert.equal(cache.size, 2);
  await cache.load('a', { width: 1, height: 1 });
  assert.equal(fetches, 4);
});

test('default preview fetch preserves the browser global receiver', async () => {
  const original = globalThis.fetch;
  let receiver;
  globalThis.fetch = function () {
    receiver = this;
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(new Response(JSON.stringify({ png: pixelPng })));
  };
  try {
    const cache = new PreviewCache();
    assert.equal(await cache.load('a'), `data:image/png;base64,${pixelPng}`);
    assert.equal(receiver, globalThis);
  } finally { globalThis.fetch = original; }
});

test('preview integrity rejects a different valid PNG and never reuses a cache entry for another digest', async () => {
  const actual = encodePng(1, 1, new Uint8Array([20, 30, 40, 255]));
  const other = encodePng(1, 1, new Uint8Array([100, 120, 140, 255]));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let fetches = 0;
  const cache = new PreviewCache({ fetchImpl: async () => { fetches++; return new Response(JSON.stringify({ png: actual.toString('base64') })); } });
  await cache.load('same-url', { width: 1, height: 1, sha256: hash(actual) });
  await assert.rejects(cache.load('same-url', { width: 1, height: 1, sha256: hash(other) }), /hash/i);
  assert.equal(fetches, 2);
  await assert.rejects(cache.load('elsewhere', { sha256: 'not-a-hash' }), /hash/i);
  assert.equal(fetches, 2);
});

test('preview loader rejects oversized streams, invalid image content and incorrect declared dimensions', async () => {
  for (const body of [JSON.stringify({ png: '<svg/onload=alert(1)>' }), JSON.stringify({ png: btoa('<svg/>') }), JSON.stringify({ png: 'AAAA' }), 'x'.repeat(MAX_PREVIEW_BYTES + 1)]) {
    const cache = new PreviewCache({ fetchImpl: async () => new Response(body) });
    await assert.rejects(cache.load('a'), /preview|PNG/i);
  }
  const cache = new PreviewCache({ fetchImpl: async () => new Response(JSON.stringify({ png: pixelPng })) });
  await assert.rejects(cache.load('a', { width: 320, height: 180 }), /dimensions/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(cache.load('a', { signal: cancelled.signal }), /abort/i);
});

test('catalog validation rejects duplicate ids, malformed cameras and unsupported schema', () => {
  assert.equal(validateCatalog(catalog()).length, 3);
  assert.throws(() => validateCatalog(catalog([candidate('a'), candidate('a')])), /duplicate/);
  assert.throws(() => validateCatalog(catalog([candidate('a', { camera: { eye: { lon: Infinity, lat: 44 } } })])), /camera/);
  assert.throws(() => validateCatalog({ schema: 'wrong', version: 1, candidates: [] }), /catalog/);
  assert.equal(validateCatalog(catalog([candidate('a', { camera: null, preview: { status: 'unavailable' } })])).length, 1);
});

test('historical and unpublished authored candidates are distinguished from existing scenes', () => {
  assert.equal(candidateKindLabel(candidate('a', { kind: 'explore', sourceViewId: 'old-authoring', provenance: { sourceStatus: 'rejected' } })), 'Historical candidate');
  assert.equal(candidateKindLabel(candidate('a', { kind: 'reference', provenance: { sourceStatus: 'rejected' } })), 'Historical candidate');
  assert.equal(candidateKindLabel(candidate('a', { kind: 'reference', provenance: { sourceStatus: 'candidate' } })), 'Authored candidate');
  assert.equal(candidateKindLabel(candidate('a', { kind: 'reference', provenance: { sourceStatus: 'candidate', sourceExperimental: true } })), 'Existing scene reference');
  assert.equal(candidateKindLabel(candidate('a', { kind: 'reference', provenance: { sourceStatus: 'approved' } })), 'Existing scene reference');
  assert.equal(candidateKindLabel(candidate('a', { kind: 'explore' })), 'Broad exploration');
});
