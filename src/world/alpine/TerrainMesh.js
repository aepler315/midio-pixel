import { finishPreparation, prepareInSlices } from './PreparationSteps.js';
// Range v2: build drawable terrain from a validated heightfield package
// (TerrainPackage.js). Engine-agnostic: produces typed arrays (positions,
// indices, a surface texture) that RangeScene uploads, and a height sampler
// that forest roots and the review tools share.
//
//   decodeTerrain(manifest, bytes)   -> TerrainData (dequantized tiles)
//   buildTerrainGeometry(data, opts) -> { bands: { far, mid, near }, stats }
//   terrainBandsFor(built, mode)     -> what the rail or the tour draws of it
//   buildSurfaceTexture(data)        -> { width, height, data: Uint8Array RGBA }
//   terrainHeightAt(data, x, z)      -> metres, NaN outside valid data
//
// Local axes X east, Y up, Z south (metres). Stable geographic identity:
// every level is a subset of one sample lattice, and a finer tile's edge
// vertices snap onto its coarser neighbour's edge, so mixed levels meet
// without cracks and a level change never moves the mountain.
import { decodeResiduals, INLAND_MAX_DRY_FLOW, INLAND_RIVER_FLOW, validateTerrainManifest, WATER_FLOW } from './TerrainPackage.js';

export const BANDS = Object.freeze(['far', 'mid', 'near']);
// Surface build: heights (4) + stored spacing (1) + RGBA output (4).
// After that generator completes, receiver construction retains RGBA + mask (5).
export const SURFACE_BUILD_BYTES_PER_PIXEL = 9;

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
  const data = { manifest, tiles, byIndex, cells: manifest.tileCells, grid: manifest.grid };
  const bank = manifest.hydrology?.riverBankAtlas;
  if (bank) {
    const tableAt = bank.byteOffset + bank.width * bank.height;
    const pageTable = bytes.slice(tableAt, bank.byteOffset + bank.byteLength);
    const slots = bank.pageColumns * (bank.height / (bank.coreSize + 1));
    for (let i = 0; i < pageTable.length; i += 2) {
      if (pageTable[i] + 256 * pageTable[i + 1] > slots) throw new Error('river bank page outside atlas');
    }
    data.riverBankAtlas = { ...bank, data: bytes.slice(bank.byteOffset, tableAt), pageTable };
  }
  return data;
}

/** Height of stored sample (u, v) of a tile, in stored-sample units. */
function sampleAt(tile, u, v) {
  return tile.heightsM[v * tile.samples + u];
}

/**
 * Metres at local (x, z) from the finest stored samples, bilinear inside
 * the covering tile. NaN outside the package or next to no-data. Terrain
 * data that draws another surface (CompiledTerrain.js columns) supplies its
 * own `groundAt`, so everything standing on the land follows what is drawn.
 */
export function terrainHeightAt(data, x, z) {
  if (data.groundAt) return data.groundAt(x, z);
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
  for (const t of data.tiles.values()) out.set(t.id, tileStride(t, budget, data.cells, bias));
  return out;
}

function tileStride(tile, budget, cells, bias = 1) {
  return Math.min(cells, Math.max(tile.stride, (tile.lod?.[budget] ?? tile.stride) * bias));
}

/** Sample the same snapped vertices used by buildTerrainGeometry. */
function tileMeshHeights(tile, stride, cells, neighbourStride) {
  const m = cells / stride, step = stride / tile.stride;
  const north = neighbourStride(0, -1), south = neighbourStride(0, 1);
  const west = neighbourStride(-1, 0), east = neighbourStride(1, 0);
  const raw = (u, v) => sampleAt(tile, u * step, v * step);
  // A finer tile's edge vertex snaps onto the coarser neighbour's straight
  // edge between that neighbour's own vertices. Never fill missing data.
  const along = (q, fixed, varyU, coarse, h) => {
    if (coarse <= stride || !Number.isFinite(h)) return h;
    const r = coarse / stride;
    const q0 = Math.floor(q / r) * r;
    if (q0 === q) return h;
    const q1 = Math.min(m, q0 + r);
    const a = varyU ? raw(q0, fixed) : raw(fixed, q0);
    const b = varyU ? raw(q1, fixed) : raw(fixed, q1);
    return a + (b - a) * ((q - q0) / r);
  };
  return (u, v) => {
    const h = raw(u, v);
    if (v === 0 && north > stride) return along(u, v, true, north, h);
    if (v === m && south > stride) return along(u, v, true, south, h);
    if (u === 0 && west > stride) return along(v, u, false, west, h);
    if (u === m && east > stride) return along(v, u, false, east, h);
    return h;
  };
}

