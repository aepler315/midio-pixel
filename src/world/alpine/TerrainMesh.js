// Range v2: build drawable terrain from a validated heightfield package
// (TerrainPackage.js). Engine-agnostic: produces typed arrays (positions,
// indices, a surface texture) that RangeScene uploads, and a height sampler
// that forest roots and the review tools share.
//
//   decodeTerrain(manifest, bytes)   -> TerrainData (dequantized tiles)
//   buildTerrainGeometry(data, opts) -> { bands: { far, mid, near }, stats }
//   buildSurfaceTexture(data)        -> { width, height, data: Uint8Array RGBA }
//   terrainHeightAt(data, x, z)      -> metres, NaN outside valid data
//
// Local axes X east, Y up, Z south (metres). Stable geographic identity:
// every level is a subset of one sample lattice, and a finer tile's edge
// vertices snap onto its coarser neighbour's edge, so mixed levels meet
// without cracks and a level change never moves the mountain.
import { decodeResiduals, validateTerrainManifest, WATER_FLOW } from './TerrainPackage.js';

export const BANDS = Object.freeze(['far', 'mid', 'near']);

/** Decode the tile samples declared by a (validated) manifest. */
export function decodeTerrain(manifest, bytes) {
  const check = validateTerrainManifest(manifest, { decoded: bytes.byteLength });
  if (!check.ok) throw new Error(`terrain manifest rejected: ${check.errors.slice(0, 4).join('; ')}`);
  const { offsetM, stepM } = manifest.quantization;
  const tiles = new Map();
  const byIndex = new Map();
  for (const t of manifest.tiles) {
    const n = t.samples;
    const count = n * n;
    const planes = bytes.subarray(t.heights.byteOffset, t.heights.byteOffset + t.heights.byteLength);
    const residual = new Uint16Array(count);
    for (let i = 0; i < count; i++) residual[i] = planes[i] | (planes[count + i] << 8);
    const q = decodeResiduals(residual, n);
    const heights = new Float32Array(count);
    for (let i = 0; i < count; i++) heights[i] = offsetM + q[i] * stepM;
    const flow = bytes.slice(t.flow.byteOffset, t.flow.byteOffset + t.flow.byteLength);
    let valid = null;
    if (t.validity.mode === 'bits') {
      const bits = bytes.subarray(t.validity.byteOffset, t.validity.byteOffset + t.validity.byteLength);
      valid = new Uint8Array(count);
      for (let i = 0; i < count; i++) valid[i] = (bits[i >> 3] >> (i & 7)) & 1;
      for (let i = 0; i < count; i++) if (!valid[i]) heights[i] = NaN;
    }
    for (let i = 0; i < count; i++) {
      if ((!valid || valid[i]) && !Number.isFinite(heights[i])) throw new Error(`tile ${t.id} decoded a non-finite height`);
    }
    const tile = { ...t, heightsM: heights, flowBytes: flow, validMask: valid };
    tiles.set(t.id, tile);
    byIndex.set(`${t.ix},${t.iz}`, tile);
  }
  return { manifest, tiles, byIndex, cells: manifest.tileCells, grid: manifest.grid };
}

/** Height of stored sample (u, v) of a tile, in stored-sample units. */
function sampleAt(tile, u, v) {
  return tile.heightsM[v * tile.samples + u];
}

/**
 * Metres at local (x, z) from the finest stored samples, bilinear inside
 * the covering tile. NaN outside the package or next to no-data.
 */
