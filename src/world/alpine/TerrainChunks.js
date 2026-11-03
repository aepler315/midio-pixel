// Frustum culling for the merged terrain bands, in their own draw order.
//
// Each depth band merges its tiles into one geometry (TerrainMesh.js) and is
// drawn with frustumCulled = false: the land moves vertically every frame
// (TerrainDeform.js), and three.js would cull the whole band as one object.
// Splitting a band into separate meshes is not an option either: three.js
// sorts opaque meshes of one material by distance, and drawing the same
// triangles in another order can flip a pixel wherever two of them meet at
// equal depth (seams, T-junctions between tile strides).
//
// So a band stays one mesh and one render-list item. Its geometry carries a
// chunk table: each tile's index range, which is contiguous in the band
// index, and its box. Three.js calls Scene.onBeforeRender before it culls
// or sorts anything; there the draw groups of every chunked geometry in the
// scene are set to the runs of chunks whose boxes, lifted by this frame's
// largest vertical displacement (MirrorScissor.liftBounds), reach the
// camera's frustum, narrowed to the target's scissor rectangle. The runs are
// in index order, so every drawn triangle keeps its place in the sequence;
// a culled chunk lies wholly outside a clip plane and could not have made a
// fragment. The picture is unchanged. Scene.onAfterRender puts the groups
// back to the whole index, so a render that does not cull draws everything.
//
// Three.js honours draw groups only for a mesh whose material is an array:
// chunked meshes hold [material] (setTerrainMaterial swaps it).

/** Culled index ranges shorter than this are drawn through instead of
 *  costing a draw call of their own (about 2,000 triangles). */
export const CHUNK_MERGE_INDICES = 6144;
/** At most this many draws per geometry and render: past it, the smallest
 *  culled gaps are drawn through. */
export const CHUNK_MAX_RUNS = 8;
/** Metres added around every chunk box (float rounding of the GPU's
 *  projection against this test's doubles). */
export const CHUNK_BOX_PAD_M = 1;
/** Pixels added around a scissor rectangle before it narrows the frustum. */
export const CHUNK_SCISSOR_MARGIN_PX = 1;

const WHOLE = Object.freeze({ start: 0, count: Infinity, materialIndex: 0 });

/**
 * A chunk table from per-chunk index ranges and boxes, in index order:
 * `start`/`count` (indices) and `box` (minX, minY, minZ, maxX, maxY, maxZ
 * per chunk, metres, before any lift). Chunks must tile the index: each
 * starts where the previous one ends.
 */
export function chunkTable(start, count, box) {
  const n = start.length;
  if (count.length !== n || box.length !== 6 * n) throw new Error('chunk table arrays disagree');
  for (let i = 1; i < n; i++) if (start[i] !== start[i - 1] + count[i - 1]) throw new Error('chunks must be contiguous and in order');
  return { start, count, box, length: n, indices: n ? start[n - 1] + count[n - 1] - start[0] : 0 };
}

/** The same chunks over an in-order subset of the index that kept
 *  `kept[i]` indices of chunk i (WaterSubset.js), with the same boxes. */
export function subsetChunkTable(table, kept) {
  const n = table.length, start = new Uint32Array(n), count = new Uint32Array(n);
  let o = 0;
  for (let i = 0; i < n; i++) { start[i] = o; count[i] = kept[i]; o += kept[i]; }
  return chunkTable(start, count, table.box);
}

/** Give `geometry` its chunk table (or none) and the whole-index group a
 *  [material] mesh needs to draw anything. */
export function setChunks(geometry, table = null) {
  geometry.userData.terrainChunks = table || null;
  geometry.groups = [{ ...WHOLE }];
  return geometry;
}

/** Put `material` on a terrain mesh, keeping its array form when it has one. */
export function setTerrainMaterial(mesh, material) {
  mesh.material = Array.isArray(mesh.material) ? [material] : material;
}

/** The one material of a terrain mesh, array form or not. */
export function terrainMaterial(mesh) {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

/**
 * World-space planes (a, b, c, d per plane; inside when a x + b y + c z + d
 * >= 0) of what `camera` draws into `target`: its frustum, its sides moved
 * in to the target's scissor rectangle when the scissor test is on. Null
 * when the matrices are unusable.
 */
export function frustumPlanes(camera, target = null, out = new Float64Array(24)) {
  const p = camera.projectionMatrix.elements, v = camera.matrixWorldInverse.elements;
  // Column-major M = P * V; row r of M is (m[r], m[4 + r], m[8 + r], m[12 + r]).
  const m = out.m || (out.m = new Float64Array(16));
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    m[c * 4 + r] = p[r] * v[c * 4] + p[4 + r] * v[c * 4 + 1] + p[8 + r] * v[c * 4 + 2] + p[12 + r] * v[c * 4 + 3];
  }
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return null;
  // NDC bounds of the drawn rectangle.
  let x0 = -1, x1 = 1, y0 = -1, y1 = 1;
  if (target?.scissorTest && target.scissor && target.viewport && target.viewport.z > 0 && target.viewport.w > 0) {
    const vp = target.viewport, s = target.scissor, k = CHUNK_SCISSOR_MARGIN_PX;
    x0 = Math.max(-1, (s.x - k - vp.x) / vp.z * 2 - 1); x1 = Math.min(1, (s.x + s.z + k - vp.x) / vp.z * 2 - 1);
    y0 = Math.max(-1, (s.y - k - vp.y) / vp.w * 2 - 1); y1 = Math.min(1, (s.y + s.w + k - vp.y) / vp.w * 2 - 1);
  }
  const row = (r, i) => m[i * 4 + r];
  const set = (k, f) => { for (let i = 0; i < 4; i++) out[k * 4 + i] = f(i); };
  set(0, i => row(0, i) - x0 * row(3, i)); // x >= x0 w
  set(1, i => x1 * row(3, i) - row(0, i)); // x <= x1 w
  set(2, i => row(1, i) - y0 * row(3, i));
  set(3, i => y1 * row(3, i) - row(1, i));
  // WebGL clip depth: -w <= z <= w.
  set(4, i => row(2, i) + row(3, i));
  set(5, i => row(3, i) - row(2, i));
  return out;
}

