import { finishPreparation, prepareInSlices } from './PreparationSteps.js';
import { terrainHeightAt } from './TerrainMesh.js';
import { settingValue } from '../../config/appSettings.js';
// Ridge/drainage hierarchy of a terrain view, for land that dances to the
// music along its own geography instead of along a synthetic sine
// (docs/landscape-dance.md). Engine-agnostic: typed arrays in, typed
// arrays out; RangeScene uploads the packed field as one small texture.
//
// From one coarse lattice of the drawn heights:
//
//  - Drainage: Priority-Flood+epsilon depression filling (Barnes et al.
//    2014), D8 steepest descent on the filled surface, contributing area,
//    channel cells above a fixed area, Strahler order of that network,
//    height above the nearest drainage (HAND, Renno et al. 2008) and the
//    flow distance from each cell to its outlet.
//  - Ridges: D8 steepest *ascent* on the raw heights; "ridge area" is the
//    number of cells whose ascent path climbs through a cell, so spurs feed
//    side ridges feed the main spines that end on summits. Strahler order
//    over that network ranks the spines.
//
// Packed field, one RGBA8 texel per lattice sample (sample centres span the
// terrain grid's first to last sample centres, like uReceiver):
//   R  relief01   HAND / its 95th percentile, smoothstepped: 0 on every
//                 valley floor, lake and channel, 1 high above drainage.
//   G  spine01    ridge Strahler order / max order, dilated and blurred
//                 into a band along each ridge (0 off the ridge network).
//   B  cos(k d)   d = flow distance to outlet, k = 2 pi / wavelength,
//   A  sin(k d)   both blurred: a wave sin(k d + phase) runs downstream
//                 as phase grows, and fades out across divides where the
//                 two sides' distances disagree.

export const HIERARCHY_MAX_SAMPLES = Object.freeze({ desktop: 384, mobile: 256 });
/** Contributing area that starts a drainage channel (m^2). */
export const CHANNEL_AREA_M2 = 250000;
/** Ascent area that starts a ridge (m^2). */
export const RIDGE_AREA_M2 = 120000;
/** Wavelength of the downstream wave along the drainage (m). */
export const DRAIN_WAVELENGTH_M = 6000;
/** Least rise per metre a ridge ascent follows. */
const MIN_RIDGE_SLOPE = .03;
/** Ridges stand at least this share of the relief reference above drainage. */
const RIDGE_MIN_RELIEF = .12;

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

/** The land dance, 0..1: on by default. `?landDance=0` (or any 0..1 value)
 *  remains only as an opt-out for side-by-side checks. */
export function landDanceRequest(search) {
  return settingValue('landDance', search);
}

/** Min-heap of (key, index) on parallel typed arrays. */
class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, value) {
    let i = this.n++;
    const k = this.k, v = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = value;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0];
    const lastK = k[--this.n], lastV = v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && k[c + 1] < k[c]) c++;
      if (k[c] >= lastK) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = lastK; v[i] = lastV;
    return top;
  }
}

/** Coarse lattice of the drawn source heights over the view's grid. */
export function hierarchyLattice(data, { maxSamples = HIERARCHY_MAX_SAMPLES.desktop } = {}) {
  const g = data.grid;
  const spanX = (g.width - 1) * g.cellSizeM, spanZ = (g.height - 1) * g.cellSizeM;
  const cellM = Math.max(g.cellSizeM, Math.max(spanX, spanZ) / Math.max(1, maxSamples - 1));
  const W = Math.max(2, Math.round(spanX / cellM) + 1), H = Math.max(2, Math.round(spanZ / cellM) + 1);
  const heights = new Float32Array(W * H);
  for (let z = 0; z < H; z++) {
    const zm = g.originM[1] + spanZ * z / (H - 1);
    for (let x = 0; x < W; x++) heights[z * W + x] = terrainHeightAt(data, g.originM[0] + spanX * x / (W - 1), zm);
  }
  return { width: W, height: H, cellXM: spanX / (W - 1), cellZM: spanZ / (H - 1), heights };
}

