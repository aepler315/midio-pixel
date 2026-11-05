// Frustum culling for the forest's mesh trees, one whole batch at a time.
//
// Every forest batch (band x species family x variant, ForestGL.js) is one
// instanced geometry spread along the whole rail and drawn with
// frustumCulled = false, so every pass that draws trees submits every tree,
// mostly off-screen. Culling trees inside a batch would change which trees
// draw before which; the soft crowns blend in instance order, so that could
// change pixels. A whole batch can go, though: when no tree of it can reach
// what the camera draws, it makes no fragment in that render.
//
// Scene.onBeforeRender runs before three.js culls or sorts. There, each
// mesh-tree geometry of the scene is tested once: its trees, binned into
// cells of FOREST_CULL_CELL_M by root, become boxes holding every vertex the
// tree shaders (ForestGL MESH_VERT) can place this frame. A geometry with no
// box inside the camera's frustum (narrowed to the target's scissor,
// TerrainChunks.frustumPlanes) gets instanceCount 0 for that render, and
// Scene.onAfterRender puts the count back. three.js still binds, uploads
// and orders everything exactly as before; renderInstances only skips the
// draw call itself when the count is 0. So every drawn object keeps its
// place and its GL state, and the picture is unchanged.
//
// A render that throws never reaches onAfterRender. Its counts stay 0 until
// the next culled render of any scene (the scenes share these geometries),
// or until restoreForestCulling(), which the code that reads or sets a
// batch's instanceCount between renders calls first (ForestGL
// updateDetailView, the tour layer's apply and setMode, RangeScene
// _setTerrainMode). The tour's apply is the first of these after a frame
// that threw, so without its restore the next render would put a stale
// count back over the twins it refilled.
//
// The box of a tree with root (X, Y, Z), height H and width W:
// - Root lift: the shaders add deformAt(iPos) to the root (rootOf). That is
//   the terrain's own displacement without ice, so MirrorScissor.liftBounds
//   bounds it (already doubled, plus 1 m).
// - Height: y01 * H, with y01 in [0, 1] when the asset's position.y is
//   (checked per asset; an asset outside that range is never culled) and
//   the tree's id (iVar.y) is (checked per batch, likewise).
// - Crown: |radial| * crownHalfWidth / crownRatio * W * jitter, with
//   crownHalfWidth / crownRatio <= .5 * 1.045 (the rag) and jitter <= 1.15
//   (CROWN_RADIUS_PER_WIDTH), |radial| = |position.xz| of foliage vertices.
// - Trunk: |radial| * (.12 + .14 id)(1 - .94 y01) <= |radial| * .26 m.
// - Wind (windAt), horizontal only and scaled by y01^2 <= 1: sway
//   WIND_SWAY * WIND_SWAY_PEAK * |uWind.x|, gust GUST_LEAN (its lean is
//   clamped to [-1, 1]), parting PARTING_LEAN * |uParting.w|, and the
//   storm's |uWind.y| along the unit WIND_DIR, all times H; doubled
//   (MIRROR_BOUND_SAFETY).
// - The song's rise (LandRise.js), applied last: riseLift(p) lowers each
//   vertex by where it stands and never raises it. Drawn height rises with
//   height and with horizontal distance from the eye, so the lowest a box
//   can draw is its bottom at its nearest point (risenFloor), as the
//   terrain's chunks bound it.
// Every box then gets CHUNK_BOX_PAD_M on each side.
//
// Billboards are not culled: their pixel-width reserve depends on the
// camera and target, and their batches span every band anyway.

import { frustumPlanes, boxOutsidePlanes, CHUNK_BOX_PAD_M } from './TerrainChunks.js';
import { liftBounds, MIRROR_BOUND_SAFETY } from './MirrorScissor.js';
import { risenFloor } from './LandRise.js';
import { WIND_SWAY, WIND_SWAY_PEAK, GUST_LEAN, PARTING_LEAN } from './ForestWind.js';

/** Root cell size for a batch's boxes, metres. */
export const FOREST_CULL_CELL_M = 256;
/** Bound of crownHalfWidth / crownRatio (.5 * the 1.045 rag) times the
 *  branch jitter's 1.15, per metre of tree width (ForestGL MESH_VERT). */
export const CROWN_RADIUS_PER_WIDTH = 0.5 * 1.045 * 1.15;
/** Bound of the trunk's radius scale (.12 + .14 id)(1 - .94 y01), metres. */
export const TRUNK_RADIUS_M = 0.26;

