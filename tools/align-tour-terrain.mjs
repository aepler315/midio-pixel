// Bring a shipped tour-baked terrain package in line with the fixed tour
// bake (tools/lib/terrain-bake.mjs) without a DEM rebake, from the view's
// rail-only package (docs/camera-tour-promotion-2026-11-03.md).
//
//   node tools/align-tour-terrain.mjs --rail-rev <git rev> [--view <id>|all] [--check]
//
// A tour bake is a superset of the view's rail-only bake on the same grid.
// The fixed bake gives every tile the rail sees the rail-only package's
// band and never a coarser level than that package (per budget, the finer
// of the two), marks the tiles only a tour pose sees rail: false, and
// records the rail tiles' bounds as railBoundsM. This tool applies exactly
// that to a package baked before the fix: where the rail package stores a
// tile finer than the tour package, the rail package's samples (the same
// DEM samples, checked) replace it. Heights, flow and tile order otherwise
// stay as baked. It refuses a view whose shared samples differ (source
// drift: rebake from the DEM instead).
//
// It rewrites the terrain payload and manifest, the build record, the shot
// library's terrain identity and the region's library identity (status back
// to candidate), then regenerates the catalog. Base and tour approval stay
// separate steps (tools/build-range-scene.mjs --approve / --approve-tour).
// --check reports what would change and writes nothing.
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
const gunzip = (gz) => { const b = zlib.gunzipSync(gz); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const key = (t) => `${t.ix},${t.iz}`;

/** gzip exactly as bakeTerrain writes it (level 9, zeroed mtime, OS 255). */
export function bakeGzip(decoded) {
  const payload = zlib.gzipSync(decoded, { level: 9, mtime: 0 });
  payload[4] = payload[5] = payload[6] = payload[7] = 0;
  payload[9] = 255;
  return payload;
}

/** Throw unless every sample the coarser of two decoded copies of a tile
 *  stores matches the finer copy's sample at the same lattice point
 *  (height and flow; invalid in both counts as equal). */
function checkSharedSamples(a, b, cells, toleranceM) {
  const [fine, coarse] = a.stride <= b.stride ? [a, b] : [b, a];
  const r = coarse.stride / fine.stride;
  for (let v = 0; v < coarse.samples; v++) for (let u = 0; u < coarse.samples; u++) {
    const i = v * coarse.samples + u, j = v * r * fine.samples + u * r;
    const x = coarse.heightsM[i], y = fine.heightsM[j];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (!(Math.abs(x - y) <= toleranceM)) throw new Error(`source drift at tile ${key(a)} (${x} vs ${y} m): rebake from the DEM`);
    if (coarse.flowBytes[i] !== fine.flowBytes[j]) throw new Error(`flow differs at tile ${key(a)}: rebake from the DEM`);
  }
  if (cells % coarse.stride) throw new Error(`tile ${key(a)} stride`);
}

/** The bake's estimatedBytes for one budget. */
function estimate(tiles, cells, grid, budget) {
  let vertices = 0, triangles = 0;
  for (const t of tiles) {
    if (!t.visible) continue;
    const m = cells / t.lod[budget];
    vertices += (m + 1) * (m + 1);
    triangles += 2 * m * m;
  }
  return { vertices, triangles, meshBytes: vertices * 12 + triangles * 3 * 4,
    surfaceTextureBytes: Math.round(grid.width * grid.height * 4 * 4 / 3) };
}

/**
 * The tour package (`tour` = { manifest, gz }) aligned with the rail-only
 * package (`rail` = { manifest, gz }). Returns { manifest, payload,
 * decoded, stats } or throws (different grids or quantization, a rail tile
 * missing from the tour package, a rail package that is itself a tour
 * bake, or source drift at a shared sample).
 */
export function alignTourToRail(tour, rail, { toleranceM = 1e-3 } = {}) {
  const T = tour.manifest, R = rail.manifest;
  if (R.lod?.poses) throw new Error('the rail package is itself a tour bake');
  if (!T.lod?.poses) throw new Error('not a tour bake');
  for (const k of ['grid', 'tileCells', 'tilesX', 'tilesZ', 'quantization', 'bands']) {
    if (JSON.stringify(T[k]) !== JSON.stringify(R[k])) throw new Error(`rail and tour packages differ in ${k}`);
  }
  const tourBytes = gunzip(tour.gz), railBytes = gunzip(rail.gz);
  const tourData = decodeTerrain(T, tourBytes), railData = decodeTerrain(R, railBytes);
  const railTiles = new Map(R.tiles.map((t) => [key(t), t]));
  for (const k of railTiles.keys()) if (!tourData.byIndex.has(k)) throw new Error(`rail tile ${k} is missing from the tour package`);
  const cells = T.tileCells;
  const chunks = [];
  let byteOffset = 0;
  const copy = (bytes, range) => {
    const at = byteOffset;
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset + range.byteOffset, range.byteLength));
    byteOffset += range.byteLength;
    return { ...range, byteOffset: at };
  };
  const stats = { railTiles: 0, tourOnly: 0, rebanded: 0, spliced: 0, finerLod: 0 };
  const tiles = T.tiles.map((t) => {
    const r = railTiles.get(key(t));
    if (!r) {
      // Only a tour pose sees it: unchanged, marked for the runtime.
      stats.tourOnly++;
      // Its own rail mark (if any) is replaced, after the other fields.
      const rest = { ...t };
      delete rest.rail; delete rest.errorsM;
      const { errorsM } = t;
      const out = { ...rest, heights: copy(tourBytes, t.heights), flow: copy(tourBytes, t.flow),
        validity: t.validity.mode === 'bits' ? copy(tourBytes, t.validity) : t.validity, rail: false, errorsM };
      return out;
    }
    stats.railTiles++;
    checkSharedSamples(tourData.byIndex.get(key(t)), railData.byIndex.get(key(r)), cells, toleranceM);
    const lod = Object.fromEntries(Object.keys(t.lod).map((b) => [b, Math.min(t.lod[b], r.lod[b])]));
    if (Object.keys(lod).some((b) => lod[b] < t.lod[b])) stats.finerLod++;
    if (r.band !== t.band) stats.rebanded++;
    const fromRail = r.stride < t.stride;
    if (fromRail) stats.spliced++;
    const src = fromRail ? r : t, bytes = fromRail ? railBytes : tourBytes;
    const stride = Math.min(...Object.values(lod));
    if (stride !== src.stride) throw new Error(`tile ${key(t)}: stride ${stride} is not the stored ${src.stride}`);
    // The bake's key order, so manifests diff cleanly against a rebake.
    return {
      id: t.id, ix: t.ix, iz: t.iz, stride: src.stride, samples: src.samples,
      heights: copy(bytes, src.heights), flow: copy(bytes, src.flow),
      validity: src.validity.mode === 'bits' ? copy(bytes, src.validity) : src.validity,
      minY: t.minY, maxY: t.maxY, visible: t.visible, framing: t.framing, closestM: t.closestM,
      band: r.band, lod, errorsM: src.errorsM,
    };
  });
  const decoded = Buffer.concat(chunks);
  const payload = bakeGzip(decoded);
  const manifest = {};
  for (const [k, v] of Object.entries(T)) {
    if (k === 'railBoundsM') continue;
    if (k === 'tiles') manifest.tiles = tiles;
    else if (k === 'payload') manifest.payload = { ...v, byteLength: payload.byteLength, sha256: sha(payload), decodedByteLength: decoded.byteLength, decodedSha256: sha(decoded) };
    else if (k === 'estimatedBytes') manifest.estimatedBytes = Object.fromEntries(Object.keys(v).map((b) => [b, estimate(tiles, cells, T.grid, b)]));
    else manifest[k] = v;
    if (k === 'boundsM') manifest.railBoundsM = R.boundsM;
  }
  // The rail tiles must now decode to the rail package's own samples.
  const check = decodeTerrain(manifest, decoded);
  for (const [k, r] of railData.byIndex) checkSharedSamples(check.byIndex.get(k), r, cells, 0);
  return { manifest, payload, decoded, stats: { ...stats, tiles: tiles.length } };
}