/**
 * Hierarchy fields from a lattice { width, height, cellXM, cellZM, heights }
 * (NaN = no data). Returns per-cell fields and the packed RGBA8 texture.
 */
export function buildTerrainHierarchy(lattice, options = {}) {
  return finishPreparation(hierarchySteps(lattice, options));
}

export function buildTerrainHierarchyAsync(lattice, options = {}) {
  return prepareInSlices(hierarchySteps(lattice, options), options);
}

function* hierarchySteps(lattice, { channelAreaM2 = CHANNEL_AREA_M2, ridgeAreaM2 = RIDGE_AREA_M2,
  wavelengthM = DRAIN_WAVELENGTH_M } = {}) {
  const { width: W, height: H, heights } = lattice;
  const cx = lattice.cellXM, cz = lattice.cellZM;
  const N = W * H, cellArea = cx * cz;
  const valid = new Uint8Array(N);
  for (let i = 0; i < N; i++) valid[i] = Number.isFinite(heights[i]) ? 1 : 0;
  const stepM = d => Math.hypot(DX[d] * cx, DZ[d] * cz);

  // Priority-Flood+epsilon from every edge and no-data boundary.
  const filled = new Float64Array(N), order = new Int32Array(N);
  const seen = new Uint8Array(N), heap = new Heap(N);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x;
    if (!valid[i]) continue;
    let edge = x === 0 || z === 0 || x === W - 1 || z === H - 1;
    for (let d = 0; d < 8 && !edge; d++) if (!valid[i + DZ[d] * W + DX[d]]) edge = true;
    if (edge) { seen[i] = 1; filled[i] = heights[i]; heap.push(filled[i], i); }
  }
  let count = 0;
  while (heap.n) {
    const c = heap.pop();
    order[count++] = c;
    const x = c % W, z = (c - x) / W;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (seen[n] || !valid[n]) continue;
      seen[n] = 1;
      const f = filled[c];
      // A relative epsilon keeps strict descent at any elevation.
      filled[n] = Math.max(heights[n], f + Math.max(1e-4, Math.abs(f) * 1e-9));
      heap.push(filled[n], n);
    }
    if ((count & 8191) === 0) yield;
  }

  // D8 steepest descent on the filled surface. Every non-seed cell has the
  // neighbour that flooded it strictly lower, so each one drains.
  const down = new Int32Array(N).fill(-1), downD = new Int8Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    const x = i % W, z = (i - x) / W;
    let best = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (!valid[n]) continue;
      const s = (filled[i] - filled[n]) / stepM(d);
      if (s > best) { best = s; down[i] = n; downD[i] = d; }
    }
    if ((i & 16383) === 16383) yield;
  }

  // Area, Strahler order: donors (later in flood order) before receivers.
  const area = new Float64Array(N), drainOrder = new Uint8Array(N);
  const inMax = new Uint8Array(N), inCount = new Uint8Array(N);
  const channelCells = Math.max(1, channelAreaM2 / cellArea);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k];
    area[i] += 1;
    if (area[i] >= channelCells) {
      drainOrder[i] = inMax[i] ? inMax[i] + (inCount[i] >= 2 ? 1 : 0) : 1;
    }
    const r = down[i];
    if (r >= 0) {
      area[r] += area[i];
      const o = drainOrder[i];
      if (o) { if (o > inMax[r]) { inMax[r] = o; inCount[r] = 1; } else if (o === inMax[r]) inCount[r]++; }
    }
  }
  yield;

  // HAND and flow distance: receivers (earlier in flood order) first.
  const hand = new Float32Array(N), distM = new Float32Array(N), drainH = new Float64Array(N);
  for (let k = 0; k < count; k++) {
    const i = order[k], r = down[i];
    drainH[i] = drainOrder[i] || r < 0 ? heights[i] : drainH[r];
    hand[i] = Math.max(0, heights[i] - drainH[i]);
    distM[i] = r < 0 ? 0 : distM[r] + stepM(downD[i]);
  }
  yield;

  // Ridges: steepest ascent on raw heights, accumulated from low to high.
  // Ascent needs real slope: on a valley floor DEM noise alone would draw
  // long parallel "ridges" across the flats.
  const up = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    const x = i % W, z = (i - x) / W;
    let best = MIN_RIDGE_SLOPE;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (!valid[n]) continue;
      const s = (heights[n] - heights[i]) / stepM(d);
      if (s > best) { best = s; up[i] = n; }
    }
    if ((i & 16383) === 16383) yield;
  }
  const byHeight = Array.from({ length: count }, (_, k) => order[k]).sort((a, b) => heights[a] - heights[b] || a - b);
  yield;
  const ridgeArea = new Float64Array(N), ridgeOrder = new Uint8Array(N);
  inMax.fill(0); inCount.fill(0);
  const ridgeCells = Math.max(1, ridgeAreaM2 / cellArea);
  for (const i of byHeight) {
    ridgeArea[i] += 1;
    if (ridgeArea[i] >= ridgeCells) ridgeOrder[i] = inMax[i] ? inMax[i] + (inCount[i] >= 2 ? 1 : 0) : 1;
    const r = up[i];
    if (r >= 0) {
      ridgeArea[r] += ridgeArea[i];
      const o = ridgeOrder[i];
      if (o) { if (o > inMax[r]) { inMax[r] = o; inCount[r] = 1; } else if (o === inMax[r]) inCount[r]++; }
    }
  }
  yield;

  // Relief: HAND over its 95th percentile on dry ground.
  const dryHand = [];
  for (let i = 0; i < N; i += 1) if (valid[i] && hand[i] > 0) dryHand.push(hand[i]);
  dryHand.sort((a, b) => a - b);
  const handRefM = Math.max(1, dryHand.length ? dryHand[Math.floor(.95 * (dryHand.length - 1))] : 1);
  let maxDrain = 0, maxRidge = 0;
  for (let i = 0; i < N; i++) { if (drainOrder[i] > maxDrain) maxDrain = drainOrder[i]; if (ridgeOrder[i] > maxRidge) maxRidge = ridgeOrder[i]; }

  const relief = new Float32Array(N), spine = new Float32Array(N), cosD = new Float32Array(N), sinD = new Float32Array(N);
  const k = 2 * Math.PI / wavelengthM;
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    const t = Math.min(1, hand[i] / handRefM);
    relief[i] = t * t * (3 - 2 * t);
    spine[i] = ridgeOrder[i] && maxRidge && hand[i] >= RIDGE_MIN_RELIEF * handRefM ? ridgeOrder[i] / maxRidge : 0;
    cosD[i] = Math.cos(k * distM[i]); sinD[i] = Math.sin(k * distM[i]);
  }
  yield;
  // A ridge is a one-cell line: dilate (max) by 2 cells, then blur, so the
  // spine is a band the mesh can resolve. Phase fields blur so divides and
  // confluences, where distances jump, fade instead of tearing.
  // The D8 network only knows eight directions, so on its own the band
  // would step at 45 degrees. Its order is kept coarse (dilated, blurred)
  // and its shape comes from where the land is actually convex: the
  // Laplacian of lightly smoothed heights follows each crest at sub-cell
  // precision in any direction.
  const convex = convexity(heights, W, H, cx, cz, valid);
  const orderBand = blur(dilate(spine, W, H, 3), W, H, 1.5, valid);
  const spineBand = new Float32Array(N);
  for (let i = 0; i < N; i++) spineBand[i] = orderBand[i] * convex[i];
  const cosB = blur(cosD, W, H, 1.5, valid), sinB = blur(sinD, W, H, 1.5, valid);
  const reliefB = blur(relief, W, H, .8, valid);
  yield;

  const texture = new Uint8Array(N * 4);
  const byte = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  const signed = v => Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5)));
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    texture[o] = valid[i] ? byte(reliefB[i]) : 0;
    texture[o + 1] = valid[i] ? byte(spineBand[i]) : 0;
    texture[o + 2] = signed(valid[i] ? cosB[i] : 0);
    texture[o + 3] = signed(valid[i] ? sinB[i] : 0);
  }
  const stats = { width: W, height: H, cellXM: cx, cellZM: cz, handRefM, maxDrainOrder: maxDrain, maxRidgeOrder: maxRidge,
    wavelengthM, channelCells: drainOrder.reduce((n, o) => n + (o ? 1 : 0), 0), ridgeCells: ridgeOrder.reduce((n, o) => n + (o ? 1 : 0), 0),
    ...fieldCurvature(texture, W, H, cx, cz) };
  return { width: W, height: H, texture, stats,
    fields: { heights, filled, down, area, drainOrder, hand, distM, up, ridgeArea, ridgeOrder, relief: reliefB, spine: spineBand, convex, cos: cosB, sin: sinB } };
}

