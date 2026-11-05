// Synthetic forests and camera timelines for the tour forest windows
// (src/world/alpine/TourForest.js), and an R2 check: every tree within its
// own mesh ring of the eye is drawn as a mesh.
import { restoreShotTimeline, SHOT_KEY_MS } from '../../src/world/terrain/ShotTimeline.js';
import { tourUniverse, tourForestIndex, tourMeshVisible, TOUR_CELL_M } from '../../src/world/alpine/TourForest.js';

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** A timeline restored as the worker's are, from eye keys every 100 ms. */
export function keyTimeline(eyeKeys, durationMs) {
  const count = eyeKeys.length;
  const eye = new Float32Array(count * 3), target = new Float32Array(count * 3), fov = new Float32Array(count).fill(40);
  eyeKeys.forEach((p, i) => { eye.set(p, i * 3); target.set([p[0] + 100, p[1] - 30, p[2]], i * 3); });
  return restoreShotTimeline({ durationMs, eye, target, fov, meta: new Uint16Array(count * 4), items: [], payoffs: [], subjects: [] });
}

/** A camera wandering at `speed` m/s with a sharp turn every `legKeys`
 *  keys, kept inside a box of half-size `box`, for `durationMs`. With
 *  `shuttle` it adds 800 m back-and-forth steps (large Catmull-Rom
 *  overshoot) over keys [shuttle[0], shuttle[1]). */
export function wanderKeys({ durationMs = 40000, speed = 300, legKeys = 12, box = 1800, seed = 3, shuttle = null } = {}) {
  const r = rng(seed), count = Math.floor(durationMs / SHOT_KEY_MS) + 2, keys = [];
  let x = 0, z = 0, heading = 0;
  const step = speed * SHOT_KEY_MS / 1000;
  for (let i = 0; i < count; i++) {
    const y = 1150 + 120 * Math.sin(i / 23);
    if (shuttle && i >= shuttle[0] && i < shuttle[1]) {
      const phase = (i - shuttle[0]) % 4;
      if (phase === 0) x += 800; else if (phase === 2) x -= 800; else z += 10;
      keys.push([x, y, z]);
      continue;
    }
    if (i % legKeys === 0) heading += (r() < .5 ? -1 : 1) * (1.6 + 1.2 * r());
    x += step * Math.cos(heading); z += step * Math.sin(heading);
    if (Math.abs(x) > box) { heading = Math.PI - heading; x = Math.sign(x) * box; }
    if (Math.abs(z) > box) { heading = -heading; z = Math.sign(z) * box; }
    keys.push([x, y, z]);
  }
  return keys;
}

/** A placed forest (ForestCover records: x, y, z, h, w, species, id, band)
 *  on a jittered `spacing` lattice over [-extent, extent]^2, with a rail
 *  prefix so it is a two-camera forest. Meshes near the middle are the
 *  detail ring, bands by distance from it. */
export function syntheticPlaced({ extent = 3600, spacing = 30, seed = 11 } = {}) {
  const r = rng(seed), detail = [], mesh = [];
  for (let gz = -extent; gz <= extent; gz += spacing) for (let gx = -extent; gx <= extent; gx += spacing) {
    const x = gx + (r() - .5) * spacing * .8, z = gz + (r() - .5) * spacing * .8;
    const y = 1000 + 80 * Math.sin(x / 700) * Math.cos(z / 900);
    const d = Math.hypot(x, z), band = d < 1500 ? 2 : 0;
    const rec = [x, y, z, 8 + 20 * r(), 3 + 4 * r(), Math.floor(r() * 4), r(), band];
    (d < 1100 || r() < .3 ? detail : mesh).push(...rec);
  }
  const meshDetail = new Float32Array(detail), m = new Float32Array(mesh);
  return { meshDetail, mesh: m, billboard: new Float32Array(), stride: 8, count: (detail.length + mesh.length) / 8,
    railCount: { meshDetail: Math.floor(meshDetail.length / 16), mesh: Math.floor(m.length / 16), billboard: 0 } };
}

/** The index over a placed forest's U, batches numbered as createForest's
 *  twins are (kind, then band, then group). */
export function syntheticIndex(placed, seed = 7) {
  return tourForestIndex({ ...tourUniverse(placed, (kind, band, group) => (kind * 3 + band) * 6 + group), seed });
}

/** The trees within their own ring of `eye` (|root - eye| < reach). */
export function inRing(index, eye, out = []) {
  out.length = 0;
  const { pos, reach, maxReach } = index, { x0, z0, nx, nz, start, items } = index.grid;
  const cx0 = Math.max(0, Math.floor((eye[0] - maxReach) / TOUR_CELL_M) - x0), cx1 = Math.min(nx - 1, Math.floor((eye[0] + maxReach) / TOUR_CELL_M) - x0);
  const cz0 = Math.max(0, Math.floor((eye[2] - maxReach) / TOUR_CELL_M) - z0), cz1 = Math.min(nz - 1, Math.floor((eye[2] + maxReach) / TOUR_CELL_M) - z0);
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    const c = cz * nx + cx;
    for (let s = start[c]; s < start[c + 1]; s++) {
      const u = items[s];
      if (Math.hypot(pos[3 * u] - eye[0], pos[3 * u + 1] - eye[1], pos[3 * u + 2] - eye[2]) < reach[u]) out.push(u);
    }
  }
  return out;
}

export const bitOf = (bits, u) => (bits[u >>> 5] >>> (u & 31)) & 1;
/** A tree's membership bits in a state (1: outgoing set, 2: incoming). */
export const stateBits = (state, u) => bitOf(state.a.bits, u) | (bitOf(state.b.bits, u) << 1);

/**
 * R2 over [fromMs, toMs] every `stepMs` on `tl`: the trees within their
 * ring of poseAt's eye that the schedule's state does not draw as meshes
 * (`misses`) or does not hold in both sets (`notBoth`), and how many were
 * checked. `onFrame(t)` runs before each frame's state.
 */
export function r2Sweep(index, schedule, tl, { fromMs = 0, toMs = tl.durationMs, stepMs = 10, onFrame = null, jitter = null } = {}) {
  let misses = 0, notBoth = 0, checked = 0, frames = 0;
  const near = [];
  for (let t0 = fromMs; t0 <= toMs + 1e-9; t0 += stepMs) {
    const t = jitter ? Math.min(toMs, t0 + jitter() * stepMs) : t0;
    onFrame?.(t);
    const state = schedule.stateAt(t), eye = tl.poseAt(t).eyeM;
    frames++;
    for (const u of inRing(index, eye, near)) {
      checked++;
      const bits = stateBits(state, u);
      if (bits !== 3) notBoth++;
      if (!tourMeshVisible(bits, index.vars[2 * u + 1], state.f)) misses++;
    }
  }
  return { misses, notBoth, checked, frames };
}
