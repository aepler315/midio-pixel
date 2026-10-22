// Scenic shot tours: the playback timeline (docs/scenic-tours.md).
//
// A plan's items (shots and links, possibly partial) are laid end to end as
// one progress coordinate S. One global progress profile S(t) drives them:
// knots at the plan's start, at every payoff (S of the shot's payoffS, at its
// planned time exactly) and at the song end. Between knots the progress
// speed is a cubic Hermite in time between the knot speeds and knot
// accelerations, plus a bump c*30u^2(1-u)^2 (zero value and slope at both
// ends) whose weight makes the interval cover exactly its progress. So every
// payoff lands on its time by construction and speed is C1 everywhere.
//
// Knot speeds: an interior knot takes the mean of its two intervals' mean
// speeds weighted toward the shorter interval (which then needs to change
// least); acceleration is zero at knots except a continued start, which keeps
// the committed timeline's speed and acceleration, and a continued plan's
// first knot when it is the committed timeline's next knot (`plan.pin`):
// that knot keeps its committed speed, so a replan that keeps the committed
// sequence reproduces it. The planner checks the same profile
// (intervalLimits) before it accepts a sequence. Shots whose payoff falls
// off screen (`hidden`) still pass it at a knot, but it is no payoff.
//
// The timeline samples camera poses on a 100 ms lattice (eye, aim point,
// fov, meta), as the Teton tour does; poseAt() interpolates eye and target
// with uniform Catmull-Rom across keys (C1) and fov linearly.
import { pathPoseAt, pathLaneAt, lookDir, headingPitch } from './ShotPath.js';

export const SHOT_KEY_MS = 100;
/** Motion defaults (data/terrain/scenic-tours.json defaults.motion); a
 *  library's own `motion` (its region's) overrides them, tunables override both. */
export const SHOT_MOTION = Object.freeze({ maxSpeedMps: 120, minSpeedMps: 4, flowCalm: .07, flowEnergetic: .24,
  maxYawDegPerSec: 20, maxClimbMps: 22, maxAccelMps2: 3.5 });
export const SHOT_PHASES = Object.freeze(['approach', 'payoff', 'hold', 'depart']);
const PAYOFF_WINDOW_MS = 1500;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Motion limits for a library: defaults, the library's region motion, tunables. */
export function shotMotion(library, tunables = {}) {
  return { ...SHOT_MOTION, ...(library?.motion || {}), ...tunables };
}

/** Speed at the knot between an interval of mean `vPrev` lasting `dtPrev`
 *  seconds and the next (`vNext`, `dtNext`). */
export function knotSpeed(vPrev, dtPrev, vNext, dtNext) {
  return (vPrev * dtNext + vNext * dtPrev) / (dtPrev + dtNext);
}

/** Bump weight and the extremes of one interval's profile:
 *  { c, maxAccel (m/s^2), peak, low (m/s) }. */
export function intervalLimits(V0, A0, V1, A1, vbar, dt) {
  const c = vbar - (V0 + V1) / 2 - dt * (A0 - A1) / 12;
  // dv/du is a cubic in u; its extremes are at the ends or where d2v/du2 = 0.
  const dv = (u) => (V1 - V0) * 6 * u * (1 - u) + dt * A0 * (3 * u * u - 4 * u + 1) + dt * A1 * (3 * u * u - 2 * u) + c * 60 * u * (1 - u) * (1 - 2 * u);
  const qa = 360 * c, qb = -12 * (V1 - V0) + 6 * dt * A0 + 6 * dt * A1 - 360 * c, qc = 6 * (V1 - V0) - 4 * dt * A0 - 2 * dt * A1 + 60 * c;
  let maxD = Math.max(Math.abs(dv(0)), Math.abs(dv(1)));
  const roots = Math.abs(qa) > 1e-12 ? (() => { const d = qb * qb - 4 * qa * qc; return d < 0 ? [] : [(-qb - Math.sqrt(d)) / (2 * qa), (-qb + Math.sqrt(d)) / (2 * qa)]; })()
    : Math.abs(qb) > 1e-12 ? [-qc / qb] : [];
  for (const u of roots) if (u > 0 && u < 1) maxD = Math.max(maxD, Math.abs(dv(u)));
  let peak = -Infinity, low = Infinity;
  for (let i = 0; i <= 8; i++) {
    const u = i / 8, v = speedAt(V0, A0, V1, A1, c, dt, u);
    if (v > peak) peak = v;
    if (v < low) low = v;
  }
  return { c, maxAccel: maxD / dt, peak, low };
}

