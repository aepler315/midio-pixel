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
// These statuses control normal runtime selection, not permission to build or
// test candidates; development diagnostics can force candidate views/tours.
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
import { linkVariants, keepParetoLinks, linkRejects } from './lib/scenic-links.mjs';
import { LINK_VISIBILITY_FIELDS, linkVisibilityStatus } from './lib/scenic-score.mjs';
import { strideCost, tourPoses, tourBakeOptions, bakeOptions } from './lib/scenic-cost.mjs';

import { SHOT_SCHEMA, SHOT_VERSION, packShotPaths, chooseLattice, shotLibraryErrors, decodeShotLibrary, cameraFootprint } from '../src/world/terrain/ShotLibrary.js';
import { pathPoseAt, slicePath, pathLaneAt, withProgress } from '../src/world/terrain/ShotPath.js';
import { shotPaceLimits } from '../src/world/terrain/ShotPlanner.js';
import { bakeTerrain, mirroredPose, VISIBILITY, LOD_BUDGETS } from './lib/terrain-bake.mjs';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';
import { validatePoses, rangeAssetBytes } from './lib/scenic-coverage.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';
import { forestPlacementBound } from '../src/world/alpine/ForestCover.js';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';

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
  constructor(viewId, size, { edgeDipDeg = 0 } = {}) {
    this.workers = []; this.queue = []; this.pending = new Map(); this.next = 0;
    this.ready = Promise.all(Array.from({ length: size }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./lib/scenic-score-worker.mjs', import.meta.url), { workerData: { viewId, root, edgeDipDeg } });
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
  // The payoff leaves room to hold the view before the shot ends.
  const payoffS = clamp(best?.s ?? record.payoffFrac * L, 0.2 * L, 0.88 * L);
  const ref = value(samples.reduce((a, b) => (Math.abs(b.s - payoffS) < Math.abs(a.s - payoffS) ? b : a)));
  let a = payoffS, b = payoffS;
  for (const x of samples) if (x.s <= payoffS && value(x) >= 0.8 * ref) a = Math.min(a, x.s);
  for (const x of samples) if (x.s >= payoffS && value(x) >= 0.8 * ref) b = Math.max(b, x.s);
  return { payoffS, holdS: [Math.min(a, payoffS - 0.08 * L, payoffS), Math.max(b, Math.min(L, payoffS + 0.08 * L))].map((v) => clamp(v, 0, L)) };
}

/** Comfortable duration range, bounded below by the runtime's supported
 *  curve limits. This is not a promise that every timed payoff/profile fits:
 *  decoded geometry and the actual inter-payoff speed profile are checked later. */
export function durationRange(p, flow, motion, physicalCapMps = null) {
  // Retain the author's comfortable coarse-curvature/flow estimate; the
  // shared runtime bound below also accounts for the drawn cubic and climb.
  const bend = pathBend(p), accel = motion.maxLateralMps2 ?? 2 * (motion.maxAccelMps2 ?? 3.5);
  let fast = 0, calm = 0;
  for (let i = 1; i < p.s.length; i++) {
    const ds = p.s[i] - p.s[i - 1], f = Math.max(1e-5, (flow[i] + flow[i - 1]) / 2);
    const cap = Math.min(motion.maxSpeedMps, Math.sqrt(accel / Math.max(1e-9, Math.max(bend[i], bend[i - 1]))));
    fast += ds / Math.min(cap, motion.flowEnergetic / f);
    calm += ds / Math.min(cap, motion.flowCalm / f);
  }
  const L = p.s[p.s.length - 1];
  if (physicalCapMps == null) {
    // The existing runtime API bounds the drawn cubic over the whole
    // path when its payoff is at the end. Links pass their batched join cap.
    const shot = { id: 'duration', subjectId: 'duration', move: 'traverse', path: { ...p, flow }, payoffS: L, score: { total: 1 } };
    physicalCapMps = shotPaceLimits({ subjects: [], shots: [shot], links: [], motion }).head[0].capMps;
  }
  fast = Math.max(fast, L / physicalCapMps);
  calm = Math.max(calm, fast);
  const min = Math.ceil(fast * 1000), ideal = Math.max(min, Math.round(clamp((fast + calm) / 2, fast, calm) * 1000));
  return { min, ideal, max: Math.max(ideal, Math.round(Math.max(calm, L / motion.minSpeedMps) * 1000)) };
}

/** Refresh authoring estimates from current motion and real source/link/target
 *  supports, including old cached graphs. Keep rejected geometry in the cache
 *  but never give an over-leash link to selection or later relinking. */
export function refreshGraphDurations(graph, motion, maxLinkMs) {
  const links = graph.front.map((l, i) => ({ ...l, id: `duration-link-${i}`, from: l.from.id, to: l.to.id }));
  const limits = shotPaceLimits({ subjects: [], shots: graph.usable, links, motion });
  graph.usable.forEach((s) => { s.durationMs = durationRange(s.path, s.path.flow, motion); });
  graph.front.forEach((l, i) => { l.durationMs = durationRange(l.path, l.path.flow, motion, limits.link[i].capMps); });
  const pairs = graph.front.filter((l) => l.durationMs.min <= maxLinkMs);
  const rejectedLinks = graph.front.filter((l) => l.durationMs.min > maxLinkMs).map((l) => ({
    from: l.from.id, to: l.to.id, kind: l.kind, minMs: l.durationMs.min, maxLinkMs,
  }));
  return { pairs, checked: graph.front.length, admitted: pairs.length, rejectedLinks };
}

/** Curvature of the eye along progress per sample, |d2 eye / ds2| (1/m),
 *  from the three-point second difference on uneven progress. */
export function pathBend(p) {
  const n = p.s.length, out = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const a = p.s[i] - p.s[i - 1], b = p.s[i + 1] - p.s[i];
    if (!(a > 0 && b > 0)) continue;
    let sq = 0;
    for (let k = 0; k < 3; k++) {
      const d2 = (2 * (p.eye[(i + 1) * 3 + k] * a - p.eye[i * 3 + k] * (a + b) + p.eye[(i - 1) * 3 + k] * b)) / (a * b * (a + b));
      sq += d2 * d2;
    }
    out[i] = Math.sqrt(sq);
  }
  if (n > 2) { out[0] = out[1]; out[n - 1] = out[n - 2]; }
  return out;
}

// ---------------------------------------------------------------------------

export async function buildViewTours(viewId, { out, workers = Math.max(2, os.cpus().length - 4), renderGate = true, log = console.log } = {}) {
  const t0 = Date.now();
  const config = regionConfig(JSON.parse(await fs.readFile(CONFIG, 'utf8')), viewId);
  const ctx = await loadViewContext(viewId, { root });
  ctx.clearance = buildClearance(ctx, config.clearance);
  ctx.heightAt = (x, z) => heightAt(ctx.grid, x, z);
  ctx.lenses = config.lensFovYDeg; ctx.standoffM = config.clearance.subjectStandoffM; ctx.boundaryMarginM = config.clearance.boundaryMarginM;
  // Horizon policy (docs/scenic-tours.md, "Horizon and the grid edge").
  ctx.edgeDipDeg = config.discovery.edgeDipDeg ?? 0; ctx.frame = config.discovery.frame ?? null;
  await terrainPolicy(ctx, config, log);
  // The tour stays in one coherent area around what the authored rail
  // frames (and the region's heroes): subjects and moves outside it would
  // only connect through long transits and pull in far terrain.
  const found = discoverSubjects(ctx, config.region, config);
  const focus = focusArea(found, config);
  // Named subjects (the region's config and the view's landmarks) stay
  // wherever they are; DEM features only inside the focus area.
  const subjects = found.filter((s) => s.kind === 'rail-target' || s.source === 'config' || s.source === 'landmark'
    || Math.hypot(s.posM[0] - focus.center[0], s.posM[2] - focus.center[2]) <= focus.radiusM);
  ctx.focus = focus;
  // Views whose water is mapped rivers only (or none) have no DEM lakes to run along.
  const mappedWater = ctx.view.riverPolicy?.terrainWater === 'mapped-only' || ctx.view.water === false;
  const lines = { valleys: valleyPaths(ctx), shores: mappedWater ? [] : shorelines(ctx) };
  log(`${viewId}: ${subjects.length} subjects (${subjects.map((s) => s.name || s.kind).join(', ')}); ${lines.valleys.length} valleys, ${lines.shores.length} shores`);
  const forward = generateShots(ctx, subjects, lines, config.region, { maxPerSubject: config.discovery.shotsPerSubject * 6 });
  // Moves that read the same flown either way also run backwards, so a link
  // can arrive along the heading a shot already travels instead of turning
  // the camera around (reveals, approaches and pullbacks keep their sense).
  const generated = [...forward, ...forward.filter((c) => REVERSIBLE.has(c.move)).map(reverseShot)];
  // The authored rail is always a candidate, wherever the focus lies.
  const outOfFocus = generated.filter((c) => c.move !== 'rail' && !inFocus(c.path, focus));
  const candidates = generated.filter((c) => (c.move === 'rail' || inFocus(c.path, focus)) && steadyLook(c.path));
  // What each stage keeps and why the rest go (report.funnel).
  const funnel = { discovery: { generated: forward.length, reversed: generated.length - forward.length, outOfFocus: outOfFocus.length,
    steepLook: generated.length - outOfFocus.length - candidates.length, candidates: candidates.length } };
  log(`${viewId}: ${candidates.length} candidate shots (${forward.length} generated + ${generated.length - forward.length} reversed; ${outOfFocus.length} outside the focus area, ${funnel.discovery.steepLook} looking near straight down)`);
  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const pool = new ScorePool(viewId, workers, { edgeDipDeg: ctx.edgeDipDeg });
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
    Object.assign(funnel.discovery, { coarseHoles: candidates.filter((c) => c.move !== 'rail' && !(c.coarse.holes < 0.5)).length,
      scoredInFull: second.length, cappedPerSubjectOrMove: candidates.filter((c) => c.move !== 'rail' && c.coarse.holes < 0.5).length - (second.length - candidates.filter((c) => c.move === 'rail').length) });
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
    // A song has room for a payoff every 15-30 s: shots longer than
    // discovery.maxShotS at their ideal pace keep their best window around
    // the payoff, and are scored again as cut.
    const maxShotMs = (config.discovery.maxShotS ?? 16) * 1000;
    const cut = [];
    second.forEach((c, i) => {
      const w = trimWindow(c, maxShotMs);
      if (w) { second[i] = trimShot(c, w, config.motion); cut.push(second[i]); }
    });
    const recut = await Promise.all(cut.map((c) => pool.score('shot', c.path, {
      subject: subjectById.get(c.subjectId), subjects, lens: c.traits.lens, move: c.move, payoffS: c.payoffS, holdS: c.holdS, everyM: 60 })));
    cut.forEach((c, i) => {
      c.scored = recut[i]; c.path.flow = Float32Array.from(recut[i].flow); c.score = { ...recut[i].aggregate, render: null };
      c.durationMs = durationRange(c.path, c.path.flow, config.motion);
    });
    log(`${viewId}: cut ${cut.length} of ${second.length} shots to about ${maxShotMs / 1000} s`);
    // Each candidate's terrain footprint (the stride the baker gives each
    // tile it sees): what it would cost beyond the shipped package.
    const cost = strideCost(ctx), scale = config.budget.poseErrorScale ?? 4;
    cost.coverageOnly = ctx.coverageOnly;
    // The rail costs nothing: its approved package covers it, reflections included.
    const prints = await Promise.all(second.map((c) => (c.move === 'rail' ? [] : pool.score('footprint', c.path, { scale }))));
    second.forEach((c, i) => { c.footprint = new Map(prints[i]); c.missing = prints[i].map(([t]) => t).filter((t) => cost.shipped(t) == null); });
    // The actual renderer: every scored candidate's key frames (entry,
    // payoff, end of hold, exit) through the production terrain material and
    // forest, against one package baked for all of them. A shot whose
    // subject the renderer does not show, or that renders flat, loses score.
    if (renderGate) {
      const { poses } = tourPoses(ctx, second.filter((c) => c.move !== 'rail'), { spacingM: 200, maxPoses: 2600 });
      const baked = await bakeTerrain(ctx.grid, ctx.build.view, tourBakeOptions(ctx, poses, scale));
      const rendered = await renderReview(viewId, { subjects, shots: second, links: [] },
        { out, sheet: false, terrain: { manifestText: JSON.stringify(baked.manifest) + '\n', payload: baked.payload }, log });
      const detailM = ctx.grid.sourceResolutionM ?? ctx.grid.cellSizeM, reasons = new Map();
      for (const c of second) {
        const r = rendered.get(c.id);
        if (!r) continue;
        const gate = renderedGate(r.frames, { fovYDeg: c.traits.fovYDeg ?? c.path.fov[0], detailM });
        const total = c.move === 'rail' || gate.pass ? renderedTotal(c.score.total, r.score) * gate.factor : 0;
        c.score = { ...c.score, dem: c.score.total, render: r.score, sharp: gate.factor, total };
        if (c.move !== 'rail') for (const why of gate.reasons) reasons.set(why, (reasons.get(why) || 0) + 1);
        if (c.move !== 'rail' && gate.pass && total === 0) reasons.set('render near empty', (reasons.get('render near empty') || 0) + 1);
      }
      const weak = second.filter((c) => c.move !== 'rail' && c.score.total === 0).length;
      funnel.discovery.renderGate = { dropped: weak, reasons: Object.fromEntries(reasons) };
      log(`${viewId}: renderer scored ${rendered.size} candidates; ${weak} dropped (${[...reasons].map(([k, n]) => `${n} ${k}`).join(', ') || 'none gated'})`);
    }
    // The candidate link graph: from each scored shot to its nearest few
    // within reach (exit to entry), every variant scored, on a leash (a
    // transit that cannot be flown within discovery.maxLinkS even at full
    // pace costs the song a payoff) and Pareto-pruned per pair.
    const maxLinkMs = (config.discovery.maxLinkS ?? 30) * 1000;
    const reachM = (maxLinkMs / 1000) * config.motion.maxSpeedMps;
    const usable = second.filter((c) => c.move === 'rail' || c.score.total > 0);
    const raw = [];
    for (const k of Object.keys(linkRejects)) delete linkRejects[k];
    let pairsTried = 0, outOfReach = 0, steep = 0;
    for (const a of usable) {
      const near = usable.filter((b) => b !== a).map((b) => [b, endGap(a, b)]);
      const next = near.filter(([, d]) => d <= reachM).sort((x, y) => x[1] - y[1]).slice(0, config.discovery.linkFanout ?? 8);
      outOfReach += near.filter(([, d]) => !(d <= reachM)).length;
      pairsTried += next.length;
      for (const [b] of next) for (const v of linkVariants(ctx, a, b, { linkMaxM: config.discovery.linkMaxM, transitMaxM: config.discovery.transitMaxM, radiusM: config.discovery.linkRadiusM ?? 400 })) {
        if (steadyLook(v.path)) raw.push({ from: a, to: b, ...v }); else steep++;
      }
    }
    const linkScores = await Promise.all(raw.map((l) => pool.score('link', l.path, { everyM: 120, width: 96, height: 54 })));
    raw.forEach((l, i) => { l.score = linkScores[i].aggregate; l.path.flow = Float32Array.from(linkScores[i].flow); });
    const leashed = refreshGraphDurations({ usable, front: raw }, config.motion, maxLinkMs).pairs;
    const front = paretoFront(leashed);
    const visibility = summarizeLinkVisibility(leashed);
    funnel.links = { shots: usable.length, pairsOutOfReach: outOfReach, pairsTried, variantsTried: pairsTried * 4, rejected: { ...linkRejects, 'looks near straight down': steep },
      built: raw.length, overLeash: raw.length - leashed.length, holed: leashed.filter((l) => l.score.holes > 0.002).length, visibility, paretoKept: front.length };
    funnel.links.rejected['all-sky sampled frame'] = visibility.rejected.allSky;
    funnel.links.rejected['visibility evidence missing or invalid'] = visibility.rejected.unmeasured;
    log(`${viewId}: links: ${pairsTried} nearest pairs within reach (${outOfReach} pairs beyond ${Math.round(reachM)} m), ${pairsTried * 4} variants tried, ${raw.length} built (rejected: ${Object.entries(funnel.links.rejected).map(([k, n]) => `${n} ${k}`).join(', ')}), ${funnel.links.overLeash} slower than ${maxLinkMs / 1000} s, ${funnel.links.holed} seeing holes, ${front.length} kept on the pairs' Pareto fronts`);
    const graph = { usable, front, subjects, focus: ctx.focus, scored: second.length, variants: raw.length, funnel,
      candidateScores: candidates.map((c) => ({ id: c.id, move: c.move, tags: c.tags, elevation: c.traits.elevation, lens: c.traits.lens,
        coarse: c.coarse ? { total: c.coarse.total, holes: c.coarse.holes, payoff: c.coarse.payoff } : null, full: c.score?.total ?? null })) };
    await writeGraphCache(out, graph);
    return await selectLibrary(viewId, { ctx, config, pool, cost, scale, graph, out, t0, log });
  } finally { await pool.close(); }
}

