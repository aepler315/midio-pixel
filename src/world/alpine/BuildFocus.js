// The source summit the opening (rise) camera keeps framed while the range
// builds (LandRiseCamera focusM): a local top that holds the rail's frame
// at every station, below the sky band, rising furthest over its own foot,
// with a climb up to it that the middle station can mostly see. Read once
// per prepared view from the rail's tile samples.
//
// Plain data, no THREE. This is the summit search the retired cast's
// Ascent used, kept unchanged so every view's opening framing is the same.
import { scenePoseAt, projectPoint } from '../terrain/SceneTravel.js';
import { terrainHeightAt } from './TerrainMesh.js';
import { railTile } from './TerrainPackage.js';
import { MIRROR_LEVEL_TOLERANCE_M } from './WaterMirror.js';
import { seenFrom } from './LineOfSight.js';

const ASPECT = 16 / 9;
/** Rail stations the summit must stay in frame at. */
export const FOCUS_STATIONS = Object.freeze([0.15, 0.5, 0.85]);
/** In-frame window (NDC) at every station; the summit must stand below the
 *  sky band. */
const FRAME_X = 0.72, FRAME_Y = [-0.6, 0.6], GROUND_Y = [-0.5, 0.42], SKY_Y = 0.55;
const SUMMIT_DEPTH_M = [1500, 12000], LANDING_DEPTH_M = 700;
/** A summit rises at least this far (NDC) over its own foot: the lowest
 *  ground within FOOT_X of it, between half its depth and its own. */
export const FOCUS_RISE = 0.25;
const FOOT_X = 0.15, LANDING_X = 0.2;
/** Summit candidates tested for their foot (the highest on screen). */
const SUMMIT_CANDIDATES = 160;
/** Lake samples given a line-of-sight test when finding the climb's start
 *  (bounds the synchronous cost of preparing a view). */
const MAX_LAKE_SIGHT_TESTS = 96;
/** Climb: greedy steps, headings tried each step, the slope it prefers, and
 *  the share of waypoints the middle station must see. */
export const FOCUS_STEPS = 24;
const HEADING_DEG = 50;
const HEADINGS = 11;
const MAX_SLOPE_DEG = 35;
export const FOCUS_VISIBLE = 0.7;

/** The flow byte of the sample at world (x, z), in whichever tile holds
 *  it, or null between samples or off the terrain. */
function flowAt(data, x, z) {
  const { grid, cells } = data;
  const gx = (x - grid.originM[0]) / grid.cellSizeM, gz = (z - grid.originM[1]) / grid.cellSizeM;
  const tile = data.byIndex?.get(`${Math.floor(gx / cells)},${Math.floor(gz / cells)}`);
  if (!tile?.flowBytes) return null;
  const u = (gx - tile.ix * cells) / tile.stride, v = (gz - tile.iz * cells) / tile.stride;
  if (!Number.isInteger(u) || !Number.isInteger(v) || u >= tile.samples || v >= tile.samples) return null;
  return tile.flowBytes[v * tile.samples + u];
}

const inFrame = (q, y = FRAME_Y) => q && Math.abs(q.x) <= FRAME_X && q.y >= y[0] && q.y <= y[1];
const framedEverywhere = (s, y = FRAME_Y) => s.q.every((q) => inFrame(q, y));

/** The visible samples of a view with their projections at the three
 *  stations, sorted into water (the mirror lake), shore and land. */
function viewSamples(data, view, waterLevelM) {
  const poses = FOCUS_STATIONS.map((u) => scenePoseAt(view, { progress01: u }));
  const { grid, cells } = data;
  const all = [], seen = new Set();
  for (const tile of data.tiles.values()) {
    if (!railTile(tile)) continue;
    const n = tile.samples, step = Math.max(1, Math.floor(n / 8));
    for (let v = 0; v < n; v += step) for (let u = 0; u < n; u += step) {
      const i = v * n + u, y = tile.heightsM[i];
      if (!Number.isFinite(y)) continue;
      const x = grid.originM[0] + (tile.ix * cells + u * tile.stride) * grid.cellSizeM;
      const z = grid.originM[1] + (tile.iz * cells + v * tile.stride) * grid.cellSizeM;
      // Neighbouring tiles share their edge samples.
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const q = poses.map((pose) => projectPoint(pose, ASPECT, [x, y, z]));
      if (!q[1]) continue;
      const level = Number.isFinite(waterLevelM);
      const water = tile.flowBytes?.[i] === 255 && level && Math.abs(y - waterLevelM) < MIRROR_LEVEL_TOLERANCE_M;
      let wet = false;
      if (!water && level && y < waterLevelM + 40) {
        // Neighbours by position: at a tile's edge they lie in the next tile.
        const d = step * tile.stride * grid.cellSizeM;
        wet = [[d, 0], [-d, 0], [0, d], [0, -d]].some(([dx, dz]) => flowAt(data, x + dx, z + dz) === 255);
      }
      all.push({ x, y, z, p: [x, y, z], q, sx: q[1].x, sy: q[1].y, depth: q[1].depth, water, shore: wet, d: step * tile.stride * grid.cellSizeM });
    }
  }
  return { poses, eye: poses[1].eyeM, all };
}

/** The summit that holds the frame, or null: a local top, framed at every
 *  station and below the sky band, rising furthest over its own foot. */
