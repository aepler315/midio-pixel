// Range v2 forest placement (plan §3.4 forest row, Task 10). Pure and
// engine-agnostic: which trees stand where, as stable instances attached
// to the terrain surface. ForestGL.js turns the result into GPU instances.
//
// Stability: trees sit on a fixed metric lattice (LATTICE_M cells in local
// X/Z), one candidate per cell, jittered and sized by a hash of the cell
// itself. The same cell always yields the same tree, whatever the quality,
// camera position or seek time. Reducing density drops a stable subset
// (by each tree's own hash); it never regenerates the forest.
//
// Eligibility follows the same terrain rules the terrain shader uses for
// forest (material rules: treeline, max forest slope, density; no trees on
// hydro-flattened water or above the treeline), evaluated from the
// package's own heights. These are derived habitat masks, not measured
// land cover.
import { terrainHeightAt } from './TerrainMesh.js';
import { RULE_DEFAULTS } from './MaterialPackage.js';
import { scenePoseAt, pathStations } from '../terrain/SceneTravel.js';

export const LATTICE_M = 13;
export const FOREST_RINGS = Object.freeze({ detailM: 450, meshM: 1200, billboardM: 8000 });

/** Deterministic 32-bit hash of two integers and a salt. */
export function hash2(ix, iz, salt = 0) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
// Unsigned operations are bit-exact even for negative cells and wrapped salts.
export const FOREST_HASH_GLSL = /* glsl */`
  uint hash2u(int ix, int iz, uint salt) {
    uint h = (uint(ix) * 0x27d4eb2du) ^ (uint(iz) * 0x165667b1u) ^ (salt * 0x9e3779b9u);
    h = (h ^ (h >> 15u)) * 0x85ebca6bu;
    h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
    return h ^ (h >> 16u);
  }
  float forestU01(uint h) { return float(h) / 4294967296.0; }
`;

// Trait salts and species thresholds mirror treeTraits; eligibility is separate.
export const FOREST_TRAITS_GLSL = /* glsl */`
  struct ForestTraits { vec2 root; float height; float width; float species; float id; };
  ForestTraits forestTreeTraits(ivec2 cell, uint seed, float y, float slope, float treeline, float scale, float cap) {
    uint h1=hash2u(cell.x,cell.y,seed+1u), h2=hash2u(cell.x,cell.y,seed+2u), h3=hash2u(cell.x,cell.y,seed+3u);
    vec2 root=(vec2(cell)+.15+.7*vec2(forestU01(h1),forestU01(h2)))*13.;
    ivec2 stand=ivec2(floor(root/90.));
    float edge=treeline+(forestU01(hash2u(stand.x,stand.y,seed+9u))-.5)*220.;
    float below=edge-y, pick=forestU01(hash2u(cell.x,cell.y,seed+5u));
    float species=below>900. ? (pick<.5?0.:pick<.8?3.:1.)
      :below>300. ? (pick<.45?1.:pick<.8?2.:0.) : (pick<.7?2.:1.);
    float vigor=min(1.,max(.35,below/400.))*(1.-.3*max(0.,slope-25.)/25.);
    vec4 size=species<.5?vec4(14.,26.,.24,.32):species<1.5?vec4(18.,32.,.32,.40)
      :species<2.5?vec4(12.,24.,.22,.28):vec4(18.,30.,.36,.44);
    float authored=(vigor<.55?2.+4.*forestU01(h3):mix(size.x,size.y,forestU01(h3))*vigor)*scale;
    float height=min(cap,authored), ratio=vigor<.55?mix(.7,1.,forestU01(h1^h2)):mix(size.z,size.w,forestU01(h1^h2));
    return ForestTraits(root,height,height*ratio,species,forestU01(hash2u(cell.x,cell.y,seed+4u)));
  }
`;

const u01 = (h) => h / 4294967296;

// Species: lodgepole, Engelmann spruce, subalpine fir, Douglas fir.
const SPECIES_SIZE = [[14, 26, .24, .32], [18, 32, .32, .40], [12, 24, .22, .28], [18, 30, .36, .44]];

function treeEdge(x, z, seed, treeline) {
  return treeline + (u01(hash2(Math.floor(x / 90), Math.floor(z / 90), seed + 9)) - .5) * 220;
}

/** Stable cell traits; eligibility and rail/ring selection remain placement's job.
 *  Keep these hashes and the elevation rules in sync with the Phase 5 GLSL twin. */
