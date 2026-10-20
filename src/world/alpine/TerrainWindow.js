import { cameraBasis } from '../terrain/SceneTravel.js';
import { STRIDES } from './TerrainPackage.js';
import { ZOOM_MIN } from '../../render/CameraDirector.js';
import { LENS_MIN_HALF_ANGLE_SCALE } from '../../render/CameraLens.js';

const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
const ceil = n => Math.ceil(n * 64) / 64;

/** A stable envelope of the scenic stage, including its deepest pull-back.
 * Backing pixels and DPR never change geographic coverage. */
export function terrainWindowCoverage(viewport = {}) {
  const width = viewport.nominalWidth || 1280, height = viewport.nominalHeight || 720;
  const margin = viewport.overscanPx ?? 64;
  const aspect = ceil(Math.max(width / height, (width + 2 * margin) / (height + 2 * margin),
    (viewport.logicalWidth || width) / (viewport.logicalHeight || height)));
  const fovScale = ceil(Math.max((viewport.logicalHeight || height) / height, 1 / ZOOM_MIN + 2 * margin / height));
  // Tour poses already contain all permitted motion (applyCameraMoves
  // returns tour poses unchanged). Bound their interpolation below instead
  // of adding unrelated static-rail move limits to every terrain tile.
  return { aspect, fovScale, key: `${aspect}:${fovScale}:${width}:${height}` };
}

/** Summit identities come from the tour's existing extracted point catalog. */
export function tourSummitTiles(data, points = []) {
  const size = data.cells * data.grid.cellSizeM;
  return [...new Set(points.filter(p => p.type === 'summit' || p.type === 'butte').map(p =>
    data.byIndex.get(`${Math.floor((p.localM[0] - data.grid.originM[0]) / size)},${Math.floor((p.localM[2] - data.grid.originM[1]) / size)}`)?.id).filter(Boolean))];
}

// Expanding a rectangular frustum by a spherical orientation bound needs
// more margin at its corners. Bound the change of each projected angle by
// the smallest projection of a unit ray onto that coordinate plane.
function expandedTangents(p, framing) {
  const v = Math.tan(p.maxFovYDeg * Math.PI / 360) * framing.fovScale, h = v * framing.aspect;
  const pad = p.anglePadRad + (framing.anglePadRad || 0);
  const horizontal = Math.asin(Math.min(1, Math.tan(pad) * Math.hypot(1, v)));
  const vertical = Math.asin(Math.min(1, Math.tan(pad) * Math.hypot(1, h)));
  const expand = (t, a) => Math.tan(Math.min(Math.PI / 2 - 1e-5, Math.atan(t) + a));
  return { tanX: expand(h, horizontal), tanY: expand(v, vertical) };
}

