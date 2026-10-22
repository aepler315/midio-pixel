// Replay the runtime shot-tour planner offline: plan a view's library against
// a song's analysed sections, roles and energy (as captured by
// tools/song-structure-probe.mjs from the real upload/analysis path), build
// the timeline, and report the shot sequence, the payoff timing against the
// music, the pace against what the library allows, and the drawn camera's
// motion. Deterministic: the same inputs give the same plan as the browser
// worker.
//
//   node tools/plan-scenic-tour.mjs --library DIR_OR_MANIFEST --structure structure.json [--song anthem.wav]
//        [--seed N] [--visible 30-85,120-168] [--modules DIR] [--tunables JSON] [--json] [--out plan.json]
//
// --visible limits where the view is on screen (seconds), as the app does when a
// song's chapters move between views; without it the view holds the whole song.
// --modules DIR replays another copy of ShotPlanner.js + ShotTimeline.js (for
// before/after comparisons); the library is always decoded by this checkout's
// ShotLibrary.js and the bounds come from this checkout's planner. --tunables
// passes planner tunables (e.g. '{"vectorAccelRatio":2}' to hold the drawn
// eye's whole acceleration to 2x maxAccel).
//
// Report (all on the drawn camera or the plan, never on the timeline's own
// diagnostics):
//   bound    the most payoffs any sequence of shots and links could reach in
//            the song, by a DP over the library graph: with the library's own
//            minimum durations, and within the motion limits (each part at
//            its speed cap: maxSpeed, the energetic flow limit, and the
//            drawn eye's tangential bend) -- each also without a subject
//            twice in a row
//   pace     visible payoffs, the longest stretch without one, and every leg
//            (knot to knot) against the comfortable pace for its music
//            (flowCalm..flowEnergetic over the leg's flow lane, capped by
//            maxSpeedMps); a leg below half of it crawls
//   music    the error of every ground-truth payoff and how many land within
//            150 ms (the climax's subject among them), the strong impacts
//            (top third by strength, at a section boundary) hit within 150 ms
//            of the detector's times against how many any plan could hit,
//            the climax subject, the outro
//   motion   poseAt at 60 Hz: tangential and vector eye acceleration and yaw
//            over 100 ms windows, the sideways share, the last 100 ms, and
//            second-difference outliers (spikes) at keys and item joins
//   variety  subjects twice in a row, moves three times in a row, the longest
//            elevation, lens and foreground runs
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeShotLibrary } from '../src/world/terrain/ShotLibrary.js';
import { musicMoments } from '../src/world/terrain/ShotMusic.js';
import { pathLaneAt } from '../src/world/terrain/ShotPath.js';
import * as livePlanner from '../src/world/terrain/ShotPlanner.js';
import * as liveTimeline from '../src/world/terrain/ShotTimeline.js';

const GENTLE = new Set(['rail', 'orbit', 'pullback', 'traverse']);

/** A library from a directory holding <view>.shots.json + .shots.bin.gz, or a
 *  manifest path; `manifestSha256` is the manifest file's SHA-256. */
export async function readLibrary(where) {
  const stat = await fs.stat(where);
  const manifestPath = stat.isDirectory() ? path.join(where, (await fs.readdir(where)).find((f) => f.endsWith('.shots.json'))) : where;
  const raw = await fs.readFile(manifestPath), manifest = JSON.parse(raw.toString('utf8'));
  const decoded = zlib.gunzipSync(await fs.readFile(path.join(path.dirname(manifestPath), manifest.payload.url)));
  const library = decodeShotLibrary(manifest, new Uint8Array(decoded));
  library.manifestSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  return library;
}

/** Song inputs (sections, roles, energy) for one probed song. */
export function songInputs(structure, file = null) {
  const song = file ? structure.songs.find((s) => s.file === file) : structure.songs[0];
  if (!song) throw new Error(`no probed song ${file}`);
  const d = song.detected;
  return { file: song.file, form: song.form, durationMs: Math.round(d.durationMs), sections: d.sections,
    roles: d.roles, energy: Float32Array.from(d.energy), energyStepMs: d.energyStepMs };
}

