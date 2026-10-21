// Scenic shot tours: the one geometry both the offline authoring tools and
// the runtime use, so playback reconstructs exactly the camera paths that
// were validated against packaged terrain.
//
// A path (a shot or a link between shots) is a dense, ordered list of camera
// samples -- eye, aim point, vertical field of view -- with a cumulative
// "progress" coordinate s. Progress is metres travelled by the eye plus
// AIM_PROGRESS_M metres per radian the aim direction turns, so a shot whose
// eye barely moves while it pans still has length, and a timeline can drive
// every path with one monotone s(t). Between samples, eye, aim and field of
// view follow a uniform Catmull-Rom spline in s (C1), never a polyline.
//
// Local scene axes: X east, Y up, Z south, metres (SceneTravel).

/** Metres of progress per radian of aim rotation. */
export const AIM_PROGRESS_M = 400;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Angle (radians) between the look directions of two samples. */
export function aimTurn(eyeA, aimA, eyeB, aimB) {
  const a = sub(aimA, eyeA), b = sub(aimB, eyeB);
  const la = len(a), lb = len(b);
  if (!(la > 0 && lb > 0)) return 0;
  return Math.acos(clamp((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb), -1, 1));
}

/** Cumulative progress for arrays of eye/aim points. */
export function progressOf(eyes, aims) {
  const s = new Float64Array(eyes.length);
  for (let i = 1; i < eyes.length; i++) {
    s[i] = s[i - 1] + Math.hypot(len(sub(eyes[i], eyes[i - 1])), AIM_PROGRESS_M * aimTurn(eyes[i - 1], aims[i - 1], eyes[i], aims[i]));
  }
  return s;
}

// Centripetal Catmull-Rom through control points (authoring only): the
// sampled result is what ships and what the runtime interpolates.
function centripetal(p0, p1, p2, p3, t) {
  const tj = (a, b) => Math.max(1e-6, Math.sqrt(len(sub(b, a))));
  const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb) => a.map((v, k) => (tb - u) / (tb - ta) * v + (u - ta) / (tb - ta) * b[k]);
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** Point at t in [0, n-1] on the centripetal spline through `points`
 *  (ends extended by reflection, so the curve starts and stops on them). */
export function splineAt(points, t) {
  const n = points.length;
  if (n === 1) return [...points[0]];
  const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
  const p1 = points[i], p2 = points[i + 1];
  const p0 = i > 0 ? points[i - 1] : p1.map((v, k) => 2 * v - p2[k]);
  const p3 = i + 2 < n ? points[i + 2] : p2.map((v, k) => 2 * v - p1[k]);
  return centripetal(p0, p1, p2, p3, clamp(t - i, 0, 1));
}

/**
 * Sample a path from control points (authoring). `eyes`, `aims` are arrays
 * of [x, y, z]; `fovs` an array of degrees (or one number); all the same
 * length. Returns { eye, aim, fov, s } typed arrays with roughly one sample
 * per `spacingM` of progress (at least `minSamples`).
 */
export function samplePath({ eyes, aims, fovs, spacingM = 25, minSamples = 8 }) {
  const n = eyes.length;
  if (n < 2 || aims.length !== n) throw new Error('path needs matching eye and aim control points');
  const fovList = Array.isArray(fovs) ? fovs : Array(n).fill(fovs);
  // Fine pass to measure progress, then resample uniformly in progress.
  const fine = Math.max(64, (n - 1) * 48);
  const fe = [], fa = [], ff = [];
  for (let k = 0; k <= fine; k++) {
    const t = (k / fine) * (n - 1);
    fe.push(splineAt(eyes, t));
    fa.push(splineAt(aims, t));
    ff.push(splineAt(fovList.map((v) => [v, 0, 0]), t)[0]);
  }
  const fs = progressOf(fe, fa), total = fs[fine];
  const count = Math.max(minSamples, Math.ceil(total / spacingM) + 1);
  const eye = new Float32Array(count * 3), aim = new Float32Array(count * 3), fov = new Float32Array(count), s = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (j < fine - 1 && fs[j + 1] < target) j++;
    const u = fs[j + 1] > fs[j] ? clamp((target - fs[j]) / (fs[j + 1] - fs[j]), 0, 1) : 0;
    for (let k = 0; k < 3; k++) {
      eye[i * 3 + k] = fe[j][k] + (fe[j + 1][k] - fe[j][k]) * u;
      aim[i * 3 + k] = fa[j][k] + (fa[j + 1][k] - fa[j][k]) * u;
    }
    fov[i] = ff[j] + (ff[j + 1] - ff[j]) * u;
    s[i] = target;
  }
  return { eye, aim, fov, s, lengthM: total };
}

