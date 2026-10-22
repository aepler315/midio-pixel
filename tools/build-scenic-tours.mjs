// Discover, score, connect, select and package scenic shot tours for the
// approved scenic views (docs/scenic-tours.md).
//
//   node tools/build-scenic-tours.mjs --view <id>|all [--out DIR] [--workers N]
//        [--render] [--bake] [--publish]
//
// Without --publish everything lands in .smoke/scenic-tours/<viewId>/ for
// review: candidates.json (every scored candidate), library files, a
// footprint report and, with --render, renderer metrics and contact sheets.
// --bake re-culls the view's terrain for rail + library poses (only when
// the library needs tiles the shipped package lacks). --publish writes the
// library (and any re-culled terrain) into src/assets/range/v2 and records
// shotsManifestUrl in data/terrain/scenic-views.json; approval is a
// separate, reviewed step (tools/build-range-scene.mjs --approve).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadViewContext, buildClearance, heightAt } from './lib/scenic-terrain.mjs';
import { discoverSubjects, valleyPaths, shorelines } from './lib/scenic-features.mjs';
import { generateShots, poseTraits, LANDFORMS } from './lib/scenic-shots.mjs';
import { linkVariants, keepParetoLinks } from './lib/scenic-links.mjs';

import { SHOT_SCHEMA, SHOT_VERSION, packShotPaths, shotLibraryErrors, decodeShotLibrary, cameraFootprint } from '../src/world/terrain/ShotLibrary.js';
import { pathPoseAt } from '../src/world/terrain/ShotPath.js';
import { bakeTerrain, mirroredPose } from './lib/terrain-bake.mjs';
import { sampleFootprintPoses, validatePoses, rangeAssetBytes, RANGE_ASSET_LIMIT } from './lib/scenic-coverage.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { mirrorLevelFor } from '../src/world/alpine/WaterMirror.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = path.join(root, 'data', 'terrain', 'scenic-tours.json');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Defaults deep-merged with one region's overrides. */
export function regionConfig(doc, viewId) {
  const region = doc.regions?.[viewId];
  if (!region) throw new Error(`${viewId}: no region block in scenic-tours.json`);
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] || {}, v) : v;
    return out;
  };
  return { ...merge(doc.defaults, region.overrides || {}), region };
}

// ---------------------------------------------------------------------------
// Scoring pool

class ScorePool {
  constructor(viewId, size) {
    this.workers = []; this.queue = []; this.pending = new Map(); this.next = 0;
    this.ready = Promise.all(Array.from({ length: size }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./lib/scenic-score-worker.mjs', import.meta.url), { workerData: { viewId, root } });
      w.busy = false;
      w.on('message', (m) => {
        if (m.ready) { this.workers.push(w); resolve(); this.pump(); return; }
        const job = this.pending.get(m.id); this.pending.delete(m.id); w.busy = false;
        if (m.error) job.reject(new Error(m.error)); else job.resolve(m.result);
        this.pump();
      });
      w.on('error', reject);
    })));
  }
  score(kind, p, opts) {
    return new Promise((resolve, reject) => { this.queue.push({ id: this.next++, kind, path: p, opts, resolve, reject }); this.pump(); });
  }
  pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift(); w.busy = true; this.pending.set(job.id, job);
      w.postMessage({ id: job.id, kind: job.kind, path: { s: job.path.s, eye: job.path.eye, aim: job.path.aim, fov: job.path.fov }, opts: job.opts });
    }
  }
  close() { return Promise.all(this.workers.map((w) => w.terminate())); }
}

// ---------------------------------------------------------------------------
// Payoff and hold from scored samples

/** Where the payoff lands and the sustained window around it. */
export function refinePayoff(record, scored) {
  const L = record.lengthM, samples = scored.samples;
  if (!samples?.length) return { payoffS: L * record.payoffFrac, holdS: [L * 0.35, L * 0.85] };
  const value = (x) => x.composition * (0.4 + 0.6 * x.subject);
  let best = null;
  if (record.move === 'reveal') {
    // The first sample where the subject is well visible after being hidden.
    let hidden = false;
    for (const x of samples) {
      if ((x.visible ?? 0) < 0.4) hidden = true;
      if (hidden && (x.visible ?? 0) >= 0.85) { best = x; break; }
    }
  }
  if (!best) {
    const want = record.payoffFrac * L;
    for (const x of samples) {
      if (x.s < 0.25 * L) continue;
      const v = value(x) * (1 - 0.35 * Math.abs(x.s - want) / L);
      if (!best || v > best.v) best = { ...x, v };
    }
  }
  const payoffS = clamp(best?.s ?? record.payoffFrac * L, 0.2 * L, L);
  const ref = value(samples.reduce((a, b) => (Math.abs(b.s - payoffS) < Math.abs(a.s - payoffS) ? b : a)));
  let a = payoffS, b = payoffS;
  for (const x of samples) if (x.s <= payoffS && value(x) >= 0.8 * ref) a = Math.min(a, x.s);
  for (const x of samples) if (x.s >= payoffS && value(x) >= 0.8 * ref) b = Math.max(b, x.s);
  return { payoffS, holdS: [Math.min(a, payoffS - 0.08 * L, payoffS), Math.max(b, Math.min(L, payoffS + 0.08 * L))].map((v) => clamp(v, 0, L)) };
}

