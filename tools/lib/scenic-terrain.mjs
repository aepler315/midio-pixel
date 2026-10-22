// Scenic shot tours (docs/scenic-tours.md): offline terrain access for shot
// authoring. loadViewContext() gathers one view's authoring context -- the
// DEM grid its published package was baked from (despiked and smoothed
// exactly as tools/build-range-scene.mjs buildView does), the decoded
// package itself, water, landmarks, the material rules that place forest
// and the music deformation cap -- and the functions below answer the
// geometric questions every shot generator and scorer asks: heights and
// slopes, canopy, a conservative camera clearance floor and a CPU depth
// raster of what a pose sees.
//
// Local frame: metres, X east, Y up, Z south, origin at the DEM grid
// centre. Nothing here runs at playback.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readDemGrid } from './terrain-source.mjs';
import { despikeGrid, smoothGentleGround, waterMask, TILE_CELLS } from './terrain-bake.mjs';
import { decodeTerrain } from '../../src/world/alpine/TerrainMesh.js';
import { RULE_DEFAULTS } from '../../src/world/alpine/MaterialPackage.js';
import { LAND_MAX_DISPLACEMENT_M } from '../../src/world/alpine/LandMotionLimits.js';
import { cameraBasis } from '../../src/world/terrain/SceneTravel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEG = Math.PI / 180;
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Effective earth radius for refraction-corrected curvature (k = 0.13),
 *  as tools/lib/view-quality.mjs. */
export const CURVATURE_RADIUS_M = 6371000 / (1 - 0.13);
/** Range camera near plane (metres of view depth). */
export const NEAR_M = 20;
/** Tallest tree ForestCover grows at treeScale 1 (its tallest species is
 *  32 m; tours cap trees at 35 m), so canopy = min(cap, this * treeScale). */
const TALLEST_TREE_M = 35;
// ForestCover jitters its limits per stand: treeline +-110 m, forest floor
// +-100 m, max slope +-3 deg. Canopy is widened to the outer edge of each.
const TREELINE_JITTER_M = 110, FLOOR_JITTER_M = 100, SLOPE_JITTER_DEG = 3;

// Material pack per biome; mirrors tools/build-range-scene.mjs DEFAULT_PACKS
// (not exported there).
const DEFAULT_PACKS = {
  RAINFOREST: 'wet-conifer', CONIFER: 'dry-conifer', TAIGA: 'taiga', ICEFIELD: 'icefield', TUNDRA: 'tundra',
  PINE_OAK: 'pine-oak', BROADLEAF: 'broadleaf', CHAPARRAL: 'chaparral', STEPPE: 'steppe', CANYON: 'canyon', DESERT: 'desert',
};

// ---------------------------------------------------------------------------
// Transverse Mercator (Krueger series to n^4: sub-millimetre within a few
// hundred km of the central meridian) from the grid's PROJ string, then the
// grid's source -> local affine.

