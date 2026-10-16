// Range v2: where a curated scenic view's camera is, as a pure function of
// heard time. Two pieces, both stateless:
//
//   sceneProgressAt()  heard time -> progress 0..1 along the view's rail. A
//                      thin adapter over ProfileTravel's finite, music-driven
//                      travel (the same start station, energy-integral rate
//                      and fit-to-length the scanned skylines use), read on a
//                      canonical 8192px strip with a 1280px reference window.
//                      No frame-to-frame accumulation: seeking, pausing and
//                      redrawing land on the same place by construction.
//   cameraPoseAt()     progress -> a perspective camera pose on the view's
//                      straight rail. Screen size, DPR and quality never enter
//                      it; aspect-ratio framing is a projection concern.
//
// Local scene axes: X east, Y up, Z south, metres (plan §7.1).
import { terrainScrollPx } from './ProfileTravel.js';

export const SCENE_STRIP_WIDTH = 8192;
export const SCENE_REFERENCE_WINDOW = 1280;
export const SCENE_ROOM = SCENE_STRIP_WIDTH - SCENE_REFERENCE_WINDOW; // 6912
export const SCENE_PREVIEW_PROGRESS = 0.5;
export const FOV_MIN_DEG = 5;
export const FOV_MAX_DEG = 120;

