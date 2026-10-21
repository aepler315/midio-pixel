#!/usr/bin/env node
// Diagnostic: how far is each uncovered hero from ANY legal heading path?
// Replays an initial captured tour-worker request, then for every hero whose
// intended subject is not projected-covered, and for each same-role
// candidate, computes s*: the smallest uniform multiple of the published yaw
// capacity for which some heading sequence on the fixed eye path keeps the
// subject inside |NDC| <= .8 for the samples measureHeroFraming needs, while
// other accepted windows and the headings outside the approach stay fixed.
// Pitch is free (it is not rate limited outside stops). s* <= 1 means a legal
// shot exists under the hard limits; it does not mean the planner finds it,
// that the subject is unoccluded, or that the shot is musically right.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let at = 2; at < process.argv.length; at += 2) {
  const name = process.argv[at], value = process.argv[at + 1];
  assert.ok(['--request', '--source', '--out'].includes(name) && value, `Unknown or incomplete argument: ${name}`);
  options.set(name, value);
}
assert.ok(options.has('--request'), 'Usage: node tools/tour-reachability-check.mjs --request capture.json [--source DIR] [--out report.json]');
const source = path.resolve(options.get('--source') || root);
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const [{ decodeTour }, { planTour }, { buildTourTimeline }, { tourYawBudget }, { projectPoint }] = await Promise.all([
  load('src/world/terrain/TourPackage.js'), load('src/world/terrain/TourPlanner.js'), load('src/world/terrain/TourTimeline.js'),
  load('src/world/terrain/TourMotion.js'), load('src/world/terrain/SceneTravel.js'),
]);
const DEG = Math.PI / 180, clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const diff = (a, b) => ((a - b + 540) % 360 + 360) % 360 - 180;
const requestPath = path.resolve(options.get('--request'));
const capture = JSON.parse(await fs.readFile(requestPath, 'utf8'));
const input = capture.tourInputs?.[0]?.data || capture.request || capture;
assert.ok(!input.previous && !input.previousPresent, 'Reachability replays initial requests only');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'src/assets/range/v2/tour/teton-range-tour.tour.json'), 'utf8'));
const data = decodeTour(manifest, gunzipSync(await fs.readFile(path.join(source, 'src/assets/range/v2/tour/teton-range-tour.tour.bin.gz'))));
const energyAt = time => input.energy[Math.min(input.energy.length - 1, Math.max(0, Math.round(time / 250)))];
const plan = planTour(data, { sections: input.sections, roles: input.roles, durationMs: input.durationMs, energyAt, reducedMotion: input.reducedMotion });
const tour = buildTourTimeline(data, plan, { reducedMotion: input.reducedMotion });
const origin = tour.routeTimeOriginMs || 0, tau = tour.routeSlowTauSec || 0, scale = tour.scale || 1, count = tour.fov.length;
const frames = Array.from({ length: count }, (_, at) => {
  const timeMs = Math.min(tour.durationMs, at * 100), elapsed = Math.max(0, (timeMs - origin) / 1000);
  const clock = origin + 1000 * (elapsed / scale + (tau ? (1 - 1 / scale) * tau * (1 - Math.exp(-elapsed / tau)) : 0));
  return { ...plan.routeAt(clock), timeMs };
});
const budget = tourYawBudget(frames, { reducedMotion: tour.reducedMotion });
const capacity = Array.from({ length: count }, (_, i) => i ? budget(frames[i - 1].timeMs, frames[i].timeMs) : 0);
const headings = Array.from({ length: count }, (_, i) => {
  const v = [0, 1, 2].map(k => tour.target[i * 3 + k] - tour.eye[i * 3 + k]);
  return Math.atan2(v[0], -v[2]) / DEG;
});
const points = new Map(data.points.map(p => [p.id, p]));
const accepted = tour.heroFraming.filter(h => h.framedFraction >= .8).map(h => h.timeMs);