/** 0..1 crest convexity: minus the Laplacian of heights smoothed over about
 *  one cell, over its 90th percentile on convex ground, smoothstepped. */
function convexity(heights, W, H, cx, cz, valid) {
  const hs = blur(heights.map(v => Number.isFinite(v) ? v : 0), W, H, 1, valid);
  const neg = new Float32Array(W * H), pos = [];
  for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
    const i = z * W + x;
    // Next to no-data the smoothed heights are one-sided: no crest there.
    if (!valid[i] || !valid[i - 1] || !valid[i + 1] || !valid[i - W] || !valid[i + W]) continue;
    const lap = (hs[i - 1] + hs[i + 1] - 2 * hs[i]) / (cx * cx) + (hs[i - W] + hs[i + W] - 2 * hs[i]) / (cz * cz);
    neg[i] = Math.max(0, -lap);
    if (neg[i] > 0) pos.push(neg[i]);
  }
  pos.sort((a, b) => a - b);
  const ref = pos.length ? pos[Math.floor(.9 * (pos.length - 1))] : 1;
  for (let i = 0; i < neg.length; i++) { const t = Math.min(1, neg[i] / (ref || 1)); neg[i] = t * t * (3 - 2 * t); }
  return neg;
}

/** Network polylines (lattice x, z) from a receiver tree: each chain of
 *  cells with order >= minOrder, from its head down to where it joins a
 *  higher-order link, then Chaikin-smoothed so the drawn line follows the
 *  terrain instead of the lattice's eight directions. */