/** Errors in a sampled path (empty = usable). */
export function pathErrors(path, { minFov = 5, maxFov = 120 } = {}) {
  const errors = [];
  const n = path?.s?.length;
  if (!(n >= 2) || path.eye?.length !== n * 3 || path.aim?.length !== n * 3 || path.fov?.length !== n) return ['path arrays'];
  for (let i = 0; i < n; i++) {
    if (![path.eye[i * 3], path.eye[i * 3 + 1], path.eye[i * 3 + 2], path.aim[i * 3], path.aim[i * 3 + 1], path.aim[i * 3 + 2], path.fov[i], path.s[i]].every(Number.isFinite)) { errors.push('nonfinite sample'); break; }
    if (i && !(path.s[i] > path.s[i - 1])) { errors.push('progress not increasing'); break; }
    if (!(path.fov[i] >= minFov && path.fov[i] <= maxFov)) { errors.push('fov range'); break; }
    const d = [path.aim[i * 3] - path.eye[i * 3], path.aim[i * 3 + 1] - path.eye[i * 3 + 1], path.aim[i * 3 + 2] - path.eye[i * 3 + 2]];
    const l = len(d);
    if (!(l > 1)) { errors.push('eye and aim coincide'); break; }
    if (Math.abs(d[1] / l) > 0.98) { errors.push('looks straight up or down'); break; }
  }
  return errors;
}

function catmull(a, b, c, d, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (3 * b - a - 3 * c + d) * u3);
}

/** Index i with s[i] <= x < s[i+1] (clamped). */
function segmentOf(s, x) {
  let lo = 0, hi = s.length - 1;
  if (x <= s[0]) return 0;
  if (x >= s[hi]) return hi - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid] <= x) lo = mid; else hi = mid; }
  return lo;
}

/**
 * Camera pose at progress `x` along a sampled path: uniform Catmull-Rom
 * between neighbouring samples (C1 in s). Returns { eyeM, targetM, fovYDeg }.
 * Paths are sampled near-uniformly in progress, so the uniform spline's
 * parameter matches progress closely; the fraction is still measured
 * locally, so uneven spacing cannot reverse motion.
 */
export function pathPoseAt(path, x) {
  const { eye, aim, fov, s } = path, n = s.length;
  const xs = clamp(x, s[0], s[n - 1]);
  const i = segmentOf(s, xs);
  const u = s[i + 1] > s[i] ? clamp((xs - s[i]) / (s[i + 1] - s[i]), 0, 1) : 0;
  const ia = Math.max(0, i - 1), ib = i, ic = i + 1, id = Math.min(n - 1, i + 2);
  const pick = (arr, k, stride) => {
    const a = arr[ia * stride + k], b = arr[ib * stride + k], c = arr[ic * stride + k], d = arr[id * stride + k];
    // Reflect at the ends so the spline does not overshoot the first/last sample.
    return catmull(ia === ib ? 2 * b - c : a, b, c, id === ic ? 2 * c - b : d, u);
  };
  return {
    eyeM: [pick(eye, 0, 3), pick(eye, 1, 3), pick(eye, 2, 3)],
    targetM: [pick(aim, 0, 3), pick(aim, 1, 3), pick(aim, 2, 3)],
    fovYDeg: clamp(pick(fov, 0, 1), Math.min(fov[ib], fov[ic]) - 2, Math.max(fov[ib], fov[ic]) + 2),
  };
}

/** Linear interpolation of a per-sample scalar lane (e.g. optical flow per
 *  unit speed) at progress x. */
export function pathLaneAt(path, lane, x) {
  const { s } = path, n = s.length, xs = clamp(x, s[0], s[n - 1]), i = segmentOf(s, xs);
  const u = s[i + 1] > s[i] ? (xs - s[i]) / (s[i + 1] - s[i]) : 0;
  return lane[i] + (lane[i + 1] - lane[i]) * u;
}

/** Unit look direction of a pose. */
export function lookDir(pose) {
  const d = sub(pose.targetM, pose.eyeM), l = len(d) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** Heading (degrees clockwise from north, -Z) and pitch (degrees up) of a
 *  direction vector. */
export function headingPitch(d) {
  return { headingDeg: Math.atan2(d[0], -d[2]) * 180 / Math.PI, pitchDeg: Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI };
}

/** Eye velocity direction at the start (`end`=false) or end of a path. */
export function pathTangent(path, end = false) {
  const n = path.s.length, i = end ? n - 2 : 0;
  const d = [path.eye[(i + 1) * 3] - path.eye[i * 3], path.eye[(i + 1) * 3 + 1] - path.eye[i * 3 + 1], path.eye[(i + 1) * 3 + 2] - path.eye[i * 3 + 2]];
  const l = len(d);
  return l > 1e-6 ? d.map((v) => v / l) : null;
}

/** Sub-path between progress a and b, resampled at the original density;
 *  progress restarts at 0. */
export function slicePath(path, a, b) {
  const n = path.s.length, total = path.s[n - 1];
  const lo = clamp(Math.min(a, b), 0, total), hi = clamp(Math.max(a, b), 0, total);
  const count = Math.max(2, Math.ceil((hi - lo) / Math.max(1e-6, total / Math.max(1, n - 1))) + 1);
  const out = { eye: new Float32Array(count * 3), aim: new Float32Array(count * 3), fov: new Float32Array(count), s: new Float32Array(count) };
  for (let i = 0; i < count; i++) {
    const x = lo + (hi - lo) * (i / (count - 1)), p = pathPoseAt(path, x);
    out.eye.set(p.eyeM, i * 3); out.aim.set(p.targetM, i * 3); out.fov[i] = p.fovYDeg; out.s[i] = x - lo;
  }
  return out;
}