/** Comfortable duration range from the flow lane: the fastest the picture
 *  may move at full energy, the calm pace, and a slow drift floor. */
export function durationRange(p, flow, motion) {
  let fast = 0, calm = 0;
  for (let i = 1; i < p.s.length; i++) {
    const ds = p.s[i] - p.s[i - 1], f = Math.max(1e-5, (flow[i] + flow[i - 1]) / 2);
    fast += ds / Math.min(motion.maxSpeedMps, motion.flowEnergetic / f);
    calm += ds / Math.min(motion.maxSpeedMps, motion.flowCalm / f);
  }
  const L = p.s[p.s.length - 1];
  return { min: Math.round(fast * 1000), ideal: Math.round(clamp((fast + calm) / 2, fast, calm) * 1000), max: Math.round(Math.max(calm, L / motion.minSpeedMps) * 1000) };
}

// ---------------------------------------------------------------------------

export async function buildViewTours(viewId, { out, workers = Math.max(2, os.cpus().length - 4), log = console.log } = {}) {
  const t0 = Date.now();
  const config = regionConfig(JSON.parse(await fs.readFile(CONFIG, 'utf8')), viewId);
  const ctx = await loadViewContext(viewId, { root });
  ctx.clearance = buildClearance(ctx, config.clearance);
  ctx.heightAt = (x, z) => heightAt(ctx.grid, x, z);
  ctx.lenses = config.lensFovYDeg; ctx.standoffM = config.clearance.subjectStandoffM; ctx.boundaryMarginM = config.clearance.boundaryMarginM;
  // The tour stays in one coherent area around what the authored rail
  // frames (and the region's heroes): subjects and moves outside it would
  // only connect through long transits and pull in far terrain.
  const found = discoverSubjects(ctx, config.region, config);
  const focus = focusArea(found, config);
  const subjects = found.filter((s) => s.kind === 'rail-target' || Math.hypot(s.posM[0] - focus.center[0], s.posM[2] - focus.center[2]) <= focus.radiusM);
  ctx.focus = focus;
  // Views whose water is mapped rivers only (or none) have no DEM lakes to run along.
  const mappedWater = ctx.view.riverPolicy?.terrainWater === 'mapped-only' || ctx.view.water === false;
  const lines = { valleys: valleyPaths(ctx), shores: mappedWater ? [] : shorelines(ctx) };
  log(`${viewId}: ${subjects.length} subjects (${subjects.map((s) => s.name || s.kind).join(', ')}); ${lines.valleys.length} valleys, ${lines.shores.length} shores`);
  const generated = generateShots(ctx, subjects, lines, config.region, { maxPerSubject: config.discovery.shotsPerSubject * 6 });
  const candidates = generated.filter((c) => inFocus(c.path, focus));
  log(`${viewId}: ${candidates.length} candidate shots`);
  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const pool = new ScorePool(viewId, workers);
  await pool.ready;
  try {
    // Pass 1: coarse scores for every candidate.
    const coarse = await Promise.all(candidates.map((c) => pool.score('shot', c.path, {
      subject: subjectById.get(c.subjectId), subjects, lens: c.traits.lens, move: c.move,
      payoffS: c.lengthM * c.payoffFrac, holdS: [c.lengthM * 0.35, c.lengthM * 0.9], everyM: Math.max(150, c.lengthM / 6), width: 96, height: 54 })));
    candidates.forEach((c, i) => { c.coarse = coarse[i].aggregate; });
    // Keep the best per (subject, move) and per subject, plus the rail.
    const bySubject = new Map();
    for (const c of candidates) {
      if (!bySubject.has(c.subjectId)) bySubject.set(c.subjectId, []);
      bySubject.get(c.subjectId).push(c);
    }
    const second = candidates.filter((c) => c.move === 'rail');
    for (const list of bySubject.values()) {
      const ranked = list.filter((c) => c.move !== 'rail' && c.coarse.holes < 0.5).sort((a, b) => b.coarse.total - a.coarse.total || a.id.localeCompare(b.id));
      const perMove = new Map();
      for (const c of ranked) {
        const key = [c.move, ...(c.tags || [])].join('+'), k = perMove.get(key) || 0;
        if (k < 3 && second.filter((x) => x.subjectId === c.subjectId).length < config.discovery.shotsPerSubject * 2) { second.push(c); perMove.set(key, k + 1); }
      }
    }
    // Pass 2: full scores and flow lanes.
    const full = await Promise.all(second.map((c) => pool.score('shot', c.path, {
      subject: subjectById.get(c.subjectId), subjects, lens: c.traits.lens, move: c.move,
      payoffS: c.lengthM * c.payoffFrac, holdS: [c.lengthM * 0.35, c.lengthM * 0.9], everyM: 60 })));
    second.forEach((c, i) => {
      c.scored = full[i]; c.path.flow = Float32Array.from(full[i].flow);
      Object.assign(c, refinePayoff(c, full[i]));
      c.score = { ...full[i].aggregate, render: null };
      c.traits = { ...c.traits, ...poseTraits(ctx, c.path, c.payoffS, subjectById.get(c.subjectId), c.traits.lens),
        foreground: full[i].samples.reduce((a, b) => (Math.abs(b.s - c.payoffS) < Math.abs(a.s - c.payoffS) ? b : a)).foreground ?? 0 };
      c.durationMs = durationRange(c.path, c.path.flow, config.motion);
    });
    // Tiles each candidate's frames need beyond the shipped package: the
    // terrain it would cost (selection charges only the new ones).
    const needs = await Promise.all(second.map((c) => pool.score('missing', c.path, {})));
    second.forEach((c, i) => { c.missing = needs[i]; });
    // Shortlist: best shots with diversity across subjects, moves and views.
    const shortlist = selectShots(second, config);
    log(`${viewId}: scored ${second.length}, shortlisted ${shortlist.length}: ${shortlist.map((s) => `${s.move}:${s.score.total.toFixed(2)}`).join(' ')}`);
    // Links: every ordered pair within reach, every variant scored, then
    // the Pareto front per pair and the best few per shot.
    const pairs = [];
    for (const a of shortlist) for (const b of shortlist) if (a !== b) for (const v of linkVariants(ctx, a, b, { linkMaxM: config.discovery.linkMaxM, transitMaxM: config.discovery.transitMaxM })) pairs.push({ from: a, to: b, ...v });
    log(`${viewId}: ${pairs.length} link variants`);
    const linkScores = await Promise.all(pairs.map((l) => pool.score('link', l.path, { everyM: 120, width: 96, height: 54 })));
    pairs.forEach((l, i) => { l.score = linkScores[i].aggregate; l.path.flow = Float32Array.from(linkScores[i].flow); l.durationMs = durationRange(l.path, l.path.flow, config.motion); });
    const linkNeeds = await Promise.all(pairs.map((l) => (l.score.holes > 0.002 ? [] : pool.score('missing', l.path, { everyM: 250 }))));
    pairs.forEach((l, i) => { l.missing = linkNeeds[i]; });
    const links = selectLinks(pairs, shortlist, config);
    const connected = shortlist.filter((s) => links.some((l) => l.from === s) && links.some((l) => l.to === s));
    log(`${viewId}: kept ${links.length} links; ${connected.length}/${shortlist.length} shots connected both ways`);
    const library = { subjects, shots: connected, links: links.filter((l) => connected.includes(l.from) && connected.includes(l.to)) };
    // Footprint: tiles the library needs beyond the shipped package.
    const need = new Set(), records = [...library.shots, ...library.links];
    const missing = await Promise.all(records.map((r) => pool.score('missing', r.path, {})));
    records.forEach((r, i) => { r.missing = missing[i]; for (const t of missing[i]) need.add(t); });
    const report = {
      viewId, builtAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, config,
      focus: ctx.focus, subjects, candidates: candidates.length,
      candidateScores: candidates.map((c) => ({ id: c.id, move: c.move, tags: c.tags, elevation: c.traits.elevation, lens: c.traits.lens,
        coarse: c.coarse ? { total: c.coarse.total, holes: c.coarse.holes, payoff: c.coarse.payoff } : null, full: c.score?.total ?? null })), scored: second.length, shortlisted: shortlist.length, linkVariants: pairs.length,
      shots: library.shots.map((s) => ({ id: s.id, move: s.move, subjectId: s.subjectId, lengthM: s.lengthM, payoffS: s.payoffS, holdS: s.holdS, score: s.score, traits: s.traits, durationMs: s.durationMs })),
      links: library.links.map((l) => ({ from: l.from.id, to: l.to.id, kind: l.kind, lengthM: l.lengthM, score: l.score })),
      missingTiles: [...need].sort((a, b) => a - b),
    };
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    log(`${viewId}: library ${library.shots.length} shots / ${library.links.length} links, ${need.size} tiles beyond the shipped package, ${report.seconds.toFixed(0)} s`);
    return { ctx, config, library, report };
  } finally { await pool.close(); }
}

