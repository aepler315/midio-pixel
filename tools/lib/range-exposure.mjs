// Range v2 visibility (plan Task 14): the far range's crest must stay at
// least MIN_FAR_EXPOSED visible at every rail station and every travel
// sample, the same protection the legacy ridge fit keeps (RidgeComposition
// MIN_EXPOSED), and a far crest must span at least MIN_FAR_CREST_COLUMNS of
// the frame. Measured on the shipped package the way the runtime draws it:
// every tile rendered in the partition its manifest assigns (`band`), each
// partition a depth raster, the far pass's skyline tested against whichever
// mid and near passes are composited over it, and the ground line.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeTerrain, buildTerrainGeometry } from '../../src/world/alpine/TerrainMesh.js';
import { travelSpans } from '../../src/world/TravelSeam.js';
import { cameraPoseAt } from '../../src/world/terrain/SceneTravel.js';
import { occlusionBuffer, MIN_FAR_EXPOSED, EXPOSURE_FRAMING, VISIBILITY } from './terrain-bake.mjs';
import { placeForest } from '../../src/world/alpine/ForestCover.js';
import { hashSeed } from '../../src/utils/math.js';

export { MIN_FAR_EXPOSED };

/** A far crest must span at least this share of the frame at every station. */
export const MIN_FAR_CREST_COLUMNS = 0.5;

/** Occlusion raster over the shipped surface, resampled every `step` cells. */
export const EXPOSURE_OCCLUSION = Object.freeze({ ...VISIBILITY.occlusion, stride: 1 });

/** Runtime partitions and the layer whose travel timing each follows
 *  (RangePresentation PASS_LAYER). */
const PASSES = Object.freeze([['far', 'L2'], ['mid', 'L4'], ['near', 'L5']]);
const OWNER = Object.freeze({ far: 1, mid: 2, near: 3 });