/**
 * Selection, from a scored link graph (buildViewTours, or its cache): the
 * strongly connected part worth most, a connected shortlist grown in it,
 * links chosen among the shortlist and priced, and the build report.
 */
async function selectLibrary(viewId, { ctx, config, pool, cost, scale, graph, out, t0, log }) {
  const { subjects } = graph;
  const { pairs: leashed, ...durationSummary } = refreshGraphDurations(graph, config.motion, (config.discovery.maxLinkS ?? 30) * 1000);
  const visibility = await refreshLinkVisibility(leashed, (p) => pool.score('link', p, { everyM: 120, width: 96, height: 54 }));
  const { pairs: front, rejectedLinks, ...visibilitySummary } = visibility;
  await writeGraphCache(out, graph);
  log(`${viewId}: current supported-curve duration admits ${durationSummary.admitted}/${durationSummary.checked} cached links within ${config.discovery.maxLinkS ?? 30} s`);
  log(`${viewId}: link visibility ${visibility.admitted}/${visibility.checked} with terrain in every sampled frame; ${visibility.measured} cached paths measured, ${visibility.rejected.allSky} all-sky and ${visibility.rejected.unmeasured} unmeasured rejected`);
  // Shots a rendered review marked broken (region.excludeShots) never join.
  const excluded = new Set(config.region.excludeShots || []);
  const usable = graph.usable.filter((c) => !excluded.has(c.id));
  // Shots of the region's named heroes (scenic-tours.json region.hero).
  const heroIds = new Set(subjects.filter((x) => (config.region.hero || []).includes(x.name)).map((x) => x.id));
  for (const c of usable) c.hero = heroIds.has(c.subjectId);
  // Tours stay inside a strongly connected part of the graph: take the
  // one whose best shots are worth most (the rail joins as the fallback).
  const component = bestComponent(usable, front, config.discovery.maxShots);
  const funnel = { ...(graph.funnel || {}), excluded: graph.usable.length - usable.length,
    linkDurations: durationSummary,
    linkVisibility: { ...visibilitySummary, rejectedLinks },
    components: { parts: bestComponent.parts, inBest: component.size, onNoCycle: usable.length - bestComponent.parts.reduce((a, b) => a + b, 0) } };
  log(`${viewId}: link graph ${graph.variants} variants, ${front.length} usable within ${config.discovery.maxLinkS ?? 30} s; best connected part ${component.size} of ${usable.length} shots`);
  // Selection inside it grows a connected set: diverse, charged for
  // terrain, and only shots (or two-shot chains) the set links into and
  // back out of; then links chosen among them.
  const candidatesIn = usable.filter((c) => component.has(c) || c.move === 'rail');
  const priced = new Set();
  const priceLinks = async (shots) => {
    const among = front.filter((l) => shots.includes(l.from) && shots.includes(l.to) && !priced.has(l));
    const prints = await Promise.all(among.map((l) => pool.score('footprint', l.path, { scale })));
    among.forEach((l, i) => { l.footprint = new Map(prints[i]); l.missing = prints[i].map(([t]) => t).filter((t) => cost.shipped(t) == null); priced.add(l); });
    return front.filter((l) => shots.includes(l.from) && shots.includes(l.to));
  };
  const shortlist = selectConnected(candidatesIn, front, config, cost, { log: (m) => log(`${viewId}: ${m}`) });
  funnel.selection = selectConnected.funnel;
  const library2 = linkLibrary(shortlist, await priceLinks(shortlist), config, cost);
  funnel.linkSelection = library2.connectivity;
  funnel.selectedLinkVisibility = summarizeLinkVisibility(library2.links);
  if (library2.connectivity.overCap.length) log(`${viewId}: connectivity retains links above the preferred outgoing cap: ${library2.connectivity.overCap.map((x) => `${x.id} ${x.links}/${x.preferredCap}`).join(', ')}; all retained links remain in the byte, triangle and forest fit`);
  const shortlisted = shortlist.length;
  const pairs = front;
  log(`${viewId}: shortlisted ${shortlisted}: ${library2.shots.length} shots / ${library2.links.length} links connected, ~${Math.round(estimatedBytes([...library2.shots, ...library2.links], cost) / 1024)} KiB: ${library2.shots.map((x) => `${x.move}:${x.score.total.toFixed(2)}`).join(' ')}`);
  const linkedLib = library2;
  const library = { subjects, ...linkedLib };
  // Footprint: tiles the library needs beyond the shipped package, and the
  // terrain bytes the cost model expects them to add.
  const need = new Set(library.shots.concat(library.links).flatMap((r) => r.missing || []));
  const estimated = estimatedBytes([...library.shots, ...library.links], cost);
  const report = {
    viewId, builtAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, config,
    focus: graph.focus, subjects, candidates: graph.candidateScores.length,
    candidateScores: graph.candidateScores, scored: graph.scored, shortlisted, linkVariants: graph.variants,
    shots: library.shots.map((s) => ({ id: s.id, move: s.move, subjectId: s.subjectId, lengthM: s.lengthM, payoffS: s.payoffS, holdS: s.holdS, score: s.score, traits: s.traits, durationMs: s.durationMs })),
    links: library.links.map((l) => ({ from: l.from.id, to: l.to.id, kind: l.kind, lengthM: l.lengthM, score: l.score })),
    missingTiles: [...need].sort((a, b) => a - b), estimatedTerrainBytes: estimated, funnel,
  };
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  log(`${viewId}: library ${library.shots.length} shots / ${library.links.length} links, ${need.size} tiles beyond the shipped package, ~${Math.round(estimated / 1024)} KiB terrain expected, ${report.seconds.toFixed(0)} s`);
  return { ctx, config, library, report, pairs, cost };
}