export function treeTraits(ix, iz, seed, yRoot, slopeDeg, rules, view) {
  const h1 = hash2(ix, iz, seed + 1), h2 = hash2(ix, iz, seed + 2), h3 = hash2(ix, iz, seed + 3);
  const x = (ix + .15 + .7 * u01(h1)) * LATTICE_M, z = (iz + .15 + .7 * u01(h2)) * LATTICE_M;
  const below = treeEdge(x, z, seed, rules.treelineM) - yRoot;
  const pick = u01(hash2(ix, iz, seed + 5));
  const species = below > 900 ? (pick < .5 ? 0 : pick < .8 ? 3 : 1)
    : below > 300 ? (pick < .45 ? 1 : pick < .8 ? 2 : 0) : (pick < .7 ? 2 : 1);
  const vigor = Math.min(1, Math.max(.35, below / 400)) * (1 - .3 * Math.max(0, slopeDeg - 25) / 25);
  const scale = rules.treeScale ?? RULE_DEFAULTS.treeScale;
  const [lo, hi, narrow, wide] = SPECIES_SIZE[species];
  // Low-vigor stems form mats; scale applies once to both upright and mat trees.
  const authoredHeight = (vigor < .55 ? 2 + 4 * u01(h3) : (lo + (hi - lo) * u01(h3)) * vigor) * scale;
  const height = view.tour ? Math.min(35, authoredHeight) : authoredHeight;
  const ratio = vigor < .55 ? .7 + .3 * u01((h1 ^ h2) >>> 0) : narrow + (wide - narrow) * u01((h1 ^ h2) >>> 0);
  return { x, z, height, width: height * ratio, species, id: u01(hash2(ix, iz, seed + 4)) };
}

/** Fraction of trees kept at a PerfGovernor rung (stable subset). Rung 2
 *  first draws the detail ring with the lighter mesh asset (RangeQuality
 *  nearDetail), so the forest keeps its mass one rung longer; thinning starts
 *  at rung 3 and keeps more of the forest at the bottom of the ladder. */
export function forestKeepFraction(quality = 0) {
  return [1, 1, 1, 0.85, 0.7, 0.55, 0.45][Math.max(0, Math.min(6, quality | 0))];
}

/** Terrain slope in degrees at (x, z) from central differences. */
function slopeDegAt(data, x, z, d) {
  const hx0 = terrainHeightAt(data, x - d, z), hx1 = terrainHeightAt(data, x + d, z);
  const hz0 = terrainHeightAt(data, x, z - d), hz1 = terrainHeightAt(data, x, z + d);
  if (![hx0, hx1, hz0, hz1].every(Number.isFinite)) return NaN;
  const gx = (hx1 - hx0) / (2 * d), gz = (hz1 - hz0) / (2 * d);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

/** Whether the package marks (x, z) as hydro-flattened water: true when
 *  any of the four samples around the point is water, because the terrain
 *  shader reads the flow byte bilinearly (a root between a water sample and
 *  a shore sample would stand in the water's fringe). */
function isWater(data, x, z) {
  const { grid, cells } = data;
  const gx = (x - grid.originM[0]) / grid.cellSizeM, gz = (z - grid.originM[1]) / grid.cellSizeM;
  const tile = data.byIndex.get(`${Math.floor(gx / cells)},${Math.floor(gz / cells)}`);
  if (!tile) return false;
  const fu = (gx - tile.ix * cells) / tile.stride, fv = (gz - tile.iz * cells) / tile.stride;
  const last = tile.samples - 1;
  for (const v of [Math.floor(fv), Math.ceil(fv)]) {
    for (const u of [Math.floor(fu), Math.ceil(fu)]) {
      if (tile.flowBytes[Math.min(last, v) * tile.samples + Math.min(last, u)] === 255) return true;
    }
  }
  return false;
}

/** Closest distance from (x, y, z) to the rail's eye segment. */
function railDistance(a, b, p) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  let t = len2 > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}

/** Conservative distance to the authored eye path. For a quadratic rail,
 * each of 32 chords deviates by at most |arc|/32² metres; subtracting that
 * bound keeps stands at a ring's edge while retaining straight-rail parity. */