/** Height under a root on the static drawable mesh at this budget. Keeps at
 *  most one tile's sampler; the mesh itself can still be built after placement. */
export function makeTerrainMeshHeightSampler(data, budget) {
  if (data.groundAt) return (x, z) => data.groundAt(x, z);
  const { grid, cells, manifest } = data;
  const [ox, oz] = grid.originM;
  const strideFor = tile => tileStride(tile, budget, cells);
  let owner, height, stride;
  return (x, z) => {
    const gx = (x - ox) / grid.cellSizeM, gz = (z - oz) / grid.cellSizeM;
    const ix = Math.floor(gx / cells) - (gx === manifest.tilesX * cells ? 1 : 0);
    const iz = Math.floor(gz / cells) - (gz === manifest.tilesZ * cells ? 1 : 0);
    const tile = data.byIndex.get(`${ix},${iz}`);
    if (!tile?.visible) return NaN;
    if (owner !== tile) {
      owner = tile;
      stride = strideFor(tile);
      height = tileMeshHeights(tile, stride, cells, (dx, dz) => {
        const other = data.byIndex.get(`${ix + dx},${iz + dz}`);
        return other ? strideFor(other) : 0;
      });
    }
    const m = cells / stride;
    const fu = (gx - ix * cells) / stride, fv = (gz - iz * cells) / stride;
    const u = Math.min(m - 1, Math.floor(fu)), v = Math.min(m - 1, Math.floor(fv));
    const tu = fu - u, tv = fv - v;
    const a = Math.fround(height(u, v)), b = Math.fround(height(u + 1, v));
    const c = Math.fround(height(u, v + 1)), d = Math.fround(height(u + 1, v + 1));
    if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) return NaN;
    return tu >= tv ? a + (b - a) * tu + (d - b) * tv : a + (d - c) * tu + (c - a) * tv;
  };
}

/** Whether the rail draws `tile`: a posed bake marks the tiles only shot-tour
 *  poses see `rail: false` (they draw while the view plays its tour). Unlike
 *  TerrainPackage's check, hidden tiles count: `includeHidden` draws them. */
const railGround = (t) => t.rail !== false;

const SIDES = Object.freeze([[0, -1], [0, 1], [-1, 0], [1, 0]]);

/**
 * Which tiles each band draws, in what order, and how big its arrays are,
 * before anything is allocated. A fringe tile borders a farther band: the
 * farther pass draws it too (RangeScene), so the seam between the two passes
 * is never left open.
 *
 * With `railSplit` (the default) a band is laid out for two draw modes that
 * are each one contiguous index range (BufferGeometry.setDrawRange):
 *
 *   [R rail copies] [A rail tiles] [T tour copies] [D tour-only tiles]
 *    `----- rail: [0, R+A) ------'
 *                   `------------- tour: [R, end) -------------------'
 *
 * A rail tile whose edge would snap onto a coarser tour-only neighbour is
 * built twice: R snaps only to what the rail draws (the shape a package
 * without tour-only tiles has), T snaps to every neighbour (crack-free
 * against the tour-only tiles). Every other rail tile (A) is the same in both
 * modes. The rail range is thus exactly the build of the package with its
 * tour-only tiles removed, and the tour range exactly the build of every
 * tile. The seam fill keeps the same contract: rail fringe tiles (a farther
 * rail neighbour) first, then the fill only the tour needs. A package without
 * tour-only tiles (every rail-only bake) has no R, T or D: its layout, and
 * every array, is byte-identical to the single-mode build.
 */