export function networkPolylines({ width: W }, next, order, { minOrder = 2, iterations = 3 } = {}) {
  const N = order.length, inflow = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (order[i] >= minOrder && next[i] >= 0 && order[next[i]] >= minOrder) inflow[next[i]]++;
  const lines = [];
  for (let i = 0; i < N; i++) {
    if (order[i] < minOrder || inflow[i]) continue;
    // A head: walk down, splitting where the order changes.
    let j = i, line = [];
    const level = () => order[j];
    let current = level();
    while (j >= 0 && order[j] >= minOrder) {
      line.push([j % W, Math.floor(j / W)]);
      const n = next[j];
      if (n < 0 || order[n] < minOrder) break;
      if (order[n] !== current || inflow[n] > 1) {
        line.push([n % W, Math.floor(n / W)]);
        lines.push({ order: current, points: chaikin(line, iterations) });
        line = [];
        if (inflow[n] > 1 && --inflow[n] > 0) { j = -1; break; }
        current = order[n];
      }
      j = n;
    }
    if (line.length > 1) lines.push({ order: current, points: chaikin(line, iterations) });
  }
  return lines;
}

function chaikin(points, iterations) {
  let p = points;
  for (let k = 0; k < iterations && p.length > 2; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      out.push([.75 * ax + .25 * bx, .75 * az + .25 * bz], [.25 * ax + .75 * bx, .25 * az + .75 * bz]);
    }
    out.push(p.at(-1));
    p = out;
  }
  return p;
}

function dilate(src, W, H, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    let m = 0;
    for (let o = -r; o <= r; o++) { const xx = x + o; if (xx >= 0 && xx < W) m = Math.max(m, src[z * W + xx]); }
    tmp[z * W + x] = m;
  }
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    let m = 0;
    for (let o = -r; o <= r; o++) { const zz = z + o; if (zz >= 0 && zz < H) m = Math.max(m, tmp[zz * W + x]); }
    out[z * W + x] = m;
  }
  return out;
}