const finite = v => Number.isFinite(v) ? v : Infinity;

/** Horizontal crown displacement windAt can add, per metre of tree height,
 *  from the forest's uniforms (no safety factor). */
export function forestLean(u) {
  const wind = u?.uWind?.value, parting = u?.uParting?.value;
  return WIND_SWAY * WIND_SWAY_PEAK * Math.abs(finite(wind?.x)) + GUST_LEAN
    + PARTING_LEAN * Math.abs(finite(parting?.w)) + Math.abs(finite(wind?.y));
}

// Asset extents per base position attribute (the lite twin swaps its base
// between two LODs at run time, so this follows the attribute in use).
const extentsCache = new WeakMap();

/** { foliage, trunk } horizontal radii (|position.xz|) of a conifer asset's
 *  foliage and trunk vertices, or null when the asset cannot be bounded
 *  (no aBranch, or a position.y outside [0, 1]). */
export function assetExtents(geometry) {
  const position = geometry?.attributes?.position, branch = geometry?.attributes?.aBranch;
  if (!position || !branch || branch.count !== position.count) return null;
  if (extentsCache.has(position)) return extentsCache.get(position);
  let foliage = 0, trunk = 0, ok = position.count > 0;
  for (let i = 0; i < position.count && ok; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (!(y >= 0 && y <= 1) || !Number.isFinite(x) || !Number.isFinite(z)) ok = false;
    const r = Math.hypot(x, z);
    if (branch.getW(i) > .5) foliage = Math.max(foliage, r); else trunk = Math.max(trunk, r);
  }
  const out = ok ? { foliage, trunk } : null;
  extentsCache.set(position, out);
  return out;
}

// Root cells per instance attribute set (shared by a batch's twins).
const cellsCache = new WeakMap();

/** A batch's trees binned by root into FOREST_CULL_CELL_M cells: per cell
 *  min x, min bottom (root y, plus the height if negative), min z, max x,
 *  max top (root y, plus the height if positive), max z, max |height|, max
 *  |width|. Null when the instances cannot be bounded (a non-finite value,
 *  or an id outside [0, 1]).
 *
 *  A batch tagged `forestCull.prefix` (the tour layer's twins, ForestGL.js)
 *  refills its attributes in place and draws only their first
 *  instanceCount trees: its cells cover that prefix and are rebuilt when
 *  the count or an attribute's version changes. three draws
 *  min(instanceCount, the instance count), so a count at or past its trees
 *  (three's default Infinity included) covers every tree. Every other batch
 *  is bound over all its trees, as before. */
export function forestCells(geometry) {
  return forestCellsEntry(geometry)?.cells ?? null;
}

// An interleaved attribute has no version of its own: its buffer has.
const versionOf = a => a.isInterleavedBufferAttribute ? a.data.version : a.version;