// The scored link graph, cached so selection can be rerun (--reselect)
// without rediscovering, rescoring and rerendering every candidate.
const GRAPH_CACHE = 'graph-cache.json';

/** Terrain-presence evidence over a complete pair pool or final library. */
export function summarizeLinkVisibility(pairs) {
  const rejected = { allSky: 0, unmeasured: 0 };
  let admitted = 0, min = Infinity;
  for (const link of pairs) {
    const status = linkVisibilityStatus(link.score);
    if (status === 'terrain') admitted++; else rejected[status]++;
    if (status !== 'unmeasured') min = Math.min(min, link.score.minTerrainFrac);
  }
  return { checked: pairs.length, admitted, rejected, minTerrainFrac: min < Infinity ? min : null, allSafe: admitted === pairs.length };
}

/** Legacy scored fronts lack frame visibility. Measure every unknown path
 * once, preserving its existing quality, flow and geometry, then close the
 * pair pool before connected selection and every later budget/forest relink.
 * Known rejected evidence stays cached for diagnostics, never for playback. */
export async function refreshLinkVisibility(pairs, score) {
  const unknown = pairs.filter((l) => linkVisibilityStatus(l.score) === 'unmeasured');
  await Promise.all(unknown.map(async (link) => {
    const result = await score(link.path);
    if (!link.score || typeof link.score !== 'object') link.score = {};
    for (const key of LINK_VISIBILITY_FIELDS) link.score[key] = result?.aggregate?.[key];
  }));
  const rejectedLinks = pairs.filter((l) => linkVisibilityStatus(l.score) !== 'terrain').map((l) => ({
    from: l.from.id, to: l.to.id, kind: l.kind, reason: linkVisibilityStatus(l.score),
    ...Object.fromEntries(LINK_VISIBILITY_FIELDS.map((key) => [key, l.score?.[key] ?? null])),
  }));
  return { ...summarizeLinkVisibility(pairs), pairs: pairs.filter((l) => linkVisibilityStatus(l.score) === 'terrain'),
    measured: unknown.length, rejectedLinks };
}

async function writeGraphCache(out, graph) {
  const typed = (k, v) => (k === 'scored' && typeof v === 'object' ? undefined
    : v instanceof Float32Array ? { $f32: Array.from(v) } : v instanceof Float64Array ? { $f64: Array.from(v) } : v instanceof Map ? { $map: [...v] } : v);
  const text = JSON.stringify({ ...graph, front: graph.front.map((l) => ({ ...l, from: l.from.id, to: l.to.id })) }, typed);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, GRAPH_CACHE), text);
}

async function readGraphCache(out) {
  const graph = JSON.parse(await fs.readFile(path.join(out, GRAPH_CACHE), 'utf8'), (k, v) => (v && typeof v === 'object'
    ? (v.$f32 ? Float32Array.from(v.$f32) : v.$f64 ? Float64Array.from(v.$f64) : v.$map ? new Map(v.$map) : v) : v));
  const byId = new Map(graph.usable.map((c) => [c.id, c]));
  graph.front = graph.front.map((l) => ({ ...l, from: byId.get(l.from), to: byId.get(l.to) }));
  return graph;
}

/** Selection, fit and review again from a build's cached link graph. */
export async function reselectViewTours(viewId, { out, workers = Math.max(2, os.cpus().length - 4), log = console.log } = {}) {
  const t0 = Date.now();
  const config = regionConfig(JSON.parse(await fs.readFile(CONFIG, 'utf8')), viewId);
  const ctx = await loadViewContext(viewId, { root });
  const graph = await readGraphCache(out);
  ctx.focus = graph.focus; ctx.edgeDipDeg = config.discovery.edgeDipDeg ?? 0;
  await terrainPolicy(ctx, config, log);
  const cost = strideCost(ctx), scale = config.budget.poseErrorScale ?? 4;
  cost.coverageOnly = ctx.coverageOnly;
  const pool = new ScorePool(viewId, workers, { edgeDipDeg: ctx.edgeDipDeg });
  await pool.ready;
  try { return await selectLibrary(viewId, { ctx, config, pool, cost, scale, graph, out, t0, log }); } finally { await pool.close(); }
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

/** The window [a, b] (progress) a shot keeps when its ideal duration is
 *  over `maxMs`: a lead-in before the payoff (a reveal keeps the last
 *  hidden stretch before it), the payoff, and the hold after; null when the
 *  shot already fits. */
export function trimWindow(c, maxMs) {
  const L = c.lengthM, ideal = c.durationMs?.ideal;
  if (!(ideal > maxMs)) return null;
  const keep = (L * maxMs) / ideal;
  let a = c.payoffS - 0.45 * keep;
  if (c.move === 'reveal') {
    const hidden = (c.scored?.samples || []).filter((x) => x.s < c.payoffS && (x.visible ?? 1) < 0.4).at(-1);
    if (hidden) a = Math.min(a, hidden.s - 0.08 * keep);
  }
  a = clamp(a, 0, Math.max(0, L - keep));
  return [a, Math.min(L, a + keep)];
}

/** A shot cut to [a, b] of its progress, its lanes, payoff and hold
 *  shifted with it. */
export function trimShot(c, [a, b], motion) {
  const path = slicePath(c.path, a, b), len = b - a;
  path.flow = Float32Array.from(path.s, (x) => pathLaneAt(c.path, c.path.flow, x + a));
  const payoffS = clamp(c.payoffS - a, 0, len);
  const holdS = [Math.min(payoffS, clamp(c.holdS[0] - a, 0, len)), Math.max(payoffS, clamp(c.holdS[1] - a, 0, len))];
  return { ...c, path, lengthM: len, payoffS, holdS, cutS: [a, b], durationMs: durationRange(path, path.flow, motion) };
}

/**
 * Whether the view's package may be rebaked. The rail-only bake must
 * reproduce the shipped package; when it does not, the DEM source has
 * drifted since approval and a rebake would change the approved rail. Such
 * a region keeps its package (coverage only: shots and links whose terrain
 * the shipped package already holds at enough detail) unless its config
 * allows the rebake (region.rebakeOnDrift, set only with rail-parity
 * evidence that the rail renders the same). region.coverageOnly forces it.
 */
export async function terrainPolicy(ctx, config, log = console.log) {
  const rail = await bakeTerrain(ctx.grid, ctx.build.view, bakeOptions(ctx));
  ctx.drift = rail.manifest.payload.sha256 !== ctx.terrain.manifest.payload.sha256;
  ctx.coverageOnly = !!config.region.coverageOnly || (ctx.drift && !config.region.rebakeOnDrift);
  if (ctx.drift) log(`${ctx.viewId}: the rail-only bake differs from the shipped package (source drift); ${ctx.coverageOnly ? 'coverage only: the package is kept' : 'rebake allowed by region.rebakeOnDrift'}`);
  else if (ctx.coverageOnly) log(`${ctx.viewId}: coverage only (region.coverageOnly)`);
}

/** The camera at a shot's payoff, entry and exit (cached on the record). */
function shotEnds(c) {
  if (!c.path) return null;
  if (!c.ends) {
    const at = (x) => { const p = pathPoseAt(c.path, x), d = p.targetM.map((v, k) => v - p.eyeM[k]), l = Math.hypot(...d); return { eye: p.eyeM, dir: d.map((v) => v / l) }; };
    c.ends = { payoff: at(c.payoffS ?? c.lengthM / 2), entry: at(0), exit: at(c.lengthM ?? c.path.s[c.path.s.length - 1]) };
  }
  return c.ends;
}

/** Whether two shots are near copies: their payoff cameras stand within
 *  discovery.copyM metres (default 700) and look within discovery.copyDeg
 *  degrees (default 14) of each other. Cut together, two shots that pay off
 *  on the same frame read as one, whatever moves lead in and out of it. */
export function nearCopy(a, b, discovery = {}) {
  const x = shotEnds(a), y = shotEnds(b);
  if (!x || !y || a === b) return false;
  const maxM = discovery.copyM ?? 700, minCos = Math.cos(((discovery.copyDeg ?? 14) * Math.PI) / 180);
  return Math.hypot(...x.payoff.eye.map((v, i) => v - y.payoff.eye[i])) <= maxM && x.payoff.dir.reduce((t, v, i) => t + v * y.payoff.dir[i], 0) >= minCos;
}

/** Moves that read the same flown either way. */
export const REVERSIBLE = new Set(['traverse', 'orbit', 'valley', 'crest']);

/** A shot flown backwards: its samples reversed, its payoff mirrored. */
export function reverseShot(c) {
  const p = c.path, n = p.s.length;
  const back = (arr, k) => { const out = new Float32Array(arr.length); for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) out[i * k + j] = arr[(n - 1 - i) * k + j]; return out; };
  const path = withProgress({ eye: back(p.eye, 3), aim: back(p.aim, 3), fov: back(p.fov, 1), s: p.s });
  const side = { left: 'right', right: 'left' }[c.traits?.side] ?? c.traits?.side;
  return { ...c, id: `${c.id}-rev`, path, lengthM: path.lengthM, payoffFrac: 1 - (c.payoffFrac ?? 0.5), traits: { ...c.traits, side }, tags: [...(c.tags || []), 'reversed'] };
}

