// Range v2 terrain baker (plan §3.3, Task 3). Turns one normalized DemGrid
// into a compact, validated, multiresolution heightfield package for one
// curated view:
//
//   <view>.terrain.json     manifest (schema midio.terrain v1)
//   <view>.terrain.bin.gz   gzip payload of every tile's samples
//
// Format choice. The plan's default is explicit Float32 position/normal/UV
// buffers. For a real 10-20 m corridor that is ~20-30 bytes per vertex and
// several hundred thousand vertices per view -- far past the agreed 60 MB
// runtime budget across 12-18 views. Every surface here is a regular
// heightfield, so the package stores each tile's height samples (Uint16,
// one global quantization) at the tile's baked stride; positions, UVs and
// indices are regular functions of (tile, sample) and are constructed at
// load by src/world/alpine/TerrainMesh.js after the same validation. The
// manifest still declares every byte range, count, type and SHA-256.
//
// Detail levels. Tiles are TILE_CELLS cells square. For each tile and each
// power-of-two stride the baker measures the true maximum vertical
// deviation of that stride's triangulation from the full-resolution
// samples. The camera rail is known, so each tile's closest visible
// approach is known too: the baked stride is the coarsest whose deviation
// projects to <= the desktop pixel budget there. Coarser strides' errors
// are kept so the runtime can drop to the mobile budget without re-baking.
// All strides are subsets of one sample lattice, so levels share
// geographic identity; the runtime snaps a finer tile's edge to its
// coarser neighbour's edge so mixed levels meet without cracks.
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { cameraPoseAt, boxMayBeVisible, viewDepthToBox, focalPx, cameraRailErrors } from '../../src/world/terrain/SceneTravel.js';
import { glacierErrors } from '../../src/world/alpine/GlacierField.js';
import { MIRROR_LIFT, MIRROR_SCALE, MIRROR_CLIP_M } from '../../src/world/alpine/WaterMirror.js';

import { TERRAIN_SCHEMA, TERRAIN_VERSION, STRIDES, WATER_FLOW } from '../../src/world/alpine/TerrainPackage.js';

export { TERRAIN_SCHEMA, TERRAIN_VERSION, STRIDES, WATER_FLOW };
/** Coarsest stride a tile holding both water and land may use (cells). */
export const SHORE_MAX_STRIDE = 4;
export { validateTerrainManifest, decodeResiduals } from '../../src/world/alpine/TerrainPackage.js';
export const TILE_CELLS = 64;
export const LOD_BUDGETS = Object.freeze({
  desktop: { errorPx: 1, heightPx: 1080 },
  mobile: { errorPx: 2, heightPx: 720 },
});
// Frustum widening used for visibility: the widest supported framing
// (2.4:1), the deepest camera pull-back (1 / ZOOM_MIN = 1.52) and the shake
// overscan margin together. Conservative on purpose: a tile culled here is
// never baked finely, so under-estimating would show coarse terrain.
export const VISIBILITY = Object.freeze({
  // Normal framing: 16:9 up to the reference's 2.07:1, with shake overscan.
  core: { aspect: 2.1, fovScale: 1.2, budgetScale: 1 },
  // Everything a frame can ever show: 2.4:1 at the deepest pull-back.
  // Terrain only visible here is baked at 3x the pixel budget.
  extended: { aspect: 2.4, fovScale: 1.85, budgetScale: 3 },
  stations: 21, minDistanceM: 40,
  // Occlusion raster: width in pixels, sample stride in cells, tolerance.
  occlusion: { width: 384, stride: 4, depthSlack: 0.015, slackM: 30 },
});

/** Each tile's axis-aligned box over its valid samples (null when it has
 *  none), as bakeTerrain lays tiles out: { cells, tilesX, tilesZ, boxes }
 *  with boxes[iz * tilesX + ix]. */
export function gridTileBoxes(grid, cells = TILE_CELLS) {
  const { width: w, height: hgt, cellSizeM: cell, originM, heightsM: h, valid } = grid;
  const tilesX = Math.ceil((w - 1) / cells), tilesZ = Math.ceil((hgt - 1) / cells);
  const boxes = new Array(tilesX * tilesZ).fill(null);
  for (let iz = 0; iz < tilesZ; iz++) for (let ix = 0; ix < tilesX; ix++) {
    const x0 = ix * cells, y0 = iz * cells;
    let minY = Infinity, maxY = -Infinity;
    for (let v = 0; v <= cells && y0 + v < hgt; v++) for (let u = 0; u <= cells && x0 + u < w; u++) {
      const i = (y0 + v) * w + x0 + u;
      if (valid[i]) { minY = Math.min(minY, h[i]); maxY = Math.max(maxY, h[i]); }
    }
    if (minY <= maxY) boxes[iz * tilesX + ix] = { min: [originM[0] + x0 * cell, minY, originM[1] + y0 * cell], max: [originM[0] + (x0 + cells) * cell, maxY, originM[1] + (y0 + cells) * cell] };
  }
  return { cells, tilesX, tilesZ, boxes };
}

/** One station's conservative depth buffer (nearest 1/depth per pixel) of
 *  the whole grid at a coarse stride, for occlusion tests at bake time.
 *  `minDepthM` drops nearer triangles; `minHeightM` drops samples below it
 *  (the water mirror clips its plane). With `tiles` (gridTileBoxes) whole
 *  tiles outside the frustum are skipped -- the same pixels, far faster for
 *  narrow poses -- and `ids` records per pixel the tile (iz * tilesX + ix)
 *  of the nearest surface, -1 for sky. `scratch` (any object, reused across
 *  calls) keeps the arrays: the result is then valid until the next call. */
