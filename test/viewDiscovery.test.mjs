import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateDiscoveryCandidates, candidateBounds, resolveReferenceCamera, candidateSignature, encodePng, createTileLoader, loadDiscoveryGrid, loadScoutMaterials, resolveScoutMaterial } from '../tools/lib/view-discovery.mjs';
import { buildDiscovery as buildDiscoveryRaw, parseArguments } from '../tools/build-view-discovery.mjs';

const fixtureStyleFor = () => ({ style: { fixture: true }, provenance: { materialId: 'fixture', materialSha256: '0'.repeat(64), preset: 'daylight', method: 'test fixture' } });
const buildDiscovery = options => buildDiscoveryRaw({ styleFor: fixtureStyleFor, ...options });

const ranges = { ranges: [
  { id: 'soft-hills', name: 'Soft Hills', region: 'Test', biome: 'broadleaf', crest: { lon: 0, lat: 45, reliefM: 20 }, summit: { lon: 0, lat: 45, elevationM: 200 }, views: [{ score: 0, eye: { lon: .05, lat: 45, h: 150, agl: 120 }, heading: 270, pitch: 2, hfov: 56 }] },
  { id: 'other-hills', name: 'Other Hills', region: 'Test two', biome: 'conifer', crest: { lon: 2, lat: 46, reliefM: 10 }, summit: { lon: 2, lat: 46, elevationM: 150 }, views: [] },
] };
const authored = { views: [{ id: 'example', title: 'Example', place: 'Somewhere', biome: 'BROADLEAF', status: 'approved', rail: {
  eyeStart: { lonLat: [0, 45], heightM: 100 }, eyeEnd: { lonLat: [.02, 45], heightM: 100 },
  targetStart: { lonLat: [.1, 45], heightM: 1000 }, targetEnd: { lonLat: [.12, 45], heightM: 1000 }, fovYDeg: 35,
} }] };
const tinyGrid = { west: -1, south: 44, east: 1, north: 46, width: 2, height: 2, heightsM: new Float32Array([100,100,100,100]) };

test('enumeration retains low-scoring cameras and four permissive perspectives per range', () => {
  const all = enumerateDiscoveryCandidates(authored, ranges);
  assert.equal(all.length, 10);
  assert.equal(all.filter(c => c.kind === 'computed').length, 1);
  assert.equal(all.filter(c => c.kind === 'explore').length, 8);
  assert.deepEqual(all.filter(c => c.kind !== 'reference').slice(0, 4).map(c => c.sourceRangeId), ['other-hills', 'soft-hills', 'other-hills', 'soft-hills']);
  assert.ok(all.filter(c => c.kind !== 'reference').every(c => c.referenceId === 'reference-example'));
});

test('stable identities survive source ordering and names are preserved as data', () => {
  const a = enumerateDiscoveryCandidates(authored, ranges);
  const b = enumerateDiscoveryCandidates(authored, { ranges: [...ranges.ranges].reverse() });
  assert.deepEqual(a.map(c => c.id), b.map(c => c.id));
  assert.equal(new Set(a.map(c => c.id)).size, a.length);
  assert.ok(a.every(c => /^[a-z0-9-]+$/.test(c.id)));
});

test('comparisons prefer the current production biome over a closer legacy-biome example', () => {
  const nearDesert = { ...authored.views[0], id: 'near-desert', biome: 'DESERT' };
  const canyonRail = structuredClone(authored.views[0].rail);
  for (const key of ['eyeStart', 'eyeEnd', 'targetStart', 'targetEnd']) canyonRail[key].lonLat[0] += 2;
  const farCanyon = { ...authored.views[0], id: 'far-canyon', biome: 'CANYON', rail: canyonRail };
  const bookCliffs = { ...ranges.ranges[0], id: 'book-cliffs', biome: 'desert' };
  const all = enumerateDiscoveryCandidates({ views: [nearDesert, farCanyon] }, { ranges: [bookCliffs] });
  assert.ok(all.filter(c => c.sourceRangeId).every(c => c.referenceId === 'reference-far-canyon'));
  assert.ok(all.filter(c => c.sourceRangeId).every(c => c.biome === 'DESERT'));
});