/** Straight distance from a shot's exit to another's entry (NaN without paths). */
export function endGap(a, b) {
  const p = a.path, q = b.path;
  if (!p || !q) return NaN;
  const i = (p.s.length - 1) * 3;
  return Math.hypot(p.eye[i] - q.eye[0], p.eye[i + 1] - q.eye[1], p.eye[i + 2] - q.eye[2]);
}

/** Strong components with at least two shots (Tarjan). A fallback rail
 *  may be isolated; a shot's self-loop alone is not a useful tour. */
function strongComponents(shots, links) {
  const out = new Map(shots.map((x) => [x, []]));
  for (const l of links) out.get(l.from)?.push(l.to);
  const index = new Map(), low = new Map(), stack = [], on = new Set(), parts = [];
  let next = 0;
  const visit = (v) => {
    index.set(v, next); low.set(v, next); next++; stack.push(v); on.add(v);
    for (const w of out.get(v) || []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const part = [];
      for (let w; w !== v;) { w = stack.pop(); on.delete(w); part.push(w); }
      if (part.length > 1) parts.push(part);
    }
  };
  for (const v of shots) if (!index.has(v)) visit(v);
  return parts;
}

/** The strongly connected set of shots (by `links`) whose best `top`
 *  scores add up most; empty when no two shots join both ways. */
export function bestComponent(shots, links, top = 36) {
  const parts = strongComponents(shots, links);
  const worth = (part) => part.map((x) => x.score.total * subjectPriority(x)).sort((a, b) => b - a).slice(0, top).reduce((a, b) => a + b, 0);
  parts.sort((a, b) => worth(b) - worth(a));
  bestComponent.parts = parts.map((p) => p.length);
  return new Set(parts[0] || []);
}

/** Whether every pose along a path, between samples too, keeps a usable
 *  look direction (the baker rejects near-vertical views). */
export function steadyLook(p, { everyM = 30, limit = 0.95 } = {}) {
  const L = p.s[p.s.length - 1];
  for (let x = p.s[0]; ; x += everyM) {
    const q = pathPoseAt(p, Math.min(x, L)), d = q.targetM.map((v, k) => v - q.eyeM[k]), l = Math.hypot(...d);
    if (!(l > 1) || Math.abs(d[1] / l) > limit) return false;
    if (x >= L) return true;
  }
}

/** Terrain bytes the cost model expects records to add beyond the shipped package. */
export function estimatedBytes(records, cost) {
  return cost ? cost.total(records.map((r) => r.footprint || new Map())) : 0;
}

/** Library bytes per record (manifest entry + packed samples), measured on
 *  packed libraries; selection reserves them inside the region's budget. */
const RECORD_BYTES = 1300;

/** Subject emphasis changes selection priority, never a shot's quality or
 *  eligibility. Invalid weights retain the default; finite positives are
 *  bounded so emphasis stays a limited preference. */
const subjectPriority = (c) => Number.isFinite(c.subjectWeight) && c.subjectWeight > 0 ? clamp(c.subjectWeight, 0.25, 4) : 1;

/**
 * Selection state shared by selectShots and selectConnected: what a shot
 * is worth next to those already chosen. Terrain is charged with a cost
 * model (worth divided by 1 + bytes / discovery.byteScaleKB, the bytes its
 * detail adds beyond the shipped package and the chosen shots, stopping
 * short of the region's byte budget with room for links and records): the
 * first shot over a range pays for terrain later shots share, so it is
 * discounted, not refused. Without a cost model, per new tile
 * (discovery.tileWeight per 100 tiles). Variety: penalties for
 * repeating a subject, a move, an elevation class, a lens, or a viewing
 * azimuth of the same subject.
 */
function selection(config, cost, chosen) {
  const perSubject = config.discovery.shotsPerSubject;
  const out = [...chosen], owned = new Set(out.flatMap((o) => o.missing || [])), paid = new Map();
  if (cost) for (const o of out) cost.own(o.footprint || new Map(), paid);
  const tileWeight = config.discovery.tileWeight ?? 0.25, byteScale = (config.discovery.byteScaleKB ?? 250) * 1024;
  const room = (config.budget?.assetBytes ?? Infinity) * 0.85;
  let spent = estimatedBytes(out, cost);
  /** { v, bytes } for c next to `out` (plus `extra`), or null when it
   *  cannot join; `state.reject` then names why. */
  const state = { reject: null };
  const no = (why) => { state.reject = why; return null; };
  const value = (c, extra = []) => {
    const others = extra.length ? [...out, ...extra] : out;
    const same = others.filter((o) => o.subjectId === c.subjectId);
    if (same.length >= perSubject) return no('subject limit');
    // A near copy of a chosen shot (same frame at the payoff) adds nothing
    // a viewer would notice.
    if (others.some((o) => nearCopy(o, c, config.discovery))) return no('near copy');
    let bytes = 0;
    if (cost) {
      const held = extra.length ? extra.reduce((m, x) => cost.own(x.footprint || new Map(), m), new Map(paid)) : paid;
      bytes = cost.marginal(c.footprint || new Map(), held);
      if (cost.coverageOnly && bytes > 0) return no('needs new terrain (coverage only)');
      const before = extra.reduce((n, x) => n + (x.bytes || 0), 0);
      // Links add about a quarter again to the shots' terrain; each shot
      // brings its own record and about three links.
      if ((spent + before + bytes) * 1.25 + 4 * RECORD_BYTES * (others.length + 1) > room) return no('over the byte budget');
    }
    let v = cost ? c.score.total / (1 + bytes / byteScale) : c.score.total - tileWeight * (c.missing || []).filter((t) => !owned.has(t)).length / 100;
    if (v <= 0) return no('worth nothing');
    const n = Math.max(1, others.length);
    v *= 1 - 0.12 * same.length;
    v *= 1 - 0.1 * others.filter((o) => o.move === c.move).length / n;
    v *= 1 - 0.25 * others.filter((o) => o.traits.elevation === c.traits.elevation).length / n;
    v *= 1 - 0.15 * others.filter((o) => o.traits.lens === c.traits.lens).length / n;
    // Steep look-downs read alike however the terrain differs.
    const down = (x) => (x.traits.elevationDeg ?? 0) < -10;
    if (down(c)) v *= 1 - 0.3 * others.filter(down).length / n;
    for (const o of same) {
      const dAz = Math.abs(((o.traits.azimuthDeg - c.traits.azimuthDeg + 540) % 360) - 180);
      if (dAz < 25 && o.traits.elevation === c.traits.elevation) v *= 0.55;
    }
    // The region's heroes carry the climax: their shots are worth more.
    if (c.hero) v *= 1 + (config.discovery.heroBonus ?? 0.35);
    v *= subjectPriority(c);
    return { v, bytes };
  };
  const take = (c, bytes) => {
    out.push(c);
    for (const t of c.missing || []) owned.add(t);
    if (cost) { cost.own(c.footprint || new Map(), paid); spent += bytes; }
  };
  return { out, value, take, state };
}

/** Diverse shortlist: greedy by worth (selection()), starting from `kept`
 *  or the rail; shots no short link can reach from (or leave for) the
 *  chosen ones are worth less (by an actual link when `reach` is given,
 *  else by distance). */
export function selectShots(scored, config, cost = null, kept = [], { add = Infinity, reach = null } = {}) {
  const sel = selection(config, cost, kept.length ? kept : scored.filter((c) => c.move === 'rail'));
  const max = Math.min(config.discovery.maxShots, sel.out.length + add);
  const rest = scored.filter((c) => !sel.out.includes(c) && c.move !== 'rail' && c.score.holes <= 0.002 && c.score.total > 0);
  const reachM = (config.discovery.maxLinkS ?? 30) * (config.motion?.maxSpeedMps ?? 120) * 0.8;
  const near = reach || ((a, b) => !(endGap(a, b) > reachM));
  while (sel.out.length < max && rest.length) {
    let best = null;
    for (const c of rest) {
      const w = sel.value(c);
      if (!w) continue;
      let v = w.v;
      if (sel.out.length) {
        const into = sel.out.some((o) => near(o, c)), away = sel.out.some((o) => near(c, o));
        v *= into && away ? 1 : into || away ? 0.75 : 0.45;
      }
      if (!best || v > best.v || (v === best.v && c.id < best.c.id)) best = { c, v, bytes: w.bytes };
    }
    if (!best) break;
    sel.take(best.c, best.bytes);
    rest.splice(rest.indexOf(best.c), 1);
  }
  return sel.out;
}

/**
 * A connected shortlist grown by ears over the link graph: seeded with a
 * short cycle (at most discovery.earShots + 2 shots), then extended only by
 * ears, chains of at most discovery.earShots new shots that leave the set
 * and rejoin it (set -> a -> ... -> set), whichever is worth most per shot
 * (selection()). Every shot so chosen has a way in and a way out among the
 * others. A seed worth most on its own may sit where nothing else connects
 * cheaply, so the library is grown from each of the best
 * discovery.seedTrials seeds and the one worth most in total is kept. The
 * rail joins as the fallback, linked or not.
 */
