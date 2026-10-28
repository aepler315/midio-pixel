// The cast in a real landscape, abstracted (brainstorm section 6, the
// "presence ladder"). Midio, Broshi and Midasus are no longer drawn as
// outlined meshes on top of the scene. Each is a small moving light in its
// own hue that lights the ground, trees and water around it, sits at a real
// depth, fades into the air and reflects in the lake. Around each light a
// loose swarm of motes wanders. What they do in a view -- climb its summit,
// or light its shore -- is docs/landscape-cast.md: CastJobs.js reads the
// terrain, CastSchedule.js sets when.
//
// Everything here is plain data: a per-song score compiled from each actor's
// lane (seek-safe, like the cloud sea), the per-song job schedule, and
// wandering routes for tour views. ActorsGL draws them.
import { MIDIO_IDENTITY_HUE } from '../../render/ColorLaw.js';
import { scenePoseAt, projectPoint } from '../terrain/SceneTravel.js';
import { terrainHeightAt } from './TerrainMesh.js';
import { compileCastSchedule } from './CastSchedule.js';
import { landscapeScoreFor } from './LandscapeScore.js';

export const ACTOR_IDS = Object.freeze(['midio', 'broshi', 'midasus']);
// Broshi's coral and Midasus's violet, as InhabitedShore.js names them
// (not imported: that module brings the 2D stage painters with it).
export const ACTOR_HUES = Object.freeze({ midio: MIDIO_IDENTITY_HUE, broshi: 16, midasus: 276 });

export const ACTOR_STEP_MS = 50;
/** Brightness follows the lane: fast attack, slow release. */
export const ACTOR_GLOW_ATTACK_MS = 120;
export const ACTOR_GLOW_RELEASE_MS = 900;
/** Travel rate (route lengths per second is set by the route): an idle
 *  actor drifts, a playing one moves with purpose. */
export const ACTOR_DRIFT = 0.2;
/** Midio's wake reaches back to where he was this long ago. */
export const ACTOR_WAKE_MS = 4000;
/** The lights arrive with the scene. */
export const ACTOR_ARRIVE_MS = [3000, 7000];
/** Each note the lane plays: a pulse of 1 at its onset, decaying with this
 *  time constant (the glow above is too slow to show single notes). */
export const ACTOR_PULSE_MS = 180;
/** A busy lane's pulse is damped by its onsets in this window up to the
 *  latest one: each past three costs a quarter, so a 16th-note line
 *  shimmers instead of strobing. */
export const ACTOR_PULSE_DENSE_MS = 500;
/** The swarm's height follows the lane's pitch, smoothed (attack and
 *  release) with this time constant: under .02 of spread per 50 ms step. */
export const ACTOR_PITCH_MS = 1250;
/** The swarm's vertical spread, from the lane's lowest pitch to its highest. */
export const ACTOR_SPREAD = Object.freeze([0.75, 1.25]);

const unit = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const EMPTY_ACTOR = Object.freeze({ glow: 0, travel: 0, pulse01: 0, spread: 1 });
/** How many of sorted `arr` are at or before `t`. */
const countThrough = (arr, t) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= t) lo = m + 1; else hi = m; }
  return lo;
};
/** A lane's note pulse at heard time `t` from its sorted onsets: only onsets
 *  at or before `t` count. The density is that of the window ending at the
 *  latest onset, so between notes the pulse only decays. */
const pulseAt = (onsets, t) => {
  const k = countThrough(onsets, t);
  if (!k) return 0;
  const last = onsets[k - 1];
  const dense = k - countThrough(onsets, last - ACTOR_PULSE_DENSE_MS);
  return Math.exp(-(t - last) / ACTOR_PULSE_MS) / (1 + Math.max(0, dense - 3) * 0.25);
};
/** A lane's onsets as a sorted, finite, distinct array (compiled once). */
const laneOnsets = (list) => {
  const sorted = Float64Array.from(Array.isArray(list) ? list.filter(Number.isFinite) : []).sort();
  return sorted.filter((v, i) => i === 0 || v !== sorted[i - 1]);
};

/**
 * Compile the cast's score for a song from `narrative` (compileLandscapeSources:
 * { durationMs, onsets[id], sample(t).sources[id].{ activity, pitch01,
 * pitchActivity } }). Returns { durationMs, at(timeMs) -> { midio: { glow,
 * travel, pulse01, spread }, ... } }: `pulse01` (0..1) flares on each of
 * the lane's notes, and `spread` (ACTOR_SPREAD, 1 when unknown) follows its
 * pitch, normalised to the lane's own range over the song.
 * Every value is a function of heard time only, so seeks read the same.
 */