function speedAt(V0, A0, V1, A1, c, dt, u) {
  const u2 = u * u, u3 = u2 * u;
  return V0 * (2 * u3 - 3 * u2 + 1) + dt * A0 * (u3 - 2 * u2 + u) + V1 * (3 * u2 - 2 * u3) + dt * A1 * (u3 - u2) + c * 30 * u2 * (1 - u) * (1 - u);
}

/**
 * The C1 progress profile through knots (`times` ms, `prog` metres; times
 * strictly increasing). `startSpeed`/`startAccel` pin the first knot (a
 * continued timeline); otherwise it starts at its first interval's mean.
 * `pin` {timeMs, speedMps} fixes the speed of the interior knot at timeMs.
 * Returns { times, prog, V, A, c, sAt(t), vAt(t), aAt(t), timeAt(S) }.
 */
export function progressProfile(times, prog, { startSpeed = null, startAccel = 0, pin = null } = {}) {
  const m = times.length - 1, dt = new Float64Array(Math.max(0, m)), vbar = new Float64Array(Math.max(0, m));
  const V = new Float64Array(m + 1), A = new Float64Array(m + 1), c = new Float64Array(Math.max(0, m));
  for (let k = 0; k < m; k++) { dt[k] = (times[k + 1] - times[k]) / 1000; vbar[k] = (prog[k + 1] - prog[k]) / dt[k]; }
  if (m > 0) {
    const pinned = Number.isFinite(startSpeed);
    V[0] = pinned ? startSpeed : vbar[0]; A[0] = pinned && Number.isFinite(startAccel) ? startAccel : 0;
    for (let k = 1; k < m; k++) V[k] = Number.isFinite(pin?.speedMps) && times[k] === pin.timeMs ? pin.speedMps : knotSpeed(vbar[k - 1], dt[k - 1], vbar[k], dt[k]);
    V[m] = vbar[m - 1];
    for (let k = 0; k < m; k++) c[k] = vbar[k] - (V[k] + V[k + 1]) / 2 - dt[k] * (A[k] - A[k + 1]) / 12;
  }
  const locate = (t) => {
    let lo = 0, hi = m;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  };
  const sAt = (t) => {
    if (m < 1 || t <= times[0]) return prog[0];
    if (t >= times[m]) return prog[m];
    const k = locate(t);
    if (t === times[k]) return prog[k];
    const u = (t - times[k]) / (times[k + 1] - times[k]), u2 = u * u, u3 = u2 * u, u4 = u3 * u, d = dt[k];
    return prog[k] + d * (V[k] * (u4 / 2 - u3 + u) + d * A[k] * (u4 / 4 - 2 * u3 / 3 + u2 / 2) + V[k + 1] * (u3 - u4 / 2)
      + d * A[k + 1] * (u4 / 4 - u3 / 3) + c[k] * (10 * u3 - 15 * u4 + 6 * u4 * u));
  };
  const vAt = (t) => {
    if (m < 1) return 0;
    const k = locate(clamp(t, times[0], times[m])), u = clamp((t - times[k]) / (times[k + 1] - times[k]), 0, 1);
    return speedAt(V[k], A[k], V[k + 1], A[k + 1], c[k], dt[k], u);
  };
  const aAt = (t) => {
    if (m < 1) return 0;
    const k = locate(clamp(t, times[0], times[m])), u = clamp((t - times[k]) / (times[k + 1] - times[k]), 0, 1), d = dt[k];
    return ((V[k + 1] - V[k]) * 6 * u * (1 - u) + d * A[k] * (3 * u * u - 4 * u + 1) + d * A[k + 1] * (3 * u * u - 2 * u) + c[k] * 60 * u * (1 - u) * (1 - 2 * u)) / d;
  };
  const timeAt = (S) => {
    if (m < 1 || S <= prog[0]) return times[0];
    if (S >= prog[m]) return times[m];
    let k = 0;
    while (k < m - 1 && prog[k + 1] <= S) k++;
    if (S === prog[k]) return times[k];
    let a = times[k], b = times[k + 1];
    for (let i = 0; i < 60 && b - a > 1e-7; i++) { const mid = (a + b) / 2; if (sAt(mid) < S) a = mid; else b = mid; }
    return (a + b) / 2;
  };
  return { times, prog, V, A, c, sAt, vAt, aAt, timeAt };
}

