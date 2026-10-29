// Offline compiler for the compiled terrain experiment
// (docs/compiled-terrain-experiment.md). From one normalized, despiked DEM
// grid it bakes the production material rules into per-face colours and
// emits two packs (src/world/alpine/CompiledTerrain.js is the contract):
//
//   columns  world-anchored height columns: top faces and exposed side spans
//   mesh     the triangulated control: same chunks, levels, colours, shader
//
// Deterministic: no clocks, no randomness, stable iteration orders, gzip
// header zeroed. Nothing here runs at playback.
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import {
  COMPILED_SCHEMA, COMPILED_VERSION, COMPILED_Y_UNIT_M, COMPILED_ATLAS_SCALE, COMPILED_NO_DATA, COMPILED_PILOT, compiledCameraView,
} from '../../src/world/alpine/CompiledTerrain.js';
import { BANDS, buildReceiverMask } from '../../src/world/alpine/TerrainMesh.js';
import { boxMayBeVisible, viewDepthToBox, distanceToBox, cameraPoseAt } from '../../src/world/terrain/SceneTravel.js';
import { LAND_MAX_DISPLACEMENT_M, LAND_WAVE_K } from '../../src/world/alpine/LandMotionLimits.js';
import { LAND_SWELL } from '../../src/world/alpine/RangeFrame.js';
import { materialDetailPosition, noise as vnoise12 } from '../../src/world/alpine/MaterialDetailDomain.js';
import { hexToLinear, RULE_DEFAULTS } from '../../src/world/alpine/MaterialPackage.js';
import { expectedForestCover, meanForestTraits } from '../../src/world/alpine/TerrainMaterial.js';
import { fillDepressions, flowAccumulation, waterMask, gridTileBoxes, VISIBILITY } from './terrain-bake.mjs';

export const COMPILER_VERSION = '1.0.0';

/** Chosen pilot settings. Horizontal cell size and vertical quantum are set
 *  per level and independently; both are world-anchored (cells on the DEM
 *  lattice from its origin, heights at multiples of the quantum from 0 m). */
export const DEFAULT_SETTINGS = Object.freeze({
  chunkCells: 64,
  levels: Object.freeze([
    Object.freeze({ level: 0, cellSamples: 1, quantumM: 5 }),
    Object.freeze({ level: 1, cellSamples: 2, quantumM: 10 }),
  ]),
  // Fixed detail selection: chunks within this distance of any declared
  // rail eye use level 0, the rest level 1.
  level0WithinM: 4000,
  // Faces merge only inside world-aligned blocks of this size: a
  // T-junction on a merged edge opens at most mergeGapBoundM under the
  // land swell, which must stay within gapToleranceM.
  mergeBlockM: 160,
  bakeSamplesPerCell: 3,
  gapToleranceM: 0.1,
  // Material atlas width in texels (tiles: one texel per column, or per
  // control lattice vertex).
  atlasWidth: 2048,
});

/** Named setting profiles (tools/build-compiled-terrain.mjs --profile). */
export const PROFILES = Object.freeze({
  default: Object.freeze({}),
  // Fewer far triangles: 80 m cells with a 20 m step beyond 3 km.
  lean: Object.freeze({ level0WithinM: 3000, levels: Object.freeze([
    Object.freeze({ level: 0, cellSamples: 1, quantumM: 5 }), Object.freeze({ level: 1, cellSamples: 4, quantumM: 20 })]) }),
});

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Deformation bound.

/** Widest gap a T-junction can open on a merged edge of length `lengthM`
 *  under the land swell: the edge interpolates its corners while interior
 *  vertices follow h²·A·sin(k·s - φ), whose second derivative along s is at
 *  most A·k². `channels` 'landscape' uses the channels Landscape drives
 *  (RangeFrame.landMotion: the slow wave; the lift is uniform); 'all' adds
 *  the melodic tilt at its shortest wavelength, every channel at the cap. */
export function mergeGapBoundM(lengthM, heightRangeM, channels = 'landscape') {
  const span = Math.max(1, heightRangeM[1] - heightRangeM[0]);
  const cap = Math.min(LAND_MAX_DISPLACEMENT_M, span * 0.065); // calibrateRangeMusic
  const reference = 106.7; // RANGE_MOTION_REFERENCE_M
  const k2 = LAND_WAVE_K * LAND_WAVE_K;
  const curvature = channels === 'all'
    ? cap * (k2 + (2 * Math.PI / 2400) ** 2)
    : (LAND_SWELL.waveM * cap / reference) * k2;
  return (lengthM * lengthM / 8) * curvature;
}

// ---------------------------------------------------------------------------
// Source surface: the production surface texture's channels, at stride 1.

/** Per-sample bytes as TerrainMesh.buildSurfaceTexture writes them (normal
 *  x/z, curvature, flow with 255 = water), from the whole grid, plus the
 *  water mask itself. Hydrology runs on the whole grid like the baker. */
export function sourceSurface(grid, { water: waterOptions = undefined } = {}) {
  const { width: W, height: H, cellSizeM: cell, heightsM: h, valid } = grid;
  const filled = fillDepressions(h, valid, W, H);
  const acc = flowAccumulation(filled, valid, W, H);
  const water = waterOptions === false ? new Uint8Array(W * H) : waterMask(h, valid, W, H, waterOptions);
  const out = new Uint8Array(W * H * 4);
  const at = (x, z) => h[Math.min(H - 1, Math.max(0, z)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x, o = i * 4, h0 = h[i];
      if (!valid[i]) { out[o] = out[o + 1] = out[o + 2] = 128; out[o + 3] = 0; continue; }
      let hl = at(x - 1, z), hr = at(x + 1, z), hu = at(x, z - 1), hd = at(x, z + 1);
      if (!Number.isFinite(hl)) hl = h0; if (!Number.isFinite(hr)) hr = h0;
      if (!Number.isFinite(hu)) hu = h0; if (!Number.isFinite(hd)) hd = h0;
      const dx = (hr - hl) / (2 * cell), dz = (hd - hu) / (2 * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      out[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((-dz * inv * 0.5 + 0.5) * 255);
      let sum = 0, cnt = 0;
      for (const [ox, oz] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]]) {
        const hv = at(x + ox, z + oz);
        if (Number.isFinite(hv)) { sum += hv; cnt++; }
      }
      const lap = cnt ? sum / cnt - h0 : 0;
      out[o + 2] = Math.max(0, Math.min(255, Math.round(128 + lap * (127 / 12))));
      out[o + 3] = water[i] ? 255 : Math.min(254, Math.round(Math.log2(Math.max(1, acc[i])) * 16));
    }
  }
  return { width: W, height: H, data: out, water };
}