function forestCellsEntry(geometry) {
  const pos = geometry?.attributes?.iPos, size = geometry?.attributes?.iSize, vars = geometry?.attributes?.iVar;
  if (!pos || !size || !vars || size.count < pos.count || vars.count < pos.count) return null;
  const cull = geometry.userData?.forestCull, prefix = !!cull?.prefix, count = geometry.instanceCount;
  const n = !prefix || count >= pos.count ? pos.count : count > 0 ? Math.floor(count) : 0;
  const version = prefix ? `${n}:${versionOf(pos)}:${versionOf(size)}:${versionOf(vars)}` : null;
  const lists = !!cull?.spans;
  const cached = cellsCache.get(pos);
  if (cached && cached.size === size && cached.vars === vars && cached.version === version && (!lists || cached.trees !== undefined)) return cached;
  const cells = new Map();
  // Spans (below) also need each cell's trees: the cell of each tree, from
  // this same pass.
  const cellOf = lists ? new Int32Array(n) : null;
  let ok = true;
  for (let i = 0; i < n && ok; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), h = size.getX(i), w = size.getY(i), id = vars.getY(i);
    if (![x, y, z, h, w].every(Number.isFinite) || !(id >= 0 && id <= 1)) { ok = false; break; }
    const key = `${Math.floor(x / FOREST_CULL_CELL_M)},${Math.floor(z / FOREST_CULL_CELL_M)}`;
    const bottom = y + Math.min(0, h), top = y + Math.max(0, h), height = Math.abs(h), width = Math.abs(w);
    const c = cells.get(key);
    if (!c) {
      if (cellOf) cellOf[i] = cells.size;
      cells.set(key, [x, bottom, z, x, top, z, height, width, cells.size]);
    } else {
      if (cellOf) cellOf[i] = c[8];
      if (x < c[0]) c[0] = x; if (bottom < c[1]) c[1] = bottom; if (z < c[2]) c[2] = z;
      if (x > c[3]) c[3] = x; if (top > c[4]) c[4] = top; if (z > c[5]) c[5] = z;
      if (height > c[6]) c[6] = height; if (width > c[7]) c[7] = width;
    }
  }
  let out = null, trees = lists ? null : undefined;
  if (ok) {
    out = new Float64Array(8 * cells.size);
    let o = 0;
    for (const c of cells.values()) { for (let j = 0; j < 8; j++) out[o + j] = c[j]; o += 8; }
    if (lists) {
      // Each cell's trees in draw order: index[start[k] .. start[k + 1]).
      const start = new Int32Array(cells.size + 1), index = new Int32Array(n);
      for (let i = 0; i < n; i++) start[cellOf[i] + 1]++;
      for (let k = 0; k < cells.size; k++) start[k + 1] += start[k];
      const fill = start.slice(0, cells.size);
      for (let i = 0; i < n; i++) index[fill[cellOf[i]]++] = i;
      trees = { start, index };
    }
  }
  const entry = { size, vars, version, cells: out, trees };
  cellsCache.set(pos, entry);
  return entry;
}

/**
 * Box (minX, minY, minZ, maxX, maxY, maxZ) around every vertex the tree
 * shader can place for the trees of cell `c` (offset `o` in `cells`), given
 * the asset's extents, the root lift { lo, hi, rise } (MirrorScissor
 * liftBounds; `rise` null when the range stands complete) and the
 * horizontal lean per metre of height. `pad` metres are added on every
 * side.
 */
export function forestCellBox(cells, o, extents, lift, lean, pad = CHUNK_BOX_PAD_M, out = new Float64Array(6)) {
  const r = Math.max(extents.foliage * CROWN_RADIUS_PER_WIDTH * cells[o + 7], extents.trunk * TRUNK_RADIUS_M) + lean * cells[o + 6] + pad;
  const x0 = cells[o] - r, z0 = cells[o + 2] - r, x1 = cells[o + 3] + r, z1 = cells[o + 5] + r;
  const bottom = cells[o + 1] + Math.min(0, lift.lo);
  out[0] = x0; out[1] = (lift.rise ? risenFloor(bottom, x0, z0, x1, z1, lift.rise) : bottom) - pad; out[2] = z0;
  out[3] = x1; out[4] = cells[o + 4] + Math.max(0, lift.hi) + pad; out[5] = z1;
  return out;
}

// A rise the box cannot bound, read as the shader reads it (LandRise.js
// riseLift: uLandRise raw, the eye from uTourEye). risenFloor holds only for
// a sink in (0, 1], a finite pivot >= 0 and a finite eye. riseFromUniforms
// turns a negative or NaN pivot into 0 and drops a rise with no eye, and
// the shader would still lower those trees, by more than the box allows.
// A sink of 0 or less draws no rise.
const unknownRise = (u, rise) => {
  const v = u?.uLandRise?.value;
  if (!v || v.x <= 0) return false;
  return !(rise && v.x <= 1 && v.y >= 0 && v.y < Infinity && rise.eye.every(Number.isFinite));
};

/** The root lift { lo, hi, rise } and lean per metre of height every box
 *  takes under the forest uniforms `u`, with production safety; null when
 *  they cannot bound the trees (non-finite, or a rise the floor cannot
 *  bound). */
export function forestBounds(u) {
  const lift = liftBounds(u || {}), lean = forestLean(u) * MIRROR_BOUND_SAFETY;
  if (![lift.lo, lift.hi, lean].every(Number.isFinite) || unknownRise(u, lift.rise)) return null;
  return { lift, lean };
}

const BOX = new Float64Array(6);

/** True when any tree of `geometry` can reach the volume `planes` bound
 *  under the forest uniforms `u` (production safety and padding). True
 *  whenever the bound is unknown. */
