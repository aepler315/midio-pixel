// When the cast work in each view (docs/landscape-cast.md). A song visits
// several views; every recurrence of a section label returns to the same
// place, and the cast pick up that view's job where they left it. Song
// structure sets when a job finishes (the climax view on its climax phrase,
// every other view late in its last stay); the lanes set how the time in
// between is spent. Everything is compiled once per song from heard-time
// data, so a seek either way reads the same state.
//
// Plain data, no THREE: CastJobs.js says where the work happens, RangeScene
// places the lanterns and lights from this.

export const CAST_STEP_MS = 50;
/** Work rate: an idle team still climbs, a playing one climbs faster. */
export const CAST_IDLE_RATE = 0.35;
/** Inside a storm episode the team shelter (ramped over its build). */
export const CAST_STORM_RATE = 0.15;
export const CAST_STORM_BUILD_MS = 6000;
export const CAST_STORM_RELEASE_MS = 4000;
/** Every view but the climax view finishes this far through its last stay. */
export const CAST_FINISH_FRACTION = 0.85;
/** The climax view arrives this far into its climax phrase. */
export const CAST_CLIMAX_ARRIVE_MS = 4000;
export const CAST_CLIMAX_ARRIVE_FRACTION = 0.25;
/** Songs shorter than this are one job, with no camps. */
export const CAST_SHORT_SONG_MS = 30000;
/** The team gather into a camp (and set out from it) over this long. */
export const CAST_CAMP_MS = 2000;
/** Payoff: the beacon swells over BEACON, then the fuse runs over FUSE. */
export const CAST_BEACON_MS = 1500;
export const CAST_FUSE_MS = 2000;
/** Gaps on the path (fractions of the job): Broshi closes up on the bass,
 *  Midasus ranges further ahead while she plays. */
export const CAST_BROSHI_GAP = Object.freeze([0.07, 0.03]);
export const CAST_MIDASUS_GAP = Object.freeze([0.04, 0.12]);
/** In a storm the team bunch up to this share of their gaps. */
export const CAST_STORM_BUNCH = 0.3;
const DEFAULT_BEAT_MS = 500;
// The cast's lanes (RangeActors.ACTOR_IDS; not imported, RangeActors
// compiles this schedule).
const ACTOR_IDS = ['midio', 'broshi', 'midasus'];

