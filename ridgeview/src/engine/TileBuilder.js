// Builds one render tile of the globe from streamed elevation: heights,
// mesh (camera-relative ECEF), skirts, a per-texel normal/water/convexity
// texture and CPU-side heights for picking. Pure JS: no GPU, no DOM, so it
// is unit-tested in Node and could move to a worker.
//
// Render tile (z, x, y) draws DEM level d = min(z - 1, 15): at native levels
// it covers a quarter of one DEM tile (128 px), so S = 128 samples per side
// match the data 1:1. Past level 16 the DEM is interpolated (Catmull-Rom)
// and procedural micro-relief fills in what the data cannot hold.
import { EARTH_RADIUS, DEG, mxToLon, myToLat } from '../core/geo.js';
import { detailHeight, roughnessFromSlope } from '../core/detail.js';
import { bilinearInTile, DEM_MAX_LEVEL } from './DemSource.js';

export const RENDER_MIN_Z = 2;
const CIRC = 2 * Math.PI * EARTH_RADIUS;
export const demLevelFor = (z) => Math.min(z - 1, DEM_MAX_LEVEL);

/** The 3x3 DEM tiles around a centre tile at one level, each resolved to
 *  the best loaded data (itself or an ancestor). */
export class HeightWindow {
  constructor(dem, level, ctx, cty) {
    this.level = level; this.n = 1 << level; this.N = 256 << level;
    this.ctx = ctx; this.cty = cty;
    this.src = new Array(9);
    this.exact = true;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const r = dem.resolve(level, ctx + i, cty + j);
        this.src[(j + 1) * 3 + (i + 1)] = r;
        if (!r || r.level < level) this.exact = false;
      }
    }
  }

  /** Height at integer global pixel index (X, Y) of this level. */
  pixel(X, Y) {
    const N = this.N;
    if (Y < 0) Y = 0; else if (Y >= N) Y = N - 1;
    const tx = X >> 8, ty = Y >> 8;
    let i = tx - this.ctx;
    const j = ty - this.cty;
    if (i < -1) i += this.n; else if (i > 1) i -= this.n;
    const s = this.src[(j + 1) * 3 + (i + 1)];
    if (!s) return 0;
    if (s.scale === 1) return s.heights[((Y & 255) << 8) | (X & 255)];
    const Xw = ((X % N) + N) % N;
    return bilinearInTile(s.heights, (Xw + 0.5) / s.scale - 0.5 - s.ox, (Y + 0.5) / s.scale - 0.5 - s.oy);
  }

  /** Copy pixels [X0, X0 + w) x [Y0, Y0 + h) into a flat array. */
  extract(X0, Y0, w, h) {
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = this.pixel(X0 + i, Y0 + j);
    return out;
  }

  /** Catmull-Rom interpolation at a fractional pixel index. */
  cubic(fx, fy) {
    const x1 = Math.floor(fx), y1 = Math.floor(fy), tx = fx - x1, ty = fy - y1;
    const wx = crWeights(tx), wy = crWeights(ty);
    let h = 0;
    for (let j = 0; j < 4; j++) {
      const Y = y1 - 1 + j;
      const r = wx[0] * this.pixel(x1 - 1, Y) + wx[1] * this.pixel(x1, Y) + wx[2] * this.pixel(x1 + 1, Y) + wx[3] * this.pixel(x1 + 2, Y);
      h += wy[j] * r;
    }
    return h;
  }
}

function crWeights(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) * 0.5, (3 * t3 - 5 * t2 + 2) * 0.5, (-3 * t3 + 4 * t2 + t) * 0.5, (t3 - t2) * 0.5];
}

const indexCache = new Map();
/** Shared triangle indices for an M x M grid plus four skirts. */
export function gridIndex(M) {
  if (indexCache.has(M)) return indexCache.get(M);
  const V = M + 1, idx = [];
  for (let b = 0; b < M; b++) {
    for (let a = 0; a < M; a++) {
      const i0 = b * V + a, i1 = i0 + 1, i2 = i0 + V, i3 = i2 + 1;
      // Alternate the diagonal so slopes don't streak one way.
      if ((a + b) & 1) idx.push(i0, i2, i1, i1, i2, i3);
      else idx.push(i0, i2, i3, i0, i3, i1);
    }
  }
  // Skirts: edge loop (clockwise in uv) and a lowered copy after the grid.
  const edge = skirtLoop(M);
  const base = V * V;
  for (let k = 0; k < edge.length; k++) {
    const a = edge[k], b = edge[(k + 1) % edge.length], sa = base + k, sb = base + ((k + 1) % edge.length);
    idx.push(a, sa, b, b, sa, sb);
  }
  const arr = new Uint16Array(idx);
  indexCache.set(M, arr);
  return arr;
}