export function compileActorScore(narrative) {
  const durationMs = narrative?.durationMs || 0;
  if (typeof narrative?.sample !== 'function' || !(durationMs > 0)) {
    return Object.freeze({ durationMs: 0, at: () => Object.fromEntries(ACTOR_IDS.map((id) => [id, { ...EMPTY_ACTOR }])) });
  }
  const n = Math.ceil(durationMs / ACTOR_STEP_MS) + 1;
  const act = Object.fromEntries(ACTOR_IDS.map((id) => [id, new Float32Array(n)]));
  // Voiced pitch per step (NaN where the lane has none).
  const pitch = Object.fromEntries(ACTOR_IDS.map((id) => [id, new Float32Array(n)]));
  for (let i = 0; i < n; i++) {
    const s = narrative.sample(Math.min(i * ACTOR_STEP_MS, durationMs))?.sources || {};
    for (const id of ACTOR_IDS) {
      act[id][i] = unit(s[id]?.activity);
      pitch[id][i] = unit(s[id]?.pitchActivity) > 0 && Number.isFinite(s[id]?.pitch01) ? unit(s[id].pitch01) : NaN;
    }
  }
  const dt = ACTOR_STEP_MS / 1000;
  const up = 1 - Math.exp(-ACTOR_STEP_MS / ACTOR_GLOW_ATTACK_MS), down = 1 - Math.exp(-ACTOR_STEP_MS / ACTOR_GLOW_RELEASE_MS);
  const along = 1 - Math.exp(-ACTOR_STEP_MS / ACTOR_PITCH_MS);
  const [spreadLo, spreadHi] = ACTOR_SPREAD;
  const curves = {};
  for (const id of ACTOR_IDS) {
    const a = act[id], pr = pitch[id];
    const glow = new Float32Array(n), travel = new Float32Array(n), spread = new Float32Array(n);
    // The lane's own pitch range, so Broshi's bass spreads as a melody does.
    // Under half a semitone (pitch01 is 60 semitones) it is one pitch.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (Number.isFinite(pr[i])) { lo = Math.min(lo, pr[i]); hi = Math.max(hi, pr[i]); }
    const span = hi - lo > 1 / 120 ? hi - lo : 0;
    let g = 0, tr = 0, ps = 0.5;
    for (let i = 0; i < n; i++) {
      g += (a[i] - g) * (a[i] > g ? up : down);
      glow[i] = g;
      travel[i] = tr;
      tr += (ACTOR_DRIFT + (1 - ACTOR_DRIFT) * g) * dt;
      // Only voiced steps move it: the last pitch holds through a rest.
      if (Number.isFinite(pr[i])) ps += ((span ? (pr[i] - lo) / span : 0.5) - ps) * along;
      spread[i] = spreadLo + (spreadHi - spreadLo) * ps;
    }
    curves[id] = { glow, travel, spread, onsets: laneOnsets(narrative.onsets?.[id] || []) };
  }
  const read = (arr, x) => {
    const i = Math.floor(x), f = x - i;
    return arr[i] + ((arr[Math.min(n - 1, i + 1)] ?? arr[i]) - arr[i]) * f;
  };
  return Object.freeze({
    durationMs,
    at(timeMs) {
      const t = Number.isFinite(timeMs) ? timeMs : 0;
      const x = Math.min(n - 1, Math.max(0, t / ACTOR_STEP_MS));
      const out = {};
      for (const id of ACTOR_IDS) {
        const c = curves[id];
        out[id] = { glow: read(c.glow, x), travel: read(c.travel, x), pulse01: pulseAt(c.onsets, t), spread: read(c.spread, x) };
      }
      return out;
    },
  });
}

const scoreCache = new WeakMap();
const scheduleCache = new WeakMap();
const scoreFor = (narrative) => {
  let score = scoreCache.get(narrative);
  if (!score) { score = compileActorScore(narrative); scoreCache.set(narrative, score); }
  return score;
};
/** The view a section is cast in: a diagnostic forced view everywhere,
 *  else the song terrain's choice for its biome. */
const viewOf = (assignments, forcedView) => (section) =>
  (forcedView || assignments?.get?.(section?.profile))?.view?.id ?? null;

/**
 * The cast's job schedule for the simulation's song, compiled once per song
 * and casting of views. A refreshed analysis of the same song keeps what
 * was already heard (through `timeMs`), as the landscape score does.
 */