const tmercCache = new Map();
function tmerc(crs) {
  if (tmercCache.has(crs)) return tmercCache.get(crs);
  if (!/\+proj=tmerc\b/.test(crs || '')) throw new Error(`unsupported horizontal CRS: ${crs}`);
  const num = (keys, fallback) => {
    for (const k of keys) {
      const m = crs.match(new RegExp(`\\+${k}=([-+0-9.eE]+)`));
      if (m) return Number(m[1]);
    }
    return fallback;
  };
  // NAD83 is on GRS80; WGS84 differs from it by 0.1 mm in b.
  const wgs = /\+(datum|ellps)=WGS84\b/.test(crs);
  const a = num(['a'], 6378137);
  const rf = num(['rf'], wgs ? 298.257223563 : 298.257222101);
  const f = 1 / rf, n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
  const p = {
    lat0: num(['lat_0'], 0) * DEG, lon0: num(['lon_0'], 0), k0: num(['k_0', 'k'], 1),
    x0: num(['x_0'], 0), y0: num(['y_0'], 0), e: Math.sqrt(f * (2 - f)),
    A: (a / (1 + n)) * (1 + n2 / 4 + n4 / 64),
    alpha: [n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180, (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440,
      (61 * n3) / 240 - (103 * n4) / 140, (49561 * n4) / 161280],
    beta: [n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360, n2 / 48 + n3 / 15 - (437 * n4) / 1440,
      (17 * n3) / 480 - (37 * n4) / 840, (4397 * n4) / 161280],
    delta: [2 * n - (2 * n2) / 3 - 2 * n3 + (116 * n4) / 45, (7 * n2) / 3 - (8 * n3) / 5 - (227 * n4) / 45,
      (56 * n3) / 15 - (136 * n4) / 35, (4279 * n4) / 630],
  };
  // Northing of lat_0 on the central meridian (eta = 0): subtracted so the
  // projection's false origin is at lat_0.
  const t0 = Math.sinh(Math.atanh(Math.sin(p.lat0)) - p.e * Math.atanh(p.e * Math.sin(p.lat0)));
  const xi0 = Math.atan(t0);
  p.N0 = p.k0 * p.A * p.alpha.reduce((s, al, j) => s + al * Math.sin(2 * (j + 1) * xi0), xi0);
  tmercCache.set(crs, p);
  return p;
}

function project(p, lon, lat) {
  const phi = lat * DEG, lam = (lon - p.lon0) * DEG;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - p.e * Math.atanh(p.e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = xi, y = eta;
  for (let j = 1; j <= 4; j++) {
    x += p.alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += p.alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return [p.x0 + p.k0 * p.A * y, p.y0 + p.k0 * p.A * x - p.N0];
}

function unproject(p, E, N) {
  const xi = (N - p.y0 + p.N0) / (p.k0 * p.A), eta = (E - p.x0) / (p.k0 * p.A);
  let xp = xi, ep = eta;
  for (let j = 1; j <= 4; j++) {
    xp -= p.beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= p.beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += p.delta[j - 1] * Math.sin(2 * j * chi);
  return [p.lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) / DEG, phi / DEG];
}

/** Local [x, z] (metres) of a [lon, lat] point in the grid's frame. */
export function lonLatToLocal(grid, [lon, lat]) {
  const [E, N] = project(tmerc(grid.horizontalCrs), lon, lat);
  const [a, b, c, d, e, f] = grid.sourceToLocal || [1, 0, 0, 0, -1, 0];
  return [a * E + b * N + c, d * E + e * N + f];
}

/** [lon, lat] of a local [x, z] point (inverse of lonLatToLocal). */
export function localToLonLat(grid, [x, z]) {
  const [a, b, c, d, e, f] = grid.sourceToLocal || [1, 0, 0, 0, -1, 0];
  const det = a * e - b * d;
  const E = (e * (x - c) - b * (z - f)) / det, N = (a * (z - f) - d * (x - c)) / det;
  return unproject(tmerc(grid.horizontalCrs), E, N);
}

// ---------------------------------------------------------------------------
// Point queries on a DemGrid.

/** Bilinear DEM height at local (x, z); NaN outside the grid or when a
 *  corner sample is no-data. */
export function heightAt(grid, x, z) {
  const fx = (x - grid.originM[0]) / grid.cellSizeM, fz = (z - grid.originM[1]) / grid.cellSizeM;
  if (!(fx >= 0 && fz >= 0 && fx <= grid.width - 1 && fz <= grid.height - 1)) return NaN;
  const w = grid.width, c = Math.min(Math.floor(fx), w - 2), r = Math.min(Math.floor(fz), grid.height - 2);
  const i = r * w + c, h = grid.heightsM, v = grid.valid;
  if (v && !(v[i] && v[i + 1] && v[i + w] && v[i + w + 1])) return NaN;
  const tx = fx - c, tz = fz - r;
  return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - tz) + (h[i + w] * (1 - tx) + h[i + w + 1] * tx) * tz;
}

function gradientAt(grid, x, z) {
  const d = grid.cellSizeM;
  const gx = (heightAt(grid, x + d, z) - heightAt(grid, x - d, z)) / (2 * d);
  const gz = (heightAt(grid, x, z + d) - heightAt(grid, x, z - d)) / (2 * d);
  return [gx, gz];
}

/** Terrain slope (degrees) at (x, z) from central differences over one
 *  cell; NaN where a neighbour is missing. */
export function slopeDegAt(grid, x, z) {
  const [gx, gz] = gradientAt(grid, x, z);
  return Math.atan(Math.hypot(gx, gz)) / DEG;
}

/** Unit surface normal [x, y, z] at (x, z); NaNs where a neighbour is missing. */
export function normalAt(grid, x, z) {
  const [gx, gz] = gradientAt(grid, x, z), l = Math.hypot(gx, 1, gz);
  return [-gx / l, 1 / l, -gz / l];
}

// ---------------------------------------------------------------------------
// One view's authoring context.

/** Every lon/lat point buildView converts (rail anchors, then landmarks in
 *  view order): part of the DEM cache key. Mirrors build-range-scene.mjs. */
function viewPoints(view) {
  const pts = {};
  for (const k of ['eyeStart', 'eyeEnd', 'targetStart', 'targetEnd']) {
    const a = view.rail?.[k];
    if (!a?.lonLat) throw new Error(`${view.id}: rail.${k}.lonLat missing (no authored rail to locate its DEM cache)`);
    pts[k] = a.lonLat;
  }
  for (const l of view.landmarks || []) pts[`landmark:${l.name}`] = l.lonLat;
  return pts;
}

/** The cache prefix buildView uses for a view's normalized grid. */
export function demCachePrefix(view, root = ROOT) {
  const key = sha(JSON.stringify({ dem: { ...view.dem, cellM: view.dem.cellM }, points: viewPoints(view) })).slice(0, 16);
  return path.join(root, '.terrain-cache', 'views', `${view.id}-${key}`);
}

/**
 * Load one scenic view's authoring context:
 *   { viewId, sourceId, view, build, camera, grid, terrain: {manifest, data},
 *     landmarks: [{name, lonLat, localM:[x,y,z]}], heightRangeM, deformCapM,
 *     water (Uint8Array per grid sample), materialRules, despikedSamples,
 *     gentleGroundSmoothingM }
 * A view sharing another's terrain (terrainSourceId) uses that view's grid,
 * build record and package, and its own material rules. heightRangeM is the
 * published package's height bounds -- the range the renderer normalizes
 * deformation with (TerrainGL uHeightRange) -- and deformCapM its cap; the
 * clearance floor uses a bound that also holds after a re-bake
 * (deformationMarginM).
 */
export async function loadViewContext(viewId, { root = ROOT } = {}) {
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const doc = JSON.parse(await fs.readFile(path.join(root, 'data', 'terrain', 'scenic-views.json'), 'utf8'));
  const view = doc.views.find((v) => v.id === viewId);
  if (!view) throw new Error(`no view ${viewId} in data/terrain/scenic-views.json`);
  const sourceId = view.terrainSourceId || view.id;
  const source = doc.views.find((v) => v.id === sourceId);
  if (!source?.dem) throw new Error(`${viewId}: terrain source ${sourceId} has no dem block`);
  const terrainDir = path.join(root, 'src', 'assets', 'range', 'v2', 'terrain');
  const readJson = async (file, what) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { throw new Error(`${viewId}: ${what} ${rel(file)} is missing or unreadable (${e.code || e.message})`, { cause: e }); }
  };
  const build = await readJson(path.join(terrainDir, `${sourceId}.build.json`), 'build record');
  const manifest = await readJson(path.join(terrainDir, `${sourceId}.terrain.json`), 'terrain manifest');

  const prefix = demCachePrefix(source, root);
  try { await fs.access(`${prefix}.json`); } catch {
    throw new Error(`${viewId}: DEM grid cache file ${rel(prefix)}.json is missing (run node tools/build-range-scene.mjs --view ${sourceId})`);
  }
  const grid = await readDemGrid(prefix);
  // Exactly buildView's steps, in its order.
  const despikedSamples = despikeGrid(grid);
  const gentleGroundSmoothingM = source.dem.source === 'terrarium' ? smoothGentleGround(grid) : null;

  const payloadFile = path.join(terrainDir, path.basename(manifest.payload.url));
  let compressed;
  try { compressed = await fs.readFile(payloadFile); }
  catch (e) { throw new Error(`${viewId}: terrain payload ${rel(payloadFile)} is missing (${e.code})`, { cause: e }); }
  if (sha(compressed) !== manifest.payload.sha256) throw new Error(`${viewId}: terrain payload hash does not match its manifest`);
  const data = decodeTerrain(manifest, new Uint8Array(zlib.gunzipSync(compressed)));

  const landmarks = [];
  for (const l of build.landmarks || []) {
    if (!Array.isArray(l.localM)) continue;
    const [x, z] = l.localM;
    const y = l.demPeakWithin200mM ?? l.demGroundM ?? heightAt(grid, x, z);
    if (Number.isFinite(y)) landmarks.push({ name: l.name, lonLat: l.lonLat, localM: [x, y, z] });
  }
  const heightRangeM = [manifest.boundsM.min[1], manifest.boundsM.max[1]];
  const deformCapM = Math.min(LAND_MAX_DISPLACEMENT_M, 0.065 * Math.max(0, heightRangeM[1] - heightRangeM[0]));
  const water = source.water === false ? new Uint8Array(grid.width * grid.height)
    : waterMask(grid.heightsM, grid.valid, grid.width, grid.height);
  const pack = view.materialPack || DEFAULT_PACKS[view.biome];
  const packManifest = await readJson(path.join(root, 'src', 'assets', 'range', 'v2', 'materials', `${pack}.json`), 'material pack');
  const materialRules = { ...RULE_DEFAULTS, ...packManifest.rules, ...(view.materialRules || {}) };
  return {
    viewId, sourceId, view, build, camera: build.view?.camera ?? null, grid,
    terrain: { manifest, data }, landmarks, heightRangeM, deformCapM, water, materialRules,
    despikedSamples, gentleGroundSmoothingM,
  };
}

// ---------------------------------------------------------------------------
// Canopy and clearance.

/** Canopy height (m) for ground at height y and slope `slopeDeg`: the tallest
 *  tree the rules can grow there, widened to ForestCover's jittered limits. */
function canopyFor(rules, capM, y, slopeDeg, wet) {
  if (wet || !(rules.forestDensity > 0)) return 0;
  if (y > rules.treelineM + TREELINE_JITTER_M) return 0;
  if (y < (rules.forestFloorM ?? RULE_DEFAULTS.forestFloorM) - FLOOR_JITTER_M) return 0;
  const maxSlope = rules.forestMaxSlopeDeg ?? rules.maxForestSlopeDeg;
  if (Number.isFinite(maxSlope) && slopeDeg > maxSlope + SLOPE_JITTER_DEG) return 0;
  return Math.min(capM, TALLEST_TREE_M * (rules.treeScale ?? RULE_DEFAULTS.treeScale));
}

/** Conservative canopy height (m) at (x, z): the tallest tree the material
 *  rules allow there (rules.treeHeightM or a 35 m cap, scaled by
 *  treeScale), 0 where forest cannot grow (above the treeline, below the
 *  forest floor, too steep, or water on all four surrounding samples). */
export function treeHeightAt(ctx, x, z) {
  const g = ctx.grid, y = heightAt(g, x, z);
  if (!Number.isFinite(y)) return 0;
  let wet = false;
  if (ctx.water) {
    const c = Math.min(Math.floor((x - g.originM[0]) / g.cellSizeM), g.width - 2);
    const r = Math.min(Math.floor((z - g.originM[1]) / g.cellSizeM), g.height - 2), i = r * g.width + c;
    wet = !!(ctx.water[i] && ctx.water[i + 1] && ctx.water[i + g.width] && ctx.water[i + g.width + 1]);
  }
  const slope = slopeDegAt(g, x, z);
  return canopyFor(ctx.materialRules || {}, ctx.materialRules?.treeHeightM ?? 35, y, Number.isFinite(slope) ? slope : 0, wet);
}

const gridLows = new WeakMap();
/** Lowest valid height of a grid (cached; heights must not change afterwards). */
function gridLow(grid) {
  let lo = gridLows.get(grid);
  if (lo === undefined) {
    lo = Infinity;
    for (let i = 0; i < grid.heightsM.length; i++) if ((!grid.valid || grid.valid[i]) && grid.heightsM[i] < lo) lo = grid.heightsM[i];
    gridLows.set(grid, lo);
  }
  return lo;
}

/** Upper bound of the music's terrain displacement at height y for ANY
 *  package baked from this grid (a re-bake can widen the current package's
 *  height range): RangeFrame.sceneDeformation moves terrain by at most
 *  cap * h^2 with cap = min(180, 0.065 (hi - lo)) and h = clamp((y - lo) /
 *  (hi - lo)), and cap * h^2 <= min(180, 0.065 (y - lo)) <= min(180,
 *  0.065 (y - gridLo)) for every package range with lo >= the grid's lowest
 *  sample. */
export function deformationMarginM(ctx, y) {
  return deformBound(gridLow(ctx.grid), y);
}
const deformBound = (lo, y) => Math.min(LAND_MAX_DISPLACEMENT_M, 0.065 * Math.max(0, y - lo));

/**
 * Conservative camera floor on a coarse lattice (cellM spacing, origin at
 * the grid's origin): at each node, the highest terrain + canopy + music
 * deformation (deformationMarginM: safe for any re-bake) over a square
 * footprintM wide around it (plus one DEM cell, since the surface between
 * samples interpolates them), plus minAglM.
 * Canopy (treeHeightM cap) stands wherever the rules' elevation limits and
 * water allow forest, whatever the DEM slope: ForestCover tests slope at
 * each root on the coarser package surface, so cliff tops can carry trees.
 * floorAt(x, z) takes the max of the four surrounding nodes, so it bounds
 * the footprint around every point in between; Infinity outside the grid.
 * Nodes over no-data take the grid's highest floor. groundAt is the bare
 * DEM height (NaN outside or over no-data).
 */
export function buildClearance(ctx, { cellM = 60, minAglM = 70, treeHeightM = 35, footprintM = 120 } = {}) {
  const g = ctx.grid, { width: w, height: hgt, cellSizeM: cs, originM, heightsM: h, valid } = g;
  const extX = (w - 1) * cs, extZ = (hgt - 1) * cs;
  const W = Math.ceil(extX / cellM - 1e-9) + 1, H = Math.ceil(extZ / cellM - 1e-9) + 1;
  const bins = new Float32Array(W * H).fill(-Infinity);
  const rules = ctx.materialRules || {}, water = ctx.water, lo = gridLow(g);
  let top = -Infinity;
  for (let r = 0; r < hgt; r++) {
    const J = Math.round((r * cs) / cellM) * W;
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (valid && !valid[i]) continue;
      const y = h[i];
      if (!Number.isFinite(y)) continue;
      const v = y + canopyFor(rules, treeHeightM, y, 0, water?.[i]) + deformBound(lo, y);
      const k = J + Math.round((c * cs) / cellM);
      if (v > bins[k]) bins[k] = v;
      if (v > top) top = v;
    }
  }
  // Separable max filter over +-k nodes: bin I holds samples within
  // cellM/2 of node I, so k covers footprintM/2 + one DEM cell.
  const k = Math.max(0, Math.ceil((footprintM / 2 + cs - cellM / 2) / cellM));
  const tmp = new Float32Array(W * H), floor = new Float32Array(W * H);
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    let m = -Infinity;
    for (let d = Math.max(0, I - k); d <= Math.min(W - 1, I + k); d++) m = Math.max(m, bins[J * W + d]);
    tmp[J * W + I] = m;
  }
  const fill = (Number.isFinite(top) ? top : 0) + minAglM;
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    let m = -Infinity;
    for (let d = Math.max(0, J - k); d <= Math.min(H - 1, J + k); d++) m = Math.max(m, tmp[d * W + I]);
    floor[J * W + I] = Number.isFinite(m) ? m + minAglM : fill;
  }
  const floorAt = (x, z) => {
    const fx = (x - originM[0]) / cellM, fz = (z - originM[1]) / cellM;
    if (!(x >= originM[0] && z >= originM[1] && x <= originM[0] + extX && z <= originM[1] + extZ)) return Infinity;
    const I0 = Math.min(W - 1, Math.floor(fx)), J0 = Math.min(H - 1, Math.floor(fz));
    const I1 = Math.min(W - 1, I0 + 1), J1 = Math.min(H - 1, J0 + 1);
    return Math.max(floor[J0 * W + I0], floor[J0 * W + I1], floor[J1 * W + I0], floor[J1 * W + I1]);
  };
  return { cellM, originM: [originM[0], originM[1]], width: W, height: H, floor, floorAt, groundAt: (x, z) => heightAt(g, x, z) };
}