export function terrainHeightAt(data, x, z) {
  const { grid, cells } = data;
  const gx = (x - grid.originM[0]) / grid.cellSizeM;
  const gz = (z - grid.originM[1]) / grid.cellSizeM;
  if (!(gx >= 0 && gz >= 0)) return NaN;
  let ix = Math.floor(gx / cells), iz = Math.floor(gz / cells);
  // The far edge of the last tile belongs to that tile.
  if (ix >= data.manifest.tilesX && gx === ix * cells) ix--;
  if (iz >= data.manifest.tilesZ && gz === iz * cells) iz--;
  const tile = data.byIndex.get(`${ix},${iz}`);
  if (!tile) return NaN;
  const fu = (gx - ix * cells) / tile.stride, fv = (gz - iz * cells) / tile.stride;
  const n = tile.samples;
  const u0 = Math.min(n - 2, Math.floor(fu)), v0 = Math.min(n - 2, Math.floor(fv));
  const tu = fu - u0, tv = fv - v0;
  const a = sampleAt(tile, u0, v0), b = sampleAt(tile, u0 + 1, v0);
  const c = sampleAt(tile, u0, v0 + 1), d = sampleAt(tile, u0 + 1, v0 + 1);
  // Same diagonal split as the mesh, so roots sit on the drawn surface.
  return tu >= tv ? a + (b - a) * tu + (d - b) * tv : a + (d - c) * tu + (c - a) * tv;
}

/** Runtime stride of each tile for a budget ('desktop' | 'mobile'), with an
 *  optional coarsening `bias` (1 = as baked, 2 = one level coarser...). */
export function tileStrides(data, budget = 'desktop', bias = 1) {
  const out = new Map();
  for (const t of data.tiles.values()) {
    const base = t.lod?.[budget] ?? t.stride;
    out.set(t.id, Math.min(data.cells, Math.max(t.stride, base * bias)));
  }
  return out;
}

/**
 * Which tiles each band draws and how big its arrays are, before anything
 * is allocated. A fringe tile borders a farther band: the farther pass
 * draws it too (RangeScene), so the seam between the two passes is never
 * left open.
 */
function planBands(data, stridesById, includeHidden) {
  const { cells } = data;
  const size = Object.fromEntries(BANDS.map((b) => [b, { v: 0, i: 0, f: 0 }]));
  const bandOf = (t) => (BANDS.includes(t.band) ? t.band : 'far');
  const drawn = [];
  for (const t of data.tiles.values()) {
    if (!t.visible && !includeHidden) continue;
    const m = cells / stridesById.get(t.id);
    const band = bandOf(t);
    let fringe = false;
    for (let dz = -1; dz <= 1 && !fringe; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nb = (dx || dz) && data.byIndex.get(`${t.ix + dx},${t.iz + dz}`);
      if (nb && (nb.visible || includeHidden) && BANDS.indexOf(bandOf(nb)) < BANDS.indexOf(band)) { fringe = true; break; }
    }
    size[band].v += (m + 1) * (m + 1);
    size[band].i += 6 * m * m;
    if (fringe) size[band].f += 6 * m * m;
    drawn.push([t, band, fringe]);
  }
  return { size, drawn };
}

/** Bytes of the seam-fill index buffers buildTerrainGeometry would make,
 *  counted without building anything (a GPU reservation needs them first). */
export function terrainFringeBytes(data, { budget = 'desktop', bias = 1, includeHidden = false, strides = null } = {}) {
  const { size } = planBands(data, strides || tileStrides(data, budget, bias), includeHidden);
  return BANDS.reduce((sum, b) => sum + size[b].f * 4, 0);
}

/**
 * Build per-band geometry. Each band merges its tiles into one position
 * (Float32 xyz) and index (Uint32) array. Tiles never visible from the
 * rail are skipped unless `includeHidden`.
 */