/** Edge vertex indices walking around the grid. */
export function skirtLoop(M) {
  const V = M + 1, loop = [];
  for (let a = 0; a < M; a++) loop.push(a); // top, left->right
  for (let b = 0; b < M; b++) loop.push(b * V + M); // right, top->bottom
  for (let a = M; a > 0; a--) loop.push(M * V + a); // bottom, right->left
  for (let b = M; b > 0; b--) loop.push(b * V); // left, bottom->top
  return loop;
}

// float32 -> IEEE half (round to nearest), for RGBA16F texture uploads.
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function toHalf(v) {
  f32[0] = v;
  const x = u32[0], sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const s = 14 - e;
    return sign | ((m + (1 << (s - 1))) >> s);
  }
  if (e >= 31) return sign | 0x7c00;
  const h = sign | (e << 10) | ((m + 0x1000) >> 13);
  return h;
}

/** The DEM pixel window a render tile needs (cubic support + apron). */
export function tileWindow(z, x, y, S) {
  const d = demLevelFor(z), shift = z - d, W = 256 / 2 ** shift;
  const X0 = Math.floor(x * W - W / S - 0.5) - 2, Y0 = Math.floor(y * W - W / S - 0.5) - 2;
  const X1 = Math.ceil((x + 1) * W + W / S - 0.5) + 3, Y1 = Math.ceil((y + 1) * W + W / S - 0.5) + 3;
  return { d, shift, W, X0, Y0, w: X1 - X0 + 1, h: Y1 - Y0 + 1 };
}

/** Extract what a tile build needs from the DEM cache (main thread, cheap). */
export function prepareTile(dem, z, x, y, { S = 128 } = {}) {
  const win = tileWindow(z, x, y, S);
  const hw = new HeightWindow(dem, win.d, x >> win.shift, y >> win.shift);
  if (!hw.src[4]) return null;
  // Coarse land/sea context (level <= 5) for telling sea from inland basins.
  let coarseNeg = false;
  if (dem.resolve) {
    const c = dem.resolve(Math.min(5, z), x >> Math.max(0, z - 5), y >> Math.max(0, z - 5));
    if (c) {
      let mn = Infinity;
      for (let i = 0; i < c.heights.length; i += 97) mn = Math.min(mn, c.heights[i]);
      coarseNeg = mn < 0;
    }
  }
  return { z, x, y, S, win, data: hw.extract(win.X0, win.Y0, win.w, win.h), exact: hw.exact, coarseNeg };
}

/** Build a render tile in one go (tests, or when no worker is available). */
export function buildTile(dem, z, x, y, opts = {}) {
  const prep = prepareTile(dem, z, x, y, opts);
  return prep ? buildPrepared(prep, opts) : null;
}

/**
 * Build a render tile from a prepared window (worker-safe: plain data in,
 * typed arrays out).
 *   options  { M = 64, detail = true }
 */