/** Planner and timeline modules: this checkout's, or another copy's (DIR
 *  holding ShotPlanner.js and ShotTimeline.js). */
export async function loadModules(dir = null) {
  if (!dir) return { planShotTour: livePlanner.planShotTour, buildShotTimeline: liveTimeline.buildShotTimeline, restoreShotTimeline: liveTimeline.restoreShotTimeline };
  const at = (f) => pathToFileURL(path.resolve(dir, f)).href;
  const [p, t] = await Promise.all([import(at('ShotPlanner.js')), import(at('ShotTimeline.js'))]);
  return { planShotTour: p.planShotTour, buildShotTimeline: t.buildShotTimeline, restoreShotTimeline: t.restoreShotTimeline };
}

// ---------------------------------------------------------------- bounds

/** Seconds for every shot's head (entry to payoff) and tail (payoff to exit)
 *  and every link: at the library's minimum durations, or within the motion
 *  limits (each part at its own speed cap). */
export function partTimes(library, mode = 'library', tunables = {}) {
  if (mode === 'library') {
    return {
      head: library.shots.map((s) => s.durationMs.min / 1000 * s.payoffS / s.lengthM),
      tail: library.shots.map((s) => s.durationMs.min / 1000 * (s.lengthM - s.payoffS) / s.lengthM),
      link: library.links.map((l) => l.durationMs.min / 1000),
    };
  }
  const caps = livePlanner.shotPaceLimits(library, tunables);
  return {
    head: caps.head.map((p) => p.lengthM / p.capMps), tail: caps.tail.map((p) => p.lengthM / p.capMps),
    link: caps.link.map((p) => p.lengthM / p.capMps),
  };
}

/**
 * The most payoffs reachable within `durationMs` (DP over the graph: the
 * earliest time each shot's k-th payoff can come). `noRepeat` forbids a
 * link between two shots of one subject. Returns { count, firstMs, gapsMs }.
 */
export function payoffBound(library, times, durationMs, { noRepeat = false } = {}) {
  const shots = library.shots, n = shots.length, index = new Map(shots.map((s, i) => [s.id, i])), D = durationMs / 1000;
  let f = Float64Array.from(times.head), count = 0;
  const at = [];
  for (;;) {
    let m = Infinity;
    for (let i = 0; i < n; i++) m = Math.min(m, f[i]);
    if (!(m <= D)) break;
    count++; at.push(m);
    const g = new Float64Array(n).fill(Infinity);
    library.links.forEach((l, j) => {
      const a = index.get(l.from), b = index.get(l.to);
      if (noRepeat && shots[a].subjectId === shots[b].subjectId) return;
      g[b] = Math.min(g[b], f[a] + times.tail[a] + times.link[j] + times.head[b]);
    });
    f = g;
  }
  return { count, firstMs: at.length ? at[0] * 1000 : null, gapsMs: at.slice(1).map((t, i) => (t - at[i]) * 1000) };
}

/** Shortest payoff-to-payoff time between every pair of shots (any chain),
 *  and every shot's earliest payoff from the song start (seconds). */
function reachTables(library, times) {
  const shots = library.shots, n = shots.length, index = new Map(shots.map((s, i) => [s.id, i]));
  const d = Array.from({ length: n }, () => new Float64Array(n).fill(Infinity));
  library.links.forEach((l, j) => {
    const a = index.get(l.from), b = index.get(l.to);
    d[a][b] = Math.min(d[a][b], times.tail[a] + times.link[j] + times.head[b]);
  });
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return { d, earliest: Float64Array.from(times.head) };
}

/** The most of `targets` (ms, ascending) that one tour could put payoffs on
 *  (any shot, slower legs always possible), and which shots could take a
 *  given target alone: { count, single: [bool], heroAt(t) }. */