/** Bilinear read of the surface bytes at fractional grid coordinates, as the
 *  GPU's linear filter reads the texture: decoded normal, curvature, flow. */
function surfaceAt(surface, gx, gz) {
  const { width: W, height: H, data } = surface;
  const x = Math.min(W - 1, Math.max(0, gx)), z = Math.min(H - 1, Math.max(0, gz));
  const x0 = Math.min(W - 2, Math.floor(x)), z0 = Math.min(H - 2, Math.floor(z)), tx = x - x0, tz = z - z0;
  const ch = (c) => {
    const a = data[(z0 * W + x0) * 4 + c], b = data[(z0 * W + x0 + 1) * 4 + c];
    const d = data[((z0 + 1) * W + x0) * 4 + c], e = data[((z0 + 1) * W + x0 + 1) * 4 + c];
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz) / 255;
  };
  const nx = ch(0) * 2 - 1, nz = ch(1) * 2 - 1;
  const n = [nx, Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)), nz];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return { n: [n[0] / l, n[1] / l, n[2] / l], curv: (ch(2) - 0.5) * 2, flowN: clamp01(ch(3) * 255 / 254) };
}

/** Bilinear DEM height at fractional grid coordinates (NaN near no-data). */
function demAt(grid, gx, gz) {
  const { width: W, height: H, heightsM: h } = grid;
  const x = Math.min(W - 1, Math.max(0, gx)), z = Math.min(H - 1, Math.max(0, gz));
  const x0 = Math.min(W - 2, Math.floor(x)), z0 = Math.min(H - 2, Math.floor(z)), tx = x - x0, tz = z - z0;
  const a = h[z0 * W + x0], b = h[z0 * W + x0 + 1], c = h[(z0 + 1) * W + x0], d = h[(z0 + 1) * W + x0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// ---------------------------------------------------------------------------
// Material detail textures (data: RG normal, B, A height).

/** Box-filtered mip chain of one channel of an RGBA8 image, as
 *  generateMipmap builds it for the GPU sampler. */
export function heightMips({ width, height, rgba }, channel = 3) {
  const levels = [];
  let w = width, hgt = height;
  let cur = new Float32Array(w * hgt);
  for (let i = 0; i < w * hgt; i++) cur[i] = rgba[i * 4 + channel] / 255;
  levels.push({ w, h: hgt, data: cur });
  while (w > 1 || hgt > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, hgt >> 1);
    const next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let s = 0, k = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(hgt - 1, y * 2 + dy);
        s += cur[sy * w + sx]; k++;
      }
      next[y * nw + x] = s / k;
    }
    levels.push({ w: nw, h: nh, data: next });
    cur = next; w = nw; hgt = nh;
  }
  return levels;
}

