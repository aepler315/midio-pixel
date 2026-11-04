#!/usr/bin/env node
// Can the song's rise (src/world/alpine/LandRise.js) bring land into the
// frame that a view's terrain package never shipped?
//
// The rise lowers land above the eye toward the horizon. Whatever was hidden
// at full height stays hidden, but land that stood above the top of the
// frame comes down into it, and a package only ships tiles some baked
// frustum saw (tools/lib/terrain-bake.mjs).
//
//   node tools/rise-coverage-check.mjs [--truth] [--poses N] [viewId ...]
//
// Rails: no station may have shipped land above its frame top. By continuity
// that rules out unshipped land there too (land rising past the top crosses
// it inside a tile the bake kept), so nothing outside the package can come
// down. Shot tours fly under ridges and do have land above the frame, so
// they are reported, and with --truth checked against real elevation
// (Terrarium z12, cached in .terrain-cache/): every risen pixel's first true
// hit must lie on a shipped tile. Exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { cameraPoseAt, cameraBasis } from '../src/world/terrain/SceneTravel.js';
import { decodeTerrain, terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { decodeShotLibrary } from '../src/world/terrain/ShotLibrary.js';
import { sampleFootprintPoses } from './lib/scenic-coverage.mjs';
import { LAND_RISE_KNEE, LAND_RISE_START } from '../src/world/alpine/LandRise.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const truth = args.includes('--truth');
const posesAt = args.indexOf('--poses');
const maxPoses = posesAt >= 0 ? Number(args[posesAt + 1]) : 200;
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--poses');
const SINK = 1 - LAND_RISE_START, STATIONS = 21, ASPECT = 16 / 9;

// Tangent of the drawn elevation for a full-height tangent t (the map is a
// function of the elevation alone, LandRise.js), and its inverse.
const squash = t => t <= 0 ? t : (1 - SINK) * t + SINK * LAND_RISE_KNEE * (1 - Math.exp(-t / LAND_RISE_KNEE));
const unsquash = b => { if (b <= 0) return b; let lo = 0, hi = 1e4; for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (squash(m) < b) lo = m; else hi = m; } return hi; };

function load(view) {
  const manifestFile = path.join(root, 'src/assets/range/v2', view.terrainManifestUrl);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const data = decodeTerrain(manifest, new Uint8Array(zlib.gunzipSync(fs.readFileSync(manifestFile.replace('.terrain.json', '.terrain.bin.gz')))));
  const build = JSON.parse(fs.readFileSync(manifestFile.replace('.terrain.json', '.build.json'), 'utf8'));
  return { manifest, data, build };
}

function tourPoses(view) {
  const file = path.join(root, 'src/assets/range/v2/tour', `${view.id}.shots.json`);
  if (!fs.existsSync(file)) return [];
  const lib = decodeShotLibrary(JSON.parse(fs.readFileSync(file, 'utf8')),
    new Uint8Array(zlib.gunzipSync(fs.readFileSync(file.replace('.shots.json', '.shots.bin.gz')))));
  const poses = sampleFootprintPoses([...lib.shots, ...lib.links], { spacingM: 120, maxPoses: 2600 });
  return poses.length <= maxPoses ? poses : Array.from({ length: maxPoses }, (_, k) => poses[Math.round(k * (poses.length - 1) / (maxPoses - 1))]);
}

// Frame rays: per column the world direction of each row (top first).
function* rays(pose, cols, rows) {
  const B = cameraBasis(pose), tv = Math.tan(pose.fovYDeg * Math.PI / 360), th = tv * ASPECT;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const x = ((c + .5) / cols) * 2 - 1, y = rows === 1 ? 1 : 1 - ((r + .5) / rows) * 2;
    const d = B.forward.map((v, i) => v + x * th * B.right[i] + y * tv * B.up[i]);
    const hz = Math.hypot(d[0], d[2]);
    yield { dx: d[0] / hz, dz: d[2] / hz, tan: d[1] / hz };
  }
}

/** Columns of `pose` with shipped land above the frame's top edge. */
function landAboveTop(data, bounds, pose) {
  let columns = 0;
  for (const ray of rays(pose, 48, 1)) {
    for (let r = 30; r < 80000; r *= 1.005) {
      const x = pose.eyeM[0] + ray.dx * r, z = pose.eyeM[2] + ray.dz * r;
      if (x < bounds[0] || x > bounds[2] || z < bounds[1] || z > bounds[3]) break;
      const h = terrainHeightAt(data, x, z);
      if (Number.isFinite(h) && h > pose.eyeM[1] + ray.tan * r) { columns++; break; }
    }
  }
  return columns;
}