/**
 * Items laid end to end: G (start of each item in global progress) and the
 * profile knots -- the start, every payoff inside its item after the start,
 * and the end. `payoffOf(i)` is item i's payoffS (null for a link).
 */
export function itemKnots(items, payoffOf, t0, durationMs) {
  const G = new Float64Array(items.length + 1);
  items.forEach((it, i) => { G[i + 1] = G[i] + Math.max(0, it.sTo - it.sFrom); });
  const times = [t0], prog = [0], knotItem = [-1];
  items.forEach((it, i) => {
    const payoffS = payoffOf(i);
    if (!Number.isFinite(payoffS) || !Number.isFinite(it.payoffMs) || it.payoffMs <= times.at(-1) || it.payoffMs > durationMs) return;
    if (payoffS < it.sFrom - 1e-6 || payoffS > it.sTo + 1e-6) return;
    times.push(it.payoffMs); prog.push(G[i] + clamp(payoffS, it.sFrom, it.sTo) - it.sFrom); knotItem.push(i);
  });
  if (times.at(-1) < durationMs) { times.push(durationMs); prog.push(G[items.length]); knotItem.push(-1); }
  return { G, times, prog, knotItem };
}

const pathOf = (library, item) => (item.kind === 'link' ? library.linkById.get(item.id) : library.shotById.get(item.id));

// pathPoseAt's spline (the validated geometry), traversed C1 in progress:
// pathPoseAt maps progress to the segment fraction linearly, so the eye's
// speed per progress metre steps wherever the sample spacing changes (the
// shipped s lanes are quantized to 0.1 m: 24.1 m then 24.2 m is a 0.4% step,
// a spike in eye acceleration). Here the fraction is a cubic Hermite in
// progress whose slope at a sample is its two segments' mean, so speed is
// continuous; poses move along the same curve by at most a few millimetres.
function smoothPoseAt(path, x) {
  const s = path.s, n = s.length;
  if (n < 3 || !(x > s[0] && x < s[n - 1])) return pathPoseAt(path, x);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid] <= x) lo = mid; else hi = mid; }
  const ds = s[lo + 1] - s[lo];
  if (!(ds > 0)) return pathPoseAt(path, x);
  const before = lo > 0 ? s[lo] - s[lo - 1] : ds, after = lo + 2 < n ? s[lo + 2] - s[lo + 1] : ds;
  const k0 = 2 * ds / (before + ds), k1 = 2 * ds / (ds + after), t = (x - s[lo]) / ds, t2 = t * t, t3 = t2 * t;
  return pathPoseAt(path, s[lo] + ds * ((t3 - 2 * t2 + t) * k0 + 3 * t2 - 2 * t3 + (t3 - t2) * k1));
}

