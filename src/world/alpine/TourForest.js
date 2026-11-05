// Range v2: which mesh-ring trees a static view's shot tour draws as meshes
// (tour forest windows). Pure: no three.js. ForestGL.js draws the result
// (createForest `tour`); RangeScene.js picks the state each frame.
//
// A two-camera static view places, for its tour, every tree within its own
// mesh ring of ANY point of the library's footprint (ForestCover.js). One
// song's tour only ever passes a small part of that footprint, so most of
// those trees are kilometres from wherever the camera is. Here the song's
// camera timeline is cut into TOUR_WINDOW_MS windows. A tree is a mesh
// while it is near the camera path of the current window; every other
// mesh-ring tree is drawn as the far ring's billboard.
//
// The rule (the universe U is every meshDetail and mesh record, in band-
// major order; rail-only rings are not part of it):
// - Window w's segments are the eye keys' Catmull-Rom segments from
//   40w - E to 40w + 39 + E (E = TOUR_FADE_MS / 2 / SHOT_KEY_MS keys), so
//   its span covers t in [4000w - 500, 4000(w + 1) + 500].
// - delta_w bounds how far the spline leaves each segment's chord (a
//   quarter of the larger tangent-minus-chord, crDeviation). P_w is the
//   window's keys simplified to within TOUR_TAU_M (Douglas-Peucker, 3-D).
// - A tree is in S_w when its root is nearer P_w than its own mesh ring
//   (reach) + TOUR_MARGIN_M + delta_w + TOUR_TAU_M + TOUR_EPS_M.
// - So a tree within its ring of any eye in the span is in S_w: the eye is
//   within delta of its chord, the chord within tau of P_w.
// - At each boundary 4000j the trees fade from S_(j-1) to S_j over
//   TOUR_FADE_MS, one tree at a time by a fixed hash of its id
//   (tourMeshVisible). A tree in both sets stays a mesh throughout, and in
//   the fade every tree within its ring of the eye is in both.
// - Guard: the drawn eye must lie within delta + tau + eps of P_A and P_B.
//   Otherwise (a camera that is not the timeline's poseAt) every tree is a
//   mesh: today's tour.
//
// The state is a pure function of the timeline's key bytes and the time:
// the window cache, its carry-over across replans and its LRU only save
// work.
import { FOREST_RINGS, LATTICE_M, forestRingScale } from './ForestCover.js';
import { familyFor, variantFor, FOREST_VARIANTS } from './ForestSpeciesAssets.js';
import { SHOT_KEY_MS } from '../terrain/ShotTimeline.js';

export const TOUR_WINDOW_MS = 4000;
/** Each boundary's dissolve; 0 switches at the boundary. */
export const TOUR_FADE_MS = 1000;
/** Metres beyond its ring a tree switches representation (M). */
export const TOUR_MARGIN_M = 50;
/** The simplified path's tolerance (tau). */
export const TOUR_TAU_M = 2;
/** Float32 eye and root rounding allowance (eps). */
export const TOUR_EPS_M = .25;
/** Root grid cell. */
export const TOUR_CELL_M = 256;
/** Window sets a schedule keeps. */
export const TOUR_CACHE_WINDOWS = 32;
/** A tree's dissolve key is fract(id * TOUR_KEY_SCALE). */
export const TOUR_KEY_SCALE = 4099;