export function buildTerrainGeometry(data, { budget = 'desktop', bias = 1, includeHidden = false, strides = null } = {}) {
  const { grid, cells } = data;
  const stridesById = strides || tileStrides(data, budget, bias);
  const neighbourStride = (t, dx, dz) => {
    const nb = data.byIndex.get(`${t.ix + dx},${t.iz + dz}`);
    return nb ? stridesById.get(nb.id) : 0;
  };
  const { size, drawn } = planBands(data, stridesById, includeHidden);
  const out = Object.fromEntries(BANDS.map((b) => [b, {
    positions: new Float32Array(size[b].v * 3), indices: new Uint32Array(size[b].i), vertexCount: 0, indexCount: 0,
    fringe: new Uint32Array(size[b].f), fringeCount: 0,
  }]));
  let triangles = 0;
  for (const [t, bandName, fringe] of drawn) {
    const s = stridesById.get(t.id);
    const step = s / t.stride; // stored samples per runtime step
    const m = cells / s; // runtime cells per side
    const n = m + 1;
    const edge = {
      north: Math.max(s, neighbourStride(t, 0, -1)), south: Math.max(s, neighbourStride(t, 0, 1)),
      west: Math.max(s, neighbourStride(t, -1, 0)), east: Math.max(s, neighbourStride(t, 1, 0)),
    };
    const band = out[bandName];
    const base = band.vertexCount;
    const x0 = grid.originM[0] + t.ix * cells * grid.cellSizeM;
    const z0 = grid.originM[1] + t.iz * cells * grid.cellSizeM;
    const hRaw = (u, v) => sampleAt(t, u * step, v * step);
    // A finer tile's edge vertex snaps onto the coarser neighbour's straight
    // edge between that neighbour's own vertices: shared edges coincide.
    const along = (k, e) => {
      const r = e / s; // runtime steps per coarse step
      const k0 = Math.floor(k / r) * r;
      return k0 === k ? null : [k0, Math.min(m, k0 + r), (k - k0) / r];
    };
    const snap = (u, v) => {
      let seg = null, axis = 'u';
      if (v === 0 && edge.north > s) seg = along(u, edge.north);
      else if (v === m && edge.south > s) seg = along(u, edge.south);
      else if (u === 0 && edge.west > s) { seg = along(v, edge.west); axis = 'v'; }
      else if (u === m && edge.east > s) { seg = along(v, edge.east); axis = 'v'; }
      const raw = hRaw(u, v);
      // No-data stays no-data: snapping never invents a surface.
      if (!seg || !Number.isFinite(raw)) return raw;
      const [k0, k1, f] = seg;
      const a = axis === 'u' ? hRaw(k0, v) : hRaw(u, k0);
      const b = axis === 'u' ? hRaw(k1, v) : hRaw(u, k1);
      return a + (b - a) * f;
    };
    const P = band.positions;
    const heights = new Float32Array(n * n);
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        const y = snap(u, v);
        heights[v * n + u] = y;
        const o = 3 * (base + v * n + u);
        P[o] = x0 + u * s * grid.cellSizeM;
        P[o + 1] = Number.isFinite(y) ? y : 0;
        P[o + 2] = z0 + v * s * grid.cellSizeM;
      }
    }
    const I = band.indices;
    let k = band.indexCount;
    for (let v = 0; v < m; v++) {
      for (let u = 0; u < m; u++) {
        const la = v * n + u;
        // Skip quads touching no-data.
        if (!(Number.isFinite(heights[la]) && Number.isFinite(heights[la + 1])
          && Number.isFinite(heights[la + n]) && Number.isFinite(heights[la + n + 1]))) continue;
        const a = base + la, b = a + 1, c = a + n, d = c + 1;
        // Split along a-d, matching the baker's error measure. Winding is
        // counter-clockwise seen from above (+Y) in X-east/Z-south axes.
        I[k++] = a; I[k++] = c; I[k++] = d;
        I[k++] = a; I[k++] = d; I[k++] = b;
        triangles += 2;
      }
    }
    if (fringe) {
      band.fringe.set(I.subarray(band.indexCount, k), band.fringeCount);
      band.fringeCount += k - band.indexCount;
    }
    band.indexCount = k;
    band.vertexCount += n * n;
  }
  const bands = {};
  for (const b of BANDS) {
    const o = out[b];
    bands[b] = { positions: o.positions, indices: o.indexCount === o.indices.length ? o.indices : o.indices.slice(0, o.indexCount), vertexCount: o.vertexCount,
      fringe: o.fringeCount === o.fringe.length ? o.fringe : o.fringe.slice(0, o.fringeCount) };
  }
  const bytes = BANDS.reduce((sum, b) => sum + bands[b].positions.byteLength + bands[b].indices.byteLength, 0);
  return { bands, stats: { triangles, vertices: BANDS.reduce((s2, b) => s2 + bands[b].vertexCount, 0), bytes } };
}