function summitOf(data, samples) {
  const tops = samples.all.filter((s) => !s.water && s.q.every((q) => q && Math.abs(q.x) <= FRAME_X
    && q.y <= SKY_Y && q.y >= FRAME_Y[0] && q.depth >= SUMMIT_DEPTH_M[0] && q.depth <= SUMMIT_DEPTH_M[1]))
    .filter((s) => [[s.d, 0], [-s.d, 0], [0, s.d], [0, -s.d]].every(([dx, dz]) => {
      const h = terrainHeightAt(data, s.x + dx, s.z + dz);
      return !(h > s.y);
    }))
    .sort((a, b) => b.sy - a.sy).slice(0, SUMMIT_CANDIDATES);
  let best = null;
  for (const s of tops) {
    let foot = Infinity;
    for (const g of samples.all) {
      if (Math.abs(g.sx - s.sx) > FOOT_X || g.depth < 0.5 * s.depth || g.depth > s.depth || g.sy < -1) continue;
      foot = Math.min(foot, g.sy);
    }
    const rise = s.sy - foot;
    if (rise >= FOCUS_RISE && (!best || rise > best.rise)) best = { ...s, rise };
  }
  return best;
}

/**
 * The share of a climb to `summit` the middle station sees (null with no
 * landing to start from): from the lake shore nearest the summit when the
 * rail sees the mirror lake below it, else the lowest framed ground near
 * it, FOCUS_STEPS greedy steps that stay framed and seen where they can, on
 * slopes it can walk where it can.
 */
function climbSeen(data, summit, samples) {
  const eye = samples.eye;
  const framed = (p) => samples.poses.every((pose) => inFrame(projectPoint(pose, ASPECT, p)));
  const S = summit.p;
  const lake = samples.all.filter((s) => s.water && framedEverywhere(s) && s.depth >= 300).sort((a, b) => a.depth - b.depth);
  const nearestSeen = (pool) => {
    const every = Math.max(1, Math.ceil(pool.length / MAX_LAKE_SIGHT_TESTS));
    return pool.find((s, i) => i % every === 0 && seenFrom(data, eye, s.p))?.p ?? null;
  };
  const W0 = nearestSeen(lake.filter((s) => Math.abs(s.sx - summit.sx) <= FOOT_X)) ?? nearestSeen(lake);
  let L = null;
  if (W0) {
    const shore = samples.all.filter((s) => s.shore && framedEverywhere(s));
    const xz = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
    if (shore.length) L = shore.reduce((a, b) => (xz(b.p, S) < xz(a.p, S) ? b : a)).p;
  }
  if (!L) {
    const ground = samples.all.filter((s) => !s.water && Math.abs(s.sx - summit.sx) <= LANDING_X
      && s.depth >= LANDING_DEPTH_M && s.depth <= summit.depth && framedEverywhere(s, GROUND_Y));
    if (!ground.length) return null;
    L = ground.reduce((a, b) => (b.y < a.y ? b : a)).p;
  }
  // Greedy ascent: each step re-aims at S with what is left of the climb.
  const hidden = [!seenFrom(data, eye, [L[0], L[1] + 2, L[2]])];
  let c = L;
  for (let k = 0; k < FOCUS_STEPS; k++) {
    const left = FOCUS_STEPS - k;
    const dx = S[0] - c[0], dz = S[2] - c[2], dist = Math.hypot(dx, dz);
    if (left === 1 || dist < 1) { hidden.push(!seenFrom(data, eye, [S[0], S[1] + 2, S[2]])); c = S; continue; }
    const step = dist / left, bearing = Math.atan2(dz, dx);
    let pick = null;
    for (let h = 0; h < HEADINGS; h++) {
      const a = bearing + (((h / (HEADINGS - 1)) * 2 - 1) * HEADING_DEG * Math.PI) / 180;
      const x = c[0] + Math.cos(a) * step, z = c[2] + Math.sin(a) * step, y = terrainHeightAt(data, x, z);
      if (!Number.isFinite(y)) continue;
      const p = [x, y, z];
      if (!framed(p) || !seenFrom(data, eye, [x, y + 2, z])) continue;
      const steep = (Math.atan2(Math.abs(y - c[1]), step) * 180) / Math.PI > MAX_SLOPE_DEG;
      const rest = Math.hypot(S[0] - x, S[2] - z);
      if (!pick || (pick.steep && !steep) || (pick.steep === steep && rest < pick.rest)) pick = { p, steep, rest };
    }
    if (pick) { c = pick.p; hidden.push(false); } else {
      const x = c[0] + (dx / dist) * step, z = c[2] + (dz / dist) * step;
      const y = terrainHeightAt(data, x, z);
      c = [x, Number.isFinite(y) ? y : c[1], z];
      hidden.push(true);
    }
  }
  return hidden.filter((h) => !h).length / hidden.length;
}

/**
 * The opening camera's focus for a prepared rail view: the summit [x, y, z]
 * (source space) that holds the frame, with a mostly visible climb up to
 * it, or null (a tour, a view without a camera, or no such summit: the
 * opening then keeps the authored target).
 */
export function buildFocusM(data, view, { waterLevelM = null } = {}) {
  if (view?.tour || !view?.camera || !data?.tiles) return null;
  const samples = viewSamples(data, view, waterLevelM);
  const summit = summitOf(data, samples);
  if (!summit) return null;
  const seen = climbSeen(data, summit, samples);
  return seen != null && seen >= FOCUS_VISIBLE ? summit.p : null;
}