/** Decode a shipped terrain package (manifest + gzip payload) from disk. */
export async function loadShippedTerrain(runtimeDir, view) {
  const manifestPath = path.join(runtimeDir, view.terrainManifestUrl);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const gz = await fs.readFile(path.join(path.dirname(manifestPath), manifest.payload.url));
  const bytes = zlib.gunzipSync(gz);
  return decodeTerrain(manifest, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** Height of stored sample (u, v) of a decoded tile. */
function tileHeight(tile, gx, gz, cells) {
  const fu = (gx - tile.ix * cells) / tile.stride, fv = (gz - tile.iz * cells) / tile.stride;
  const n = tile.samples;
  const u0 = Math.min(n - 2, Math.floor(fu)), v0 = Math.min(n - 2, Math.floor(fv));
  const tu = fu - u0, tv = fv - v0;
  const at = (u, v) => tile.heightsM[v * n + u];
  const a = at(u0, v0), b = at(u0 + 1, v0), c = at(u0, v0 + 1), d = at(u0 + 1, v0 + 1);
  return tu >= tv ? a + (b - a) * tu + (d - b) * tv : a + (d - c) * tu + (c - a) * tv;
}

/**
 * A regular height grid sampled from the decoded tiles, resampled every
 * `step` source cells. With `band`, only tiles the runtime draws in that
 * partition contribute; a sample on a tile edge belongs to every tile that
 * shares it, so partitions meet without gaps. Hidden tiles are never drawn
 * and never contribute.
 */
export function gridFromTerrain(data, step = 4, { band = null } = {}) {
  const g = data.grid, cells = data.cells;
  const w = Math.floor((g.width - 1) / step) + 1, h = Math.floor((g.height - 1) / step) + 1;
  const heightsM = new Float32Array(w * h), valid = new Uint8Array(w * h);
  const drawn = (t) => t && t.visible !== false && (!band || t.band === band);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const gx = i * step, gz = j * step;
    const ixs = [Math.floor(gx / cells)], izs = [Math.floor(gz / cells)];
    if (gx % cells === 0 && gx > 0) ixs.push(gx / cells - 1);
    if (gz % cells === 0 && gz > 0) izs.push(gz / cells - 1);
    let y = NaN;
    for (const ix of ixs) for (const iz of izs) {
      const t = data.byIndex.get(`${ix},${iz}`);
      if (!Number.isFinite(y) && drawn(t)) y = tileHeight(t, gx, gz, cells);
    }
    if (Number.isFinite(y)) { heightsM[j * w + i] = y; valid[j * w + i] = 1; }
  }
  return { width: w, height: h, cellSizeM: g.cellSizeM * step, originM: [...g.originM], heightsM, valid };
}

/**
 * One station as the runtime composes it: per pixel, which partition's
 * surface is nearest (0 none, 1 far, 2 mid, 3 near) -- what each pass's
 * image actually contains after the shared depth pre-pass -- and, per
 * column, the top row of the far partition's skyline (-1 = none).
 */
export function stationMasks(bands, pose, { framing = EXPOSURE_FRAMING, occ = EXPOSURE_OCCLUSION, trees = null } = {}) {
  const buf = {};
  // A band is either the runtime mesh ({ positions, indices }) or a height
  // grid (synthetic fixtures).
  for (const [name] of PASSES) {
    buf[name] = bands[name]?.indices ? meshDepthBuffer(bands[name], pose, framing, occ) : occlusionBuffer(bands[name], pose, framing, occ);
  }
  // Trees are in the runtime depth pre-pass too, each in its own band.
  if (trees) rasterTrees(buf, trees);
  const { W, H } = buf.far;
  const owner = new Uint8Array(W * H);
  for (let o = 0; o < W * H; o++) {
    const f = buf.far.buf[o], m = buf.mid.buf[o], n = buf.near.buf[o];
    // Larger 1/depth is nearer, exactly as the runtime depth pre-pass
    // orders them: the nearest surface owns the pixel.
    if (n > 0 && n >= m && n >= f) owner[o] = OWNER.near;
    else if (m > 0 && m >= f) owner[o] = OWNER.mid;
    else if (f > 0) owner[o] = OWNER.far;
  }
  const topFar = new Int16Array(W).fill(-1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) if (buf.far.buf[y * W + x] > 0) { topFar[x] = y; break; }
  }
  // Per column, at the far crest: is far nearer than this side's own mid /
  // near there? (During travel a side's depth pre-pass holds a nearer band
  // only in the columns it draws that band.) Per pixel: does this side have
  // a mid (bit 1) or near (bit 2) surface that would cover the other side?
  const farBeatsMid = new Uint8Array(W), farBeatsNear = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    const y = topFar[x];
    if (y < 0) continue;
    const o = y * W + x, f = buf.far.buf[o];
    farBeatsMid[x] = buf.mid.buf[o] > f ? 0 : 1;
    farBeatsNear[x] = buf.near.buf[o] > f ? 0 : 1;
  }
  const presence = new Uint8Array(W * H);
  for (let o = 0; o < W * H; o++) presence[o] = (buf.mid.buf[o] > 0 ? 2 : 0) | (buf.near.buf[o] > 0 ? 4 : 0);
  return { W, H, groundRow: Math.floor((framing.groundFrac ?? 1) * H), owner, topFar, farBeatsMid, farBeatsNear, presence };
}

/**
 * Depth raster (nearest 1/depth per pixel) of one band's runtime mesh --
 * the exact desktop-LOD triangles RangeScene draws, edge snapping included
 * -- with the same projection as occlusionBuffer.
 */