export function occlusionBuffer(grid, pose, framing, occ, { minDepthM = 0, minHeightM = -Infinity, tiles = null, ids = false, scratch = null } = {}) {
  const { width: w, height: hgt, cellSizeM: cell, originM, heightsM: h, valid } = grid;
  const W = occ.width, H = Math.max(2, Math.round(occ.width / framing.aspect));
  const R = occ.stride;
  const cols = Math.floor((w - 1) / R) + 1, rows = Math.floor((hgt - 1) / R) + 1;
  const alloc = (key, Type, n) => {
    if (!scratch) return new Type(n);
    return (scratch[key + n] ||= new Type(n));
  };
  const buf = alloc('buf', Float32Array, W * H).fill(0); // 1/depth, 0 = sky
  const tileOf = ids && tiles ? alloc('tile', Int32Array, W * H).fill(-1) : null;
  const sx = alloc('sx', Float32Array, cols * rows), sy = alloc('sy', Float32Array, cols * rows), iz = alloc('iz', Float32Array, cols * rows);
  const f = norm3(sub3(pose.targetM, pose.eyeM));
  const r = norm3(cross3(f, [0, 1, 0]));
  const u = cross3(r, f);
  const t = Math.tan((pose.fovYDeg * Math.PI) / 360) * framing.fovScale;
  const project = (i, j) => {
    const k = j * cols + i;
    const gi = (j * R) * w + i * R;
    if (!valid[gi] || h[gi] < minHeightM) { iz[k] = -1; return; }
    const d = [originM[0] + i * R * cell - pose.eyeM[0], h[gi] - pose.eyeM[1], originM[1] + j * R * cell - pose.eyeM[2]];
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z < 1) { iz[k] = -1; return; }
    sx[k] = ((d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * t * framing.aspect) * 0.5 + 0.5) * W;
    sy[k] = (0.5 - (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * t) * 0.5) * H;
    iz[k] = 1 / z;
  };
  const maxIz = minDepthM > 0 ? 1 / minDepthM : Infinity;
  let id = -1;
  const tri = (a, b, c) => {
    if (iz[a] < 0 || iz[b] < 0 || iz[c] < 0) return;
    if (iz[a] > maxIz || iz[b] > maxIz || iz[c] > maxIz) return;
    const minX = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
    const minY = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
    if (minX > maxX || minY > maxY) return;
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
    if (Math.abs(area) < 1e-9) return;
    for (let py = minY; py <= maxY; py++) {
      const y = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5;
        const w0 = ((sx[b] - x) * (sy[c] - y) - (sx[c] - x) * (sy[b] - y)) / area;
        const w1 = ((sx[c] - x) * (sy[a] - y) - (sx[a] - x) * (sy[c] - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const v = w0 * iz[a] + w1 * iz[b] + w2 * iz[c];
        const o = py * W + px;
        if (v > buf[o]) { buf[o] = v; if (tileOf) tileOf[o] = id; }
      }
    }
  };
  const quad = (i, j) => {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
    tri(a, c, d); tri(a, d, b);
  };
  // A tile's quads lie inside its box, so a box outside the frustum draws
  // nothing; needs tiles whose cells are whole raster quads.
  const q = tiles && tiles.cells % R === 0 ? tiles.cells / R : 0;
  if (!q) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) project(i, j);
    for (let j = 0; j + 1 < rows; j++) for (let i = 0; i + 1 < cols; i++) {
      if (tileOf) id = Math.min(tiles.tilesZ - 1, Math.floor((j * R) / tiles.cells)) * tiles.tilesX + Math.min(tiles.tilesX - 1, Math.floor((i * R) / tiles.cells));
      quad(i, j);
    }
  } else {
    for (let bz = 0; bz < tiles.tilesZ; bz++) for (let bx = 0; bx < tiles.tilesX; bx++) {
      id = bz * tiles.tilesX + bx;
      const box = tiles.boxes[id];
      if (!box || box.max[1] < minHeightM || !boxMayBeVisible(pose, framing.aspect, box, framing.fovScale)) continue;
      const i0 = bx * q, j0 = bz * q, i1 = Math.min(cols - 1, i0 + q), j1 = Math.min(rows - 1, j0 + q);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) project(i, j);
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) quad(i, j);
    }
  }
  return { buf, W, H, f, r, u, t, eye: pose.eyeM, aspect: framing.aspect, ...(tileOf ? { tile: tileOf } : {}) };
}

/** Whether a local point is in frame and not behind the buffer's surface. */
export function pointVisible(ob, p, occ) {
  return visibleAt(ob, p[0], p[1], p[2], occ);
}

function visibleAt(ob, X, Y, Z, occ) {
  const d = [X - ob.eye[0], Y - ob.eye[1], Z - ob.eye[2]];
  const z = d[0] * ob.f[0] + d[1] * ob.f[1] + d[2] * ob.f[2];
  if (z < 1) return false;
  const x = ((d[0] * ob.r[0] + d[1] * ob.r[1] + d[2] * ob.r[2]) / (z * ob.t * ob.aspect) * 0.5 + 0.5) * ob.W;
  const y = (0.5 - (d[0] * ob.u[0] + d[1] * ob.u[1] + d[2] * ob.u[2]) / (z * ob.t) * 0.5) * ob.H;
  if (x < -1 || y < -1 || x > ob.W + 1 || y > ob.H + 1) return false;
  let nearest = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const px = Math.min(ob.W - 1, Math.max(0, Math.floor(x) + dx)), py = Math.min(ob.H - 1, Math.max(0, Math.floor(y) + dy));
    // The least-occluded neighbour: a point peeking past an edge counts.
    const v = ob.buf[py * ob.W + px];
    nearest = dx === -1 && dy === -1 ? v : Math.min(nearest, v);
  }
  if (!(nearest > 0)) return true; // sky there
  const surfaceDepth = 1 / nearest;
  return z <= surfaceDepth * (1 + occ.depthSlack) + occ.slackM;
}

/**
 * Remove spikes: a valid sample (or a cluster up to three samples across)
 * higher than every valid sample on the surrounding ring at distance r by
 * more than `ratio * r` cell widths (steeper than ~63 degrees for the
 * default 2) cannot be real terrain at this spacing, and is lowered to that
 * ring's highest sample. Edge samples use the in-bounds part of the ring.
 * Wider blobs (a mosaic seam left a 2 x 5 one up to 4.7 km on Tombstone's
 * west edge, drawn as a needle on the skyline) are found by a grey opening
 * with a disc of `blobRadius` cells: whatever stands more than
 * `ratio * blobRadius` cells above the opened surface is just as steep on
 * every side, and is lowered to it when it forms a blob no wider than the
 * disc in either direction (a long narrow ridge stays) and lies within
 * `blobRadius` cells of the grid edge or a no-data sample, where source
 * seams leave such blobs (a compact butte inland stays). Returns the
 * number of samples changed.
 */
export function despikeGrid(grid, { ratio = 2, blobRadius = 3 } = {}) {
  const { width: w, height: hgt, heightsM: h, valid, cellSizeM: cell } = grid;
  let changed = 0;
  for (const r of [1, 2, 1]) {
    const limit = ratio * r * cell;
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) continue;
      let top = -Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= hgt) continue;
        const j = yy * w + xx;
        if (valid[j] && h[j] > top) top = h[j];
      }
      if (Number.isFinite(top) && h[i] - top > limit) { h[i] = top; changed++; }
    }
  }
  if (blobRadius > 0) {
    const opened = openGrid(h, valid, w, hgt, blobRadius);
    const limit = ratio * blobRadius * cell;
    const span = 2 * blobRadius + 1;
    const seen = new Uint8Array(h.length);
    const isCandidate = (i) => valid[i] && h[i] - opened[i] > limit;
    // Compactness alone does not make a blob an artifact (a butte or rock
    // tower is compact too). These blobs come from where the source data
    // ends: a mosaic seam at the grid edge or a no-data hole. A blob is
    // lowered only within `blobRadius` cells of one.
    const nearDataEdge = (x0, x1, y0, y1) => {
      const ax = x0 - blobRadius, bx = x1 + blobRadius, ay = y0 - blobRadius, by = y1 + blobRadius;
      if (ax < 0 || ay < 0 || bx >= w || by >= hgt) return true;
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (!valid[y * w + x]) return true;
      return false;
    };
    // Only a bounded blob goes: a long ridge narrower than the disc stands
    // above the opening along its whole length but is not a spike.
    for (let start = 0; start < h.length; start++) {
      if (seen[start] || !isCandidate(start)) continue;
      const blob = [start];
      seen[start] = 1;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let k = 0; k < blob.length; k++) {
        const i = blob[k], x = i % w, y = (i - x) / w;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= hgt) continue;
          const j = yy * w + xx;
          if (!seen[j] && isCandidate(j)) { seen[j] = 1; blob.push(j); }
        }
      }
      if (x1 - x0 + 1 > span || y1 - y0 + 1 > span) continue;
      if (!nearDataEdge(x0, x1, y0, y1)) continue;
      for (const i of blob) { h[i] = opened[i]; changed++; }
    }
  }
  return changed;
}

