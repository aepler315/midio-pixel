// A single construction operation, indexed by the relief that the terrain
// actually draws. The old per-view work schedule cannot send the team to a
// finished summit while it is flat, or keep building after the land is up.
// All positions remain in source space: ActorsGL's shared groundLift seats
// actors, transferred motes, fixed lines and survey threads on the same mesh.
import { pathPosition } from './CastJobs.js';
import { ACTOR_LOOK, routePosition, ROUTE_UNITS } from './RangeActors.js';

const unit = x => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
const ease = (a, b, x) => { const u = unit((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const PREPARE_END = .035;
const SETTLE_START = .90;
// Infrastructure reveals over a small share of the actual climb, never an
// elapsed-time animation that continues when the mountain stops moving.
const INSTALL_SPAN = .018;
const MARK_AGE_MS = 1500;
const IDS = ['midio', 'broshi', 'midasus'];

/** Position sampler for the job's shared work front. A basin follows its
 * cairns once; a tour borrows a real land route once, instead of having
 * three independent paths that repeat after construction has finished. */
function frontFor(plan, routes, options) {
  if (plan?.job === 'ascent' && plan.points?.length > 1) {
    const waterU = plan.waterU || 0;
    return (u, hoverM) => pathPosition(plan, waterU + (1 - waterU) * unit(u), { ...options, hoverM });
  }
  if (plan?.job === 'lamplighters' && plan.cairns?.length > 1) {
    const points = plan.cairns;
    const path = { points, us: points.map((_, k) => k / (points.length - 1)), waterU: 0 };
    return (u, hoverM) => pathPosition(path, unit(u), { ...options, hoverM });
  }
  const route = routes?.broshi || routes?.midasus || routes?.midio;
  return route?.points?.length > 1 ? (u, hoverM) => routePosition(route, unit(u) * ROUTE_UNITS, { ...options, hoverM }) : null;
}

/** Existing RangeScene job shape, driven only by exact terrain rise and
 * this heard-time actor sample. Null means the caller can use its legacy
 * job (no build state), or no real route exists on which to stand. */
export function castConstructionJob({ plan = null, work = null, routes = null, data = null,
  waterLevelM = null, rise01, actors = null } = {}) {
  if (!Number.isFinite(rise01)) return null;
  const sample = frontFor(plan, routes, { data, waterLevelM });
  if (!sample) return null;
  const relief = unit(rise01);
  const phase = relief <= PREPARE_END ? 'prepare' : relief < SETTLE_START ? 'raise' : relief < 1 ? 'settle' : 'inspect';
  const progress = unit((relief - PREPARE_END) / (1 - PREPARE_END));
  const settle = ease(SETTLE_START, 1, relief);
  const activity01 = ease(PREPARE_END, .12, relief) * (1 - settle);
  // Constant formation makes a lamp's work independent of lane intensity;
  // the music instead gives the tools their pulse. This keeps installed
  // anchors from unlighting when Broshi's musical lane falls quiet.
  const anchorFront = unit(progress - .045 * (1 - settle));
  const fronts = { midio: Math.min(.98, progress), broshi: Math.max(0, anchorFront - .025 * settle),
    midasus: Math.min(1, progress + .075 * (1 - .5 * settle)) };
  const marks = work?.marks || [];
  const lights = work?.lights || [];
  const lightByMark = new Map(lights.map(light => [light.mark, light]));
  const cairns = lights.filter(light => light.kind === 'cairn');
  const ages = [];
  // The bounded work list is ordered: a thread refers only to earlier
  // anchor marks. No per-frame search through a song or effect history.
  for (let k = 0; k < marks.length; k++) {
    const mark = marks[k], light = lightByMark.get(k);
    let due = Number.isFinite(mark.p) ? unit(mark.p) : 1;
    if (light?.kind === 'line') due = unit((light.u - (plan.waterU || 0)) / (1 - (plan.waterU || 0)));
    if (light?.kind === 'cairn') {
      const i = cairns.indexOf(light);
      due = i / Math.max(1, plan.cairns.length - 1);
    }
    const front = light?.actor === 'broshi' ? anchorFront : progress;
    const age = mark.after?.length ? Math.min(...mark.after.map(i => ages[i] ?? -Infinity)) - 800
      : (front - due) / INSTALL_SPAN * MARK_AGE_MS;
    ages.push(phase === 'prepare' ? -Infinity : phase === 'inspect' ? Infinity : age);
  }
  const since = k => ages[k] ?? -Infinity;
  const reached = k => since(k) >= 0;
  const transfer = (id, target) => {
    const age = actors?.[id]?.noteAgeMs;
    if (!(activity01 > .025) || !target || !(age >= 0 && age < 800)) return null;
    return { t: .03 + .94 * age / 800, pos: target };
  };
  const cast = {};
  for (const id of IDS) {
    const pos = sample(fronts[id], ACTOR_LOOK[id].climbM);
    const role = phase === 'inspect' ? 'inspect' : phase === 'prepare'
      ? { midio: 'set-out', broshi: 'anchor', midasus: 'survey' }[id]
      : { midio: 'direct', broshi: 'secure', midasus: 'survey' }[id];
    // Direct transfers remain small: existing twelve-mote tool strokes
    // toward the next real point on the work front, never a new emitter.
    let fly = transfer(id, sample(unit(fronts[id] + (id === 'midasus' ? .045 : .035)), 1.5));
    if (id === 'broshi') {
      let light = null;
      for (const candidate of lights) {
        const age = since(candidate.mark);
        if (candidate.actor === id && age >= 0 && age < 800 && (!light || age < since(light.mark))) light = candidate;
      }
      fly = activity01 > .025 && light ? { t: .03 + .94 * since(light.mark) / 800, pos: light.pos } : null;
    }
    cast[id] = { pos, role, fly, wakeTail: null };
    if (id === 'midasus') cast[id].lag = [1, 2, 3].map(j => sample(unit(fronts[id] - .012 * j), ACTOR_LOOK.midasus.climbM));
  }
  return {
    actors: cast, construction: { phase, relief01: relief, progress01: progress, activity01 },
    // A quiet inspection glow, with no giant beacon or travelling fuse.
    beacon01: .12 * settle, beaconGain: 1.15, dim: 1, reached, since, times: [],
    state: { p: progress, active: phase !== 'inspect', offsets: { broshi: .045, midasus: .075 },
      camps: 0, payoff01: settle, fuse01: 0, climax: false, shelter01: 0 },
  };
}