export function targetReach(library, times, targets) {
  const { d, earliest } = reachTables(library, times), n = library.shots.length;
  const best = targets.map(() => new Float64Array(n).fill(-Infinity));
  targets.forEach((t, k) => {
    for (let i = 0; i < n; i++) {
      if (earliest[i] <= t / 1000) best[k][i] = 1;
      for (let q = 0; q < k; q++) for (let j = 0; j < n; j++) if (best[q][j] > -Infinity && d[j][i] <= (t - targets[q]) / 1000 && best[q][j] + 1 > best[k][i]) best[k][i] = best[q][j] + 1;
    }
  });
  const count = Math.max(0, ...best.map((row) => Math.max(...row)));
  const single = targets.map((t) => library.shots.some((_, i) => earliest[i] <= t / 1000));
  const heroAt = (t) => library.shots.some((s, i) => library.subjectById?.get(s.subjectId)?.hero && earliest[i] <= t / 1000);
  return { count, single, heroAt };
}

// ---------------------------------------------------------------- motion

/** How near an item join a motion spike counts as the join's (ms). */
export const JOIN_SPIKE_MS = 50;

/**
 * Motion as the viewer sees it, measured on the drawn camera independently
 * of the timeline's own diagnostics: poseAt sampled at `hz`, eye velocity by
 * central differences; over `windowMs` the change of speed (tangential), of
 * the velocity vector (so turns count) and of the look heading (yaw); the
 * sideways part of the vector change; the last window of the song; and
 * spikes: frames whose second difference of the eye stands out against its
 * neighbourhood (ratio to the median over +-250 ms, floor 0.5 m/s2), noting
 * whether they fall at a 100 ms key or within 50 ms of an item join.
 */
export function motionAudit(timeline, { hz = 60, windowMs = 100 } = {}) {
  const dt = 1 / hz, n = Math.floor((timeline.durationMs / 1000) * hz), w = Math.max(1, Math.round((windowMs / 1000) * hz / 2)), t0 = timeline.startMs ?? 0;
  const eye = [], yaw = [];
  for (let k = 0; k <= n; k++) {
    const p = timeline.poseAt((k * 1000) / hz);
    eye.push(p.eyeM); yaw.push(Math.atan2(p.targetM[0] - p.eyeM[0], -(p.targetM[2] - p.eyeM[2])));
  }
  const vel = eye.map((_, k) => (k === 0 || k === n ? null : eye[k + 1].map((v, i) => (v - eye[k - 1][i]) / (2 * dt))));
  const stat = () => ({ values: [], worst: null });
  const tan = stat(), acc = stat(), side = stat(), turn = stat(), speed = [];
  for (let k = 1; k < n; k++) speed[k] = Math.hypot(...vel[k]);
  for (let k = 1 + w; k < n - w; k++) {
    if (k * 1000 / hz < t0) continue;
    const a = vel[k + w], b = vel[k - w], span = 2 * w * dt, dv = a.map((v, i) => v - b[i]);
    const vec = Math.hypot(...dv) / span, tg = Math.abs(speed[k + w] - speed[k - w]) / span;
    const u = vel[k], ul = Math.hypot(...u) || 1, along = (dv[0] * u[0] + dv[1] * u[1] + dv[2] * u[2]) / ul / span;
    const lat = Math.sqrt(Math.max(0, vec * vec - along * along));
    const y = Math.abs(((yaw[k + w] - yaw[k - w]) * 180 / Math.PI + 540) % 360 - 180) / span;
    for (const [st, v] of [[tan, tg], [acc, vec], [side, lat], [turn, y]]) { st.values.push(v); if (!st.worst || v > st.worst.v) st.worst = { v, k }; }
  }
  const summary = (st) => {
    const sorted = Float64Array.from(st.values).sort(), at = st.worst ? (st.worst.k * 1000) / hz : null;
    return { max: st.worst?.v ?? 0, p99: sorted[Math.floor(0.99 * (sorted.length - 1))] ?? 0, atMs: at, item: at == null ? null : timeline.stateAt(at).id };
  };
  // The song's last window, measured one-sided (the camera's final 100 ms).
  const last = n - 1, first = Math.max(1, last - 2 * w), lastAccel = vel[first] && vel[last]
    ? { vector: Math.hypot(...vel[last].map((v, i) => v - vel[first][i])) / ((last - first) * dt), tangential: Math.abs(speed[last] - speed[first]) / ((last - first) * dt) } : null;
  // Spikes: second difference against the local median.
  const d2 = new Float64Array(n + 1);
  for (let k = 1; k < n; k++) d2[k] = Math.hypot(...eye[k + 1].map((v, i) => v - 2 * eye[k][i] + eye[k - 1][i])) / (dt * dt);
  const joins = (timeline.items || []).slice(1).map((it) => it.startMs).filter((t) => t > t0);
  const h = Math.round(.25 * hz), spikes = [];
  for (let k = 1 + h; k < n - h; k++) {
    if (k * 1000 / hz < t0) continue;
    const around = [];
    for (let j = k - h; j <= k + h; j++) if (Math.abs(j - k) > 1) around.push(d2[j]);
    around.sort((a, b) => a - b);
    const ratio = d2[k] / Math.max(.5, around[around.length >> 1]);
    // A local maximum only; `key` when the frame is a 100 ms key, `join` when
    // within JOIN_SPIKE_MS of an item join (a join's turn spreads over a
    // sample or two).
    if (ratio > 3 && d2[k] >= d2[k - 1] && d2[k] >= d2[k + 1]) {
      const t = (k * 1000) / hz;
      spikes.push({ atMs: t, ratio, d2: d2[k], key: k % Math.round(hz / 10) === 0, join: joins.some((j) => Math.abs(j - t) <= JOIN_SPIKE_MS) });
    }
  }
  spikes.sort((a, b) => b.ratio - a.ratio);
  const legs = (timeline.items || []).filter((it) => it.endMs > t0).map((it) => {
    const ks = speed.map((v, k) => [v, (k * 1000) / hz]).filter(([v, t]) => v != null && t >= it.startMs && t < it.endMs).map(([v]) => v);
    return { kind: it.kind, id: it.id, startMs: it.startMs, endMs: it.endMs, meanSpeedMps: ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : 0 };
  });
  return { tangentialMps2: summary(tan), accelMps2: summary(acc), sidewaysMps2: summary(side), yawDegPerSec: summary(turn), lastAccel,
    spikes: { count: spikes.length, atJoins: spikes.filter((s) => s.join).length, atKeys: spikes.filter((s) => s.key).length, worst: spikes.slice(0, 5) }, legs };
}