export function buildPrepared(prep, { M = 64, detail = true } = {}) {
  const { z, x, y, S, win: wn, data: px } = prep;
  const W = wn.W;
  const pix = (X, Y) => {
    let i = X - wn.X0, j = Y - wn.Y0;
    if (i < 0) i = 0; else if (i >= wn.w) i = wn.w - 1;
    if (j < 0) j = 0; else if (j >= wn.h) j = wn.h - 1;
    return px[j * wn.w + i];
  };
  const cubic = (fx, fy) => {
    const x1 = Math.floor(fx), y1 = Math.floor(fy);
    const wx = crWeights(fx - x1), wy = crWeights(fy - y1);
    let h = 0;
    for (let j = 0; j < 4; j++) {
      const Y = y1 - 1 + j;
      h += wy[j] * (wx[0] * pix(x1 - 1, Y) + wx[1] * pix(x1, Y) + wx[2] * pix(x1 + 1, Y) + wx[3] * pix(x1 + 2, Y));
    }
    return h;
  };
  const n = 2 ** z, P = S + 3;
  const base = new Float32Array(P * P);
  const latRow = new Float64Array(P), lonCol = new Float64Array(P);
  for (let j = 0; j < P; j++) latRow[j] = myToLat((y + (j - 1) / S) / n);
  for (let i = 0; i < P; i++) lonCol[i] = mxToLon((x + (i - 1) / S) / n);
  for (let j = 0; j < P; j++) {
    const fy = (y + (j - 1) / S) * W - 0.5;
    for (let i = 0; i < P; i++) base[j * P + i] = cubic((x + (i - 1) / S) * W - 0.5, fy);
  }
  // Water: hydro-flattened lakes are exactly flat; the sea is bathymetry.
  const water = new Uint8Array(P * P);
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      const k = j * P + i, h0 = base[k];
      if (h0 < -150 || (h0 < 0.5 && prep.coarseNeg)) { water[k] = 2; continue; }
      let flat = true;
      for (let dj = -2; dj <= 2 && flat; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= P) continue;
        for (let di = -2; di <= 2; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= P) continue;
          if (Math.abs(base[jj * P + ii] - h0) > 0.05) { flat = false; break; }
        }
      }
      if (flat) water[k] = 1;
    }
  }
  const texM = CIRC / (n * S); // sample spacing, mercator metres
  const F = new Float32Array(P * P);
  const useDetail = detail && texM < 2.5 * 32 * 0.999;
  for (let j = 0; j < P; j++) {
    const g = texM * Math.cos(latRow[j] * DEG);
    const my = ((y + (j - 1) / S) / n) * CIRC;
    for (let i = 0; i < P; i++) {
      const k = j * P + i;
      let h = water[k] === 2 ? 0 : base[k];
      if (useDetail && !water[k]) {
        const ip = Math.min(P - 1, i + 1), im = Math.max(0, i - 1), jp = Math.min(P - 1, j + 1), jm = Math.max(0, j - 1);
        const sx = (base[j * P + ip] - base[j * P + im]) / ((ip - im) * g);
        const sy = (base[jp * P + i] - base[jm * P + i]) / ((jp - jm) * g);
        const rough = roughnessFromSlope(Math.hypot(sx, sy));
        h += detailHeight(((x + (i - 1) / S) / n) * CIRC, my, rough, texM);
      }
      F[k] = h;
    }
  }
  // Texture: east slope, north slope, water (0 land, .5 lake, 1 sea), convexity.
  const tex = new Uint16Array(P * P * 4);
  for (let j = 0; j < P; j++) {
    const g = texM * Math.cos(latRow[j] * DEG);
    const jp = Math.min(P - 1, j + 1), jm = Math.max(0, j - 1);
    for (let i = 0; i < P; i++) {
      const k = j * P + i, ip = Math.min(P - 1, i + 1), im = Math.max(0, i - 1);
      const sE = (F[j * P + ip] - F[j * P + im]) / ((ip - im) * g);
      const sN = (F[jm * P + i] - F[jp * P + i]) / ((jp - jm) * g);
      const avg = (F[j * P + ip] + F[j * P + im] + F[jp * P + i] + F[jm * P + i]) * 0.25;
      const cvx = ((F[k] - avg) / g) * 4;
      tex[k * 4] = toHalf(sE); tex[k * 4 + 1] = toHalf(sN);
      tex[k * 4 + 2] = toHalf(water[k] === 2 ? 1 : water[k] ? 0.5 : 0);
      tex[k * 4 + 3] = toHalf(Math.max(-60000, Math.min(60000, cvx)));
    }
  }
  // CPU heights (no apron) for picking and queries.
  const hf = new Float32Array((S + 1) * (S + 1));
  const wm = new Uint8Array((S + 1) * (S + 1));
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j <= S; j++) {
    for (let i = 0; i <= S; i++) {
      const h = F[(j + 1) * P + (i + 1)];
      hf[j * (S + 1) + i] = h;
      wm[j * (S + 1) + i] = water[(j + 1) * P + (i + 1)];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  // Mesh.
  const V = M + 1, step = S / M;
  const midLat = myToLat((y + 0.5) / n), midLon = mxToLon((x + 0.5) / n);
  const center = ecef(midLon, midLat, (minH + maxH) / 2);
  const skirt = Math.max(20, Math.min(4000, (CIRC / n) * Math.cos(midLat * DEG) * 0.02 + (maxH - minH) * 0.05));
  const loop = skirtLoop(M);
  const nv = V * V + loop.length;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), hv = new Float32Array(nv);
  let radius = 0;
  const put = (vi, lon, lat, h, u, v) => {
    const p = ecef(lon, lat, h);
    const px = p[0] - center[0], py = p[1] - center[1], pz = p[2] - center[2];
    pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz;
    uv[vi * 2] = u; uv[vi * 2 + 1] = v; hv[vi] = h;
    const r = Math.hypot(px, py, pz);
    if (r > radius) radius = r;
  };
  for (let b = 0; b <= M; b++) {
    const j = b * step;
    for (let a = 0; a <= M; a++) {
      const i = a * step;
      put(b * V + a, lonCol[i + 1], latRow[j + 1], hf[j * (S + 1) + i], a / M, b / M);
    }
  }
  for (let k = 0; k < loop.length; k++) {
    const vi = loop[k], a = vi % V, b = (vi / V) | 0;
    put(V * V + k, lonCol[a * step + 1], latRow[b * step + 1], hf[b * step * (S + 1) + a * step] - skirt, a / M, b / M);
  }
  return {
    z, x, y, S, M, center, radius, minH, maxH, exact: prep.exact, demLevel: wn.d,
    positions: pos, uvs: uv, heights: hv, index: gridIndex(M),
    tex, texSize: P, heightfield: hf, water: wm,
    peaks: z >= 9 && z <= 15 ? findPeaks(hf, S, (i, j) => [mxToLon((x + i / S) / n), myToLat((y + j / S) / n)]) : [],
  };
}