test('all repository references and precomputed viewpoints enter discovery without promotion', async () => {
  const read = p => fs.readFile(new URL(p, import.meta.url), 'utf8').then(JSON.parse);
  const [a, r] = await Promise.all([read('../data/terrain/scenic-views.json'), read('../ridgeview/data/viewpoints.json')]);
  const all = enumerateDiscoveryCandidates(a, r);
  assert.equal(all.filter(c => c.sourceViewId).length, a.views.length);
  assert.equal(all.filter(c => c.kind === 'reference').length, a.views.filter(v => v.status === 'approved' || v.experimental === true).length);
  assert.ok(all.filter(c => c.referenceId).every(c => all.find(r => r.id === c.referenceId)?.kind === 'reference'));
  assert.equal(all.filter(c => c.kind === 'computed').length, r.ranges.reduce((n, v) => n + v.views.length, 0));
  assert.equal(all.filter(c => c.kind === 'explore' && c.sourceRangeId).length, r.ranges.length * 4);
  assert.ok(all.filter(c => c.sourceRangeId === 'rainier').every(c => c.landmark === 'Mount Rainier'));
  assert.ok(all.every(c => !Object.hasOwn(c, 'approved') && !Object.hasOwn(c, 'experimental')));
});

test('reference optics preserve vertical FOV and target pitch in the coarse scene', () => {
  const c = enumerateDiscoveryCandidates(authored, ranges)[0];
  const camera = resolveReferenceCamera(c.camera, tinyGrid);
  assert.ok(Math.abs(camera.hfovDeg - 58.52) < 0.1);
  assert.ok(camera.pitchDeg > 6 && camera.pitchDeg < 7);
  assert.equal(camera.eye.lon, .01);
  assert.equal(camera.eye.heightM, 100);
});

test('bounds cover each camera with a finite geographic padding', () => {
  const all = enumerateDiscoveryCandidates(authored, ranges).filter(c => c.sourceRangeId === 'soft-hills');
  const box = candidateBounds(all, 36000);
  for (const c of all) assert.ok(c.camera.eye.lon > box.west && c.camera.eye.lon < box.east && c.camera.eye.lat > box.south && c.camera.eye.lat < box.north);
  assert.throws(() => candidateBounds([], 36000), /candidate/i);
});

test('review signature changes with camera, source, or actual preview bytes', () => {
  const c = enumerateDiscoveryCandidates(authored, ranges)[0];
  const signature = candidateSignature(c, Buffer.from('a'), { source: 'one' });
  assert.equal(signature, candidateSignature(c, Buffer.from('a'), { source: 'one' }));
  assert.notEqual(signature, candidateSignature(c, Buffer.from('b'), { source: 'one' }));
  assert.notEqual(signature, candidateSignature(c, Buffer.from('a'), { source: 'two' }));
  assert.notEqual(signature, candidateSignature({ ...c, camera: { ...c.camera, pitchDeg: 1 } }, Buffer.from('a'), { source: 'one' }));
});

test('PNG writer emits a bounded real image', () => {
  const png = encodePng(2, 1, new Uint8Array([1,2,3,255,4,5,6,255]));
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  assert.throws(() => encodePng(2, 1, new Uint8Array(2)), /size/i);
});

test('tile loader shares requests, reuses validated disk cache and enforces concurrency', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-tiles-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let requests = 0, active = 0, peak = 0;
  const bytes = encodePng(256, 256, new Uint8Array(256 * 256 * 4));
  const fetchImpl = async () => { requests++; active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 3)); active--; return { ok: true, arrayBuffer: async () => bytes }; };
  const loader = createTileLoader({ cacheDir: dir, concurrency: 2, fetchImpl });
  await Promise.all([loader(9,1,2),loader(9,1,2),loader(9,2,2),loader(9,3,2)]);
  assert.equal(requests, 3);
  assert.ok(peak <= 2);
  await createTileLoader({ cacheDir: dir, fetchImpl })(9,1,2);
  assert.equal(requests, 3);
});

test('generator retains failed previews and writes successful candidates without GPU or terrain bake', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-discovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const candidates = enumerateDiscoveryCandidates(authored, ranges).slice(0, 3);
  const catalog = await buildDiscovery({ candidates, out: dir,
    loadGrid: async group => { if (group[0].sourceRangeId === 'other-hills') throw new Error('fixture terrain unavailable'); return { ...tinyGrid, cellM: 300, source: 'fixture terrain', tileHashes: ['fixture'] }; },
    render: () => ({ width: 2, height: 1, rgba: new Uint8Array(8), coverage: .5 }), log: () => {},
  });
  assert.equal(catalog.candidates.length, 3);
  assert.equal(catalog.candidates.filter(c => c.preview.status === 'ready').length, 2);
  assert.match(catalog.candidates.find(c => c.preview.status === 'unavailable').preview.warning, /fixture terrain unavailable/);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'catalog.json')));
  assert.equal(saved.schema, 'midio.view-discovery');
  assert.ok(saved.candidates.every(c => /^[a-f0-9]{64}$/.test(c.signature)));
  assert.ok(saved.candidates.filter(c => c.preview.status === 'ready').every(c => /^previews\/[a-z0-9-]+-[a-f0-9]{12}\.json$/.test(c.preview.url)));
});