const WINDOW_KEYS = TOUR_WINDOW_MS / SHOT_KEY_MS;
const EXTEND_KEYS = TOUR_FADE_MS / 2 / SHOT_KEY_MS;
const HALF_FADE_MS = TOUR_FADE_MS / 2;
const KINDS = ['meshDetail', 'mesh'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => globalThis.performance?.now?.() ?? Date.now();

/** A tree's dissolve key in [0, 1), as the tour shaders compute it from the
 *  Float32 id (fract(iVar.y * 4099.0)). */
export function tourKey(id) {
  const k = Math.fround(Math.fround(id) * TOUR_KEY_SCALE);
  return k - Math.floor(k);
}

/** Whether a tree with membership `bits` (1: in the outgoing window's set,
 *  2: in the incoming one's) and `id` is a mesh at fade `f` (0..1): the JS
 *  twin of ForestGL's tourMesh(). */
export function tourMeshVisible(bits, id, f) {
  const key = tourKey(id), fade = Math.fround(f), inA = (bits & 1) !== 0, inB = (bits & 2) !== 0;
  return inB ? (inA || key < fade) : (inA && key >= fade);
}

/** The forest batch group (species family x variant) of a record, as
 *  createForest groups its batches. */
export function forestGroupOf(species, id) {
  return familyFor(species) * FOREST_VARIANTS + variantFor(id);
}

/** Each U record's kind (0 meshDetail, 1 mesh), band and group, in U
 *  order: for each band, its meshDetail records then its mesh records, in
 *  placement order. `visit(kind, band, group, data, offset)` per record. */
function eachTourRecord(placed, visit) {
  const S = placed.stride;
  for (let b = 0; b < 3; b++) {
    for (let k = 0; k < KINDS.length; k++) {
      const data = placed[KINDS[k]];
      if (!data) continue;
      for (let o = 0; o < data.length; o += S) {
        if (data[o + 7] !== b) continue;
        visit(k, b, forestGroupOf(data[o + 5], data[o + 6]), data, o);
      }
    }
  }
}

/** How many records U holds. */
export function tourForestCount(placed) {
  if (!placed?.stride) return 0;
  return KINDS.reduce((n, k) => n + (placed[k]?.length || 0) / placed.stride, 0);
}

/** U's records as the tour layer keeps them: roots, sizes and vars
 *  (Float32, also the demote boards' instance attributes), each record's
 *  batch `batchId(kind, band, group)`, and where each band starts. */
export function tourUniverse(placed, batchId) {
  const N = tourForestCount(placed);
  const pos = new Float32Array(3 * N), size = new Float32Array(2 * N), vars = new Float32Array(2 * N), batchOf = new Uint8Array(N);
  const bandStart = new Int32Array(4);
  let u = 0;
  eachTourRecord(placed, (kind, band, group, d, o) => {
    pos[3 * u] = d[o]; pos[3 * u + 1] = d[o + 1]; pos[3 * u + 2] = d[o + 2];
    size[2 * u] = d[o + 3]; size[2 * u + 1] = d[o + 4];
    vars[2 * u] = d[o + 5]; vars[2 * u + 1] = d[o + 6];
    batchOf[u] = batchId(kind, band, group);
    bandStart[band + 1]++;
    u++;
  });
  for (let b = 1; b < 4; b++) bandStart[b] += bandStart[b - 1];
  return { pos, size, vars, batchOf, bandStart };
}

const gridSpan = (x0, x1) => Math.floor(x1 / TOUR_CELL_M) - Math.floor(x0 / TOUR_CELL_M) + 1;

/** The root grid's cell counts for roots spanning [x0, x1] x [z0, z1]. */
function gridShape(pos) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!(x1 >= x0) || !(z1 >= z0)) return { x0: 0, z0: 0, nx: 0, nz: 0 };
  return { x0: Math.floor(x0 / TOUR_CELL_M), z0: Math.floor(z0 / TOUR_CELL_M), nx: gridSpan(x0, x1), nz: gridSpan(z0, z1) };
}

/** Every bit of an N-tree set. */
function fullBits(N) {
  const words = Math.ceil(N / 32), bits = new Uint32Array(words).fill(0xffffffff), r = N & 31;
  if (r) bits[words - 1] = 2 ** r - 1;
  return bits;
}

/**
 * The tour layer's index over U (built once per forest; keeps the given
 * arrays, copies none): each tree's reach (its own mesh ring, recovered
 * from its lattice cell: frac(x / 13) lies in [.15, .85]), a CSR grid of
 * roots in TOUR_CELL_M cells, and ALL (every tree a mesh).
 */
export function tourForestIndex({ pos, size, vars, batchOf, bandStart, seed }) {
  const N = pos.length / 3, words = Math.ceil(N / 32);
  const reach = new Float32Array(N);
  let maxReach = 0;
  for (let u = 0; u < N; u++) {
    reach[u] = FOREST_RINGS.meshM * forestRingScale(Math.floor(pos[3 * u] / LATTICE_M), Math.floor(pos[3 * u + 2] / LATTICE_M), seed);
    if (reach[u] > maxReach) maxReach = reach[u];
  }
  const { x0, z0, nx, nz } = gridShape(pos);
  const start = new Uint32Array(nx * nz + 1), items = new Uint32Array(N);
  const cellOf = u => (Math.floor(pos[3 * u + 2] / TOUR_CELL_M) - z0) * nx + Math.floor(pos[3 * u] / TOUR_CELL_M) - x0;
  for (let u = 0; u < N; u++) start[cellOf(u) + 1]++;
  for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * nz);
  for (let u = 0; u < N; u++) items[fill[cellOf(u)]++] = u;
  const all = { w: -1, bits: fullBits(N), pts: null, guard: Infinity, deps: null, size: N };
  return { count: N, words, pos, size, vars, reach, batchOf, bandStart, seed, maxReach, all,
    grid: { x0, z0, nx, nz, start, items } };
}

