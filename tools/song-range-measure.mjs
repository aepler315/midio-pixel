// What does a composed song range cost at runtime? (Song range composition,
// Phase 3.) CPU-side measurements in Node of the same code the browser runs:
// plan, fetch-equivalent reads, verify, decode, assemble and decode the
// stage, against shipped catalog views.
//
//   node tools/song-range-measure.mjs [--songs N] [--out FILE]
//
// Not a GPU, frame-rate or device measurement. JOYING JY-UTS18N12 remains
// the performance target and is not measured here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { planSongRange } from '../src/world/terrain/SongRangePlan.js';
import { songRangeView, loadSongRangeStage } from '../src/world/alpine/StageAssembly.js';
import { loadTerrainPackage, sha256Hex, terrainCpuBytes } from '../src/world/alpine/RangeAssets.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';
import { syntheticSongs } from './song-range-uniqueness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'src/assets/range/v2/');
const baseUrl = pathToFileURL(assets).href;
let readBytes = 0;
const diskFetch = async (url) => { const b = await fs.readFile(fileURLToPath(url)); readBytes += b.byteLength; return new Response(b); };

const bandTris = (manifest, budget) => {
  const out = { near: 0, mid: 0, far: 0 };
  for (const t of manifest.tiles) { const m = manifest.tileCells / (t.lod?.[budget] ?? t.stride); out[t.band] += 2 * m * m; }
  return out;
};

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const N = Number(opt('--songs', 12));
  const out = path.resolve(opt('--out', path.join(root, '.smoke', 'song-range-measure.json')));
  const stages = [];
  for (const s of syntheticSongs(4000, 11)) {
    if (stages.length >= N) break;
    const plan = planSongRange(s.profile, s.seed);
    if (!plan) continue;
    const view = songRangeView(plan, { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
    readBytes = 0;
    const t0 = performance.now();
    const pkg = await loadSongRangeStage(view, { catalog: MASSIF_CATALOG, baseUrl, fetchImpl: diskFetch, loadPackage: loadTerrainPackage, sha256Hex });
    const ms = performance.now() - t0;
    stages.push({ id: view.id, principal: plan.principal.pieceId, downloadBytes: readBytes, planToPreparedMs: Math.round(ms),
      assembleMs: Math.round(pkg.timings.assembleMs), tiles: pkg.manifest.tiles.length, residentCpuBytes: terrainCpuBytes(pkg.manifest),
      decodedBytes: pkg.bytes.decoded, triangles: { desktop: pkg.manifest.estimatedBytes.desktop.triangles, mobile: pkg.manifest.estimatedBytes.mobile.triangles },
      bands: { desktop: bandTris(pkg.manifest, 'desktop'), mobile: bandTris(pkg.manifest, 'mobile') }, achievedErrorPx: pkg.manifest.lod.achievedErrorPx });
  }
  // Standard views for comparison: the shipped dry-conifer catalog views and the Phase 1 offline stages.
  const standards = [];
  for (const id of ['teton-jackson-lake', 'sawtooth-redfish-north', 'crater-lake-watchman-east', 'song-range-pilot-a']) {
    readBytes = 0;
    const t0 = performance.now();
    const pkg = await loadTerrainPackage(new URL(`terrain/${id}.terrain.json`, baseUrl).href, { fetchImpl: diskFetch });
    const ms = performance.now() - t0;
    standards.push({ id, downloadBytes: readBytes, loadMs: Math.round(ms), tiles: pkg.manifest.tiles.length, residentCpuBytes: terrainCpuBytes(pkg.manifest),
      triangles: { desktop: pkg.manifest.estimatedBytes.desktop.triangles, mobile: pkg.manifest.estimatedBytes.mobile.triangles },
      bands: { desktop: bandTris(pkg.manifest, 'desktop'), mobile: bandTris(pkg.manifest, 'mobile') } });
  }
  const med = (k, f = (x) => x[k]) => { const v = stages.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const summary = { stages: stages.length, medianDownloadBytes: med('downloadBytes'), medianPlanToPreparedMs: med('planToPreparedMs'),
    medianAssembleMs: med('assembleMs'), medianResidentCpuBytes: med('residentCpuBytes'),
    medianTrianglesDesktop: med(null, (x) => x.triangles.desktop), medianTrianglesMobile: med(null, (x) => x.triangles.mobile) };
  const report = { note: 'Node CPU measurements of the browser code path; not GPU, frame-rate or device results.', node: process.version, summary, stages, standards };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  const mib = (b) => (b / 1048576).toFixed(2);
  console.log(`composed ranges (${stages.length}, medians): download ${mib(summary.medianDownloadBytes)} MiB, plan to prepared ${summary.medianPlanToPreparedMs} ms (assembly ${summary.medianAssembleMs} ms), resident ${mib(summary.medianResidentCpuBytes)} MiB, triangles ${summary.medianTrianglesDesktop} desktop / ${summary.medianTrianglesMobile} mobile`);
  for (const s of standards) console.log(`${s.id}: download ${mib(s.downloadBytes)} MiB, load ${s.loadMs} ms, resident ${mib(s.residentCpuBytes)} MiB, ${s.tiles} tiles, triangles ${s.triangles.desktop} desktop / ${s.triangles.mobile} mobile`);
  console.log(`report: ${path.relative(root, out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