test('partial generation requires its own output and rejects invalid cost controls', () => {
  assert.throws(() => parseArguments(['--only','tetons']), /explicit --out/);
  assert.equal(parseArguments(['--only','tetons','--out','somewhere']).only[0], 'tetons');
  assert.throws(() => parseArguments(['--zoom','10']), /8 or 9/);
  assert.throws(() => parseArguments(['--cell','NaN']), /200 and 1000/);
});

test('a region tile cap rejects before any download begins', async () => {
  const candidates = enumerateDiscoveryCandidates(authored, ranges);
  let calls = 0;
  await assert.rejects(loadDiscoveryGrid(candidates, { tileLoader: async () => { calls++; }, zoom: 9, maxTiles: 1 }), /cap/);
  assert.equal(calls, 0);
});

test('unsupported single-pose references stay visible without making terrain requests', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-unsupported-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const candidates = enumerateDiscoveryCandidates({ views: [{ id: 'route-only', title: 'Tour', biome: 'CONIFER', status: 'candidate' }] }, { ranges: [] });
  let requests = 0;
  const result = await buildDiscovery({ candidates, out: dir, loadGrid: async () => { requests++; }, render: () => {}, log: () => {} });
  assert.equal(requests, 0);
  assert.equal(result.generatedWith.unsupported, 1);
  assert.equal(result.generatedWith.failed, 0);
  assert.equal(result.candidates[0].preview.status, 'unavailable');
});


test('PNG dimensions and expanding data are rejected before terrain allocation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-bad-tile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const oversized = encodePng(1, 1, new Uint8Array(4));
  oversized.writeUInt32BE(0xffffffff, 16);
  const loader = createTileLoader({ cacheDir: dir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => oversized }) });
  await assert.rejects(loader(8,1,1), /bounded 256/);
  const valid = encodePng(256, 256, new Uint8Array(256 * 256 * 4));
  const secondHeader = Buffer.from(valid.subarray(8, 33)); secondHeader.writeUInt32BE(0xffffffff, 8);
  const duplicate = Buffer.concat([valid.subarray(0, 33), secondHeader, valid.subarray(33)]);
  const doubleHeader = createTileLoader({ cacheDir: dir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => duplicate }) });
  await assert.rejects(doubleHeader(8,3,1), /Duplicate/);
  const expanding = encodePng(512, 256, new Uint8Array(512 * 256 * 4)); expanding.writeUInt32BE(256, 16);
  const bomb = createTileLoader({ cacheDir: dir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => expanding }) });
  await assert.rejects(bomb(8,4,1), /larger|length/);
  const huge = createTileLoader({ cacheDir: dir, fetchImpl: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  await assert.rejects(huge(8,2,1), /exceeds 2 MiB/);
});

test('invalid concurrency cannot silently produce null catalog entries', async () => {
  await assert.rejects(buildDiscovery({ candidates: [], out: 'ignored', loadGrid: () => {}, render: () => {}, groupConcurrency: 0 }), /groupConcurrency/);
});


test('high-latitude previews lower source zoom to fit the same tile cap', async () => {
  const read = p => fs.readFile(new URL(p, import.meta.url), 'utf8').then(JSON.parse);
  const [a, r] = await Promise.all([read('../data/terrain/scenic-views.json'), read('../ridgeview/data/viewpoints.json')]);
  const all = enumerateDiscoveryCandidates(a, r).filter(c => c.sourceRangeId === 'arctic-cordillera');
  let calls = 0;
  const image = { width: 256, height: 256, channels: 3, data: new Uint8Array(256 * 256 * 3) };
  const grid = await loadDiscoveryGrid(all, { tileLoader: async zoom => { calls++; assert.equal(zoom, 8); return { image, hash: 'fixture' }; } });
  assert.ok(calls <= 64);
  assert.equal(grid.zoom, 8);
  assert.match(grid.warning, /tile budget/);
});

test('failed regions finish pending requests before reporting build costs', async () => {
  const group = enumerateDiscoveryCandidates(authored, ranges).slice(0, 1);
  let completed = 0, requests = 0;
  await assert.rejects(loadDiscoveryGrid(group, { tileLoader: async () => {
    requests++;
    if (requests === 1) throw new Error('tile failure');
    await new Promise(resolve => setTimeout(resolve, 5)); completed++;
    return { image: null, hash: 'unused' };
  } }), /tile failure/);
  assert.equal(completed, requests - 1);
});