// Item k's path, extended by one support sample at each end where it joins
// its neighbour exactly (shot end -> link start, link end -> shot start), so
// the Catmull-Rom runs across the join instead of reflecting at it. The
// support lies on the neighbour's first chord, scaled to this path's own
// sample spacing: both sides then share one tangent per progress metre at
// the join, and the eye's velocity is continuous from one path to the next.
// A continued element (the same element cut at a replan) looks past its own
// committed copy for the neighbour, as the committed timeline did.
function joinedPath(library, items, k) {
  const item = items[k], path = pathOf(library, item).path, n = path.s.length, L = path.s[n - 1];
  const same = (a, b) => a && b && a.kind === b.kind && a.id === b.id;
  const joins = (a, b) => (a.kind === 'shot' && b.kind === 'link' ? pathOf(library, b)?.from === a.id
    : a.kind === 'link' && b.kind === 'shot' && pathOf(library, a)?.to === b.id);
  let p = k - 1;
  while (p >= 0 && same(items[p], item)) p--;
  const prevItem = items[p], nextItem = items[k + 1], prevPath = prevItem && pathOf(library, prevItem).path;
  const before = prevItem && joins(prevItem, item) && prevItem.sTo >= prevPath.s.at(-1) - 1e-6 ? prevPath : null;
  const after = nextItem && joins(item, nextItem) && item.sTo >= L - 1e-6 && nextItem.sFrom <= 1e-6 ? pathOf(library, nextItem).path : null;
  if (!before && !after) return path;
  const o = before ? 1 : 0, m = n + o + (after ? 1 : 0);
  const out = { s: new Float64Array(m), eye: new Float64Array(m * 3), aim: new Float64Array(m * 3), fov: new Float64Array(m), flow: new Float64Array(m) };
  for (let i = 0; i < n; i++) {
    out.s[o + i] = path.s[i]; out.fov[o + i] = path.fov[i]; out.flow[o + i] = path.flow?.[i] ?? 0;
    for (let q = 0; q < 3; q++) { out.eye[(o + i) * 3 + q] = path.eye[i * 3 + q]; out.aim[(o + i) * 3 + q] = path.aim[i * 3 + q]; }
  }
  // Support at `at`: from this path's end sample `j` toward neighbour sample
  // `i`, `f` of the way (own spacing over the neighbour's).
  const support = (src, i, j, at, sValue, f) => {
    out.s[at] = sValue; out.fov[at] = path.fov[j] + (src.fov[i] - path.fov[j]) * f; out.flow[at] = src.flow?.[i] ?? 0;
    for (let q = 0; q < 3; q++) {
      out.eye[at * 3 + q] = path.eye[j * 3 + q] + (src.eye[i * 3 + q] - path.eye[j * 3 + q]) * f;
      out.aim[at * 3 + q] = path.aim[j * 3 + q] + (src.aim[i * 3 + q] - path.aim[j * 3 + q]) * f;
    }
  };
  if (before) {
    const nb = before.s.length, own = path.s[1] - path.s[0];
    support(before, nb - 2, 0, 0, path.s[0] - own, own / (before.s[nb - 1] - before.s[nb - 2]));
  }
  if (after) { const own = L - path.s[n - 2]; support(after, 1, n - 1, m - 1, L + own, own / (after.s[1] - after.s[0])); }
  return out;
}

/**
 * Keyframes for a plan. With `previous`, every key through the plan's start
 * (frozenThroughMs, which may not lie beyond it) is copied bit-exactly from
 * `previous`, and the plan -- whose `start` continues the committed element
 * at its progress, speed and acceleration -- takes over from there.
 */