function forestRail(view) {
  if(view.tour){
    const start=view.tourWindowStartMs||0,end=Math.min(view.tour.durationMs,start+8000);
    const poses=pathStations({tour:{durationMs:end-start,poseAt:t=>view.tour.poseAt(start+t)}},17).map(p=>p.eyeM);
    return p=>Math.min(...poses.slice(1).map((b,i)=>railDistance(poses[i],b,p)));
  }
  const arc = view.camera.eyeArcM;
  const steps = arc && Math.hypot(...arc) > 0 ? 32 : 1;
  const poses = Array.from({ length: steps + 1 }, (_, i) => scenePoseAt(view, { progress01: i / steps }).eyeM);
  if (steps === 1) return p => railDistance(poses[0], poses[1], p);
  const segments = poses.slice(1).map((b, i) => {
    const a = poses[i], d = b.map((v, k) => v - a[k]);
    return { a, d, length2: d.reduce((sum, v) => sum + v * v, 0) };
  });
  const error = steps > 1 ? Math.hypot(...arc) / (steps * steps) : 0;
  return p => {
    let best2 = Infinity;
    for (const { a, d, length2 } of segments) {
      const x = p[0] - a[0], y = p[1] - a[1], z = p[2] - a[2];
      const t = length2 > 0 ? Math.max(0, Math.min(1, (x * d[0] + y * d[1] + z * d[2]) / length2)) : 0;
      best2 = Math.min(best2, (x - t * d[0]) ** 2 + (y - t * d[1]) ** 2 + (z - t * d[2]) ** 2);
    }
    return Math.max(0, Math.sqrt(best2) - error);
  };
}

/** Upper bound from the same tile/ring cull and lattice limits as placement.
 * No typed chunks are allocated here. Density and per-tree habitat tests can
 * only reduce this count. Three partly filled 64K-float chunks are included. */
export function forestPlacementBound(data, view, rules, rings = FOREST_RINGS) {
  const distanceToRail = forestRail(view);
  const size = data.cells * data.grid.cellSizeM;
  let count = 0;
  for (const tile of data.tiles.values()) {
    if (!tile.visible || tile.minY > rules.treelineM + 300) continue;
    const x0 = data.grid.originM[0] + tile.ix * size, z0 = data.grid.originM[1] + tile.iz * size;
    if (distanceToRail([x0 + size / 2, (tile.minY + tile.maxY) / 2, z0 + size / 2]) - Math.SQRT2 * size / 2 > rings.billboardM) continue;
    count += (Math.ceil((x0 + size) / LATTICE_M) - Math.ceil(x0 / LATTICE_M))
      * (Math.ceil((z0 + size) / LATTICE_M) - Math.ceil(z0 / LATTICE_M));
  }
  return { count, placementBytes: count * 64 + 3 * (1 << 16) * 4 };
}

/**
 * Place the view's trees.
 *   data    decoded terrain (TerrainMesh.decodeTerrain)
 *   view    SceneView (camera rail)
 *   rules   material rules (+ view overrides)
 *   options { seed, rings, bands: { nearM, midM } }
 * Returns { meshDetail, mesh, billboard: Float32Array, stride, count }.
 * Each instance: x, yRoot, z, height, width, variant, id01, bandIndex
 * (0 far, 1 mid, 2 near -- the terrain band that owns its root).
 */