/** Grey opening (erosion, then dilation) of the valid samples by a disc of
 *  radius `r` cells; edges and no-data use the in-bounds valid part. */
function openGrid(h, valid, w, hgt, r) {
  const disc = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) disc.push([dx, dy]);
  const pass = (src, pick, init) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) { out[i] = src[i]; continue; }
      let v = init;
      for (const [dx, dy] of disc) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= hgt) continue;
        const j = yy * w + xx;
        if (valid[j]) v = pick(v, src[j]);
      }
      out[i] = v;
    }
    return out;
  };
  return pass(pass(h, Math.min, Infinity), Math.max, -Infinity);
}

/**
 * Soften resampling steps on gentle ground. A coarse global source (Terrain
 * Tiles) resampled to the bake grid leaves stair-steps that read as a
 * waffle pattern on valley floors (a beat between the source pixel and
 * the bake cell, ~5 cells long); a 7x7 Gaussian (sigma 2 cells) is
 * blended in where the slope is gentle and fades out by ~17 degrees, so
 * ridges and cliffs keep their shape. Returns the mean absolute change (m).
 */
export function smoothGentleGround(grid) {
  const { width: w, height: hgt, heightsM: h, valid, cellSizeM: cell } = grid;
  const k = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) k.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * 2 * 2))]);
  const out = new Float32Array(h);
  let sum = 0, n = 0;
  for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!valid[i]) continue;
    const gx = (h[i + 1] - h[i - 1]) / (2 * cell), gy = (h[i + w] - h[i - w]) / (2 * cell);
    const slope = Math.hypot(gx, gy);
    const t = Math.min(1, Math.max(0, (slope - 0.1) / 0.2));
    const blend = 1 - t * t * (3 - 2 * t);
    if (!(blend > 0)) continue;
    let acc = 0, wsum = 0;
    for (const [dx, dy, wt] of k) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= hgt) continue;
      const j = yy * w + xx;
      if (!valid[j]) continue;
      acc += h[j] * wt; wsum += wt;
    }
    out[i] = h[i] + (acc / wsum - h[i]) * blend;
    sum += Math.abs(out[i] - h[i]); n++;
  }
  h.set(out);
  return n ? sum / n : 0;
}

/** Legacy parity (RidgeComposition MIN_EXPOSED): at every station the far
 *  range's crest must stay at least this exposed. */
export const MIN_FAR_EXPOSED = 0.55;
/** What the audience sees at normal framing: the nominal 16:9 stage, and
 *  the rock stage/cast from Midio's ground line (625 of 720 px) down. */
export const EXPOSURE_FRAMING = Object.freeze({ aspect: 16 / 9, fovScale: 1, groundFrac: 625 / 720 });

/**
 * Far-crest exposure from one pose: for each raster column, the top-most
 * pixel of terrain at view depth >= `farM` (the far partition's skyline),
 * and whether nearer terrain -- or the ground line -- covers it. Returns
 * per-column states (0 no far crest, 1 hidden, 2 exposed) and the exposed
 * fraction of columns that have a far crest.
 */
export function farCrestExposure(grid, pose, farM, { framing = EXPOSURE_FRAMING, occ = VISIBILITY.occlusion } = {}) {
  const all = occlusionBuffer(grid, pose, framing, occ);
  const far = occlusionBuffer(grid, pose, framing, occ, { minDepthM: farM });
  const { W, H } = all;
  const groundRow = Math.floor((framing.groundFrac ?? 1) * H);
  const columns = new Uint8Array(W);
  let crest = 0, shown = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const v = far.buf[y * W + x];
      if (!(v > 0)) continue;
      crest++;
      const covered = y >= groundRow || all.buf[y * W + x] > v * (1 + occ.depthSlack) + 1e-12;
      columns[x] = covered ? 1 : 2;
      if (!covered) shown++;
      break;
    }
  }
  return { columns, fraction: crest ? shown / crest : 0, crestColumns: crest / W };
}