function planBands(data, stridesById, includeHidden, railSplit = true) {
  const { cells } = data;
  const isRail = railSplit ? railGround : () => true;
  const bandOf = (t) => (BANDS.includes(t.band) ? t.band : 'far');
  const drawn = (t) => !!t && (t.visible || includeHidden);
  const tourOnly = (t) => drawn(t) && !isRail(t);
  const size = Object.fromEntries(BANDS.map((b) => [b, { v: 0, i: 0, f: 0, copyV: 0, copyI: 0, copyF: 0 }]));
  const sections = Object.fromEntries(BANDS.map((b) => [b, { R: [], A: [], T: [], D: [] }]));
  let seq = -1;
  for (const t of data.tiles.values()) {
    seq++;
    if (!drawn(t)) continue;
    const s = stridesById.get(t.id), m = cells / s, band = bandOf(t), at = BANDS.indexOf(band);
    let fringe = false, railFringe = false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nb = (dx || dz) && data.byIndex.get(`${t.ix + dx},${t.iz + dz}`);
      if (!drawn(nb) || BANDS.indexOf(bandOf(nb)) >= at) continue;
      fringe = true;
      if (isRail(nb)) railFringe = true;
    }
    const tv = (m + 1) * (m + 1), ti = 6 * m * m, sz = size[band], sec = sections[band];
    sz.v += tv; sz.i += ti; if (fringe) sz.f += ti;
    if (!isRail(t)) { sec.D.push({ t, seq, fringe, ignoreTourOnly: false }); continue; }
    // Corners never snap (along() keeps multiples of the coarse step), so
    // only the four edge neighbours can move a rail tile's vertices.
    const split = SIDES.some(([dx, dz]) => {
      const nb = data.byIndex.get(`${t.ix + dx},${t.iz + dz}`);
      return tourOnly(nb) && stridesById.get(nb.id) > s;
    });
    if (!split) { sec.A.push({ t, seq, fringe, railFringe, ignoreTourOnly: false }); continue; }
    sz.v += tv; sz.i += ti; sz.copyV += tv; sz.copyI += ti;
    if (railFringe) { sz.f += ti; sz.copyF += ti; }
    sec.R.push({ t, seq, fringe: railFringe, ignoreTourOnly: true });
    sec.T.push({ t, seq, fringe, ignoreTourOnly: false });
  }
  return { size, sections };
}

/** Bytes of the seam-fill index buffers buildTerrainGeometry would make,
 *  counted without building anything (a GPU reservation needs them first). */
export function terrainFringeBytes(data, { budget = 'desktop', bias = 1, includeHidden = false, strides = null, railSplit = true } = {}) {
  const { size } = planBands(data, strides || tileStrides(data, budget, bias), includeHidden, railSplit);
  return BANDS.reduce((sum, b) => sum + size[b].f * 4, 0);
}

/** Upper bound of the position and index bytes of the rail copies (R above):
 *  a bake's mesh estimate counts each tile once. 0 for a rail-only package. */
export function terrainRailCopyBytes(data, { budget = 'desktop', bias = 1, includeHidden = false, strides = null, railSplit = true } = {}) {
  const { size } = planBands(data, strides || tileStrides(data, budget, bias), includeHidden, railSplit);
  return BANDS.reduce((sum, b) => sum + size[b].copyV * 12 + size[b].copyI * 4, 0);
}

/**
 * Build per-band geometry. Each band merges its tiles into one position
 * (Float32 xyz) and index (Uint32) array. Tiles never visible from any pose
 * are skipped unless `includeHidden`. Each band carries the index ranges of
 * its two draw modes, `ranges` and `fringeRanges` ({ rail, tour }: [start,
 * count]), or null when the band holds nothing only a tour draws (both modes
 * then draw the whole buffer). With ranges, `tileOrder` ({ rail, tour }:
 * flat [first, last) index pairs) lists each mode's tiles in package order. `railSplit: false` lays every tile out once,
 * as rail tiles (tour windows, which never draw a rail).
 */