// ---------------------------------------------------------------------------
// Depth raster: hierarchical ray marching over a max-height pyramid.

const pyramids = new WeakMap();
/** Max-height pyramid of a grid (cached per grid; heights must not change
 *  afterwards). Level 0 cell (c, r) is the highest of its four corner
 *  samples (-Infinity when any is no-data: such cells are not drawn);
 *  level k cells are 2^k base cells wide. */
export function maxPyramid(grid) {
  let pyr = pyramids.get(grid);
  if (pyr) return pyr;
  const { width: w, height: hgt, heightsM: h, valid } = grid;
  const cw = w - 1, ch = hgt - 1, base = new Float32Array(cw * ch);
  for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
    const i = r * w + c;
    const ok = !valid || (valid[i] && valid[i + 1] && valid[i + w] && valid[i + w + 1]);
    const m = Math.max(h[i], h[i + 1], h[i + w], h[i + w + 1]);
    base[r * cw + c] = ok && Number.isFinite(m) ? m : -Infinity;
  }
  const levels = [{ w: cw, h: ch, data: base }];
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const p = levels.at(-1), W = Math.ceil(p.w / 2), H = Math.ceil(p.h / 2), d = new Float32Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let m = -Infinity;
      for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
        const cc = 2 * c + dc, rr = 2 * r + dr;
        if (cc < p.w && rr < p.h) m = Math.max(m, p.data[rr * p.w + cc]);
      }
      d[r * W + c] = m;
    }
    levels.push({ w: W, h: H, data: d });
  }
  pyr = { levels };
  pyramids.set(grid, pyr);
  return pyr;
}