/** The coarsest measured-error-safe grid over an eight-second route window. */
export function planTerrainWindow(data, tour, index, {
  budget = 'desktop', heightPx = 1080, aspect = 16 / 9, bias = 1,
  pixelLimit = budget === 'mobile' ? 2 : 1, coverage = null, coverageRevision = 0,
  protectedTileIds = [],
} = {}) {
  const summits = new Set(protectedTileIds);
  const startMs = index * 8000, endMs = Math.min(tour.durationMs, startMs + 8000);
  const times = [];
  for (let t = startMs; t < endMs; t += 100) times.push(t);
  times.push(Math.max(startMs, endMs));
  const poses = times.map(timeMs => {
    const pose = tour.poseAt(timeMs);
    return { ...pose, basis: cameraBasis(pose), paddingM: 1, anglePadRad: 0,
      minFovYDeg: pose.fovYDeg, maxFovYDeg: pose.fovYDeg };
  });
  // Eyes are linear and aims slerp on TourTimeline's 100ms lattice. Bound
  // both yaw and pitch motion of the world-up basis throughout each arc.
  for (let i = 1; i < poses.length; i++) {
    const a = poses[i - 1], b = poses[i];
    const distance = Math.hypot(...a.eyeM.map((v, k) => v - b.eyeM[k])) / 2 + 1;
    const arc = Math.acos(Math.max(-1, Math.min(1, dot(a.basis.forward, b.basis.forward))));
    const pitch = Math.min(Math.PI / 2 - .001, Math.max(Math.asin(Math.abs(a.basis.forward[1])), Math.asin(Math.abs(b.basis.forward[1]))) + arc);
    const angle = Math.min(Math.PI / 2 - 1e-5, arc * (1 + 1 / Math.cos(pitch)) / 2 + 1e-6);
    for (const p of [a, b]) {
      p.paddingM = Math.max(p.paddingM, distance); p.anglePadRad = Math.max(p.anglePadRad, angle);
      p.minFovYDeg = Math.min(p.minFovYDeg, a.fovYDeg, b.fovYDeg);
      p.maxFovYDeg = Math.max(p.maxFovYDeg, a.fovYDeg, b.fovYDeg);
    }
  }
  const framing = { aspect: coverage?.aspect || aspect, fovScale: coverage?.fovScale || 1.2, anglePadRad: coverage?.anglePadRad || 0 };
  for (const p of poses) {
    Object.assign(p, expandedTangents(p, framing));
    p.focal = heightPx / (2 * Math.tan(p.minFovYDeg * Math.PI / 360) * LENS_MIN_HALF_ANGLE_SCALE);
  }
  const requirements = new Map(), visible = new Set();
  for (const tile of data.tiles.values()) {
    const size = data.cells * data.grid.cellSizeM;
    const cx = data.grid.originM[0] + (tile.ix + .5) * size;
    const cz = data.grid.originM[1] + (tile.iz + .5) * size;
    const cy = (tile.minY + tile.maxY) / 2, hy = (tile.maxY - tile.minY) / 2, hx = size / 2;
    let pixelPerMetre = 0;
    for (const p of poses) {
      const dx = cx - p.eyeM[0], dy = cy - p.eyeM[1], dz = cz - p.eyeM[2];
      const { forward: f, right: r, up: u } = p.basis;
      const depth = dx * f[0] + dy * f[1] + dz * f[2];
      const depthRadius = hx * (Math.abs(f[0]) + Math.abs(f[2])) + hy * Math.abs(f[1]) + p.paddingM;
      if (depth + depthRadius <= 1) continue;
      const sideRadius = hx * (Math.abs(r[0]) + Math.abs(r[2])) + hy * Math.abs(r[1]) + p.paddingM;
      const upRadius = hx * (Math.abs(u[0]) + Math.abs(u[2])) + hy * Math.abs(u[1]) + p.paddingM;
      if (Math.abs(dx * r[0] + dy * r[1] + dz * r[2]) > Math.max(0, depth) * p.tanX + sideRadius + depthRadius * p.tanX
        || Math.abs(dx * u[0] + dy * u[1] + dz * u[2]) > Math.max(0, depth) * p.tanY + upRadius + depthRadius * p.tanY) continue;
      visible.add(tile.id);
      pixelPerMetre = Math.max(pixelPerMetre, p.focal / Math.max(20, depth - depthRadius));
    }
    requirements.set(tile.id, pixelPerMetre);
  }
  // Frustum work happens once. Budget retries only rescan the small error
  // tables, so admission and a seek reconstruction do not repeat it.
  const cap = budget === 'mobile' ? 1000000 : 1500000, requestedLimit = pixelLimit;
  for (;;) {
    const strides = new Map(); let triangles = 0, maxErrorPx = 0, summitMaxErrorPx = 0, protectedTiles = 0;
    for (const tile of data.tiles.values()) {
      const ppm = requirements.get(tile.id), summit = summits.has(tile.id);
      const tileLimit = summit ? Math.min(8, pixelLimit) : pixelLimit;
      let stride = data.cells;
      if (ppm) {
        stride = tile.stride;
        for (const s of STRIDES) {
          if (s < tile.stride || s > data.cells) continue;
          const error = tile.errorsM?.[s];
          if (Number.isFinite(error) && error * ppm <= tileLimit) stride = s;
        }
      }
      stride = Math.min(data.cells, Math.max(tile.stride, stride * (summit ? 1 : bias)));
      strides.set(tile.id, stride); triangles += 2 * (data.cells / stride) ** 2;
      if (ppm) {
        const error = (tile.errorsM?.[stride] || 0) * ppm;
        maxErrorPx = Math.max(maxErrorPx, error);
        if (summit) { protectedTiles++; summitMaxErrorPx = Math.max(summitMaxErrorPx, error); }
      }
    }
    if (triangles <= cap) return { index, startMs, endMs, strides, visible, triangles, maxErrorPx, pixelLimit,
      coarse: bias > 1, coverage: framing, coverageRevision, poses,
      protectedTiles, summitMaxErrorPx, summitPixelLimit: Math.min(8, pixelLimit),
      ...(pixelLimit > requestedLimit ? { detailNote: `Triangle cap required ${pixelLimit}px surrounding terrain / ${Math.min(8, pixelLimit)}px summit detail (requested ${requestedLimit}px)` } : {}) };
    // Wide views can expose more terrain than the original 8px ceiling
    // permits within the triangle cap. Keep that ceiling for every summit;
    // only surrounding terrain may use the additional measured levels.
    if (pixelLimit >= (summits.size ? 32 : 8)) throw new Error(`Tour window ${index} exceeds triangle cap (${triangles})`);
    pixelLimit *= 2;
  }
}