export function buildTerrainGeometry(data, { budget = 'desktop', bias = 1, includeHidden = false, strides = null, railSplit = true } = {}) {
  const { grid, cells } = data;
  const isRail = railSplit ? railGround : () => true;
  const stridesById = strides || tileStrides(data, budget, bias);
  const { size, sections } = planBands(data, stridesById, includeHidden, railSplit);
  let triangles = 0, railTriangles = 0, railCopies = 0;
  const bands = {};
  for (const bandName of BANDS) {
    const sz = size[bandName];
    const P = new Float32Array(sz.v * 3), I = new Uint32Array(sz.i), F = new Uint32Array(sz.f);
    let vertexCount = 0, k = 0, fringeCount = 0;
    const { R, A, T, D } = sections[bandName];
    const tileCount = R.length + A.length + T.length + D.length;
    const chunks = chunkArrays(tileCount), fringeChunks = chunkArrays(tileCount);
    const fill = (a, b, box) => {
      pushChunk(fringeChunks, fringeCount, b - a, box);
      F.set(I.subarray(a, b), fringeCount);
      fringeCount += b - a;
    };
    // One tile into the band's arrays: [first, last) of its indices.
    const emit = ({ t, ignoreTourOnly }) => {
      const s = stridesById.get(t.id);
      const m = cells / s; // runtime cells per side
      const n = m + 1;
      // A rail copy is shaped as if the tour-only tiles were not there.
      const neighbourStride = (dx, dz) => {
        const nb = data.byIndex.get(`${t.ix + dx},${t.iz + dz}`);
        if (!nb || (ignoreTourOnly && (nb.visible || includeHidden) && !isRail(nb))) return 0;
        return stridesById.get(nb.id);
      };
      const base = vertexCount;
      const x0 = grid.originM[0] + t.ix * cells * grid.cellSizeM;
      const z0 = grid.originM[1] + t.iz * cells * grid.cellSizeM;
      const snap = tileMeshHeights(t, s, cells, neighbourStride);
      const heights = new Float32Array(n * n);
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let v = 0; v < n; v++) {
        for (let u = 0; u < n; u++) {
          const y = snap(u, v);
          heights[v * n + u] = y;
          const o = 3 * (base + v * n + u);
          P[o] = x0 + u * s * grid.cellSizeM;
          P[o + 1] = Number.isFinite(y) ? y : 0;
          P[o + 2] = z0 + v * s * grid.cellSizeM;
          if (Number.isFinite(y)) for (let axis = 0; axis < 3; axis++) {
            box[axis] = Math.min(box[axis], P[o + axis]);
            box[axis + 3] = Math.max(box[axis + 3], P[o + axis]);
          }
        }
      }
      const first = k;
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
        }
      }
      vertexCount += n * n;
      pushChunk(chunks, first, k - first, box);
      return [first, k, box];
    };
    // Each emitted tile's [first, last) indices, for the per-mode tile order.
    const pieces = { R: [], A: [], T: [] };
    for (const e of R) { const [a, b, box] = emit(e); pieces.R.push([e.seq, a, b]); railTriangles += (b - a) / 3; railCopies++; if (e.fringe) fill(a, b, box); }
    const tourStart = k, tourFringeStart = fringeCount;
    // A tile that borders a farther band only through a tour-only tile
    // fills that seam in the tour alone: after the rail's fill.
    const tourFill = [];
    for (const e of A) {
      const [a, b, box] = emit(e);
      pieces.A.push([e.seq, a, b]);
      railTriangles += (b - a) / 3;
      if (e.railFringe) fill(a, b, box); else if (e.fringe) tourFill.push([a, b, box]);
    }
    const railEnd = k, railFringeEnd = fringeCount;
    for (const [a, b, box] of tourFill) fill(a, b, box);
    for (const e of [...T, ...D]) { const [a, b, box] = emit(e); pieces.T.push([e.seq, a, b]); if (e.fringe) fill(a, b, box); }
    triangles += (k - tourStart) / 3;
    const split = railEnd !== k || tourStart !== 0;
    // Each mode's tiles in package order: the order a build of what that
    // mode draws, alone, would emit them in (order-dependent samplers such
    // as the contour-ink reservoir read it).
    const ordered = (...lists) => Uint32Array.from(lists.flat().sort((x, y) => x[0] - y[0]).flatMap(([, a, b]) => [a, b]));
    const fringeSplit = railFringeEnd !== fringeCount || tourFringeStart !== 0;
    bands[bandName] = {
      positions: vertexCount * 3 === P.length ? P : P.slice(0, vertexCount * 3),
      indices: k === I.length ? I : I.slice(0, k), vertexCount,
      fringe: fringeCount === F.length ? F : F.slice(0, fringeCount),
      chunks: finishChunks(chunks), fringeChunks: finishChunks(fringeChunks),
      ranges: split ? { rail: [0, railEnd], tour: [tourStart, k - tourStart] } : null,
      fringeRanges: fringeSplit ? { rail: [0, railFringeEnd], tour: [tourFringeStart, fringeCount - tourFringeStart] } : null,
      tileOrder: split ? { rail: ordered(pieces.R, pieces.A), tour: ordered(pieces.A, pieces.T) } : null,
    };
  }
  const bytes = BANDS.reduce((sum, b) => sum + bands[b].positions.byteLength + bands[b].indices.byteLength, 0);
  return { bands, stats: { triangles, railTriangles, railCopies, vertices: BANDS.reduce((s2, b) => s2 + bands[b].vertexCount, 0), bytes } };
}

/** The arrays one draw mode ('rail' | 'tour') of a built terrain draws, per
 *  band: the shared positions and that mode's index and seam-fill ranges.
 *  For evidence tools that read the mesh as the scene draws it. */
export function terrainBandsFor(built, mode) {
  return Object.fromEntries(BANDS.map((b) => {
    const band = built.bands[b];
    const cut = (array, ranges) => (ranges ? array.subarray(ranges[mode][0], ranges[mode][0] + ranges[mode][1]) : array);
    return [b, { ...band, indices: cut(band.indices, band.ranges), fringe: cut(band.fringe, band.fringeRanges) }];
  }));
}