export function buildShotTimeline(library, plan, { previous = null, frozenThroughMs = -1, tunables = {} } = {}) {
  const T = shotMotion(library, tunables), durationMs = Math.max(0, plan.durationMs || 0), notes = [...(plan.notes || [])];
  const count = durationMs > 0 ? Math.ceil(durationMs / SHOT_KEY_MS) + 1 : 1, keyTime = (i) => Math.min(durationMs, i * SHOT_KEY_MS);
  const planItems = plan.items || [], t0 = planItems[0]?.startMs ?? 0;
  const resolved = planItems.map((item) => pathOf(library, item));
  if (resolved.some((r) => !r)) throw new Error('shot plan references an item missing from the library');
  const subjectIndex = new Map(library.subjects.map((s, i) => [s.id, i]));

  // Committed prefix: previous items before the plan's start (the continued
  // one cut at it), so the copied meta keeps pointing at the right items.
  let kept = [], keptPayoffs = [], keptKnots = [], lastFrozen = -1;
  if (previous?.fov?.length) {
    // Keys after the plan's start are the plan's own: freezing them would
    // splice two different motions.
    if (frozenThroughMs > t0) throw new Error(`frozenThroughMs ${frozenThroughMs} lies beyond the plan's start ${t0}`);
    lastFrozen = Math.min(count - 1, previous.fov.length - 1, Math.floor(t0 / SHOT_KEY_MS));
    kept = previous.items.filter((it) => it.startMs < t0).map((it) => (it.endMs > t0
      ? { ...it, endMs: t0, sTo: it.id === planItems[0]?.id && it.kind === planItems[0]?.kind ? planItems[0].sFrom : it.sTo } : { ...it }));
    keptPayoffs = (previous.payoffs || []).filter((p) => p.plannedMs <= t0 && p.itemIndex < kept.length).map((p) => ({ ...p }));
    keptKnots = (previous.knots || []).filter((k) => k.timeMs <= t0 && k.itemIndex < kept.length).map((k) => ({ ...k }));
  }
  const offset = kept.length, items = [...kept, ...planItems.map((it) => ({ ...it }))];
  const paths = planItems.map((_, j) => joinedPath(library, items, offset + j));

  const { G, times, prog, knotItem } = itemKnots(planItems, (i) => (planItems[i].kind === 'shot' ? resolved[i].payoffS : null), t0, durationMs);
  const profile = progressProfile(times, prog, { startSpeed: plan.start?.speedMps ?? null, startAccel: plan.start?.accelMps2 ?? 0, pin: plan.pin ?? null });

  const locateItem = (S) => {
    let lo = 0, hi = planItems.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (G[mid] <= S) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const sample = (t) => {
    const S = profile.sAt(Math.max(t, t0)), j = locateItem(S), it = planItems[j];
    const local = clamp(it.sFrom + (S - G[j]), it.sFrom, it.sTo);
    return { j, it, local, pose: smoothPoseAt(paths[j], local) };
  };
  const phaseOf = (it, rec, local, t) => {
    if (it.kind !== 'shot') return 0;
    if (Number.isFinite(it.payoffMs) && !it.hidden && Math.abs(t - it.payoffMs) <= PAYOFF_WINDOW_MS) return 1;
    if (local >= rec.holdS[0] && local <= rec.holdS[1]) return 2;
    return local < rec.payoffS ? 0 : 3;
  };
  const subjectOf = (it, rec) => subjectIndex.get(it.kind === 'shot' ? rec.subjectId : library.shotById.get(rec.to)?.subjectId) ?? 0;

  const eye = new Float32Array(count * 3), target = new Float32Array(count * 3), fov = new Float32Array(count), meta = new Uint16Array(count * 4);
  const progress = new Float64Array(count), speed = new Float64Array(count), accel = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (i <= lastFrozen) {
      eye.set(previous.eye.subarray(i * 3, i * 3 + 3), i * 3); target.set(previous.target.subarray(i * 3, i * 3 + 3), i * 3);
      fov[i] = previous.fov[i]; meta.set(previous.meta.subarray(i * 4, i * 4 + 4), i * 4);
      progress[i] = previous.progress?.[i] ?? 0; speed[i] = previous.speed?.[i] ?? 0; accel[i] = previous.accel?.[i] ?? 0;
      continue;
    }
    const t = keyTime(i), { j, it, local, pose } = sample(t), rec = resolved[j];
    eye.set(pose.eyeM, i * 3); target.set(pose.targetM, i * 3); fov[i] = pose.fovYDeg;
    meta.set([offset + j, it.kind === 'link' ? 1 : 0, phaseOf(it, rec, local, t), subjectOf(it, rec)], i * 4);
    progress[i] = local; speed[i] = t < t0 ? 0 : profile.vAt(t); accel[i] = t < t0 ? 0 : profile.aAt(t);
  }

  // Payoffs (on screen) and every knot, for later continuations. A payoff's
  // actual time is read back from the sampled progress lane: where its item's
  // progress crosses payoffS between two keys.
  const crossing = (itemIndex, payoffS) => {
    for (let i = Math.max(0, lastFrozen); i + 1 < count; i++) {
      if (meta[i * 4] !== itemIndex || meta[(i + 1) * 4] !== itemIndex || !(progress[i] <= payoffS + 1e-9 && progress[i + 1] >= payoffS - 1e-9)) continue;
      const span = progress[i + 1] - progress[i];
      return keyTime(i) + (span > 0 ? clamp((payoffS - progress[i]) / span, 0, 1) : 0) * (keyTime(i + 1) - keyTime(i));
    }
    return NaN;
  };
  const payoffs = [...keptPayoffs], knots = [...keptKnots];
  for (let k = 1; k < times.length; k++) {
    if (knotItem[k] < 0) continue;
    const it = planItems[knotItem[k]], rec = resolved[knotItem[k]];
    knots.push({ timeMs: times[k], itemIndex: offset + knotItem[k] });
    if (it.hidden) continue;
    payoffs.push({ itemIndex: offset + knotItem[k], shotId: it.id, subjectId: rec.subjectId, plannedMs: it.payoffMs,
      actualMs: crossing(offset + knotItem[k], rec.payoffS), moment: it.moment ?? -1 });
  }

  // Diagnostics over the planned (uncommitted) span, every 50 ms: eye speed
  // and its rate of change (the acceleration limit), the eye's sideways
  // acceleration (reported only), look rates and image flow.
  const lane = plan.intensity, laneStep = plan.intensityStepMs || SHOT_KEY_MS;
  const flowLimit = (t) => {
    if (!lane?.length) return T.flowEnergetic;
    const at = clamp(t / laneStep, 0, lane.length - 1), a = Math.floor(at), b = Math.min(lane.length - 1, a + 1);
    return T.flowCalm + (T.flowEnergetic - T.flowCalm) * (lane[a] + (lane[b] - lane[a]) * (at - a));
  };
  const d = { maxSpeedMps: 0, maxProgressSpeedMps: 0, maxAccelMps2: 0, maxLateralAccelMps2: 0, maxProgressAccelMps2: 0, maxYawDegPerSec: 0, maxPitchDegPerSec: 0,
    maxFlowRadPerSec: 0, maxFlowRatio: 0, minSpeedMps: Infinity, payoffErrorMs: 0, notes };
  const h = 50, from = Math.max(t0, lastFrozen >= 0 ? keyTime(lastFrozen) : 0);
  let prev = null, prev2 = null, prevSpeed = null;
  for (let t = from; ; t = Math.min(durationMs, t + h)) {
    const { j, local, pose } = sample(t), v = profile.vAt(t), look = headingPitch(lookDir(pose));
    const flow = v * pathLaneAt(paths[j], paths[j].flow, local);
    d.maxProgressSpeedMps = Math.max(d.maxProgressSpeedMps, v); d.minSpeedMps = Math.min(d.minSpeedMps, v);
    d.maxProgressAccelMps2 = Math.max(d.maxProgressAccelMps2, Math.abs(profile.aAt(t)));
    d.maxFlowRadPerSec = Math.max(d.maxFlowRadPerSec, flow); d.maxFlowRatio = Math.max(d.maxFlowRatio, flow / flowLimit(t));
    if (prev) {
      const dtS = (t - prev.t) / 1000, e = pose.eyeM, p = prev.pose.eyeM, eyeSpeed = Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2]) / dtS;
      d.maxSpeedMps = Math.max(d.maxSpeedMps, eyeSpeed);
      if (prevSpeed !== null && dtS > .02) d.maxAccelMps2 = Math.max(d.maxAccelMps2, Math.abs(eyeSpeed - prevSpeed) / dtS);
      if (prev2 && dtS > .02 && Math.abs(prev.t - prev2.t - (t - prev.t)) < 1e-6) {
        const q = prev2.pose.eyeM, acc = [0, 1, 2].map((k) => (e[k] - 2 * p[k] + q[k]) / (dtS * dtS)), dir = [0, 1, 2].map((k) => e[k] - q[k]), dl = Math.hypot(...dir) || 1;
        const along = (acc[0] * dir[0] + acc[1] * dir[1] + acc[2] * dir[2]) / dl;
        d.maxLateralAccelMps2 = Math.max(d.maxLateralAccelMps2, Math.sqrt(Math.max(0, acc[0] ** 2 + acc[1] ** 2 + acc[2] ** 2 - along * along)));
      }
      d.maxYawDegPerSec = Math.max(d.maxYawDegPerSec, Math.abs(((look.headingDeg - prev.look.headingDeg + 540) % 360) - 180) / dtS);
      d.maxPitchDegPerSec = Math.max(d.maxPitchDegPerSec, Math.abs(look.pitchDeg - prev.look.pitchDeg) / dtS);
      prevSpeed = dtS > .02 ? eyeSpeed : prevSpeed;
    }
    prev2 = prev; prev = { t, pose, look };
    if (t >= durationMs) break;
  }
  if (!Number.isFinite(d.minSpeedMps)) d.minSpeedMps = 0;
  for (const p of payoffs.slice(keptPayoffs.length)) d.payoffErrorMs = Math.max(d.payoffErrorMs, Number.isFinite(p.actualMs) ? Math.abs(p.actualMs - p.plannedMs) : Infinity);
  if (d.maxProgressAccelMps2 > T.maxAccelMps2 + 1e-6) notes.push(`progress acceleration ${d.maxProgressAccelMps2.toFixed(2)} m/s2 over the limit`);
  if (d.maxAccelMps2 > T.maxAccelMps2 * 1.05) notes.push(`eye acceleration ${d.maxAccelMps2.toFixed(2)} m/s2 over the limit`);
  if (d.maxFlowRatio > 1.05) notes.push(`image flow ${d.maxFlowRatio.toFixed(2)}x its comfort limit`);

  return restoreShotTimeline({ durationMs, startMs: t0, eye, target, fov, meta, progress, speed, accel, items, payoffs, knots,
    subjects: library.subjects.map((s) => s.id), viewId: library.viewId ?? null, fallback: plan.fallback ?? null, notes, diagnostics: d });
}