function sampleLevel(L, u, v) {
  const x = u * L.w - 0.5, y = v * L.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const at = (i, j) => L.data[(((j % L.h) + L.h) % L.h) * L.w + (((i % L.w) + L.w) % L.w)];
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** Trilinear, repeating read: `footprintM` of world per sample picks the mip. */
function sampleMips(mips, u, v, texelsPerSample) {
  const lod = Math.min(mips.length - 1, Math.max(0, Math.log2(Math.max(1, texelsPerSample))));
  const l0 = Math.floor(lod), t = lod - l0, l1 = Math.min(mips.length - 1, l0 + 1);
  const a = sampleLevel(mips[l0], u, v);
  return t > 0 ? mix(a, sampleLevel(mips[l1], u, v), t) : a;
}

/** triplanarRib's blended height (TerrainMaterial.js), box-filtered over a
 *  sample footprint. GLSL mat2(c,-s,s,c) is column-major. */
function triplanarHeight(tex, p, n, scale, rot, rib, footprintM) {
  if (!tex) return 0.5;
  let wx = n[0] ** 4, wy = n[1] ** 4, wz = n[2] ** 4;
  const ws = wx + wy + wz; wx /= ws; wy /= ws; wz /= ws;
  const c = Math.cos(rot), s = Math.sin(rot);
  const R = (a, b) => [(c * a + s * b) / scale, (-s * a + c * b) / scale];
  const texels = footprintM * tex.width / scale;
  const read = ([u, v]) => sampleMips(tex.mips, u, v, texels);
  return wx * read(R(p[2], p[1] * rib)) + wy * read(R(p[0], p[2])) + wz * read(R(p[0], p[1] * rib));
}

// ---------------------------------------------------------------------------
// The production albedo, at rest (no swell, no glacier, no storm).

/** Linear palette and rule values the bake reads, from a material manifest
 *  plus the view's rule overrides. */
export function bakeMaterial(materialManifest, ruleOverrides = {}) {
  const rules = { ...RULE_DEFAULTS, ...materialManifest.rules, ...ruleOverrides };
  const p = Object.fromEntries(Object.entries(materialManifest.palette).map(([k, hex]) => [k, hexToLinear(hex)]));
  return { palette: p, rules, textures: {} };
}

/**
 * Albedo and ambient occlusion of the production terrain material at world
 * point (x, y, z) with surface sample `s`, ported from SCENE_FRAG. View-
 * dependent terms are fixed at `eyeM` (the rail's middle eye): forest colour
 * by distance and crown cover by view angle; the far-forest ring is taken as
 * fully mixed. Mapped-only water views never draw terrain water.
 */
export function materialAlbedo(mat, x, y, z, s, { eyeM, footprintM }) {
  const { palette: P, rules: r, textures: T } = mat;
  const n = s.n, curv = s.curv, flowN = s.flowN;
  const slopeDeg = Math.acos(Math.min(1, Math.max(0, n[1]))) * 180 / Math.PI;
  const dp = materialDetailPosition([x, y, z]);
  const sRock = T.rockDetail?.metersPerTile ?? 150;
  const macroH = triplanarHeight(T.rockDetail, dp, n, sRock, 0, 0.35, footprintM);
  const macro2H = triplanarHeight(T.rockDetail, dp, n, sRock * 0.37, 1.1, 0.5, footprintM);
  const rh = mix(macroH, macro2H, 0.35);
  const breakup = vnoise12(x / 23, z / 23) * 0.15 + rh;
  const treeLine = r.treelineM + (breakup - 0.5) * 220 + curv * 140;
  const alpine = smoothstep(treeLine - 50, treeLine + 350, y);
  const cliff0 = Math.max(40, r.forestMaxSlopeDeg - 6);
  let rockMask = smoothstep(cliff0, Math.max(cliff0 + 8, r.forestMaxSlopeDeg + 10), slopeDeg + (rh - 0.5) * 16 - curv * 12);
  rockMask = Math.max(rockMask, smoothstep(0.45, 0.9, -curv) * smoothstep(30, 44, slopeDeg) * 0.7);
  rockMask = Math.max(rockMask, alpine * smoothstep(20, 38, slopeDeg + (rh - 0.5) * 18 - curv * 10));
  const forest = (1 - smoothstep(treeLine - 90, treeLine + 60, y))
    * (1 - smoothstep(r.forestMaxSlopeDeg - 6, r.forestMaxSlopeDeg + 4, slopeDeg))
    * smoothstep(r.forestFloorM - 60, r.forestFloorM + 60, y + (breakup - 0.5) * 200) * r.forestDensity;
  const snowLine = r.snowlineM + (breakup - 0.5) * 260 - curv * 180;
  let snow = smoothstep(snowLine, Math.max(snowLine + 1, snowLine + (r.snowFullM - r.snowlineM)), y);
  snow *= 1 - smoothstep(r.snowMaxSlopeDeg - 10, r.snowMaxSlopeDeg + 6, slopeDeg - Math.max(curv, 0) * 25);
  let ground = mix3(P.meadow, P.soil, smoothstep(18, 34, slopeDeg));
  ground = mix3(ground, P.moss, r.moss * smoothstep(0.35, 0.75, flowN) * smoothstep(1.5, 5, slopeDeg) * (1 - rockMask));
  let rockCol = mix3(P.rockShade, P.rockLit, clamp01(rh * 1.2 - 0.1 + curv * -0.25));
  rockCol = mix3(rockCol, P.rockWarm, r.strata * smoothstep(0.55, 0.9, macro2H));
  rockCol = mix3(rockCol, P.lichen, 0.25 * (1 - rockMask));
  rockCol = scale3(rockCol, 1 - 0.45 * smoothstep(0.25, 0.6, flowN) * smoothstep(35, 55, slopeDeg));
  rockCol = scale3(rockCol, 0.7 + 0.6 * macroH);
  const toEye = [eyeM[0] - x, eyeM[1] - y, eyeM[2] - z];
  const dist = Math.hypot(...toEye) || 1;
  const ray = toEye.map(v => v / dist);
  const forestCol = mix3(P.forestNear, P.forestFar, smoothstep(1500, 12000, dist));
  const understory = forestCol.map((c, i) => c * (0.45 + 0.1 * clamp01(ground[i])));
  const crown = meanForestTraits({ below: treeLine - y, slopeDeg, scale: r.treeScale ?? 1 });
  const cover = expectedForestCover({ forest, radius: crown.radius, crownHeight: crown.crownHeight, normal: n, toEye: ray });
  const habitat = r.forestDensity > 0 ? clamp01(forest / r.forestDensity) : 0;
  const openGround = mix3(ground, rockCol, rockMask);
  const crownLit = scale3(forestCol, 0.78);
  let albedo = mix3(openGround, mix3(understory, crownLit, cover), habitat);
  if (snow > 0) {
    const sSnow = T.snow?.metersPerTile ?? 60;
    const sn = mix(triplanarHeight(T.snow, dp, n, sSnow, 0.7, 1, footprintM), triplanarHeight(T.snow, dp, n, sSnow * 3.7, 2.1, 1, footprintM), 0.5);
    albedo = mix3(albedo, mix3(P.snowShade, P.snow, 0.7 + 0.3 * sn), snow);
  }
  const ao = Math.min(1, Math.max(0.35, 1 - Math.max(curv, 0) * 0.55 - flowN * 0.12));
  return { albedo, ao };
}

const srgbByte = (v) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

// ---------------------------------------------------------------------------
// Coverage and the chunk plan.

function stations(view, count = VISIBILITY.stations) {
  return Array.from({ length: count }, (_, k) => cameraPoseAt(view, count > 1 ? k / (count - 1) : 0));
}

/**
 * Chunks to compile: every 64-cell tile whose box (lifted by the largest
 * swell) can enter the extended framing of a declared rail station, with no
 * occlusion culling, plus every tile of the shipped package. `coverage`
 * 'all' takes every tile (synthetic tests). Bands follow the shipped tiles,
 * else the baker's rule on the default rail's view depth; level 0 within
 * `level0WithinM` of any declared eye.
 */
export function planChunks(grid, { view = null, cameras = [], original = null, settings, coverage = 'rails' }) {
  const cells = settings.chunkCells;
  const layout = gridTileBoxes(grid, cells);
  const ext = VISIBILITY.extended;
  const rails = view ? [view, ...cameras.map(c => compiledCameraView(view, c))] : [];
  const railStations = rails.map(v => stations(v));
  const defaultStations = railStations[0] || [];
  const originalTiles = new Map((original?.tiles || []).map(t => [`${t.ix},${t.iz}`, t]));
  const bandRule = { nearM: 1800, midM: 7000, ...(original?.bands || {}), ...(view?.bands || {}) };
  const chunks = [];
  for (let iz = 0; iz < layout.tilesZ; iz++) for (let ix = 0; ix < layout.tilesX; ix++) {
    const box = layout.boxes[iz * layout.tilesX + ix];
    if (!box) continue;
    const lifted = { min: [box.min[0], box.min[1] - LAND_MAX_DISPLACEMENT_M, box.min[2]], max: [box.max[0], box.max[1] + LAND_MAX_DISPLACEMENT_M, box.max[2]] };
    const shipped = originalTiles.get(`${ix},${iz}`);
    const seen = coverage === 'all' || !!shipped
      || railStations.some(list => list.some(pose => boxMayBeVisible(pose, ext.aspect, lifted, ext.fovScale)));
    if (!seen) continue;
    let band = shipped?.band;
    if (!band) {
      let reach = Infinity;
      for (const pose of defaultStations) {
        if (!boxMayBeVisible(pose, ext.aspect, lifted, ext.fovScale)) continue;
        reach = Math.min(reach, Math.max(VISIBILITY.minDistanceM, viewDepthToBox(pose, box)));
      }
      band = reach < bandRule.nearM ? 'near' : reach < bandRule.midM ? 'mid' : 'far';
    }
    const near = railStations.flat().reduce((d, pose) => Math.min(d, distanceToBox(pose.eyeM, box)), Infinity);
    const level = coverage === 'all' && !view ? 0 : near < settings.level0WithinM ? 0 : 1;
    chunks.push({ id: `t${ix}_${iz}`, ix, iz, band, level, shipped: !!shipped, nearestEyeM: Number.isFinite(near) ? Math.round(near) : null });
  }
  return { chunks, layout, bands: bandRule };
}

// ---------------------------------------------------------------------------
// Heights.

/** Area mean of the bilinear DEM surface over the cell spanning samples
 *  [gx, gx + s] x [gz, gz + s] (trapezoid weights); NaN over no-data. */
export function cellMeanHeight(grid, gx, gz, s) {
  const { width: W, height: H, heightsM: h, valid } = grid;
  if (gx < 0 || gz < 0 || gx + s > W - 1 || gz + s > H - 1) return NaN;
  let sum = 0, wsum = 0;
  for (let j = 0; j <= s; j++) {
    const wj = j === 0 || j === s ? 0.5 : 1;
    for (let i = 0; i <= s; i++) {
      const k = (gz + j) * W + gx + i;
      if (!valid[k]) return NaN;
      const w = wj * (i === 0 || i === s ? 0.5 : 1);
      sum += w * h[k]; wsum += w;
    }
  }
  return sum / wsum;
}

/** World-anchored vertical quantization: nearest multiple of `quantumM`. */
export function quantizeHeight(y, quantumM) {
  return quantumM > 0 ? Math.round(y / quantumM) * quantumM : y;
}

// ---------------------------------------------------------------------------
// Geometry assembly.

/** One chunk's vertices (deduplicated by position and normal), indices and
 *  material-atlas coordinates. Positions are world metres here; they become
 *  Int16 chunk-local values when the pack is written. */
class ChunkGeometry {
  constructor(atlasOf) { this.pos = []; this.nrm = []; this.atl = []; this.idx = []; this.ids = new Map(); this.atlasOf = atlasOf; this.tops = 0; this.sides = 0; }
  vertex(p, normal) {
    const key = `${p[0]},${p[1]},${p[2]},${normal[0]},${normal[1]},${normal[2]}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.pos.length / 3;
      this.ids.set(key, id);
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(Math.round(normal[0] * 127), Math.round(normal[1] * 127), Math.round(normal[2] * 127), 0);
      const [ax, ay] = this.atlasOf(p);
      this.atl.push(ax, ay);
    }
    return id;
  }
  /** A planar quad, wound counter-clockwise as seen from `normal`. */
  quad(corners, normal) {
    const [a, b, c] = corners;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const ordered = cr[0] * normal[0] + cr[1] * normal[1] + cr[2] * normal[2] >= 0 ? corners : [corners[0], corners[3], corners[2], corners[1]];
    const ids = ordered.map(p => this.vertex(p, normal));
    this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }
}

/** Greedy rectangles of equal keys inside world-aligned blocks of `block`
 *  cells. `key(u, v)` is null for cells without a face. */
export function greedyRectangles(n, block, key) {
  const done = new Uint8Array(n * n), out = [];
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
    if (done[v * n + u]) continue;
    const k = key(u, v);
    if (k === null) { done[v * n + u] = 1; continue; }
    const uEnd = Math.min(n, (Math.floor(u / block) + 1) * block), vEnd = Math.min(n, (Math.floor(v / block) + 1) * block);
    let u1 = u + 1;
    while (u1 < uEnd && !done[v * n + u1] && key(u1, v) === k) u1++;
    let v1 = v + 1;
    grow: while (v1 < vEnd) {
      for (let x = u; x < u1; x++) if (done[v1 * n + x] || key(x, v1) !== k) break grow;
      v1++;
    }
    for (let y = v; y < v1; y++) for (let x = u; x < u1; x++) done[y * n + x] = 1;
    out.push({ u0: u, v0: v, u1, v1, key: k });
  }
  return out;
}

/** Contiguous runs of equal keys along one line, split at block edges. */
export function mergeRuns(items, block) {
  items.sort((a, b) => a.a0 - b.a0);
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.a1 === it.a0 && last.key === it.key && Math.floor(last.a0 / block) === Math.floor(it.a0 / block)) last.a1 = it.a1;
    else out.push({ ...it });
  }
  return out;
}

/** Shelf-pack square tiles (largest first, then chunk order) into an atlas
 *  `width` texels wide. Deterministic. */
export function packAtlas(tiles, width) {
  const order = tiles.map((t, i) => i).sort((a, b) => tiles[b].size - tiles[a].size || a - b);
  let x = 0, y = 0, shelf = 0;
  const at = new Array(tiles.length);
  for (const i of order) {
    const s = tiles[i].size;
    if (s > width) throw new Error(`atlas tile ${s} wider than ${width}`);
    if (x + s > width) { x = 0; y += shelf; shelf = 0; }
    at[i] = { x, y, size: s };
    x += s; shelf = Math.max(shelf, s);
  }
  return { tiles: at, width, height: Math.max(1, y + shelf) };
}

// ---------------------------------------------------------------------------
// The compiler.

const DIRS = Object.freeze([
  { name: '+x', d: [1, 0], normal: [1, 0, 0] }, { name: '-x', d: [-1, 0], normal: [-1, 0, 0] },
  { name: '+z', d: [0, 1], normal: [0, 0, 1] }, { name: '-z', d: [0, -1], normal: [0, 0, -1] },
]);

/**
 * Compile both representations from one bake.
 *   grid       normalized DEM after the production despike (DemGrid shape)
 *   view       runtime catalog view (camera, materialRules, bands) or null
 *   material   bakeMaterial(...) with optional textures { rockDetail, snow }
 *   options    { settings, cameras, original (shipped terrain manifest),
 *                coverage: 'rails' | 'all', levelFor(chunk), heightRangeM,
 *                identity (source/material records for the manifest),
 *                water, surface (a precomputed sourceSurface) }
 * Returns { packs: { columns, mesh }, plan } where each pack is
 * { manifest, payload (gzip Buffer), decoded (Buffer) }.
 */
export function compileTerrainPacks(grid, view, material, options = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings || {}) };
  const cells = settings.chunkCells;
  for (const l of settings.levels) {
    const cm = l.cellSamples * grid.cellSizeM;
    if (COMPILED_ATLAS_SCALE % l.cellSamples) throw new Error(`level ${l.level}: ${l.cellSamples}-sample cells need finer atlas fixed point`);
    if (cells % l.cellSamples || settings.mergeBlockM % cm || (cells * grid.cellSizeM) % settings.mergeBlockM) {
      throw new Error(`level ${l.level}: ${cm} m cells, ${settings.mergeBlockM} m merge blocks and ${cells}-sample chunks must nest`);
    }
  }
  // Chunks tile the grid exactly (the shipped tile lattice): no chunk may
  // reach past the source, where indices would wrap into the next row.
  if ((grid.width - 1) % cells || (grid.height - 1) % cells) {
    throw new Error(`grid ${grid.width}x${grid.height} does not tile into ${cells}-cell chunks`);
  }
  const levels = new Map(settings.levels.map(l => [l.level, l]));
  const plan = planChunks(grid, { view, cameras: options.cameras || [], original: options.original, settings, coverage: options.coverage || 'rails' });
  if (options.levelFor) for (const c of plan.chunks) c.level = options.levelFor(c);
  const surface = options.surface || sourceSurface(grid, { water: options.water });
  const heightRangeM = options.heightRangeM || (() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < grid.heightsM.length; i++) if (grid.valid[i]) { lo = Math.min(lo, grid.heightsM[i]); hi = Math.max(hi, grid.heightsM[i]); }
    return [lo, hi];
  })();
  const gap = {
    blockM: settings.mergeBlockM,
    landscapeM: Math.round(mergeGapBoundM(settings.mergeBlockM, heightRangeM, 'landscape') * 1e4) / 1e4,
    allChannelsM: Math.round(mergeGapBoundM(settings.mergeBlockM, heightRangeM, 'all') * 1e4) / 1e4,
  };
  if (gap.landscapeM > settings.gapToleranceM) throw new Error(`merge block ${settings.mergeBlockM} m opens ${gap.landscapeM} m > ${settings.gapToleranceM} m under the land swell`);
  const eyeM = view ? cameraPoseAt(view, 0.5).eyeM : [grid.originM[0], heightRangeM[1] + 1000, grid.originM[1]];
  const { width: W, height: H, cellSizeM: cell, originM } = grid;
  const byIndex = new Map(plan.chunks.map(c => [`${c.ix},${c.iz}`, c]));
  const water = surface.water;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < water.length; i++) if (water[i]) rgba[i * 4 + 3] = 255;
  const receiver = buildReceiverMask({ width: W, height: H, data: rgba });
  // Receiver pinned near water: no merged edge may interpolate across it.
  const dry = (gx, gz) => receiver.data[Math.min(H - 1, Math.max(0, Math.round(gz))) * W + Math.min(W - 1, Math.max(0, Math.round(gx)))] === 255;

  // Column heights: world-anchored cells, area means, world-anchored steps.
  for (const c of plan.chunks) {
    const L = levels.get(c.level), s = L.cellSamples, n = cells / s;
    Object.assign(c, { n, s, cellM: s * cell, quantumM: L.quantumM,
      x0: originM[0] + c.ix * cells * cell, z0: originM[1] + c.iz * cells * cell });
    c.cols = new Float64Array(n * n);
    c.means = new Float64Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const mean = cellMeanHeight(grid, c.ix * cells + u * s, c.iz * cells + v * s, s);
      c.means[v * n + u] = mean;
      c.cols[v * n + u] = Number.isFinite(mean) ? quantizeHeight(mean, L.quantumM) : NaN;
    }
  }
  /** Displayed column height over fine cell (gi, gj); undefined off-pack. */
  const colAt = (gi, gj) => {
    const c = byIndex.get(`${Math.floor(gi / cells)},${Math.floor(gj / cells)}`);
    if (!c) return undefined;
    return c.cols[Math.floor((gj - c.iz * cells) / c.s) * c.n + Math.floor((gi - c.ix * cells) / c.s)];
  };
  // Smooth lattice per chunk: decimated samples, snapped on edges shared
  // with a coarser neighbour (TerrainMesh's seam rule).
  const sampleRaw = (gx, gz) => (gx >= 0 && gz >= 0 && gx < W && gz < H && grid.valid[gz * W + gx] ? grid.heightsM[gz * W + gx] : NaN);
  /** The coarsest cell step among chunks touching lattice point (gx, gz):
   *  a vertex shared across a level border gets one normal and one colour,
   *  whichever chunk emits it. */
  const touchS = (gx, gz) => {
    const xs = gx % cells === 0 && gx > 0 ? [gx / cells - 1, gx / cells] : [Math.floor(gx / cells)];
    const zs = gz % cells === 0 && gz > 0 ? [gz / cells - 1, gz / cells] : [Math.floor(gz / cells)];
    let most = 1;
    for (const ix of xs) for (const iz of zs) { const nb = byIndex.get(`${ix},${iz}`); if (nb) most = Math.max(most, nb.s); }
    return most;
  };
  for (const c of plan.chunks) {
    const n = c.n, s = c.s, m = n + 1;
    const lat = new Float64Array(m * m);
    for (let v = 0; v < m; v++) for (let u = 0; u < m; u++) lat[v * m + u] = sampleRaw(c.ix * cells + u * s, c.iz * cells + v * s);
    const coarser = (dx, dz) => { const nb = byIndex.get(`${c.ix + dx},${c.iz + dz}`); return nb && nb.s > s ? nb.s / s : 0; };
    const snapEdge = (r, at) => {
      if (!r) return;
      for (let k = 0; k <= n; k++) {
        const k0 = Math.floor(k / r) * r;
        if (k0 === k) continue;
        const k1 = Math.min(n, k0 + r), f = (k - k0) / r;
        const a = lat[at(k0)], b = lat[at(k1)];
        if (Number.isFinite(lat[at(k)]) && Number.isFinite(a) && Number.isFinite(b)) lat[at(k)] = a + (b - a) * f;
      }
    };
    // The same edges also carry the control's normals and colours.
    c.snapEdges = [[coarser(0, -1), k => k], [coarser(0, 1), k => n * m + k], [coarser(-1, 0), k => k * m], [coarser(1, 0), k => k * m + n]];
    for (const [r, at] of c.snapEdges) snapEdge(r, at);
    c.lattice = lat;
  }

  // Bake: mean albedo + occlusion over a footprint, sRGB8 + AO8 texels.
  const sub = settings.bakeSamplesPerCell;
  const bakeArea = (out, o, gx, gz, half) => {
    let r = 0, g = 0, b = 0, ao = 0, k = 0;
    const footprintM = (2 * half * cell) / sub;
    for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
      const sx = gx - half + (i + 0.5) * (2 * half / sub), sz = gz - half + (j + 0.5) * (2 * half / sub);
      const y = demAt(grid, sx, sz);
      if (!Number.isFinite(y)) continue;
      const res = materialAlbedo(material, originM[0] + sx * cell, y, originM[1] + sz * cell, surfaceAt(surface, sx, sz), { eyeM, footprintM });
      r += res.albedo[0]; g += res.albedo[1]; b += res.albedo[2]; ao += res.ao; k++;
    }
    if (!k) { r = g = b = 0.2; ao = 1; k = 1; }
    out[o] = srgbByte(r / k); out[o + 1] = srgbByte(g / k); out[o + 2] = srgbByte(b / k); out[o + 3] = Math.round(Math.min(1, ao / k) * 255);
  };
  for (const c of plan.chunks) {
    const n = c.n, s = c.s, m = n + 1, gi0 = c.ix * cells, gj0 = c.iz * cells;
    // Columns: one texel per column (its top and every side it owns).
    c.columnTexels = new Uint8Array(n * n * 4);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) bakeArea(c.columnTexels, (v * n + u) * 4, gi0 + (u + 0.5) * s, gj0 + (v + 0.5) * s, s / 2);
    // Control: one texel per lattice vertex, filtered between them; at a
    // level border, baked at the coarser step and interpolated along a
    // snapped edge, so both chunks agree on every shared vertex.
    c.vertexTexels = new Uint8Array(m * m * 4);
    for (let v = 0; v < m; v++) for (let u = 0; u < m; u++) {
      bakeArea(c.vertexTexels, (v * m + u) * 4, gi0 + u * s, gj0 + v * s, touchS(gi0 + u * s, gj0 + v * s) / 2);
    }
    for (const [r, at] of c.snapEdges) if (r) for (let k = 0; k <= n; k++) {
      const k0 = Math.floor(k / r) * r;
      if (k0 === k) continue;
      const k1 = Math.min(n, k0 + r), f = (k - k0) / r;
      for (let ch = 0; ch < 4; ch++) {
        const a = c.vertexTexels[at(k0) * 4 + ch], b = c.vertexTexels[at(k1) * 4 + ch];
        c.vertexTexels[at(k) * 4 + ch] = Math.round(a + (b - a) * f);
      }
    }
  }

  const packs = {};
  for (const representation of ['columns', 'mesh']) {
    const columns = representation === 'columns';
    const atlas = packAtlas(plan.chunks.map(c => ({ size: columns ? c.n : c.n + 1 })), settings.atlasWidth);
    const atlasTexels = new Uint8Array(atlas.width * atlas.height * 4);
    plan.chunks.forEach((c, i) => {
      const t = atlas.tiles[i], src = columns ? c.columnTexels : c.vertexTexels;
      for (let v = 0; v < t.size; v++) atlasTexels.set(src.subarray(v * t.size * 4, (v + 1) * t.size * 4), ((t.y + v) * atlas.width + t.x) * 4);
    });
    const sections = [];
    let byteOffset = 0;
    const push = (typed) => {
      const at = byteOffset;
      const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
      sections.push(buf);
      byteOffset += buf.byteLength;
      const pad = (4 - (byteOffset % 4)) % 4;
      if (pad) { sections.push(Buffer.alloc(pad)); byteOffset += pad; }
      return { byteOffset: at, byteLength: typed.byteLength };
    };
    const atlasRecord = { width: atlas.width, height: atlas.height, format: 'srgb8-ao8', filter: columns ? 'nearest-column' : 'linear-vertex', texels: push(atlasTexels) };
    const chunkRecords = [];
    const stats = { chunks: 0, vertices: 0, triangles: 0, levels: {}, bands: {},
      bytes: { positions: 0, normals: 0, atlasCoords: 0, indices: 0, samples: 0, columns: 0, atlas: atlasTexels.byteLength } };
    const merge = { topCells: 0, topQuads: 0, sideSegments: 0, sideQuads: 0 };
    plan.chunks.forEach((c, ci) => {
      const n = c.n, s = c.s, m = n + 1, cm = c.cellM, tile = atlas.tiles[ci];
      const gi0 = c.ix * cells, gj0 = c.iz * cells;
      // Atlas coordinate of a world point: tile origin + chunk-local cells,
      // in quarter-texel fixed point, exact for side spans that start part
      // of a column in on a level border.
      const fixed = (v) => { const q = v * COMPILED_ATLAS_SCALE; if (Math.abs(q - Math.round(q)) > 1e-6) throw new Error(`${c.id}: atlas coordinate ${v} off the fixed-point grid`); return Math.round(q); };
      const geo = new ChunkGeometry((p) => [fixed(tile.x + (p[0] - c.x0) / cm), fixed(tile.y + (p[2] - c.z0) / cm)]);
      if (columns) {
        const keys = new Array(n * n);
        for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
          const h = c.cols[v * n + u];
          if (!Number.isFinite(h)) { keys[v * n + u] = null; continue; }
          merge.topCells++;
          const mergeable = dry(gi0 + u * s, gj0 + v * s) && dry(gi0 + (u + 1) * s, gj0 + (v + 1) * s)
            && dry(gi0 + (u + 1) * s, gj0 + v * s) && dry(gi0 + u * s, gj0 + (v + 1) * s);
          keys[v * n + u] = mergeable ? `${h}` : `${h}:${u},${v}`;
        }
        for (const r of greedyRectangles(n, Math.max(1, Math.round(settings.mergeBlockM / cm)), (u, v) => keys[v * n + u])) {
          const y = c.cols[r.v0 * n + r.u0];
          const x0 = c.x0 + r.u0 * cm, x1 = c.x0 + r.u1 * cm, z0 = c.z0 + r.v0 * cm, z1 = c.z0 + r.v1 * cm;
          geo.quad([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], [0, 1, 0]);
          geo.tops++;
        }
        // Exposed side spans, at fine resolution along every column edge:
        // against the neighbour's displayed column (any level, any chunk),
        // owned by the taller side; open or no-data neighbours close down
        // to the chunk floor. Equal neighbours expose nothing.
        let floor = Infinity;
        for (const h of c.cols) if (Number.isFinite(h)) floor = Math.min(floor, h);
        const floorM = floor - c.quantumM;
        const lines = new Map();
        for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
          const h = c.cols[v * n + u];
          if (!Number.isFinite(h)) continue;
          for (const dir of DIRS) for (let k = 0; k < s; k++) {
            let fi, fj, plane, along;
            if (dir.d[0]) {
              fi = dir.d[0] > 0 ? gi0 + (u + 1) * s : gi0 + u * s - 1; fj = gj0 + v * s + k;
              plane = dir.d[0] > 0 ? gi0 + (u + 1) * s : gi0 + u * s; along = fj;
            } else {
              fj = dir.d[1] > 0 ? gj0 + (v + 1) * s : gj0 + v * s - 1; fi = gi0 + u * s + k;
              plane = dir.d[1] > 0 ? gj0 + (v + 1) * s : gj0 + v * s; along = fi;
            }
            const nb = colAt(fi, fj);
            const bottom = nb === undefined || Number.isNaN(nb) ? floorM : nb;
            if (!(bottom < h)) continue;
            merge.sideSegments++;
            const edge = dir.d[0] ? [plane, along, plane, along + 1] : [along, plane, along + 1, plane];
            const mergeable = dry(edge[0], edge[1]) && dry(edge[2], edge[3]);
            const key = `${dir.name}|${plane}|${bottom}|${h}${mergeable ? '' : `|${along}`}`;
            let list = lines.get(key);
            if (!list) lines.set(key, list = []);
            list.push({ a0: along, a1: along + 1, key, dir, y0: bottom, y1: h, plane });
          }
        }
        const blockFine = Math.max(1, Math.round(settings.mergeBlockM / cell));
        for (const key of [...lines.keys()].sort()) {
          for (const run of mergeRuns(lines.get(key), blockFine)) {
            const { dir, y0, y1 } = run;
            const xAxis = dir.d[0] !== 0;
            const p = originM[xAxis ? 0 : 1] + run.plane * cell;
            const a0 = originM[xAxis ? 1 : 0] + run.a0 * cell, a1 = originM[xAxis ? 1 : 0] + run.a1 * cell;
            geo.quad(xAxis ? [[p, y0, a0], [p, y0, a1], [p, y1, a1], [p, y1, a0]] : [[a0, y0, p], [a1, y0, p], [a1, y1, p], [a0, y1, p]], dir.normal);
            geo.sides++;
          }
        }
        merge.topQuads += geo.tops; merge.sideQuads += geo.sides;
      } else {
        // Control: regular lattice, quads split along a-d as TerrainMesh.
        const lat = c.lattice, vid = new Int32Array(m * m).fill(-1);
        // Normals over the coarsest step touching each vertex, then
        // interpolated along snapped edges like the heights.
        const nrm = new Float64Array(m * m * 3);
        for (let v = 0; v < m; v++) for (let u = 0; u < m; u++) {
          const gx = gi0 + u * s, gz = gj0 + v * s, st = touchS(gx, gz), y0 = lat[v * m + u];
          const h = (x, z) => { const t = demAt(grid, x, z); return Number.isFinite(t) ? t : y0; };
          const dx = (h(Math.min(W - 1, gx + st), gz) - h(Math.max(0, gx - st), gz)) / ((Math.min(W - 1, gx + st) - Math.max(0, gx - st)) * cell);
          const dz = (h(gx, Math.min(H - 1, gz + st)) - h(gx, Math.max(0, gz - st))) / ((Math.min(H - 1, gz + st) - Math.max(0, gz - st)) * cell);
          nrm.set([-dx, 1, -dz], (v * m + u) * 3);
        }
        for (const [r, at] of c.snapEdges) if (r) for (let k = 0; k <= n; k++) {
          const k0 = Math.floor(k / r) * r;
          if (k0 === k) continue;
          const k1 = Math.min(n, k0 + r), f = (k - k0) / r;
          for (let a = 0; a < 3; a++) nrm[at(k) * 3 + a] = nrm[at(k0) * 3 + a] + (nrm[at(k1) * 3 + a] - nrm[at(k0) * 3 + a]) * f;
        }
        for (let v = 0; v < m; v++) for (let u = 0; u < m; u++) {
          const y = lat[v * m + u];
          if (!Number.isFinite(y)) continue;
          const o = (v * m + u) * 3, l = Math.hypot(nrm[o], nrm[o + 1], nrm[o + 2]);
          // One vertex per lattice point (no dedup key needed).
          vid[v * m + u] = geo.pos.length / 3;
          geo.pos.push(c.x0 + u * cm, y, c.z0 + v * cm);
          geo.nrm.push(Math.round(nrm[o] / l * 127), Math.round(nrm[o + 1] / l * 127), Math.round(nrm[o + 2] / l * 127), 0);
          geo.atl.push((tile.x + u) * COMPILED_ATLAS_SCALE, (tile.y + v) * COMPILED_ATLAS_SCALE);
        }
        for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
          const a = vid[v * m + u], b = vid[v * m + u + 1], cc = vid[(v + 1) * m + u], d = vid[(v + 1) * m + u + 1];
          if (a < 0 || b < 0 || cc < 0 || d < 0) continue;
          geo.idx.push(a, cc, d, a, d, b);
        }
      }
      const V = geo.pos.length / 3;
      // Base height and local positions (x/z whole metres, y decimetres).
      let yBase = Infinity, yMax = -Infinity;
      for (let i = 1; i < geo.pos.length; i += 3) { yBase = Math.min(yBase, geo.pos[i]); yMax = Math.max(yMax, geo.pos[i]); }
      for (let i = 0; i < m * m; i++) if (Number.isFinite(c.lattice[i])) { yBase = Math.min(yBase, c.lattice[i]); yMax = Math.max(yMax, c.lattice[i]); }
      yBase = Math.floor(yBase);
      if ((yMax - yBase) / COMPILED_Y_UNIT_M > 32767) throw new Error(`chunk ${c.id} spans more than Int16 decimetres`);
      const dm = (y) => Math.round((y - yBase) / COMPILED_Y_UNIT_M);
      const positions = new Int16Array(V * 3);
      const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let i = 0; i < V; i++) {
        const lx = geo.pos[i * 3] - c.x0, lz = geo.pos[i * 3 + 2] - c.z0;
        if (Math.abs(lx - Math.round(lx)) > 1e-6 || Math.abs(lz - Math.round(lz)) > 1e-6) throw new Error(`chunk ${c.id}: vertex off the metre lattice`);
        positions[i * 3] = Math.round(lx); positions[i * 3 + 1] = dm(geo.pos[i * 3 + 1]); positions[i * 3 + 2] = Math.round(lz);
        const wp = [c.x0 + positions[i * 3], yBase + positions[i * 3 + 1] * COMPILED_Y_UNIT_M, c.z0 + positions[i * 3 + 2]];
        for (let a = 0; a < 3; a++) { bounds.min[a] = Math.min(bounds.min[a], wp[a]); bounds.max[a] = Math.max(bounds.max[a], wp[a]); }
      }
      if (!V) { bounds.min = [c.x0, yBase, c.z0]; bounds.max = [c.x0 + cells * cell, yBase, c.z0 + cells * cell]; }
      const indexType = V > 65535 ? 'uint32' : 'uint16';
      const sec = {
        positions: push(positions), normals: push(Int8Array.from(geo.nrm)), atlas: push(Uint16Array.from(geo.atl)),
        indices: push(indexType === 'uint32' ? Uint32Array.from(geo.idx) : Uint16Array.from(geo.idx)),
        samples: push(Int16Array.from(c.lattice, y => (Number.isFinite(y) ? dm(y) : COMPILED_NO_DATA))),
      };
      if (columns) sec.columns = push(Int16Array.from(c.cols, y => (Number.isFinite(y) ? dm(y) : COMPILED_NO_DATA)));
      stats.bytes.positions += sec.positions.byteLength; stats.bytes.normals += sec.normals.byteLength;
      stats.bytes.atlasCoords += sec.atlas.byteLength; stats.bytes.indices += sec.indices.byteLength;
      stats.bytes.samples += sec.samples.byteLength; stats.bytes.columns += sec.columns?.byteLength || 0;
      const triangles = geo.idx.length / 3;
      chunkRecords.push({
        id: c.id, ix: c.ix, iz: c.iz, band: c.band, level: c.level, shipped: c.shipped, nearestEyeM: c.nearestEyeM,
        originM: [c.x0, c.z0], yBaseM: yBase, boundsM: bounds, atlas: tile,
        vertexCount: V, indexCount: geo.idx.length, indexType, triangles,
        faces: columns ? { top: geo.tops, side: geo.sides } : { cells: triangles / 2 },
        sections: sec,
      });
      stats.chunks++; stats.vertices += V; stats.triangles += triangles;
      stats.levels[c.level] = (stats.levels[c.level] || 0) + 1;
      stats.bands[c.band] = (stats.bands[c.band] || 0) + 1;
    });
    // Receiver mask: only the pinned (non-255) texels.
    const pinned = [];
    for (let i = 0; i < receiver.data.length; i++) if (receiver.data[i] !== 255) pinned.push(i);
    const receiverRecord = { count: pinned.length, indices: push(Uint32Array.from(pinned)),
      values: push(Uint8Array.from({ length: Math.ceil(pinned.length / 4) * 4 }, (_, k) => (k < pinned.length ? receiver.data[pinned[k]] : 0))) };
    const decoded = Buffer.concat(sections);
    const payload = zlib.gzipSync(decoded, { level: 9 });
    // gzip's header carries an mtime and OS byte; zero them for reproducible hashes.
    payload[4] = payload[5] = payload[6] = payload[7] = 0;
    payload[9] = 255;
    const covered = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const r of chunkRecords) for (let a = 0; a < 3; a++) { covered.min[a] = Math.min(covered.min[a], r.boundsM.min[a]); covered.max[a] = Math.max(covered.max[a], r.boundsM.max[a]); }
    stats.bytes.payload = payload.byteLength;
    stats.bytes.decoded = decoded.byteLength;
    // GPU-resident: vertex attributes, indices, atlas, full-grid receiver.
    stats.bytes.gpu = stats.bytes.positions + stats.bytes.normals + stats.bytes.atlasCoords + stats.bytes.indices + stats.bytes.atlas + W * H;
    if (columns) stats.merge = merge;
    const heightsBuf = Buffer.from(grid.heightsM.buffer, grid.heightsM.byteOffset, grid.heightsM.byteLength);
    const manifest = {
      schema: COMPILED_SCHEMA, version: COMPILED_VERSION, compilerVersion: COMPILER_VERSION,
      representation, viewId: view?.id ?? 'synthetic',
      source: {
        demSha256: options.identity?.demSha256 ?? grid.meta?.payload?.heights?.sha256 ?? sha256(heightsBuf),
        validSha256: options.identity?.validSha256 ?? grid.meta?.payload?.valid?.sha256
          ?? sha256(Buffer.from(grid.valid.buffer, grid.valid.byteOffset, grid.valid.byteLength)),
        compiledHeightsSha256: sha256(heightsBuf),
        grid: { width: W, height: H, cellSizeM: cell, originM: [...originM] },
        axes: 'X east, Y up, Z south (metres)',
        horizontalCrs: grid.horizontalCrs ?? 'synthetic', verticalReference: grid.verticalReference ?? 'synthetic',
        heightUnits: 'metre',
        provenance: options.identity?.provenance ?? grid.provenance ?? null,
        despikedSamples: options.identity?.despikedSamples ?? null,
        terrainPackage: options.identity?.terrainPackage ?? null,
      },
      material: {
        manifestUrl: options.identity?.material?.manifestUrl ?? null, sha256: options.identity?.material?.sha256 ?? null,
        palette: options.identity?.material?.palette ?? {}, rules: options.identity?.material?.rules ?? material.rules,
        textures: options.identity?.material?.textures ?? null,
        bake: 'TerrainMaterial SCENE_FRAG albedo and ambient occlusion at rest (no swell, storm or glacier), box-filtered over each texel footprint; forest colour and crown cover fixed at the rail\'s middle eye; mapped-only water (none drawn)',
      },
      coverage: {
        rule: options.coverage === 'all' ? 'every tile' : 'union of rail frusta (production extended framing, swell-lifted boxes), no occlusion culling, plus every shipped tile',
        cameras: ['default', ...(options.cameras || [])],
        chunks: chunkRecords.length, shippedChunks: chunkRecords.filter(c => c.shipped).length,
        boundsM: covered, complete: plan.chunks.every(c => c.cols.every(Number.isFinite)),
      },
      settings: {
        chunkCells: cells, levels: settings.levels.map(l => ({ ...l, cellM: l.cellSamples * cell })),
        level0WithinM: settings.level0WithinM, mergeBlockM: settings.mergeBlockM, bakeSamplesPerCell: settings.bakeSamplesPerCell,
        atlasWidth: settings.atlasWidth,
        quantization: 'column height = round(area mean of the bilinear DEM over the cell / quantum) * quantum (world-anchored at 0 m); |error| <= quantum / 2',
        seams: 'columns: sides at 20 m resolution against the neighbour\'s displayed column at any level, owned by the taller side; control: finer edges snapped to the coarser neighbour',
      },
      bands: plan.bands,
      deform: { heightRangeM, gapBoundM: gap, toleranceM: settings.gapToleranceM, cullPadM: LAND_MAX_DISPLACEMENT_M },
      atlas: atlasRecord,
      receiver: receiverRecord,
      payload: { url: `${view?.id ?? 'synthetic'}.${representation}.bin.gz`, byteLength: payload.byteLength, sha256: sha256(payload),
        decodedByteLength: decoded.byteLength, decodedSha256: sha256(decoded) },
      stats,
      chunks: chunkRecords,
    };
    packs[representation] = { manifest, payload, decoded };
  }
  return { packs, plan };
}

export { COMPILED_PILOT, BANDS };
