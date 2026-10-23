// What the cast do in a view (docs/landscape-cast.md), read from the terrain
// the rail sees. Where a clear summit holds the frame they climb it (the
// Ascent): Midio leads up a planned path, Broshi follows fixing lights
// along it, Midasus scouts ahead. Elsewhere they are Lamplighters: Broshi
// lights cairns along the shore, Midio buoys on the lake, and Midasus
// draws survey threads between them. Tour views keep wandering lanterns.
//
// Plain data, no THREE. CastSchedule.js says when; RangeScene places them.
import { scenePoseAt, projectPoint } from '../terrain/SceneTravel.js';
import { terrainHeightAt } from './TerrainMesh.js';
import { MIRROR_LEVEL_TOLERANCE_M } from './WaterMirror.js';
import { seenFrom } from './LineOfSight.js';
import { ROUTE_STATIONS, pickAnchors } from './RangeActors.js';

const ASPECT = 16 / 9;
/** In-frame window (NDC) at every station, as the routes use; the summit
 *  must stand below the sky band. */
const FRAME_X = 0.72, FRAME_Y = [-0.6, 0.6], GROUND_Y = [-0.5, 0.42], SKY_Y = 0.55;
const SUMMIT_DEPTH_M = [1500, 12000], SITE_DEPTH_M = [700, 12000];
/** Sites may stand this far out when too few lie nearer (a view down onto
 *  a wide basin); they are drawn at a fixed size on screen. */
const SITE_FAR_M = 30000;
/** A summit rises at least this far (NDC) over its own foot: the lowest
 *  ground within FOOT_X of it, between half its depth and its own. */
export const ASCENT_RISE = 0.25;
const FOOT_X = 0.15, LANDING_X = 0.2;
/** Summit candidates tested for their foot (the highest on screen). */
const SUMMIT_CANDIDATES = 160;
/** Lake samples given a line-of-sight test when finding the water leg's
 *  start (bounds the synchronous cost of preparing a view). */
const MAX_LAKE_SIGHT_TESTS = 96;
/** Path: greedy steps, headings tried each step, the slope it prefers, and
 *  the share of waypoints the middle station must see. */
export const ASCENT_STEPS = 24;
export const ASCENT_HEADING_DEG = 50;
const ASCENT_HEADINGS = 11;
export const ASCENT_MAX_SLOPE_DEG = 35;
export const ASCENT_VISIBLE = 0.7;
/** The water leg takes this much of the path. */
export const ASCENT_WATER_U = 0.12;
const WATER_LEG_POINTS = 6;
/** Fixed-line lights per view (and at quality level 4 and up). */
export const FIXED_LIGHTS = 32;
export const FIXED_LIGHTS_LOW = 12;
export const CAIRN_BINS = 8, BUOY_BINS = 6;

/** The flow byte of the sample at world (x, z), in whichever tile holds
 *  it, or null between samples or off the terrain. */
export function flowAt(data, x, z) {
  const { grid, cells } = data;
  const gx = (x - grid.originM[0]) / grid.cellSizeM, gz = (z - grid.originM[1]) / grid.cellSizeM;
  const tile = data.byIndex?.get(`${Math.floor(gx / cells)},${Math.floor(gz / cells)}`);
  if (!tile?.flowBytes) return null;
  const u = (gx - tile.ix * cells) / tile.stride, v = (gz - tile.iz * cells) / tile.stride;
  if (!Number.isInteger(u) || !Number.isInteger(v) || u >= tile.samples || v >= tile.samples) return null;
  return tile.flowBytes[v * tile.samples + u];
}

const inFrame = (q, y = FRAME_Y) => q && Math.abs(q.x) <= FRAME_X && q.y >= y[0] && q.y <= y[1];

/** The visible samples of a view with their projections at the three
 *  stations, sorted into water (the mirror lake), shore and land. */
function viewSamples(data, view, waterLevelM) {
  const poses = ROUTE_STATIONS.map((u) => scenePoseAt(view, { progress01: u }));
  const { grid, cells } = data;
  const all = [], seen = new Set();
  for (const tile of data.tiles.values()) {
    if (!tile.visible) continue;
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

const framedEverywhere = (s, y = FRAME_Y) => s.q.every((q) => inFrame(q, y));

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
    if (rise >= ASCENT_RISE && (!best || rise > best.rise)) best = { ...s, rise };
  }
  return best;
}

function polyline(points, u0, u1) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]));
  }
  const total = lengths.at(-1) || 1;
  return lengths.map((l) => u0 + ((u1 - u0) * l) / total);
}