export function meshDepthBuffer(mesh, pose, framing, occ) {
  const W = occ.width, H = Math.max(2, Math.round(occ.width / framing.aspect));
  const buf = new Float32Array(W * H);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(sub(pose.targetM, pose.eyeM));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const t = Math.tan((pose.fovYDeg * Math.PI) / 360) * framing.fovScale;
  const P = mesh.positions, I = mesh.indices;
  const nv = P.length / 3;
  const sx = new Float32Array(nv), sy = new Float32Array(nv), iz = new Float32Array(nv);
  const e = pose.eyeM;
  for (let v = 0; v < nv; v++) {
    const dx = P[3 * v] - e[0], dy = P[3 * v + 1] - e[1], dz = P[3 * v + 2] - e[2];
    const z = dx * f[0] + dy * f[1] + dz * f[2];
    if (z < 1) { iz[v] = -1; continue; }
    sx[v] = ((dx * r[0] + dy * r[1] + dz * r[2]) / (z * t * framing.aspect) * 0.5 + 0.5) * W;
    sy[v] = (0.5 - (dx * u[0] + dy * u[1] + dz * u[2]) / (z * t) * 0.5) * H;
    iz[v] = 1 / z;
  }
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k], b = I[k + 1], c = I[k + 2];
    if (iz[a] < 0 || iz[b] < 0 || iz[c] < 0) continue;
    const minX = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
    if (minX > maxX) continue;
    const minY = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
    if (minY > maxY) continue;
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
    if (Math.abs(area) < 1e-9) continue;
    for (let py = minY; py <= maxY; py++) {
      const y = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5;
        const w0 = ((sx[b] - x) * (sy[c] - y) - (sx[c] - x) * (sy[b] - y)) / area;
        const w1 = ((sx[c] - x) * (sy[a] - y) - (sx[a] - x) * (sy[c] - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * iz[a] + w1 * iz[b] + w2 * iz[c];
        const o = py * W + px;
        if (d > buf[o]) buf[o] = d;
      }
    }
  }
  return { buf, W, H, f, r, u, t, eye: pose.eyeM, aspect: framing.aspect };
}

/**
 * Rasterise placed trees ({ data, stride } from placeForest, band 0 far /
 * 1 mid / 2 near) into the band depth buffers, each tree as a triangle
 * facing the camera: its crown's width at the foot, its apex at its height.
 */
function rasterTrees(buf, { data, stride }) {
  const names = ['far', 'mid', 'near'];
  const ob0 = buf.far;
  const { r, f, u, t, eye, W, H, aspect } = ob0;
  const proj = (p) => {
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z < 1) return null;
    return [((d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * t * aspect) * 0.5 + 0.5) * W,
      (0.5 - (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * t) * 0.5) * H, 1 / z];
  };
  for (let i = 0; i < data.length; i += stride) {
    const x = data[i], y = data[i + 1], z = data[i + 2], h = data[i + 3], w = data[i + 4], band = data[i + 7];
    const target = buf[names[band]];
    if (!target) continue;
    const half = w / 2;
    const a = proj([x - r[0] * half, y, z - r[2] * half]), b = proj([x + r[0] * half, y, z + r[2] * half]), c = proj([x, y + h, z]);
    if (!a || !b || !c) continue;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    if (minX > maxX || minY > maxY) continue;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const X = px + 0.5, Y = py + 0.5;
      const w0 = ((b[0] - X) * (c[1] - Y) - (c[0] - X) * (b[1] - Y)) / area;
      const w1 = ((c[0] - X) * (a[1] - Y) - (a[0] - X) * (c[1] - Y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const iz = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const o = py * W + px;
      if (iz > target.buf[o]) target.buf[o] = iz;
    }
  }
}

/** The view's trees exactly as RangeScene places them (full quality). */
export function viewTrees(data, view, rules) {
  const placed = placeForest(data, view, rules, { seed: hashSeed(view.id) });
  const all = new Float32Array(placed.meshDetail.length + placed.mesh.length + placed.billboard.length);
  all.set(placed.meshDetail, 0);
  all.set(placed.mesh, placed.meshDetail.length);
  all.set(placed.billboard, placed.meshDetail.length + placed.mesh.length);
  return { data: all, stride: placed.stride };
}

/** Exposed share of the far crest in one composed frame, where each
 *  partition p in columns x comes from `sideOf(p, x)`'s masks. */
