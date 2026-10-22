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
import { strideCost, tourPoses, tourBakeOptions, bakeOptions } from './lib/scenic-cost.mjs';

import { SHOT_SCHEMA, SHOT_VERSION, packShotPaths, shotLibraryErrors, decodeShotLibrary, cameraFootprint } from '../src/world/terrain/ShotLibrary.js';
import { pathPoseAt, slicePath, pathLaneAt } from '../src/world/terrain/ShotPath.js';
import { bakeTerrain } from './lib/terrain-bake.mjs';
import { validatePoses, rangeAssetBytes, RANGE_ASSET_LIMIT } from './lib/scenic-coverage.mjs';
import { decodeTerrain } from '../src/world/alpine/TerrainMesh.js';

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

export async function buildViewTours(viewId, { out, workers = Math.max(2, os.cpus().length - 4), renderGate = true, log = console.log } = {}) {
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
  // Named subjects (the region's config and the view's landmarks) stay
  // wherever they are; DEM features only inside the focus area.
  const subjects = found.filter((s) => s.kind === 'rail-target' || s.source === 'config' || s.source === 'landmark'
    || Math.hypot(s.posM[0] - focus.center[0], s.posM[2] - focus.center[2]) <= focus.radiusM);
  ctx.focus = focus;
  // Views whose water is mapped rivers only (or none) have no DEM lakes to run along.
  const mappedWater = ctx.view.riverPolicy?.terrainWater === 'mapped-only' || ctx.view.water === false;
  const lines = { valleys: valleyPaths(ctx), shores: mappedWater ? [] : shorelines(ctx) };
  log(`${viewId}: ${subjects.length} subjects (${subjects.map((s) => s.name || s.kind).join(', ')}); ${lines.valleys.length} valleys, ${lines.shores.length} shores`);
  const generated = generateShots(ctx, subjects, lines, config.region, { maxPerSubject: config.discovery.shotsPerSubject * 6 });
  // The authored rail is always a candidate, wherever the focus lies.
  const candidates = generated.filter((c) => (c.move === 'rail' || inFocus(c.path, focus)) && steadyLook(c.path));
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
      for (const c of second) {
        const r = rendered.get(c.id)?.score;
        if (r != null) c.score = { ...c.score, dem: c.score.total, render: r, total: renderedTotal(c.score.total, r) };
      }
      const weak = second.filter((c) => c.move !== 'rail' && c.score.total === 0).length;
      log(`${viewId}: renderer scored ${rendered.size} candidates; ${weak} show no subject or render flat`);
    }
    // The candidate link graph: from each scored shot to its nearest few
    // within reach (exit to entry), every variant scored, on a leash (a
    // transit that cannot be flown within discovery.maxLinkS even at full
    // pace costs the song a payoff) and Pareto-pruned per pair.
    const maxLinkMs = (config.discovery.maxLinkS ?? 30) * 1000;
    const reachM = (maxLinkMs / 1000) * config.motion.maxSpeedMps;
    const usable = second.filter((c) => c.move === 'rail' || c.score.total > 0);
    const raw = [];
    for (const a of usable) {
      const next = usable.filter((b) => b !== a).map((b) => [b, endGap(a, b)]).filter(([, d]) => d <= reachM)
        .sort((x, y) => x[1] - y[1]).slice(0, config.discovery.linkFanout ?? 8);
      for (const [b] of next) for (const v of linkVariants(ctx, a, b, { linkMaxM: config.discovery.linkMaxM, transitMaxM: config.discovery.transitMaxM })) if (steadyLook(v.path)) raw.push({ from: a, to: b, ...v });
    }
    const linkScores = await Promise.all(raw.map((l) => pool.score('link', l.path, { everyM: 120, width: 96, height: 54 })));
    raw.forEach((l, i) => { l.score = linkScores[i].aggregate; l.path.flow = Float32Array.from(linkScores[i].flow); l.durationMs = durationRange(l.path, l.path.flow, config.motion); });
    const front = paretoFront(raw.filter((l) => l.durationMs.min <= maxLinkMs));
    // Tours stay inside a strongly connected part of the graph: take the
    // one whose best shots are worth most (the rail joins as the fallback).
    const component = bestComponent(usable, front, config.discovery.maxShots);
    log(`${viewId}: link graph ${raw.length} variants, ${front.length} usable within ${maxLinkMs / 1000} s; best connected part ${component.size} of ${usable.length} shots`);
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
    const shortlist = selectConnected(candidatesIn, front, config, cost);
    const library2 = linkLibrary(shortlist, await priceLinks(shortlist), config, cost);
    const shortlisted = shortlist.length;
    const variants = raw.length, pairs = front;
    log(`${viewId}: shortlisted ${shortlisted}: ${library2.shots.length} shots / ${library2.links.length} links connected, ~${Math.round(estimatedBytes([...library2.shots, ...library2.links], cost) / 1024)} KiB: ${library2.shots.map((x) => `${x.move}:${x.score.total.toFixed(2)}`).join(' ')}`);
    const linkedLib = library2;
    const library = { subjects, ...linkedLib };
    // Footprint: tiles the library needs beyond the shipped package, and the
    // terrain bytes the cost model expects them to add.
    const need = new Set(library.shots.concat(library.links).flatMap((r) => r.missing || []));
    const estimated = estimatedBytes([...library.shots, ...library.links], cost);
    const report = {
      viewId, builtAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, config,
      focus: ctx.focus, subjects, candidates: candidates.length,
      candidateScores: candidates.map((c) => ({ id: c.id, move: c.move, tags: c.tags, elevation: c.traits.elevation, lens: c.traits.lens,
        coarse: c.coarse ? { total: c.coarse.total, holes: c.coarse.holes, payoff: c.coarse.payoff } : null, full: c.score?.total ?? null })), scored: second.length, shortlisted, linkVariants: variants,
      shots: library.shots.map((s) => ({ id: s.id, move: s.move, subjectId: s.subjectId, lengthM: s.lengthM, payoffS: s.payoffS, holdS: s.holdS, score: s.score, traits: s.traits, durationMs: s.durationMs })),
      links: library.links.map((l) => ({ from: l.from.id, to: l.to.id, kind: l.kind, lengthM: l.lengthM, score: l.score })),
      missingTiles: [...need].sort((a, b) => a - b), estimatedTerrainBytes: estimated,
    };
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    log(`${viewId}: library ${library.shots.length} shots / ${library.links.length} links, ${need.size} tiles beyond the shipped package, ~${Math.round(estimated / 1024)} KiB terrain expected, ${report.seconds.toFixed(0)} s`);
    return { ctx, config, library, report, pairs, cost };
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