export function forestGeometryVisible(geometry, planes, u) {
  const extents = assetExtents(geometry), cells = forestCells(geometry);
  if (!extents || !cells || !planes) return true;
  const bounds = forestBounds(u);
  if (!bounds) return true;
  const { lift, lean } = bounds;
  for (let o = 0; o < cells.length; o += 8) {
    const b = forestCellBox(cells, o, extents, lift, lean, CHUNK_BOX_PAD_M, BOX);
    if (!boxOutsidePlanes(planes, b[0], b[1], b[2], b[3], b[4], b[5])) return true;
  }
  return false;
}

// Twin spans (forestCull.spans, the tour layer's twins). A twin draws its
// first instanceCount trees in placement order, one instanced draw per
// pass, and its soft crowns blend in that order. A tree whose own box (the
// box above, over a cell of that one tree) is outside the drawn volume
// makes no fragment in this render. So a render may draw any contiguous
// span of the twin's trees that holds every tree whose box can reach the
// volume: the same draw, in the same order, of the same bytes, less trees
// that would have drawn nothing. WebGL2 has no base instance: the span's
// per-tree attributes read the twin's buffers from a byte offset
// (InterleavedBufferAttribute, stride = item size; ForestGL twinGeometry).

/** Tree tests one forestSpan may make before it settles for the cells'
 *  span (every tree of the first and last cells in view). */
export const SPAN_SCAN_MAX = 1024;
/** A span starts at a multiple of this many trees (the stride-1 Uint8 iTour
 *  view then starts on a 4-byte boundary). */
export const SPAN_ALIGN = 4;

const TREE = new Float64Array(8);
function treeOutside(pos, size, i, extents, lift, lean, planes) {
  const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), h = size.getX(i), w = size.getY(i);
  TREE[0] = TREE[3] = x; TREE[2] = TREE[5] = z;
  TREE[1] = y + Math.min(0, h); TREE[4] = y + Math.max(0, h); TREE[6] = Math.abs(h); TREE[7] = Math.abs(w);
  const b = forestCellBox(TREE, 0, extents, lift, lean, CHUNK_BOX_PAD_M, BOX);
  return boxOutsidePlanes(planes, b[0], b[1], b[2], b[3], b[4], b[5]);
}

// The last span per geometry and everything it was computed from.
const spanMemo = new WeakMap();
const KEY = new Float64Array(34);

/** The span [first, last] of the trees `geometry` draws (its prefix) that
 *  holds every tree whose box can reach the volume `planes` bound under
 *  the forest uniforms `u`: null when none can, the whole prefix when the
 *  bound is unknown. */
export function forestSpan(geometry, planes, u, { scan = SPAN_SCAN_MAX, memo = true } = {}) {
  const pos = geometry?.attributes?.iPos, size = geometry?.attributes?.iSize;
  const count = geometry?.instanceCount;
  const n = Math.min(pos?.count ?? 0, count > 0 ? Math.floor(count) : 0);
  if (!(n > 0)) return null;
  const whole = [0, n - 1];
  const extents = assetExtents(geometry), entry = forestCellsEntry(geometry), cells = entry?.cells;
  if (!extents || !cells || !planes) return whole;
  const bounds = forestBounds(u);
  if (!bounds) return whole;
  const { lift, lean } = bounds, rise = lift.rise;
  for (let i = 0; i < 24; i++) KEY[i] = planes[i];
  KEY[24] = lift.lo; KEY[25] = lift.hi; KEY[26] = lean; KEY[27] = scan;
  KEY[28] = rise ? rise.sink : NaN; KEY[29] = rise ? rise.pivot : NaN; KEY[30] = rise ? rise.knee : NaN;
  KEY[31] = rise ? rise.eye[0] : NaN; KEY[32] = rise ? rise.eye[1] : NaN; KEY[33] = rise ? rise.eye[2] : NaN;
  // Same cells (same trees, versions and count), same asset and the same
  // numbers: the same span. NaN marks no rise.
  const last = memo ? spanMemo.get(geometry) : null;
  if (last && last.cells === cells && last.extents === extents && last.n === n
    && KEY.every((v, i) => v === last.key[i] || (v !== v && last.key[i] !== last.key[i]))) return last.span;
  const span = computeSpan(entry, pos, size, extents, lift, lean, planes, scan, n);
  if (memo) spanMemo.set(geometry, { cells, extents, n, key: KEY.slice(), span });
  return span;
}