test('preview filenames bind the actual image and replace only files owned by the prior catalog', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-addressed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const candidates = enumerateDiscoveryCandidates(authored, ranges).slice(0, 1);
  let color = 10;
  const options = { candidates, out: dir, loadGrid: async () => ({ ...tinyGrid, cellM: 250, source: 'fixture' }),
    render: () => ({ width: 2, height: 1, rgba: new Uint8Array(8).fill(color), coverage: 1 }), log: () => {} };
  const first = await buildDiscovery(options), a = first.candidates[0];
  const payload = JSON.parse(await fs.readFile(path.join(dir, a.preview.url)));
  assert.equal(a.preview.encoding, 'png-base64');
  assert.match(payload.png, /^iVBORw0KGgo/);
  assert.ok(a.preview.url.includes(a.preview.sha256.slice(0, 12)));
  await fs.writeFile(path.join(dir, 'previews', 'unrelated.png'), 'keep');
  color = 20;
  const second = await buildDiscovery(options), b = second.candidates[0];
  assert.notEqual(a.preview.url, b.preview.url);
  assert.notEqual(a.signature, b.signature);
  await assert.rejects(fs.access(path.join(dir, a.preview.url)));
  assert.equal(await fs.readFile(path.join(dir, 'previews', 'unrelated.png'), 'utf8'), 'keep');
  assert.ok((await fs.readdir(dir)).every(name => !name.includes('.tmp-')));
});


test('appearance source uses actual production palettes, view overrides and explicit biome fallback', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const materials = await loadScoutMaterials({ root });
  assert.equal(materials.size, 11);
  const candidate = { biome: 'TUNDRA', sourceViewId: 'local-view' };
  const resolved = resolveScoutMaterial(candidate, { materials, authored: { views: [{ id: 'local-view', materialRules: { treelineM: 1550, forestDensity: .12 } }] } });
  assert.equal(resolved.material.id, 'tundra');
  assert.equal(resolved.materialRules.treelineM, 1550);
  assert.match(resolved.provenance.materialSha256, /^[a-f0-9]{64}$/);
  assert.equal(resolved.provenance.source, 'src/assets/range/v2/materials/tundra.json');
  const glacial = resolveScoutMaterial({ biome: 'GLACIAL_FLOW' }, { materials });
  assert.equal(glacial.material.id, 'icefield');
  assert.equal(glacial.styleBiome, 'ICEFIELD');
  const unknown = resolveScoutMaterial({ biome: 'UNKNOWN' }, { materials });
  assert.equal(unknown.material.id, 'dry-conifer');
  assert.match(unknown.provenance.warning, /fallback/);
  const cliffs = resolveScoutMaterial({ biome: 'DESERT', sourceRangeId: 'book-cliffs' }, { materials });
  assert.equal(cliffs.material.id, 'canyon');
  assert.equal(cliffs.provenance.sourceBiome, 'DESERT');
  assert.equal(cliffs.provenance.styleBiome, 'CANYON');
  const cascades = resolveScoutMaterial({ biome: 'CONIFER', sourceRangeId: 'north-cascades' }, { materials });
  assert.equal(cascades.material.id, 'wet-conifer');
  const explicit = resolveScoutMaterial({ biome: 'DESERT', sourceRangeId: 'book-cliffs', sourceViewId: 'authored-override' }, {
    materials, authored: { views: [{ id: 'authored-override', biome: 'TUNDRA', materialPack: 'icefield' }] },
  });
  assert.equal(explicit.material.id, 'icefield');
  assert.equal(explicit.styleBiome, 'TUNDRA');
});

test('appearance and terrain-only previews are separate and both bind the review signature', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-appearance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const candidates = enumerateDiscoveryCandidates(authored, ranges).slice(0, 1);
  let terrainColor = 10, materialVersion = 'a';
  const options = { candidates, out: dir, loadGrid: async () => ({ ...tinyGrid, cellM: 250, source: 'fixture' }),
    styleFor: () => ({ style: { color: 40 }, provenance: { materialId: 'fixture', materialSha256: materialVersion, preset: 'daylight', warning: 'Unknown biome fixture; explicit material fallback.' } }),
    render: (grid, camera, { style }) => ({ width: 2, height: 1, rgba: new Uint8Array(8).fill(style ? style.color : terrainColor), coverage: 1 }), log: () => {} };
  const first = (await buildDiscovery(options)).candidates[0];
  assert.equal(first.preview.appearance, 'landscape-study');
  assert.equal(first.preview.shape.appearance, 'terrain-only');
  assert.notEqual(first.preview.url, first.preview.shape.url);
  assert.equal(first.provenance.style.materialId, 'fixture');
  assert.match(first.preview.warning, /explicit material fallback/);
  assert.doesNotMatch(first.preview.shape.warning || '', /explicit material fallback/);
  terrainColor = 20;
  const second = (await buildDiscovery(options)).candidates[0];
  assert.notEqual(first.signature, second.signature);
  assert.equal(first.preview.url, second.preview.url);
  materialVersion = 'b';
  const third = (await buildDiscovery(options)).candidates[0];
  assert.notEqual(second.signature, third.signature);
  assert.equal(second.preview.url, third.preview.url);
});
