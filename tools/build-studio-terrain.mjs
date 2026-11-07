#!/usr/bin/env node
// Bundle real coarse Terrarium DEMs beside the app: the editor never needs
// cross-origin terrain access for any camera in the discovery collection.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { candidateBounds, createTileLoader, loadDiscoveryGrid } from './lib/view-discovery.mjs';
import { tilesForBbox } from './lib/terrarium.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;

export function packStudioGrid(grid) {
  if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
    || grid.width < 2 || grid.height < 2 || grid.width > 257 || grid.height > 257
    || grid.heightsM?.length !== grid.width * grid.height
    || ![grid.west, grid.south, grid.east, grid.north, grid.cellM].every(Number.isFinite)
    || !(grid.west < grid.east && grid.south < grid.north && grid.cellM > 0)
    || grid.west < -180 || grid.east > 180 || grid.south < -85 || grid.north > 85
    || typeof grid.source !== 'string' || !grid.source || !Array.isArray(grid.tileHashes)) {
    throw new Error('Invalid bounded terrain grid or missing source provenance');
  }
  const bytes = Buffer.alloc(grid.width * grid.height * 2);
  let missing = 0, minHeightM = Infinity, maxHeightM = -Infinity;
  for (let index = 0; index < grid.heightsM.length; index++) {
    const height = grid.heightsM[index];
    if (!Number.isFinite(height)) { bytes.writeInt16LE(-32768, index * 2); missing++; continue; }
    const rounded = Math.round(height);
    if (rounded <= -32768 || rounded > 32767) throw new Error('Terrain elevation is outside the signed 16-bit metre range');
    bytes.writeInt16LE(rounded, index * 2);
    minHeightM = Math.min(minHeightM, rounded); maxHeightM = Math.max(maxHeightM, rounded);
  }
  if (missing === grid.heightsM.length) throw new Error('Terrain source has entirely missing coverage');
  return { schema: 'midio.studio-terrain', version: 1, encoding: 'gzip-int16-le',
    noDataValue: -32768, width: grid.width, height: grid.height,
    west: grid.west, south: grid.south, east: grid.east, north: grid.north,
    cellM: grid.cellM, zoom: grid.zoom, source: grid.source, tileHashes: grid.tileHashes,
    attribution: { provider: 'Mapzen / AWS Terrain Tiles', url: 'https://registry.opendata.aws/terrain-tiles/',
      sources: 'USGS 3DEP, SRTM, GMTED and ETOPO; source selection varies by region and zoom' },
    coverage: 1 - missing / grid.heightsM.length, minHeightM, maxHeightM,
    data: gzipSync(bytes, { level: 9 }).toString('base64') };
}

/** Keep the longest grid dimension at 193 cells and each source request at 16 tiles. */
export function studioGridOptions(candidates, { maxDimension = 193, paddingM = 36000, zoom = 8, maxTiles = 16 } = {}) {
  if (!Number.isInteger(maxDimension) || maxDimension < 16 || maxDimension > 257
    || !Number.isInteger(zoom) || zoom < 0 || zoom > 12 || !Number.isInteger(maxTiles) || maxTiles < 1) {
    throw new Error('Invalid studio terrain sample or tile budget');
  }
  const bbox = candidateBounds(candidates, paddingM);
  const widthM = (bbox.east - bbox.west) * 111320 * Math.cos((bbox.north + bbox.south) / 2 * Math.PI / 180);
  const heightM = (bbox.north - bbox.south) * 110540;
  let tiles = tilesForBbox(bbox, zoom);
  while ((tiles.x1 - tiles.x0 + 1) * (tiles.y1 - tiles.y0 + 1) > maxTiles && zoom > 0) tiles = tilesForBbox(bbox, --zoom);
  if ((tiles.x1 - tiles.x0 + 1) * (tiles.y1 - tiles.y0 + 1) > maxTiles) throw new Error('Terrain source cannot fit the requested tile budget');
  return { cellM: Math.max(widthM, heightM) / maxDimension, paddingM, zoom, maxTiles };
}