export function selectConnected(scored, links, config, cost = null, { log = null } = {}) {
  const rail = scored.filter((c) => c.move === 'rail');
  const eligible = scored.filter((c) => c.move !== 'rail' && c.score.holes <= 0.002 && c.score.total > 0);
  const outs = new Map(), ins = new Map();
  for (const l of links) {
    if (!outs.has(l.from)) outs.set(l.from, new Set());
    if (!ins.has(l.to)) ins.set(l.to, new Set());
    outs.get(l.from).add(l.to); ins.get(l.to).add(l.from);
  }
  // Why a shot cannot join (report.funnel.selection and the build log).
  const why = { eligible: 0, holes: scored.filter((c) => c.move !== 'rail' && !(c.score.holes <= 0.002)).length, noShortCycle: 0, cycles: 0, seedRejects: {}, seeds: 0, trials: 0, stop: null };
  const max = config.discovery.maxShots, earShots = config.discovery.earShots ?? 3;
  const key = (chain) => chain.map((c) => c.id).join('>');
  const better = (x, y) => !y || x.v > y.v || (x.v === y.v && x.key < y.key);
  const walk = (parent, from, stop) => { const path = []; for (let x = from; x && !stop(x); x = parent.get(x)) path.push(x); return path; };
  // Breadth-first through `pool` shots from `sources` along `edges`, at
  // most `limit` steps, never through a copy of a shot already on the way
  // (a chain holding two copies could not be chosen): { parent, depth }.
  const bfs = (pool, sources, edges, limit) => {
    const parent = new Map(), depth = new Map();
    let frontier = [...sources];
    for (const x of frontier) depth.set(x, 0);
    for (let d = 1; d <= limit && frontier.length; d++) {
      const next = [];
      for (const x of frontier) for (const y of edges.get(x) || []) {
        if (!pool.has(y) || depth.has(y)) continue;
        let copy = false;
        for (let z = x; z !== undefined && !copy; z = parent.get(z)) copy = nearCopy(z, y, config.discovery);
        if (copy) continue;
        depth.set(y, d); parent.set(y, x); next.push(y);
      }
      frontier = next;
    }
    return { parent, depth };
  };
  // Value of adding a chain in order to a selection, or null when any
  // member does not fit. Longer chains spend more of the song on one
  // detour: 5% per extra shot.
  const chainValue = (sel, chain) => {
    const extra = [];
    let total = 0;
    for (const c of chain) {
      const w = sel.value(c, extra);
      if (!w) { chainValue.reject = sel.state.reject; return null; }
      total += w.v; extra.push(Object.assign(Object.create(c), { bytes: w.bytes }));
    }
    return { v: (total / chain.length) * (1 - 0.05 * (chain.length - 1)), bytes: extra.map((x) => x.bytes) };
  };
  // Seeds: the shortest cycle through each shot, valued on its own.
  const base = selection(config, cost, rail), seeds = new Map();
  for (const a of eligible) {
    // Not through a copy of itself (its own reversal pays off on its frame).
    const through = new Set(eligible.filter((x) => x === a || !nearCopy(a, x, config.discovery)));
    const { parent, depth } = bfs(through, [a], outs, earShots + 1);
    let close = null;
    for (const y of ins.get(a) || []) if (y !== a && depth.has(y) && (!close || depth.get(y) < depth.get(close))) close = y;
    if (!close) { why.noShortCycle++; continue; }
    const chain = [a, ...walk(parent, close, (x) => x === a).reverse()];
    why.cycles++;
    const w = chainValue(base, chain);
    if (!w) { why.seedRejects[chainValue.reject] = (why.seedRejects[chainValue.reject] || 0) + 1; continue; }
    const k = [...chain].map((c) => c.id).sort().join('+');
    if (!seeds.has(k) || w.v > seeds.get(k).v) seeds.set(k, { ...w, key: key(chain), chain });
  }
  // Grow from a seed: { out, worth }.
  const grow = (seed) => {
    const sel = selection(config, cost, rail), set = new Set(rail), pool = new Set(eligible);
    // Shots that can no longer join (copies of chosen ones) are no way through either.
    const add = (best) => {
      best.chain.forEach((c, i) => { sel.take(c, best.bytes[i]); set.add(c); pool.delete(c); });
      for (const c of [...pool]) if (best.chain.some((o) => nearCopy(o, c, config.discovery))) pool.delete(c);
    };
    add(seed);
    let stop = null;
    while (sel.out.length < max) {
      const fwd = bfs(pool, [...set], outs, earShots), back = bfs(pool, [...set], ins, earShots);
      let best = null;
      // Why each remaining shot could not join on this pass.
      stop = { remaining: pool.size, unreachable: 0, noWayBack: 0, longChain: 0, repeat: 0, rejects: {} };
      for (const c of pool) {
        if (!fwd.depth.has(c)) { stop.unreachable++; continue; }
        if (!back.depth.has(c)) { stop.noWayBack++; continue; }
        const chain = [...walk(fwd.parent, c, (x) => set.has(x)).reverse(), ...walk(back.parent, back.parent.get(c), (x) => set.has(x))];
        if (chain.length > earShots || sel.out.length + chain.length > max) { stop.longChain++; continue; }
        if (new Set(chain).size !== chain.length) { stop.repeat++; continue; }
        const w = chainValue(sel, chain);
        if (!w) { stop.rejects[chainValue.reject] = (stop.rejects[chainValue.reject] || 0) + 1; continue; }
        if (better({ ...w, key: key(chain) }, best)) best = { ...w, key: key(chain), chain };
      }
      if (!best) break;
      add(best);
    }
    if (sel.out.length >= max) stop = { full: true };
    // A library worth keeping covers the region's heroes: each hero subject
    // with a shot counts as much as a good shot more.
    const heroes = new Set(sel.out.filter((c) => c.hero).map((c) => c.subjectId)).size;
    return { out: sel.out, worth: sel.out.filter((c) => c.move !== 'rail').reduce((t, c) => t + c.score.total * subjectPriority(c), 0) + 0.6 * heroes, stop };
  };
  const trials = [...seeds.values()].sort((x, y) => y.v - x.v || (x.key < y.key ? -1 : 1)).slice(0, config.discovery.seedTrials ?? 12);
  let kept = null;
  for (const seed of trials) {
    const r = grow(seed);
    if (!kept || r.worth > kept.worth + 1e-9) kept = { ...r, seed };
  }
  Object.assign(why, { eligible: eligible.length, seeds: seeds.size, trials: trials.length, keptSeed: kept?.seed.chain.length ?? 0, chosen: kept ? kept.out.length - rail.length : 0, stop: kept?.stop ?? null });
  const list = (o) => Object.entries(o).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  log?.(`connected selection: ${eligible.length} shots eligible (${why.holes} left out for holes); ${why.noShortCycle} lie on no cycle of ${earShots + 2} or fewer shots; ${why.cycles} short cycles (${seeds.size} distinct usable seeds, ${Object.values(why.seedRejects).reduce((a, b) => a + b, 0)} rejected: ${list(why.seedRejects)})${kept ? `; grew ${trials.length} seeds, kept one of ${kept.seed.chain.length} shots growing to ${why.chosen}` : '; no seed'}`);
  if (kept?.stop && !kept.stop.full) log?.(`connected selection stopped with ${kept.stop.remaining} shots left: ${kept.stop.unreachable} unreachable from the set within ${earShots} shots, ${kept.stop.noWayBack} with no way back, ${kept.stop.longChain} only by longer chains, ${kept.stop.repeat} only through a repeated shot, rejected: ${list(kept.stop.rejects)}`);
  selectConnected.funnel = why;
  return kept ? kept.out : base.out;
}