/** Far-crest exposure at each of the view's rail stations. */
export function stationExposure(grid, view, { stations = VISIBILITY.stations, farM = null, framing, occ } = {}) {
  const far = farM ?? (view.bands?.midM || 7000);
  return railStations(view, stations).map((pose) => farCrestExposure(grid, pose, far, { framing, occ }));
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Validate a DemGrid before baking. Returns { ok, errors }. */
export function validateDemGrid(grid) {
  const errors = [];
  if (!grid || typeof grid !== 'object') return { ok: false, errors: ['grid missing'] };
  const { width, height, cellSizeM } = grid;
  if (!(Number.isInteger(width) && width >= 2 && Number.isInteger(height) && height >= 2)) errors.push('bad dimensions');
  if (!(cellSizeM > 0)) errors.push('bad cell size');
  if (!(grid.heightsM instanceof Float32Array) || grid.heightsM.length !== width * height) errors.push('heights length');
  if (!(grid.valid instanceof Uint8Array) || grid.valid.length !== width * height) errors.push('validity length');
  if (!Array.isArray(grid.originM) || grid.originM.length !== 2 || !grid.originM.every(Number.isFinite)) errors.push('origin');
  if (!errors.length) {
    let anyValid = false;
    for (let i = 0; i < grid.heightsM.length; i++) {
      if (!grid.valid[i]) continue;
      anyValid = true;
      if (!Number.isFinite(grid.heightsM[i])) { errors.push(`valid cell ${i} not finite`); break; }
    }
    // A corridor outside source coverage (or a failed fill) yields no data
    // at all; baking it would produce an empty package with infinite bounds.
    if (!anyValid) errors.push('no valid samples');
  }
  if (grid.upsampled) errors.push('grid is upsampled beyond its source resolution');
  return { ok: !errors.length, errors };
}

// ---------------------------------------------------------------------------
// Hydrology: depression-filled D8 flow accumulation and a water mask from
// hydro-flattened surfaces. Derived fields, not measured land cover.

/** Priority-flood depression filling (Barnes et al. 2014) with an epsilon
 *  gradient so flats drain. Returns filled heights (Float64Array). */
export function fillDepressions(h, valid, w, hgt, eps = 1e-3) {
  const n = w * hgt;
  const out = new Float64Array(n);
  const done = new Uint8Array(n);
  // Binary heap of [height, index].
  const heapH = new Float64Array(n);
  const heapI = new Int32Array(n);
  let size = 0;
  const push = (hh, i) => {
    let k = size++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapH[p] <= hh) break;
      heapH[k] = heapH[p]; heapI[k] = heapI[p]; k = p;
    }
    heapH[k] = hh; heapI[k] = i;
  };
  const pop = () => {
    const topI = heapI[0];
    const lastH = heapH[--size], lastI = heapI[size];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= size) break;
      if (c + 1 < size && heapH[c + 1] < heapH[c]) c++;
      if (heapH[c] >= lastH) break;
      heapH[k] = heapH[c]; heapI[k] = heapI[c]; k = c;
    }
    heapH[k] = lastH; heapI[k] = lastI;
    return topI;
  };
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0;
    const edge = x === 0 || y === 0 || x === w - 1 || y === hgt - 1;
    let nearHole = false;
    if (!edge && valid[i]) {
      for (let dy = -1; dy <= 1 && !nearHole; dy++) for (let dx = -1; dx <= 1; dx++) if (!valid[i + dy * w + dx]) { nearHole = true; break; }
    }
    if (valid[i] && (edge || nearHole)) { out[i] = h[i]; done[i] = 1; push(h[i], i); }
    if (!valid[i]) done[i] = 1;
  }
  while (size > 0) {
    const i = pop();
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= hgt) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((!dx && !dy) || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (done[j]) continue;
        done[j] = 1;
        out[j] = Math.max(h[j], out[i] + eps);
        push(out[j], j);
      }
    }
  }
  return out;
}

/** D8 flow accumulation (cells draining through each cell, itself
 *  included) over depression-filled heights. */
export function flowAccumulation(filled, valid, w, hgt) {
  const n = w * hgt;
  const order = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) if (valid[i]) order[m++] = i;
  const idx = Array.from(order.subarray(0, m)).sort((a, b) => filled[b] - filled[a]);
  const acc = new Float64Array(n);
  for (const i of idx) acc[i] += 1;
  for (const i of idx) {
    const x = i % w, y = (i / w) | 0;
    let best = -1, drop = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= hgt) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((!dx && !dy) || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (!valid[j]) continue;
        const d = (filled[i] - filled[j]) / (dx && dy ? Math.SQRT2 : 1);
        if (d > drop) { drop = d; best = j; }
      }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  return acc;
}

/** Hydro-flattened water: connected cells whose 3x3 neighbourhood is flat
 *  to within `flatM`, in components of at least `minCells`. Bare-earth
 *  3DEP flattens lakes and wide rivers, so this reads the source's own
 *  water surfaces rather than guessing them. */
export function waterMask(h, valid, w, hgt, { flatM = 0.35, minCells = 60 } = {}) {
  const n = w * hgt;
  const flat = new Uint8Array(n);
  for (let y = 1; y < hgt - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!valid[i]) continue;
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy * w + dx;
        if (!valid[j]) { ok = false; break; }
        lo = Math.min(lo, h[j]); hi = Math.max(hi, h[j]);
      }
      if (ok && hi - lo <= flatM) flat[i] = 1;
    }
  }
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!flat[s] || seen[s]) continue;
    let top = 0, count = 0;
    const members = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top];
      members.push(i); count++;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= hgt) continue;
        const j = yy * w + xx;
        if (flat[j] && !seen[j] && Math.abs(h[j] - h[i]) <= flatM) { seen[j] = 1; stack[top++] = j; }
      }
    }
    if (count >= minCells) for (const i of members) out[i] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detail levels.

/** Height of the stride-`s` triangulation at local sample (u, v) inside a
 *  cell of that stride whose corners are a (0,0), b (s,0), c (0,s), d (s,s).
 *  Quads split along the a-d diagonal, as TerrainMesh does. */
export function triangulatedHeight(a, b, c, d, fu, fv) {
  return fu >= fv ? a + (b - a) * fu + (d - b) * fv : a + (d - c) * fu + (c - a) * fv;
}

/** Max |full - stride triangulation| over one tile. Cells with an invalid
 *  corner are skipped (they are not drawn); a cell that would bridge an
 *  invalid interior sample makes the stride ineligible (Infinity). */
export function tileStrideError(h, valid, w, hgt, x0, y0, cells, stride) {
  if (stride === 1) return 0;
  let err = 0;
  for (let cy = 0; cy < cells; cy += stride) {
    for (let cx = 0; cx < cells; cx += stride) {
      const X = x0 + cx, Y = y0 + cy;
      if (X + stride >= w || Y + stride >= hgt) continue;
      const ia = Y * w + X, ib = ia + stride, ic = ia + stride * w, id = ic + stride;
      if (!(valid[ia] && valid[ib] && valid[ic] && valid[id])) continue;
      const a = h[ia], b = h[ib], c = h[ic], d = h[id];
      for (let v = 0; v <= stride; v++) {
        for (let u = 0; u <= stride; u++) {
          const j = (Y + v) * w + X + u;
          // A coarse cell with valid corners would draw over no-data inside
          // it: that stride cannot represent this tile.
          if (!valid[j]) return Infinity;
          const e = Math.abs(h[j] - triangulatedHeight(a, b, c, d, u / stride, v / stride));
          if (e > err) err = e;
        }
      }
    }
  }
  return err;
}

function railStations(view, count) {
  return Array.from({ length: count }, (_, k) => cameraPoseAt(view, count > 1 ? k / (count - 1) : 0));
}

const FRAMINGS = Object.freeze(['core', 'extended']);
// The visibility framings a pose is tested in: an 'extended' pose (seen
// only in the widest framing) never makes a tile core.
const POSE_FRAMINGS = Object.freeze({ core: FRAMINGS, extended: Object.freeze(['extended']), mirror: FRAMINGS });

/**
 * The camera the water mirror renders for `pose` (WaterMirror
 * mirrorCameraFor): the eye reflected about y = levelM and lifted `lift` of
 * its height, the look direction reflected (not lifted), the same lens.
 * Tagged framing 'mirror' with its level, so bakeTerrain and validatePoses
 * clip the ground at and below the water and use the mirror's resolution.
 */
export function mirroredPose(pose, levelM, lift = MIRROR_LIFT) {
  const d = sub3(pose.targetM, pose.eyeM);
  const eyeM = [pose.eyeM[0], levelM - lift * (pose.eyeM[1] - levelM), pose.eyeM[2]];
  return { eyeM, targetM: [eyeM[0] + d[0], eyeM[1] - d[1], eyeM[2] + d[2]], fovYDeg: pose.fovYDeg, framing: 'mirror', levelM };
}