// Headings (unwrapped near `ref`) that keep `subject` covered at `time`, with
// the pitch centring it vertically. Null when no heading covers it.
function coveringInterval(time, subject, ref) {
  const pose = tour.poseAt(time), eye = pose.eyeM;
  const d = subject.localM.map((x, k) => x - eye[k]);
  const bearing = Math.atan2(d[0], -d[2]) / DEG, pitch = clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG, -25, 35);
  const covered = heading => {
    const v = [Math.sin(heading * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(heading * DEG) * Math.cos(pitch * DEG)];
    const q = projectPoint({ eyeM: eye, targetM: eye.map((x, k) => x + v[k] * 12000), fovYDeg: pose.fovYDeg }, 16 / 9, subject.localM);
    return d[0] * v[0] + d[1] * v[1] + d[2] * v[2] > 0 && q && Math.abs(q.x) <= .8 && Math.abs(q.y) <= .8;
  };
  if (!covered(bearing)) return null;
  let lo = 0, hi = 0;
  while (lo > -80 && covered(bearing + lo - .02)) lo -= .02;
  while (hi < 80 && covered(bearing + hi + .02)) hi += .02;
  const centre = ref + diff(bearing, ref);
  return [centre + lo, centre + hi, centre];
}

// Exact 1-D interval reachability: forward from the fixed heading before
// `start`, backward from the fixed heading after `end` when one follows.
function reachable(s, start, end, constraints, joinsAfter) {
  const forward = [];
  let lo = headings[start - 1], hi = lo;
  for (let i = start; i <= end; i++) {
    lo -= capacity[i] * s; hi += capacity[i] * s;
    const c = constraints.get(i);
    if (c) { lo = Math.max(lo, c[0]); hi = Math.min(hi, c[1]); }
    if (lo > hi + 1e-9) return false;
    forward[i] = [lo, hi];
  }
  if (!joinsAfter) return true;
  lo = hi = headings[start - 1] + diff(headings[end + 1], headings[start - 1]);
  for (let i = end; i >= start; i--) {
    lo -= capacity[i + 1] * s; hi += capacity[i + 1] * s;
    lo = Math.max(lo, forward[i][0]); hi = Math.min(hi, forward[i][1]);
    if (lo > hi + 1e-9) return false;
  }
  return true;
}

function analyse(hero, subject, released = []) {
  const others = accepted.filter(at => at !== hero.timeMs && !released.includes(at));
  const prior = others.filter(at => at < hero.timeMs), later = others.filter(at => at > hero.timeMs);
  // The same approach bounds composeDistantHeroes uses (TourTimeline.js).
  const priorEnd = prior.length ? Math.max(...prior) + 1500 : -100;
  const start = Math.max(1, Math.floor((hero.timeMs - 10000) / 100), Math.floor(priorEnd / 100) + 1);
  const end = Math.min(count - 1, Math.ceil((hero.timeMs + 7000) / 100), Math.floor((later.length ? Math.min(...later) - 1500 : Infinity) / 100));
  const w0 = Math.max(0, hero.timeMs - 1500), w1 = Math.min(tour.durationMs, hero.timeMs + 1500), samples = [];
  for (let t = w0; t < w1; t += 250) samples.push(t);
  samples.push(w1);
  const ref = headings[start - 1], intervals = samples.map(t => coveringInterval(t, subject, ref));
  const misses = samples.length - Math.ceil(.8 * samples.length - 1e-9), results = [];
  for (let skip = 0; skip <= misses; skip++) {
    if (intervals.slice(skip).some(x => !x)) { results.push({ skippedSamples: skip, sStar: null, reason: 'no heading covers a required sample' }); continue; }
    const constraints = new Map();
    const put = (i, c) => {
      if (i < start || i > end) return;
      const old = constraints.get(i);
      constraints.set(i, old ? [Math.max(old[0], c[0]), Math.min(old[1], c[1])] : c);
    };
    for (let k = skip; k < samples.length; k++) {
      put(Math.floor(samples[k] / 100), intervals[k]); put(Math.min(count - 1, Math.ceil(samples[k] / 100)), intervals[k]);
    }
    for (let i = start; i <= end; i++) {
      if (others.some(at => i >= Math.floor(Math.max(0, at - 1500) / 100) && i <= Math.ceil(Math.min(tour.durationMs, at + 1500) / 100))) {
        const h = ref + diff(headings[i], ref); put(i, [h - 1e-6, h + 1e-6]);
      }
    }
    if (!reachable(8, start, end, constraints, end < count - 1)) { results.push({ skippedSamples: skip, sStar: null, reason: 'infeasible at 8x capacity' }); continue; }
    let lo = 0, hi = 8;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (reachable(mid, start, end, constraints, end < count - 1)) hi = mid; else lo = mid; }
    results.push({ skippedSamples: skip, sStar: +hi.toFixed(4) });
  }
  const first = intervals.find(Boolean), approachMs = w0 - frames[start - 1].timeMs, approachCapacityDeg = budget(frames[start - 1].timeMs, w0);
  const best = Math.min(...results.map(r => r.sStar ?? Infinity));
  return { subject: subject.id, name: subject.name ?? null, approachStartMs: frames[start - 1].timeMs, approachMs,
    approachCapacityDeg: +approachCapacityDeg.toFixed(2), approachRateDegPerSecond: +(approachCapacityDeg / Math.max(.001, approachMs / 1000)).toFixed(2),
    composeEndMs: frames[end].timeMs, rejoinsFixedTimeline: end < count - 1, windowMs: [w0, w1], samples: samples.length, allowedMisses: misses,
    turnToCoverageEdgeDeg: first ? +Math.max(0, first[0] - ref, ref - first[1]).toFixed(2) : null,
    turnToCentreDeg: first ? +Math.abs(first[2] - ref).toFixed(2) : null, halfWidthDeg: first ? +((first[1] - first[0]) / 2).toFixed(2) : null,
    bestSStar: Number.isFinite(best) ? best : null, legal: best <= 1, results };
}

