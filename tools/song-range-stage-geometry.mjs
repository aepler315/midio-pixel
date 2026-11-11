// How much geometry does runtime stage assembly keep that an offline bake of
// the same layout drops? (Frame cost audit, docs/frame-cost-audit-2026-11-10.md.)
//
//   node tools/song-range-stage-geometry.mjs [--out FILE]
//
// The three Phase 1 pilot stages were baked offline with the catalog baker's
// rail visibility and occlusion tests (tools/lib/terrain-bake.mjs). Runtime
// assembly (src/world/alpine/StageAssembly.js) builds the same layouts from
// massif pieces and keeps every tile. This compares tiles, triangles per LOD
// budget and strides, and counts the runtime tiles the offline bake never
// kept. Pure CPU in Node: no GPU, frame-rate or device claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSongRangeStage, songRangeView } from '../src/world/alpine/StageAssembly.js';
import { loadTerrainPackage, sha256Hex } from '../src/world/alpine/RangeAssets.js';
import { pilotPlan } from '../src/world/terrain/SongRangePlan.js';
import MASSIF_CATALOG from '../src/world/terrain/massifCatalogData.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = pathToFileURL(path.join(root, 'src/assets/range/v2/')).href;
const diskFetch = async (url) => new Response(await fs.readFile(fileURLToPath(url)));

const strideOf = (tile, budget) => tile.lod?.[budget] ?? tile.stride;
const tileTriangles = (manifest, tile, budget) => 2 * (manifest.tileCells / strideOf(tile, budget)) ** 2;

/** Tiles, triangles per budget and the stride histogram of a manifest. */
export function geometrySummary(manifest) {
  const out = { tiles: manifest.tiles.length, visibleTiles: manifest.tiles.filter((t) => t.visible !== false).length, triangles: {}, strides: {} };
  for (const budget of ['desktop', 'mobile']) {
    out.triangles[budget] = 0;
    out.strides[budget] = {};
    for (const tile of manifest.tiles) {
      if (tile.visible === false) continue;
      out.triangles[budget] += tileTriangles(manifest, tile, budget);
      out.strides[budget][strideOf(tile, budget)] = (out.strides[budget][strideOf(tile, budget)] || 0) + 1;
    }
  }
  return out;
}

export async function compareLayout(id) {
  const offline = await loadTerrainPackage(new URL(`terrain/${id}.terrain.json`, baseUrl).href, { fetchImpl: diskFetch });
  const view = songRangeView(pilotPlan(id, 'CONIFER'), { catalog: MASSIF_CATALOG, sceneCatalog: SCENE_CATALOG });
  const runtime = await loadSongRangeStage(view, { catalog: MASSIF_CATALOG, baseUrl, fetchImpl: diskFetch, loadPackage: loadTerrainPackage, sha256Hex });
  const kept = new Set(offline.manifest.tiles.map((t) => `${t.ix},${t.iz}`));
  const extra = { tiles: 0, triangles: { desktop: 0, mobile: 0 } };
  for (const tile of runtime.manifest.tiles) {
    if (tile.visible === false || kept.has(`${tile.ix},${tile.iz}`)) continue;
    extra.tiles++;
    for (const budget of ['desktop', 'mobile']) extra.triangles[budget] += tileTriangles(runtime.manifest, tile, budget);
  }
  return { id, offline: geometrySummary(offline.manifest), runtime: geometrySummary(runtime.manifest), runtimeOnly: extra };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : null;
  const rows = [];
  for (const id of ['song-range-pilot-a', 'song-range-pilot-b', 'song-range-pilot-c']) {
    const row = await compareLayout(id);
    rows.push(row);
    console.log(id);
    for (const [label, g] of [['offline bake', row.offline], ['runtime', row.runtime]]) {
      console.log(`  ${label.padEnd(12)} ${String(g.visibleTiles).padStart(4)} tiles drawn  desktop ${String(g.triangles.desktop).padStart(8)} triangles`
        + `  mobile ${String(g.triangles.mobile).padStart(8)}  desktop strides ${JSON.stringify(g.strides.desktop)}`);
    }
    const share = (100 * row.runtimeOnly.triangles.desktop / row.runtime.triangles.desktop).toFixed(0);
    console.log(`  runtime tiles the offline bake dropped: ${row.runtimeOnly.tiles} tiles, ${row.runtimeOnly.triangles.desktop} desktop triangles (${share}% of the runtime stage)`);
  }
  if (out) {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify({ note: 'Geometry counts from Node; no GPU, frame-rate or device claim.', rows }, null, 2)}\n`);
    console.log(`report: ${path.relative(root, out)}`);
  }
}