/** A failed build never publishes an index with nonexistent or substituted terrain. */
export async function buildStudioTerrain({ candidates, out, loadGrid = null, concurrency = 4,
  log = console.log, cacheDir = path.join(root, '.terrain-cache'), maxBytes = MAX_BUNDLE_BYTES } = {}) {
  if (!Array.isArray(candidates) || !out || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('Terrain build requires candidates, output and 1–4 concurrent region loads');
  }
  if (loadGrid !== null && typeof loadGrid !== 'function') throw new Error('Terrain loader must be a function');
  const groups = new Map(), seen = new Set(), unsupported = [];
  for (const candidate of candidates) {
    if (!candidate || !/^[a-z0-9-]+$/.test(candidate.id) || seen.has(candidate.id)) throw new Error('Invalid or duplicate terrain candidate id');
    seen.add(candidate.id);
    if (!candidate.camera) { unsupported.push(candidate.id); continue; }
    const key = candidate.sourceRangeId || candidate.sourceViewId || candidate.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const tileLoader = loadGrid ? null : createTileLoader({ cacheDir, concurrency: 8 });
  const getGrid = loadGrid || (group => loadDiscoveryGrid(group, { tileLoader, ...studioGridOptions(group) }));
  const jobs = [...groups].sort(([a], [b]) => a.localeCompare(b));
  await fs.mkdir(out, { recursive: true });
  const entries = {}, files = new Map(), failures = [];
  let next = 0, totalBytes = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length && !failures.length) {
      const [key, group] = jobs[next++];
      try {
        const grid = await getGrid(group), record = packStudioGrid(grid);
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`), sha256 = hash(bytes);
        const url = `${slug(key)}-${sha256.slice(0, 12)}.json`;
        totalBytes += bytes.length;
        if (totalBytes > maxBytes) throw new Error(`Terrain bundle exceeds its ${maxBytes} byte budget`);
        const file = path.join(out, url), temp = `${file}.tmp-${process.pid}`;
        await fs.writeFile(temp, bytes); await fs.rename(temp, file);
        files.set(url, bytes.length);
        for (const candidate of group) entries[candidate.id] = { url, sha256 };
        log(`${key}: ${group.length} cameras, ${record.width}×${record.height}, z${record.zoom}, ${bytes.length} bytes`);
      } catch (error) { failures.push({ group: key, error: error.message }); }
    }
  }));
  if (failures.length) throw new Error(`Studio terrain build failed: ${failures.map(item => `${item.group}: ${item.error}`).join('; ')}`);
  const index = { schema: 'midio.studio-terrain-index', version: 1,
    generatedWith: { method: 'Real Terrarium DEM, north-up cell-centred resampling, integer metre gzip bundles',
      source: 'https://registry.opendata.aws/terrain-tiles/', paddingM: 36000, maxDimension: 193,
      groups: files.size, supportedCandidates: Object.keys(entries).length, bytes: totalBytes,
      ...(tileLoader ? { tiles: tileLoader.stats } : {}) },
    candidates: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))), unsupported: unsupported.sort() };
  // Retain only files referenced by this index when replacing an earlier build;
  // unrelated files in the destination are never removed.
  let previous = [];
  try {
    const old = JSON.parse(await fs.readFile(path.join(out, 'index.json'), 'utf8'));
    if (old.schema === index.schema) previous = Object.values(old.candidates || {}).map(entry => entry.url)
      .filter(url => typeof url === 'string' && /^[a-z0-9-]+\.json$/.test(url));
  } catch { /* A first build has no previous index. */ }
  const indexFile = path.join(out, 'index.json'), temp = `${indexFile}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(index)}\n`); await fs.rename(temp, indexFile);
  for (const url of new Set(previous)) if (!files.has(url)) await fs.rm(path.join(out, url), { force: true });
  return index;
}

async function main(args) {
  let out = path.join(root, 'src/assets/studio-terrain'), only = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') { console.log('Usage: NODE_USE_ENV_PROXY=1 node tools/build-studio-terrain.mjs [--out directory] [--only source-id,candidate-id]'); return; }
    if (!['--out', '--only'].includes(args[index]) || !args[index + 1]) throw new Error(`Unknown or missing argument: ${args[index]}`);
    const key = args[index++], value = args[index];
    if (key === '--out') out = path.resolve(value);
    else only = value.split(',').filter(Boolean);
  }
  let candidates = JSON.parse(await fs.readFile(path.join(root, 'src/assets/view-discovery/catalog.json'), 'utf8')).candidates;
  if (only) {
    const groups = new Set(candidates.filter(candidate => [candidate.id, candidate.sourceRangeId, candidate.sourceViewId].some(id => only.includes(id)))
      .map(candidate => candidate.sourceRangeId || candidate.sourceViewId || candidate.id));
    candidates = candidates.filter(candidate => groups.has(candidate.sourceRangeId || candidate.sourceViewId || candidate.id));
    if (!candidates.length) throw new Error('No discovery cameras match --only');
  }
  const result = await buildStudioTerrain({ candidates, out });
  console.log(`Bundled ${result.generatedWith.supportedCandidates} cameras in ${result.generatedWith.groups} regions (${result.generatedWith.bytes} bytes).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