/** First tau in [0, L] where a ray meets the bilinear cell (c, r): the ray
 *  height is G0 + G1 tau + G2 tau^2 (curvature folded in), the cell
 *  coordinates u0 + du tau, v0 + dv tau, so ray minus surface is quadratic
 *  in tau. -1 when it stays above. */
function cellHit(h, gw, c, r, u0, v0, du, dv, G0, G1, G2, L) {
  const i = r * gw + c, a = h[i], b = h[i + 1] - a, e = h[i + gw] - a, d = a - h[i + 1] - h[i + gw] + h[i + gw + 1];
  const F0 = G0 - (a + b * u0 + e * v0 + d * u0 * v0);
  if (F0 <= 0) return 0;
  const F1 = G1 - (b * du + e * dv + d * (u0 * dv + v0 * du)), F2 = G2 - d * du * dv;
  let best = Infinity;
  if (Math.abs(F2) < 1e-14) { if (F1 < 0) best = -F0 / F1; }
  else {
    const disc = F1 * F1 - 4 * F2 * F0;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const root of [(-F1 - sq) / (2 * F2), (-F1 + sq) / (2 * F2)]) if (root > 0 && root < best) best = root;
    }
  }
  return best <= L ? best : -1;
}

const presence = new WeakMap();
function tilePresence(ctx, tilesX, tilesZ) {
  const data = ctx.terrain?.data;
  if (!data) return null;
  let p = presence.get(data);
  if (!p) {
    p = new Uint8Array(tilesX * tilesZ);
    // Hidden tiles ship but are not drawn (TerrainMesh planBands).
    for (const t of data.tiles.values()) if (t.visible !== false && t.ix < tilesX && t.iz < tilesZ) p[t.iz * tilesX + t.ix] = 1;
    presence.set(data, p);
  }
  return p;
}

