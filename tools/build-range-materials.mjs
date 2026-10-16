// Build Range v2 material packs (plan §3.4, Task 9).
//
//   node tools/build-range-materials.mjs [--textures] [--packs]
//
// Textures (shared by packs) are data maps only -- normal, roughness,
// height, coverage -- written by tools/terrain/make-materials.py, either
// procedurally (seeded, reproducible) or from ambientCG CC0 scans whose
// colour maps are never used. Colour comes from each pack's palette, so a
// shared rock normal map under a desert palette and different masks is not
// "the same alpine scene recoloured".
//
// Outputs:
//   src/assets/range/v2/textures/<id>.webp        (+ provenance in the pack)
//   src/assets/range/v2/materials/<pack>.json     (schema midio.material v1)
//   src/assets/range/v2/NOTICE-materials.md       (sources and licences)
// CC0 zips are cached in .terrain-cache/cc0 (never committed).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'src', 'assets', 'range', 'v2');
const CACHE = path.join(root, '.terrain-cache', 'cc0');
const PY = process.env.MIDIO_GDAL_PYTHON || '/usr/bin/python3.12';
export const MATERIAL_SCHEMA = 'midio.material';
export const MATERIAL_VERSION = 1;

const CC0 = (asset, note) => ({ kind: 'cc0', asset, note,
  url: `https://ambientcg.com/get?file=${asset}_2K-PNG.zip`, page: `https://ambientcg.com/a/${asset}`,
  provider: 'ambientCG', license: 'CC0 1.0 Universal (public domain dedication)' });
const PROC = (kind, seed, note) => ({ kind: 'proc', proc: kind, seed, note });

/** Every shared data texture. metersPerTile is the intended terrain scale. */
export const TEXTURES = {
  'proc-cliff': { ...PROC('cliff', 11, 'weathered crystalline cliff: buttresses, sparse joints, patchy bedding'), metersPerTile: 150 },
  'proc-canopy': { ...PROC('canopy', 12, 'conifer crowns from above: clumped stands with gaps'), metersPerTile: 70 },
  'proc-snow': { ...PROC('snow', 13, 'wind-packed snow ripples'), metersPerTile: 60 },
  'cc0-rock051': { ...CC0('Rock051', 'mountain cliff wall'), metersPerTile: 6 },
  'cc0-rock063': { ...CC0('Rock063', 'cracked, eroded layered slabs (rock stage)'), metersPerTile: 4 },
  'cc0-rock020': { ...CC0('Rock020', 'smooth wet flat stone'), metersPerTile: 3 },
  'cc0-rock029': { ...CC0('Rock029', 'red desert cliff'), metersPerTile: 6 },
  'cc0-rock055': { ...CC0('Rock055', 'layered beige cliff'), metersPerTile: 6 },
  'cc0-ground068': { ...CC0('Ground068', 'dirt, moss and stones'), metersPerTile: 3 },
  'cc0-ground022': { ...CC0('Ground022', 'river pebbles'), metersPerTile: 2 },
};

// Palettes are sRGB hex albedo (before light and air). Wet conifer is
// sampled from the reference's blue-hour values and backed off to albedo;
// the others follow each biome's real ground. Rules are defaults a view
// may override (scenic-views.json materialRules) from its own geography.
const ALPINE = { rockDetail: 'proc-cliff', rockNear: 'cc0-rock051', stage: 'cc0-rock063', stageWet: 'cc0-rock020',
  soil: 'cc0-ground068', canopy: 'proc-canopy', snow: 'proc-snow', pebbles: 'cc0-ground022' };