/** Errors in a bake/validation pose (empty = usable). */
export function poseErrors(p) {
  const vec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!p || !vec(p.eyeM) || !vec(p.targetM)) return ['eye and target must be three finite numbers'];
  const errors = [];
  if (!(p.fovYDeg >= 5 && p.fovYDeg <= 120)) errors.push('fovYDeg must be within 5..120');
  if (!POSE_FRAMINGS[p.framing ?? 'core']) errors.push(`unknown framing ${p.framing}`);
  if (p.framing === 'mirror' && !Number.isFinite(p.levelM)) errors.push('a mirror pose needs levelM');
  const d = sub3(p.targetM, p.eyeM), l = Math.hypot(d[0], d[1], d[2]);
  if (!(l > 1)) errors.push('eye and target coincide');
  else if (Math.abs(d[1] / l) > 0.98) errors.push('looks straight up or down');
  return errors;
}

/**
 * Bake viewers from poses: every `stride`th pose (and the last), with
 * near-duplicates merged -- eye within `eyeM`, look within `angleDeg`, lens
 * within `fovDeg`, same framing and mirror level. A merged viewer frames
 * the widest member lens widened by the look difference, and takes its
 * detail from the narrowest lens, so merging neither culls nor coarsens
 * beyond the eye offset. `eyeM: 0` disables merging.
 */
function bakeViewers(poses, { stride = 1, eyeM = 25, angleDeg = 2, fovDeg = 2 } = {}) {
  const step = Math.max(1, Math.floor(stride) || 1), cosMax = Math.cos((angleDeg * Math.PI) / 180);
  const out = [];
  // Spatial hash on the eye: candidates for a merge share or neighbour a cell.
  const cellM = Math.max(1, eyeM), hash = new Map();
  const keyOf = (x, y, z) => `${x},${y},${z}`;
  poses.forEach((p, i) => {
    const errors = poseErrors(p);
    if (errors.length) throw new Error(`pose ${i}: ${errors.join('; ')}`);
    if (i % step && i !== poses.length - 1) return;
    const framing = p.framing ?? 'core';
    const minHeightM = framing === 'mirror' ? p.levelM + MIRROR_CLIP_M : -Infinity;
    const dir = norm3(sub3(p.targetM, p.eyeM));
    const c = p.eyeM.map((v) => Math.floor(v / cellM));
    if (eyeM > 0) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const v of hash.get(keyOf(c[0] + dx, c[1] + dy, c[2] + dz)) || []) {
          if (v.framing !== framing || v.minHeightM !== minHeightM || Math.abs(v.lensDeg - p.fovYDeg) > fovDeg) continue;
          if (Math.hypot(v.pose.eyeM[0] - p.eyeM[0], v.pose.eyeM[1] - p.eyeM[1], v.pose.eyeM[2] - p.eyeM[2]) > eyeM) continue;
          const cos = v.dir[0] * dir[0] + v.dir[1] * dir[1] + v.dir[2] * dir[2];
          if (cos < cosMax) continue;
          const turnDeg = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
          v.pose.fovYDeg = Math.max(v.pose.fovYDeg, p.fovYDeg + 2 * turnDeg);
          v.focalFovYDeg = Math.min(v.focalFovYDeg, p.fovYDeg);
          return;
        }
      }
    }
    const viewer = {
      pose: { eyeM: [...p.eyeM], targetM: [...p.targetM], fovYDeg: p.fovYDeg }, framing, framings: POSE_FRAMINGS[framing],
      lensDeg: p.fovYDeg, focalFovYDeg: p.fovYDeg, focalScale: framing === 'mirror' ? MIRROR_SCALE : 1, minHeightM, dir,
    };
    out.push(viewer);
    const k = keyOf(...c);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k).push(viewer);
  });
  return out;
}

/** Whether any of the flat xyz points at or above `minHeightM` is visible. */
function anyPointVisible(ob, pts, occ, minHeightM) {
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] >= minHeightM && visibleAt(ob, pts[i], pts[i + 1], pts[i + 2], occ)) return true;
  }
  return false;
}

/** Byte-plane split of Uint16 values (low bytes, then high bytes): gzip
 *  compresses small residuals far better this way. */
function splitPlanes(u16) {
  const out = new Uint8Array(u16.length * 2);
  for (let i = 0; i < u16.length; i++) { out[i] = u16[i] & 0xff; out[u16.length + i] = u16[i] >>> 8; }
  return out;
}

/** Planar predictor residuals (left + up - upleft), modulo 2^16. */
export function encodeResiduals(q, n) {
  const r = new Uint16Array(q.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const left = x ? q[i - 1] : (y ? q[i - n] : 0);
      const up = y ? q[i - n] : left;
      const ul = x && y ? q[i - n - 1] : (y ? q[i - n] : left);
      const pred = x && y ? Math.min(65535, Math.max(0, left + up - ul)) : (x ? left : up);
      r[i] = (q[i] - pred) & 0xffff;
    }
  }
  return r;
}

/**
 * Bake one view's terrain package.
 *   grid     DemGrid (tools/lib/terrain-source.mjs)
 *   view     SceneView (camera rail, bands, id)
 *   options  { tileCells, budgets, visibility, dataUrl, quantStepM, landmarks,
 *              allTiles?: boolean (requires complete source coverage),
 *              poses?: [{ eyeM, targetM, fovYDeg, framing?, levelM? }],
 *              poseStride?, poseDedupe? (see bakeViewers) }
 * Poses (shot library footprints, mirrored cameras) are seen in addition
 * to the rail stations, or alone when the view has no camera; a tile's
 * stride then meets the budget at every pose that sees it, each with its
 * own lens. Without poses the bake is exactly the rail bake.
 * Returns { manifest, payload (gzip Buffer), decoded (Buffer), stats }.
 */