const unit = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const smooth = (a, b, x) => { const t = unit((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** The climax phrase: the highest relEnergy01, the later one on a tie. */
export function climaxPhrase(phrases = []) {
  let best = null;
  for (const p of phrases) {
    if (!Number.isFinite(p?.startMs) || !(p.endMs > p.startMs)) continue;
    if (!best || (p.relEnergy01 ?? 0) >= (best.relEnergy01 ?? 0)) best = p;
  }
  return best;
}

/** Fallback climax with no trusted phrases: the loudest 3 s after the
 *  first quarter of the song. */
function energyClimaxMs(energyAt, durationMs) {
  if (typeof energyAt !== 'function') return durationMs * CAST_FINISH_FRACTION;
  const win = 3000, step = 250;
  let best = -1, at = durationMs * CAST_FINISH_FRACTION;
  for (let t = Math.max(win, durationMs * 0.25); t <= durationMs; t += step) {
    let sum = 0, k = 0;
    for (let s = t - win; s <= t; s += step) { sum += unit(energyAt(s)); k++; }
    if (sum / k > best) { best = sum / k; at = t; }
  }
  return at;
}

/** The onset in `list` (sorted) nearest `t` within [lo, hi] that `ok`
 *  accepts, or null. */
const nearestOnset = (list, t, lo, hi, ok) => {
  if (!list?.length) return null;
  let a = 0, b = list.length;
  while (a < b) { const m = (a + b) >>> 1; if (list[m] < t) a = m + 1; else b = m; }
  let best = null;
  for (let i = a - 1; i >= 0 && list[i] >= lo; i--) if (list[i] <= hi && ok(list[i])) { best = list[i]; break; }
  for (let i = a; i < list.length && list[i] <= hi; i++) {
    if (list[i] < lo || !ok(list[i])) continue;
    if (best == null || list[i] - t < t - best) best = list[i];
    break;
  }
  return best;
};

/**
 * Compile the cast's schedule for a song.
 *   sections        [{ startMs, endMs, barMs }] (BiomeManager's)
 *   viewForSection  (section, index) -> view id or null
 *   phrases         LandscapeScore phrases ({ startMs, endMs, relEnergy01 })
 *   episodes        LandscapeScore storm episodes ({ startMs, endMs })
 *   lanes           the actor score ({ at(t) -> { midio: { glow }, ... } })
 *   onsets          { midio: [tMs], broshi: [tMs], midasus: [tMs] }, sorted
 *   energyAt        globalEnergyNorm (the no-phrase fallback)
 *   previous, committedThroughMs   an earlier schedule for this song: state
 *                   at or before committedThroughMs is kept exactly
 * Returns { durationMs, views, climaxViewId, at(t), stateOf(viewId, t),
 * kindleTimes(viewId, marks) }.
 */
export function compileCastSchedule({ sections = [], viewForSection = () => null, phrases = [], episodes = [],
  lanes = null, onsets = {}, energyAt = null, durationMs = 0, previous = null, committedThroughMs = -1 } = {}) {
  const D = Math.max(0, Number(durationMs) || 0);
  const n = Math.ceil(D / CAST_STEP_MS) + 1;
  const timeOf = (i) => Math.min(D, i * CAST_STEP_MS);
  const ordered = sections.filter((s) => Number.isFinite(s?.startMs) && s.endMs > s.startMs)
    .map((s, i) => ({ s, i })).sort((a, b) => a.s.startMs - b.s.startMs);
  const viewIds = [...new Set(ordered.map(({ s, i }) => viewForSection(s, i)).filter(Boolean))];
  const short = D < CAST_SHORT_SONG_MS;
  const climax = climaxPhrase(phrases);
  const oneStay = short || viewIds.length <= 1;

  // Stays: runs of consecutive sections in the same view. A short song, or
  // one that never leaves its view, is a single stay per view: the whole
  // song. Untrusted phrases do not change the stays; only the climax moves.
  const stays = new Map(viewIds.map((v) => [v, []]));
  if (oneStay) for (const v of viewIds) stays.get(v).push({ startMs: 0, endMs: D });
  else {
    // A section with no view does not break a stay.
    let prior = null;
    for (const { s, i } of ordered) {
      const v = viewForSection(s, i);
      if (!v) continue;
      const list = stays.get(v);
      if (prior === v) list.at(-1).endMs = Math.min(D, s.endMs);
      else list.push({ startMs: Math.max(0, s.startMs), endMs: Math.min(D, s.endMs) });
      prior = v;
    }
  }

  // Finish times, and the climax view.
  const climaxMs = short ? D * CAST_FINISH_FRACTION : climax
    ? climax.startMs + Math.min(CAST_CLIMAX_ARRIVE_MS, CAST_CLIMAX_ARRIVE_FRACTION * (climax.endMs - climax.startMs))
    : energyClimaxMs(energyAt, D);
  let climaxViewId = null, anchorMs = null;
  if (!short && climax) {
    const hit = ordered.find(({ s }) => climax.startMs >= s.startMs - 1 && climax.startMs < s.endMs);
    climaxViewId = hit ? viewForSection(hit.s, hit.i) : null;
  } else if (!oneStay) {
    // No trusted phrases: the view of the section holding the energy climax,
    // else of the nearest viewed section before it, then after it.
    let k = ordered.findIndex(({ s }) => climaxMs >= s.startMs - 1 && climaxMs < s.endMs);
    if (k < 0) k = ordered.findLastIndex(({ s }) => s.startMs <= climaxMs);
    // anchorMs remembers the section the view came from, so its finish
    // lands in that stay rather than in the view's last one.
    const take = (j) => {
      climaxViewId = viewForSection(ordered[j].s, ordered[j].i) || null;
      if (climaxViewId) anchorMs = ordered[j].s.startMs;
    };
    for (let j = k; j >= 0 && !climaxViewId; j--) take(j);
    for (let j = k + 1; j < ordered.length && !climaxViewId; j++) take(j);
  }
  if (oneStay && !short && viewIds.length === 1) climaxViewId = viewIds[0];
  // The summit push (the stay holding the climax view's finish) goes on
  // through a storm. When that stay is the whole song, the push is the
  // climax phrase onward.
  const finish = new Map(), climaxStay = new Map();
  for (const [v, list] of stays) {
    if (!list.length) continue;
    if (short) { finish.set(v, D * CAST_FINISH_FRACTION); continue; }
    if (oneStay) {
      finish.set(v, Math.min(D, climaxMs));
      climaxStay.set(v, { startMs: climax ? climax.startMs : climaxMs - 2 * CAST_STORM_BUILD_MS, endMs: D });
    } else if (v === climaxViewId) {
      const stay = list.find((s) => climaxMs >= s.startMs && climaxMs <= s.endMs)
        || (anchorMs != null && list.find((s) => anchorMs >= s.startMs && anchorMs < s.endMs)) || list.at(-1);
      finish.set(v, Math.max(stay.startMs, Math.min(stay.endMs, climaxMs)));
      climaxStay.set(v, stay);
    } else {
      const last = list.at(-1);
      finish.set(v, last.startMs + CAST_FINISH_FRACTION * (last.endMs - last.startMs));
    }
  }

  // Lane glow and the weather on one grid.
  const glow = Object.fromEntries(ACTOR_IDS.map((id) => [id, new Float32Array(n)]));
  const storm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = timeOf(i), g = lanes?.at?.(t) || {};
    for (const id of ACTOR_IDS) glow[id][i] = unit(g[id]?.glow);
    let s = 0;
    for (const e of episodes) {
      if (!(e?.endMs > e?.startMs)) continue;
      const k = t < e.startMs ? smooth(e.startMs - CAST_STORM_BUILD_MS, e.startMs, t)
        : t <= e.endMs ? 1 : 1 - smooth(e.endMs, e.endMs + CAST_STORM_RELEASE_MS, t);
      s = Math.max(s, k);
    }
    storm[i] = s;
  }
  const read = (arr, t) => {
    const x = Math.max(0, Math.min(n - 1, t / CAST_STEP_MS)), i = Math.floor(x), f = x - i;
    return arr[i] + ((arr[Math.min(n - 1, i + 1)] ?? arr[i]) - arr[i]) * f;
  };
  const inStay = (list, t) => list.some((s) => t >= s.startMs && t < s.endMs);
  // The heard time a frozen view's state is read at: the last moment it was
  // being travelled to (its outgoing side holds still).
  const anchorOf = (list, t) => {
    let at = list[0]?.startMs ?? 0;
    for (const s of list) { if (t >= s.endMs) at = s.endMs; else if (t >= s.startMs) return t; }
    return Math.min(t, at);
  };

  const plans = new Map();
  for (const [v, list] of stays) {
    if (!list.length) continue;
    const exempt = climaxStay.get(v) || null;
    const weather = (t) => (exempt && t >= exempt.startMs && t < exempt.endMs ? 1 : 1 - (1 - CAST_STORM_RATE) * read(storm, t));
    const work = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const t = timeOf(i - 1);
      const team = (glow.midio[i - 1] + glow.broshi[i - 1] + glow.midasus[i - 1]) / 3;
      work[i] = work[i - 1] + (inStay(list, t + CAST_STEP_MS / 2) ? (CAST_IDLE_RATE + (1 - CAST_IDLE_RATE) * team) * weather(t) * CAST_STEP_MS : 0);
    }
    const camps = short ? [] : list.filter((s) => s.endMs < D - 1).map((s) => ({ atMs: s.endMs }));
    plans.set(v, { stays: list.map(({ startMs, endMs }) => Object.freeze({ startMs, endMs })), work, weather, camps,
      finishMs: finish.get(v), climax: !short && (oneStay || v === climaxViewId) });
  }

  // Refresh: the future is re-normalized from where the earlier schedule
  // stood at committedThroughMs.
  const c = previous && Number.isFinite(committedThroughMs) ? committedThroughMs : -1;
  for (const [v, plan] of plans) {
    plan.fromP = 0; plan.fromMs = -1;
    if (c < 0) continue;
    const before = previous.stateOf?.(v, c);
    plan.fromP = before?.p ?? 0; plan.fromMs = c;
    if (plan.fromP >= 1) { plan.finishMs = before.finishMs ?? Math.min(plan.finishMs, c); continue; }
    if (plan.finishMs <= c) {
      // The new analysis put the finish in the past: finish a little later,
      // in the next stretch of this view, so nothing jumps.
      const due = c + 2 * CAST_CAMP_MS;
      const stay = plan.stays.find((s) => s.endMs > due);
      plan.finishMs = stay ? Math.max(due, stay.startMs + CAST_CAMP_MS) : Infinity;
    }
  }
  const workAt = (plan, t) => read(plan.work, t);

  const glowAt = (id, t) => read(glow[id], t);
  function stateOf(v, timeMs) {
    const plan = plans.get(v);
    if (!plan) return null;
    const t = Math.max(0, Math.min(D, Number.isFinite(timeMs) ? timeMs : 0));
    if (c >= 0 && t <= c && previous?.stateOf?.(v, t)) return previous.stateOf(v, t);
    const F = plan.finishMs;
    let p;
    if (c >= 0) {
      const w0 = workAt(plan, c), span = Number.isFinite(F) ? workAt(plan, F) - w0 : 0;
      p = span > 0 ? plan.fromP + (1 - plan.fromP) * unit((workAt(plan, t) - w0) / span) : t >= F ? 1 : plan.fromP;
    } else {
      const total = workAt(plan, F);
      p = total > 0 ? unit(workAt(plan, t) / total) : t >= F ? 1 : 0;
    }
    if (t >= F) p = 1;
    const a = anchorOf(plan.stays, t);
    const weather = plan.weather(a), shelter01 = unit((1 - weather) / (1 - CAST_STORM_RATE));
    // Camps: the team close up over the end of a stay, and set out from
    // the camp at the start of the next one. At the summit they gather on
    // the lead.
    let gather01 = 0;
    for (const s of plan.stays) {
      if (a < s.startMs || a > s.endMs) continue;
      if (plan.camps.some((k) => k.atMs === s.endMs)) gather01 = Math.max(gather01, smooth(s.endMs - CAST_CAMP_MS, s.endMs, a));
      if (s !== plan.stays[0] && a < s.endMs) gather01 = Math.max(gather01, 1 - smooth(s.startMs, s.startMs + CAST_CAMP_MS, a));
    }
    if (a >= F) gather01 = Math.max(gather01, smooth(F, F + CAST_CAMP_MS, a));
    const bunch = (1 - (1 - CAST_STORM_BUNCH) * shelter01) * (1 - gather01);
    const payoff01 = Number.isFinite(F) ? unit((a - F) / CAST_BEACON_MS) : 0;
    return Object.freeze({
      p, active: inStay(plan.stays, t), finishMs: F, climax: plan.climax,
      offsets: Object.freeze({
        broshi: lerp(CAST_BROSHI_GAP[0], CAST_BROSHI_GAP[1], glowAt('broshi', a)) * bunch,
        midasus: lerp(CAST_MIDASUS_GAP[0], CAST_MIDASUS_GAP[1], glowAt('midasus', a)) * bunch,
      }),
      gather01, camps: plan.camps.filter((k) => k.atMs <= t).length, payoff01,
      fuse01: plan.climax && Number.isFinite(F) ? unit((a - F - CAST_BEACON_MS) / CAST_FUSE_MS) : 0,
      weather, shelter01,
    });
  }

  const beatAt = (t) => {
    const s = ordered.find(({ s }) => t >= s.startMs && t < s.endMs)?.s;
    return Number(s?.barMs) > 0 ? s.barMs / 4 : DEFAULT_BEAT_MS;
  };
  const kindled = new Map();
  /**
   * When each mark in a view kindles. A mark is { p, follow, lane } (lit
   * when progress, offset by the follower's gap -- 'broshi' behind the
   * lead, 'midasus' ahead -- first reaches p) or { after: [i, j], lane }
   * (lit once both marks i and j are). The time snaps to the nearest onset
   * on `lane` within one beat, inside the view's stays. Infinity: never.
   * Memoized by the marks array.
   */
  function kindleTimes(v, marks) {
    const plan = plans.get(v);
    if (!plan || !Array.isArray(marks)) return null;
    let memo = kindled.get(v);
    if (!memo) kindled.set(v, (memo = new WeakMap()));
    if (memo.has(marks)) return memo.get(marks);
    const out = new Float64Array(marks.length).fill(Infinity);
    const due = new Float64Array(marks.length).fill(Infinity);
    const reach = new Map();
    for (const follow of new Set(marks.filter((m) => Number.isFinite(m.p)).map((m) => m.follow || 'lead'))) {
      // Running best progress of that follower over the stays.
      const best = new Float32Array(n);
      let top = 0;
      for (let i = 0; i < n; i++) {
        const t = timeOf(i);
        if (inStay(plan.stays, t) || t >= plan.finishMs) {
          const s = stateOf(v, t);
          const at = follow === 'broshi' ? s.p - s.offsets.broshi : follow === 'midasus' ? s.p + s.offsets.midasus : s.p;
          top = Math.max(top, at);
        }
        best[i] = top;
      }
      reach.set(follow, best);
    }
    const snap = (k, t, earliest) => {
      if (!Number.isFinite(t)) return Infinity;
      const beat = beatAt(t), lo = Math.max(earliest, c >= 0 ? c + 1 : -Infinity, t - beat), hi = t + beat;
      const hit = nearestOnset(onsets?.[marks[k].lane], t, lo, hi, (x) => inStay(plan.stays, x));
      return hit ?? t;
    };
    marks.forEach((m, k) => {
      if (!Number.isFinite(m.p)) return;
      const best = reach.get(m.follow || 'lead');
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (best[mid] >= m.p - 1e-6) hi = mid; else lo = mid + 1; }
      due[k] = lo < n ? timeOf(lo) : Infinity;
      out[k] = snap(k, due[k], -Infinity);
    });
    marks.forEach((m, k) => {
      if (!Array.isArray(m.after)) return;
      due[k] = Math.max(...m.after.map((j) => out[j] ?? Infinity));
      // A thread never runs ahead of the light it joins.
      out[k] = snap(k, due[k], due[k]);
    });
    if (c >= 0) {
      const old = previous?.kindleTimes?.(v, marks);
      if (old) for (let k = 0; k < marks.length; k++) {
        if (old[k] <= c) out[k] = old[k];
        else if (out[k] <= c) out[k] = Math.min(D, c + CAST_STEP_MS);
      }
    }
    const times = Object.freeze(Array.from(out));
    memo.set(marks, times);
    return times;
  }

  const views = Object.freeze(Object.fromEntries([...plans].map(([v, plan]) => [v, Object.freeze({
    stays: Object.freeze(plan.stays), finishMs: plan.finishMs, climax: plan.climax,
    camps: Object.freeze(plan.camps.map((k) => Object.freeze({ atMs: k.atMs, p: stateOf(v, k.atMs).p }))),
  })])));
  return Object.freeze({
    durationMs: D, views, climaxViewId, stateOf, kindleTimes,
    at(timeMs) {
      return Object.freeze(Object.fromEntries([...plans.keys()].map((v) => [v, stateOf(v, timeMs)])));
    },
  });
}