/**
 * Grid-resolution surface texture, RGBA8, row 0 = north:
 *   R, G  surface normal X and Z, (n + 1) / 2 * 255
 *   B     curvature: 128 flat, lower convex (ridges), higher concave (gullies)
 *   A     flow: log2 accumulation * 16 (0..254), 255 = hydro-flattened water
 * Heights come from the stored samples at each tile's baked stride, so a
 * coarse distant tile shades as smoothly as it is shaped.
 */
export function buildSurfaceTexture(data, { stride = 1 } = {}) {
  const { grid, cells } = data;
  if (![1, 2, 4].includes(stride) || (grid.width - 1) % stride || (grid.height - 1) % stride) throw new Error('Invalid surface sampling stride');
  const W = (grid.width - 1) / stride + 1, H = (grid.height - 1) / stride + 1;
  const heights = new Float32Array(W * H).fill(NaN);
  const flow = new Uint8Array(W * H);
  // Each cell's stored sample spacing: coarse tiles on gentle ground keep
  // few samples, and their slopes are measured across that spacing.
  const spacing = new Uint8Array(W * H).fill(1);
  for (const t of data.tiles.values()) {
    const x0 = t.ix * cells, z0 = t.iz * cells;
    for (let gz = 0; gz <= cells; gz += stride) {
      const Z = z0 + gz;
      if (Z >= grid.height) break;
      const fv = gz / t.stride;
      const v0 = Math.min(t.samples - 2, Math.floor(fv)), tv = fv - v0;
      for (let gx = 0; gx <= cells; gx += stride) {
        const X = x0 + gx;
        if (X >= grid.width) break;
        const fu = gx / t.stride;
        const u0 = Math.min(t.samples - 2, Math.floor(fu)), tu = fu - u0;
        const a = sampleAt(t, u0, v0), b = sampleAt(t, u0 + 1, v0);
        const c = sampleAt(t, u0, v0 + 1), d = sampleAt(t, u0 + 1, v0 + 1);
        // Bilinear, not the mesh's diagonal split: a coarse tile's triangles
        // are flat facets, and normals taken from them light up as a
        // diamond grid across gentle ground.
        const hh = a + (b - a) * tu + (c - a) * tv + (a - b - c + d) * tu * tv;
        const i = Z / stride * W + X / stride;
        heights[i] = hh;
        spacing[i] = Math.max(1, Math.min(255, t.stride / stride));
        // Water is the bilinear half-coverage contour of the four samples,
        // not the nearest sample: a coarse tile's nearest lookup draws a
        // shoreline in stride-sized stairs. Flow blends the dry samples.
        const fs = t.samples, o = v0 * fs + u0;
        const fa = t.flowBytes[o], fb = t.flowBytes[o + 1], fc = t.flowBytes[o + fs], fd = t.flowBytes[o + fs + 1];
        const wa = (1 - tu) * (1 - tv), wb = tu * (1 - tv), wc = (1 - tu) * tv, wd = tu * tv;
        const wet = (fa === 255 ? wa : 0) + (fb === 255 ? wb : 0) + (fc === 255 ? wc : 0) + (fd === 255 ? wd : 0);
        const dry = 1 - wet;
        const acc = (fa === 255 ? 0 : fa * wa) + (fb === 255 ? 0 : fb * wb) + (fc === 255 ? 0 : fc * wc) + (fd === 255 ? 0 : fd * wd);
        flow[i] = wet > 0.5 ? 255 : dry > 1e-6 ? Math.min(254, Math.round(acc / dry)) : 254;
      }
    }
  }
  const out = new Uint8Array(W * H * 4);
  const cell = grid.cellSizeM * stride;
  const at = (x, z) => {
    const cx = x < 0 ? 0 : x >= W ? W - 1 : x;
    const cz = z < 0 ? 0 : z >= H ? H - 1 : z;
    return heights[cz * W + cx];
  };
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const h0 = heights[i];
      const o = i * 4;
      if (!Number.isFinite(h0)) { out[o] = 128; out[o + 1] = 128; out[o + 2] = 128; out[o + 3] = 0; continue; }
      // Central differences across the stored sample spacing (at least one
      // cell), so the slope blends across a coarse tile's sample cells.
      const r = Math.max(1, spacing[i] >> 1);
      let hl = at(x - r, z), hr = at(x + r, z), hu = at(x, z - r), hd = at(x, z + r);
      if (!Number.isFinite(hl)) hl = h0; if (!Number.isFinite(hr)) hr = h0;
      if (!Number.isFinite(hu)) hu = h0; if (!Number.isFinite(hd)) hd = h0;
      const dx = (hr - hl) / (2 * r * cell), dz = (hd - hu) / (2 * r * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      out[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((-dz * inv * 0.5 + 0.5) * 255);
      // Curvature over a 2-cell radius: mean of neighbours minus centre, in
      // metres; +-12 m spans the byte.
      let sum = 0, cnt = 0;
      for (const [ox, oz] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]]) {
        const hv = at(x + ox, z + oz);
        if (Number.isFinite(hv)) { sum += hv; cnt++; }
      }
      const lap = cnt ? sum / cnt - h0 : 0;
      out[o + 2] = Math.max(0, Math.min(255, Math.round(128 + lap * (127 / 12))));
      out[o + 3] = flow[i];
    }
  }
  return { width: W, height: H, data: out, waterValue: WATER_FLOW };
}