function catmull(a, b, c, d, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (3 * b - a - 3 * c + d) * u3);
}

/** A timeline's data without its functions, ready for postMessage. */
export function shotTimelineData(timeline) {
  return timeline && Object.fromEntries(Object.entries(timeline).filter(([, v]) => typeof v !== 'function'));
}

/** Add poseAt(t) and stateAt(t) to a timeline (after a structured clone). */
export function restoreShotTimeline(timeline) {
  const { eye, target, fov, meta, durationMs } = timeline, count = fov.length;
  const keyTime = (i) => Math.min(durationMs, i * SHOT_KEY_MS);
  const locate = (timeMs) => {
    const t = clamp(Number(timeMs) || 0, 0, durationMs), i = Math.max(0, Math.min(count - 2, Math.floor(t / SHOT_KEY_MS)));
    const span = keyTime(i + 1) - keyTime(i);
    return { t, i, u: span > 0 ? clamp((t - keyTime(i)) / span, 0, 1) : 0 };
  };
  const spline = (arr, i, u) => {
    if (u <= 0) return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
    if (u >= 1) return [arr[i * 3 + 3], arr[i * 3 + 4], arr[i * 3 + 5]];
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p1 = arr[i * 3 + k], p2 = arr[(i + 1) * 3 + k];
      out[k] = catmull(i > 0 ? arr[(i - 1) * 3 + k] : 2 * p1 - p2, p1, p2, i + 2 < count ? arr[(i + 2) * 3 + k] : 2 * p2 - p1, u);
    }
    return out;
  };
  const describe = (key) => {
    const itemIndex = meta[key * 4], item = timeline.items?.[itemIndex];
    return { itemIndex, kind: meta[key * 4 + 1] ? 'link' : 'shot', id: item?.id ?? null, subjectId: timeline.subjects?.[meta[key * 4 + 3]] ?? null,
      phase: SHOT_PHASES[meta[key * 4 + 2]] ?? 'approach' };
  };
  timeline.poseAt = (timeMs) => {
    if (count < 2) return { eyeM: [eye[0], eye[1], eye[2]], targetM: [target[0], target[1], target[2]], fovYDeg: fov[0], tour: true, shot: describe(0) };
    const { i, u } = locate(timeMs);
    return { eyeM: spline(eye, i, u), targetM: spline(target, i, u), fovYDeg: fov[i] + (fov[i + 1] - fov[i]) * u, tour: true, shot: describe(u < .5 ? i : i + 1) };
  };
  timeline.stateAt = (timeMs) => {
    const { t, i, u } = count < 2 ? { t: 0, i: 0, u: 0 } : locate(timeMs), key = count < 2 || u < .5 ? i : i + 1, shot = describe(key);
    // Lanes interpolate inside one item; across an item change take the nearer key.
    const sameItem = count > 1 && meta[i * 4] === meta[(i + 1) * 4];
    const lerp = (lane) => (lane ? (sameItem ? lane[i] + (lane[i + 1] - lane[i]) * u : lane[key]) : null);
    const payoffs = timeline.payoffs || [];
    const current = payoffs.find((p) => Math.abs(p.plannedMs - t) <= PAYOFF_WINDOW_MS) || payoffs.find((p) => p.plannedMs >= t) || null;
    return { timeMs: t, ...shot, progressM: lerp(timeline.progress), speedMps: lerp(timeline.speed),
      payoff: current && { ...current, inMs: current.plannedMs - t }, fallback: timeline.fallback ?? null };
  };
  return timeline;
}