/**
 * CPU depth raster of what `pose` ({eyeM, targetM, fovYDeg}; world-up camera
 * basis as SceneTravel.cameraBasis) sees of the full DEM grid, width x height
 * pixels at `aspect`. Rays start at the near plane (NEAR_M view depth) and
 * stop at farM (Euclidean). Each ray skips empty space over the max
 * pyramid (coarser while clear, finer near terrain) and intersects the
 * bilinear DEM cells exactly at the finest level, so single-sample summits
 * and cliff walls are hit wherever the ray actually passes below them.
 * Terrain is lowered by the refraction-corrected earth curvature drop
 * d^2 / 2R (curvature = false disables it; note the renderer itself draws
 * flat terrain). Per pixel:
 *   depth   view-space depth of the hit (Infinity = sky)
 *   dist    Euclidean distance along the ray
 *   hitX/Y/Z  hit point (hitY is the DEM height there)
 *   tile    package tile index iz*tilesX+ix of the hit, -1 = sky
 *   present 1 when that tile is in ctx.terrain.data and drawn (visible !== false;
 *           1 when ctx carries no package)
 *   water   1 when the nearest DEM sample of the hit is water
 *   edge    1 when a downward ray (below the eye's horizontal) left the grid
 *           (or never entered it) before farM without hitting: the frame
 *           shows past the terrain's boundary
 */