// Per-tile index ranges and boxes (TerrainChunks.chunkTable's arrays).
function chunkArrays(n) {
  return { start: new Uint32Array(n), count: new Uint32Array(n), box: new Float64Array(6 * n), length: 0 };
}

function pushChunk(c, start, count, box) {
  // A tile with no drawable quad keeps no chunk; its range is empty.
  if (!count) return;
  const i = c.length++;
  c.start[i] = start; c.count[i] = count;
  for (let a = 0; a < 6; a++) c.box[i * 6 + a] = box[a];
}

function finishChunks(c) {
  const n = c.length;
  return { start: c.start.slice(0, n), count: c.count.slice(0, n), box: c.box.slice(0, 6 * n) };
}

/**
 * Grid-resolution surface texture, RGBA8, row 0 = north:
 *   R, G  surface normal X and Z, (n + 1) / 2 * 255
 *   B     curvature: 128 flat, lower convex (ridges), higher concave (gullies)
 *   A     flow: 0..254, with 255 reserved for hydro-flattened water. Inland
 *         terrain reserves 254 for generated channels and caps dry flow at 240.
 * Heights come from the stored samples at each tile's baked stride, so a
 * coarse distant tile shades as smoothly as it is shaped.
 */
export function buildSurfaceTexture(data, options = {}) {
  return finishPreparation(surfaceTextureSteps(data, options));
}

export function buildSurfaceTextureAsync(data, options = {}) {
  return prepareInSlices(surfaceTextureSteps(data, options), options);
}

function* surfaceTextureSteps(data, { stride = 1 } = {}) {
  const { grid, cells } = data;
  const inland = data.manifest?.hydrology?.riverFlow === INLAND_RIVER_FLOW;
  const wetMarker = inland ? INLAND_RIVER_FLOW : WATER_FLOW;
  const dryLimit = inland ? INLAND_MAX_DRY_FLOW : WATER_FLOW - 1;
  if (![1, 2, 4].includes(stride) || (grid.width - 1) % stride || (grid.height - 1) % stride) throw new Error('Invalid surface sampling stride');
  const W = (grid.width - 1) / stride + 1, H = (grid.height - 1) / stride + 1;
  const heights = new Float32Array(W * H).fill(NaN);
  const out = new Uint8Array(W * H * 4);
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
        const wet = (fa === wetMarker ? wa : 0) + (fb === wetMarker ? wb : 0) + (fc === wetMarker ? wc : 0) + (fd === wetMarker ? wd : 0);
        const dry = 1 - wet;
        const acc = (fa === wetMarker ? 0 : fa * wa) + (fb === wetMarker ? 0 : fb * wb) + (fc === wetMarker ? 0 : fc * wc) + (fd === wetMarker ? 0 : fd * wd);
        const channelOrLake = inland ? wet >= 0.5 : wet > 0.5;
        out[i * 4 + 3] = channelOrLake ? wetMarker : dry > 1e-6 ? Math.min(dryLimit, Math.round(acc / dry)) : dryLimit;
      }
      yield;
    }
  }
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
    }
    yield;
  }
  const surface = { width: W, height: H, data: out, waterValue: WATER_FLOW };
  if (inland) surface.riverValue = INLAND_RIVER_FLOW;
  return surface;
}


/** Water and two adjacent grid cells stay still while a two-cell shoulder
 * reconnects them to moving uplands. Lake and inland river markers are exact. */
export function buildReceiverMask(surface) {
  return finishPreparation(receiverMaskSteps(surface));
}

export function buildReceiverMaskAsync(surface, options = {}) {
  return prepareInSlices(receiverMaskSteps(surface), options);
}

function* receiverMaskSteps(surface) {
  const { width: W, height: H, data, riverValue = WATER_FLOW } = surface;
  const mask = new Uint8Array(W * H).fill(255);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x, flow = data[i * 4 + 3];
      if (flow === WATER_FLOW || flow === riverValue) mask[i] = 0;
    }
    yield;
  }
  // Two linear sweeps compute chessboard distance without repeated scans of
  // large lake interiors; the same byte array becomes the final field.
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
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
    yield;
  }
  for (let z = H - 1; z >= 0; z--) {
    for (let x = W - 1; x >= 0; x--) {
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
    yield;
  }
  for (let i = 0; i < mask.length; i++) {
    const t = Math.min(1, Math.max(0, (mask[i] - 2) / 2));
    mask[i] = Math.round(255 * t * t * (3 - 2 * t));
    if (i % 4096 === 4095) yield;
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
