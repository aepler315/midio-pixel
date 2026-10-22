// Scenic shot tours: the planner (docs/scenic-tours.md).
//
// Strings a view's shots and links together against one song. Every shot's
// payoff lands on a payoff *slot*: an energy impact (ShotMusic), a phrase
// start, or a filler in a long gap, on a grid of the whole song (so a replan
// sees the slots the committed plan used; a replan also gets the committed
// timeline's later knots as slots). Payoff slots lie inside the visible
// intervals. Off screen the camera only has to keep moving legally: there the
// fillers are *pass-through* knots (`hidden`), where a shot passes its
// payoffS unseen -- no payoff, no reward, and the costs of what a viewer
// would see (repetition, link quality, speed changes) scale with the share
// of the leg on screen. Between two knots the camera covers one *leg*: the
// rest of the shot after its payoff, a link, and the next shot up to its
// payoff. A leg's mean speed must fit [minSpeed, capMargin * cap], cap =
// min(maxSpeed, flowLimit / max flow) over each part of the leg (rest of a
// shot, link, next shot), the flow limit running from flowCalm to
// flowEnergetic with the music's lowest intensity while that part plays, and
// the speed profile that ShotTimeline will build through the knots
// (intervalLimits, the same knot rules) must keep the eye's acceleration in
// the limit: |a| + v^2 * bend <= maxAccel, where `bend` is the fastest change
// of the eye's share of progress on the leg (joins included) -- at a steady
// progress speed v the eye still speeds up or slows by bend * v^2 where a
// path trades flying for panning.
//
// Search: knots in time order, each holding a beam of states (last shot,
// its payoff at that knot, recent history), at most one per (shot, previous
// subject) and `beamWidth` in all. Every state expands over its shot's links
// and the next few impact slots plus the few visible and pass-through slots
// nearest a comfortable pace that its leg can reach (and the ones from which
// the shot's rest would just reach the song end); a song end is tried from
// every state. The best complete plan wins, so the climax shot and the
// outro are chosen together, never committed greedily. Costs: shot quality
// times slot importance (the climax heaviest, a bonus for a top hero shot
// there and for ending on a pullback or high move after it), link quality,
// repetition (subject, move, heading, elevation, lens, foreground), calm
// slots wanting gentle moves, pace against the comfortable image flow, and
// speed changes between legs.
//
// A replan (`start` from shotContinuation) holds its first leg to the hard
// limits only and, landing on the committed timeline's next knot, keeps that
// knot's speed (`plan.pin`): the committed sequence stays among its choices.
// Motion limits: the defaults, then the library's region `motion`, then
// `tunables`.
//
// Pure and deterministic: ties break by creation order, which follows shot
// and link order; `seed` only perturbs shot and link rewards slightly.
import { musicMoments } from './ShotMusic.js';
import { pathLaneAt } from './ShotPath.js';
import { SHOT_MOTION, SHOT_KEY_MS, knotSpeed, intervalLimits, itemKnots, progressProfile } from './ShotTimeline.js';

export const SHOT_TUNABLES = Object.freeze({
  ...SHOT_MOTION,
  beamWidth: 256, maxLegMs: 90000, impactsPerLeg: 2, freeSlotsPerLeg: 3, hiddenSlotsPerLeg: 2, fillerGapMs: 12000, fillerSpacingMs: 6000,
  capMargin: .8, comfortFlow: .55,
  weights: Object.freeze({ shot: 3, scoreBase: .5, impact: 3, climax: 2.5, showing: .3, link: .5, comfort: .06, hiddenComfort: .15, change: .8, timing: .002, sameSubject: 10, recentSubject: 1,
    olderSubject: .5, sameMove: .8, heading: .3, run: .3, foregroundRun: .2, reuse: 3, calmEnergetic: .8, impactGentle: .3,
    climaxHero: 16, outro: 2, railOpen: 2, wideOpen: 1, energeticOpen: 2.5, linkTime: .04, seedJitter: .2 }),
});