/** Each ordered pair's Pareto front of usable link variants (at most two). */
export function paretoFront(pairs) {
  const byPair = new Map();
  for (const l of pairs) {
    if (l.score.holes > 0.002 || linkVisibilityStatus(l.score) !== 'terrain') continue;
    const k = `${l.from.id}>${l.to.id}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(l);
  }
  return [...byPair.values()].flatMap((v) => keepParetoLinks(v, 2));
}

/** Pareto per pair, then prefer maxLinksPerShot per origin and distinct
 *  destinations. Restore connectivity when local ranking cuts a cycle;
 *  the incoming-link restoration already makes this a preferred cap. */
export function selectLinks(pairs, shots, config, cost = null) {
  const front = paretoFront(pairs).filter((l) => !cost?.coverageOnly || cost.marginal(l.footprint || new Map()) === 0);
  const out = [];
  // A link's worth is its scenery per second it costs the song, less the
  // new terrain it would add beyond the shots' own.
  const owned = new Set(shots.flatMap((x) => x.missing || []));
  const paid = cost ? shots.reduce((m, x) => cost.own(x.footprint || new Map(), m), new Map()) : null;
  const byteScale = (config.discovery.byteScaleKB ?? 250) * 1024;
  const worth = new Map(front.map((l) => { const w = l.score.total / (1 + (l.durationMs?.ideal ?? l.lengthM * 40) / 20000);
    return [l, cost ? w / (1 + cost.marginal(l.footprint || new Map(), paid) / byteScale)
      : w - (config.discovery.tileWeight ?? 0.25) * (l.missing || []).filter((t) => !owned.has(t)).length / 100]; }));
  for (const s of shots) {
    const mine = front.filter((l) => l.from === s).sort((a, b) => worth.get(b) - worth.get(a) || a.lengthM - b.lengthM);
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
  // Having a way in and out is insufficient: local caps can keep two
  // closed clusters while discarding their only inter-cluster bridges.
  // Preserve existing connected selections byte for byte; repair only a
  // component that the scored graph connected before local link ranking.
  const required = strongComponents(shots, front);
  const componentMap = () => new Map(strongComponents(shots, out).flatMap((part, i) => part.map((s) => [s, i])));
  const intact = (parts) => required.every((part) => parts.has(part[0]) && part.every((s) => parts.get(s) === parts.get(part[0])));
  let parts = componentMap();
  if (!intact(parts)) {
    const sourceParts = new Map(required.flatMap((part, i) => part.map((s) => [s, i])));
    const ranked = [...front].sort((a, b) => worth.get(b) - worth.get(a) || a.lengthM - b.lengthM);
    for (const link of ranked) {
      if (!sourceParts.has(link.from) || sourceParts.get(link.from) !== sourceParts.get(link.to) || out.includes(link)) continue;
      if (parts.has(link.from) && parts.get(link.from) === parts.get(link.to)) continue;
      out.push(link); parts = componentMap();
      if (intact(parts)) break;
    }
    // Make room for bridges by removing redundant local links. Do not
    // replace an indispensable bridge just to meet the preferred cap:
    // some graphs (a hub with two leaves at cap one) cannot satisfy both.
    // linkLibrary reports any excess, and fitting prices every link.
    for (const shot of shots) {
      let mine = out.filter((l) => l.from === shot);
      while (mine.length > config.discovery.maxLinksPerShot) {
        const redundant = (l) => mine.filter((x) => x.to === l.to).length > 1 ? 1 : 0;
        mine.sort((a, b) => redundant(b) - redundant(a) || worth.get(a) - worth.get(b) || b.lengthM - a.lengthM);
        let removed = false;
        for (const link of mine) {
          const at = out.indexOf(link); out.splice(at, 1);
          if (intact(componentMap())) { removed = true; break; }
          out.splice(at, 0, link);
        }
        if (!removed) break;
        mine = out.filter((l) => l.from === shot);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actual-renderer review: each library shot at its start, payoff, end of
// hold and exit, through the production terrain material and forest.

/** A candidate's score once rendered: its DEM score, kept in full when
 *  the renderer shows its subject with real contrast (render >= 0.45) and
 *  down to 55% as that fades; zero when the render is near empty. */
export function renderedTotal(dem, render) {
  if (!(render >= 0.1)) return 0;
  return dem * (0.55 + 0.45 * clamp(render / 0.45, 0, 1));
}

/**
 * What the renderer shows of a candidate's key frames (entry, payoff, end
 * of hold, exit), as gates and a sharpness factor. Fitted to a visual review
 * of the first full libraries (170 shots in 12 regions, judged as film:
 * docs/scenic-tours.md, "Rendered review"): a shot is dropped when its
 * subject is not in the frame at the payoff, fills the frame, or when the
 * payoff and hold are all terrain too close to show detail (the DEM's
 * detailM cells spanning more than 10 pixels of the 640x360 picture); its
 * worth falls by up to half as that soft close terrain grows, and by up to a
 * quarter more when the entry or exit frame is all of it.
 */
export function renderedGate(frames, { fovYDeg = 26, detailM = 30 } = {}) {
  const m = frames.map((f) => f.metrics || {});
  const focal = 180 / Math.tan((fovYDeg * Math.PI) / 360), softM = (focal * detailM) / 10;
  const soft = (x) => {
    const d = x.depth;
    if (!d?.frac) return 0;
    let t = 0, lo = 0;
    d.frac.forEach((f, i) => { const hi = d.edgesM[i]; t += hi <= softM ? f : lo < softM ? (f * (softM - lo)) / (hi - lo) : 0; lo = hi; });
    return t;
  };
  const pay = m[1] || {}, reasons = [];
  if (pay.subject && !(pay.subject.inFrame >= 0.6)) reasons.push('subject out of frame at the payoff');
  if ((pay.subject?.screenHeight ?? 0) > 0.8) reasons.push('subject fills the frame');
  const payoffSoft = Math.max(soft(m[1] || {}), soft(m[2] || {})), endsSoft = Math.max(soft(m[0] || {}), soft(m[3] || {}));
  if (payoffSoft > 0.95) reasons.push('payoff all soft close terrain');
  const factor = 1 - 0.5 * clamp((payoffSoft - 0.75) / 0.2, 0, 1) - 0.25 * clamp((endsSoft - 0.85) / 0.15, 0, 1);
  return { pass: !reasons.length, factor, reasons, payoffSoft, endsSoft };
}

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

/**
 * Rail parity for a re-culled package: the authored rail rendered at
 * `stations` points with the shipped package and with the candidate. A
 * superset package keeps every tile the rail sees, so coverage, skyline and
 * pixels should match except where finer tour detail lands in view.
 */
export async function railParity(viewId, camera, terrain, { stations = 9, width = 480, height = 270 } = {}) {
  const { openShotReview, decodePng } = await import('./lib/scenic-render.mjs');
  const poses = Array.from({ length: stations }, (_, k) => {
    const u = k / (stations - 1), at = (a, b, arc) => a.map((v, i) => v + (b[i] - v) * u + (arc?.[i] || 0) * 4 * u * (1 - u));
    return { eyeM: at(camera.eyeStartM, camera.eyeEndM, camera.eyeArcM), targetM: at(camera.targetStartM, camera.targetEndM, camera.targetArcM), fovYDeg: camera.fovYDeg };
  });
  const render = async (candidate) => {
    const session = await openShotReview(viewId, { width, height, terrain: candidate });
    try { return await session.renderPoses(poses, { mode: 'material' }); } finally { await session.close(); }
  };
  const [before, after] = [await render(null), await render(terrain)];
  const rows = before.map((b, k) => {
    const a = after[k], pa = Buffer.from(a.png, 'base64'), pb = Buffer.from(b.png, 'base64');
    // Pixels that visibly changed (any channel by more than 6 levels).
    const da = decodePng(pa, zlib).rgb, db = decodePng(pb, zlib).rgb;
    let changed = 0, maxDelta = 0;
    for (let i = 0; i < da.length; i += 3) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > 6) changed++;
      if (d > maxDelta) maxDelta = d;
    }
    return { u: k / (stations - 1), identical: pa.equals(pb), changedFrac: changed / (da.length / 3), maxDelta, terrainFrac: [b.metrics.terrainFrac, a.metrics.terrainFrac],
      holes: [b.metrics.holes, a.metrics.holes], skylineTop: [b.metrics.skylineTop, a.metrics.skylineTop],
      luminance: [b.metrics.luminance?.mean, a.metrics.luminance?.mean] };
  });
  const worst = rows.reduce((w, r) => Math.max(w, Math.abs(r.terrainFrac[0] - r.terrainFrac[1])), 0);
  const changed = rows.reduce((w, r) => Math.max(w, r.changedFrac), 0);
  return { rows, identical: rows.filter((r) => r.identical).length, maxTerrainFracDelta: worst, maxChangedFrac: changed,
    ok: worst < 0.01 && changed < 0.03 && rows.every((r) => !(r.holes[1] > r.holes[0] + 1e-4)),
    before: before.map((b) => b.png), after: after.map((a) => a.png) };
}

// ---------------------------------------------------------------------------
// Terrain coverage: re-cull the view's package for rail + library poses

/** The poses a library's frames (and, where a lake mirrors, their
 *  reflections) need covered. */
export function libraryPoses(ctx, library, options = {}) {
  // Direct rail stations are kept by every bake. Rail reflections are
  // checked separately at the rail's own pixel limits in libraryCoverage.
  return tourPoses(ctx, [...library.shots.filter((x) => x.move !== 'rail'), ...library.links], options);
}

/** Coverage requirements follow the package the runtime will load: a bake
 *  can expose water or change its median plane. Keep rail mirrors at the
 *  ordinary rail limits, independently of the looser tour pixel budget. */
function libraryCoverage(ctx, library, check) {
  const { poses: tour, mirrorLevelM } = libraryPoses(ctx, library);
  const count = bakeOptions(ctx).visibility?.stations ?? VISIBILITY.stations;
  const rail = mirrorLevelM == null ? [] : Array.from({ length: count }, (_, k) =>
    mirroredPose(cameraPoseAt(ctx.build.view, count > 1 ? k / (count - 1) : 0), mirrorLevelM));
  const poses = [...tour, ...rail];
  const validation = { ok: true, holes: [], lod: [], worst: { holeFrac: 0, errorPx: 0, extendedErrorPx: 0 } };
  for (const budget of ['desktop', 'mobile']) {
    const lens = (ctx.terrain.manifest.lod?.budgets ?? LOD_BUDGETS)[budget];
    const tourCheck = { errorPx: check.errorPx * lens.errorPx, extendedErrorPx: check.extendedErrorPx * lens.errorPx };
    for (const [required, options, offset] of [[tour, tourCheck, 0], [rail, {}, tour.length]]) {
      if (!required.length) continue;
      const result = validatePoses(ctx, required, { ...options, budget });
      validation.ok &&= result.ok;
      for (const key of ['holes', 'lod']) validation[key].push(...result[key].map((e) => ({ ...e, poseIndex: e.poseIndex + offset, budget })));
      for (const key of Object.keys(validation.worst)) validation.worst[key] = Math.max(validation.worst[key], result.worst[key]);
    }
  }
  return { poses, railPoses: rail, mirrorLevelM, validation };
}

/**
 * Validate the library against the shipped package; when tiles or detail
 * are missing, bake a superset package (rail stations + library poses,
 * same options build-range-scene.mjs uses) and validate that. Returns
 * { rebaked, manifest, payload, data, validation, budget }.
 */
export async function bakeForLibrary(ctx, library, config, { log = console.log } = {}) {
  // Tour frames are held to the tour pixel budget (the rail keeps its own).
  const scale = config.budget.poseErrorScale ?? 3, check = { errorPx: scale, extendedErrorPx: 3 * scale };
  const initial = libraryCoverage(ctx, library, check);
  const { poses, mirrorLevelM, validation: shipped } = initial;
  log(`${ctx.viewId}: ${poses.length} footprint poses${mirrorLevelM != null ? ` (mirror at ${mirrorLevelM.toFixed(1)} m)` : ''}; shipped package: ${shipped.holes.length} poses with holes, ${shipped.lod.length} LOD violations`);
  if (shipped.ok || ctx.coverageOnly) return { rebaked: false, ...initial };
  // The rail-only bake must reproduce the shipped heights, or the source
  // has drifted since the view was approved (reported, not hidden).
  const rail = await bakeTerrain(ctx.grid, ctx.build.view, bakeOptions(ctx));
  const drift = rail.manifest.payload.sha256 !== ctx.terrain.manifest.payload.sha256;
  const tour = poses.slice(0, poses.length - initial.railPoses.length);
  const baked = await bakeTerrain(ctx.grid, ctx.build.view, { ...tourBakeOptions(ctx, tour, scale), railPoses: initial.railPoses });
  const data = decodeTerrain(baked.manifest, new Uint8Array(baked.decoded));
  const final = libraryCoverage({ ...ctx, terrain: { manifest: baked.manifest, data } }, library, check);
  const { validation } = final;
  const manifestText = JSON.stringify(baked.manifest) + '\n';
  const before = Buffer.byteLength(JSON.stringify(ctx.terrain.manifest) + '\n') + ctx.terrain.manifest.payload.byteLength;
  const budget = { addedBytes: Buffer.byteLength(manifestText) + baked.payload.byteLength - before,
    desktopTriangles: baked.manifest.estimatedBytes.desktop.triangles, mobileTriangles: baked.manifest.estimatedBytes.mobile.triangles,
    tiles: baked.manifest.tiles.length, shippedTiles: ctx.terrain.manifest.tiles.length, sourceDrift: drift };
  log(`${ctx.viewId}: re-culled package ${budget.shippedTiles} -> ${budget.tiles} tiles, +${(budget.addedBytes / 1024).toFixed(0)} KiB, desktop ${budget.desktopTriangles} / mobile ${budget.mobileTriangles} triangles; ${validation.holes.length} poses with holes, ${validation.lod.length} LOD violations${drift ? '; SOURCE DRIFT: the rail-only bake differs from the shipped package' : ''}`);
  return { rebaked: true, manifest: baked.manifest, manifestText, payload: baked.payload, data, budget, ...final };
}

/** Budget problems for a candidate library + terrain (empty = within). */
/**
 * Forest build memory the runtime reserves before it plants a static view:
 * ForestCover's placement bound (every forest lattice cell within the
 * billboard ring of the rail or a library path, 64 bytes each), for the rail
 * alone and with the library's footprint. A wide footprint can outgrow the
 * graphics residency budget, and a view that cannot reserve it is deferred
 * for good, so the fit holds it to budget.forestBuildBytes (or a little over
 * the rail's own bound where that is larger already).
 */
export async function forestBuild(ctx, data, library) {
  const view = SCENE_CATALOG.views.find((v) => v.id === ctx.viewId);
  const pack = JSON.parse(await fs.readFile(path.join(root, 'src', 'assets', 'range', 'v2', view.materialManifestUrl), 'utf8'));
  const rules = { ...pack.rules, ...(view.materialRules || {}) };
  const bound = (lib) => forestPlacementBound(data, lib ? { ...view, cameraPaths: cameraFootprint(lib) } : view, rules).placementBytes;
  return { rail: bound(null), tour: bound(library), bound };
}

export async function budgetErrors(ctx, config, packed, bake, forest = null) {
  const errors = [], b = config.budget;
  const forestCap = Math.max(b.forestBuildBytes ?? 160 * 2 ** 20, 1.1 * (forest?.rail ?? 0));
  if (forest && forest.tour > forestCap) errors.push(`forest build ${(forest.tour / 2 ** 20).toFixed(0)} MiB, over ${(forestCap / 2 ** 20).toFixed(0)} MiB`);
  if (!bake.validation.ok) errors.push(`not covered by the ${bake.rebaked ? 're-culled' : 'shipped'} package (${bake.validation.holes.length} poses with holes, ${bake.validation.lod.length} LOD violations)`);
  const added = (bake.rebaked ? bake.budget.addedBytes : 0) + Buffer.byteLength(packed.manifestText) + packed.payload.byteLength;
  if (added > b.assetBytes) errors.push(`adds ${added} bytes, over the region's ${b.assetBytes}`);
  if (bake.rebaked && bake.budget.desktopTriangles > b.desktopTriangles) errors.push(`desktop ${bake.budget.desktopTriangles} triangles, over ${b.desktopTriangles}`);
  if (bake.rebaked && bake.budget.mobileTriangles > b.mobileTriangles) errors.push(`mobile ${bake.budget.mobileTriangles} triangles, over ${b.mobileTriangles}`);
  const total = await rangeAssetBytes(root);
  return { errors, added, deliveryBytes: total + added, forest: forest ? { rail: forest.rail, tour: forest.tour, cap: forestCap } : null };
}

// ---------------------------------------------------------------------------
// Packing

const round = (v, k = 1000) => Math.round(v * k) / k;

/** The midio.shots manifest + gzip payload for a selected library. */
export function packLibrary(viewId, regionId, terrainManifestSha256, library, provenance = {}, motion = null, heroNames = []) {
  for (const link of library.links) {
    const visibility = linkVisibilityStatus(link.score);
    if (visibility !== 'terrain') throw new Error(`${viewId}: link ${link.from.id}->${link.to.id} has ${visibility} terrain visibility`);
  }
  const used = new Set(library.shots.map((s) => s.subjectId));
  // Hero subjects (the region's named heroes, else its grandest subject)
  // are the planner's choice for the climax.
  const kept = library.subjects.filter((s) => used.has(s.id) && s.kind !== 'rail-target');
  const heroes = new Set(kept.filter((s) => heroNames.includes(s.name)).map((s) => s.id));
  if (!heroes.size && kept.length) heroes.add(kept.reduce((a, b) => ((b.grandeur ?? 0) > (a.grandeur ?? 0) ? b : a)).id);
  const subjects = library.subjects.filter((s) => used.has(s.id)).map((s) => ({ id: s.id, kind: s.kind, name: s.name || null,
    posM: s.posM.map((v) => round(v, 10)), radiusM: round(s.radiusM, 10), heightM: round(s.heightM || 0, 10), ...(heroes.has(s.id) ? { hero: true } : {}) }));
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
      score: { total: round(l.score.total), weakest: round(l.score.weakest ?? 0), composition: round(l.score.composition ?? 0),
        ...Object.fromEntries(LINK_VISIBILITY_FIELDS.map((key) => [key, l.score[key]])) } };
  });
  const lattice = chooseLattice([...shots, ...links]);
  const decoded = Buffer.from(packShotPaths([...shots, ...links], lattice));
  const payload = zlib.gzipSync(decoded, { level: 9, mtime: 0 });
  payload[4] = payload[5] = payload[6] = payload[7] = 0; payload[9] = 255;
  const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'path'));
  const manifest = {
    schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId, regionId, terrainManifestSha256,
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' },
    ...(motion ? { motion } : {}), subjects, shots: shots.map(strip), links: links.map(strip),
    payload: { url: `${viewId}.shots.bin.gz`, encoding: 'gzip', byteLength: payload.byteLength, sha256: sha(payload),
      decodedByteLength: decoded.byteLength, decodedSha256: sha(decoded), lattice },
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

/** Re-link from every scored pair, retaining one actual strongly
 *  connected tour rather than disconnected cycles with ways in/out.
 *  The rail always stays as a fallback, without forcing it into a cycle. */
export function linkLibrary(shots, pairs, config, cost = null) {
  let keep = shots, links = [];
  for (let changed = true; changed;) {
    const set = new Set(keep);
    links = selectLinks(pairs.filter((l) => set.has(l.from) && set.has(l.to)), keep, config, cost);
    const component = bestComponent(keep, links, config.discovery.maxShots);
    const next = keep.filter((s) => s.move === 'rail' || component.has(s));
    changed = next.length !== keep.length; keep = next;
  }
  const cap = config.discovery.maxLinksPerShot;
  return { shots: keep, links, connectivity: { droppedShots: shots.length - keep.length,
    overCap: keep.map((s) => ({ id: s.id, links: links.filter((l) => l.from === s).length, preferredCap: cap })).filter((s) => s.links > cap) } };
}

/** The shot whose terrain is most its own per unit of what it brings
 *  (score, and rarity: the only move, elevation or subject of its kind),
 *  among the drops that keep the most of the library (`survivors(shot)`,
 *  the shots still connected without it). */
export function costliestShot(library, cost, survivors = null) {
  const records = [...library.shots, ...library.links], all = estimatedBytes(records, cost);
  let worst = null;
  for (const shot of library.shots) {
    if (shot.move === 'rail') continue;
    const own = all - estimatedBytes(records.filter((r) => r !== shot && r.from !== shot && r.to !== shot), cost);
    const alone = (key) => library.shots.filter((o) => o !== shot && key(o) === key(shot)).length === 0;
    const rarity = 1 + 1.5 * alone((o) => o.move + (o.tags || []).join('+')) + 1.5 * alone((o) => o.traits.elevation) + 0.8 * alone((o) => o.subjectId);
    const c = (own + 4000) / (Math.max(0.05, shot.score.total) * rarity), keep = survivors ? survivors(shot) : 0;
    if (!worst || keep > worst.keep || (keep === worst.keep && c > worst.cost)) worst = { shot, cost: c, bytes: own, keep };
  }
  return worst;
}

/** What to drop from a library over its forest build: among single shots
 *  and each subject's shots together, the drop that narrows the forest most
 *  per shot it costs (shots it disconnects included), then the one costing
 *  fewest shots. A subject's shots overlap, so dropping one of them alone
 *  often narrows nothing (Izta, round 3: 12 of 22 single drops). relink(shots)
 *  gives { shots, links }; bound(library) the forest build bytes. Null when
 *  nothing can go without leaving fewer than minShots. */
export function forestDrop(library, relink, bound, { minShots = 4 } = {}) {
  const now = bound(library), movable = library.shots.filter((s) => s.move !== 'rail'), bySubject = new Map();
  for (const s of movable) bySubject.set(s.subjectId, [...(bySubject.get(s.subjectId) || []), s]);
  let best = null;
  for (const group of [...movable.map((s) => [s]), ...[...bySubject.values()].filter((g) => g.length > 1)]) {
    const rest = relink(library.shots.filter((s) => !group.includes(s)));
    if (rest.shots.length < minShots) continue;
    const size = bound({ ...library, ...rest }), lost = library.shots.length - rest.shots.length, gain = (now - size) / lost;
    if (!best || gain > best.gain + 1e-9 || (Math.abs(gain - best.gain) <= 1e-9 && lost < best.lost)) best = { group, rest, size, lost, gain };
  }
  return best;
}

/**
 * Bake, pack and measure; while the region is over its byte or triangle
 * budget, drop the shot whose terrain is most its
 * own per unit of score, and try again. Returns the fitted result.
 */
export async function fitToBudget(built, { log = console.log, maxIterations = Infinity } = {}) {
  const { ctx, config, pairs = [], cost = null } = built;
  const shippedSha = sha(await fs.readFile(path.join(TERRAIN_DIR, `${ctx.viewId}.terrain.json`)));
  let library = { ...built.library };
  for (let iter = 1; ; iter++) {
    const bake = await bakeForLibrary(ctx, library, config, { log });
    if (bake.rebaked && !bake.validation.ok) throw new Error(`${ctx.viewId}: final terrain coverage failed (${bake.validation.holes.length} poses with holes, ${bake.validation.lod.length} LOD violations; mirror ${bake.mirrorLevelM ?? 'none'} m)`);
    const terrainSha = bake.rebaked ? sha(bake.manifestText) : shippedSha;
    const packed = packLibrary(ctx.viewId, ctx.view.regionId, terrainSha, library,
      { builtWith: 'tools/build-scenic-tours.mjs', configSha256: sha(JSON.stringify(config)), demSha256: ctx.grid.meta?.payload?.heights?.sha256 ?? null },
      config.motion, config.region.hero || []);
    const forest = await forestBuild(ctx, bake.rebaked ? bake.data : ctx.terrain.data, library);
    const budget = await budgetErrors(ctx, config, packed, bake, forest);
    log(`${ctx.viewId}: fit ${iter}: ${library.shots.length} shots / ${library.links.length} links, adds ${(budget.added / 1024).toFixed(0)} KiB${budget.errors.length ? ` -- ${budget.errors.join('; ')}` : ' -- within budget'}`);
    if (!budget.errors.length) return { library, bake, packed, budget, iterations: iter };
    if (iter >= maxIterations) return { library, bake, packed, budget, iterations: iter, failed: true, survey: true };
    // Drop shots until the cost model, calibrated on this bake, expects the
    // region's budget to hold (at least one per bake), re-linking the rest
    // from every scored pair rather than pruning orphans.
    const libBytes = Buffer.byteLength(packed.manifestText) + packed.payload.byteLength;
    const est = estimatedBytes([...library.shots, ...library.links], cost);
    const ratio = est > 0 ? Math.min(4, Math.max(0.25, (budget.added - libBytes) / est)) : 1;
    const perRecord = libBytes / Math.max(1, library.shots.length + library.links.length);
    const fits = (lib) => estimatedBytes([...lib.shots, ...lib.links], cost) * ratio + perRecord * (lib.shots.length + lib.links.length) <= 0.95 * config.budget.assetBytes;
    let dropped = 0;
    // Over the forest build: drop what narrows the forest most per shot lost.
    while (budget.forest && budget.forest.tour > budget.forest.cap && library.shots.length > 4) {
      const best = forestDrop(library, (shots) => linkLibrary(shots, pairs, config, cost), forest.bound);
      if (!best) break;
      log(`${ctx.viewId}: dropping ${best.group.map((s) => s.id).join(', ')}${best.lost > best.group.length ? ` (and ${best.lost - best.group.length} left unlinked)` : ''} (forest build to ${(best.size / 2 ** 20).toFixed(0)} MiB)`);
      library = { ...library, ...best.rest };
      dropped += best.lost;
      if (best.size <= budget.forest.cap) break;
    }
    while (library.shots.length > 4 && (!dropped || (cost && !fits(library)))) {
      const worst = costliestShot(library, cost, (shot) => linkLibrary(library.shots.filter((s) => s !== shot), pairs, config, cost).shots.length);
      if (!worst) break;
      log(`${ctx.viewId}: dropping ${worst.shot.id} (~${Math.round(worst.bytes * ratio / 1024)} KiB of its own)`);
      library = { ...library, ...linkLibrary(library.shots.filter((s) => s !== worst.shot), pairs, config, cost) };
      dropped++;
    }
    if (!dropped) return { library, bake, packed, budget, iterations: iter, failed: true };
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
    connectivity: fitted.library?.connectivity || null,
    linkVisibility: summarizeLinkVisibility(fitted.packed.manifest.links),
    libraryBytes: Buffer.byteLength(fitted.packed.manifestText) + fitted.packed.payload.byteLength }, null, 1));
}