/**
 * The Ascent's geometry for a view with summit `S`: an optional water leg
 * from the mirror lake's near edge (W0) to the landing (L), then a climb
 * of ASCENT_STEPS greedy steps from L to S that the rail can see, on
 * slopes it can walk where it can (switchbacks on a steep face).
 */
export function ascentPlan(data, view, summit, samples, { waterLevelM = null } = {}) {
  const eye = samples.eye;
  const framed = (p) => samples.poses.every((pose) => inFrame(projectPoint(pose, ASPECT, p)));
  const S = summit.p;
  // The water leg starts at the lake's near edge below the summit (else
  // anywhere on it): the nearest framed lake sample the rail can see,
  // testing at most MAX_LAKE_SIGHT_TESTS of them (in each of the two
  // pools), nearest first.
  const lake = samples.all.filter((s) => s.water && framedEverywhere(s) && s.depth >= 300).sort((a, b) => a.depth - b.depth);
  const nearestSeen = (pool) => {
    const every = Math.max(1, Math.ceil(pool.length / MAX_LAKE_SIGHT_TESTS));
    return pool.find((s, i) => i % every === 0 && seenFrom(data, eye, s.p))?.p ?? null;
  };
  let W0 = nearestSeen(lake.filter((s) => Math.abs(s.sx - summit.sx) <= FOOT_X)) ?? nearestSeen(lake), L = null, shoreStart = null;
  if (W0) {
    const shore = samples.all.filter((s) => s.shore && framedEverywhere(s));
    const xz = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
    if (shore.length) {
      L = shore.reduce((a, b) => (xz(b.p, S) < xz(a.p, S) ? b : a)).p;
      shoreStart = shore.reduce((a, b) => (xz(b.p, W0) < xz(a.p, W0) ? b : a)).p;
    } else W0 = null;
  }
  if (!L) {
    const ground = samples.all.filter((s) => !s.water && Math.abs(s.sx - summit.sx) <= LANDING_X
      && s.depth >= SITE_DEPTH_M[0] && s.depth <= summit.depth && framedEverywhere(s, GROUND_Y));
    if (!ground.length) return null;
    L = ground.reduce((a, b) => (b.y < a.y ? b : a)).p;
  }
  // Greedy ascent: each step re-aims at S with what is left of the climb.
  const climb = [L], hidden = [!seenFrom(data, eye, [L[0], L[1] + 2, L[2]])];
  let c = L;
  for (let k = 0; k < ASCENT_STEPS; k++) {
    const left = ASCENT_STEPS - k;
    const dx = S[0] - c[0], dz = S[2] - c[2], dist = Math.hypot(dx, dz);
    if (left === 1 || dist < 1) { climb.push(S); hidden.push(!seenFrom(data, eye, [S[0], S[1] + 2, S[2]])); c = S; continue; }
    const step = dist / left, bearing = Math.atan2(dz, dx);
    let pick = null;
    for (let h = 0; h < ASCENT_HEADINGS; h++) {
      const a = bearing + (((h / (ASCENT_HEADINGS - 1)) * 2 - 1) * ASCENT_HEADING_DEG * Math.PI) / 180;
      const x = c[0] + Math.cos(a) * step, z = c[2] + Math.sin(a) * step, y = terrainHeightAt(data, x, z);
      if (!Number.isFinite(y)) continue;
      const p = [x, y, z];
      if (!framed(p) || !seenFrom(data, eye, [x, y + 2, z])) continue;
      const steep = (Math.atan2(Math.abs(y - c[1]), step) * 180) / Math.PI > ASCENT_MAX_SLOPE_DEG;
      const rest = Math.hypot(S[0] - x, S[2] - z);
      if (!pick || (pick.steep && !steep) || (pick.steep === steep && rest < pick.rest)) pick = { p, steep, rest };
    }
    if (pick) { c = pick.p; hidden.push(false); } else {
      const x = c[0] + (dx / dist) * step, z = c[2] + (dz / dist) * step;
      const y = terrainHeightAt(data, x, z);
      c = [x, Number.isFinite(y) ? y : c[1], z];
      hidden.push(true);
    }
    climb.push(c);
  }
  const seen = hidden.filter((h) => !h).length / hidden.length;
  const water = W0 && Number.isFinite(waterLevelM) ? Array.from({ length: WATER_LEG_POINTS }, (_, i) => {
    const f = i / WATER_LEG_POINTS;
    return [W0[0] + (L[0] - W0[0]) * f, waterLevelM, W0[2] + (L[2] - W0[2]) * f];
  }) : [];
  const waterU = water.length ? ASCENT_WATER_U : 0;
  const points = [...water, ...climb];
  const us = [...(water.length ? polyline([...water, L], 0, waterU).slice(0, -1) : []), ...polyline(climb, waterU, 1)];
  return Object.freeze({
    job: 'ascent', points, us, waterU, hidden: Object.freeze(hidden), seen,
    summit: S, landing: L, start: W0 || L, shoreStart, rise: summit.rise,
  });
}