const GENTLE = new Set(['rail', 'orbit', 'pullback', 'traverse']), ENERGETIC = new Set(['reveal', 'approach', 'valley', 'crest']);
const LENSES = ['wide', 'normal', 'tele'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Rebuild the lookup Maps of a library that crossed postMessage. */
export function restoreShotLibrary(library) {
  if (library.shotById instanceof Map && library.linkById instanceof Map && library.linksFrom instanceof Map) return library;
  const linksFrom = new Map(library.shots.map((s) => [s.id, []]));
  for (const l of library.links) linksFrom.get(l.from)?.push(l);
  for (const list of linksFrom.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return { ...library, shotById: new Map(library.shots.map((s) => [s.id, s])), linkById: new Map(library.links.map((l) => [l.id, l])),
    linksFrom, subjectById: new Map(library.subjects.map((s) => [s.id, s])) };
}

// The eye's share of progress g (eye metres per progress metre) and its
// rate of change along a path, as the timeline traverses pathPoseAt's
// uniform Catmull-Rom. From the per-progress-metre chords a, b, c around
// segment i (a = w[i-1], clamped at the ends as pathPoseAt reflects), the
// eye's velocity per metre is P(u) = (a+b)/2 + E u + 1.5 F u^2 and its
// derivative Q(u) = E + 3 F u (E = -2a + 3b - c, F = a - 2b + c), so
// dg/ds = P.Q / |P| / ds; its largest magnitude (at u = 0, 1/2 or 1, where
// Q jumps or turns) is the segment's bend.
const chordOf = (path) => {
  const { s, eye } = path, last = s.length - 2;
  return (i, out) => {
    i = i < 0 ? 0 : i > last ? last : i;
    const ds = s[i + 1] - s[i] || 1;
    out[0] = (eye[i * 3 + 3] - eye[i * 3]) / ds; out[1] = (eye[i * 3 + 4] - eye[i * 3 + 1]) / ds; out[2] = (eye[i * 3 + 5] - eye[i * 3 + 2]) / ds;
    return out;
  };
};
function segmentBend(a, b, c, ds) {
  let bend = 0;
  for (let u = 0; u <= 1; u += .5) {
    let pq = 0, pp = 0;
    for (let k = 0; k < 3; k++) {
      const E = -2 * a[k] + 3 * b[k] - c[k], F = a[k] - 2 * b[k] + c[k], P = (a[k] + b[k]) / 2 + E * u + 1.5 * F * u * u;
      pq += P * (E + 3 * F * u); pp += P * P;
    }
    if (pp > 1e-12) bend = Math.max(bend, Math.abs(pq) / Math.sqrt(pp) / ds);
  }
  return bend;
}

/** Over progress [a, b] of a path: max and integral of its flow lane, and
 *  `bend`, the fastest change of the eye's share of progress (1/m). */
function laneStats(path, a, b) {
  const { s, flow } = path, n = s.length;
  let prevS = a, prevF = flow ? pathLaneAt(path, flow, a) : 1 / 500, max = prevF, int = 0;
  if (flow) {
    for (let i = 0; i < n && s[i] < b; i++) {
      if (s[i] <= a) continue;
      int += (s[i] - prevS) * (flow[i] + prevF) / 2; max = Math.max(max, flow[i]); prevS = s[i]; prevF = flow[i];
    }
  }
  const fb = flow ? pathLaneAt(path, flow, b) : 1 / 500, w = chordOf(path);
  let bend = 0, p = new Float64Array(3), q = new Float64Array(3), r = new Float64Array(3), first = true;
  for (let i = 0; i < n - 1; i++) {
    if (s[i + 1] < a || s[i] > b) continue;
    if (first) { w(i - 1, p); w(i, q); first = false; }
    w(i + 1, r);
    bend = Math.max(bend, segmentBend(p, q, r, s[i + 1] - s[i]));
    [p, q, r] = [q, r, p];
  }
  return { max: Math.max(max, fb, 1e-9), int: Math.max(0, int + (b - prevS) * (fb + prevF) / 2), bend };
}

/** Bend of the two segments where path A's end joins path B's start
 *  (ShotTimeline joins them through each other's end chords). */
function joinBend(A, B) {
  const na = A.s.length, wa = chordOf(A), wb = chordOf(B);
  const a2 = wa(na - 3, new Float64Array(3)), a1 = wa(na - 2, new Float64Array(3)), b0 = wb(0, new Float64Array(3)), b1 = wb(1, new Float64Array(3));
  return Math.max(segmentBend(a2, a1, b0, A.s[na - 1] - A.s[na - 2]), segmentBend(a1, b0, b1, B.s[1] - B.s[0]));
}

// Song-independent per-library tables, cached per decoded library.
const indexes = new WeakMap();
function libraryIndex(library) {
  let ix = indexes.get(library);
  if (ix) return ix;
  const shots = library.shots, links = library.links, n = shots.length, shotIndex = new Map(shots.map((s, i) => [s.id, i]));
  const subjects = new Map(library.subjects.map((s, i) => [s.id, i])), foregrounds = new Map();
  const L = new Float64Array(n), pay = new Float64Array(n), head = [], tail = [];
  shots.forEach((s, i) => {
    L[i] = s.path.s[s.path.s.length - 1]; pay[i] = clamp(s.payoffS, 0, L[i]);
    head.push(laneStats(s.path, 0, pay[i])); tail.push(laneStats(s.path, pay[i], L[i]));
  });
  const fgOf = (f) => { const key = String(f ?? 'none'); if (!foregrounds.has(key)) foregrounds.set(key, foregrounds.size); return foregrounds.get(key); };
  const agl = (s) => s.traits?.aglM ?? 500;
  const heroes = new Set(library.subjects.filter((s) => s.hero).map((s) => s.id));
  for (const s of shots) if (s.tags?.includes('hero')) heroes.add(s.subjectId);
  if (!heroes.size) {
    const top = shots.filter((s) => s.move !== 'rail').sort((a, b) => b.score.total - a.score.total || byId(a, b))[0];
    if (top) heroes.add(top.subjectId);
  }
  const heroTop = new Uint8Array(n);
  for (const subject of heroes) {
    const own = shots.map((s, i) => [s, i]).filter(([s]) => s.subjectId === subject).sort(([a], [b]) => b.score.total - a.score.total || byId(a, b));
    for (const [, i] of own.slice(0, own.length >= 6 ? 3 : 2)) heroTop[i] = 1;
  }
  // A link's bend includes both of its joins.
  const linkStats = links.map((l) => {
    const st = laneStats(l.path, 0, l.path.s[l.path.s.length - 1]), A = library.shotById.get(l.from)?.path, B = library.shotById.get(l.to)?.path;
    return { ...st, bend: Math.max(st.bend, A ? joinBend(A, l.path) : 0, B ? joinBend(l.path, B) : 0) };
  });
  ix = {
    shots, links, shotIndex, L, pay, head, tail, heroTop,
    subj: Int32Array.from(shots, (s) => subjects.get(s.subjectId) ?? -1),
    move: shots.map((s) => s.move), gentle: Uint8Array.from(shots, (s) => +GENTLE.has(s.move)), energetic: Uint8Array.from(shots, (s) => +ENERGETIC.has(s.move)),
    heading: Float64Array.from(shots, (s) => s.traits?.headingDeg ?? NaN),
    elev: Int8Array.from(shots, (s) => (agl(s) < 450 ? 0 : agl(s) < 750 ? 1 : 2)),
    lens: Int8Array.from(shots, (s) => LENSES.indexOf(s.traits?.lens)), fg: Int16Array.from(shots, (s) => fgOf(s.traits?.foreground)),
    score: Float64Array.from(shots, (s) => s.score.total),
    high: Uint8Array.from(shots, (s) => +(agl(s) >= 750 || !!s.tags?.includes('high'))), wide: Uint8Array.from(shots, (s) => +(s.traits?.lens === 'wide')),
    rail: shots.findIndex((s) => s.move === 'rail'),
    lFrom: Int32Array.from(links, (l) => shotIndex.get(l.from)), lTo: Int32Array.from(links, (l) => shotIndex.get(l.to)),
    lL: Float64Array.from(links, (l) => l.path.s[l.path.s.length - 1]), lMax: Float64Array.from(linkStats, (x) => x.max), lBend: Float64Array.from(linkStats, (x) => x.bend),
    lInt: Float64Array.from(linkStats, (x) => x.int), lScore: Float64Array.from(links, (l) => l.score.total),
    out: shots.map(() => []),
  };
  const linkIndex = new Map(links.map((l, j) => [l, j]));
  // Code-unit id order (not locale order), so ties break the same everywhere.
  shots.forEach((s, i) => { ix.out[i] = (library.linksFrom.get(s.id) || []).toSorted(byId).map((l) => linkIndex.get(l)).filter((j) => j !== undefined); });
  indexes.set(library, ix);
  return ix;
}

function hash01(seed, text) {
  let h = (2166136261 ^ (seed * 2654435761)) >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Range queries over a lane on the 100 ms lattice: prefix mean and sparse-table min.
function rangeTables(lane) {
  const n = lane.length, prefix = new Float64Array(n + 1), table = [Float64Array.from(lane)];
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + lane[i];
  for (let w = 1; 2 * w <= n; w *= 2) {
    const last = table.at(-1), next = new Float64Array(n - 2 * w + 1);
    for (let i = 0; i < next.length; i++) next[i] = Math.min(last[i], last[i + w]);
    table.push(next);
  }
  const span = (a, b) => [clamp(Math.floor(a / SHOT_KEY_MS), 0, n - 1), clamp(Math.ceil(b / SHOT_KEY_MS), 0, n - 1)];
  return {
    mean: (a, b) => { const [i, j] = span(a, b); return (prefix[j + 1] - prefix[i]) / (j - i + 1); },
    min: (a, b) => { const [i, j] = span(a, b), l = Math.floor(Math.log2(j - i + 1)); return Math.min(table[l][i], table[l][j - (1 << l) + 1]); },
  };
}

/**
 * Plan one song's shot tour. Returns { durationMs, moments, calm, items:
 * [{kind, id, startMs, endMs, sFrom, sTo, payoffMs?, moment?, hidden?}],
 * notes, cost, fallback, start, pin, intensity, intensityStepMs, visible,
 * stats }. Items tile [start?.timeMs ?? 0, durationMs]: shot, link, shot,
 * ... A shot item's payoffMs is when the camera passes its payoffS; `hidden`
 * marks one off screen, which is no payoff. `visible` null means the whole
 * song is on screen; [] means none of it.
 */
export function planShotTour(library, { durationMs = 0, sections = [], roles = [], energy = null, energyStepMs = 100,
  visible = null, seed = 0, start = null, tunables = {} } = {}) {
  library = restoreShotLibrary(library);
  const T = { ...SHOT_TUNABLES, ...(library.motion || {}), ...tunables, weights: { ...SHOT_TUNABLES.weights, ...tunables.weights } }, w = T.weights;
  const ix = libraryIndex(library), { shots, links, L, pay } = ix, nShots = shots.length;
  durationMs = Math.max(0, Number(durationMs) || 0);
  const music = musicMoments({ durationMs, sections, roles, energy: energy || [], energyStepMs });
  const moments = music.impacts.map((m) => ({ ...m, climax: m === music.climax }));
  const nLane = Math.ceil(durationMs / SHOT_KEY_MS) + 1, intensity = Float32Array.from({ length: nLane }, (_, i) => music.intensityAt(i * SHOT_KEY_MS));
  const t0 = start ? clamp(Math.round(start.timeMs), 0, durationMs) : 0, notes = [];
  const intervals = (visible ?? [{ startMs: 0, endMs: durationMs }]).map((v) => ({ startMs: Math.max(0, v.startMs), endMs: Math.min(durationMs, v.endMs) }))
    .filter((v) => v.endMs >= v.startMs);
  const visibleAt = (t) => intervals.some((v) => t >= v.startMs && t <= v.endMs);
  const base = { durationMs, moments, calm: music.calm, start, intensity, intensityStepMs: SHOT_KEY_MS, visible: intervals, seed };
  const startIndex = start ? (start.itemKind === 'link' ? library.links.findIndex((l) => l.id === start.id) : ix.shotIndex.get(start.id) ?? -1) : -1;

  const finish = (items, cost, fallback, stats, pin = null) => {
    const payoffOf = (i) => (items[i].kind === 'shot' ? pay[ix.shotIndex.get(items[i].id)] : null);
    const { G, times, prog } = itemKnots(items, payoffOf, t0, durationMs);
    const profile = progressProfile(times, prog, { startSpeed: start?.speedMps ?? null, startAccel: start?.accelMps2 ?? 0, pin });
    items.forEach((it, i) => { it.startMs = i ? items[i - 1].endMs : t0; it.endMs = i === items.length - 1 ? durationMs : profile.timeAt(G[i + 1]); });
    return { ...base, items, notes, cost, fallback, pin, stats };
  };
  // Not physically checked: a continued element stretched at a uniform pace
  // from its committed speed (the worker keeps the committed timeline instead).
  const fallbackPlan = (reason) => {
    notes.push(`fallback: ${reason}`);
    let items;
    if (start && startIndex >= 0) {
      if (start.itemKind === 'link') {
        const to = ix.lTo[startIndex];
        items = [{ kind: 'link', id: start.id, sFrom: start.s, sTo: ix.lL[startIndex] }, { kind: 'shot', id: shots[to].id, sFrom: 0, sTo: L[to], payoffMs: null, moment: -1, hidden: false }];
      } else items = [{ kind: 'shot', id: start.id, sFrom: start.s, sTo: L[startIndex], payoffMs: start.payoffMs ?? null, moment: -1, hidden: false }];
    } else {
      const rail = ix.rail >= 0 ? ix.rail : shots.map((s, i) => i).sort((a, b) => ix.score[b] - ix.score[a] || byId(shots[a], shots[b]))[0];
      // A preview (no duration) holds the rail's payoff view.
      items = [{ kind: 'shot', id: shots[rail].id, sFrom: durationMs > 0 ? 0 : pay[rail], sTo: durationMs > 0 ? L[rail] : pay[rail], payoffMs: null, moment: -1, hidden: false }];
    }
    // Stretch uniformly over the remaining song; a payoff ahead keeps its place on that pace.
    const total = items.reduce((n, it) => n + it.sTo - it.sFrom, 0);
    let at = 0;
    for (const it of items) {
      const i = ix.shotIndex.get(it.id);
      if (it.kind === 'shot' && it.payoffMs === null && pay[i] > it.sFrom && total > 0 && durationMs > t0) {
        it.payoffMs = clamp(Math.round((t0 + (at + pay[i] - it.sFrom) / total * (durationMs - t0)) / SHOT_KEY_MS) * SHOT_KEY_MS, t0 + SHOT_KEY_MS, durationMs);
        it.hidden = !visibleAt(it.payoffMs);
      }
      at += it.sTo - it.sFrom;
    }
    return finish(items, Infinity, reason, null);
  };
  if (!nShots) throw new Error('shot library has no shots');
  if (!(durationMs > t0)) return fallbackPlan(durationMs ? 'nothing left to plan' : 'no duration');
  if (start && startIndex < 0) return fallbackPlan('committed element missing from the library');

  const lanes = rangeTables(intensity), vis = rangeTables(Float64Array.from({ length: nLane }, (_, i) => +visibleAt(i * SHOT_KEY_MS)));
  const flowAt = (I) => T.flowCalm + (T.flowEnergetic - T.flowCalm) * I;
  const inCalm = (t) => music.calm.some((c) => t >= c.startMs && t <= c.endMs);

  // Slots on a grid of the whole song (independent of t0), then the
  // committed knots of a replan; only those after t0 are used.
  const slotMap = new Map();
  const addSlot = (t, slot) => { const old = slotMap.get(t); if (!old || slot.imp > old.imp) slotMap.set(t, { t, ...slot }); };
  moments.forEach((m, k) => {
    const t = Math.round(m.timeMs / SHOT_KEY_MS) * SHOT_KEY_MS;
    if (t > 0 && t <= durationMs && visibleAt(t)) {
      addSlot(t, { kind: 'impact', moment: k, strength: m.strength, climax: m.climax, timing: Math.abs(t - m.timeMs),
        imp: w.impact * (1 + 1.5 * m.strength + (m.boundary ? .5 : 0)) * (m.climax ? w.climax : 1) });
    }
  });
  const near = (t, gap) => [...slotMap.keys()].some((u) => Math.abs(u - t) < gap);
  for (const p of music.phrases) {
    const t = Math.round(p / SHOT_KEY_MS) * SHOT_KEY_MS;
    if (t > 0 && t < durationMs && visibleAt(t) && !near(t, 2000)) addSlot(t, { kind: 'phrase', moment: -1, imp: .4 });
  }
  const free = (t) => (visibleAt(t) ? { kind: 'filler', moment: -1, imp: .25 } : { kind: 'hidden', moment: -1, imp: 0 });
  const fences = [0, ...[...slotMap.keys()].sort((a, b) => a - b), durationMs];
  for (let k = 1; k < fences.length; k++) {
    const gap = fences[k] - fences[k - 1];
    if (gap <= T.fillerGapMs) continue;
    const count = Math.ceil(gap / T.fillerSpacingMs) - 1;
    for (let q = 1; q <= count; q++) {
      const t = Math.round((fences[k - 1] + gap * q / (count + 1)) / SHOT_KEY_MS) * SHOT_KEY_MS;
      if (t > 0 && t < durationMs) addSlot(t, free(t));
    }
  }
  for (const t of [start?.next?.timeMs, ...(start?.knots || [])]) if (Number.isFinite(t) && t > t0 && t < durationMs && !slotMap.has(t)) addSlot(t, free(t));
  const slots = [...slotMap.values()].filter((s) => s.t > t0).sort((a, b) => a.t - b.t);
  slots.forEach((s) => { s.calm = inCalm(s.t); s.climax = !!s.climax; s.strength ??= 0; s.timing ??= 0; });
  const pick = (test) => slots.map((s, i) => i).filter((i) => test(slots[i]));
  const impactSlots = pick((s) => s.kind === 'impact'), visSlots = pick((s) => s.kind === 'phrase' || s.kind === 'filler'), hidSlots = pick((s) => s.kind === 'hidden');
  const timesOf = (list) => Float64Array.from(list, (i) => slots[i].t);
  const impactT = timesOf(impactSlots), visT = timesOf(visSlots), hidT = timesOf(hidSlots);
  const nextSlot = start?.next ? slots.findIndex((s) => s.t === start.next.timeMs) : -1;
  const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };

  const jitter = Float64Array.from(shots, (s) => w.seedJitter * (hash01(seed, s.id) - .5));
  const linkJitter = Float64Array.from(links, (l) => w.seedJitter * (hash01(seed, l.id) - .5));
  const amax = T.maxAccelMps2, vmin = T.minSpeedMps, pinned = Number.isFinite(start?.speedMps);
  const startSpeed = pinned ? start.speedMps : null, startAccel = pinned && Number.isFinite(start.accelMps2) ? start.accelMps2 : 0;
  // A leg's speed cap over [ta, tb]: the speed limit, the bend's share of the
  // acceleration limit (the eye's acceleration is the profile's plus bend *
  // v^2; its share of progress is at most 1), and per part of the leg (rest
  // of a shot, link, next shot; `parts` = [length, max flow, ...]) the flow
  // limit at the quietest music while that part is on screen -- the parts'
  // times assume a steady pace, widened by up to 2 s for the profile's swing.
  // The upper bound (the most energetic music) prunes a leg's reachable slots.
  const capBound = (leg) => Math.min(T.maxSpeedMps, flowAt(1) / leg.max, leg.bend > 0 ? Math.sqrt(amax / leg.bend) : Infinity);
  const legCap = (ta, tb, leg) => {
    const parts = leg.parts, span = tb - ta, slack = Math.min(2000, .15 * span);
    let cap = Math.min(T.maxSpeedMps, leg.bend > 0 ? Math.sqrt(amax / leg.bend) : Infinity), at = 0;
    for (let k = 0; k < parts.length; k += 2) {
      const a = ta + span * at / leg.D, b = ta + span * (at + parts[k]) / leg.D;
      at += parts[k];
      cap = Math.min(cap, flowAt(lanes.min(Math.max(ta, a - slack), Math.min(tb, b + slack))) / parts[k + 1]);
    }
    return cap;
  };
  const okLimits = (lim, cap, bend) => lim.maxAccel + lim.peak * lim.peak * bend <= amax + 1e-9 && lim.peak <= cap + 1e-9 && lim.low >= vmin - 1e-9;

  // Root state: the song start, or the committed element of a replan.
  const root = { root: true, t: t0, shot: -1, cost: 0, serial: 0, parent: null, s1: -1, s2: -1, s3: -1, move: null, heading: NaN,
    elev: -1, elevRun: 0, lens: -1, lensRun: 0, fg: -1, fgRun: 0, used: 0n, climax: 0, vbar: 0, rem: 0, endBase: 0, pending: null, pinV: null };
  if (start) {
    if (start.itemKind === 'link') {
      const j = startIndex, B = ix.lTo[j], part = laneStats(links[j].path, start.s, ix.lL[j]);
      root.pending = { kind: 'link', link: j, shot: B, D: ix.lL[j] - start.s + pay[B], max: Math.max(part.max, ix.head[B].max), int: part.int + ix.head[B].int,
        bend: Math.max(ix.lBend[j], ix.head[B].bend), linkRest: ix.lL[j] - start.s, linkPart: ix.lL[j] - start.s, parts: [ix.lL[j] - start.s, part.max, pay[B], ix.head[B].max] };
      root.s1 = ix.subj[ix.lFrom[j]];
    } else if (start.s < pay[startIndex] - 1e-6) {
      const X = startIndex, part = laneStats(shots[X].path, start.s, pay[X]);
      root.pending = { kind: 'shot', link: -1, shot: X, D: pay[X] - start.s, max: part.max, int: part.int, bend: part.bend, parts: [pay[X] - start.s, part.max] };
    } else {
      const X = startIndex, part = laneStats(shots[X].path, start.s, L[X]);
      Object.assign(root, { shot: X, rem: L[X] - start.s, remMax: part.max, remInt: part.int, remBend: part.bend, endBase: start.s, s1: ix.subj[X], move: ix.move[X],
        heading: ix.heading[X], elev: ix.elev[X], elevRun: 1, lens: ix.lens[X], lensRun: 1, fg: ix.fg[X], fgRun: 1, used: 1n << BigInt(X) });
    }
  }

  const W = Math.max(1, T.beamWidth | 0), buckets = new Array(slots.length).fill(null);
  let serial = 1, best = null, expansions = 0, kept = 0;
  const prune = (bucket) => {
    bucket.list.sort((a, b) => a.cost - b.cost || a.serial - b.serial);
    const seen = new Set(), out = [];
    for (const s of bucket.list) {
      const key = s.shot * 4096 + s.s2 + 1;
      if (seen.has(key)) continue;
      seen.add(key); out.push(s);
      if (out.length >= W) break;
    }
    bucket.list = out; bucket.worst = out.length >= W ? out[out.length - 1].cost : Infinity;
  };

  // One leg from state P to shot B's payoff at slot si, through link j.
  const evaluate = (P, leg, si) => {
    const slot = slots[si], B = leg.shot, dtS = (slot.t - P.t) / 1000, v = leg.D / dtS;
    expansions++;
    if (!(dtS > 0)) return;
    // The committed start's first leg is held to the hard limits only, and
    // keeps the committed knot's speed when it lands on that knot.
    const committed = P.root && !!start, pinV = committed && si === nextSlot && shots[B].id === start.next.id ? start.next.speedMps : null;
    const cap = legCap(P.t, slot.t, leg);
    if (!committed && (v < vmin - 1e-9 || v > T.capMargin * cap)) return;
    let Vk = v, Ak = 0;
    if (P.root) { if (pinned) { Vk = startSpeed; Ak = startAccel; } }
    else {
      Vk = P.pinV ?? knotSpeed(P.vbar, P.dt, v, dtS);
      if (!okLimits(intervalLimits(P.V, P.A, Vk, 0, P.vbar, P.dt), P.cap, P.bend)) return;
    }
    if (!okLimits(intervalLimits(Vk, Ak, pinV ?? v, 0, v, dtS), cap, leg.bend)) return;
    // Soft costs of what a viewer sees scale with the leg's share on screen.
    const hidden = slot.kind === 'hidden', seen = vis.mean(P.t, slot.t);
    const comfort = clamp(T.comfortFlow * flowAt(lanes.mean(P.t, slot.t)) * leg.D / Math.max(1e-9, leg.int), vmin, T.capMargin * cap);
    let cost = P.cost + w.comfort * dtS * Math.abs(Math.log(v / comfort)) * (w.hiddenComfort + (1 - w.hiddenComfort) * seen) + w.timing * slot.timing;
    const before = P.root ? startSpeed : P.vbar;
    if (before > 0) cost += seen * w.change * Math.abs(Math.log(v / before));
    if (!hidden) cost -= w.shot * (w.scoreBase + ix.score[B]) * (slot.imp + w.showing) * (1 + jitter[B]);
    if (leg.link >= 0 && !leg.continued) cost -= seen * w.link * ix.lScore[leg.link] * (1 + linkJitter[leg.link]);
    if (leg.link >= 0) cost += seen * w.linkTime * dtS * leg.linkPart / leg.D;
    if (!hidden && slot.calm && ix.energetic[B]) cost += w.calmEnergetic;
    if (slot.kind === 'impact' && !slot.climax && slot.strength >= .5 && ix.gentle[B]) cost += w.impactGentle;
    let climax = P.climax;
    if (slot.climax) { climax = ix.heroTop[B] ? 2 : 1; if (ix.heroTop[B]) cost -= w.climaxHero; }
    const s1 = ix.subj[B];
    let repeat = 0;
    if (s1 === P.s1) repeat += w.sameSubject; else if (s1 === P.s2) repeat += w.recentSubject; else if (s1 === P.s3) repeat += w.olderSubject;
    if (ix.move[B] === P.move) repeat += w.sameMove;
    if (Math.abs(((ix.heading[B] - P.heading + 540) % 360) - 180) < 30) repeat += w.heading;
    const elevRun = ix.elev[B] === P.elev ? P.elevRun + 1 : 1, lensRun = ix.lens[B] === P.lens ? P.lensRun + 1 : 1, fgRun = ix.fg[B] === P.fg ? P.fgRun + 1 : 1;
    repeat += w.run * (elevRun - 1 + lensRun - 1) + w.foregroundRun * (fgRun - 1);
    const bit = 1n << BigInt(B);
    if (P.used & bit) repeat += w.reuse;
    cost += seen * repeat;
    if (P.root && !start) {
      let open = ix.energetic[B] ? w.energeticOpen : 0;
      if (ix.move[B] === 'rail') open -= w.railOpen; else if (ix.high[B] || ix.wide[B]) open -= w.wideOpen;
      cost += seen * open;
    }
    let bucket = buckets[si];
    if (!bucket) bucket = buckets[si] = { list: [], worst: Infinity };
    if (cost >= bucket.worst) return;
    bucket.list.push({ root: false, t: slot.t, si, shot: B, link: leg.link, continued: !!leg.continued, parent: P, cost, serial: serial++,
      rem: L[B] - pay[B], remMax: ix.tail[B].max, remInt: ix.tail[B].int, remBend: ix.tail[B].bend, endBase: pay[B], V: Vk, A: Ak, vbar: v, dt: dtS, cap, bend: leg.bend,
      s1, s2: P.s1, s3: P.s2, move: ix.move[B], heading: ix.heading[B], elev: ix.elev[B], elevRun, lens: ix.lens[B], lensRun, fg: ix.fg[B], fgRun,
      used: P.used | bit, climax, pending: null, pinV });
    if (bucket.list.length >= 3 * W) prune(bucket);
  };

  // A leg tries the next few impacts it can reach, and the visible and the
  // pass-through slots nearest a comfortable pace (separate quotas).
  const nearest = (P, leg, times, list, at, lo, hi, quota) => {
    let left = lowerBound(times, at) - 1, right = left + 1, taken = 0;
    while (taken < quota) {
      const okL = left >= 0 && times[left] >= lo, okR = right < times.length && times[right] <= hi;
      if (!okL && !okR) break;
      if (okR && (!okL || times[right] - at <= at - times[left])) { if (times[right] >= lo) { evaluate(P, leg, list[right]); taken++; } right++; }
      else { evaluate(P, leg, list[left]); taken++; left--; }
    }
  };
  const expandLeg = (P, leg) => {
    if (!(leg.D > 0)) return;
    const capHi = capBound(leg), committed = P.root && !!start;
    const lo = P.t + 1000 * leg.D / ((committed ? 1 : T.capMargin) * capHi), hi = Math.min(durationMs, P.t + Math.min(T.maxLegMs, 1000 * leg.D / vmin));
    if (committed && nextSlot >= 0 && shots[leg.shot].id === start.next.id) evaluate(P, leg, nextSlot);
    if (lo > hi) return;
    for (let k = lowerBound(impactT, lo), n = 0; k < impactT.length && impactT[k] <= hi && n < T.impactsPerLeg; k++, n++) evaluate(P, leg, impactSlots[k]);
    const pace = clamp(T.comfortFlow * flowAt(lanes.mean(P.t, P.t + 1000 * leg.D / Math.max(vmin, 20))) * leg.D / Math.max(1e-9, leg.int), vmin, T.capMargin * capHi);
    const at = P.t + 1000 * leg.D / pace;
    nearest(P, leg, visT, visSlots, at, lo, hi, T.freeSlotsPerLeg);
    nearest(P, leg, hidT, hidSlots, at, lo, hi, T.hiddenSlotsPerLeg);
    // And the knot from which the shot's rest would carry the camera to the
    // song end at this pace, so a quiet or off-screen ending has a way out.
    const end = durationMs - 1000 * (L[leg.shot] - pay[leg.shot]) / pace;
    if (end > at + 1000) { nearest(P, leg, visT, visSlots, end, lo, hi, 1); nearest(P, leg, hidT, hidSlots, end, lo, hi, 1); }
  };
  const expand = (P) => {
    if (P.pending) { const p = P.pending; expandLeg(P, { shot: p.shot, link: p.link, continued: true, D: p.D, max: p.max, int: p.int, bend: p.bend, linkPart: p.linkPart || 0, parts: p.parts }); return; }
    if (P.shot < 0) {
      for (let B = 0; B < nShots; B++) expandLeg(P, { shot: B, link: -1, D: pay[B], max: ix.head[B].max, int: ix.head[B].int, bend: ix.head[B].bend, parts: [pay[B], ix.head[B].max] });
      return;
    }
    for (const j of ix.out[P.shot]) {
      const B = ix.lTo[j];
      expandLeg(P, { shot: B, link: j, D: P.rem + ix.lL[j] + pay[B], max: Math.max(P.remMax, ix.lMax[j], ix.head[B].max), int: P.remInt + ix.lInt[j] + ix.head[B].int,
        bend: Math.max(P.remBend, ix.lBend[j], ix.head[B].bend), linkPart: ix.lL[j], parts: [P.rem, P.remMax, ix.lL[j], ix.lMax[j], pay[B], ix.head[B].max] });
    }
  };

  // The song end from state P: ride on inside its current element. The
  // outro bonus goes to a song that ends on a pullback or high shot after a
  // hero climax.
  const terminal = (P) => {
    if (P.root && !start) return;
    const tau = (durationMs - P.t) / 1000, avail = P.pending ? P.pending.D - .5 : P.rem;
    const end = P.pending || { max: P.remMax, int: P.remInt, bend: P.remBend }, fint = end.int;
    let cost = P.cost, v = 0;
    if (tau <= 1e-9) {
      if (!P.root && !okLimits(intervalLimits(P.V, P.A, P.vbar, 0, P.vbar, P.dt), P.cap, P.bend)) return;
    } else {
      const cap = legCap(P.t, durationMs, { D: 1, parts: [1, end.max], bend: end.bend }), hi = Math.min(T.capMargin * cap, avail / tau);
      if (hi < vmin) return;
      const comfort = clamp(T.comfortFlow * flowAt(lanes.mean(P.t, durationMs)) * avail / Math.max(1e-9, fint), vmin, hi);
      const before = P.root ? startSpeed : P.vbar;
      const ok = (u) => {
        const Vk = P.root ? (pinned ? startSpeed : u) : P.pinV ?? knotSpeed(P.vbar, P.dt, u, tau), Ak = P.root ? startAccel : 0;
        return (P.root || okLimits(intervalLimits(P.V, P.A, Vk, 0, P.vbar, P.dt), P.cap, P.bend)) && okLimits(intervalLimits(Vk, Ak, u, 0, u, tau), cap, end.bend);
      };
      v = [comfort, clamp(before || comfort, vmin, hi), (comfort + clamp(before || comfort, vmin, hi)) / 2].find(ok);
      if (v === undefined) return;
      const seen = vis.mean(P.t, durationMs);
      cost += w.comfort * tau * Math.abs(Math.log(v / comfort)) * (w.hiddenComfort + (1 - w.hiddenComfort) * seen);
      if (before > 0) cost += seen * w.change * Math.abs(Math.log(v / before));
    }
    if (P.climax === 2 && P.shot >= 0 && (ix.move[P.shot] === 'pullback' || ix.high[P.shot])) cost -= w.outro * (tau > 0 ? vis.mean(P.t, durationMs) : 1);
    if (!best || cost < best.cost) best = { cost, state: P, e: v * Math.max(0, tau) };
  };

  expand(root); terminal(root);
  for (let si = 0; si < slots.length; si++) {
    const bucket = buckets[si];
    if (!bucket) continue;
    prune(bucket); buckets[si] = null; kept += bucket.list.length;
    for (const P of bucket.list) { terminal(P); expand(P); }
  }
  const stats = { slots: slots.length, kept, expansions };
  if (!best) return fallbackPlan('no feasible shot sequence');

  // Items from the winning chain.
  const chain = [];
  for (let s = best.state; s; s = s.parent) chain.push(s);
  chain.reverse();
  const items = [];
  let open = null;
  const shotItem = (B, sFrom, slot) => ({ kind: 'shot', id: shots[B].id, sFrom, sTo: L[B], payoffMs: slot ? slot.t : null,
    moment: slot ? slot.moment : -1, hidden: slot ? slot.kind === 'hidden' : false });
  if (root.pending?.kind === 'link') items.push({ kind: 'link', id: start.id, sFrom: start.s, sTo: ix.lL[root.pending.link] });
  else if (start && !root.pending) { open = shotItem(root.shot, start.s, null); open.payoffMs = start.payoffMs ?? null; items.push(open); }
  for (let k = 1; k < chain.length; k++) {
    const st = chain[k], slot = slots[st.si];
    if (st.link >= 0 && !st.continued) {
      if (open) open.sTo = L[ix.shotIndex.get(open.id)];
      items.push({ kind: 'link', id: links[st.link].id, sFrom: 0, sTo: ix.lL[st.link] });
    }
    open = shotItem(st.shot, k === 1 && root.pending?.kind === 'shot' ? start.s : 0, slot);
    items.push(open);
  }
  if (chain.length > 1 || !root.pending) open.sTo = Math.min(L[ix.shotIndex.get(open.id)], best.state.endBase + best.e);
  else if (root.pending.kind === 'shot') items.push({ ...shotItem(root.pending.shot, start.s, null), sTo: start.s + best.e });
  else {
    // Ending inside the committed link, or just past it before the next payoff.
    const link = items[0], rest = root.pending.linkRest;
    if (best.e <= rest) link.sTo = start.s + best.e;
    else items.push({ ...shotItem(root.pending.shot, 0, null), sTo: best.e - rest });
  }
  const nonEmpty = items.filter((it) => it.sTo - it.sFrom > 1e-6);
  const shown = nonEmpty.filter((it) => it.kind === 'shot' && Number.isFinite(it.payoffMs) && !it.hidden && it.payoffMs > t0);
  const hit = shown.filter((it) => it.moment >= 0).length;
  const ahead = moments.filter((m) => m.timeMs > t0), climaxAhead = ahead.some((m) => m.climax);
  notes.push(`payoffs on ${hit} of ${ahead.length} impacts${climaxAhead ? `; climax ${best.state.climax === 2 ? 'on a hero shot' : best.state.climax ? 'on a non-hero shot' : 'missed'}` : ''}`);
  for (const v of intervals) {
    if (v.endMs - Math.max(v.startMs, t0) >= 10000 && !shown.some((it) => it.payoffMs >= v.startMs && it.payoffMs <= v.endMs)) notes.push(`no payoff on screen ${v.startMs}-${v.endMs} ms`);
  }
  const pin = chain[1]?.pinV != null ? { timeMs: chain[1].t, speedMps: chain[1].pinV } : null;
  return finish(nonEmpty.length ? nonEmpty : items, best.cost, null, stats, pin);
}