function composedExposure(sideOf, W) {
  let crest = 0, shown = 0;
  for (let x = 0; x < W; x++) {
    const f = sideOf('far', x);
    const y = f.topFar[x];
    if (y < 0) continue;
    crest++;
    if (y >= f.groundRow) continue;
    const o = y * W + x;
    const m = sideOf('mid', x), n = sideOf('near', x);
    // The far image holds the crest unless one of its own side's nearer
    // bands -- only those that side draws in this column -- is in front of
    // it; the other side's mid / near images drawn over it must not cover it.
    if (m === f ? !f.farBeatsMid[x] : (m.presence[o] & 2)) continue;
    if (n === f ? !f.farBeatsNear[x] : (n.presence[o] & 4)) continue;
    shown++;
  }
  return { fraction: crest ? shown / crest : 0, crestColumns: crest / W };
}

/** Exposure of one view's station: all partitions from the same side. */
export function maskExposure(m) {
  return composedExposure(() => m, m.W);
}

/** Per-station exposure of a shipped view: { stations, min, minCrest }. */
export async function viewExposure(runtimeDir, view, { stations = VISIBILITY.stations, rules = null } = {}) {
  const data = await loadShippedTerrain(runtimeDir, view);
  // The runtime's own desktop meshes, band by band.
  const meshes = buildTerrainGeometry(data, { budget: 'desktop' }).bands;
  // The forest the scene would place (its material rules and the view's
  // overrides); without a material pack, terrain alone.
  let packRules = rules;
  if (!packRules && view.materialManifestUrl) {
    const pack = JSON.parse(await fs.readFile(path.join(runtimeDir, view.materialManifestUrl), 'utf8'));
    packRules = { ...pack.rules, ...(view.materialRules || {}) };
  }
  const trees = packRules ? viewTrees(data, view, packRules) : null;
  const list = [];
  for (let k = 0; k < stations; k++) {
    const masks = stationMasks(meshes, cameraPoseAt(view, stations > 1 ? k / (stations - 1) : 0), { trees });
    list.push({ ...maskExposure(masks), masks });
  }
  return {
    stations: list,
    min: Math.min(...list.map((s) => s.fraction)),
    minCrest: Math.min(...list.map((s) => s.crestColumns)),
  };
}

/** Whether side B supplies column x of a pass at seam progress p. */
function useB(spans, x) {
  const cx = x + 0.5;
  if (cx < spans.lo) return false;
  if (cx >= spans.hi) return true;
  return (spans.bands.find((b) => cx >= b.x0 && cx < b.x1)?.weightB ?? 0.5) >= 0.5;
}

/**
 * Exposure and crest coverage ({ fraction, crestColumns }) of a travel
 * composite at seam progress `p`. Each partition
 * follows its own seam (far L2, mid L4, near L5), so at one column the far
 * crest may come from side A while side B's mid or near pass already covers
 * it; the feather band splits at weight 0.5.
 */
export function travelExposure(masksA, masksB, p) {
  const W = masksA.W;
  const spans = Object.fromEntries(PASSES.map(([name, layer]) => [name, travelSpans(W, layer, p)]));
  return composedExposure((pass, x) => (useB(spans[pass], x) ? masksB : masksA), W);
}

/**
 * The worst far-crest exposure of a travel between two views. Both sides
 * render at the same song progress (RangeScene uses one frame.progress01),
 * so side A's station k is blended with side B's station k, at every seam
 * sample. Returns { min, at: { station, p } }.
 */
export function pairExposure(expA, expB, { seamSamples = 21 } = {}) {
  let min = Infinity, at = null, minCrest = Infinity, crestAt = null;
  const n = Math.min(expA.stations.length, expB.stations.length);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < seamSamples; j++) {
      const p = seamSamples > 1 ? j / (seamSamples - 1) : 0;
      const e = travelExposure(expA.stations[k].masks, expB.stations[k].masks, p);
      if (e.fraction < min) { min = e.fraction; at = { station: k, p }; }
      if (e.crestColumns < minCrest) { minCrest = e.crestColumns; crestAt = { station: k, p }; }
    }
  }
  return { min, at, minCrest, crestAt };
}