/**
 * The Lamplighters' geometry: cairn sites along the shore (else low open
 * ground) and buoy sites on the mirror lake, each picked across the frame
 * and swept left to right.
 */
export function lampPlan(data, view, samples, { seed = 0 } = {}) {
  const within = (far) => samples.all.filter((s) => !s.water && framedEverywhere(s, GROUND_Y)
    && s.q.every((q) => q.depth >= SITE_DEPTH_M[0] && q.depth <= far));
  let ground = within(SITE_DEPTH_M[1]);
  if (ground.length < 2 * CAIRN_BINS) ground = within(SITE_FAR_M);
  const shore = ground.filter((s) => s.shore);
  const low = () => {
    const ys = ground.map((s) => s.y).sort((a, b) => a - b);
    const cut = ys[Math.floor(ys.length * 0.3)];
    return ground.filter((s) => s.y <= cut);
  };
  const cairns = pickAnchors(shore.length >= CAIRN_BINS ? shore : low(), seed + 4, CAIRN_BINS) || [];
  const lake = samples.all.filter((s) => s.water && framedEverywhere(s, GROUND_Y) && s.depth >= SITE_DEPTH_M[0] && s.depth <= SITE_FAR_M);
  const buoys = lake.length >= BUOY_BINS ? pickAnchors(lake, seed + 5, BUOY_BINS) || [] : [];
  return Object.freeze({ job: 'lamplighters', cairns: Object.freeze(cairns), buoys: Object.freeze(buoys) });
}

const WANDER = Object.freeze({ job: 'wander' });

/**
 * The cast's plan for a prepared view: { job: 'ascent', ... } where a clear
 * summit holds the frame and the rail can see a path up it,
 * { job: 'lamplighters', ... } otherwise, { job: 'wander' } for tours
 * (and a view with nowhere to set a cairn).
 */
export function castPlan(data, view, { waterLevelM = null, seed = 0 } = {}) {
  // A tour moves the eye too far for either job to stay in frame.
  if (view?.tour || !view?.camera) return WANDER;
  const samples = viewSamples(data, view, waterLevelM);
  const summit = summitOf(data, samples);
  const ascent = summit ? ascentPlan(data, view, summit, samples, { waterLevelM }) : null;
  if (ascent && ascent.seen >= ASCENT_VISIBLE) return ascent;
  const lamps = lampPlan(data, view, samples, { seed });
  return lamps.cairns.length >= 2 ? lamps : WANDER;
}

/** 'ascent', 'lamplighters' or 'wander' (tours) for a view. */
export function classifyCastJob(data, view, opts = {}) {
  return castPlan(data, view, opts).job;
}

/**
 * World position on an ascent path at `u` (0..1): Catmull-Rom through the
 * waypoints, on the water's surface along the water leg and on the drawn
 * ground on the climb, `hoverM` above either.
 */
export function pathPosition(plan, u, { data = null, waterLevelM = null, hoverM = 0 } = {}) {
  if (!plan?.points?.length) return null;
  const P = plan.points, us = plan.us;
  const t = Math.max(0, Math.min(1, Number.isFinite(u) ? u : 0));
  let i = 0;
  while (i < us.length - 2 && t > us[i + 1]) i++;
  const span = us[i + 1] - us[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (t - us[i]) / span)) : 0;
  const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[Math.min(P.length - 1, i + 1)], p3 = P[Math.min(P.length - 1, i + 2)];
  const cr = (a, b, c, e) => 0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - e) * f * f + (-a + 3 * b - 3 * c + e) * f * f * f);
  const x = cr(p0[0], p1[0], p2[0], p3[0]), z = cr(p0[2], p1[2], p2[2], p3[2]);
  const ground = data ? terrainHeightAt(data, x, z) : NaN;
  let y = Number.isFinite(ground) ? ground : cr(p0[1], p1[1], p2[1], p3[1]);
  if (t < plan.waterU && Number.isFinite(waterLevelM)) y = Math.max(y, waterLevelM);
  return [x, y + hoverM, z];
}

/** Where along a polyline of `sites` a walker stands at `p`, where it
 *  reaches site k at dues[k]: it eases between sites, starting from
 *  between its last and first, and closes the loop at p = 1. */