// ---------------------------------------------------------------- plan metrics

/** Global progress of every item start and of each knot (start, payoffs, end). */
function planKnots(library, plan) {
  const items = plan.items, G = [0];
  items.forEach((it) => G.push(G.at(-1) + it.sTo - it.sFrom));
  const knots = [{ t: items[0]?.startMs ?? 0, S: 0, item: -1 }];
  items.forEach((it, i) => {
    if (it.kind !== 'shot' || !Number.isFinite(it.payoffMs)) return;
    const shot = library.shotById.get(it.id), payoffS = Math.min(shot.payoffS, shot.path.s[shot.path.s.length - 1]);
    if (payoffS < it.sFrom - 1e-6 || payoffS > it.sTo + 1e-6 || it.payoffMs <= knots.at(-1).t) return;
    knots.push({ t: it.payoffMs, S: G[i] + payoffS - it.sFrom, item: i, hidden: !!it.hidden });
  });
  if (knots.at(-1).t < plan.durationMs) knots.push({ t: plan.durationMs, S: G.at(-1), item: -1 });
  return { G, knots };
}

/** Length-weighted flow integral of the plan between global progress a and b. */
function flowIntegral(library, plan, G, a, b) {
  let sum = 0;
  plan.items.forEach((it, i) => {
    const lo = Math.max(a, G[i]), hi = Math.min(b, G[i + 1]);
    if (!(hi > lo)) return;
    const p = (it.kind === 'link' ? library.linkById : library.shotById).get(it.id).path, steps = Math.max(2, Math.ceil((hi - lo) / 10));
    for (let k = 0; k < steps; k++) sum += pathLaneAt(p, p.flow, it.sFrom + lo - G[i] + (k + .5) * (hi - lo) / steps) * (hi - lo) / steps;
  });
  return sum;
}

/** The longest stretch on screen without a payoff (ms): measured inside each
 *  visible interval (from the plan's start), never across time off screen. */
