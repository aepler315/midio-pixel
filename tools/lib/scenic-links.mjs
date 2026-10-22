// Scenic shot tours: connecting moves between shots (docs/scenic-tours.md).
//
// A link leaves one shot exactly where it ends -- eye, travel direction,
// look target and field of view -- and arrives exactly where another
// begins. Over the ground the eye follows the shortest course of bounded
// curvature from the outgoing shot's heading to the incoming one's (a
// Dubins path: arcs of radius discovery.linkRadiusM and straights), so it
// never cusps or turns tighter than the timeline can fly at speed; its
// height follows a cubic in that course's length that leaves and arrives at
// each shot's own climb. Variants take a wider sweep or the second-best
// course (arc) or rise over the terrain (high).
// The look target slides from the outgoing shot's target to the incoming
// one's, so the camera keeps tracking what it was looking at and hands over
// to the next subject; when that would swing past the eye, the direction is
// slerped instead. All variants are generated and scored before any are
// dropped: a shorter transit, a stronger reveal of the next subject or a
// better approach into it can each survive (keepParetoLinks).
import { samplePath, pathTangent, pathErrors, withProgress } from '../../src/world/terrain/ShotPath.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * t * (t * (6 * t - 15) + 10);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function endState(path, end) {
  const n = path.s.length, i = end ? n - 1 : 0;
  const eye = [path.eye[i * 3], path.eye[i * 3 + 1], path.eye[i * 3 + 2]];
  const aim = [path.aim[i * 3], path.aim[i * 3 + 1], path.aim[i * 3 + 2]];
  return { eye, aim, fov: path.fov[i], tangent: pathTangent(path, end) };
}

function slerp(a, b, t) {
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1), w = Math.acos(d);
  if (w < 1e-4) return norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  const sa = Math.sin((1 - t) * w) / Math.sin(w), sb = Math.sin(t * w) / Math.sin(w);
  return [a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb];
}

/** Minimum turning radius of a sampled eye path (horizontal), metres. */
/** Why link variants were rejected, by reason (diagnostics). */
export const linkRejects = Object.create(null);
const reject = (why) => { linkRejects[why] = (linkRejects[why] || 0) + 1; return null; };

export function minTurnRadius(path, stride = 3) {
  let best = Infinity;
  const n = path.s.length, e = path.eye;
  for (let i = stride; i < n - stride; i++) {
    const a = [e[(i - stride) * 3], e[(i - stride) * 3 + 2]], b = [e[i * 3], e[i * 3 + 2]], c = [e[(i + stride) * 3], e[(i + stride) * 3 + 2]];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (area > 1e-6) best = Math.min(best, ab * bc * ac / (2 * area));
  }
  return best;
}

/**
 * One link variant from shot `from` to shot `to`.
 *   kind  'direct' | 'arc' (side +1/-1) | 'high'
 * Returns { kind, path, lengthM } or null when the variant is illegal
 * (too long, too tight, below clearance near an end, degenerate look).
 */
