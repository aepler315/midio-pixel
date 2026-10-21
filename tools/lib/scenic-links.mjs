// Scenic shot tours: connecting moves between shots (docs/scenic-tours.md).
//
// A link leaves one shot exactly where it ends -- eye, travel direction,
// look target and field of view -- and arrives exactly where another
// begins. The eye follows a cubic Hermite curve whose end tangents are the
// shots' own; variants bend it sideways (arc) or over the terrain (high).
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
export function buildLink(ctx, from, to, kind, { side = 1, linkMaxM = 9000, transitMaxM = 14000, minRadiusM = 200, spacingM = 40 } = {}) {
  const A = endState(from.path, true), B = endState(to.path, false);
  if (!A.tangent || !B.tangent) return reject('no tangent');
  const chord = sub(B.eye, A.eye), D = len(chord);
  // Beyond linkMaxM only a high transit may connect two shots.
  if (D < 120) return reject('too close');
  if (D > transitMaxM || (D > linkMaxM && kind !== 'high')) return reject('too far');
  const m = clamp(D * 0.9, 150, 4000);
  const lateral = norm([-chord[2], 0, chord[0]]);
  const n = Math.max(12, Math.ceil(D / 60));
  const eyes = [], aims = [], fovs = [];
  const dirA = norm(sub(A.aim, A.eye)), dirB = norm(sub(B.aim, B.eye));
  const turn = Math.acos(clamp(dirA[0] * dirB[0] + dirA[1] * dirB[1] + dirA[2] * dirB[2], -1, 1));
  for (let i = 0; i <= n; i++) {
    const u = i / n, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const p = [0, 1, 2].map((k) => h00 * A.eye[k] + h10 * m * A.tangent[k] + h01 * B.eye[k] + h11 * m * B.tangent[k]);
    const bump = Math.sin(Math.PI * u) ** 2;
    if (kind === 'arc') for (let k = 0; k < 3; k++) p[k] += lateral[k] * side * 0.22 * D * bump;
    if (kind === 'high') p[1] += Math.max(150, 0.12 * D) * bump;
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
  const sampled = samplePath({ eyes, aims, fovs, spacingM, minSamples: 12 });
  if (pathErrors(sampled).length) return reject('degenerate look');
  const path = liftInterior(sampled, ctx.clearance.floorAt);
  if (!path) return reject('clearance at an end');
  const total = path.s[path.s.length - 1];
  if (minTurnRadius(path) < minRadiusM) return reject('turn too tight');
  // Progress (with aim turn) far beyond the chord means a loop, not a turn.
  if (total > 3 * D + 1500 + 400 * turn) return reject('loop');
  return { kind, path, lengthM: total };
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