/** A held window must contain the actual resolved camera and its lens. */
export function terrainWindowCovers(plan, pose, projection) {
  if (!plan?.poses || !pose || !projection) return false;
  const actual = cameraBasis(pose), tanV = Math.tan(projection.fovYDeg * Math.PI / 360), tanH = tanV * projection.aspect;
  return plan.poses.some(p => {
    if (Math.hypot(...pose.eyeM.map((v, k) => v - p.eyeM[k])) > p.paddingM + 1) return false;
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      const ray = actual.forward.map((v, k) => v + x * tanH * actual.right[k] + y * tanV * actual.up[k]);
      const depth = dot(ray, p.basis.forward);
      if (depth <= 0 || Math.abs(dot(ray, p.basis.right)) > depth * p.tanX + 1e-6
        || Math.abs(dot(ray, p.basis.up)) > depth * p.tanY + 1e-6) return false;
    }
    return true;
  });
}

/** Mesh ownership is bounded independently of asynchronous build completion. */
export class TourWindowCache {
  constructor({ build, windowMs = 8000, now = Date.now, canRetry = null } = {}) {
    this.build = build; this.windowMs = windowMs; this.resident = new Map(); this.pending = new Map();
    this.now = now; this.canRetry = canRetry; this.retryAt = new Map();
    this.generation = 0; this.current = 0; this.closed = false;
  }
  async request(index, { replace = false, retryNow = false } = {}) {
    if (this.closed || index < 0) return null;
    if (this.resident.has(index) && !replace) return this.resident.get(index);
    if (this.pending.has(index)) return this.pending.get(index);
    if (!retryNow && this.retryAt.has(index)) {
      if (this.now() < this.retryAt.get(index)) return null;
      if (this.canRetry && !this.canRetry(index)) {
        this.retryAt.set(index, this.now() + 250);
        return null;
      }
    }
    const generation = this.generation;
    const job = Promise.resolve(this.build(index)).then(mesh => {
      if (this.closed || generation !== this.generation || Math.abs(index - this.current) > 1) { mesh?.dispose?.(); return null; }
      this.resident.get(index)?.dispose?.(); this.resident.set(index, mesh);
      if (mesh?.adopt?.() === false) { this.resident.delete(index); mesh.dispose?.(); return null; }
      this.retryAt.delete(index);
      this.prune(); return mesh;
    }).catch(error => {
      // Failed admission otherwise reruns the route planner on every frame.
      // Keep playback smooth while retrying asynchronously as room returns.
      if (error?.reason === 'budget' && generation === this.generation && !this.closed) this.retryAt.set(index, this.now() + 250);
      throw error;
    }).finally(() => { if (this.pending.get(index) === job) this.pending.delete(index); });
    this.pending.set(index, job); return job;
  }
  async at(timeMs) { this.current = Math.max(0, Math.floor(timeMs / this.windowMs)); this.prune(); return this.request(this.current); }
  invalidate(keep = null) {
    this.generation++;
    this.pending.clear();
    this.retryAt.clear();
    for (const [index, mesh] of this.resident) if (mesh !== keep) { mesh?.dispose?.(); this.resident.delete(index); }
  }
  prune() {
    for (const index of this.retryAt.keys()) if (Math.abs(index - this.current) > 1) this.retryAt.delete(index);
    for (const [index, mesh] of this.resident) if (Math.abs(index - this.current) > 1) { mesh?.dispose?.(); this.resident.delete(index); }
  }
  dispose() { if (this.closed) return; this.closed = true; this.invalidate(); }
}