async function trueGround(manifest, build) {
  const { loadTiles } = await import('./fetch-terrain-grid.mjs');
  const { lonLatToPixel, terrariumElevation } = await import('./lib/terrarium.mjs');
  // Affine local (x, z) -> (lon, lat) from the landmarks and rail ends.
  const pairs = build.landmarks.map(l => [l.lonLat, l.localM]);
  for (const k of ['eyeStart', 'eyeEnd', 'targetStart', 'targetEnd']) {
    const ll = build.view.rail?.[k]?.lonLat, m = build.view.camera?.[`${k}M`];
    if (ll && m) pairs.push([ll, [m[0], m[2]]]);
  }
  const solve = ys => {
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    pairs.forEach(([, [x, z]], i) => { const row = [1, x, z]; for (let a = 0; a < 3; a++) { A[a][3] += row[a] * ys[i]; for (let c = 0; c < 3; c++) A[a][c] += row[a] * row[c]; } });
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (j !== i) { const f = A[j][i] / A[i][i]; for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k]; }
    return A.map((r, i) => r[3] / r[i]);
  };
  const L = solve(pairs.map(p => p[0][0])), B = solve(pairs.map(p => p[0][1]));
  const toLL = (x, z) => [L[0] + L[1] * x + L[2] * z, B[0] + B[1] * x + B[2] * z];
  const g = manifest.grid, corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) =>
    toLL(g.originM[0] + a * g.width * g.cellSizeM, g.originM[1] + b * g.height * g.cellSizeM));
  const bbox = { west: Math.min(...corners.map(c => c[0])), east: Math.max(...corners.map(c => c[0])),
    south: Math.min(...corners.map(c => c[1])), north: Math.max(...corners.map(c => c[1])) };
  const zoom = 12, { tiles } = await loadTiles(bbox, zoom);
  const pixel = (px, py) => {
    const t = tiles.get(`${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
    if (!t) return NaN;
    const k = (Math.floor(py % 256) * t.width + Math.floor(px % 256)) * t.channels;
    return terrariumElevation(t.data[k], t.data[k + 1], t.data[k + 2]);
  };
  return (x, z) => {
    const { x: px, y: py } = lonLatToPixel(...toLL(x, z), zoom);
    const fx = px - .5, fy = py - .5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    return (1 - ax) * (1 - ay) * pixel(x0, y0) + ax * (1 - ay) * pixel(x0 + 1, y0)
      + (1 - ax) * ay * pixel(x0, y0 + 1) + ax * ay * pixel(x0 + 1, y0 + 1);
  };
}

/** Risen pixels (above the horizon) whose first true hit is not shipped. */
function unshippedPixels(data, bounds, pose, ground, shipped) {
  let missing = 0, total = 0;
  for (const ray of rays(pose, 48, 27)) {
    if (ray.tan <= 0) continue;
    total++;
    const t = unsquash(ray.tan);
    for (let r = 20; r < 80000; r *= 1.003) {
      const x = pose.eyeM[0] + ray.dx * r, z = pose.eyeM[2] + ray.dz * r;
      if (x < bounds[0] || x > bounds[2] || z < bounds[1] || z > bounds[3]) break;
      if (ground(x, z) >= pose.eyeM[1] + t * r) { if (!shipped(x, z)) missing++; break; }
    }
  }
  return { missing, total };
}

let failed = false;
for (const view of catalog.views.filter(v => v.camera && (!ids.length || ids.includes(v.id)))) {
  const { manifest, data, build } = load(view);
  const g = manifest.grid, size = manifest.tileCells * g.cellSizeM;
  const bounds = [g.originM[0], g.originM[1], g.originM[0] + g.width * g.cellSizeM, g.originM[1] + g.height * g.cellSizeM];
  const shipped = (x, z) => data.byIndex.has(`${Math.floor((x - g.originM[0]) / size)},${Math.floor((z - g.originM[1]) / size)}`);
  const stations = Array.from({ length: STATIONS }, (_, k) => cameraPoseAt(view, k / (STATIONS - 1)));
  const railAbove = stations.reduce((n, p) => n + landAboveTop(data, bounds, p), 0);
  const tour = tourPoses(view);
  const tourAbove = tour.reduce((n, p) => n + (landAboveTop(data, bounds, p) > 0 ? 1 : 0), 0);
  const line = [`${view.id.padEnd(30)} rail: ${railAbove ? `FAIL ${railAbove} columns with land above the frame` : 'ok'}`];
  if (railAbove) failed = true;
  if (tour.length) line.push(`tour: ${tourAbove}/${tour.length} poses with land above the frame`);
  if (truth && (tourAbove || railAbove)) {
    const ground = await trueGround(manifest, build);
    let missing = 0, total = 0;
    for (const p of [...stations, ...tour]) { const r = unshippedPixels(data, bounds, p, ground, shipped); missing += r.missing; total += r.total; }
    line.push(`real elevation: ${missing ? `FAIL ${missing}` : '0'}/${total} risen pixels on unshipped tiles`);
    if (missing) failed = true;
  }
  console.log(line.join(' | '));
}
process.exitCode = failed ? 1 : 0;
