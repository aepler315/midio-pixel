import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDiscovery } from '../tools/build-view-discovery.mjs';

const html = await fs.readFile(new URL('../src/dev/view-discovery.html', import.meta.url), 'utf8');
class Element {
  constructor(tagName, id = '') {
    this.tagName = tagName.toUpperCase(); this.id = id; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    this.listeners = new Map(); this.attributes = new Map(); this.children = []; this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  set src(value) { this._src = value; this.onSourceAssigned?.(value); }
  get src() { return this._src; }
  append(child) { this.children.push(child); }
  remove() {}
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  click() { return this.listeners.get('click')?.({ target: this }); }
  dispatch(name, extra = {}) { return this.listeners.get(name)?.({ target: this, preventDefault() {}, ...extra }); }
}

function fakeDocument() {
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, new Element(tag, id)]));
  const doc = new Element('document');
  doc.activeElement = null; doc.body = new Element('body');
  doc.getElementById = id => elements.get(id);
  doc.querySelectorAll = selector => selector === 'button' ? [...elements.values()].filter(e => e.tagName === 'BUTTON') : [];
  doc.createElement = tag => new Element(tag);
  return doc;
}
function sourceChanges(element, previous) {
  if (element.src && element.src !== previous) return Promise.resolve(element.src);
  return new Promise(resolve => { element.onSourceAssigned = value => { if (value !== previous) { element.onSourceAssigned = null; resolve(value); } }; });
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1YQAAAAASUVORK5CYII=';
const preview = (id, extra = {}) => ({ status: 'ready', url: `previews/${id}-123456abcdef.json`, encoding: 'png-base64', source: 'Real DEM', appearance: 'landscape-study', ...extra });
const candidate = (id, extra = {}) => ({ id, signature: `sig-${id}`, name: `View ${id}`, region: 'Idaho', kind: 'computed', biome: 'CONIFER', camera: { eye: { lon: -115, lat: 44, aboveGroundM: 150 }, headingDeg: 90, pitchDeg: 0, hfovDeg: 55 }, preview: preview(id), ...extra });
let loadId = 0;
async function withPage(candidates, fn, { storageBroken = false, httpError = false, stored = null, previewFetch = async () => new Response(JSON.stringify({ png })) } = {}) {
  const doc = fakeDocument(), saved = new Map();
  if (stored) saved.set('midio.view-discovery.review.v1', stored);
  const globals = { document: doc, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => { if (storageBroken) throw new Error('Denied'); saved.set(key, value); } }, fetch: async (url, options) => String(url).includes('/previews/') ? previewFetch(url, options) : ({ ok: !httpError, status: httpError ? 404 : 200, json: async () => ({ schema: 'midio.view-discovery', version: 1, candidates }) }) };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const module = await import(`../src/dev/view-discovery/main.js?test=${loadId++}`);
    await module.ready;
    await fn(doc, saved);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}

test('page actions save notes, advance and undo using actual production event handlers', async () => {
  await withPage([candidate('a'), candidate('b')], (doc, saved) => {
    const el = id => doc.getElementById(id);
    assert.equal(el('view-name').textContent, 'View a');
    el('notes').value = 'More open valley'; el('notes').dispatch('input');
    el('keep').click();
    assert.equal(el('view-name').textContent, 'View b');
    const snapshot = JSON.parse([...saved.values()][0]);
    assert.equal(snapshot.decisions[0].note, 'More open valley');
    assert.equal(snapshot.decisions[0].verdict, 'keep');
    assert.equal(snapshot.currentId, 'b');
    el('undo').click();
    assert.equal(el('view-name').textContent, 'View a');
    assert.equal(el('notes').value, 'More open valley');
  });
});

test('reference comparison prevents rating the reference accidentally and resets on navigation', async () => {
  await withPage([candidate('a', { referenceId: 'reference' }), candidate('b'), candidate('reference', { kind: 'reference', provenance: { sourceStatus: 'approved' } })], doc => {
    const el = id => doc.getElementById(id);
    assert.equal(el('compare').hidden, false);
    el('compare').click();
    assert.equal(el('preview-label').textContent, 'Landscape appearance preview');
    assert.equal(el('compare').textContent, 'Return to candidate');
    assert.equal(el('keep').disabled, true);
    doc.dispatch('keydown', { key: 'k', target: doc.body });
    assert.equal(el('view-name').textContent, 'View a');
    doc.dispatch('keydown', { key: 'ArrowRight', target: doc.body });
    assert.equal(el('view-name').textContent, 'View b');
    assert.equal(el('preview-label').textContent, 'Landscape appearance preview');
    assert.equal(el('keep').disabled, false);
  });
});

