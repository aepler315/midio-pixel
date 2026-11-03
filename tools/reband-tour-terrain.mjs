// Correct the bands of a tour-baked terrain package without a DEM rebake
// (docs/camera-tour-promotion-2026-11-03.md).
//
//   node tools/reband-tour-terrain.mjs --rail-rev <git rev> [--view <id>|all]
//
// Tour bakes before f029289 banded each tile by its closest approach from
// any tour pose, so the rail drew distant crests a shot flies past in its
// mid / near partition. A tour bake is a superset of the view's rail-only
// bake: for every tile the rail-only package at <rail-rev> ships, the rail
// sees it, and the fixed bake bands it exactly as that package does. Tiles
// only a tour pose sees keep their band. Heights, LOD and payload are
// untouched; the tool refuses a view whose shared tiles' heights differ
// from the rail package (source drift: rebake from the DEM instead).
//
// It rewrites the terrain manifest, the build record's hashes, the shot
// library's terrain identity and the region's library identity, then
// regenerates the catalog. Base and tour approval stay separate steps.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(root, 'src', 'assets', 'range', 'v2');
const sha = (x) => createHash('sha256').update(x).digest('hex');
const decode = (manifest, gz) => {
  const bytes = zlib.gunzipSync(gz);
  return decodeTerrain(manifest, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
};

/** Bands of `tour` corrected from `rail` (both decoded with their manifests).
 *  Returns { manifest, changed, shared } or throws on height drift. */
export function rebandFromRail(tourManifest, tourData, railManifest, railData, { toleranceM = 1e-3 } = {}) {
  if (JSON.stringify(tourManifest.grid) !== JSON.stringify(railManifest.grid) || tourManifest.tileCells !== railManifest.tileCells) {
    throw new Error('rail and tour packages use different grids');
  }
  const railBand = new Map(railManifest.tiles.map((t) => [`${t.ix},${t.iz}`, t.band]));
  for (const [key, a] of railData.byIndex) {
    const b = tourData.byIndex.get(key);
    if (!b) throw new Error(`rail tile ${key} is missing from the tour package`);
    if (a.stride !== b.stride) continue;
    for (let i = 0; i < a.heightsM.length; i++) {
      const x = a.heightsM[i], y = b.heightsM[i];
      if (Number.isNaN(x) && Number.isNaN(y)) continue; // invalid in both
      if (!(Math.abs(x - y) <= toleranceM)) throw new Error(`source drift at tile ${key}: rebake from the DEM`);
    }
  }
  let changed = 0;
  const tiles = tourManifest.tiles.map((t) => {
    const band = railBand.get(`${t.ix},${t.iz}`);
    if (band === undefined || band === t.band) return t;
    changed++;
    return { ...t, band };
  });
  return { manifest: { ...tourManifest, tiles }, changed, shared: railBand.size };
}

async function rebandView(id, railRev, log) {
  const terrainFile = path.join(RUNTIME, 'terrain', `${id}.terrain.json`);
  const buildFile = path.join(RUNTIME, 'terrain', `${id}.build.json`);
  const build = JSON.parse(await fs.readFile(buildFile, 'utf8'));
  if (!build.tourFootprint) { log(`${id}: not a tour bake; skipped`); return null; }
  const tourManifest = JSON.parse(await fs.readFile(terrainFile, 'utf8'));
  const tourData = decode(tourManifest, await fs.readFile(path.join(RUNTIME, 'terrain', tourManifest.payload.url)));
  const show = (rel) => execFileSync('git', ['show', `${railRev}:${rel}`], { cwd: root, maxBuffer: 1 << 30 });
  const railManifest = JSON.parse(show(`src/assets/range/v2/terrain/${id}.terrain.json`).toString());
  if (railManifest.lod?.poses) throw new Error(`${id}: the package at ${railRev} is itself a tour bake`);
  const railData = decode(railManifest, show(`src/assets/range/v2/terrain/${railManifest.payload.url}`));
  const { manifest, changed, shared } = rebandFromRail(tourManifest, tourData, railManifest, railData);
  const manifestText = JSON.stringify(manifest) + '\n';
  await fs.writeFile(terrainFile, manifestText);
  const terrainSha = sha(manifestText);
  // The library binds the terrain manifest; its payload is unchanged.
  const shotsFile = path.join(RUNTIME, 'tour', `${id}.shots.json`);
  const shots = JSON.parse(await fs.readFile(shotsFile, 'utf8'));
  shots.terrainManifestSha256 = terrainSha;
  const shotsText = JSON.stringify(shots) + '\n';
  await fs.writeFile(shotsFile, shotsText);
  build.manifestSha256 = terrainSha;
  build.tourFootprint = { ...build.tourFootprint, shotsManifestSha256: sha(shotsText) };
  await fs.writeFile(buildFile, JSON.stringify(build, null, 1) + '\n');
  log(`${id}: ${changed} of ${shared} rail tiles re-banded (${manifest.tiles.length} tiles shipped)`);
  return { id, changed, shared, tiles: manifest.tiles.length };
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const railRev = opt('--rail-rev');
  if (!railRev) throw new Error('--rail-rev <git rev> (the rail-only packages) is required');
  const { readAuthoring, AUTHORING, TOUR_AUTHORING, shotLibraryIdentity } = await import('./build-range-scene.mjs');
  const doc = await readAuthoring();
  const id = opt('--view') || 'all';
  const ids = id === 'all' ? doc.views.filter((v) => v.shotsManifestUrl && !v.terrainSourceId).map((v) => v.id) : [id];
  const tours = JSON.parse(await fs.readFile(TOUR_AUTHORING, 'utf8'));
  for (const viewId of ids) {
    let result;
    try { result = await rebandView(viewId, railRev, console.log); }
    catch (error) { console.log(`${viewId}: NOT re-banded: ${error.message}`); continue; }
    if (!result) continue;
    const v = doc.views.find((x) => x.id === viewId);
    const build = JSON.parse(await fs.readFile(path.join(RUNTIME, 'terrain', `${viewId}.build.json`), 'utf8'));
    if (tours.regions?.[viewId]) {
      tours.regions[viewId].library = await shotLibraryIdentity(v, build);
      tours.regions[viewId].status = 'candidate';
      delete tours.regions[viewId].approval;
    }
  }
  await fs.writeFile(TOUR_AUTHORING, JSON.stringify(tours, null, 2) + '\n');
  await fs.writeFile(AUTHORING, JSON.stringify(doc, null, 2) + '\n');
  execFileSync(process.execPath, [path.join(root, 'tools', 'build-range-scene.mjs'), '--catalog'], { stdio: 'inherit' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