/** Bound on how far `poseAt`'s Catmull-Rom curve leaves the chord of
 *  segment k (keys k to k + 1) of `count` keys: a quarter of the larger of
 *  |m1 - d| and |m2 - d|, with the end keys reflected as poseAt reflects
 *  them. */
export function crDeviation(eye, count, k) {
  let a = 0, b = 0;
  for (let c = 0; c < 3; c++) {
    const p1 = eye[3 * k + c], p2 = eye[3 * (k + 1) + c];
    const p0 = k > 0 ? eye[3 * (k - 1) + c] : 2 * p1 - p2;
    const p3 = k + 2 < count ? eye[3 * (k + 2) + c] : 2 * p2 - p1;
    const d = p2 - p1, m1 = (p2 - p0) / 2, m2 = (p3 - p1) / 2;
    a += (m1 - d) ** 2; b += (m2 - d) ** 2;
  }
  return Math.sqrt(Math.max(a, b)) / 4;
}

/** Squared distance from (x, y, z) to the segment of `pts` (xyz triples)
 *  from point i to point j. */
function segDist2(x, y, z, pts, i, j) {
  const ax = pts[3 * i], ay = pts[3 * i + 1], az = pts[3 * i + 2];
  const dx = pts[3 * j] - ax, dy = pts[3 * j + 1] - ay, dz = pts[3 * j + 2] - az;
  const px = x - ax, py = y - ay, pz = z - az, L = dx * dx + dy * dy + dz * dz;
  const t = L > 0 ? clamp((px * dx + py * dy + pz * dz) / L, 0, 1) : 0;
  return (px - t * dx) ** 2 + (py - t * dy) ** 2 + (pz - t * dz) ** 2;
}

/** Squared distance from (x, y, z) to the polyline `pts`. */
export function polylineDist2(x, y, z, pts) {
  const n = pts.length / 3;
  if (n === 1) return (x - pts[0]) ** 2 + (y - pts[1]) ** 2 + (z - pts[2]) ** 2;
  let best = Infinity;
  for (let i = 0; i + 1 < n; i++) best = Math.min(best, segDist2(x, y, z, pts, i, i + 1));
  return best;
}

/** Douglas-Peucker in 3-D, float64: the kept points of `pts` (xyz triples)
 *  such that every point lies within `tau` of the kept polyline. */
export function simplify3(pts, tau) {
  const n = pts.length / 3;
  if (n <= 2) return Float64Array.from(pts);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1], tau2 = tau * tau;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    let best = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], pts, a, b);
      if (d > best) { best = d; at = i; }
    }
    if (best > tau2) { keep[at] = 1; stack.push(a, at, at, b); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const out = new Float64Array(3 * m);
  for (let i = 0, k = 0; i < n; i++) if (keep[i]) { out[k++] = pts[3 * i]; out[k++] = pts[3 * i + 1]; out[k++] = pts[3 * i + 2]; }
  return out;
}

/** Windows of a timeline: floor(durationMs / TOUR_WINDOW_MS) + 1. */
export function tourWindowCount(tl) {
  return Math.floor((tl.durationMs || 0) / TOUR_WINDOW_MS) + 1;
}

/** Whether a timeline has the keys the rule reads. */
const keyed = tl => !!tl && tl.fov?.length > 0 && tl.eye?.length >= 3 * tl.fov.length && Number.isFinite(tl.durationMs);

/** Window w's segments [s0, s1] (keys s0 .. s1 + 1) of a timeline. */
export function tourWindowSegments(tl, w) {
  const count = tl.fov.length;
  const s1 = Math.min(count - 2, WINDOW_KEYS * w + WINDOW_KEYS - 1 + EXTEND_KEYS);
  const s0 = Math.max(0, Math.min(s1, WINDOW_KEYS * w - EXTEND_KEYS));
  return [s0, s1];
}