export async function bakeTerrain(grid, view, options = {}) {
  const allTiles = options.allTiles === true;
  const check = validateDemGrid(grid);
  if (!check.ok) throw new Error(`DEM rejected: ${check.errors.join('; ')}`);
  if (allTiles && grid.valid.some(v => !v)) {
    throw new Error('allTiles DEM contains no-data; normalize with complete source/fill coverage before baking');
  }
  const posed = !allTiles && Array.isArray(options.poses) && options.poses.length > 0;
  const hasRail = !allTiles && !(posed && view?.camera == null);
  const railErrors = hasRail ? cameraRailErrors(view?.camera) : [];
  if (railErrors.length) throw new Error(`view ${view?.id}: ${railErrors.join('; ')}`);
  const cells = options.tileCells || TILE_CELLS;
  const budgets = options.budgets || LOD_BUDGETS;
  const vis = { ...VISIBILITY, ...(options.visibility || {}) };
  // A shader-raised ice surface can reveal valley floor hidden by the bed.
  // Keep the source heights/hydrology intact and conservatively expand only
  // tiles intersecting the glacier's capsule in the visibility calculation.
  const glacier = view.glacier;
  const glacierProblems = glacierErrors(glacier);
  if (glacierProblems.length) throw new Error(`view ${view.id}: ${glacierProblems.join('; ')}`);
  const displacementFor = (box) => {
    if (!glacier || box.min[1] >= Math.max(glacier.surfaceStartM, glacier.surfaceEndM)) return 0;
    const a = glacier.axisStartM, b = glacier.axisEndM;
    const x = (box.min[0] + box.max[0]) / 2, z = (box.min[2] + box.max[2]) / 2;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(1, dx * dx + dz * dz)));
    const radius = Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2;
    return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) <= glacier.halfWidthM + radius ? glacier.maxThicknessM : 0;
  };
  const bands = { nearM: 1800, midM: 7000, ...(view.bands || {}), ...(options.bands || {}) };
  const { width: w, height: hgt, cellSizeM: cell, originM } = grid;
  const h = grid.heightsM, valid = grid.valid;

  // Global quantization: shared samples quantize identically in every tile.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) if (valid[i]) { lo = Math.min(lo, h[i]); hi = Math.max(hi, h[i]); }
  const stepM = options.quantStepM || Math.max(0.05, Math.ceil(((hi - lo + 2) / 65000) * 100) / 100);
  const offsetM = Math.floor(lo) - 1;
  const quant = (v) => Math.max(1, Math.min(65535, Math.round((v - offsetM) / stepM)));

  // Hydrology on the whole grid (tile-independent, so seams agree).
  const filled = fillDepressions(h, valid, w, hgt);
  const acc = flowAccumulation(filled, valid, w, hgt);
  // A view may declare that its flats are not water (a salt pan or playa
  // reads as perfectly flat too): then no sample is marked water.
  const water = options.water === false ? new Uint8Array(w * hgt) : waterMask(h, valid, w, hgt, options.water);
  const flowByte = (i) => (water[i] ? WATER_FLOW : Math.min(254, Math.round(Math.log2(Math.max(1, acc[i])) * 16)));

  const tilesX = Math.ceil((w - 1) / cells), tilesZ = Math.ceil((hgt - 1) / cells);
  const stations = hasRail ? railStations(view, vis.stations) : [];
  const viewers = stations.map((pose) => ({ pose, framings: FRAMINGS, focalFovYDeg: pose.fovYDeg, focalScale: 1, minHeightM: -Infinity }));
  const posedViewers = posed ? bakeViewers(options.poses, { stride: options.poseStride, ...(options.poseDedupe === false ? { eyeM: 0 } : options.poseDedupe) }) : [];
  // Tour poses may carry a coarser pixel budget than the rail
  // (options.poseErrorScale): the app presents terrain on a 320x180 or
  // 640x360 pixel grid, so 1 px at 1080 is stricter than any tour frame needs.
  const poseErrorScale = posed && options.poseErrorScale > 1 ? options.poseErrorScale : 1;
  if (poseErrorScale > 1) for (const v of posedViewers) v.focalScale /= poseErrorScale;
  viewers.push(...posedViewers);
  // Each tile's highest valid sample: narrow summits must not slip between
  // the coarse occlusion samples.
  const peak = new Map();
  if (!allTiles) for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!valid[i]) continue;
    const key = `${Math.min(Math.floor(x / cells), Math.ceil((w - 1) / cells) - 1)},${Math.min(Math.floor(y / cells), Math.ceil((hgt - 1) / cells) - 1)}`;
    const cur = peak.get(key);
    if (!cur || h[i] > cur[1]) peak.set(key, [originM[0] + x * cell, h[i], originM[1] + y * cell]);
  }
  const focal = hasRail ? Object.fromEntries(Object.entries(budgets).map(([k, b]) => [k, focalPx(view.camera.fovYDeg, b.heightPx)])) : {};

  // Per tile: its box (raised over glacier ice) and the samples tested for
  // occlusion, then what every viewer sees of it -- the closest view depth
  // per framing and, with poses, the sharpest focal / depth per framing and
  // budget. One viewer's occlusion buffers at a time, reused.
  const layout = gridTileBoxes(grid, cells);
  const boxes = layout.boxes.map((b) => b && { min: [...b.min], max: [...b.max] });
  const displacement = new Float64Array(boxes.length);
  const samplePts = new Array(boxes.length).fill(null);
  const R = vis.occlusion.stride;
  for (let k = 0; k < boxes.length; k++) {
    const box = boxes[k];
    if (!box) continue;
    displacement[k] = displacementFor(box);
    if (displacement[k]) box.max[1] = Math.max(box.max[1], Math.min(box.max[1] + displacement[k], Math.max(glacier.surfaceStartM, glacier.surfaceEndM)));
    if (allTiles) continue;
    const ix = k % tilesX, iz = (k - ix) / tilesX, x0 = ix * cells, y0 = iz * cells;
    const pts = [];
    for (let v = 0; v <= cells; v += R) for (let u = 0; u <= cells; u += R) {
      const X = Math.min(w - 1, x0 + u), Y = Math.min(hgt - 1, y0 + v);
      const i = Y * w + X;
      if (valid[i]) pts.push(originM[0] + X * cell, h[i], originM[1] + Y * cell);
    }
    if (peak.has(`${ix},${iz}`)) pts.push(...peak.get(`${ix},${iz}`));
    samplePts[k] = Float64Array.from(pts);
  }
  const reach = Object.fromEntries(FRAMINGS.map((name) => [name, new Float64Array(boxes.length).fill(Infinity)]));
  const budgetKeys = Object.keys(budgets);
  const sharp = posed ? Object.fromEntries(FRAMINGS.map((name) => [name, Object.fromEntries(budgetKeys.map((b) => [b, new Float64Array(boxes.length)]))])) : null;
  // Poses framed 'extended' hold their whole frame to the extended budget,
  // also on tiles another viewer sees in core. Kept apart from
  // sharp.extended, which every core viewer's widest framing feeds too (wider
  // than the frame validatePoses checks): only these refine core tiles.
  const wide = posedViewers.some((v) => v.framing === 'extended') ? Object.fromEntries(budgetKeys.map((b) => [b, new Float64Array(boxes.length)])) : null;
  const scratch = {};
  for (const viewer of viewers) {
    const { pose, minHeightM } = viewer;
    const focalOf = sharp && budgetKeys.map((b) => focalPx(viewer.focalFovYDeg, budgets[b].heightPx) * viewer.focalScale);
    const wideOnly = wide && viewer.framing === 'extended';
    for (const name of viewer.framings) {
      const best = wideOnly ? wide : sharp?.[name];
      // Built on first need: a viewer that can improve no tile draws nothing.
      let ob = null;
      for (let k = 0; k < boxes.length; k++) {
        const box = boxes[k];
        if (!box || box.max[1] < minHeightM || !boxMayBeVisible(pose, vis[name].aspect, box, vis[name].fovScale)) continue;
        // View depth, not Euclidean distance: off-axis tiles project
        // larger than their distance suggests. A box reaching behind the
        // eye plane falls to minDistanceM below.
        const depth = Math.max(0, viewDepthToBox(pose, box));
        const sharper = sharp && budgetKeys.some((b, j) => focalOf[j] / Math.max(vis.minDistanceM, depth) > best[b][k]);
        if (!(depth < reach[name][k]) && !sharper) continue;
        // Bed occlusion is not valid across spatially varying retreat:
        // a foreground ice margin and a distant surface clear at different
        // times. Keep all in-frustum glacier tiles conservatively.
        if (!displacement[k]) {
          ob ||= occlusionBuffer(grid, pose, vis[name], vis.occlusion, posed ? { scratch, tiles: layout, minHeightM } : { scratch });
          if (!anyPointVisible(ob, samplePts[k], vis.occlusion, minHeightM)) continue;
        }
        reach[name][k] = Math.min(reach[name][k], depth);
        if (sharp) {
          budgetKeys.forEach((b, j) => {
            const fd = focalOf[j] / Math.max(vis.minDistanceM, depth);
            sharp[name][b][k] = Math.max(sharp[name][b][k], fd);
            if (wideOnly) wide[b][k] = Math.max(wide[b][k], fd);
          });
        }
      }
    }
  }
  const tiles = [];
  const chunks = [];
  let byteOffset = 0;
  const pushChunk = (buf) => { const at = byteOffset; chunks.push(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)); byteOffset += buf.byteLength; return at; };
  const achieved = Object.fromEntries(Object.keys(budgets).map((k) => [k, 0]));
  let bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (let iz = 0; iz < tilesZ; iz++) {
    for (let ix = 0; ix < tilesX; ix++) {
      const x0 = ix * cells, y0 = iz * cells, ti = iz * tilesX + ix;
      const box = boxes[ti];
      if (!box) continue;
      const minY = layout.boxes[ti].min[1], maxY = layout.boxes[ti].max[1];
      // Closest approach per framing among viewers where some sample of
      // the tile is on screen and not hidden behind nearer terrain.
      const framing = allTiles ? 'route' : Number.isFinite(reach.core[ti]) ? 'core' : Number.isFinite(reach.extended[ti]) ? 'extended' : null;
      const visible = framing !== null;
      const dist = allTiles ? Infinity : Math.max(vis.minDistanceM, visible ? reach[framing][ti] : Infinity);
      const budgetScale = allTiles ? 1 : visible ? vis[framing].budgetScale : 1;
      const errorsM = {};
      for (const s of STRIDES) if (s <= cells) errorsM[s] = tileStrideError(h, valid, w, hgt, x0, y0, cells, s);
      // A shoreline tile keeps a fine stride whatever its height error: a
      // flat lake edge is "error free" at the coarsest stride, but its four
      // corners cannot carry where the water ends.
      let wetCells = 0, landCells = 0;
      for (let cy = 0; cy <= cells && y0 + cy < hgt; cy++) {
        for (let cx = 0; cx <= cells && x0 + cx < w; cx++) {
          const i = (y0 + cy) * w + x0 + cx;
          if (valid[i]) { if (water[i]) wetCells++; else landCells++; }
        }
      }
      const strideCap = wetCells && landCells ? SHORE_MAX_STRIDE : Infinity;
      const pick = (budget) => {
        // GPU ice displacement is nonlinear. A bed-snapped fine-edge
        // midpoint does not land on its coarse neighbour's displaced edge.
        // One common grid for the whole glacier view avoids those cracks
        // at every retreat and quality; report its actual bed error below.
        if (glacier) return Math.min(2, cells);
        if (!visible) return cells;
        let best = 1;
        for (const s of STRIDES) {
          if (s > cells || s > strideCap) break;
          // Rail only: its one lens at the closest approach. With poses: the
          // sharpest focal / depth of any pose that sees the tile, and of
          // any 'extended' pose at the extended budget.
          const px = sharp ? errorsM[s] * sharp[framing][budget][ti] : errorsM[s] * focal[budget] / dist;
          if (wide && errorsM[s] * wide[budget][ti] > budgets[budget].errorPx * vis.extended.budgetScale) continue;
          if (px <= budgets[budget].errorPx * budgetScale) best = s;
        }
        return best;
      };
      // Hidden from every station in every framing: never drawn, so not
      // shipped (options.keepHidden keeps it, coarsest, for diagnostics).
      if (!visible && !options.keepHidden) continue;
      const lod = Object.fromEntries(Object.keys(budgets).map((k) => [k, pick(k)]));
      const stride = allTiles ? (options.tileStride?.({ ix, iz, x0, y0, cells, grid }) ?? 1) : Math.min(...Object.values(lod));
      if (!STRIDES.includes(stride) || stride > cells) throw new Error('Invalid authored tile stride');
      for (const k of Object.keys(lod)) {
        if (framing === 'core') achieved[k] = Math.max(achieved[k], sharp ? errorsM[lod[k]] * sharp.core[k][ti] : errorsM[lod[k]] * focal[k] / dist);
      }
      const n = cells / stride + 1;
      const q = new Uint16Array(n * n);
      const flow = new Uint8Array(n * n);
      const vbits = new Uint8Array(Math.ceil((n * n) / 8));
      let allValid = true;
      for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
        const X = x0 + u * stride, Y = y0 + v * stride;
        const k = v * n + u;
        const inside = X < w && Y < hgt;
        const i = Y * w + X;
        if (inside && valid[i]) {
          q[k] = quant(h[i]);
          flow[k] = flowByte(i);
          vbits[k >> 3] |= 1 << (k & 7);
        } else {
          allValid = false;
          // Carry the neighbour's value so the residual stream stays small;
          // the validity bit, not this value, decides what is drawn.
          q[k] = k ? q[k - 1] : quant(minY);
        }
      }
      const residual = splitPlanes(encodeResiduals(q, n));
      const hAt = pushChunk(residual);
      const fAt = pushChunk(flow);
      const tile = {
        id: `t${ix}_${iz}`, ix, iz, stride, samples: n,
        heights: { byteOffset: hAt, byteLength: residual.byteLength, count: n * n, type: 'uint16', predictor: 'planar', planes: 'lo-hi' },
        flow: { byteOffset: fAt, byteLength: flow.byteLength, count: n * n, type: 'uint8', water: WATER_FLOW },
        validity: allValid ? { mode: 'all' } : { mode: 'bits', byteOffset: pushChunk(vbits), byteLength: vbits.byteLength },
        minY, maxY, visible, framing, closestM: allTiles ? null : visible ? Math.round(dist) : null,
        band: !visible ? 'far' : dist < bands.nearM ? 'near' : dist < bands.midM ? 'mid' : 'far',
        ...(!allTiles ? { lod } : {}),
        errorsM: Object.fromEntries(Object.entries(errorsM).filter(([s]) => Number(s) >= stride).map(([s, e]) => [s, Math.round(e * 1000) / 1000])),
      };
      tiles.push(tile);
      for (let a = 0; a < 3; a++) { bounds.min[a] = Math.min(bounds.min[a], box.min[a]); bounds.max[a] = Math.max(bounds.max[a], box.max[a]); }
    }
  }
  const decoded = Buffer.concat(chunks);
  const payload = zlib.gzipSync(decoded, { level: 9, mtime: 0 });
  // gzip's header carries an mtime and OS byte; zero them for reproducible hashes.
  payload[4] = payload[5] = payload[6] = payload[7] = 0;
  payload[9] = 255;
  const estimate = (budget) => {
    let vertices = 0, triangles = 0;
    for (const t of tiles) {
      if (!t.visible) continue;
      const s = allTiles ? t.stride : t.lod[budget];
      const m = cells / s;
      vertices += (m + 1) * (m + 1);
      triangles += 2 * m * m;
    }
    return {
      vertices, triangles,
      // Float32 xyz position + Uint32 indices, plus the RGBA8 surface
      // texture at grid resolution with a full mip chain (x4/3).
      meshBytes: vertices * 12 + triangles * 3 * 4,
      surfaceTextureBytes: Math.round(w * hgt * 4 * 4 / 3),
    };
  };
  const manifest = {
    schema: TERRAIN_SCHEMA, version: TERRAIN_VERSION,
    viewId: view.id, regionId: view.regionId || null,
    source: {
      demSha256: grid.meta?.payload?.heights?.sha256 || null,
      provenance: grid.provenance || null,
      fill: grid.fill || null,
      horizontalCrs: grid.horizontalCrs, verticalReference: grid.verticalReference,
      centerLonLat: grid.centerLonLat || null,
      sourceResolutionM: grid.sourceResolutionM, outputSpacingM: grid.outputSpacingM,
    },
    grid: { width: w, height: hgt, cellSizeM: cell, originM: [...originM] },
    axes: 'X east, Y up, Z south (metres)',
    tileCells: cells, tilesX, tilesZ,
    quantization: { offsetM, stepM },
    boundsM: bounds,
    bands,
    ...(!allTiles ? { lod: {
      budgets, fovYDeg: hasRail ? view.camera.fovYDeg : null, visibility: vis,
      framings: 'core tiles meet the pixel budget at their closest unoccluded approach; extended-only tiles at budgetScale x; hidden tiles are not drawn',
      achievedErrorPx: Object.fromEntries(Object.entries(achieved).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      ...(posed ? { poses: {
        poseCount: options.poses.length, bakedPoses: posedViewers.length, ...(poseErrorScale > 1 ? { errorScale: poseErrorScale } : {}),
        minFovYDeg: Math.min(...options.poses.map((p) => p.fovYDeg)),
        sources: options.poses.reduce((n, p) => { const k = p.source ?? p.framing ?? 'core'; n[k] = (n[k] || 0) + 1; return n; }, hasRail ? { rail: stations.length } : {}),
        detail: 'each pose with its own lens at its own closest unoccluded approach; mirror poses at the mirror resolution, ground at and below the water clipped',
      } } : {}),
      ...(glacier ? { glacierGrid: 'uniform stride 2 for all tiles and quality budgets; nonlinear ice displacement requires shared edge samples' } : {}),
      triangulation: 'quads split along the (0,0)-(1,1) diagonal; finer edges snap to the coarser neighbour',
    } } : {}),
    hydrology: {
      flow: 'log2(D8 accumulation over depression-filled heights) * 16, capped 254',
      water: options.water === false ? 'none: the view declares its flats are not water' : 'hydro-flattened components (3x3 range <= 0.35 m, >= 60 cells) = 255',
    },
    payload: {
      url: options.dataUrl || `${view.id}.terrain.bin.gz`, encoding: 'gzip',
      byteLength: payload.byteLength, sha256: sha256(payload),
      decodedByteLength: decoded.byteLength, decodedSha256: sha256(decoded),
    },
    estimatedBytes: { desktop: estimate('desktop'), mobile: estimate('mobile') },
    landmarks: options.landmarks || grid.meta?.landmarks || [],
    tiles,
  };
  return { manifest, payload, decoded, stats: { tiles: tiles.length, ...manifest.estimatedBytes } };
}