export function longestPayoffGap(visible, payoffTimesMs, { startMs = 0, durationMs }) {
  let longest = 0;
  for (const v of visible) {
    const a = Math.max(v.startMs, startMs), b = Math.min(v.endMs, durationMs);
    if (!(b > a)) continue;
    const times = [a, ...payoffTimesMs.filter((t) => t > a && t < b).sort((x, y) => x - y), b];
    for (let i = 1; i < times.length; i++) longest = Math.max(longest, times[i] - times[i - 1]);
  }
  return longest;
}

/** Everything the brief's targets measure, for one plan + timeline. */
export function planMetrics(library, inputs, plan, timeline, audit, { tunables = {} } = {}) {
  const T = { ...liveTimeline.shotMotion(library, tunables) }, D = plan.durationMs;
  const music = musicMoments({ durationMs: D, sections: inputs.sections, roles: inputs.roles, energy: inputs.energy, energyStepMs: inputs.energyStepMs });
  const shots = plan.items.filter((it) => it.kind === 'shot').map((it) => ({ ...it, rec: library.shotById.get(it.id) }));
  const shown = shots.filter((it) => Number.isFinite(it.payoffMs) && !it.hidden && it.payoffMs > (plan.start?.timeMs ?? 0));
  const visible = plan.visible?.length ? plan.visible : [{ startMs: 0, endMs: D }];
  const fullSong = visible.length === 1 && visible[0].startMs <= 0 && visible[0].endMs >= D;

  // Pace: payoffs, the longest stretch on screen without one, legs.
  const longestGapMs = longestPayoffGap(visible, shown.map((it) => it.payoffMs), { startMs: plan.start?.timeMs ?? 0, durationMs: D });
  const { G, knots } = planKnots(library, plan), flowAt = (I) => T.flowCalm + (T.flowEnergetic - T.flowCalm) * I;
  const intensityMean = (a, b) => { let s = 0, c = 0; for (let t = a; t <= b; t += 100) { s += music.intensityAt(t); c++; } return c ? s / c : .5; };
  const legs = [];
  for (let k = 1; k < knots.length; k++) {
    const a = knots[k - 1], b = knots[k], dS = b.S - a.S, dt = (b.t - a.t) / 1000;
    if (!(dt > 0) || !(dS > 0)) continue;
    const I = intensityMean(a.t, b.t), flow = flowIntegral(library, plan, G, a.S, b.S) / dS;
    const comfort = Math.min(T.maxSpeedMps, flowAt(I) / Math.max(1e-9, flow)), v = dS / dt;
    legs.push({ fromMs: a.t, toMs: b.t, lengthM: dS, speedMps: v, comfortMps: comfort, ratio: v / comfort, intensity: I });
  }
  const crawl = legs.filter((l) => l.ratio < .5);

  // Music: ground truth, strong impacts, climax, outro.
  const nearestPayoff = (t) => shown.reduce((best, it) => (!best || Math.abs(it.payoffMs - t) < Math.abs(best.payoffMs - t) ? it : best), null);
  const groundTruth = (inputs.form?.payoffs || []).map((p) => {
    const it = nearestPayoff(p.timeMs), errorMs = it ? it.payoffMs - p.timeMs : null;
    const onScreen = visible.some((v) => p.timeMs >= v.startMs && p.timeMs <= v.endMs);
    return { kind: p.kind, timeMs: p.timeMs, climax: !!p.climax, errorMs, shot: it?.id ?? null, move: it?.rec.move ?? null,
      hero: it ? !!library.subjectById.get(it.rec.subjectId)?.hero : null, visible: onScreen,
      hit: onScreen && errorMs !== null && Math.abs(errorMs) <= 150 };
  });
  const gtClimax = groundTruth.find((p) => p.climax) ?? null;
  const byStrength = [...music.impacts].sort((a, b) => b.strength - a.strength), cut = byStrength[Math.max(0, Math.ceil(byStrength.length / 3) - 1)]?.strength ?? Infinity;
  // Near a section start: a chorus/drop boundary rise, or within 3 s of any detected section start.
  const starts = (inputs.sections || []).map((s) => s.startMs).filter((t) => t > 0);
  const strong = music.impacts.filter((m) => m.strength >= cut && (m.boundary || starts.some((t) => Math.abs(t - m.timeMs) <= 3000))
    && visible.some((v) => m.timeMs >= v.startMs && m.timeMs <= v.endMs));
  const hitOf = (m) => shown.find((it) => Math.abs(it.payoffMs - m.timeMs) <= 150) || null;
  const strongHits = strong.filter(hitOf).length;
  const climaxItem = music.climax ? hitOf(music.climax) : null;
  const last = shots.at(-1)?.rec, finalChorus = music.climax ? shots.filter((it) => it.endMs > music.climax.timeMs).map((it) => it.rec.move) : [];

  // Bounds (full song only) and reach.
  const lib = partTimes(library, 'library', tunables), mot = partTimes(library, 'motion', tunables);
  const bound = fullSong ? {
    library: payoffBound(library, lib, D), libraryNoRepeat: payoffBound(library, lib, D, { noRepeat: true }),
    motion: payoffBound(library, mot, D), motionNoRepeat: payoffBound(library, mot, D, { noRepeat: true }),
  } : null;
  const reach = targetReach(library, mot, strong.map((m) => m.timeMs));
  const gtReach = targetReach(library, mot, groundTruth.filter((p) => p.visible).map((p) => p.timeMs));

  // Variety.
  const run = (key) => { let best = 0, cur = 0, prev; for (const it of shots) { const v = key(it.rec); cur = v === prev ? cur + 1 : 1; prev = v; best = Math.max(best, cur); } return best; };
  let subjectRepeats = 0, moveTriples = 0;
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].rec.subjectId === shots[i - 1].rec.subjectId) subjectRepeats++;
    if (i >= 2 && shots[i].rec.move === shots[i - 1].rec.move && shots[i].rec.move === shots[i - 2].rec.move) moveTriples++;
  }
  const elev = (s) => s.traits?.elevation ?? (s.traits.aglM < 450 ? 'low' : s.traits.aglM < 750 ? 'mid' : 'high');

  // Calm and energetic payoffs: move class and the speed of the leg into them.
  const inCalm = (t) => music.calm.some((c) => t >= c.startMs && t <= c.endMs);
  const legInto = (t) => legs.find((l) => l.toMs === t);
  const calm = shown.filter((it) => inCalm(it.payoffMs)), energetic = shown.filter((it) => !inCalm(it.payoffMs) && music.intensityAt(it.payoffMs) >= .6);
  const describe = (list) => ({ count: list.length, gentle: list.filter((it) => GENTLE.has(it.rec.move)).length,
    meanLegMps: list.length ? list.reduce((n, it) => n + (legInto(it.payoffMs)?.speedMps ?? 0), 0) / list.length : null });

  return {
    manifest: library.manifestSha256?.slice(0, 12) ?? null, durationMs: D, fallback: plan.fallback ?? null,
    payoffs: shown.length, payoffTimesMs: shown.map((it) => it.payoffMs), longestGapMs, bound,
    legs: { count: legs.length, crawl: crawl.length, minRatio: legs.length ? Math.min(...legs.map((l) => l.ratio)) : null, list: legs },
    groundTruth, groundTruthReach: gtReach.count, groundTruthHits: groundTruth.filter((p) => p.hit).length, groundTruthVisible: groundTruth.filter((p) => p.visible).length,
    strong: { count: strong.length, hit: strongHits, reachable: reach.count, times: strong.map((m) => m.timeMs) },
    climax: music.climax ? { timeMs: music.climax.timeMs, hit: !!climaxItem, hero: climaxItem ? !!library.subjectById.get(climaxItem.rec.subjectId)?.hero : false,
      heroReachable: reach.heroAt(music.climax.timeMs), shot: climaxItem?.id ?? null,
      // The detector's climax is judged against its own time above; against the song's ground truth here.
      groundTruth: gtClimax && { timeMs: gtClimax.timeMs, errorMs: gtClimax.errorMs, hit: gtClimax.hit, hero: gtClimax.hit && gtClimax.hero } } : null,
    outro: last ? { move: last.move, tags: last.tags || [], elevation: elev(last), afterClimax: finalChorus } : null,
    variety: { subjectRepeats, moveTriples, elevationRun: run(elev), lensRun: run((s) => s.traits.lens), foregroundRun: run((s) => s.tags?.includes('foreground-pass') || null) },
    calm: describe(calm), energetic: describe(energetic),
    motion: { limits: { maxAccelMps2: T.maxAccelMps2, maxYawDegPerSec: T.maxYawDegPerSec }, tangential: audit.tangentialMps2, vector: audit.accelMps2,
      sideways: audit.sidewaysMps2, yaw: audit.yawDegPerSec, last100ms: audit.lastAccel, spikes: audit.spikes },
  };
}

