// Range v2 Task 9: material packs are real, verified data assets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMaterialManifest, materialGpuBytes, hexToLinear, loadMaterialPack, MATERIAL_ROLES } from '../src/world/alpine/MaterialPackage.js';
import { REAL_BIOME_NAMES } from '../src/world/RealBiomes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/assets/range/v2/materials');
const packs = await Promise.all((await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  .map(async (f) => ({ file: f, m: JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) })));

test('every shipped pack validates and every biome has one', () => {
  for (const { file, m } of packs) assert.deepEqual(validateMaterialManifest(m), { ok: true, errors: [] }, file);
  const covered = new Set(packs.flatMap(({ m }) => m.biomes));
  for (const b of REAL_BIOME_NAMES) assert.ok(covered.has(b), `no material pack for ${b}`);
});

test('textures are data maps with verified bytes, sizes and provenance', async () => {
  const seen = new Set();
  for (const { m } of packs) {
    for (const role of MATERIAL_ROLES) {
      const t = m.textures[role];
      assert.equal(t.colorSpace, 'data');
      assert.ok(!t.channels.includes('color') && !t.channels.includes('albedo'), 'no scanned colour ships');
      if (seen.has(t.sha256)) continue;
      seen.add(t.sha256);
      const buf = await fs.readFile(path.join(dir, t.url));
      assert.equal(buf.byteLength, t.bytes);
      assert.equal(createHash('sha256').update(buf).digest('hex'), t.sha256);
      assert.ok(t.source.license, 'licence recorded');
      if (t.source.provider === 'ambientCG') assert.match(t.source.license, /CC0/);
      else assert.equal(t.source.generator, 'tools/terrain/make-materials.py');
    }
  }
  assert.ok(seen.size >= 6);
});

test('packs differ by biome: palettes and rules are not one scene recoloured', () => {
  const byId = Object.fromEntries(packs.map(({ m }) => [m.id, m]));
  assert.notDeepEqual(byId['wet-conifer'].palette, byId.desert.palette);
  assert.ok(byId.canyon.rules.strata > byId['wet-conifer'].rules.strata);
  assert.ok(byId['wet-conifer'].rules.forestDensity > byId.desert.rules.forestDensity);
  assert.ok(byId.icefield.rules.snowlineM < byId.desert.rules.snowlineM);
  assert.notEqual(byId.desert.textures.stage.sha256, byId['wet-conifer'].textures.stage.sha256);
});

test('validation rejects colour-managed or incomplete packs', () => {
  const base = packs[0].m;
  const bad = (mut, re) => { const c = structuredClone(base); mut(c); assert.match(validateMaterialManifest(c).errors.join('\n'), re); };
  bad((c) => { c.textures.rockDetail.colorSpace = 'srgb'; }, /data texture/);
  bad((c) => { delete c.textures.snow; }, /snow missing/);
  bad((c) => { c.palette.snow = 'white'; }, /palette snow/);
  bad((c) => { c.rules.treelineM = NaN; }, /treelineM/);
  bad((c) => { c.version = 9; }, /version/);
  bad((c) => { c.textures.canopy.sha256 = 'x'; }, /sha256/);
  bad((c) => { c.rules.forestFloorM = 'low'; }, /forestFloorM/);
  bad((c) => { c.rules.treeScale = 0; }, /treeScale/);
  bad((c) => { c.rules.airScale = -1; }, /airScale/);
  // The optional rules may be absent.
  const plain = structuredClone(base);
  for (const k of ['forestFloorM', 'treeScale', 'airScale']) delete plain.rules[k];
  assert.deepEqual(validateMaterialManifest(plain), { ok: true, errors: [] });
});

test('habitat rules follow each biome\'s real vegetation and snow', () => {
  const byId = Object.fromEntries(packs.map(({ m }) => [m.id, m]));
  // Dry country: open valley floors, small trees, clearer air.
  for (const id of ['steppe', 'canyon', 'desert']) {
    const r = byId[id].rules;
    assert.ok(r.forestFloorM > 1000, `${id} forest starts above its valley floors`);
    assert.ok(r.treeScale < 1, `${id} grows small trees`);
    assert.ok(r.airScale < 1, `${id} air is clearer than wet ranges'`);
  }
  // Wet and alpine packs keep the defaults (their approvals depend on them).
  for (const id of ['wet-conifer', 'dry-conifer', 'icefield']) {
    for (const k of ['forestFloorM', 'treeScale', 'airScale']) assert.ok(!(k in byId[id].rules), `${id} ${k}`);
  }
  // Southern Appalachian forest reaches the summits (Mitchell 2037 m).
  assert.ok(byId.broadleaf.rules.treelineM > 2037);
  // Boreal forest stands above northern lakes (Muncho Lake ~817 m); summer
  // tundra and taiga are not an icefield.
  assert.ok(byId.taiga.rules.treelineM > 1200);
  for (const id of ['taiga', 'tundra']) assert.ok(byId[id].rules.snowlineM > byId.icefield.rules.snowlineM + 1000, id);
});