async function alignView(id, railRev, { write, log }) {
  const terrainFile = path.join(RUNTIME, 'terrain', `${id}.terrain.json`);
  const buildFile = path.join(RUNTIME, 'terrain', `${id}.build.json`);
  const build = JSON.parse(await fs.readFile(buildFile, 'utf8'));
  if (!build.tourFootprint) { log(`${id}: not a tour bake; skipped`); return null; }
  const tourManifest = JSON.parse(await fs.readFile(terrainFile, 'utf8'));
  const tour = { manifest: tourManifest, gz: await fs.readFile(path.join(RUNTIME, 'terrain', tourManifest.payload.url)) };
  const show = (rel) => execFileSync('git', ['show', `${railRev}:${rel}`], { cwd: root, maxBuffer: 1 << 30 });
  const railManifest = JSON.parse(show(`src/assets/range/v2/terrain/${id}.terrain.json`).toString());
  const rail = { manifest: railManifest, gz: show(`src/assets/range/v2/terrain/${railManifest.payload.url}`) };
  const { manifest, payload, stats } = alignTourToRail(tour, rail);
  log(`${id}: ${stats.tiles} tiles (${stats.railTiles} rail, ${stats.tourOnly} tour-only); ${stats.rebanded} re-banded, `
    + `${stats.spliced} rail tiles restored to the rail package's finer samples, ${stats.finerLod} with a finer level`);
  if (!write) return { id, stats };
  const manifestText = JSON.stringify(manifest) + '\n';
  await fs.writeFile(path.join(RUNTIME, 'terrain', manifest.payload.url), payload);
  await fs.writeFile(terrainFile, manifestText);
  const terrainSha = sha(manifestText);
  // The library binds the terrain manifest.
  const shotsFile = path.join(RUNTIME, 'tour', `${id}.shots.json`);
  const shots = JSON.parse(await fs.readFile(shotsFile, 'utf8'));
  shots.terrainManifestSha256 = terrainSha;
  const shotsText = JSON.stringify(shots) + '\n';
  await fs.writeFile(shotsFile, shotsText);
  build.manifestSha256 = terrainSha;
  build.payloadSha256 = manifest.payload.sha256;
  build.payloadBytes = payload.byteLength;
  build.stats = { tiles: manifest.tiles.length, ...manifest.estimatedBytes };
  build.tourFootprint = { ...build.tourFootprint, shotsManifestSha256: sha(shotsText) };
  await fs.writeFile(buildFile, JSON.stringify(build, null, 1) + '\n');
  return { id, stats };
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const railRev = opt('--rail-rev');
  if (!railRev) throw new Error('--rail-rev <git rev> (the rail-only packages) is required');
  const write = !args.includes('--check');
  const { readAuthoring, AUTHORING, TOUR_AUTHORING, shotLibraryIdentity } = await import('./build-range-scene.mjs');
  const doc = await readAuthoring();
  const id = opt('--view') || 'all';
  const ids = id === 'all' ? doc.views.filter((v) => v.shotsManifestUrl && !v.terrainSourceId).map((v) => v.id) : [id];
  const tours = JSON.parse(await fs.readFile(TOUR_AUTHORING, 'utf8'));
  for (const viewId of ids) {
    let result;
    try { result = await alignView(viewId, railRev, { write, log: console.log }); }
    catch (error) { console.log(`${viewId}: NOT aligned: ${error.message}`); continue; }
    if (!result || !write) continue;
    const v = doc.views.find((x) => x.id === viewId);
    const build = JSON.parse(await fs.readFile(path.join(RUNTIME, 'terrain', `${viewId}.build.json`), 'utf8'));
    if (tours.regions?.[viewId]) {
      tours.regions[viewId].library = await shotLibraryIdentity(v, build);
      tours.regions[viewId].status = 'candidate';
      delete tours.regions[viewId].approval;
    }
  }
  if (!write) return;
  await fs.writeFile(TOUR_AUTHORING, JSON.stringify(tours, null, 2) + '\n');
  await fs.writeFile(AUTHORING, JSON.stringify(doc, null, 2) + '\n');
  execFileSync(process.execPath, [path.join(root, 'tools', 'build-range-scene.mjs'), '--catalog'], { stdio: 'inherit' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
