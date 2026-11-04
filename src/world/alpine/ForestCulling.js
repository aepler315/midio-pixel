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
// updateDetailView, RangeScene._setTerrainMode).
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
 *  or an id outside [0, 1]). */
export function forestCells(geometry) {
  const pos = geometry?.attributes?.iPos, size = geometry?.attributes?.iSize, vars = geometry?.attributes?.iVar;
  if (!pos || !size || !vars || size.count < pos.count || vars.count < pos.count) return null;
  const cached = cellsCache.get(pos);
  if (cached && cached.size === size && cached.vars === vars) return cached.cells;
  const cells = new Map();
  let ok = true;
  for (let i = 0; i < pos.count && ok; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), h = size.getX(i), w = size.getY(i), id = vars.getY(i);
    if (![x, y, z, h, w].every(Number.isFinite) || !(id >= 0 && id <= 1)) { ok = false; break; }
    const key = `${Math.floor(x / FOREST_CULL_CELL_M)},${Math.floor(z / FOREST_CULL_CELL_M)}`;
    const bottom = y + Math.min(0, h), top = y + Math.max(0, h), height = Math.abs(h), width = Math.abs(w);
    const c = cells.get(key);
    if (!c) cells.set(key, [x, bottom, z, x, top, z, height, width]);
    else {
      if (x < c[0]) c[0] = x; if (bottom < c[1]) c[1] = bottom; if (z < c[2]) c[2] = z;
      if (x > c[3]) c[3] = x; if (top > c[4]) c[4] = top; if (z > c[5]) c[5] = z;
      if (height > c[6]) c[6] = height; if (width > c[7]) c[7] = width;
    }
  }
  const out = ok ? Float64Array.from([...cells.values()].flat()) : null;
  cellsCache.set(pos, { size, vars, cells: out });
  return out;
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
    const visible = forestGeometryVisible(geometry, planes, cull.uniforms);
    if (stats) { stats.total += count; if (visible) stats.kept += count; else stats.batches++; }
    if (visible) continue;
    touched.push(geometry, count);
    geometry.instanceCount = 0;
  }
  return touched;
}

export function restoreForestScene(touched) {
  for (let i = touched.length - 2; i >= 0; i -= 2) touched[i].instanceCount = touched[i + 1];
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