/** The tour's area: centred between the rail target and the hero
 *  subjects, focusRadiusM across (config.discovery). */
export function focusArea(subjects, config) {
  const rail = subjects.find((s) => s.kind === 'rail-target');
  const heroes = subjects.filter((s) => (config.region.hero || []).includes(s.name));
  const anchors = [rail, ...heroes].filter(Boolean);
  const center = [0, 2].map((k) => anchors.reduce((a, s) => a + s.posM[k], 0) / Math.max(1, anchors.length));
  return { center: [center[0], 0, center[1]], radiusM: config.region.focusRadiusM ?? LANDFORMS[config.region.landform]?.focusM ?? config.discovery.focusRadiusM };
}

/** Whether a path's eye stays within the focus area (plus a margin). */
export function inFocus(p, focus, marginM = 2500) {
  const r = focus.radiusM + marginM;
  for (let i = 0; i < p.s.length; i += 4) if (Math.hypot(p.eye[i * 3] - focus.center[0], p.eye[i * 3 + 2] - focus.center[2]) > r) return false;
  return true;
}

/** Diverse shortlist: greedy by score with penalties for repeating a
 *  subject, a move, a viewing azimuth or an elevation class. */
export function selectShots(scored, config) {
  const max = config.discovery.maxShots, perSubject = config.discovery.shotsPerSubject;
  const out = scored.filter((c) => c.move === 'rail');
  const rest = scored.filter((c) => c.move !== 'rail' && c.score.holes <= 0.002 && c.score.total > 0);
  // New terrain: each tile beyond the shipped package and the shots already
  // chosen costs score (config.discovery.tileWeight per 100 tiles).
  const owned = new Set(out.flatMap((o) => o.missing || []));
  const tileWeight = config.discovery.tileWeight ?? 0.25;
  while (out.length < max && rest.length) {
    let best = null;
    for (const c of rest) {
      const same = out.filter((o) => o.subjectId === c.subjectId);
      if (same.length >= perSubject) continue;
      let v = c.score.total - tileWeight * (c.missing || []).filter((t) => !owned.has(t)).length / 100;
      if (v <= 0) continue;
      v *= 1 - 0.12 * same.length;
      v *= 1 - 0.1 * out.filter((o) => o.move === c.move).length / Math.max(1, out.length);
      // Variety across the whole library: elevations and lenses, not only moves.
      v *= 1 - 0.25 * out.filter((o) => o.traits.elevation === c.traits.elevation).length / Math.max(1, out.length);
      v *= 1 - 0.15 * out.filter((o) => o.traits.lens === c.traits.lens).length / Math.max(1, out.length);
      for (const o of same) {
        const dAz = Math.abs(((o.traits.azimuthDeg - c.traits.azimuthDeg + 540) % 360) - 180);
        if (dAz < 25 && o.traits.elevation === c.traits.elevation) v *= 0.55;
      }
      if (!best || v > best.v || (v === best.v && c.id < best.c.id)) best = { c, v };
    }
    if (!best) break;
    out.push(best.c);
    for (const t of best.c.missing || []) owned.add(t);
    rest.splice(rest.indexOf(best.c), 1);
  }
  return out;
}