test('typing in notes does not trigger keyboard reviews and broken storage remains visibly exportable', async () => {
  await withPage([candidate('a'), candidate('b')], doc => {
    const el = id => doc.getElementById(id);
    doc.dispatch('keydown', { key: 'k', target: el('notes') });
    assert.equal(el('view-name').textContent, 'View a');
    assert.match(el('storage-state').textContent, /unavailable.*Export/);
    assert.equal(el('storage-state').classes.has('unsaved'), true);
    assert.equal(el('export').disabled, false);
  }, { storageBroken: true });
});

test('unavailable previews and failed catalog requests provide visible recovery messages', async () => {
  await withPage([candidate('a', { camera: null, preview: { status: 'unavailable', warning: 'Terrain fetch failed' } })], doc => {
    const el = id => doc.getElementById(id);
    assert.equal(el('view-name').textContent, 'View a');
    assert.match(el('preview-message').textContent, /Preview unavailable/);
    assert.equal(el('preview-warning').textContent, 'Terrain fetch failed');
    assert.equal(el('keep').disabled, false);
  });
  await withPage([], doc => {
    assert.equal(doc.getElementById('view-name').textContent, 'The collection is unavailable.');
    assert.match(doc.getElementById('preview-message').textContent, /404/);
    assert.equal(doc.getElementById('keep').disabled, true);
  }, { httpError: true });
});

test('coarse camera adaptation is concise information while actual coverage warnings remain prominent', async () => {
  const adaptation = 'Saved above-ground height is reapplied to the coarse terrain; original camera height is retained in provenance.';
  await withPage([candidate('a', { preview: preview('a', { cellM: 250, source: 'Long source attribution', warning: adaptation }) }), candidate('b', { preview: preview('b', { warning: `${adaptation} Terrain coverage is incomplete.` }) })], doc => {
    const el = id => doc.getElementById(id);
    assert.match(el('preview-detail').textContent, /^Current landscape colors and lighting/);
    assert.doesNotMatch(el('preview-detail').textContent, /Long source attribution/);
    assert.equal(el('preview-warning').classes.has('informational'), true);
    assert.match(el('preview-warning').textContent, /Camera follows the coarse ground/);
    el('next').click();
    assert.equal(el('preview-warning').classes.has('informational'), false);
    assert.match(el('preview-warning').textContent, /Terrain coverage is incomplete/);
  });
});

test('late preview requests cannot replace the currently selected image', async () => {
  let releaseA;
  const secondPng = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from([0])]).toString('base64');
  await withPage([candidate('a'), candidate('b')], async doc => {
    const el = id => doc.getElementById(id), oldLoad = el('preview').onload;
    el('next').click();
    oldLoad();
    assert.equal(el('preview').hidden, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el('preview').src, `data:image/png;base64,${secondPng}`);
    releaseA(new Response(JSON.stringify({ png })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el('preview').src, `data:image/png;base64,${secondPng}`);
    assert.equal(el('view-name').textContent, 'View b');
  }, { previewFetch: url => String(url).includes('/a-') ? new Promise(resolve => { releaseA = resolve; }) : Promise.resolve(new Response(JSON.stringify({ png: secondPng }))) });
});

test('invalid preview records show a load failure without assigning an unsafe data URL', async () => {
  await withPage([candidate('a')], async doc => {
    await new Promise(resolve => setImmediate(resolve));
    assert.match(doc.getElementById('preview-message').textContent, /could not load/);
    assert.equal(doc.getElementById('preview').src, undefined);
    assert.equal(doc.getElementById('keep').disabled, false);
  }, { previewFetch: async () => new Response(JSON.stringify({ png: btoa('<svg/>') })) });
});