/**
 * Window w's set S_w of `index`'s trees for timeline `tl`, with its
 * simplified path (pts), guard radius and the keys it depends on (deps,
 * inclusive): a timeline whose keys are byte-equal there, with the same
 * duration and key count, has the same entry.
 */
export function windowSet(index, tl, w) {
  const count = tl.fov.length, eye = tl.eye;
  let pts, delta = 0, deps;
  if (count < 2) {
    pts = Float64Array.of(eye[0], eye[1], eye[2]);
    deps = [0, 0];
  } else {
    const [s0, s1] = tourWindowSegments(tl, w);
    for (let k = s0; k <= s1; k++) delta = Math.max(delta, crDeviation(eye, count, k));
    pts = simplify3(Float64Array.from(eye.subarray ? eye.subarray(3 * s0, 3 * (s1 + 2)) : eye.slice(3 * s0, 3 * (s1 + 2))), TOUR_TAU_M);
    deps = [Math.max(0, s0 - 1), Math.min(count - 1, s1 + 2)];
  }
  const extra = TOUR_MARGIN_M + delta + TOUR_TAU_M + TOUR_EPS_M, grow = index.maxReach + extra;
  const bits = new Uint32Array(index.words);
  const { pos, reach } = index, { x0, z0, nx, nz, start, items } = index.grid;
  const n = pts.length / 3;
  let size = 0;
  for (let i = 0; i < Math.max(1, n - 1); i++) {
    const j = n === 1 ? 0 : i + 1;
    const cx0 = Math.max(0, Math.floor((Math.min(pts[3 * i], pts[3 * j]) - grow) / TOUR_CELL_M) - x0);
    const cx1 = Math.min(nx - 1, Math.floor((Math.max(pts[3 * i], pts[3 * j]) + grow) / TOUR_CELL_M) - x0);
    const cz0 = Math.max(0, Math.floor((Math.min(pts[3 * i + 2], pts[3 * j + 2]) - grow) / TOUR_CELL_M) - z0);
    const cz1 = Math.min(nz - 1, Math.floor((Math.max(pts[3 * i + 2], pts[3 * j + 2]) + grow) / TOUR_CELL_M) - z0);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cz * nx + cx;
      for (let s = start[c]; s < start[c + 1]; s++) {
        const u = items[s], word = u >>> 5, m = 1 << (u & 31);
        if (bits[word] & m) continue;
        const th = reach[u] + extra;
        if (segDist2(pos[3 * u], pos[3 * u + 1], pos[3 * u + 2], pts, i, j) < th * th) { bits[word] |= m; size++; }
      }
    }
  }
  return { w, bits, pts, guard: delta + TOUR_TAU_M + TOUR_EPS_M, delta, deps, size };
}

/** Whether two timelines' eye keys are byte-equal over keys [a, b]. */
function sameKeys(e0, e1, [a, b]) {
  if (e0 instanceof Float32Array && e1 instanceof Float32Array) {
    const u0 = new Uint32Array(e0.buffer, e0.byteOffset, e0.length), u1 = new Uint32Array(e1.buffer, e1.byteOffset, e1.length);
    for (let i = 3 * a; i < 3 * b + 3; i++) if (u0[i] !== u1[i]) return false;
    return true;
  }
  for (let i = 3 * a; i < 3 * b + 3; i++) if (!Object.is(e0[i], e1[i])) return false;
  return true;
}

/**
 * Which window sets a tour draws at each time. Its states hold the window
 * entries themselves, so a consumer keys its work on their identity: a new
 * timeline's recomputed window is a new entry. The cache is an LRU of at
 * most `cacheWindows` entries that never evicts the current state's.
 */
export class TourForestSchedule {
  constructor(index, { cacheWindows = TOUR_CACHE_WINDOWS } = {}) {
    this.index = index;
    this.limit = Math.max(2, cacheWindows);
    this.tl = null;
    this.cache = new Map();
    this.all = { a: index.all, b: index.all, f: 1 };
    this.state = { a: index.all, b: index.all, f: 1 };
    this.computes = 0; this.syncComputes = 0; this.maxComputeMs = 0;
  }

  /** A new camera timeline (a replan, or null for none). Entries carry
   *  over only where the window's keys are byte-equal. */
  setTimeline(tl) {
    if (tl === this.tl) return;
    const old = this.tl, cache = this.cache;
    this.tl = tl || null;
    this.cache = new Map();
    this.state = { a: this.index.all, b: this.index.all, f: 1 };
    if (!keyed(old) || !keyed(tl) || old.durationMs !== tl.durationMs || old.fov.length !== tl.fov.length) return;
    for (const [w, e] of cache) if (sameKeys(old.eye, tl.eye, e.deps)) this.cache.set(w, e);
  }