export function depthRaster(ctx, pose, { width = 160, height = 90, farM = 60000, aspect = width / height, curvature = true } = {}) {
  const grid = ctx.grid, { width: gw, height: gh, cellSizeM: cs, originM } = grid;
  const { levels } = maxPyramid(grid), top = levels.length - 1;
  const n = width * height;
  const depth = new Float32Array(n).fill(Infinity), dist = new Float32Array(n).fill(Infinity);
  const hitX = new Float32Array(n).fill(NaN), hitY = new Float32Array(n).fill(NaN), hitZ = new Float32Array(n).fill(NaN);
  const tile = new Int32Array(n).fill(-1), present = new Uint8Array(n), water = new Uint8Array(n), edge = new Uint8Array(n);
  const tileCells = ctx.terrain?.manifest?.tileCells || TILE_CELLS;
  const tilesX = ctx.terrain?.manifest?.tilesX || Math.ceil((gw - 1) / tileCells);
  const tilesZ = ctx.terrain?.manifest?.tilesZ || Math.ceil((gh - 1) / tileCells);
  const have = tilePresence(ctx, tilesX, tilesZ);
  const { forward, right, up } = cameraBasis(pose);
  const tanY = Math.tan((pose.fovYDeg * DEG) / 2), tanX = tanY * aspect;
  const [ex, ey, ez] = pose.eyeM;
  const gx0 = (ex - originM[0]) / cs, gz0 = (ez - originM[1]) / cs, cw = gw - 1, ch = gh - 1;
  const invR = curvature ? 1 / (2 * CURVATURE_RADIUS_M) : 0;
  const h = grid.heightsM;
  // Bilinear surface in cell units; NaN over no-data.
  const surf = (fx, fz) => {
    if (!(fx >= 0 && fz >= 0 && fx <= cw && fz <= ch)) return NaN;
    const c = Math.min(Math.floor(fx), cw - 1), r = Math.min(Math.floor(fz), ch - 1);
    if (levels[0].data[r * cw + c] === -Infinity) return NaN;
    const i = r * gw + c, tx = fx - c, tz = fz - r;
    return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - tz) + (h[i + gw] * (1 - tx) + h[i + gw + 1] * tx) * tz;
  };
  for (let py = 0; py < height; py++) {
    const vy = (1 - ((py + 0.5) / height) * 2) * tanY;
    for (let px = 0; px < width; px++) {
      const vx = (((px + 0.5) / width) * 2 - 1) * tanX;
      let dx = forward[0] + right[0] * vx + up[0] * vy, dy = forward[1] + right[1] * vx + up[1] * vy, dz = forward[2] + right[2] * vx + up[2] * vy;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl; dy /= dl; dz /= dl;
      const o = py * width + px, cosF = dx * forward[0] + dy * forward[1] + dz * forward[2];
      const hl = Math.hypot(dx, dz);
      // Horizontal parameter t (metres); ray height y(t) = ey + s*t.
      if (hl < 1e-9) continue;
      const ux = dx / hl / cs, uz = dz / hl / cs, s = dy / hl;
      // Clip to the grid rectangle [0, cw] x [0, ch] (cell units).
      let tIn = -Infinity, tOut = Infinity;
      for (const [g0, u, max] of [[gx0, ux, cw], [gz0, uz, ch]]) {
        if (Math.abs(u) < 1e-15) { if (g0 < 0 || g0 > max) tIn = Infinity; continue; }
        const ta = (0 - g0) / u, tb = (max - g0) / u;
        tIn = Math.max(tIn, Math.min(ta, tb)); tOut = Math.min(tOut, Math.max(ta, tb));
      }
      const farT = farM * hl, leaves = !(tIn <= tOut) || tOut < farT;
      const tA = Math.max((NEAR_M / cosF) * hl, tIn), tB = Math.min(farT, tOut);
      let hitT = -1, t = tA, level = 0;
      while (t < tB) {
        const lv = levels[level], size = 1 << level;
        const t1 = Math.min(tB, t + size * cs);
        const xa = gx0 + ux * t, xb = gx0 + ux * t1, za = gz0 + uz * t, zb = gz0 + uz * t1;
        const c0 = Math.max(0, Math.floor(Math.min(xa, xb) / size)), c1 = Math.min(lv.w - 1, Math.floor(Math.max(xa, xb) / size));
        const r0 = Math.max(0, Math.floor(Math.min(za, zb) / size)), r1 = Math.min(lv.h - 1, Math.floor(Math.max(za, zb) / size));
        let m = -Infinity;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const v = lv.data[r * lv.w + c]; if (v > m) m = v; }
        // Lowest point of the ray over the segment, with the terrain lowered
        // by the (smaller) curvature drop at the segment's near end.
        if (Math.min(ey + s * t, ey + s * t1) + t * t * invR > m) {
          t = t1;
          if (level < top) level++;
          continue;
        }
        if (level > 0) { level--; continue; }
        // Level 0: exact first intersection with each bilinear cell the
        // segment crosses (split where it crosses cell lines).
        const brk = [t, t1];
        for (const [g0, u] of [[gx0, ux], [gz0, uz]]) {
          if (Math.abs(u) < 1e-15) continue;
          const ga = g0 + u * t, gb = g0 + u * t1;
          for (let k = Math.ceil(Math.min(ga, gb)); k <= Math.floor(Math.max(ga, gb)); k++) {
            const tk = (k - g0) / u;
            if (tk > t && tk < t1) brk.push(tk);
          }
        }
        brk.sort((p, q) => p - q);
        for (let k = 0; k + 1 < brk.length && hitT < 0; k++) {
          const ta = brk[k], tb = brk[k + 1], tm = (ta + tb) / 2;
          if (!(tb > ta)) continue;
          const c = Math.min(cw - 1, Math.max(0, Math.floor(gx0 + ux * tm))), r = Math.min(ch - 1, Math.max(0, Math.floor(gz0 + uz * tm)));
          if (levels[0].data[r * cw + c] === -Infinity) continue;
          hitT = cellHit(h, gw, c, r, gx0 + ux * ta - c, gz0 + uz * ta - r, ux, uz, ey + s * ta + invR * ta * ta, s + 2 * invR * ta, invR, tb - ta);
          if (hitT >= 0) hitT += ta;
        }
        if (hitT >= 0) break;
        t = t1;
        level = Math.min(top, 1);
      }
      if (hitT < 0) {
        if (dy < 0 && leaves) edge[o] = 1;
        continue;
      }
      const x = ex + (dx / hl) * hitT, z = ez + (dz / hl) * hitT, along = hitT / hl;
      depth[o] = along * cosF; dist[o] = along;
      hitX[o] = x; hitZ[o] = z;
      const fx = (x - originM[0]) / cs, fz = (z - originM[1]) / cs;
      hitY[o] = surf(fx, fz);
      const ix = Math.min(tilesX - 1, Math.max(0, Math.floor(fx / tileCells))), iz = Math.min(tilesZ - 1, Math.max(0, Math.floor(fz / tileCells)));
      tile[o] = iz * tilesX + ix;
      present[o] = have ? have[tile[o]] : 1;
      if (ctx.water) water[o] = ctx.water[Math.min(gh - 1, Math.round(fz)) * gw + Math.min(gw - 1, Math.round(fx))];
    }
  }
  return { width, height, depth, dist, hitX, hitY, hitZ, tile, present, water, edge };
}