export function buildLink(ctx, from, to, kind, { side = 1, linkMaxM = 9000, transitMaxM = 14000, minRadiusM = 200, radiusM = 400, spacingM = 60 } = {}) {
  const A = endState(from.path, true), B = endState(to.path, false);
  if (!A.tangent || !B.tangent) return reject('no tangent');
  const chord = sub(B.eye, A.eye), D = len(chord);
  // Beyond linkMaxM only a high transit may connect two shots.
  if (D < 120) return reject('too close');
  if (D > transitMaxM || (D > linkMaxM && kind !== 'high')) return reject('too far');
  // A shot that only pans has no travel heading of its own: leave along the chord.
  const heading = (t) => (Math.hypot(t[0], t[2]) > 0.05 ? Math.atan2(t[2], t[0]) : Math.atan2(chord[2], chord[0]));
  const course = dubins([A.eye[0], A.eye[2], heading(A.tangent)], [B.eye[0], B.eye[2], heading(B.tangent)],
    kind === 'arc' && side > 0 ? radiusM * 2.2 : radiusM, { rank: kind === 'arc' && side < 0 ? 1 : 0 });
  if (!course) return reject('no course');
  const ground = sampleCourse(course, Math.max(10, Math.min(spacingM, course.length / 24)));
  // Height: a cubic in course length leaving and arriving at each shot's
  // climb (capped at a 1:2 grade), plus a rise over the terrain for 'high'.
  const grade = (t) => clamp(t[1] / Math.max(1e-6, Math.hypot(t[0], t[2])), -0.5, 0.5);
  const L = course.length, gA = grade(A.tangent) * L, gB = grade(B.tangent) * L;
  const eyes = [], aims = [], fovs = [];
  const dirA = norm(sub(A.aim, A.eye)), dirB = norm(sub(B.aim, B.eye));
  const turn = Math.acos(clamp(dirA[0] * dirB[0] + dirA[1] * dirB[1] + dirA[2] * dirB[2], -1, 1));
  for (const [x, z, , at] of ground) {
    const u = at / L, u2 = u * u, u3 = u2 * u;
    let y = (2 * u3 - 3 * u2 + 1) * A.eye[1] + (u3 - 2 * u2 + u) * gA + (-2 * u3 + 3 * u2) * B.eye[1] + (u3 - u2) * gB;
    if (kind === 'high') y += Math.max(150, 0.12 * D) * Math.sin(Math.PI * u) ** 2;
    const p = [x, y, z];
    eyes.push(p);
    const w = smooth(u);
    fovs.push(A.fov + (B.fov - A.fov) * w);
    // Track the outgoing target, hand over to the incoming one.
    const target = [0, 1, 2].map((k) => A.aim[k] + (B.aim[k] - A.aim[k]) * w);
    const look = sub(target, p);
    if (turn < 2.1 && len(look) > 900) aims.push(target);
    else {
      const d = slerp(dirA, dirB, w), dist = len(sub(A.aim, A.eye)) * (1 - w) + len(sub(B.aim, B.eye)) * w;
      aims.push([p[0] + d[0] * dist, p[1] + d[1] * dist, p[2] + d[2] * dist]);
    }
  }
  // Long transits sample more sparsely: they are gentle curves.
  const sampled = samplePath({ eyes, aims, fovs, spacingM: Math.max(spacingM, Math.min(120, D / 40)), minSamples: 12 });
  if (pathErrors(sampled).length) return reject('degenerate look');
  const path = liftInterior(sampled, ctx.clearance.floorAt);
  if (!path) return reject('clearance at an end');
  const total = path.s[path.s.length - 1];
  // Every sample, the ends included: nothing tighter than the course allows.
  if (minTurnRadius(path, 1) < minRadiusM) return reject('turn too tight');
  // Progress (with aim turn) far beyond the chord means a loop, not a turn.
  if (total > 3 * D + 1500 + 400 * turn) return reject('loop');
  return { kind, path, lengthM: total };
}

const TAU = 2 * Math.PI;
const mod2pi = (x) => x - TAU * Math.floor(x / TAU);

/**
 * Dubins courses from [x, z, heading] to [x, z, heading] in the ground
 * plane (heading = atan2(dz, dx); L turns toward increasing heading) with
 * turn radius R: the shortest (rank 0) or the next shortest (rank 1) of the
 * six families. Returns { start, R, segments: [{ type: 'L'|'S'|'R', m }],
 * length } or null.
 */
export function dubins(start, end, R, { rank = 0 } = {}) {
  const dx = end[0] - start[0], dz = end[1] - start[1], d = Math.hypot(dx, dz) / R;
  const th = mod2pi(Math.atan2(dz, dx)), al = mod2pi(start[2] - th), be = mod2pi(end[2] - th);
  const sa = Math.sin(al), sb = Math.sin(be), ca = Math.cos(al), cb = Math.cos(be), cab = Math.cos(al - be);
  const found = [];
  const add = (types, t, p, q) => { if ([t, p, q].every(Number.isFinite)) found.push({ types, lengths: [t, p, q], total: t + p + q }); };
  { const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb); if (p2 >= 0) { const t1 = Math.atan2(cb - ca, d + sa - sb); add('LSL', mod2pi(-al + t1), Math.sqrt(p2), mod2pi(be - t1)); } }
  { const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa); if (p2 >= 0) { const t1 = Math.atan2(ca - cb, d - sa + sb); add('RSR', mod2pi(al - t1), Math.sqrt(p2), mod2pi(-be + t1)); } }
  { const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb); if (p2 >= 0) { const p = Math.sqrt(p2), t2 = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p); add('LSR', mod2pi(-al + t2), p, mod2pi(-be + t2)); } }
  { const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb); if (p2 >= 0) { const p = Math.sqrt(p2), t2 = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p); add('RSL', mod2pi(al - t2), p, mod2pi(be - t2)); } }
  { const t = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8; if (Math.abs(t) <= 1) { const p = mod2pi(TAU - Math.acos(t)), t1 = mod2pi(al - Math.atan2(ca - cb, d - sa + sb) + p / 2); add('RLR', t1, p, mod2pi(al - be - t1 + p)); } }
  { const t = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8; if (Math.abs(t) <= 1) { const p = mod2pi(TAU - Math.acos(t)), t1 = mod2pi(-al - Math.atan2(ca - cb, d + sa - sb) + p / 2); add('LRL', t1, p, mod2pi(be - al - t1 + p)); } }
  found.sort((x, y) => x.total - y.total || (x.types < y.types ? -1 : 1));
  // Families can coincide (a straight course is both LSL and RSR with no arcs).
  const distinct = found.filter((c, i) => !i || c.total - found[i - 1].total > 1e-6);
  const pick = distinct[rank];
  if (!pick) return null;
  const segments = [...pick.types].map((type, i) => ({ type, m: pick.lengths[i] * R })).filter((g) => g.m > 1e-6);
  return { start, R, segments, length: segments.reduce((t, g) => t + g.m, 0) };
}