function computeSpan({ cells, trees }, pos, size, extents, lift, lean, planes, scan, n) {
  const seen = [];
  for (let o = 0, k = 0; o < cells.length; o += 8, k++) {
    const b = forestCellBox(cells, o, extents, lift, lean, CHUNK_BOX_PAD_M, BOX);
    if (!boxOutsidePlanes(planes, b[0], b[1], b[2], b[3], b[4], b[5])) seen.push(k);
  }
  if (!seen.length) return null;
  if (!trees) return [0, n - 1];
  const { start, index } = trees;
  // The cells' span: every tree of every cell in view lies inside it.
  let cellFirst = Infinity, cellLast = -1;
  for (const k of seen) {
    cellFirst = Math.min(cellFirst, index[start[k]]);
    cellLast = Math.max(cellLast, index[start[k + 1] - 1]);
  }
  let budget = scan, first = Infinity, lastTree = -1;
  // Earliest first: a cell whose first tree is past the best cannot better it.
  seen.sort((a, b) => index[start[a]] - index[start[b]]);
  for (const k of seen) {
    if (index[start[k]] >= first) break;
    for (let j = start[k]; j < start[k + 1] && index[j] < first; j++) {
      if (budget-- <= 0) return [cellFirst, cellLast];
      if (!treeOutside(pos, size, index[j], extents, lift, lean, planes)) { first = index[j]; break; }
    }
  }
  if (first === Infinity) return null;
  seen.sort((a, b) => index[start[b + 1] - 1] - index[start[a + 1] - 1]);
  for (const k of seen) {
    if (index[start[k + 1] - 1] <= lastTree) break;
    for (let j = start[k + 1] - 1; j >= start[k] && index[j] > lastTree; j--) {
      if (budget-- <= 0) return [cellFirst, cellLast];
      if (!treeOutside(pos, size, index[j], extents, lift, lean, planes)) { lastTree = index[j]; break; }
    }
  }
  return [first, lastTree];
}

// Span attribute sets by first tree, per buffer set (a twin's detail and
// lite share theirs): InterleavedBufferAttributes over the same buffers.
// A set is a new object per first tree: three rebinds a vertex array only
// when an attribute object changes (WebGLBindingStates needsUpdate), never
// for a changed offset.
const spanSets = new WeakMap();
const SPAN_SETS = 16;
function spanSet(geometry, first) {
  const key = geometry.attributes.iPos.data;
  let byFirst = spanSets.get(key);
  if (!byFirst) spanSets.set(key, byFirst = new Map());
  let set = byFirst.get(first);
  if (!set) {
    if (byFirst.size >= SPAN_SETS) byFirst.clear();
    set = [];
    for (const [name, a] of Object.entries(geometry.attributes)) {
      if (a.isInterleavedBufferAttribute && a.data.isInstancedInterleavedBuffer) set.push(name, new a.constructor(a.data, a.itemSize, first * a.data.stride, a.normalized));
    }
    byFirst.set(first, set);
  }
  return set;
}

/** Whether every per-tree attribute of `geometry` can start at an offset:
 *  iPos and each other instanced attribute either interleaved with a
 *  divisor of 1, offset 0 and stride = item size, or one value every
 *  instance reads. */
function spannable(geometry) {
  const pos = geometry.attributes.iPos;
  if (!pos?.isInterleavedBufferAttribute) return false;
  for (const a of Object.values(geometry.attributes)) {
    if (a.isInterleavedBufferAttribute) {
      if (a.data.isInstancedInterleavedBuffer && (a.data.meshPerAttribute !== 1 || a.offset !== 0 || a.data.stride !== a.itemSize || a.data.count !== pos.count)) return false;
    } else if (a.isInstancedBufferAttribute && !(a.count === 1 && a.meshPerAttribute >= pos.count)) return false;
  }
  return true;
}

// Scratch planes (renders do not nest) and a per-render serial so each
// geometry is tested once however many of its meshes the scene holds.
const PLANES = new Float64Array(24);
let serial = 0;
const IDENTITY = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };

/**
 * Cull the mesh-tree batches of `scene` for one render of `camera` into
 * `target`: a batch none of whose trees can reach the drawn volume gets
 * instanceCount 0. Each change is recorded in `touched` (geometry, count)
 * before it is made; restoreForestScene puts the counts back. `stats`
 * (optional) counts trees tested and kept.
 */
