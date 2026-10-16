// Fetch real elevation for a lon/lat box and write the grid that
// tools/build-terrain-profile.mjs takes. The missing first step of the range
// pipeline: the profile builder always accepted a grid, but nothing produced
// one, so it only ever ran once, by hand, for the Tetons.
//
//   node tools/fetch-terrain-grid.mjs --bbox=W,S,E,N --out=grid.json [--zoom=11] [--cell=200]
//
// Tiles are cached under .terrain-cache/ (gitignored) so rebuilding a range,
// or tuning its camera, does not re-download anything.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERRARIUM_URL, decodePng, resampleGrid, tilesForBbox } from './lib/terrarium.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, '.terrain-cache');
// Decoded tiles, most recently used last. Discovery probes thousands of
// peaks, most of them sharing tiles with a neighbour.
const decoded = new Map();
const DECODED_MAX = 96;

/** Download (or read from the cache) and decode every tile covering the
 *  box. Returns the "x/y" -> decoded PNG map resampleGrid takes. */
export async function loadTiles(bbox, zoom, maxTiles = 400) {
  const { x0, x1, y0, y1 } = tilesForBbox(bbox, zoom);
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > maxTiles) throw new Error(`${count} tiles is too many; shrink the box or lower --zoom`);
  mkdirSync(CACHE, { recursive: true });
  // Download the missing tiles a few at a time first; a range at high
  // latitude needs dozens, and one at a time that is most of the build.
  const missing = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!existsSync(path.join(CACHE, `${zoom}-${tx}-${ty}.png`))) missing.push([tx, ty]);
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, async () => {
    while (next < missing.length) {
      const [tx, ty] = missing[next++];
      const res = await fetch(`${TERRARIUM_URL}/${zoom}/${tx}/${ty}.png`);
      if (!res.ok) throw new Error(`tile ${zoom}/${tx}/${ty}: HTTP ${res.status}`);
      writeFileSync(path.join(CACHE, `${zoom}-${tx}-${ty}.png`), Buffer.from(await res.arrayBuffer()));
    }
  }));
  const tiles = new Map();
  const tileIds = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const id = `${zoom}/${tx}/${ty}`;
      const file = path.join(CACHE, `${zoom}-${tx}-${ty}.png`);
      let png = decoded.get(file);
      if (png) {
        decoded.delete(file); decoded.set(file, png);
        tiles.set(`${tx}/${ty}`, png);
        tileIds.push(`terrarium/${id}`);
        continue;
      }
      png = decodePng(readFileSync(file));
      decoded.set(file, png);
      if (decoded.size > DECODED_MAX) decoded.delete(decoded.keys().next().value);
      tiles.set(`${tx}/${ty}`, png);
      tileIds.push(`terrarium/${id}`);
    }
  }
  return { tiles, tileIds, count };
}

export async function fetchTerrainGrid({ bbox, zoom = 11, cellM = 200, log = () => {} }) {
  const { tiles, tileIds, count } = await loadTiles(bbox, zoom);
  log(`${count} tiles at z${zoom}`);
  const { width, height, elev } = resampleGrid(bbox, zoom, tiles, cellM);
  return {
    ...bbox, width, height, cellM,
    elevB64: Buffer.from(elev.buffer).toString('base64'),
    source: 'AWS Terrain Tiles (terrarium)',
    provider: 'Mapzen / AWS Open Data (USGS 3DEP, SRTM, GMTED, ETOPO by region and zoom)',
    product: `terrarium z${zoom}`,
    tileIds,
    horizontalReference: 'WGS84 (resampled from Web Mercator tiles)',
    verticalReference: 'as supplied per source (approx. mean sea level)',
    elevationUnits: 'meters',
  };
}

function parseBbox(value) {
  const [west, south, east, north] = String(value).split(',').map(Number);
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    throw new Error(`--bbox must be W,S,E,N with W<E and S<N (got ${value})`);
  }
  return { west, south, east, north };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
  const bboxArg = arg('bbox'), out = arg('out');
  if (!bboxArg || !out) {
    console.error('usage: node tools/fetch-terrain-grid.mjs --bbox=W,S,E,N --out=grid.json [--zoom=11] [--cell=200]');
    process.exit(1);
  }
  const grid = await fetchTerrainGrid({
    bbox: parseBbox(bboxArg), zoom: Number(arg('zoom', 11)), cellM: Number(arg('cell', 200)),
    log: (m) => console.log(m),
  });
  writeFileSync(out, JSON.stringify(grid));
  console.log(`wrote ${out}: ${grid.width}x${grid.height} cells of ${grid.cellM}m`);
}