/** Points along a course every `step` metres (and its end): [x, z, heading, distance]. */
export function sampleCourse(course, step) {
  const { R } = course, out = [];
  let [x, z, h] = course.start, done = 0;
  const at = (g, m) => {
    if (g.type === 'S') return [x + m * Math.cos(h), z + m * Math.sin(h), h];
    const phi = m / R;
    return g.type === 'L' ? [x + R * (Math.sin(h + phi) - Math.sin(h)), z - R * (Math.cos(h + phi) - Math.cos(h)), h + phi]
      : [x - R * (Math.sin(h - phi) - Math.sin(h)), z + R * (Math.cos(h - phi) - Math.cos(h)), h - phi];
  };
  out.push([x, z, h, 0]);
  for (const g of course.segments) {
    const n = Math.max(1, Math.ceil(g.m / step));
    for (let k = 1; k <= n; k++) { const [px, pz, ph] = at(g, (g.m * k) / n); out.push([px, pz, ph, done + (g.m * k) / n]); }
    [x, z, h] = at(g, g.m); done += g.m;
  }
  return out;
}

/**
 * Raise a link's interior over the clearance floor with a smooth envelope
 * that is locked to zero at both ends (a link's ends are a shot's exact
 * exit and entry). A violation within the locked ends rejects the link.
 */
export function liftInterior(path, floorAt, { lockM = 40, rampM = 360, spreadM = 400, maxLiftM = 800 } = {}) {
  const n = path.s.length, L = path.s[n - 1], need = new Float64Array(n), w = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const f = floorAt(path.eye[i * 3], path.eye[i * 3 + 2]);
    if (!Number.isFinite(f)) return null;
    need[i] = Math.max(0, f - path.eye[i * 3 + 1]);
    const t = clamp((Math.min(path.s[i], L - path.s[i]) - lockM) / rampM, 0, 1);
    w[i] = t * t * (3 - 2 * t);
    if (need[i] > 0) { if (w[i] < 0.02 || need[i] > maxLiftM) return null; any = true; }
  }
  if (!any) return path;
  const lift = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!(need[i] > 0)) continue;
    const want = need[i] / w[i] + 3;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(path.s[j] - path.s[i]);
      if (d < spreadM) lift[j] = Math.max(lift[j], want * 0.5 * (1 + Math.cos(Math.PI * d / spreadM)));
    }
  }
  const eye = Float32Array.from(path.eye);
  for (let i = 0; i < n; i++) eye[i * 3 + 1] += lift[i] * w[i];
  for (let i = 0; i < n; i++) if (eye[i * 3 + 1] < floorAt(eye[i * 3], eye[i * 3 + 2]) - 0.5) return null;
  return withProgress({ ...path, eye });
}

/** Every variant for one ordered pair. */
export function linkVariants(ctx, from, to, opts = {}) {
  // opts.radiusM: discovery.linkRadiusM.
  const out = [];
  for (const [kind, side] of [['direct', 1], ['arc', 1], ['arc', -1], ['high', 1]]) {
    const link = buildLink(ctx, from, to, kind, { ...opts, side });
    if (link) out.push({ ...link, side });
  }
  return out;
}

/**
 * Keep the alternatives worth keeping for one ordered pair: the
 * non-dominated set over (shorter length, higher score), at most `max`.
 * Ties break by kind order so the result is deterministic.
 */
export function keepParetoLinks(variants, max = 2) {
  const order = { direct: 0, arc: 1, high: 2, low: 3 };
  const sorted = [...variants].sort((a, b) => a.lengthM - b.lengthM || order[a.kind] - order[b.kind] || (a.side || 0) - (b.side || 0));
  const kept = [];
  let bestScore = -Infinity;
  for (const v of sorted) if (v.score.total > bestScore + 1e-6) { kept.push(v); bestScore = v.score.total; }
  // Keep the shortest and the best always; fill with the rest of the front.
  return kept.length <= max ? kept : [kept[0], ...kept.slice(1).sort((a, b) => b.score.total - a.score.total).slice(0, max - 1)];
}