// ---------------------------------------------------------------------------
// Character: the view's own skyline, measured from the DEM through its
// camera, scored on the same four axes as songs and ranges.

/**
 * The skyline seen from `pose`: for `columns` bearings across the core
 * horizontal field of view, march each ray over the grid and keep the
 * terrain point with the highest elevation angle. Returns the elevations of
 * those points (metres), their distances, and the mean horizontal spacing
 * between neighbouring skyline points.
 */
export function viewSkyline(grid, pose, { aspect = 16 / 9, columns = 160, stepM = null, maxDistM = 60000 } = {}) {
  const { width: w, height: hgt, cellSizeM: cell, originM, heightsM: h, valid } = grid;
  const step = stepM || cell;
  const f = norm3(sub3(pose.targetM, pose.eyeM));
  const yaw = Math.atan2(f[0], -f[2]); // bearing from north, clockwise
  const hfov = 2 * Math.atan(Math.tan((pose.fovYDeg * Math.PI) / 360) * aspect);
  const elev = [], dist = [], pts = [];
  for (let c = 0; c < columns; c++) {
    const b = yaw - hfov / 2 + (hfov * (c + 0.5)) / columns;
    const dx = Math.sin(b), dz = -Math.cos(b);
    let best = -Infinity, bestH = NaN, bestD = NaN, bestP = null;
    for (let d = step; d <= maxDistM; d += step) {
      const x = pose.eyeM[0] + dx * d, z = pose.eyeM[2] + dz * d;
      const gx = Math.round((x - originM[0]) / cell), gz = Math.round((z - originM[1]) / cell);
      if (gx < 0 || gz < 0 || gx >= w || gz >= hgt) break;
      const i = gz * w + gx;
      if (!valid[i]) continue;
      const a = (h[i] - pose.eyeM[1]) / d;
      if (a > best) { best = a; bestH = h[i]; bestD = d; bestP = [x, z]; }
    }
    elev.push(bestH); dist.push(bestD); pts.push(bestP);
  }
  let gap = 0, n = 0;
  for (let c = 1; c < columns; c++) {
    if (pts[c] && pts[c - 1]) { gap += Math.hypot(pts[c][0] - pts[c - 1][0], pts[c][1] - pts[c - 1][1]); n++; }
  }
  return { elevationsM: elev, distancesM: dist, spacingM: n ? gap / n : NaN };
}