/** Straight distance from a shot's exit to another's entry (NaN without paths). */
export function endGap(a, b) {
  const p = a.path, q = b.path;
  if (!p || !q) return NaN;
  const i = (p.s.length - 1) * 3;
  return Math.hypot(p.eye[i] - q.eye[0], p.eye[i + 1] - q.eye[1], p.eye[i + 2] - q.eye[2]);
}

/** The strongly connected set of shots (by `links`) whose best `top`
 *  scores add up most (Tarjan); empty when no two shots join both ways. */
export function bestComponent(shots, links, top = 36) {
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
  const worth = (part) => part.map((x) => x.score.total).sort((a, b) => b - a).slice(0, top).reduce((a, b) => a + b, 0);
  return new Set(parts.sort((a, b) => worth(b) - worth(a))[0] || []);
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

/**
 * Selection state shared by selectShots and selectConnected: what a shot
 * is worth next to those already chosen. Terrain is charged with a cost
 * model (bytes its detail adds beyond the shipped package and the chosen
 * shots, discovery.byteWeight of score per 100 KB, stopping short of the
 * region's byte budget with room for links and records) or, without one,
 * per new tile (discovery.tileWeight per 100 tiles). Variety: penalties for
 * repeating a subject, a move, an elevation class, a lens, or a viewing
 * azimuth of the same subject.
 */
function selection(config, cost, chosen) {
  const perSubject = config.discovery.shotsPerSubject;
  const out = [...chosen], owned = new Set(out.flatMap((o) => o.missing || [])), paid = new Map();
  if (cost) for (const o of out) cost.own(o.footprint || new Map(), paid);
  const tileWeight = config.discovery.tileWeight ?? 0.25, byteWeight = config.discovery.byteWeight ?? 0.25;
  const room = (config.budget?.assetBytes ?? Infinity) * 0.85;
  let spent = estimatedBytes(out, cost);
  /** { v, bytes } for c next to `out` (plus `extra`), or null when it
   *  does not fit or is worth nothing. */
  const value = (c, extra = []) => {
    const others = extra.length ? [...out, ...extra] : out;
    const same = others.filter((o) => o.subjectId === c.subjectId);
    if (same.length >= perSubject) return null;
    let bytes = 0;
    if (cost) {
      const held = extra.length ? extra.reduce((m, x) => cost.own(x.footprint || new Map(), m), new Map(paid)) : paid;
      bytes = cost.marginal(c.footprint || new Map(), held);
      const before = extra.reduce((n, x) => n + (x.bytes || 0), 0);
      // Links add about a quarter again to the shots' terrain; each shot
      // brings its own record and about three links.
      if ((spent + before + bytes) * 1.25 + 4 * RECORD_BYTES * (others.length + 1) > room) return null;
    }
    let v = c.score.total - (cost ? byteWeight * bytes / 100000 : tileWeight * (c.missing || []).filter((t) => !owned.has(t)).length / 100);
    if (v <= 0) return null;
    const n = Math.max(1, others.length);
    v *= 1 - 0.12 * same.length;
    v *= 1 - 0.1 * others.filter((o) => o.move === c.move).length / n;
    v *= 1 - 0.25 * others.filter((o) => o.traits.elevation === c.traits.elevation).length / n;
    v *= 1 - 0.15 * others.filter((o) => o.traits.lens === c.traits.lens).length / n;
    for (const o of same) {
      const dAz = Math.abs(((o.traits.azimuthDeg - c.traits.azimuthDeg + 540) % 360) - 180);
      if (dAz < 25 && o.traits.elevation === c.traits.elevation) v *= 0.55;
    }
    return { v, bytes };
  };
  const take = (c, bytes) => {
    out.push(c);
    for (const t of c.missing || []) owned.add(t);
    if (cost) { cost.own(c.footprint || new Map(), paid); spent += bytes; }
  };
  return { out, value, take };
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
 * A connected shortlist grown by ears over the link graph: seeded with the
 * best two- or three-shot cycle, then extended only by a shot the set links
 * into and back out of, or a two-shot chain set -> a -> b -> set, whichever
 * is worth most per shot (selection()). Every shot so chosen has a way in
 * and a way out among the others. The rail joins as the fallback, linked or
 * not.
 */
export function selectConnected(scored, links, config, cost = null) {
  const rail = scored.filter((c) => c.move === 'rail');
  const pool = new Set(scored.filter((c) => c.move !== 'rail' && c.score.holes <= 0.002 && c.score.total > 0));
  const outs = new Map(), ins = new Map();
  for (const l of links) {
    if (!outs.has(l.from)) outs.set(l.from, new Set());
    if (!ins.has(l.to)) ins.set(l.to, new Set());
    outs.get(l.from).add(l.to); ins.get(l.to).add(l.from);
  }
  const has = (m, a, b) => m.get(a)?.has(b) || false;
  const sel = selection(config, cost, rail);
  const set = new Set(rail.filter((r) => [...(outs.get(r) || [])].some((x) => has(outs, x, r))));
  const max = config.discovery.maxShots;
  // Value of adding a group in order, or null when any member does not fit.
  const groupValue = (group) => {
    const extra = [];
    let total = 0;
    for (const c of group) {
      const w = sel.value(c, extra);
      if (!w) return null;
      total += w.v; extra.push(Object.assign(Object.create(c), { bytes: w.bytes }));
    }
    return { v: total / group.length, bytes: extra.map((x) => x.bytes) };
  };
  const better = (a, b) => !b || a.v > b.v || (a.v === b.v && a.key < b.key);
  const add = (best) => { best.group.forEach((c, i) => { sel.take(c, best.bytes[i]); set.add(c); pool.delete(c); }); };
  // Seed: the best cycle of two or three shots.
  let seed = null;
  for (const a of pool) {
    for (const b of outs.get(a) || []) {
      if (!pool.has(b)) continue;
      if (has(outs, b, a) && a.id < b.id) {
        const w = groupValue([a, b]);
        if (w && better({ ...w, key: a.id + b.id }, seed)) seed = { ...w, key: a.id + b.id, group: [a, b] };
      }
      for (const c of outs.get(b) || []) {
        if (c === a || !pool.has(c) || !has(outs, c, a) || !(a.id < b.id && a.id < c.id)) continue;
        const w = groupValue([a, b, c]);
        // A three-shot seed must beat a two-shot one per shot by a margin.
        if (w && better({ ...w, v: w.v * 0.95, key: a.id + b.id + c.id }, seed)) seed = { ...w, v: w.v * 0.95, key: a.id + b.id + c.id, group: [a, b, c] };
      }
    }
  }
  if (!seed) return sel.out;
  add(seed);
  // Ears: a single shot linked both ways to the set, or a chain of two.
  while (sel.out.length < max) {
    let best = null;
    for (const c of pool) {
      const into = [...(ins.get(c) || [])].some((x) => set.has(x));
      if (!into) continue;
      if ([...(outs.get(c) || [])].some((x) => set.has(x))) {
        const w = groupValue([c]);
        if (w && better({ ...w, key: c.id }, best)) best = { ...w, key: c.id, group: [c] };
      }
      if (sel.out.length + 2 > max) continue;
      for (const d of outs.get(c) || []) {
        if (!pool.has(d) || ![...(outs.get(d) || [])].some((x) => set.has(x))) continue;
        const w = groupValue([c, d]);
        if (w && better({ ...w, v: w.v * 0.95, key: c.id + d.id }, best)) best = { ...w, v: w.v * 0.95, key: c.id + d.id, group: [c, d] };
      }
    }
    if (!best) break;
    add(best);
  }
  return sel.out;
}

/** Each ordered pair's Pareto front of usable link variants (at most two). */
export function paretoFront(pairs) {
  const byPair = new Map();
  for (const l of pairs) {
    if (l.score.holes > 0.002) continue;
    const k = `${l.from.id}>${l.to.id}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(l);
  }
  return [...byPair.values()].flatMap((v) => keepParetoLinks(v, 2));
}

/** Pareto per pair, then at most maxLinksPerShot per origin, preferring
 *  distinct destinations and keeping each destination reachable. */
export function selectLinks(pairs, shots, config, cost = null) {
  const front = paretoFront(pairs);
  const out = [];
  // A link's worth is its scenery per second it costs the song, less the
  // new terrain it would add beyond the shots' own.
  const owned = new Set(shots.flatMap((x) => x.missing || []));
  const paid = cost ? shots.reduce((m, x) => cost.own(x.footprint || new Map(), m), new Map()) : null;
  const worth = new Map(front.map((l) => [l, l.score.total / (1 + (l.durationMs?.ideal ?? l.lengthM * 40) / 20000)
    - (cost ? (config.discovery.byteWeight ?? 0.25) * cost.marginal(l.footprint || new Map(), paid) / 100000
      : (config.discovery.tileWeight ?? 0.25) * (l.missing || []).filter((t) => !owned.has(t)).length / 100)]));
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
  // The rail shot is the authored rail, which the approved package (and the
  // rail stations every bake keeps) already covers, reflections included.
  return tourPoses(ctx, [...library.shots.filter((x) => x.move !== 'rail'), ...library.links], options);
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
  // The rail-only bake must reproduce the shipped heights, or the source
  // has drifted since the view was approved (reported, not hidden).
  const rail = await bakeTerrain(ctx.grid, ctx.build.view, bakeOptions(ctx));
  const drift = rail.manifest.payload.sha256 !== ctx.terrain.manifest.payload.sha256;
  const baked = await bakeTerrain(ctx.grid, ctx.build.view, tourBakeOptions(ctx, poses, scale));
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
export function packLibrary(viewId, regionId, terrainManifestSha256, library, provenance = {}, motion = null, heroNames = []) {
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
      score: { total: round(l.score.total), weakest: round(l.score.weakest ?? 0), composition: round(l.score.composition ?? 0) } };
  });
  const decoded = Buffer.from(packShotPaths([...shots, ...links]));
  const payload = zlib.gzipSync(decoded, { level: 9, mtime: 0 });
  payload[4] = payload[5] = payload[6] = payload[7] = 0; payload[9] = 255;
  const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'path'));
  const manifest = {
    schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId, regionId, terrainManifestSha256,
    axes: { x: 'east', y: 'up', z: 'south', units: 'metres' },
    ...(motion ? { motion } : {}), subjects, shots: shots.map(strip), links: links.map(strip),
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

/** Links for a set of shots, chosen afresh from every scored pair between
 *  them, and the shots both reachable and leavable through those links
 *  (the rail always stays: it is the fallback). */
export function linkLibrary(shots, pairs, config, cost = null) {
  let keep = shots, links = [];
  for (let changed = true; changed;) {
    const set = new Set(keep);
    links = selectLinks(pairs.filter((l) => set.has(l.from) && set.has(l.to)), keep, config, cost);
    const next = keep.filter((s) => s.move === 'rail' || (links.some((l) => l.from === s) && links.some((l) => l.to === s)));
    changed = next.length !== keep.length; keep = next;
  }
  return { shots: keep, links };
}

/** The shot whose terrain is most its own per unit of what it brings
 *  (score, and rarity: the only move, elevation or subject of its kind). */
export function costliestShot(library, cost) {
  const records = [...library.shots, ...library.links], all = estimatedBytes(records, cost);
  let worst = null;
  for (const shot of library.shots) {
    if (shot.move === 'rail') continue;
    const own = all - estimatedBytes(records.filter((r) => r !== shot && r.from !== shot && r.to !== shot), cost);
    const alone = (key) => library.shots.filter((o) => o !== shot && key(o) === key(shot)).length === 0;
    const rarity = 1 + 1.5 * alone((o) => o.move + (o.tags || []).join('+')) + 1.5 * alone((o) => o.traits.elevation) + 0.8 * alone((o) => o.subjectId);
    const c = (own + 4000) / (Math.max(0.05, shot.score.total) * rarity);
    if (!worst || c > worst.cost) worst = { shot, cost: c, bytes: own };
  }
  return worst;
}

/**
 * Bake, pack and measure; while the region is over its byte or triangle
 * budget (or the shared 60 MB), drop the shot whose terrain is most its
 * own per unit of score, and try again. Returns the fitted result.
 */
export async function fitToBudget(built, { log = console.log, maxIterations = Infinity } = {}) {
  const { ctx, config, pairs = [], cost = null } = built;
  const shippedSha = sha(await fs.readFile(path.join(TERRAIN_DIR, `${ctx.viewId}.terrain.json`)));
  let library = { ...built.library };
  for (let iter = 1; ; iter++) {
    const bake = await bakeForLibrary(ctx, library, config, { log });
    const terrainSha = bake.rebaked ? sha(bake.manifestText) : shippedSha;
    const packed = packLibrary(ctx.viewId, ctx.view.regionId, terrainSha, library,
      { builtWith: 'tools/build-scenic-tours.mjs', configSha256: sha(JSON.stringify(config)), demSha256: ctx.grid.meta?.payload?.heights?.sha256 ?? null },
      config.motion, config.region.hero || []);
    const budget = await budgetErrors(ctx, config, packed, bake);
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
    while (library.shots.length > 4 && (!dropped || (cost && !fits(library)))) {
      const worst = costliestShot(library, cost);
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
    const built = await buildViewTours(viewId, { out, workers: Number(opt('--workers')) || undefined, renderGate: !args.includes('--no-render-gate') });
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