/** Plan + timeline + metrics. */
export async function replay(library, inputs, { seed = 315, visible = null, modules = null, tunables = {} } = {}) {
  const m = modules || await loadModules();
  const t0 = performance.now();
  const plan = m.planShotTour(library, { durationMs: inputs.durationMs, sections: inputs.sections, roles: inputs.roles,
    energy: inputs.energy, energyStepMs: inputs.energyStepMs, visible: visible || [{ startMs: 0, endMs: inputs.durationMs }], seed, tunables });
  const t1 = performance.now();
  const timeline = m.restoreShotTimeline(m.buildShotTimeline(library, plan, { tunables }));
  const t2 = performance.now();
  const shots = plan.items.filter((i) => i.kind === 'shot').map((i) => {
    const s = library.shotById.get(i.id);
    return { id: i.id, move: s.move, subjectId: s.subjectId, startMs: i.startMs, endMs: i.endMs, payoffMs: i.payoffMs ?? null, hidden: !!i.hidden,
      lens: s.traits.lens, elevation: s.traits.elevation, tags: s.tags || [], score: s.score.total };
  });
  const audit = motionAudit(timeline);
  const metrics = planMetrics(library, inputs, plan, timeline, audit, { tunables });
  return { plan, timeline, planMs: t1 - t0, timelineMs: t2 - t1, shots, moments: plan.moments, notes: plan.notes,
    diagnostics: timeline.diagnostics, audit, metrics, fallback: plan.fallback };
}