export function placeForest(data, view, rules, options = {}) {
  const steps = placeForestSteps(data, view, rules, options);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/** placeForest that yields to the event loop every `sliceMs` of work, so a
 *  view prepared during playback never blocks a frame for long. Same
 *  result as placeForest. */
export async function placeForestAsync(data, view, rules, { sliceMs = 8, yieldTo = defaultYield, signal = null, ...options } = {}) {
  const steps = placeForestSteps(data, view, rules, options);
  let t0 = performance.now();
  let r = steps.next();
  while (!r.done) {
    if (performance.now() - t0 > sliceMs) {
      await yieldTo();
      if (signal?.aborted) throw new Error('aborted');
      t0 = performance.now();
    }
    r = steps.next();
  }
  return r.value;
}

function defaultYield() {
  return new Promise((res) => (globalThis.scheduler?.yield ? globalThis.scheduler.yield().then(res) : setTimeout(res, 0)));
}

/** The placement, one tile per step (a generator returning the result). */
function* placeForestSteps(data, view, rules, { seed = 0, rings = FOREST_RINGS, bands = null } = {}) {
  const STRIDE = 8;
  const distanceToRail = forestRail(view);
  const b = bands || data.manifest.bands || { nearM: 1800, midM: 7000 };
  const treeline = rules.treelineM, maxSlope = rules.forestMaxSlopeDeg, density = rules.forestDensity;
  const floor = rules.forestFloorM ?? RULE_DEFAULTS.forestFloorM;
  // Typed chunks, not growing JS arrays: a 300k-tree view would otherwise
  // reallocate and copy millions of elements in single long pauses.
  const detail = new FloatChunks(), mesh = new FloatChunks(), board = new FloatChunks();
  const cells = data.cells, cs = data.grid.cellSizeM;
  for (const tile of data.tiles.values()) {
    if (!tile.visible || tile.minY > treeline + 300) continue;
    const x0 = data.grid.originM[0] + tile.ix * cells * cs, z0 = data.grid.originM[1] + tile.iz * cells * cs;
    const x1 = x0 + cells * cs, z1 = z0 + cells * cs;
    // Tile-level ring cull before visiting its lattice cells.
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const tileDist = distanceToRail([cx, (tile.minY + tile.maxY) / 2, cz]) - Math.hypot(x1 - x0, z1 - z0) / 2;
    if (tileDist > rings.billboardM) continue;
    for (let iz = Math.ceil(z0 / LATTICE_M); iz * LATTICE_M < z1; iz++) {
      for (let ix = Math.ceil(x0 / LATTICE_M); ix * LATTICE_M < x1; ix++) {
        const h0 = hash2(ix, iz, seed);
        if (u01(h0) > density) continue;
        const h1 = hash2(ix, iz, seed + 1), h2 = hash2(ix, iz, seed + 2), h3 = hash2(ix, iz, seed + 3);
        const x = (ix + 0.15 + 0.7 * u01(h1)) * LATTICE_M, z = (iz + 0.15 + 0.7 * u01(h2)) * LATTICE_M;
        const y = terrainHeightAt(data, x, z);
        if (!Number.isFinite(y)) continue;
        // Treeline with a stand-scale breakup, as the shader does.
        const edge = treeEdge(x, z, seed, treeline);
        if (y > edge) continue;
        // Lower forest limit (dry valley floors), with the same breakup.
        const breakup = u01(hash2(Math.floor(x / 90), Math.floor(z / 90), seed + 10)) - 0.5;
        if (y < floor + breakup * 200) continue;
        const slope = slopeDegAt(data, x, z, cs);
        if (!(slope <= maxSlope + (u01(h3) - 0.5) * 6)) continue;
        if (isWater(data, x, z)) continue;
        const d = distanceToRail([x, y, z]);
        if (d > rings.billboardM) continue;
        const traits = treeTraits(ix, iz, seed, y, slope, rules, view);
        const band = d < b.nearM ? 2 : d < b.midM ? 1 : 0;
        const rec = [traits.x, y, traits.z, traits.height, traits.width, traits.species, traits.id, band];
        (d < Math.min(rings.meshM, rings.detailM ?? FOREST_RINGS.detailM) ? detail : d < rings.meshM ? mesh : board).push(...rec);
      }
      // One lattice row per step: a 64-cell tile holds ~100 rows of ~100
      // candidates, so a whole tile between yields could run for 100 ms.
      yield;
    }
  }
  return { meshDetail: detail.toArray(), mesh: mesh.toArray(), billboard: board.toArray(), stride: STRIDE,
    count: (detail.length + mesh.length + board.length) / STRIDE };
}

/** Append-only float storage in fixed typed chunks. */
class FloatChunks {
  constructor(size = 1 << 16) { this.size = size; this.chunks = [new Float32Array(size)]; this.fill = 0; this.length = 0; }
  push(...values) {
    for (const v of values) {
      if (this.fill === this.size) { this.chunks.push(new Float32Array(this.size)); this.fill = 0; }
      this.chunks[this.chunks.length - 1][this.fill++] = v;
      this.length++;
    }
  }
  toArray() {
    const out = new Float32Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      const n = Math.min(c.length, this.length - at);
      out.set(n === c.length ? c : c.subarray(0, n), at);
      at += n;
    }
    return out;
  }
}

/** Indices (into an instance array) kept at a quality rung: a stable
 *  subset by each tree's own id hash (column 6). */
export function keptInstances(instances, stride, quality) {
  const keep = forestKeepFraction(quality);
  const out = [];
  for (let i = 0; i < instances.length / stride; i++) if (instances[i * stride + 6] < keep) out.push(i);
  return out;
}