/** True when the box (min/max, metres) lies wholly outside one plane. */
function outside(planes, x0, y0, z0, x1, y1, z1) {
  for (let k = 0; k < 24; k += 4) {
    const a = planes[k], b = planes[k + 1], c = planes[k + 2], d = planes[k + 3];
    // The corner farthest along the plane's normal.
    if (a * (a >= 0 ? x1 : x0) + b * (b >= 0 ? y1 : y0) + c * (c >= 0 ? z1 : z0) + d < 0) return true;
  }
  return false;
}

/**
 * Draw groups (index ranges, in order) covering every chunk of `table` that
 * can reach the volume `planes` bound, its boxes lifted by `lift` ({ lo, hi },
 * metres added to min/max y). Gaps under `mergeIndices` are drawn through,
 * and at most `maxRuns` groups are returned (the smallest gaps merge first).
 * `stats` (optional) counts indices kept and culled.
 */
export function visibleGroups(table, planes, lift, { mergeIndices = CHUNK_MERGE_INDICES, maxRuns = CHUNK_MAX_RUNS, stats = null } = {}) {
  const { start, count, box, length: n } = table;
  const lo = Number.isFinite(lift?.lo) ? Math.min(0, lift.lo) : -Infinity, hi = Number.isFinite(lift?.hi) ? Math.max(0, lift.hi) : Infinity;
  const pad = CHUNK_BOX_PAD_M;
  const runs = [];
  let open = null;
  for (let i = 0; i < n; i++) {
    if (!count[i]) continue;
    const o = i * 6;
    const keep = !outside(planes, box[o] - pad, box[o + 1] + lo - pad, box[o + 2] - pad, box[o + 3] + pad, box[o + 4] + hi + pad, box[o + 5] + pad);
    if (!keep) { open = null; continue; }
    if (open && open.end === start[i]) open.end = start[i] + count[i];
    else runs.push(open = { start: start[i], end: start[i] + count[i] });
  }
  // Draw through short gaps, then the smallest ones until few enough draws.
  for (let i = runs.length - 1; i > 0; i--) {
    if (runs[i].start - runs[i - 1].end < mergeIndices) { runs[i - 1].end = runs[i].end; runs.splice(i, 1); }
  }
  while (runs.length > Math.max(1, maxRuns)) {
    let best = 1;
    for (let i = 2; i < runs.length; i++) if (runs[i].start - runs[i - 1].end < runs[best].start - runs[best - 1].end) best = i;
    runs[best - 1].end = runs[best].end; runs.splice(best, 1);
  }
  if (stats) {
    let kept = 0;
    for (const r of runs) kept += r.end - r.start;
    stats.kept += kept; stats.total += table.indices; stats.draws += runs.length;
  }
  return runs.map(r => ({ start: r.start, count: r.end - r.start, materialIndex: 0 }));
}

/**
 * Cull every chunked terrain mesh of `scene` for one render of `camera`
 * into `target` (Scene.onBeforeRender), returning the geometries changed;
 * restoreTerrainScene puts them back. `lift` is this frame's vertical
 * displacement bound. Meshes on no layer the camera draws are left alone.
 */
export function cullTerrainScene(scene, camera, target, lift, stats = null) {
  const touched = [];
  let planes = null;
  for (const mesh of scene.children) {
    const geometry = mesh.geometry, table = geometry?.userData?.terrainChunks;
    if (!table || !mesh.visible || !Array.isArray(mesh.material) || !camera.layers.test(mesh.layers)) continue;
    if (!mesh.matrixWorld.equals(IDENTITY)) continue; // the boxes are in mesh space
    if (planes === null) planes = frustumPlanes(camera, target) || false;
    if (!planes) return touched;
    geometry.groups = visibleGroups(table, planes, lift, { stats });
    touched.push(geometry);
  }
  return touched;
}

export function restoreTerrainScene(touched) {
  for (const geometry of touched) geometry.groups = [{ ...WHOLE }];
}

// A plain identity matrix (no three.js import here): Matrix4.equals reads
// .elements.
const IDENTITY = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };

/**
 * Cull `scene`'s chunked terrain on every render (three.js calls
 * onBeforeRender before culling and sorting, onAfterRender at the end).
 * `lift()` returns the frame's vertical displacement bound; `stats` collects
 * indices kept and culled.
 */
export function attachTerrainCulling(scene, lift, stats = null) {
  let touched = [];
  scene.onBeforeRender = (renderer, s, camera, target) => {
    restoreTerrainScene(touched);
    touched = cullTerrainScene(scene, camera, target, lift(), stats);
  };
  scene.onAfterRender = () => { restoreTerrainScene(touched); touched = []; };
  return scene;
}