export function castScheduleFor(sim, { sceneAssignments = null, forcedView = null, timeMs = 0 } = {}) {
  const mgr = sim?.biomes, narrative = sim?.rangeNarrative;
  if (!mgr || !narrative || typeof narrative !== 'object') return null;
  const landscape = landscapeScoreFor(mgr);
  const key = { narrative, sections: mgr.sections, landscape, durationMs: mgr.durationMs || narrative.durationMs,
    sceneAssignments, forced: forcedView?.view?.id ?? null };
  const hit = scheduleCache.get(mgr);
  if (hit && Object.keys(key).every((k) => hit.key[k] === key[k])) return hit.schedule;
  const schedule = compileCastSchedule({
    sections: mgr.sections || [], viewForSection: viewOf(sceneAssignments, forcedView),
    phrases: landscape.phrases, episodes: landscape.episodes, lanes: scoreFor(narrative), onsets: narrative.onsets || {},
    energyAt: mgr.energyCurves?.globalEnergyNorm?.bind(mgr.energyCurves), durationMs: key.durationMs,
    previous: hit && hit.key.durationMs === key.durationMs ? hit.schedule : null, committedThroughMs: hit ? timeMs : -1,
  });
  scheduleCache.set(mgr, { key, schedule });
  return schedule;
}

/** The cast's state at heard time for a simulation (compiled once per song).
 *  With `sceneAssignments` / `forcedView` (as buildRangeFrame has them),
 *  `jobs` holds each view's job state and `schedule` the compiled schedule. */
export function rangeActorsAt(sim, timeMs, { sceneAssignments = null, forcedView = null } = {}) {
  const narrative = sim?.rangeNarrative;
  if (!narrative || typeof narrative !== 'object') return null;
  const score = scoreFor(narrative);
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  const a = ACTOR_ARRIVE_MS;
  const x = unit((t - a[0]) / (a[1] - a[0]));
  const now = score.at(t);
  // Where Midio was a few seconds ago: the tail of his wake.
  now.midio.trail = score.at(t - ACTOR_WAKE_MS).midio.travel;
  const schedule = sceneAssignments || forcedView ? castScheduleFor(sim, { sceneAssignments, forcedView, timeMs: t }) : null;
  let jobs = schedule ? schedule.at(t) : null;
  // A diagnostic override (like the cloud sea's) holds job progress, so a
  // review can see a view's work at any stage without waiting for it.
  const forced = sim.biomes?.castProgressOverride;
  if (jobs && forced != null) {
    jobs = Object.fromEntries(Object.entries(jobs).map(([v, s]) => {
      const p = Number.isFinite(forced) ? forced : forced?.[v];
      if (!Number.isFinite(p) || !s) return [v, s];
      const done = p >= 1 ? 1 : 0;
      return [v, { ...s, p: unit(p), payoff01: done, fuse01: s.climax ? done : 0, override: true }];
    }));
  }
  return Object.freeze({ timeMs: t, presence: x * x * (3 - 2 * x), ...now, jobs, schedule });
}

export const ACTOR_MOTES = 72;

/** How each actor shows (pixels at the stage's 720 px height). `climbM` is
 *  the hover on a face (Midio's headlamp on rock). */
export const ACTOR_LOOK = Object.freeze({
  midio: { hoverM: 7, climbM: 2, haloPx: 30, wanderPx: 26, lightM: 140, lightGain: 2.4 },
  broshi: { hoverM: 4, climbM: 4, haloPx: 26, wanderPx: 30, lightM: 110, lightGain: 2.2 },
  // Midasus flies, but six feet up, keeping to the ground like the others.
  midasus: { hoverM: 1.83, climbM: 1.83, haloPx: 24, wanderPx: 22, lightM: 700, lightGain: 1.1 },
});

// --- Routes: where the cast wander in a tour view ---

export const ROUTE_ANCHORS = 5;
/** Rail stations a route must stay in frame at. */
export const ROUTE_STATIONS = Object.freeze([0.15, 0.5, 0.85]);
const ROUTE_ASPECT = 16 / 9;
/** In-frame window (NDC): clear of the frame edges and of the rock stage
 *  along the bottom. */
const FRAME_X = 0.72, FRAME_Y = [-0.5, 0.42];
const DEPTH_M = [700, 12000];
/** One route length takes this many travel units (ACTOR_DRIFT..1 per
 *  second), so a full sweep across the frame takes about a minute. */
export const ROUTE_UNITS = 40;
/** Where along its route each actor starts (travel units): Broshi sets
 *  out from the far end, so he and Midio do not move as one. */
export const ACTOR_START = Object.freeze({ midio: 0, broshi: ROUTE_UNITS, midasus: ROUTE_UNITS / 2 });