/** One pose provider for heard-time tours and ordinary authored rails. */
export function scenePoseAt(view, { progress01 = .5, timeMs = null, tour = view?.tour } = {}) {
  return tour ? tour.poseAt(timeMs ?? progress01 * tour.durationMs) : cameraPoseAt(view, progress01);
}
export function pathStations(view, count = 32, tour = view?.tour) {
  return Array.from({ length: count }, (_, i) => scenePoseAt(view, { progress01: count > 1 ? i / (count - 1) : .5, tour }));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/**
 * Progress 0..1 along a view's rail at heard time `timeMs`.
 * A zero or unknown duration is a preview: the rail's midpoint, matching the
 * scanned skylines' midpoint preview station.
 */
export function sceneProgressAt({ timeMs = 0, curves = null, durationMs = 0, reducedFlash = false, response = null } = {}) {
  const dur = Number(durationMs) || 0;
  if (!(dur > 0)) return SCENE_PREVIEW_PROGRESS;
  const tSec = Math.max(0, Number(timeMs) || 0) / 1000;
  const scrollPx = terrainScrollPx({
    tSec, curves, durationMs: dur, stripWidth: SCENE_STRIP_WIDTH, reducedFlash, response,
    depth: 1, fit: { viewWidth: SCENE_REFERENCE_WINDOW, maxDepth: 1 },
  });
  return clamp01(scrollPx / SCENE_ROOM);
}

/** Validate a view's camera rail. Returns a list of problems (empty = ok). */
export function cameraRailErrors(camera) {
  const errors = [];
  if (!camera || typeof camera !== 'object') return ['camera missing'];
  for (const k of ['eyeStartM', 'eyeEndM', 'targetStartM', 'targetEndM']) {
    if (!isVec3(camera[k])) errors.push(`camera.${k} must be three finite numbers`);
  }
  for (const k of ['eyeArcM', 'targetArcM']) {
    if (camera[k] != null && !isVec3(camera[k])) errors.push(`camera.${k} must be three finite metre offsets`);
  }
  const fov = camera.fovYDeg;
  if (!(Number.isFinite(fov) && fov >= FOV_MIN_DEG && fov <= FOV_MAX_DEG)) {
    errors.push(`camera.fovYDeg must be within ${FOV_MIN_DEG}..${FOV_MAX_DEG}`);
  }
  if (errors.length) return errors;
  for (const [eye, target, name] of [[camera.eyeStartM, camera.targetStartM, 'start'], [camera.eyeEndM, camera.targetEndM, 'end']]) {
    const d = sub(target, eye);
    const len = Math.hypot(...d);
    if (!(len > 1)) errors.push(`camera ${name} eye and target coincide`);
    else if (Math.abs(d[1] / len) > 0.98) errors.push(`camera ${name} looks straight up or down`);
  }
  if (errors.length) return errors;
  // The look vector d(u) = target(u) - eye(u) is linear in u, so two valid
  // endpoints can still pass through a degenerate pose in between (e.g.
  // opposite look directions meet at a zero vector). Check the rail's
  // minimum over the whole segment, not only its ends.
  const d0 = sub(camera.targetStartM, camera.eyeStartM), d1 = sub(camera.targetEndM, camera.eyeEndM);
  const deltaArc = sub(camera.targetArcM || [0, 0, 0], camera.eyeArcM || [0, 0, 0]);
  const at = u => sub(railPoint(camera.targetStartM, camera.targetEndM, camera.targetArcM, u),
    railPoint(camera.eyeStartM, camera.eyeEndM, camera.eyeArcM, u));
  const closest = (dims) => {
    const dd = dims.map((k) => d1[k] - d0[k]);
    const den = dd.reduce((acc, v) => acc + v * v, 0);
    return den > 0 ? clamp01(-dims.reduce((acc, k, i) => acc + d0[k] * dd[i], 0) / den) : 0;
  };
  const probes = [closest([0, 1, 2]), closest([0, 2])];
  // Curves can collapse between the regular stations. Their look vector
  // is quadratic; test the extrema of both length and verticality exactly.
  const coeff = d0.map((v, k) => [v, d1[k] - v + 4 * deltaArc[k], -4 * deltaArc[k]]);
  const lengthSq = squaredPolynomial(coeff), horizontalSq = squaredPolynomial([coeff[0], coeff[2]]);
  probes.push(...roots01(derivative(lengthSq)), ...roots01(derivative(horizontalSq)),
    ...roots01(polySubtract(polyProduct(derivative(horizontalSq), lengthSq), polyProduct(horizontalSq, derivative(lengthSq)))));
  for (let k = 0; k <= 64; k++) probes.push(k / 64);
  for (const u of probes) {
    const d = at(u);
    const len = Math.hypot(...d);
    if (!(len > 1)) { errors.push(`camera eye and target coincide at rail ${u.toFixed(3)}`); break; }
    if (Math.abs(d[1] / len) > 0.98) { errors.push(`camera looks straight up or down at rail ${u.toFixed(3)}`); break; }
  }
  return errors;
}

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const railPoint = (a, b, arc, u) => lerp3(a, b, u).map((v, i) => v + (arc?.[i] || 0) * 4 * u * (1 - u));
const derivative = p => p.slice(1).map((v, i) => v * (i + 1));
const polyAt = (p, u) => p.reduceRight((s, v) => s * u + v, 0);
function polyProduct(a, b) {
  const p = new Array(a.length + b.length - 1).fill(0);
  a.forEach((v, i) => b.forEach((w, j) => { p[i + j] += v * w; }));
  return p;
}
const polySubtract = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] || 0) - (b[i] || 0));
function squaredPolynomial(vectors) {
  const p = [0, 0, 0, 0, 0];
  for (const v of vectors) polyProduct(v, v).forEach((x, i) => { p[i] += x; });
  return p;
}
function roots01(coefficients) {
  const p = [...coefficients];
  const scale = Math.max(1, ...p.map(Math.abs));
  while (p.length > 1 && Math.abs(p.at(-1)) < scale * 1e-13) p.pop();
  if (p.length < 2) return [];
  if (p.length === 2) { const u = -p[0] / p[1]; return u > 0 && u < 1 ? [u] : []; }
  const splits = [0, ...roots01(derivative(p)), 1].sort((a, b) => a - b), roots = [];
  for (const u of splits) if (Math.abs(polyAt(p, u)) < scale * 1e-11) roots.push(u);
  for (let i = 1; i < splits.length; i++) {
    let a = splits[i - 1], b = splits[i], fa = polyAt(p, a);
    if (fa * polyAt(p, b) >= 0) continue;
    for (let k = 0; k < 50; k++) {
      const mid = (a + b) / 2, fm = polyAt(p, mid);
      if (fa * fm <= 0) b = mid; else { a = mid; fa = fm; }
    }
    roots.push((a + b) / 2);
  }
  return roots;
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The camera pose at rail progress `progress01` (clamped): eye and target
 *  interpolated between the authored endpoints, world-up kept. Throws on an
 *  invalid rail rather than returning a degenerate camera. */
export function cameraPoseAt(view, progress01) {
  const camera = view?.camera;
  const errors = cameraRailErrors(camera);
  if (errors.length) throw new Error(`invalid camera rail for ${view?.id ?? 'view'}: ${errors.join('; ')}`);
  const u = clamp01(Number.isFinite(progress01) ? progress01 : 0);
  return {
    eyeM: railPoint(camera.eyeStartM, camera.eyeEndM, camera.eyeArcM, u),
    targetM: railPoint(camera.targetStartM, camera.targetEndM, camera.targetArcM, u),
    fovYDeg: camera.fovYDeg,
  };
}

/** Orthonormal camera basis: forward, right, up (world-up kept). */
export function cameraBasis(pose) {
  const forward = norm(sub(pose.targetM, pose.eyeM));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { forward, right, up };
}

/**
 * Project a local point for a pose at aspect `aspect` (width/height).
 * Returns { x, y } in normalized device coordinates (-1..1, y up) and the
 * view depth `depth` (metres along forward), or null behind the eye.
 * `fovScale` widens the frustum (pull-back/overscan), 1 = the view's own.
 */
export function projectPoint(pose, aspect, point, fovScale = 1) {
  const { forward, right, up } = cameraBasis(pose);
  const d = sub(point, pose.eyeM);
  const depth = dot(d, forward);
  if (!(depth > 1e-6)) return null;
  const t = Math.tan((pose.fovYDeg * Math.PI) / 360) * fovScale;
  return { x: dot(d, right) / (depth * t * aspect), y: dot(d, up) / (depth * t), depth };
}

/** Pixels per metre of vertical offset at `depth` for a viewport `heightPx`. */
export function focalPx(fovYDeg, heightPx) {
  return heightPx / (2 * Math.tan((fovYDeg * Math.PI) / 360));
}

/** Whether an axis-aligned box {min:[x,y,z], max:[x,y,z]} can appear in the
 *  pose's frustum at `aspect` widened by `fovScale`. Conservative: tests the
 *  box against the four side planes and the near plane. */
export function boxMayBeVisible(pose, aspect, box, fovScale = 1) {
  const { forward, right, up } = cameraBasis(pose);
  const t = Math.tan((pose.fovYDeg * Math.PI) / 360) * fovScale;
  const tx = t * aspect;
  // Plane normals pointing into the volume: the near plane (forward) and
  // the four sides, n = forward * tan -/+ axis.
  const side = (axis, tan, sign) => norm([
    forward[0] * tan - sign * axis[0], forward[1] * tan - sign * axis[1], forward[2] * tan - sign * axis[2],
  ]);
  const planes = [forward, side(right, tx, 1), side(right, tx, -1), side(up, t, 1), side(up, t, -1)];
  for (const n of planes) {
    // The box corner furthest along n must be on the inside.
    const p = [n[0] >= 0 ? box.max[0] : box.min[0], n[1] >= 0 ? box.max[1] : box.min[1], n[2] >= 0 ? box.max[2] : box.min[2]];
    if (dot(n, sub(p, pose.eyeM)) < 0) return false;
  }
  return true;
}

/** Shortest distance from the eye to a box. */
/** Smallest view-space depth (metres along the pose's forward axis) of any
 *  point of an axis-aligned box. Projected size scales with 1/depth, not
 *  1/distance, so this -- not the Euclidean distance, which exceeds it for
 *  off-axis terrain -- bounds a tile's on-screen error. The minimum of a
 *  linear function over a box is at a corner. */
export function viewDepthToBox(pose, box) {
  const { forward } = cameraBasis(pose);
  let best = Infinity;
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    best = Math.min(best, (x - pose.eyeM[0]) * forward[0] + (y - pose.eyeM[1]) * forward[1] + (z - pose.eyeM[2]) * forward[2]);
  }
  return best;
}

export function distanceToBox(eye, box) {
  const dx = Math.max(box.min[0] - eye[0], 0, eye[0] - box.max[0]);
  const dy = Math.max(box.min[1] - eye[1], 0, eye[1] - box.max[1]);
  const dz = Math.max(box.min[2] - eye[2], 0, eye[2] - box.max[2]);
  return Math.hypot(dx, dy, dz);
}