test('GPU ownership counts each shared texture once, with mips', () => {
  const m = packs.find((p) => p.m.id === 'wet-conifer').m;
  const unique = new Set(Object.values(m.textures).map((t) => t.sha256)).size;
  assert.ok(materialGpuBytes(m) >= unique * 512 * 512 * 4);
  assert.deepEqual(hexToLinear('#ffffff'), [1, 1, 1]);
  assert.ok(Math.abs(hexToLinear('#808080')[0] - 0.2158) < 1e-3);
});

test('loading verifies texture bytes before decoding', async () => {
  const m = packs.find((p) => p.m.id === 'wet-conifer').m;
  const base = 'http://assets.test/v2/materials/wet-conifer.json';
  const files = new Map([[base, JSON.stringify(m)]]);
  for (const t of Object.values(m.textures)) files.set(new URL(t.url, base).href, await fs.readFile(path.join(dir, t.url)));
  const fetchImpl = async (u) => (files.has(u) ? new Response(files.get(u)) : new Response('', { status: 404 }));
  const decode = async () => ({ width: 512, height: 512 });
  const decodeAny = async (bytes) => { const t = Object.values(m.textures).find((x) => x.bytes === bytes.byteLength); return { width: t.width, height: t.height }; };
  const ok = await loadMaterialPack(base, { fetchImpl, decode: decodeAny });
  assert.ok(ok.images.size >= 6);
  const tampered = new Map(files);
  const first = new URL(m.textures.rockDetail.url, base).href;
  const buf = Buffer.from(tampered.get(first)); buf[100] ^= 1; tampered.set(first, buf);
  await assert.rejects(loadMaterialPack(base, { fetchImpl: async (u) => new Response(tampered.get(u)), decode }), /hash/);
});

test('a failing texture closes every image already decoded; the reservation hook runs before decoding', async () => {
  const m = packs.find((p) => p.m.id === 'wet-conifer').m;
  const base = 'http://assets.test/v2/materials/wet-conifer.json';
  const files = new Map([[base, JSON.stringify(m)]]);
  for (const t of Object.values(m.textures)) files.set(new URL(t.url, base).href, await fs.readFile(path.join(dir, t.url)));
  const last = new URL(Object.values(m.textures).at(-1).url, base).href;
  const fetchImpl = async (u) => (u === last ? new Response('', { status: 500 }) : new Response(files.get(u)));
  const decoded = [];
  let hookRanFirst = null;
  const decode = async (bytes) => {
    if (hookRanFirst === null) hookRanFirst = false;
    const t = Object.values(m.textures).find((x) => x.bytes === bytes.byteLength);
    const img = { width: t.width, height: t.height, closed: false, close() { this.closed = true; } };
    decoded.push(img);
    return img;
  };
  await assert.rejects(loadMaterialPack(base, { fetchImpl, decode, onManifest: () => { hookRanFirst ??= true; } }), /HTTP 500/);
  assert.equal(hookRanFirst, true);
  assert.ok(decoded.length > 0 && decoded.every((i) => i.closed));
  // A denied reservation stops the load before any decode.
  const none = [];
  await assert.rejects(loadMaterialPack(base, { fetchImpl, decode: async () => none.push(1),
    onManifest: () => { throw new Error('budget'); } }), /budget/);
  assert.equal(none.length, 0);
});

test('a body that fails mid-read is a classified asset error', async () => {
  const base = 'http://assets.test/v2/materials/x.json';
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => { throw new TypeError('network dropped'); } });
  await assert.rejects(loadMaterialPack(base, { fetchImpl }), (e) => e.reason === 'http');
});

test('a view loads only the material pack it was approved with', async () => {
  const { createHash } = await import('node:crypto');
  const m = packs.find((p) => p.m.id === 'wet-conifer').m;
  const base = 'http://assets.test/v2/materials/wet-conifer.json';
  const manifestText = JSON.stringify(m);
  const files = new Map([[base, manifestText]]);
  for (const t of Object.values(m.textures)) files.set(new URL(t.url, base).href, await fs.readFile(path.join(dir, t.url)));
  const fetchImpl = async (u) => (files.has(u) ? new Response(files.get(u)) : new Response('', { status: 404 }));
  const decode = async (bytes) => { const t = Object.values(m.textures).find((x) => x.bytes === bytes.byteLength); return { width: t.width, height: t.height }; };
  const approved = createHash('sha256').update(manifestText).digest('hex');
  assert.ok((await loadMaterialPack(base, { fetchImpl, decode, expectSha256: approved })).images.size > 0);
  await assert.rejects(loadMaterialPack(base, { fetchImpl, decode, expectSha256: '0'.repeat(64) }), (e) => e.reason === 'hash');
});