export function hash(seed, i) {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Spread `pool` across the frame: `bins` bins by screen x, one candidate
 *  from each (seeded), ordered left to right. */
export function pickAnchors(pool, seed, bins = ROUTE_ANCHORS) {
  if (pool.length < 2) return null;
  const sorted = [...pool].sort((a, b) => a.sx - b.sx);
  const k = Math.min(bins, sorted.length);
  const out = [];
  for (let b = 0; b < k; b++) {
    const lo = Math.floor((b * sorted.length) / k), hi = Math.max(lo + 1, Math.floor(((b + 1) * sorted.length) / k));
    out.push(sorted[lo + Math.floor(hash(seed, b) * (hi - lo))]);
  }
  return out.map((c) => [c.x, c.y, c.z]);
}

/**
 * Routes for a prepared view: { midio, broshi, midasus } each
 * { points: [[x,y,z]...], lengths, total, kind } or null. Midio skims the
 * lake (else the valley floor), Broshi follows the shore (else low open
 * ground), Midasus flies six feet over low open ground. Candidates are tile
 * samples visible from the rail that stay inside the frame at every
 * station.
 */
export function actorRoutes(data, view, { waterLevelM = null, seed = 0 } = {}) {
  const poses = ROUTE_STATIONS.map((u) => scenePoseAt(view, { progress01: u }));
  const { grid, cells } = data;
  const water = [], shore = [], land = [];
  for (const tile of data.tiles.values()) {
    if (!tile.visible) continue;
    const n = tile.samples, step = Math.max(1, Math.floor(n / 8));
    for (let v = 0; v < n; v += step) for (let u = 0; u < n; u += step) {
      const i = v * n + u, y = tile.heightsM[i];
      if (!Number.isFinite(y)) continue;
      const x = grid.originM[0] + (tile.ix * cells + u * tile.stride) * grid.cellSizeM;
      const z = grid.originM[1] + (tile.iz * cells + v * tile.stride) * grid.cellSizeM;
      const p = [x, y, z];
      const proj = poses.map((pose) => projectPoint(pose, ROUTE_ASPECT, p));
      if (proj.some((q) => !q || Math.abs(q.x) > FRAME_X || q.depth < DEPTH_M[0] || q.depth > DEPTH_M[1])) continue;
      const c = { x, y, z, sx: proj[1].x };
      const onGround = proj.every((q) => q.y >= FRAME_Y[0] && q.y <= FRAME_Y[1]);
      const flow = tile.flowBytes?.[i];
      const isWater = flow === 255 && Number.isFinite(waterLevelM) && Math.abs(y - waterLevelM) < 3;
      if (onGround) {
        if (isWater) water.push(c);
        else {
          let wet = false;
          for (const j of [i - step, i + step, i - step * n, i + step * n]) if (tile.flowBytes?.[j] === 255) wet = true;
          if (wet && Number.isFinite(waterLevelM) && y < waterLevelM + 40) shore.push(c);
          else land.push(c);
        }
      }
    }
  }
  const low = (pool) => {
    const ys = pool.map((c) => c.y).sort((a, b) => a - b);
    const cut = ys[Math.floor(ys.length * 0.3)];
    return pool.filter((c) => c.y <= cut);
  };
  const route = (points, kind) => {
    if (!points) return null;
    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const l = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
      lengths.push(l); total += l;
    }
    return total > 1 ? Object.freeze({ points, lengths, total, kind }) : null;
  };
  return Object.freeze({
    midio: route(water.length >= 8 ? pickAnchors(water, seed + 1) : pickAnchors(low(land), seed + 1), water.length >= 8 ? 'water' : 'ground'),
    broshi: route(shore.length >= 8 ? pickAnchors(shore, seed + 2) : pickAnchors(low(land), seed + 2), 'ground'),
    midasus: route(pickAnchors(low(land), seed + 3), 'ground'),
  });
}

/**
 * World position along `route` after `travel` units: back and forth along
 * the anchors (smoothed through them), at its hover height over the drawn
 * ground or water. `bobSec` adds a slow rise and fall.
 */
export function routePosition(route, travel, { data = null, waterLevelM = null, hoverM = 0, bobSec = 0 } = {}) {
  if (!route) return null;
  const P = route.points;
  const cycle = (travel / ROUTE_UNITS) % 2;
  let d = (cycle < 1 ? cycle : 2 - cycle) * route.total;
  let i = 0;
  while (i < route.lengths.length - 1 && d > route.lengths[i]) d -= route.lengths[i++];
  const f = route.lengths[i] ? Math.min(1, d / route.lengths[i]) : 0;
  // Catmull-Rom through the anchors: no corner at each turn.
  const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
  const cr = (a, b, c, e) => 0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - e) * f * f + (-a + 3 * b - 3 * c + e) * f * f * f);
  const x = cr(p0[0], p1[0], p2[0], p3[0]), z = cr(p0[2], p1[2], p2[2], p3[2]);
  const y = cr(p0[1], p1[1], p2[1], p3[1]);
  const bob = Math.sin(bobSec * 0.9) * 0.35 + Math.sin(bobSec * 2.3) * 0.15;
  const ground = data ? terrainHeightAt(data, x, z) : NaN;
  const base = Number.isFinite(ground) ? ground : y;
  const surface = route.kind === 'water' && Number.isFinite(waterLevelM) ? Math.max(base, waterLevelM) : base;
  return [x, surface + hoverM * (1 + bob * 0.4), z];
}