/**
 * Where a committed timeline is at the replanning horizon
 * ceil((committedThroughMs + leadMs) / 100) * 100: the element, its local
 * progress, speed and acceleration, the payoff it already showed
 * (`payoffMs`), its next knot `next` {timeMs, speedMps, id: that shot} and
 * the times of all later knots (`knots`), so a replan can keep the
 * committed sequence. Null when nothing is left to replan.
 */
export function shotContinuation(previous, committedThroughMs, { leadMs = 3000, minRemainingMs = 4000 } = {}) {
  const count = previous?.fov?.length || 0;
  if (count < 2 || !previous.progress || !previous.items?.length) return null;
  const timeMs = Math.ceil((Math.max(0, Number(committedThroughMs) || 0) + leadMs) / SHOT_KEY_MS) * SHOT_KEY_MS;
  if (timeMs > previous.durationMs - minRemainingMs) return null;
  const i = Math.round(timeMs / SHOT_KEY_MS), itemIndex = previous.meta[i * 4], item = previous.items[itemIndex];
  if (!item) return null;
  const later = (previous.knots || []).filter((k) => k.timeMs > timeMs && previous.items[k.itemIndex]).sort((a, b) => a.timeMs - b.timeMs);
  const next = later[0] && Number.isInteger(later[0].timeMs / SHOT_KEY_MS)
    ? { timeMs: later[0].timeMs, speedMps: previous.speed[later[0].timeMs / SHOT_KEY_MS], id: previous.items[later[0].itemIndex].id } : null;
  return { timeMs, itemKind: item.kind, id: item.id, s: previous.progress[i], speedMps: previous.speed[i], accelMps2: previous.accel[i],
    itemIndex, payoffMs: item.kind === 'shot' && Number.isFinite(item.payoffMs) && item.payoffMs <= timeMs ? item.payoffMs : null,
    next, knots: later.map((k) => k.timeMs) };
}