  _entry(w, keep, sync) {
    let e = this.cache.get(w);
    if (e) { this.cache.delete(w); this.cache.set(w, e); return e; }
    const t0 = now();
    e = windowSet(this.index, this.tl, w);
    const ms = now() - t0;
    this.computes++;
    if (sync) this.syncComputes++;
    if (ms > this.maxComputeMs) this.maxComputeMs = ms;
    this.cache.set(w, e);
    for (const [k, old] of this.cache) {
      if (this.cache.size <= this.limit) break;
      if (old !== e && !keep.includes(old)) this.cache.delete(k);
    }
    return e;
  }

  /** The state at heard time `tMs`: { a, b, f } (a reused object). Missing
   *  windows are computed now. */
  stateAt(tMs) {
    const tl = this.tl, s = this.state;
    if (!keyed(tl)) { s.a = s.b = this.index.all; s.f = 1; return s; }
    const t = clamp(Number(tMs) || 0, 0, tl.durationMs), W = tourWindowCount(tl), j = Math.round(t / TOUR_WINDOW_MS);
    let wa, wb, f = 1;
    if (j >= 1 && j <= W - 1 && t >= TOUR_WINDOW_MS * j - HALF_FADE_MS && t < TOUR_WINDOW_MS * j + HALF_FADE_MS) {
      wa = j - 1; wb = j; f = (t - TOUR_WINDOW_MS * j + HALF_FADE_MS) / TOUR_FADE_MS;
    } else wa = wb = Math.min(W - 1, Math.floor(t / TOUR_WINDOW_MS));
    const keep = [this.cache.get(wa), this.cache.get(wb)];
    const a = this._entry(wa, keep, true);
    keep[0] = a;
    s.b = wb === wa ? a : this._entry(wb, keep, true);
    s.a = a; s.f = f;
    return s;
  }

  /** Whether the drawn eye lies within each of the state's windows' guard
   *  of its path. */
  covers(state, eye) {
    for (const e of [state.a, state.b]) {
      if (!e.pts) continue;
      if (!(polylineDist2(eye[0], eye[1], eye[2], e.pts) <= e.guard * e.guard)) return false;
    }
    return true;
  }

  /** Compute at most one missing window of the next two after `tMs`'s.
   *  True when it computed one. */
  prefetch(tMs) {
    const tl = this.tl;
    if (!keyed(tl)) return false;
    const t = clamp(Number(tMs) || 0, 0, tl.durationMs), W = tourWindowCount(tl), w = Math.min(W - 1, Math.floor(t / TOUR_WINDOW_MS));
    const keep = [this.state.a, this.state.b];
    // A full cache of the current state's windows has no room to fill.
    if (this.cache.size >= this.limit && [...this.cache.values()].every(e => keep.includes(e))) return false;
    for (const n of [w + 1, w + 2]) {
      if (n >= W || this.cache.has(n)) continue;
      this._entry(n, keep, false);
      return true;
    }
    return false;
  }
}

/**
 * What the tour layer of `placed` holds, exactly (0 without one): U's
 * records on the CPU and the GPU (also the demote boards' buffers), the
 * twins' CPU staging and GPU copies, the twins' and boards' membership
 * flags (both copies), reach, batch ids, the grid, the detail twins'
 * weight scalars, ALL, and an LRU of TOUR_CACHE_WINDOWS sets.
 */
export function tourForestBytes(placed) {
  const N = placed?.railCount ? tourForestCount(placed) : 0;
  if (!N) return 0;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const pairs = new Set();
  eachTourRecord(placed, (kind, band, group, d, o) => {
    const x = d[o], z = d[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    if (kind === 0) pairs.add(band * 64 + group);
  });
  const cells = x1 >= x0 && z1 >= z0 ? gridSpan(x0, x1) * gridSpan(z0, z1) : 0;
  const words = Math.ceil(N / 32);
  const perTree = 2 * 28 + 2 * 28 + 2 * 2 + 4 + 1 + 4;
  return N * perTree + 4 * (cells + 1) + pairs.size * 2 * 2 * 4 + 4 * words * (1 + TOUR_CACHE_WINDOWS);
}