export function cullForestScene(scene, camera, target, stats = null, { renderer = null, touched = [] } = {}) {
  const stamp = ++serial;
  let planes = null;
  for (const mesh of scene.children) {
    const geometry = mesh.geometry, cull = geometry?.userData?.forestCull;
    if (!cull || !geometry.isInstancedBufferGeometry || cull.seen === stamp) continue;
    if (!mesh.visible || !camera.layers.test(mesh.layers)) continue;
    cull.seen = stamp;
    // The tree shaders ignore modelMatrix; keep it that way before culling.
    if (!mesh.matrixWorld.equals(IDENTITY)) continue;
    if (planes === null) planes = frustumPlanes(camera, target, PLANES, renderer) || false;
    if (!planes) return touched;
    const count = geometry.instanceCount;
    if (!(count > 0)) continue;
    if (cull.spans && spannable(geometry)) {
      const n = Math.min(geometry.attributes.iPos.count, Math.floor(count));
      let span = forestSpan(geometry, planes, cull.uniforms);
      if (span) {
        const first = span[0] - span[0] % SPAN_ALIGN, last = span[1];
        // three does not clamp a draw by attribute offset.
        span = first >= 0 && first <= last && last <= n - 1 ? [first, last] : [0, n - 1];
      }
      const drawn = span ? span[1] - span[0] + 1 : 0;
      if (stats) { stats.total += count; stats.kept += drawn; if (!span) stats.batches++; }
      if (span && span[0] === 0 && drawn === n) { cull.first = 0; continue; }
      // A culled twin keeps the set it last drew with, so its vertex arrays
      // stay as they are; the originals are the set of first tree 0.
      const first = span ? span[0] : cull.first || 0;
      const set = first > 0 ? spanSet(geometry, first) : null;
      let swaps = null;
      if (set) {
        swaps = [];
        for (let j = 0; j < set.length; j += 2) {
          swaps.push(set[j], geometry.attributes[set[j]], set[j + 1]);
          geometry.attributes[set[j]] = set[j + 1];
        }
      }
      touched.push(geometry, count, swaps);
      geometry.instanceCount = drawn;
      if (span) cull.first = first;
      continue;
    }
    const visible = forestGeometryVisible(geometry, planes, cull.uniforms);
    if (stats) { stats.total += count; if (visible) stats.kept += count; else stats.batches++; }
    if (visible) continue;
    touched.push(geometry, count, null);
    geometry.instanceCount = 0;
  }
  return touched;
}

export function restoreForestScene(touched) {
  for (let i = touched.length - 3; i >= 0; i -= 3) {
    const geometry = touched[i], swaps = touched[i + 2];
    // Only the per-tree attributes a span put in, and only while they are
    // still there: the lite twin's base attributes can change between a
    // render that threw and this restore (ForestGL setLiteAsset).
    if (swaps) for (let j = 0; j < swaps.length; j += 3) {
      if (geometry.attributes[swaps[j]] === swaps[j + 2]) geometry.attributes[swaps[j]] = swaps[j + 1];
    }
    geometry.instanceCount = touched[i + 1];
  }
  touched.length = 0;
}

// The counts attached scenes have set to 0 and not yet put back. Renders do
// not nest, so one list serves every scene.
const PENDING = [];

/** Put back every count an attached scene's render set to 0, including
 *  those a render that threw left behind. Call it before reading or setting
 *  a mesh-tree batch's instanceCount outside a render. */
export function restoreForestCulling() { restoreForestScene(PENDING); }

/**
 * Cull `scene`'s mesh-tree batches on every render, after whatever
 * onBeforeRender the scene already runs (TerrainChunks.attachTerrainCulling)
 * and restoring them before its onAfterRender. A render that throws leaves
 * its counts to the next culled render of any scene, or to
 * restoreForestCulling.
 */
export function attachForestCulling(scene, stats = null) {
  const before = scene.onBeforeRender, after = scene.onAfterRender;
  scene.onBeforeRender = function (renderer, s, camera, target, ...rest) {
    restoreForestCulling();
    before.call(this, renderer, s, camera, target, ...rest);
    cullForestScene(scene, camera, target, stats, { renderer, touched: PENDING });
  };
  scene.onAfterRender = function (...args) {
    restoreForestCulling();
    after.apply(this, args);
  };
  return scene;
}