const report = { version: 1, kind: 'diagnostic', source, request: requestPath, durationMs: tour.durationMs, reducedMotion: tour.reducedMotion,
  limits: 'Heading reachability on the fixed eye path, FOV and protected windows only. Not a planner, occlusion, footprint, rendered or musical check.',
  heroes: [] };
for (const framing of tour.heroFraming) {
  if (framing.intendedFramedFraction >= .8) continue;
  const hero = tour.heroes.find(h => h.timeMs === framing.timeMs && h.pointId === framing.pointId);
  const intended = points.get(framing.intendedPointId);
  // Same role pool composeDistantHeroes draws alternatives from, unbounded.
  const pool = [intended, ...data.points.filter(p => p.id !== hero.pointId && p.role === intended?.role)].filter(Boolean);
  const rows = pool.map(subject => analyse(hero, subject)).sort((a, b) => (a.bestSStar ?? Infinity) - (b.bestSStar ?? Infinity));
  const prior = accepted.filter(at => at < hero.timeMs).sort((a, b) => b - a)[0];
  report.heroes.push({ pointId: framing.pointId, role: framing.role, finalChorus: framing.finalChorus, timeMs: framing.timeMs,
    outcome: framing.outcome, reason: framing.reason, intendedPointId: framing.intendedPointId, framedPointId: framing.framedPointId,
    framedFraction: framing.framedFraction, intendedFramedFraction: framing.intendedFramedFraction,
    intended: rows.find(r => r.subject === framing.intendedPointId) ?? null, best: rows.slice(0, 5),
    legalCandidates: rows.filter(r => r.legal).length, candidates: rows.length,
    // What the intended subject would need if the preceding accepted shot
    // were not protected: a trade-off, never applied by the planner.
    withoutPriorProtection: prior === undefined || !intended ? null : { priorMs: prior, intended: analyse(hero, intended, [prior]) } });
}
const output = path.resolve(options.get('--out') || path.join(root, '.smoke/tour-reachability/report.json'));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, heroes: report.heroes.map(h => ({ role: h.role, timeMs: Math.round(h.timeMs), outcome: h.outcome,
  intended: h.intendedPointId, intendedSStar: h.intended?.bestSStar ?? null, legalCandidates: `${h.legalCandidates}/${h.candidates}`,
  bestCandidate: h.best[0] ? `${h.best[0].subject}:${h.best[0].bestSStar}` : null,
  intendedWithoutPriorProtection: h.withoutPriorProtection?.intended.bestSStar ?? null })) }, null, 2));