/**
 * Publish: the library into src/assets/range/v2/tour, the re-culled terrain
 * (if any) over the view's package with its build record updated, and
 * shotsManifestUrl into scenic-views.json; then regenerate the catalog.
 * The library stays a candidate until --approve-tour records a review.
 * Unchanged terrain preserves base approval; a rebake still requires its
 * own base review with --approve before the tour can be approved.
 */
export async function publishView(viewId, fitted, { log = console.log } = {}) {
  const links = fitted.packed?.manifest?.links;
  if (!Array.isArray(links) || !summarizeLinkVisibility(links).allSafe) {
    throw new Error(`${viewId}: link terrain visibility is missing, invalid or all-sky; reselect the current fresh graph with --reselect before publishing`);
  }
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
  const { readAuthoring, AUTHORING, TOUR_AUTHORING, shotLibraryIdentity } = await import('./build-range-scene.mjs');
  const doc = await readAuthoring();
  const v = doc.views.find((x) => x.id === viewId);
  v.shotsManifestUrl = `tour/${viewId}.shots.json`;
  const tours = JSON.parse(await fs.readFile(TOUR_AUTHORING, 'utf8'));
  const region = tours.regions?.[viewId];
  if (!region) throw new Error(`${viewId}: no region block in scenic-tours.json`);
  const build = JSON.parse(await fs.readFile(path.join(TERRAIN_DIR, `${v.terrainSourceId || viewId}.build.json`), 'utf8'));
  region.library = await shotLibraryIdentity(v, build);
  region.status = 'candidate';
  delete region.approval;
  await fs.writeFile(TOUR_AUTHORING, JSON.stringify(tours, null, 2) + '\n');
  await fs.writeFile(AUTHORING, JSON.stringify(doc, null, 2) + '\n');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(root, 'tools', 'build-range-scene.mjs'), '--catalog'], { stdio: 'inherit' });
  if (fitted.bake.rebaked) log(`${viewId}: terrain changed; review and approve the base with --approve ${viewId} before approving the tour`);
  log(`${viewId}: published candidate tour; after review: node tools/build-range-scene.mjs --approve-tour ${viewId} --evidence docs/scenic-tours.md`);
}