/** Pareto per pair, then at most maxLinksPerShot per origin, preferring
 *  distinct destinations and keeping each destination reachable. */
export function selectLinks(pairs, shots, config) {
  const byPair = new Map();
  for (const l of pairs) {
    if (l.score.holes > 0.002) continue;
    const k = `${l.from.id}>${l.to.id}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(l);
  }
  const front = [...byPair.values()].flatMap((v) => keepParetoLinks(v, 2));
  const out = [];
  for (const s of shots) {
    // A link's worth is its scenery per second it costs the song, less the
    // new terrain it would add beyond the shots' own.
    const owned = new Set(shots.flatMap((x) => x.missing || []));
    const worth = (l) => l.score.total / (1 + (l.durationMs?.ideal ?? l.lengthM * 40) / 20000)
      - (config.discovery.tileWeight ?? 0.25) * (l.missing || []).filter((t) => !owned.has(t)).length / 100;
    const mine = front.filter((l) => l.from === s).sort((a, b) => worth(b) - worth(a) || a.lengthM - b.lengthM);
    const seen = new Set();
    for (const l of mine) {
      if (out.filter((x) => x.from === s).length >= config.discovery.maxLinksPerShot) break;
      if (seen.has(l.to.id) && out.filter((x) => x.from === s).length >= config.discovery.maxLinksPerShot / 2) continue;
      seen.add(l.to.id); out.push(l);
    }
  }
  // Every shot keeps at least one way in when one exists.
  for (const s of shots) if (!out.some((l) => l.to === s)) {
    const best = front.filter((l) => l.to === s).sort((a, b) => b.score.total - a.score.total)[0];
    if (best) out.push(best);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actual-renderer review: each library shot at its start, payoff, end of
// hold and exit, through the production terrain material and forest.

/** Renderer score for one shot from its rendered key frames (0..1): no
 *  holes, the subject actually visible at the payoff, real contrast. */
export function renderScore(frames) {
  const payoff = frames[1]?.metrics || {};
  if (frames.some((f) => (f.metrics?.holes ?? 0) > 0.003)) return 0;
  const visible = payoff.subject ? clamp(payoff.subject.visible ?? 0, 0, 1) : 0.6;
  const contrast = clamp((payoff.luminance?.localContrast ?? 0.05) / 0.08, 0, 1);
  const terrain = clamp(1 - Math.abs((payoff.terrainFrac ?? 0.6) - 0.6) / 0.45, 0, 1);
  return 0.45 * visible + 0.3 * contrast + 0.25 * terrain;
}

export async function renderReview(viewId, library, { out, width = 480, height = 270, sheet = true, terrain = null, log = console.log } = {}) {
  const { openShotReview, contactSheet } = await import('./lib/scenic-render.mjs');
  const session = await openShotReview(viewId, { cameraPaths: cameraFootprint(library), width, height, terrain });
  const pngs = [], labels = [], results = new Map();
  try {
    for (const shot of library.shots) {
      const subject = library.subjects.find((x) => x.id === shot.subjectId);
      const at = [0.04 * shot.lengthM, shot.payoffS, shot.holdS[1], 0.97 * shot.lengthM];
      const poses = at.map((x) => ({ ...pathPoseAt(shot.path, x), subject }));
      const frames = await session.renderPoses(poses, { mode: 'material' });
      const silhouettes = await session.renderPoses(poses, { mode: 'silhouette' });
      frames.forEach((f, i) => { f.metrics = { ...f.metrics, ...silhouettes[i].metrics, subject: f.metrics?.subject ?? silhouettes[i].metrics?.subject }; });
      const score = renderScore(frames);
      results.set(shot.id, { score, frames: frames.map((f) => ({ metrics: f.metrics, ms: f.ms })) });
      frames.forEach((f, i) => { pngs.push(Buffer.from(f.png, 'base64')); labels.push(`${shot.move} ${['in', 'payoff', 'hold', 'out'][i]} ${shot.score.total.toFixed(2)}/${score.toFixed(2)}`); });
    }
  } finally { await session.close(); }
  if (sheet && pngs.length) await contactSheet(pngs, { columns: 4, labels, out: path.join(out, `${viewId}-shots.png`), tileWidth: 320 });
  log(`${viewId}: rendered ${library.shots.length} shots`);
  return results;
}

// ---------------------------------------------------------------------------
// Terrain coverage: re-cull the view's package for rail + library poses

/** Median height of a package's hydro-flattened water samples (RangeScene). */
export function waterLevelOf(data) {
  const hs = [];
  for (const t of data.tiles.values()) {
    if (!t.flowBytes) continue;
    for (let i = 0; i < t.flowBytes.length; i += 7) if (t.flowBytes[i] === 255 && Number.isFinite(t.heightsM[i])) hs.push(t.heightsM[i]);
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return hs[hs.length >> 1];
}

/** The poses a library's frames (and, where a lake mirrors, their
 *  reflections) need covered. */
export function libraryPoses(ctx, library, { spacingM = 120, maxPoses = 2600 } = {}) {
  let poses = sampleFootprintPoses([...library.shots, ...library.links], { spacingM, maxPoses });
  const mapped = ctx.view.riverPolicy?.terrainWater === 'mapped-only';
  const level = mapped ? null : mirrorLevelFor(ctx.terrain.data, waterLevelOf(ctx.terrain.data));
  if (level != null) poses = poses.concat(poses.filter((_, i) => i % 2 === 0).map((p) => mirroredPose(p, level)));
  return { poses, mirrorLevelM: level };
}

/**
 * Validate the library against the shipped package; when tiles or detail
 * are missing, bake a superset package (rail stations + library poses,
 * same options build-range-scene.mjs uses) and validate that. Returns
 * { rebaked, manifest, payload, data, validation, budget }.
 */
export async function bakeForLibrary(ctx, library, config, { log = console.log } = {}) {
  const { poses, mirrorLevelM } = libraryPoses(ctx, library);
  // Tour frames are held to the tour pixel budget (the rail keeps its own).
  const scale = config.budget.poseErrorScale ?? 3, check = { errorPx: scale, extendedErrorPx: 3 * scale };
  const shipped = validatePoses(ctx, poses, check);
  log(`${ctx.viewId}: ${poses.length} footprint poses${mirrorLevelM != null ? ` (mirror at ${mirrorLevelM.toFixed(1)} m)` : ''}; shipped package: ${shipped.holes.length} poses with holes, ${shipped.lod.length} LOD violations`);
  if (shipped.ok) return { rebaked: false, validation: shipped, poses };
  const camera = ctx.build.view.camera;
  const options = { landmarks: ctx.build.landmarks, dataUrl: `${ctx.viewId}.terrain.bin.gz`, ...(ctx.view.water === false ? { water: false } : {}),
    ...(camera.eyeArcM || camera.targetArcM ? { visibility: { stations: 61 } } : {}) };
  // The rail-only bake must reproduce the shipped heights, or the source
  // has drifted since the view was approved (reported, not hidden).
  const rail = await bakeTerrain(ctx.grid, ctx.build.view, options);
  const drift = rail.manifest.payload.sha256 !== ctx.terrain.manifest.payload.sha256;
  const baked = await bakeTerrain(ctx.grid, ctx.build.view, { ...options, poses, poseErrorScale: scale });
  const data = decodeTerrain(baked.manifest, new Uint8Array(baked.decoded));
  const validation = validatePoses({ ...ctx, terrain: { manifest: baked.manifest, data } }, poses, check);
  const manifestText = JSON.stringify(baked.manifest) + '\n';
  const before = Buffer.byteLength(JSON.stringify(ctx.terrain.manifest) + '\n') + ctx.terrain.manifest.payload.byteLength;
  const budget = { addedBytes: Buffer.byteLength(manifestText) + baked.payload.byteLength - before,
    desktopTriangles: baked.manifest.estimatedBytes.desktop.triangles, mobileTriangles: baked.manifest.estimatedBytes.mobile.triangles,
    tiles: baked.manifest.tiles.length, shippedTiles: ctx.terrain.manifest.tiles.length, sourceDrift: drift };
  log(`${ctx.viewId}: re-culled package ${budget.shippedTiles} -> ${budget.tiles} tiles, +${(budget.addedBytes / 1024).toFixed(0)} KiB, desktop ${budget.desktopTriangles} / mobile ${budget.mobileTriangles} triangles; ${validation.holes.length} poses with holes, ${validation.lod.length} LOD violations${drift ? '; SOURCE DRIFT: the rail-only bake differs from the shipped package' : ''}`);
  return { rebaked: true, manifest: baked.manifest, manifestText, payload: baked.payload, data, validation, budget, poses };
}

/** Budget problems for a candidate library + terrain (empty = within). */
export async function budgetErrors(ctx, config, packed, bake) {
  const errors = [], b = config.budget;
  const added = (bake.rebaked ? bake.budget.addedBytes : 0) + Buffer.byteLength(packed.manifestText) + packed.payload.byteLength;
  if (added > b.assetBytes) errors.push(`adds ${added} bytes, over the region's ${b.assetBytes}`);
  if (bake.rebaked && bake.budget.desktopTriangles > b.desktopTriangles) errors.push(`desktop ${bake.budget.desktopTriangles} triangles, over ${b.desktopTriangles}`);
  if (bake.rebaked && bake.budget.mobileTriangles > b.mobileTriangles) errors.push(`mobile ${bake.budget.mobileTriangles} triangles, over ${b.mobileTriangles}`);
  const total = await rangeAssetBytes(root);
  if (total + added > RANGE_ASSET_LIMIT) errors.push(`Range assets would reach ${total + added} bytes, over ${RANGE_ASSET_LIMIT}`);
  return { errors, added };
}

// ---------------------------------------------------------------------------
// Packing

const round = (v, k = 1000) => Math.round(v * k) / k;

/** The midio.shots manifest + gzip payload for a selected library. */
export function packLibrary(viewId, regionId, terrainManifestSha256, library, provenance = {}) {
  const used = new Set(library.shots.map((s) => s.subjectId));
  const subjects = library.subjects.filter((s) => used.has(s.id)).map((s) => ({ id: s.id, kind: s.kind, name: s.name || null,
    posM: s.posM.map((v) => round(v, 10)), radiusM: round(s.radiusM, 10), heightM: round(s.heightM || 0, 10) }));
  const shots = library.shots.map((s) => ({ id: s.id, subjectId: s.subjectId, move: s.move, path: s.path, lengthM: round(s.lengthM, 10),
    payoffS: round(s.payoffS, 10), holdS: s.holdS.map((v) => round(v, 10)), durationMs: s.durationMs,
    traits: Object.fromEntries(Object.entries(s.traits).map(([k, v]) => [k, typeof v === 'number' ? round(v, 100) : v])),
    score: Object.fromEntries(Object.entries(s.score).filter(([, v]) => v === null || typeof v === 'number').map(([k, v]) => [k, v === null ? null : round(v)])),
    tags: s.tags || [] }));
  const ids = new Map();
  const links = library.links.map((l, i) => {
    const base = `link-${l.from.id}-${l.to.id}-${l.kind}${l.kind === 'arc' ? (l.side > 0 ? 'R' : 'L') : ''}`;
    const id = ids.has(base) ? `${base}-${i}` : base; ids.set(base, true);
    return { id, from: l.from.id, to: l.to.id, kind: l.kind, path: l.path, lengthM: round(l.lengthM, 10), durationMs: l.durationMs,
      score: { total: round(l.score.total), weakest: round(l.score.weakest ?? 0), composition: round(l.score.composition ?? 0) } };
  });
  const decoded = Buffer.from(packShotPaths([...shots, ...links]));
  const payload = zlib.gzipSync(decoded, { level: 9, mtime: 0 });
  payload[4] = payload[5] = payload[6] = payload[7] = 0; payload[9] = 255;
  const strip = (r) => { const { path: _p, ...rest } = r; return rest; };
  const manifest = {
    schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId, regionId, terrainManifestSha256,
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' },
    subjects, shots: shots.map(strip), links: links.map(strip),
    payload: { url: `${viewId}.shots.bin.gz`, encoding: 'gzip', byteLength: payload.byteLength, sha256: sha(payload),
      decodedByteLength: decoded.byteLength, decodedSha256: sha(decoded) },
    provenance,
  };
  const errors = shotLibraryErrors(manifest, { viewId, decodedByteLength: decoded.byteLength });
  if (errors.length) throw new Error(`${viewId}: packed library invalid: ${errors.join('; ')}`);
  decodeShotLibrary(manifest, new Uint8Array(decoded)); // round trip
  return { manifest, manifestText: JSON.stringify(manifest) + '\n', payload, decoded };
}

// ---------------------------------------------------------------------------
// Fit to budget, write, publish

const TERRAIN_DIR = path.join(root, 'src', 'assets', 'range', 'v2', 'terrain');
const TOUR_DIR = path.join(root, 'src', 'assets', 'range', 'v2', 'tour');

/** Remove a shot and its links; then shots left without a way in or out. */
function dropShot(library, shot) {
  let shots = library.shots.filter((s) => s !== shot), links = library.links.filter((l) => l.from !== shot && l.to !== shot);
  for (let changed = true; changed;) {
    const keep = shots.filter((s) => s.move === 'rail' || (links.some((l) => l.from === s) && links.some((l) => l.to === s)));
    changed = keep.length !== shots.length;
    shots = keep; links = links.filter((l) => shots.includes(l.from) && shots.includes(l.to));
  }
  return { ...library, shots, links };
}

/**
 * Bake, pack and measure; while the region is over its byte or triangle
 * budget (or the shared 60 MB), drop the shot whose terrain is most its
 * own per unit of score, and try again. Returns the fitted result.
 */
export async function fitToBudget(built, { log = console.log, maxIterations = Infinity } = {}) {
  const { ctx, config } = built;
  const shippedSha = sha(await fs.readFile(path.join(TERRAIN_DIR, `${ctx.viewId}.terrain.json`)));
  let library = { ...built.library };
  for (let iter = 1; ; iter++) {
    const bake = await bakeForLibrary(ctx, library, config, { log });
    const terrainSha = bake.rebaked ? sha(bake.manifestText) : shippedSha;
    const packed = packLibrary(ctx.viewId, ctx.view.regionId, terrainSha, library,
      { builtWith: 'tools/build-scenic-tours.mjs', configSha256: sha(JSON.stringify(config)), demSha256: ctx.grid.meta?.payload?.heights?.sha256 ?? null });
    const budget = await budgetErrors(ctx, config, packed, bake);
    log(`${ctx.viewId}: fit ${iter}: ${library.shots.length} shots / ${library.links.length} links, adds ${(budget.added / 1024).toFixed(0)} KiB${budget.errors.length ? ` -- ${budget.errors.join('; ')}` : ' -- within budget'}`);
    if (!budget.errors.length) return { library, bake, packed, budget, iterations: iter };
    if (iter >= maxIterations) return { library, bake, packed, budget, iterations: iter, failed: true, survey: true };
    const records = [...library.shots, ...library.links];
    let worst = null;
    for (const shot of library.shots) {
      if (shot.move === 'rail') continue;
      const own = new Set(shot.missing || []);
      for (const l of library.links) if (l.from === shot || l.to === shot) for (const t of l.missing || []) own.add(t);
      const others = new Set();
      for (const r of records) if (r !== shot && r.from !== shot && r.to !== shot) for (const t of r.missing || []) others.add(t);
      const unique = [...own].filter((t) => !others.has(t)).length;
      // What the shot alone brings to the library: the only move, elevation
      // or subject of its kind is worth keeping at a higher terrain cost.
      const alone = (key) => library.shots.filter((o) => o !== shot && key(o) === key(shot)).length === 0;
      const rarity = 1 + 1.5 * alone((o) => o.move + (o.tags || []).join('+')) + 1.5 * alone((o) => o.traits.elevation) + 0.8 * alone((o) => o.subjectId);
      const cost = (unique + 1) / (Math.max(0.05, shot.score.total) * rarity);
      if (!worst || cost > worst.cost) worst = { shot, cost, unique };
    }
    if (!worst || library.shots.length <= 4) return { library, bake, packed, budget, iterations: iter, failed: true };
    log(`${ctx.viewId}: dropping ${worst.shot.id} (${worst.unique} tiles of its own)`);
    library = dropShot(library, worst.shot);
  }
}

/** Write the fitted library (and re-culled terrain) to `out`. */
export async function writeFitted(out, viewId, fitted) {
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${viewId}.shots.json`), fitted.packed.manifestText);
  await fs.writeFile(path.join(out, `${viewId}.shots.bin.gz`), fitted.packed.payload);
  if (fitted.bake.rebaked) {
    await fs.writeFile(path.join(out, `${viewId}.terrain.json`), fitted.bake.manifestText);
    await fs.writeFile(path.join(out, `${viewId}.terrain.bin.gz`), fitted.bake.payload);
  }
  await fs.writeFile(path.join(out, 'fit.json'), JSON.stringify({ iterations: fitted.iterations, failed: !!fitted.failed, budget: fitted.budget,
    bake: { rebaked: fitted.bake.rebaked, budget: fitted.bake.budget || null, validation: { ok: fitted.bake.validation.ok, worst: fitted.bake.validation.worst,
      holes: fitted.bake.validation.holes.length, lod: fitted.bake.validation.lod.length } },
    shots: fitted.packed.manifest.shots.length, links: fitted.packed.manifest.links.length,
    libraryBytes: Buffer.byteLength(fitted.packed.manifestText) + fitted.packed.payload.byteLength }, null, 1));
}

/**
 * Publish: the library into src/assets/range/v2/tour, the re-culled terrain
 * (if any) over the view's package with its build record updated, and
 * shotsManifestUrl into scenic-views.json; then regenerate the catalog.
 * The view ships as a candidate until it is re-approved (build-range-scene
 * --approve), which is a separate, reviewed step.
 */
export async function publishView(viewId, fitted, { log = console.log } = {}) {
  if (fitted.failed || !fitted.bake.validation.ok) throw new Error(`${viewId}: not publishable (budget or validation failed)`);
  await fs.mkdir(TOUR_DIR, { recursive: true });
  await fs.writeFile(path.join(TOUR_DIR, `${viewId}.shots.json`), fitted.packed.manifestText);
  await fs.writeFile(path.join(TOUR_DIR, `${viewId}.shots.bin.gz`), fitted.packed.payload);
  if (fitted.bake.rebaked) {
    await fs.writeFile(path.join(TERRAIN_DIR, `${viewId}.terrain.json`), fitted.bake.manifestText);
    await fs.writeFile(path.join(TERRAIN_DIR, `${viewId}.terrain.bin.gz`), fitted.bake.payload);
    const buildPath = path.join(TERRAIN_DIR, `${viewId}.build.json`);
    const build = JSON.parse(await fs.readFile(buildPath, 'utf8'));
    const m = fitted.bake.manifest;
    Object.assign(build, { manifestSha256: sha(fitted.bake.manifestText), payloadSha256: m.payload.sha256, payloadBytes: fitted.bake.payload.byteLength,
      stats: { tiles: m.tiles.length, ...m.estimatedBytes }, achievedErrorPx: m.lod.achievedErrorPx,
      tourFootprint: { shotsManifestSha256: sha(fitted.packed.manifestText), poses: m.lod.poses } });
    await fs.writeFile(buildPath, JSON.stringify(build, null, 1) + '\n');
  }
  const { readAuthoring, AUTHORING } = await import('./build-range-scene.mjs');
  const doc = await readAuthoring();
  const v = doc.views.find((x) => x.id === viewId);
  v.shotsManifestUrl = `tour/${viewId}.shots.json`;
  await fs.writeFile(AUTHORING, JSON.stringify(doc, null, 2) + '\n');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(root, 'tools', 'build-range-scene.mjs'), '--catalog'], { stdio: 'inherit' });
  log(`${viewId}: published; re-approve with: node tools/build-range-scene.mjs --approve ${viewId} --evidence docs/scenic-tours.md`);
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const doc = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
  const id = opt('--view');
  const ids = id === 'all' ? Object.keys(doc.regions) : (id || '').split(',').filter(Boolean);
  if (!ids.length || ids.some((v) => !doc.regions[v])) throw new Error('usage: node tools/build-scenic-tours.mjs --view <id>[,<id>]|all [--render] [--publish]');
  for (const viewId of ids) {
    const out = path.resolve(opt('--out') || path.join(root, '.smoke', 'scenic-tours', viewId));
    const built = await buildViewTours(viewId, { out, workers: Number(opt('--workers')) || undefined });
    const fitted = await fitToBudget(built, { maxIterations: args.includes('--survey') ? 1 : Infinity });
    await writeFitted(out, viewId, fitted);
    if (args.includes('--render')) {
      const scores = await renderReview(viewId, fitted.library, { out, terrain: fitted.bake.rebaked ? { manifestText: fitted.bake.manifestText, payload: fitted.bake.payload } : null });
      await fs.writeFile(path.join(out, 'render.json'), JSON.stringify(Object.fromEntries(scores), null, 1));
    }
    const libraryKiB = (Buffer.byteLength(fitted.packed.manifestText) + fitted.packed.payload.byteLength) / 1024;
    console.log(`${viewId}: ${fitted.packed.manifest.shots.length} shots, ${fitted.packed.manifest.links.length} links, library ${libraryKiB.toFixed(1)} KiB, terrain ${fitted.bake.rebaked ? `re-culled (+${(fitted.bake.budget.addedBytes / 1024).toFixed(0)} KiB)` : 'unchanged'}${fitted.failed ? ' -- OVER BUDGET' : ''}`);
    if (args.includes('--publish')) await publishView(viewId, fitted);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