/** Separable Gaussian over valid cells (normalized by their weight). */
function blur(src, W, H, sigma, valid) {
  const r = Math.ceil(sigma * 3), w = [];
  for (let o = -r; o <= r; o++) w.push(Math.exp(-o * o / (2 * sigma * sigma)));
  const pass = (input, horizontal) => {
    const out = new Float32Array(input.length);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      let s = 0, ws = 0;
      for (let o = -r; o <= r; o++) {
        const xx = horizontal ? x + o : x, zz = horizontal ? z : z + o;
        if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
        const j = zz * W + xx;
        if (!valid[j]) continue;
        s += input[j] * w[o + r]; ws += w[o + r];
      }
      out[z * W + x] = ws ? s / ws : 0;
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/** Largest second difference of each packed channel, per m^2, decoded to
 *  the shader's units ([0, 1] for R/G, [-1, 1] for B/A): the curvature a
 *  triangle spanning the field can miss (LandMotionLimits). */
function fieldCurvature(tex, W, H, cx, cz) {
  const scale = [1 / 255, 1 / 255, 1 / 127.5, 1 / 127.5];
  const out = [0, 0, 0, 0];
  for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
    const i = (z * W + x) * 4;
    for (let c = 0; c < 4; c++) {
      const v = tex[i + c];
      const ddx = Math.abs(tex[i + 4 + c] - 2 * v + tex[i - 4 + c]) * scale[c] / (cx * cx);
      const ddz = Math.abs(tex[i + W * 4 + c] - 2 * v + tex[i - W * 4 + c]) * scale[c] / (cz * cz);
      out[c] = Math.max(out[c], ddx, ddz);
    }
  }
  return { curvaturePerM2: out };
}

/** Bilinear read of the packed field at local (x, z), as the GL texture
 *  reads it (sample centres at the grid's first and last sample). */
export function sampleHierarchy(h, grid, x, z) {
  const W = h.width, H = h.height;
  const spanX = (grid.width - 1) * grid.cellSizeM, spanZ = (grid.height - 1) * grid.cellSizeM;
  const fx = Math.min(W - 1, Math.max(0, (x - grid.originM[0]) / spanX * (W - 1)));
  const fz = Math.min(H - 1, Math.max(0, (z - grid.originM[1]) / spanZ * (H - 1)));
  const x0 = Math.min(W - 2, Math.floor(fx)), z0 = Math.min(H - 2, Math.floor(fz)), tx = fx - x0, tz = fz - z0;
  const t = h.texture, at = (u, v, c) => t[(v * W + u) * 4 + c];
  const lerp = c => at(x0, z0, c) * (1 - tx) * (1 - tz) + at(x0 + 1, z0, c) * tx * (1 - tz)
    + at(x0, z0 + 1, c) * (1 - tx) * tz + at(x0 + 1, z0 + 1, c) * tx * tz;
  return { relief: lerp(0) / 255, spine: lerp(1) / 255, cos: (lerp(2) - 127.5) / 127.5, sin: (lerp(3) - 127.5) / 127.5 };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Dance displacement (m) at one hierarchy sample, before receiver and tour
 *  fade: CPU twin of TerrainDeform.js danceField. */
export function danceDisplacement(music, s) {
  if (!music || !s || (!music.spineM && !music.drainM)) return 0;
  const gate = music.spineGate01 ?? 1;
  const spine = smooth(gate - .2, gate, s.spine);
  const wave = s.sin * Math.cos(music.drainPhaseRad || 0) + s.cos * Math.sin(music.drainPhaseRad || 0);
  return s.relief * ((music.spineM || 0) * spine * (.35 + .65 * s.relief) + (music.drainM || 0) * wave);
}

/** Upload the packed field (CPU copy dropped after upload, like uSurface). */
export function createHierarchyTexture(THREE, h) {
  const tex = new THREE.DataTexture(h.texture, h.width, h.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { texture: tex, bytes: h.texture.byteLength };
}