function ecef(lon, lat, h) {
  const r = EARTH_RADIUS + h, cl = Math.cos(lat * DEG);
  return [r * cl * Math.cos(lon * DEG), r * cl * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
}

/** Local maxima that dominate a radius of ~12 samples; best three. */
function findPeaks(hf, S, toLonLat) {
  const R = 12, out = [];
  for (let j = 2; j <= S - 2; j += 2) {
    for (let i = 2; i <= S - 2; i += 2) {
      const h = hf[j * (S + 1) + i];
      if (h < 200) continue;
      let top = true;
      for (let dj = -R; dj <= R && top; dj += 2) {
        const jj = j + dj;
        if (jj < 0 || jj > S) continue;
        for (let di = -R; di <= R; di += 2) {
          const ii = i + di;
          if (ii < 0 || ii > S || (!di && !dj)) continue;
          if (hf[jj * (S + 1) + ii] > h) { top = false; break; }
        }
      }
      if (top) { const [lon, lat] = toLonLat(i, j); out.push({ lon, lat, h, u: i / S, v: j / S }); }
    }
  }
  return out.sort((a, b) => b.h - a.h).slice(0, 3);
}

/** Water class at tile fraction (u, v): 0 land, 1 lake, 2 sea. */
export function tileWaterAt(tile, u, v) {
  const S = tile.S, i = Math.min(S, Math.max(0, Math.round(u * S))), j = Math.min(S, Math.max(0, Math.round(v * S)));
  return tile.water[j * (S + 1) + i];
}

/** Bilinear height from a built tile at tile fraction (u, v). */
export function tileHeightAt(tile, u, v) {
  const S = tile.S, fx = Math.min(S - 1e-6, Math.max(0, u * S)), fy = Math.min(S - 1e-6, Math.max(0, v * S));
  const i = fx | 0, j = fy | 0, ax = fx - i, ay = fy - j, w = S + 1, h = tile.heightfield;
  const a = h[j * w + i] + (h[j * w + i + 1] - h[j * w + i]) * ax;
  const b = h[(j + 1) * w + i] + (h[(j + 1) * w + i + 1] - h[(j + 1) * w + i]) * ax;
  return a + (b - a) * ay;
}
