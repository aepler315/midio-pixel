// Re-bake the terrain under a published shot library from the view's DEM,
// keeping the library itself (docs/ross-lake-terrain-rebuild-2026-11-03.md).
//
//   node tools/rebake-tour-terrain.mjs --view <id> [--check]
//
// tools/align-tour-terrain.mjs brings a tour package in line with the fixed
// bake when its samples already match the rail package; this tool is for a
// view whose tour package came from a different grid. It needs the view's
// rail-only package published from the same grid first
// (node tools/build-range-scene.mjs --view <id> --publish), so that the
// rail-only bake reproduces the shipped package byte for byte: every tile
// the rail ships keeps its heights, and the tiles only the tour sees come
// from the same grid. It then bakes rail + library poses with the current
// bake (tools/build-scenic-tours.mjs bakeForLibrary), checks coverage and
// the region's budget, binds the library to the new terrain and publishes
// both as a candidate. Base and tour approval stay separate, reviewed steps
// (tools/build-range-scene.mjs --approve / --approve-tour). --check reports
// the bake and its budget and writes nothing.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadViewContext } from './lib/scenic-terrain.mjs';
import { bakeForLibrary, budgetCap, budgetErrors, forestBuild, publishView, regionConfig, CONFIG } from './build-scenic-tours.mjs';
import { decodeShotLibrary } from '../src/world/terrain/ShotLibrary.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(root, 'src', 'assets', 'range', 'v2');
const sha = (x) => createHash('sha256').update(x).digest('hex');

/** The re-baked terrain and the library bound to it, as publishView takes
 *  them, plus the budget report. Throws when the view can't be re-baked
 *  safely: no library, a shipped tour bake, source drift, or holes. */
export async function rebakeTourTerrain(viewId, { log = console.log } = {}) {
  const ctx = await loadViewContext(viewId);
  if (!ctx.view.shotsManifestUrl) throw new Error(`${viewId}: no published shot library (shotsManifestUrl)`);
  if (ctx.terrain.manifest.lod?.poses) {
    throw new Error(`${viewId}: the shipped package is already a tour bake; publish the rail-only package first (node tools/build-range-scene.mjs --view ${viewId} --publish)`);
  }
  const config = regionConfig(JSON.parse(await fs.readFile(CONFIG, 'utf8')), viewId);
  const shotsFile = path.join(RUNTIME, ctx.view.shotsManifestUrl);
  const shots = JSON.parse(await fs.readFile(shotsFile, 'utf8'));
  const payload = await fs.readFile(path.join(path.dirname(shotsFile), path.basename(shots.payload.url)));
  if (sha(payload) !== shots.payload.sha256) throw new Error(`${viewId}: shot payload sha differs from its manifest`);
  const bytes = zlib.gunzipSync(payload);
  const library = decodeShotLibrary(shots, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  log(`${viewId}: ${library.shots.length} shots, ${library.links.length} links`);
  const bake = await bakeForLibrary(ctx, library, config, { log });
  if (!bake.rebaked) throw new Error(`${viewId}: the shipped package already covers the library; nothing to re-bake`);
  if (bake.budget.sourceDrift) throw new Error(`${viewId}: the rail-only bake differs from the shipped package (source drift); not re-baked`);
  if (!bake.validation.ok) throw new Error(`${viewId}: ${bake.validation.holes.length} poses with holes, ${bake.validation.lod.length} LOD violations in the re-baked package`);
  const manifest = { ...shots, terrainManifestSha256: sha(bake.manifestText) };
  const packed = { manifest, manifestText: JSON.stringify(manifest) + '\n', payload };
  const forest = await forestBuild(ctx, bake.data, library);
  const budget = await budgetErrors(ctx, config, packed, bake, forest);
  const railTiles = bake.manifest.tiles.filter((t) => t.rail !== false).length;
  const of = (v) => (budgetCap(v) === Infinity ? 'no cap' : v);
  log(`${viewId}: ${bake.manifest.tiles.length} tiles (${railTiles} rail), adds ${budget.added} bytes (${of(config.budget.assetBytes)}); desktop ${bake.budget.desktopTriangles} (${of(config.budget.desktopTriangles)}), mobile ${bake.budget.mobileTriangles} (${of(config.budget.mobileTriangles)}) triangles; forest ${(budget.forest.tour / 2 ** 20).toFixed(1)} MiB (${budget.forest.cap === Infinity ? 'no cap' : `${(budget.forest.cap / 2 ** 20).toFixed(1)} MiB`})`);
  return { library, bake, packed, budget, failed: budget.errors.length > 0 };
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const viewId = opt('--view');
  if (!viewId) throw new Error('usage: node tools/rebake-tour-terrain.mjs --view <id> [--check]');
  const fitted = await rebakeTourTerrain(viewId);
  if (fitted.failed) throw new Error(`${viewId}: over budget: ${fitted.budget.errors.join('; ')}`);
  if (args.includes('--check')) return;
  await publishView(viewId, fitted);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
