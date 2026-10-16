// Compute crest viewpoints for every range in data/ranges.json and write
// data/viewpoints.json. Elevation comes from AWS Terrain Tiles (cached on
// disk in .tile-cache/). Deterministic for a given set of tiles.
//   node tools/compute-viewpoints.mjs [--only id,id] [--zoom-m 90]
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodePng, terrariumToHeights } from '../src/core/png.js';
import { DemGrid } from '../src/core/demgrid.js';
import { findViewpoints } from '../src/core/viewpoints.js';
import { mercatorScale, destination, clamp } from '../src/core/geo.js';
import { fetchTile } from './tile-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const only = opt('only', '')?.split(',').filter(Boolean);
const targetCellM = Number(opt('zoom-m', 90));
const outFile = path.resolve(root, opt('out', 'data/viewpoints.json'));
const MARGIN_M = 47000;

export function zoomFor(lat, cellM = targetCellM) {
  return clamp(Math.round(Math.log2(mercatorScale(lat) / (256 * cellM))), 6, 13);
}

export function expandBbox([w, s, e, n], m) {
  const lat = (s + n) / 2, dLat = m / 111320, dLon = m / (111320 * Math.cos((lat * Math.PI) / 180));
  return [w - dLon, Math.max(-85, s - dLat), e + dLon, Math.min(85, n + dLat)];
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export async function loadGrid(bbox, z) {
  const t = DemGrid.tilesFor(bbox, z);
  const grid = new DemGrid({ z, ...t });
  const jobs = [];
  for (let y = 0; y < t.tilesY; y++) for (let x = 0; x < t.tilesX; x++) jobs.push([t.tx0 + x, t.ty0 + y]);
  await pool(jobs, 12, async ([x, y]) => {
    const png = await fetchTile(z, x, y);
    const img = await decodePng(png, (b) => zlib.inflateSync(b));
    grid.setTile(x, y, terrariumToHeights(img));
  });
  return grid;
}

/** Measure the summit on ~10-20 m data: the maximum within 1.2 km. */
async function refineSummit(summit) {
  const z = zoomFor(summit.lat, 15);
  const pad = 1200;
  const grid = await loadGrid(expandBbox([summit.lon, summit.lat, summit.lon, summit.lat], pad), z);
  const [cx, cy] = grid.toPixel(summit.lon, summit.lat);
  const r = Math.ceil(pad / grid.mpp(summit.lat));
  let best = { h: -Infinity, x: cx, y: cy };
  for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y++) {
    for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x++) {
      if (!grid.inside(x, y) || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const h = grid.data[y * grid.width + x];
      if (h > best.h) best = { h, x, y };
    }
  }
  const [lon, lat] = grid.toLonLat(best.x, best.y);
  return { lon, lat, h: best.h };
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

async function main() {
  const { ranges } = JSON.parse(await fs.readFile(path.join(root, 'data/ranges.json'), 'utf8'));
  let previous = { ranges: [] };
  try { previous = JSON.parse(await fs.readFile(outFile, 'utf8')); } catch { /* first run */ }
  const results = new Map(previous.ranges.map((r) => [r.id, r]));
  const todo = ranges.filter((r) => !only?.length || only.includes(r.id));
  for (const range of todo) {
    const t0 = Date.now();
    const lat = (range.bbox[1] + range.bbox[3]) / 2;
    const z = zoomFor(lat);
    const area = expandBbox(range.bbox, MARGIN_M);
    console.log(`${range.id}: z${z}`);
    const grid = await loadGrid(area, z);
    const { crest, views, evaluated } = findViewpoints(grid, range, { log: console.log });
    const peak = await refineSummit(crest.summit);
    const entry = {
      id: range.id,
      name: range.name,
      region: range.region,
      biome: range.biome,
      landmark: range.landmark ?? null,
      summit: { name: range.summit?.name ?? null, lon: r5(peak.lon), lat: r5(peak.lat), elevationM: range.summit?.elevationM ?? Math.round(peak.h), demElevationM: Math.round(peak.h) },
      crest: { lon: r5(crest.centroid.lon), lat: r5(crest.centroid.lat), axisBearing: r1(crest.axisBearing), lengthM: Math.round(crest.lengthM), reliefM: Math.round(crest.relief) },
      demZoom: z,
      evaluated,
      views: views.map((v) => {
        const [tlon, tlat] = destination(v.eye.lon, v.eye.lat, v.heading, v.features.distanceM);
        return {
          score: r3(v.score),
          eye: { lon: r5(v.eye.lon), lat: r5(v.eye.lat), agl: v.eye.agl, h: Math.round(v.eye.h) },
          heading: r1(v.heading), pitch: r1(v.pitch), hfov: r1(v.hfov),
          target: { lon: r5(tlon), lat: r5(tlat), h: Math.round(grid.heightAt(tlon, tlat)) },
          features: Object.fromEntries(Object.entries(v.features).map(([k, val]) => [k, typeof val === 'number' ? r3(val) : val])),
        };
      }),
    };
    if (!entry.views.length || entry.views[0].score < 0.05) entry.rejected = 'no viewpoint shows the crest well';
    results.set(range.id, entry);
    console.log(`  ${entry.views.length} views, best ${entry.views[0]?.score ?? '-'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    const order = ranges.map((r) => r.id).filter((id) => results.has(id));
    const doc = {
      about: 'Calculated crest viewpoints. Generated by tools/compute-viewpoints.mjs from AWS Terrain Tiles; rerun it rather than editing. heading/pitch/hfov in degrees (hfov for a 16:9 frame); eye.agl is metres above ground, eye.h the computed height above sea level.',
      generatedWith: { cellM: targetCellM, marginM: MARGIN_M },
      ranges: order.map((id) => results.get(id)),
    };
    await fs.writeFile(outFile, JSON.stringify(doc, null, 1) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
