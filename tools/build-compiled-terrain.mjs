// Build the compiled terrain packs of the experiment
// (docs/compiled-terrain-experiment.md) from the view's real DEM.
//
//   node tools/build-compiled-terrain.mjs [--view ID] [--out DIR] [--verify]
//        [--allow-dem-mismatch] [--profile default|lean]
//
// The DEM is the production one: tools/build-range-scene.mjs's normalized
// grid (cached in .terrain-cache, normalized on a miss: needs GDAL and the
// network), despiked exactly as the production bake does. Its hash must match
// the shipped terrain package's source unless --allow-dem-mismatch (GDAL
// builds can differ below the package's 5 cm quantization). --verify
// compiles twice and requires identical bytes. Output defaults to
// src/assets/range/v2/compiled/, which is generated and not committed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuthoring, loadViewGrid, RUNTIME_DIR } from './build-range-scene.mjs';
import { despikeGrid } from './lib/terrain-bake.mjs';
import { compileTerrainPacks, bakeMaterial, heightMips, COMPILER_VERSION, PROFILES } from './lib/compiled-terrain.mjs';
import { COMPILED_PILOT, compiledManifestPath } from '../src/world/alpine/CompiledTerrain.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function verifiedJson(file, expectSha, what) {
  const bytes = await fs.readFile(file);
  const got = sha256(bytes);
  if (expectSha && got !== expectSha) throw new Error(`${what} ${path.relative(root, file)} is ${got}, catalog pins ${expectSha}`);
  return { json: JSON.parse(bytes.toString('utf8')), sha256: got };
}

/** A data texture (webp) as raw RGBA8, decoded by PIL, sha-checked. */
async function loadTexture(materialFile, t) {
  const file = path.resolve(path.dirname(materialFile), t.url);
  const bytes = await fs.readFile(file);
  if (sha256(bytes) !== t.sha256) throw new Error(`texture ${t.id} hash mismatch`);
  const python = process.env.MIDIO_GDAL_PYTHON || 'python3';
  const rgba = execFileSync(python, ['-c',
    'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGBA"); sys.stdout.buffer.write(im.tobytes())', file],
  { maxBuffer: 1 << 28 });
  if (rgba.byteLength !== t.width * t.height * 4) throw new Error(`texture ${t.id} decoded ${rgba.byteLength} bytes`);
  return { id: t.id, width: t.width, height: t.height, metersPerTile: t.metersPerTile, mips: heightMips({ width: t.width, height: t.height, rgba }) };
}