const f1 = (v) => (v == null ? '-' : (v / 1000).toFixed(1));
async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (!opt('--library') || !opt('--structure')) throw new Error('usage: node tools/plan-scenic-tour.mjs --library DIR --structure structure.json [--song file.wav] [--seed N] [--visible a-b,...] [--modules DIR] [--tunables JSON] [--json]');
  const library = await readLibrary(path.resolve(opt('--library')));
  const inputs = songInputs(JSON.parse(await fs.readFile(path.resolve(opt('--structure')), 'utf8')), opt('--song'));
  const visible = opt('--visible')?.split(',').map((w) => { const [a, b] = w.split('-').map(Number); return { startMs: a * 1000, endMs: b * 1000 }; }) ?? null;
  const r = await replay(library, inputs, { seed: Number(opt('--seed') ?? 315), visible, modules: await loadModules(opt('--modules')), tunables: JSON.parse(opt('--tunables') ?? '{}') });
  const x = r.metrics;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ viewId: library.viewId, song: inputs.file, seed: Number(opt('--seed') ?? 315), planMs: r.planMs, timelineMs: r.timelineMs,
      shots: r.shots.map(({ id, move, subjectId, payoffMs, hidden }) => ({ id, move, subjectId, payoffMs, hidden })), metrics: { ...x, legs: { ...x.legs, list: undefined } } }));
  } else {
    console.log(`${library.viewId} (manifest ${x.manifest}) x ${inputs.file}: ${r.shots.length} shots, plan ${r.planMs.toFixed(1)} ms, timeline ${r.timelineMs.toFixed(1)} ms${r.fallback ? `, FALLBACK ${r.fallback}` : ''}`);
    for (const s of r.shots) {
      console.log(`  ${f1(s.startMs).padStart(6)}-${f1(s.endMs).padEnd(6)} payoff ${s.payoffMs == null ? '   -  ' : `${f1(s.payoffMs).padStart(6)}${s.hidden ? ' (off screen)' : ''}`}  ${s.move.padEnd(9)} ${s.lens.padEnd(6)} ${String(s.elevation).padEnd(5)} ${s.subjectId}`);
    }
    const b = x.bound;
    console.log(`  pace: ${x.payoffs} payoffs on screen${b ? ` (bound: library ${b.library.count}, no repeat ${b.libraryNoRepeat.count}; within motion limits ${b.motion.count}, no repeat ${b.motionNoRepeat.count})` : ''}; longest gap ${f1(x.longestGapMs)} s;`
      + ` ${x.legs.crawl} of ${x.legs.count} legs crawl (min ${x.legs.minRatio?.toFixed(2)} x comfortable)`);
    for (const l of x.legs.list) console.log(`    leg ${f1(l.fromMs).padStart(6)}-${f1(l.toMs).padEnd(6)} ${l.lengthM.toFixed(0).padStart(5)} m at ${l.speedMps.toFixed(1).padStart(5)} m/s, comfortable ${l.comfortMps.toFixed(1).padStart(5)} (${l.ratio.toFixed(2)}x, intensity ${l.intensity.toFixed(2)})`);
    for (const p of x.groundTruth) console.log(`  ${p.kind} at ${f1(p.timeMs)} s -> ${p.shot ? `payoff ${p.errorMs >= 0 ? '+' : ''}${p.errorMs} ms (${p.move}${p.hero ? ', hero' : ''})` : 'none'}`);
    const onShot = (c) => (c.hit ? (c.hero ? 'on a hero shot' : 'on a non-hero shot') : 'missed');
    if (x.groundTruth.length) console.log(`  ground truth: ${x.groundTruthHits} of ${x.groundTruthVisible} on-screen payoffs within 150 ms (at most ${x.groundTruthReach} reachable together)${x.climax?.groundTruth ? `; climax ${f1(x.climax.groundTruth.timeMs)} s ${onShot(x.climax.groundTruth)}` : ''}`);
    console.log(`  strong impacts (detector times) ${x.strong.hit} of ${x.strong.count} hit (at most ${x.strong.reachable} reachable together)${x.climax ? `; climax ${f1(x.climax.timeMs)} s ${onShot(x.climax)} (hero ${x.climax.heroReachable ? '' : 'not '}reachable)` : ''}`
      + `; outro ${x.outro?.move} ${x.outro?.elevation} [${x.outro?.tags.join(',')}]`);
    console.log(`  variety: ${x.variety.subjectRepeats} subject repeats, ${x.variety.moveTriples} move triples, runs elevation ${x.variety.elevationRun} lens ${x.variety.lensRun} foreground ${x.variety.foregroundRun};`
      + ` calm ${x.calm.gentle}/${x.calm.count} gentle at ${x.calm.meanLegMps?.toFixed(1) ?? '-'} m/s, energetic ${x.energetic.count - x.energetic.gentle}/${x.energetic.count} lively at ${x.energetic.meanLegMps?.toFixed(1) ?? '-'} m/s`);
    const { tangential: tg, vector: a, sideways: sd, yaw: y, last100ms: e, spikes: sp } = x.motion;
    console.log(`  drawn camera at 60 Hz: tangential max ${tg.max.toFixed(2)} (p99 ${tg.p99.toFixed(2)}) m/s2 at ${f1(tg.atMs)} s in ${tg.item}; vector max ${a.max.toFixed(2)} (p99 ${a.p99.toFixed(2)}) at ${f1(a.atMs)} s in ${a.item};`
      + ` sideways max ${sd.max.toFixed(2)}; yaw max ${y.max.toFixed(1)} (p99 ${y.p99.toFixed(1)}) deg/s; last 100 ms ${e ? `${e.tangential.toFixed(2)}/${e.vector.toFixed(2)}` : '-'} m/s2;`
      + ` ${sp.count} spikes (${sp.atJoins} at joins, ${sp.atKeys} at keys)${sp.worst[0] ? `, worst ${sp.worst[0].ratio.toFixed(1)}x at ${f1(sp.worst[0].atMs)} s` : ''}`);
    if (r.notes?.length) console.log('  notes', r.notes.slice(0, 8).join(' | '));
  }
  if (opt('--out')) await fs.writeFile(path.resolve(opt('--out')), JSON.stringify({ ...r, plan: { ...r.plan, moments: undefined, intensity: undefined }, timeline: undefined }, null, 1));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