test('specific mountain names are visible beside broadly named ranges', async () => {
  await withPage([candidate('a', { name: 'Cascade Range · saved view 1', landmark: 'Mount Rainier' })], doc => {
    assert.match(doc.getElementById('view-region').textContent, /Mount Rainier/);
  });
});

test('appearance and shape controls change the active image and reference consistently without changing candidate', async () => {
  const requests = [];
  const primary = candidate('a', { referenceId: 'reference', preview: preview('a', { shape: preview('a-shape', { appearance: 'terrain-only' }) }) });
  const reference = candidate('reference', { kind: 'reference', provenance: { sourceStatus: 'approved' }, preview: preview('reference', { shape: preview('reference-shape', { appearance: 'terrain-only' }) }) });
  await withPage([primary, reference], async (doc, saved) => {
    const el = id => doc.getElementById(id);
    assert.equal(el('mode-landscape').attributes.get('aria-pressed'), 'true');
    assert.equal(el('preview-label').textContent, 'Landscape appearance preview');
    el('mode-shape').click();
    assert.equal(el('view-name').textContent, 'View a');
    assert.equal(el('preview-label').textContent, 'Terrain shape');
    assert.equal(JSON.parse([...saved.values()][0]).displayMode, 'shape');
    el('compare').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(requests.some(url => url.includes('a-shape-')));
    assert.ok(requests.some(url => url.includes('reference-shape-')));
    el('mode-landscape').click();
    assert.equal(el('view-name').textContent, 'View a');
    assert.equal(el('preview-label').textContent, 'Landscape appearance preview');
  }, { previewFetch: async url => { requests.push(String(url)); return new Response(JSON.stringify({ png })); } });
});

test('restoring an updated appearance catalog visibly reports outdated ratings and retains their notes in exports', async () => {
  const stored = JSON.stringify({ schema: 'midio.view-discovery-review', version: 1, decisions: [{ id: 'a', signature: 'old-neutral-preview', verdict: 'keep', note: 'Old note' }] });
  await withPage([candidate('a')], (doc, saved) => {
    assert.match(doc.getElementById('announcement').textContent, /1 outdated/);
    assert.equal(doc.getElementById('verdict').hidden, true);
    assert.equal(JSON.parse([...saved.values()][0]).outdatedDecisions[0].note, 'Old note');
  }, { stored });
});

test('the actual generator record and PNG files display as landscape appearance and terrain shape', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'view-discovery-ui-contract-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  await buildDiscovery({ candidates: [candidate('contract', { sourceRangeId: 'contract', provenance: {} })], out,
    loadGrid: async () => ({ west: -116, south: 43, east: -114, north: 45, width: 2, height: 2, heightsM: new Float32Array([100, 100, 100, 100]), cellM: 250, source: 'fixture terrain', zoom: 9, tileHashes: [] }),
    styleFor: () => ({ style: { fixture: true }, provenance: { source: 'fixture style' } }),
    render: (grid, camera, options) => ({ width: 1, height: 1, rgba: new Uint8Array([options.style ? 180 : 80, 90, 100, 255]), coverage: 1 }), log: () => {},
  });
  const catalog = JSON.parse(await fs.readFile(path.join(out, 'catalog.json'), 'utf8'));
  await withPage(catalog.candidates, async doc => {
    const el = id => doc.getElementById(id);
    assert.equal(el('preview-label').textContent, 'Landscape appearance preview');
    await sourceChanges(el('preview'));
    assert.match(el('preview').src, /^data:image\/png;base64,/);
    const appearance = el('preview').src;
    el('mode-shape').click();
    assert.equal(el('preview-label').textContent, 'Terrain shape');
    await sourceChanges(el('preview'), appearance);
    assert.match(el('preview').src, /^data:image\/png;base64,/);
    assert.notEqual(el('preview').src, appearance);
  }, { previewFetch: async url => new Response(await fs.readFile(path.join(out, 'previews', path.basename(new URL(url).pathname)))) });
});

test('region labels show the current material biome rather than the legacy range category', async () => {
  await withPage([candidate('a', { biome: 'DESERT', provenance: { style: { sourceBiome: 'DESERT', styleBiome: 'CANYON' } } })], doc => {
    const label = doc.getElementById('view-region').textContent;
    assert.match(label, /canyon/);
    assert.doesNotMatch(label, /desert/);
  });
});