export async function buildCompiledTerrain({ viewId = COMPILED_PILOT.viewId, profile = 'default', outDir = null,
  verify = false, allowDemMismatch = false, log = console.log } = {}) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`unknown profile ${profile} (${Object.keys(PROFILES).join(', ')})`);
  outDir ??= path.join(RUNTIME_DIR, 'compiled', ...(profile === 'default' ? [] : [profile]));
  const view = catalog.views.find(v => v.id === viewId);
  if (!view) throw new Error(`no catalog view ${viewId}`);
  const authoring = (await readAuthoring()).views.find(v => v.id === viewId);
  if (!authoring) throw new Error(`no authoring view ${viewId}`);
  const terrainFile = path.join(RUNTIME_DIR, view.terrainManifestUrl);
  const original = await verifiedJson(terrainFile, view.terrainManifestSha256, 'terrain manifest');
  const materialFile = path.join(RUNTIME_DIR, view.materialManifestUrl);
  const material = await verifiedJson(materialFile, view.materialManifestSha256, 'material manifest');

  const t0 = performance.now();
  const grid = await loadViewGrid(authoring, { log });
  const demSha256 = grid.meta?.payload?.heights?.sha256;
  if (demSha256 !== original.json.source.demSha256) {
    const msg = `${viewId}: DEM ${demSha256} differs from the shipped package's ${original.json.source.demSha256}`;
    if (!allowDemMismatch) throw new Error(`${msg} (pass --allow-dem-mismatch to compile anyway)`);
    log(`warning: ${msg}`);
  }
  if (!grid.valid.every(Boolean)) log(`${viewId}: ${grid.valid.filter(v => !v).length} no-data samples stay holes`);
  const despiked = despikeGrid(grid);
  log(`${viewId}: DEM ${grid.width}x${grid.height} at ${grid.cellSizeM} m, despiked ${despiked} sample(s)`);

  const mat = bakeMaterial(material.json, view.materialRules || {});
  for (const role of ['rockDetail', 'snow']) {
    const t = material.json.textures[role];
    if (t) mat.textures[role] = await loadTexture(materialFile, t);
  }
  const terrainPayload = path.join(path.dirname(terrainFile), original.json.payload.url);
  const identity = {
    demSha256, validSha256: grid.meta?.payload?.valid?.sha256 ?? null, despikedSamples: despiked,
    provenance: grid.provenance,
    terrainPackage: { manifestUrl: view.terrainManifestUrl, manifestSha256: original.sha256,
      payloadSha256: sha256(await fs.readFile(terrainPayload)), tiles: original.json.tiles.length },
    material: { manifestUrl: view.materialManifestUrl, sha256: material.sha256, palette: material.json.palette,
      rules: { ...material.json.rules, ...(view.materialRules || {}) },
      textures: Object.fromEntries(['rockDetail', 'snow'].map(r => [r, material.json.textures[r]?.sha256 ?? null])) },
  };
  const options = {
    settings: PROFILES[profile], cameras: Object.keys(COMPILED_PILOT.cameras), original: original.json, identity,
    heightRangeM: [original.json.boundsM.min[1], original.json.boundsM.max[1]],
    ...(authoring.water === false ? { water: false } : {}),
  };
  if (view.riverPolicy?.terrainWater !== 'mapped-only') throw new Error(`${viewId}: compiled packs draw no terrain water; only mapped-only views are supported`);
  const tPrep = performance.now();
  const { packs } = compileTerrainPacks(grid, view, mat, options);
  const tCompile = performance.now();
  if (verify) {
    const again = compileTerrainPacks(grid, view, mat, options).packs;
    for (const k of Object.keys(packs)) {
      if (!packs[k].payload.equals(again[k].payload) || JSON.stringify(packs[k].manifest) !== JSON.stringify(again[k].manifest)) {
        throw new Error(`${k}: a second compile differs`);
      }
    }
    log('verify: a second compile produced identical manifests and payloads');
  }
  await fs.mkdir(outDir, { recursive: true });
  const report = { compilerVersion: COMPILER_VERSION, viewId, profile, sourceMs: Math.round(tPrep - t0), compileMs: Math.round(tCompile - tPrep), packs: {} };
  for (const [rep, pack] of Object.entries(packs)) {
    const manifestText = JSON.stringify(pack.manifest) + '\n';
    const manifestFile = path.join(outDir, path.basename(compiledManifestPath(viewId, rep)));
    await fs.writeFile(manifestFile, manifestText);
    await fs.writeFile(path.join(outDir, pack.manifest.payload.url), pack.payload);
    report.packs[rep] = { manifest: path.relative(root, manifestFile), manifestSha256: sha256(manifestText), manifestBytes: Buffer.byteLength(manifestText),
      payloadSha256: pack.manifest.payload.sha256, stats: pack.manifest.stats, coverage: pack.manifest.coverage, deform: pack.manifest.deform };
    const st = pack.manifest.stats;
    log(`${rep}: ${st.chunks} chunks (levels ${JSON.stringify(st.levels)}, bands ${JSON.stringify(st.bands)}), ${st.vertices} vertices, ${st.triangles} triangles, payload ${(st.bytes.payload / 1024).toFixed(0)} KiB gz / ${(st.bytes.decoded / 1024).toFixed(0)} KiB, manifest ${(Buffer.byteLength(manifestText) / 1024).toFixed(0)} KiB`);
  }
  await fs.writeFile(path.join(outDir, `${viewId}.compiled-build.json`), JSON.stringify(report, null, 1) + '\n');
  log(`source ${report.sourceMs} ms, compile ${report.compileMs} ms -> ${path.relative(root, outDir)}`);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  await buildCompiledTerrain({
    viewId: opt('--view') || COMPILED_PILOT.viewId, profile: opt('--profile') || 'default',
    outDir: opt('--out') ? path.resolve(opt('--out')) : undefined,
    verify: args.includes('--verify'), allowDemMismatch: args.includes('--allow-dem-mismatch'),
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