/** Conservative dry-receiver field. Water and two grid cells of shore pin;
 * a two-cell shoulder reconnects smoothly to moving uplands. Water's special
 * 255 marker is checked exactly; high flow accumulation is not a lake. */
export function buildReceiverMask(surface) {
  const { width: W, height: H, data } = surface;
  const mask = new Uint8Array(W * H).fill(255);
  for (let i = 0; i < mask.length; i++) if (data[i * 4 + 3] === 255) mask[i] = 0;
  // Two linear sweeps compute chessboard distance without repeated scans of
  // large lake interiors; the same byte array becomes the final field.
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x;
    let d = mask[i];
    if (x > 0) d = Math.min(d, mask[i - 1] + 1);
    if (z > 0) {
      d = Math.min(d, mask[i - W] + 1);
      if (x > 0) d = Math.min(d, mask[i - W - 1] + 1);
      if (x < W - 1) d = Math.min(d, mask[i - W + 1] + 1);
    }
    mask[i] = d;
  }
  for (let z = H - 1; z >= 0; z--) for (let x = W - 1; x >= 0; x--) {
    const i = z * W + x;
    let d = mask[i];
    if (x < W - 1) d = Math.min(d, mask[i + 1] + 1);
    if (z < H - 1) {
      d = Math.min(d, mask[i + W] + 1);
      if (x > 0) d = Math.min(d, mask[i + W - 1] + 1);
      if (x < W - 1) d = Math.min(d, mask[i + W + 1] + 1);
    }
    mask[i] = d;
  }
  for (let i = 0; i < mask.length; i++) {
    const t = Math.min(1, Math.max(0, (mask[i] - 2) / 2));
    mask[i] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return { width: W, height: H, data: mask };
}

/** Bilinear receiver read at grid sample coordinates, matching GL texture. */
export function sampleReceiverMask(mask, x, z) {
  const W = mask.width, H = mask.height;
  const xx = Math.min(W - 1, Math.max(0, x)), zz = Math.min(H - 1, Math.max(0, z));
  const x0 = Math.floor(xx), z0 = Math.floor(zz), tx = xx - x0, tz = zz - z0;
  const at = (u, v) => mask.data[Math.min(H - 1, v) * W + Math.min(W - 1, u)] / 255;
  return at(x0, z0) * (1 - tx) * (1 - tz) + at(x0 + 1, z0) * tx * (1 - tz)
    + at(x0, z0 + 1) * (1 - tx) * tz + at(x0 + 1, z0 + 1) * tx * tz;
}