export function siteWalk(sites, dues, p) {
  if (!sites?.length) return null;
  const n = sites.length;
  const mid = (a, b) => a.map((v, k) => (v + b[k]) / 2);
  const knots = [[0, mid(sites[n - 1], sites[0])], ...sites.map((s, k) => [dues[k], s]), [1, sites[0]]];
  const t = Math.max(0, Math.min(1, p));
  let k = 0;
  while (k < knots.length - 2 && t > knots[k + 1][0]) k++;
  const [a, A] = knots[k], [b, B] = knots[k + 1];
  const f = b > a ? Math.max(0, Math.min(1, (t - a) / (b - a))) : 1;
  const e = f * f * (3 - 2 * f);
  return A.map((v, j) => v + (B[j] - v) * e);
}

/** Midasus flies, but keeps to the ground like the others: this far (six
 *  feet) above it, and her survey threads lie draped at the same height. */
export const MIDASUS_HOVER_M = 1.83;
/** Segments a survey thread is draped over the ground in. */
export const THREAD_SEGMENTS = 16;

/**
 * What a plan builds, as the schedule needs it: `lights` (fixed lines on an
 * ascent; cairns and buoys for lamplighters), `threads` (lamplighters), and
 * `marks`, one per light then per thread, for CastSchedule.kindleTimes.
 * Lamplighters also get each walker's sites and the progress it reaches
 * them at. Positions are on the drawn ground or water.
 */
export function castWork(plan, { data = null, waterLevelM = null } = {}) {
  const lights = [], threads = [], marks = [], walkers = {};
  if (plan?.job === 'ascent') {
    const low = new Set(Array.from({ length: FIXED_LIGHTS_LOW }, (_, j) => Math.round(((j + 0.5) * FIXED_LIGHTS) / FIXED_LIGHTS_LOW - 0.5)));
    for (let k = 0; k < FIXED_LIGHTS; k++) {
      const u = plan.waterU + ((1 - plan.waterU) * (k + 1)) / (FIXED_LIGHTS + 1);
      lights.push({ pos: pathPosition(plan, u, { data, waterLevelM, hoverM: 1.5 }), kind: 'line', actor: 'broshi', u, low: low.has(k), mark: marks.length });
      marks.push({ p: u, follow: 'broshi', lane: 'broshi' });
    }
  } else if (plan?.job === 'lamplighters') {
    const lake = plan.buoys.length > 0;
    const nc = plan.cairns.length, nb = plan.buoys.length;
    const ground = (p, lift) => {
      const h = data ? terrainHeightAt(data, p[0], p[2]) : NaN;
      return [p[0], (Number.isFinite(h) ? h : p[1]) + lift, p[2]];
    };
    walkers.broshi = { sites: [], dues: [] };
    walkers.midio = { sites: [], dues: [], water: lake };
    plan.cairns.forEach((c, k) => {
      // With no lake Midio lights alternate cairns.
      const actor = !lake && k % 2 === 1 ? 'midio' : 'broshi', p = (k + 1) / (nc + 1), pos = ground(c, 1.5);
      lights.push({ pos, kind: 'cairn', actor, mark: marks.length });
      marks.push({ p, lane: actor });
      walkers[actor].sites.push(pos); walkers[actor].dues.push(p);
    });
    plan.buoys.forEach((b, j) => {
      const p = (j + 1) / (nb + 1), pos = [b[0], (Number.isFinite(waterLevelM) ? waterLevelM : b[1]) + 1, b[2]];
      lights.push({ pos, kind: 'buoy', actor: 'midio', mark: marks.length });
      marks.push({ p, lane: 'midio' });
      walkers.midio.sites.push(pos); walkers.midio.dues.push(p);
    });
    // Survey threads join neighbouring cairns once both are lit; the last
    // closes the network back to the first at the finish. Each lies draped
    // over the ground (or water) between them, where Midasus flies it.
    const drape = (a, b) => Array.from({ length: THREAD_SEGMENTS + 1 }, (_, s) => {
      const f = s / THREAD_SEGMENTS, x = a[0] + (b[0] - a[0]) * f, z = a[2] + (b[2] - a[2]) * f;
      const h = data ? terrainHeightAt(data, x, z) : NaN;
      const ground = Number.isFinite(h) ? h : a[1] + (b[1] - a[1]) * f - 1.5;
      return [x, (Number.isFinite(waterLevelM) ? Math.max(ground, waterLevelM) : ground) + MIDASUS_HOVER_M, z];
    });
    for (let k = 1; k <= nc; k++) {
      const closing = k === nc;
      if (closing && nc < 3) break;
      const i = k - 1, j = closing ? 0 : k;
      const points = drape(lights[i].pos, lights[j].pos);
      threads.push({ a: points[0], b: points.at(-1), points, closing, mark: marks.length });
      marks.push(closing ? { p: 1, lane: 'midasus' } : { after: [lights[i].mark, lights[j].mark], lane: 'midasus' });
    }
  }
  return Object.freeze({ lights, threads, marks, walkers });
}