const DESERTY = { ...ALPINE, rockNear: 'cc0-rock029', stage: 'cc0-rock055' };
export const PACKS = {
  'wet-conifer': { biomes: ['RAINFOREST'], textures: ALPINE,
    palette: { rockLit: '#454e58', rockShade: '#1e242a', rockWarm: '#4e4a44', soil: '#454a3e', meadow: '#4e5c44',
      forestNear: '#2c3e34', forestFar: '#33443f', moss: '#465438', snow: '#c9d5e4', snowShade: '#7d90aa',
      water: '#243442', waterDeep: '#16202a', wetRock: '#262e34', lichen: '#56604e' },
    rules: { snowlineM: 1850, snowFullM: 2250, snowMaxSlopeDeg: 52, treelineM: 1750, forestMaxSlopeDeg: 50,
      forestDensity: 0.92, moss: 0.7, wetness: 0.8, strata: 0.25 } },
  'dry-conifer': { biomes: ['CONIFER'], textures: ALPINE,
    palette: { rockLit: '#8a8478', rockShade: '#3a3834', rockWarm: '#8e7c66', soil: '#5a5040', meadow: '#6a6a48',
      forestNear: '#1c2a1e', forestFar: '#2c3a30', moss: '#4c5438', snow: '#eef2f6', snowShade: '#a8b6c6',
      water: '#22323c', waterDeep: '#101a20', wetRock: '#2c2c28', lichen: '#707060' },
    rules: { snowlineM: 3000, snowFullM: 3500, snowMaxSlopeDeg: 50, treelineM: 3100, forestMaxSlopeDeg: 36,
      forestDensity: 0.7, moss: 0.3, wetness: 0.4, strata: 0.3 } },
  taiga: { biomes: ['TAIGA'], textures: ALPINE,
    palette: { rockLit: '#747a7e', rockShade: '#30353a', rockWarm: '#766e62', soil: '#4a4636', meadow: '#5e6644',
      forestNear: '#18261e', forestFar: '#28362f', moss: '#56603c', snow: '#eef3f8', snowShade: '#a4b6ca',
      water: '#1e2c36', waterDeep: '#0e161c', wetRock: '#24292c', lichen: '#6a6e58' },
    // Northern Rockies in summer: boreal forest to ~1400 m above lakes near
    // 800 m; snow lingers only on the highest peaks.
    rules: { snowlineM: 2000, snowFullM: 2400, snowMaxSlopeDeg: 52, treelineM: 1400, forestMaxSlopeDeg: 34,
      forestDensity: 0.6, moss: 0.6, wetness: 0.6, strata: 0.2 } },
  icefield: { biomes: ['ICEFIELD'], textures: ALPINE,
    palette: { rockLit: '#5e6670', rockShade: '#23282e', rockWarm: '#625e58', soil: '#403e38', meadow: '#4a5040',
      forestNear: '#1a2620', forestFar: '#2a3632', moss: '#445038', snow: '#f0f5fb', snowShade: '#9cb4d0',
      water: '#28404e', waterDeep: '#122028', wetRock: '#20252a', lichen: '#5a5e52' },
    rules: { snowlineM: 700, snowFullM: 1100, snowMaxSlopeDeg: 58, treelineM: 400, forestMaxSlopeDeg: 30,
      forestDensity: 0.25, moss: 0.3, wetness: 0.5, strata: 0.15 } },
  tundra: { biomes: ['TUNDRA'], textures: ALPINE,
    palette: { rockLit: '#6e7070', rockShade: '#2e3032', rockWarm: '#6e665c', soil: '#4e4838', meadow: '#6a6a4a',
      forestNear: '#23301f', forestFar: '#34402f', moss: '#6a6a42', snow: '#eef2f6', snowShade: '#a6b6c8',
      water: '#243440', waterDeep: '#101a20', wetRock: '#28292a', lichen: '#7a7a5e' },
    // Yukon alpine tundra in summer: snow patches only near the summits.
    rules: { snowlineM: 1900, snowFullM: 2300, snowMaxSlopeDeg: 50, treelineM: 300, forestMaxSlopeDeg: 20,
      forestDensity: 0.05, moss: 0.8, wetness: 0.5, strata: 0.2 } },
  'pine-oak': { biomes: ['PINE_OAK'], textures: DESERTY,
    palette: { rockLit: '#9a8a74', rockShade: '#3e3830', rockWarm: '#a08066', soil: '#6a5842', meadow: '#7a7650',
      forestNear: '#243224', forestFar: '#3a4636', moss: '#5a5c3a', snow: '#f2f4f6', snowShade: '#b0bccb',
      water: '#2a3a40', waterDeep: '#141e22', wetRock: '#322e28', lichen: '#7e7a62' },
    rules: { snowlineM: 3300, snowFullM: 3600, snowMaxSlopeDeg: 45, treelineM: 3500, forestMaxSlopeDeg: 32,
      forestDensity: 0.45, moss: 0.1, wetness: 0.2, strata: 0.35, forestFloorM: 2700 } },
  // Deciduous canopy reflects more than conifer needles: lighter greens.
  broadleaf: { biomes: ['BROADLEAF'], textures: ALPINE,
    palette: { rockLit: '#7c7a70', rockShade: '#34342e', rockWarm: '#7e7060', soil: '#4e4632', meadow: '#5a6a3c',
      forestNear: '#2e4624', forestFar: '#40563a', moss: '#4e6232', snow: '#eef2f6', snowShade: '#a8b6c6',
      water: '#1e2e32', waterDeep: '#0e1618', wetRock: '#2a2a26', lichen: '#6a6e54' },
    // Southern Appalachian spruce-fir runs to the highest summits (Mitchell
    // 2037 m): no treeline or lasting snow inside the range's heights.
    rules: { snowlineM: 2400, snowFullM: 2700, snowMaxSlopeDeg: 45, treelineM: 2300, forestMaxSlopeDeg: 42,
      forestDensity: 0.95, moss: 0.6, wetness: 0.6, strata: 0.2 } },
  chaparral: { biomes: ['CHAPARRAL'], textures: DESERTY,
    palette: { rockLit: '#a8987e', rockShade: '#443c32', rockWarm: '#ae8e6c', soil: '#7a6648', meadow: '#8a8456',
      forestNear: '#2e3a28', forestFar: '#48523c', moss: '#6a6a42', snow: '#f2f4f6', snowShade: '#b2bcc8',
      water: '#2c3c42', waterDeep: '#141e22', wetRock: '#383228', lichen: '#8a8466' },
    rules: { snowlineM: 3200, snowFullM: 3400, snowMaxSlopeDeg: 42, treelineM: 3000, forestMaxSlopeDeg: 34,
      forestDensity: 0.35, moss: 0.05, wetness: 0.1, strata: 0.3 } },
  steppe: { biomes: ['STEPPE'], textures: DESERTY,
    palette: { rockLit: '#9c9280', rockShade: '#403a32', rockWarm: '#a08a6e', soil: '#7e7050', meadow: '#8a8a5c',
      forestNear: '#2a3628', forestFar: '#48523e', moss: '#6e6e46', snow: '#f0f3f6', snowShade: '#aebccb',
      water: '#2a3a40', waterDeep: '#141e22', wetRock: '#36322a', lichen: '#8a8868' },
    rules: { snowlineM: 3300, snowFullM: 3600, snowMaxSlopeDeg: 45, treelineM: 3200, forestMaxSlopeDeg: 30,
      forestDensity: 0.12, moss: 0.05, wetness: 0.1, strata: 0.4, forestFloorM: 2000, treeScale: 0.3, airScale: 0.6 } },
  canyon: { biomes: ['CANYON'], textures: DESERTY,
    palette: { rockLit: '#b8805a', rockShade: '#4e2e22', rockWarm: '#c89468', soil: '#9a6a48', meadow: '#8a7a54',
      forestNear: '#2e3a2a', forestFar: '#4a5040', moss: '#6a6040', snow: '#f4f2f0', snowShade: '#bcc0c8',
      water: '#2e3c3c', waterDeep: '#141c1c', wetRock: '#442a20', lichen: '#8a7a60' },
    rules: { snowlineM: 3600, snowFullM: 3900, snowMaxSlopeDeg: 40, treelineM: 3400, forestMaxSlopeDeg: 28,
      forestDensity: 0.08, moss: 0.02, wetness: 0.05, strata: 0.9, forestFloorM: 1700, treeScale: 0.45, airScale: 0.6 } },
  desert: { biomes: ['DESERT'], textures: DESERTY,
    palette: { rockLit: '#a8906e', rockShade: '#46382a', rockWarm: '#b89266', soil: '#96805a', meadow: '#8e8660',
      forestNear: '#303a2a', forestFar: '#4e5440', moss: '#706a48', snow: '#f2f2f2', snowShade: '#b8bec8',
      water: '#2e3c3e', waterDeep: '#141c1e', wetRock: '#3e3226', lichen: '#8e8468' },
    rules: { snowlineM: 3000, snowFullM: 3200, snowMaxSlopeDeg: 42, treelineM: 2600, forestMaxSlopeDeg: 30,
      forestDensity: 0.1, moss: 0.02, wetness: 0.05, strata: 0.55, forestFloorM: 1800, treeScale: 0.3, airScale: 0.5 } },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function ensureZip(asset, url) {
  const file = path.join(CACHE, `${asset}.zip`);
  try { await fs.access(file); return file; } catch { /* download */ }
  await fs.mkdir(CACHE, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${asset}: HTTP ${res.status}`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

export async function buildTextures() {
  const dir = path.join(OUT, 'textures');
  await fs.mkdir(dir, { recursive: true });
  for (const [id, t] of Object.entries(TEXTURES)) {
    const out = path.join(dir, `${id}.webp`);
    if (t.kind === 'cc0') {
      const zip = await ensureZip(t.asset, t.url);
      execFileSync(PY, [path.join(root, 'tools/terrain/make-materials.py'), 'cc0', zip, out,
        '--meta', JSON.stringify({ source: { provider: t.provider, asset: t.asset, url: t.url, page: t.page, license: t.license } })], { stdio: 'inherit' });
    } else {
      execFileSync(PY, [path.join(root, 'tools/terrain/make-materials.py'), 'proc', t.proc, out, '--seed', String(t.seed)], { stdio: 'inherit' });
    }
  }
}

async function textureRecord(id) {
  const t = TEXTURES[id];
  const file = path.join(OUT, 'textures', `${id}.webp`);
  const side = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
  const bytes = await fs.readFile(file);
  if (sha256(bytes) !== side.sha256) throw new Error(`${id}: sidecar hash is stale`);
  return {
    url: `../textures/${id}.webp`, sha256: side.sha256, bytes: bytes.byteLength,
    width: side.width, height: side.height, colorSpace: 'data', channels: side.channels, format: side.format,
    mips: 'generated at upload', metersPerTile: t.metersPerTile, note: t.note,
    source: t.kind === 'cc0'
      ? { provider: t.provider, asset: t.asset, url: t.url, page: t.page, license: t.license, zipSha256: side.sourceSha256, usedMaps: ['NormalGL', 'Roughness', 'Displacement'] }
      : { generator: 'tools/terrain/make-materials.py', kind: t.proc, seed: t.seed, license: 'project (generated)' },
  };
}

export async function buildPacks() {
  const dir = path.join(OUT, 'materials');
  await fs.mkdir(dir, { recursive: true });
  const notice = ['# Range v2 material sources', '',
    'Data maps only (normal, roughness, height, coverage). No scanned colour map ships; colour comes from each pack palette.', ''];
  for (const [id, t] of Object.entries(TEXTURES)) {
    notice.push(t.kind === 'cc0'
      ? `- \`textures/${id}.webp\`: ${t.provider} ${t.asset} (${t.page}), ${t.license}. ${t.note}.`
      : `- \`textures/${id}.webp\`: generated by tools/terrain/make-materials.py (${t.proc}, seed ${t.seed}). ${t.note}.`);
  }
  for (const [packId, pack] of Object.entries(PACKS)) {
    const textures = {};
    for (const [role, texId] of Object.entries(pack.textures)) textures[role] = { id: texId, ...(await textureRecord(texId)) };
    const manifest = { schema: MATERIAL_SCHEMA, version: MATERIAL_VERSION, id: packId, biomes: pack.biomes,
      textures, palette: pack.palette, rules: pack.rules,
      colorManagement: 'palette hex values are sRGB albedo; shaders convert to linear; data textures are not colour-managed' };
    await fs.writeFile(path.join(dir, `${packId}.json`), JSON.stringify(manifest, null, 1) + '\n');
  }
  await fs.writeFile(path.join(OUT, 'NOTICE-materials.md'), notice.join('\n') + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const all = !args.includes('--textures') && !args.includes('--packs');
  if (all || args.includes('--textures')) await buildTextures();
  if (all || args.includes('--packs')) await buildPacks();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