/** A fitted build as writeFitted left it in `dir`, ready for publishView. */
export async function readFitted(viewId, dir) {
  const fit = JSON.parse(await fs.readFile(path.join(dir, 'fit.json'), 'utf8'));
  const manifestText = await fs.readFile(path.join(dir, `${viewId}.shots.json`), 'utf8');
  const packed = { manifestText, manifest: JSON.parse(manifestText), payload: await fs.readFile(path.join(dir, `${viewId}.shots.bin.gz`)) };
  const bake = { rebaked: fit.bake.rebaked, validation: { ok: fit.bake.validation.ok } };
  if (bake.rebaked) {
    bake.manifestText = await fs.readFile(path.join(dir, `${viewId}.terrain.json`), 'utf8');
    bake.manifest = JSON.parse(bake.manifestText);
    bake.payload = await fs.readFile(path.join(dir, `${viewId}.terrain.bin.gz`));
  }
  return { failed: fit.failed, packed, bake };
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const doc = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
  const id = opt('--view');
  // Publish a build reviewed earlier, without rebuilding it.
  if (opt('--publish-from')) {
    if (!doc.regions[id]) throw new Error('usage: node tools/build-scenic-tours.mjs --view <id> --publish-from DIR');
    await publishView(id, await readFitted(id, path.resolve(opt('--publish-from'))));
    return;
  }
  const ids = id === 'all' ? Object.keys(doc.regions) : (id || '').split(',').filter(Boolean);
  if (!ids.length || ids.some((v) => !doc.regions[v])) throw new Error('usage: node tools/build-scenic-tours.mjs --view <id>[,<id>]|all [--render] [--publish]');
  for (const viewId of ids) {
    const out = path.resolve(opt('--out') || path.join(root, '.smoke', 'scenic-tours', viewId));
    const built = args.includes('--reselect') ? await reselectViewTours(viewId, { out, workers: Number(opt('--workers')) || undefined })
      : await buildViewTours(viewId, { out, workers: Number(opt('--workers')) || undefined, renderGate: !args.includes('--no-render-gate') });
    const fitted = await fitToBudget(built, { maxIterations: args.includes('--survey') ? 1 : Infinity });
    await writeFitted(out, viewId, fitted);
    if (args.includes('--render')) {
      const candidate = fitted.bake.rebaked ? { manifestText: fitted.bake.manifestText, payload: fitted.bake.payload } : null;
      const scores = await renderReview(viewId, fitted.library, { out, terrain: candidate });
      await fs.writeFile(path.join(out, 'render.json'), JSON.stringify(Object.fromEntries(scores), null, 1));
      if (candidate) {
        const parity = await railParity(viewId, built.ctx.build.view.camera, candidate);
        const { contactSheet } = await import('./lib/scenic-render.mjs');
        await contactSheet([...parity.before, ...parity.after].map((p) => Buffer.from(p, 'base64')), { columns: parity.rows.length, tileWidth: 240,
          labels: [...parity.rows.map((r) => `shipped u=${r.u.toFixed(2)}`), ...parity.rows.map((r) => `re-culled u=${r.u.toFixed(2)}`)], out: path.join(out, `${viewId}-rail-parity.png`) });
        await fs.writeFile(path.join(out, 'rail-parity.json'), JSON.stringify({ ...parity, before: undefined, after: undefined }, null, 1));
        console.log(`${viewId}: rail parity ${parity.ok ? 'ok' : 'CHANGED'} (${parity.identical}/${parity.rows.length} identical frames, up to ${(100 * parity.maxChangedFrac).toFixed(2)}% of pixels changed, max terrain delta ${parity.maxTerrainFracDelta.toFixed(4)})`);
      }
    }
    const libraryKiB = (Buffer.byteLength(fitted.packed.manifestText) + fitted.packed.payload.byteLength) / 1024;
    console.log(`${viewId}: ${fitted.packed.manifest.shots.length} shots, ${fitted.packed.manifest.links.length} links, library ${libraryKiB.toFixed(1)} KiB, terrain ${fitted.bake.rebaked ? `re-culled (+${(fitted.bake.budget.addedBytes / 1024).toFixed(0)} KiB)` : 'unchanged'}${fitted.failed ? ' -- OVER BUDGET' : ''}`);
    if (args.includes('--publish')) await publishView(viewId, fitted);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
