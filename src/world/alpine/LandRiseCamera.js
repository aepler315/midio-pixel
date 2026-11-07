import { clamp01 } from '../../utils/math.js';
import { projectPoint } from '../terrain/SceneTravel.js';

export const BUILD_CAMERA = Object.freeze({ settleRise: .7, distanceScale: 3,
  maxPullbackM: 30000, maxOverviewDistanceM: 90000, craneScale: .75, maxCraneM: 22500 });
const mix = (a, b, t) => a + (b - a) * t;
const overviewAt = rise => {
  const u = clamp01(rise / BUILD_CAMERA.settleRise);
  return 1 - u * u * (3 - 2 * u);
};
const focusAt = (pose, focusM) => Array.isArray(focusM) && focusM.length === 3 && focusM.every(Number.isFinite)
  ? focusM : pose.targetM;

function overviewGeometry(pose, focusM) {
  const focus = focusAt(pose, focusM);
  const dx = pose.eyeM[0] - focus[0], dz = pose.eyeM[2] - focus[2], distance = Math.hypot(dx, dz);
  const pullback = Math.min((BUILD_CAMERA.distanceScale - 1) * distance, BUILD_CAMERA.maxPullbackM,
    Math.max(0, BUILD_CAMERA.maxOverviewDistanceM - distance));
  return { focus, x: distance > 0 ? dx / distance * pullback : 0,
    z: distance > 0 ? dz / distance * pullback : 0,
    crane: Math.min(BUILD_CAMERA.maxCraneM, distance * BUILD_CAMERA.craneScale) };
}

function keepFocusFramed(pose, eyeM, targetM, focus, rise, aspect) {
  if (!Number.isFinite(pose.fovYDeg)) return targetM;
  const u = clamp01((rise - BUILD_CAMERA.settleRise) / (1 - BUILD_CAMERA.settleRise));
  const limit = .72 + .28 * u * u * (3 - 2 * u);
  const fits = target => {
    const p = projectPoint({ ...pose, eyeM, targetM: target }, aspect, focus);
    return !!p && Math.abs(p.x) <= limit && Math.abs(p.y) <= limit;
  };
  if (fits(targetM)) return targetM;
  // Retain only the smallest correction needed for this growing source
  // summit. A nearby top can otherwise fall below the eye long before the
  // terrain reaches its original height, despite being framed at full rise.
  let lo = 0, hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2, candidate = targetM.map((v, k) => mix(v, focus[k], mid));
    if (fits(candidate)) hi = mid; else lo = mid;
  }
  return targetM.map((v, k) => mix(v, focus[k], hi));
}

/** One source-space floor for both cameras and every render pass. */
export function landRiseBase(prepared) {
  const rail = prepared?.modeWater?.rail;
  const water = rail ? rail.waterLevelM : prepared?.waterLevelM;
  if (Number.isFinite(water)) return water;
  const floor = prepared?.data?.manifest?.boundsM?.min?.[1]
    ?? rail?.heightRange?.[0] ?? prepared?.uniforms?.uHeightRange?.value?.x;
  return Number.isFinite(floor) ? floor : 0;
}

/** Open over the future range, then approach its authored composition as
 * relief builds. The source summit/action follows the same vertical map as
 * terrain; the overview is a pure function of rise, including on a seek.
 * Missing source ground keeps the authored height before the overview lift. */
export function landRiseCamera(pose, { rise01 = 1, baseM = 0, groundM = NaN, focusM = null,
  groundAt = null, aspect = 16 / 9, overview = !pose.tour } = {}) {
  const rise = Number.isFinite(rise01) ? clamp01(rise01) : 1;
  if (rise === 1) return pose;
  const ground = Number.isFinite(groundM) ? groundM : baseM;
  const clearance = Math.max(2, pose.eyeM[1] - ground);
  const eyeM = [...pose.eyeM], targetM = [...pose.targetM];
  eyeM[1] = rise * pose.eyeM[1] + (1 - rise) * (baseM + clearance);
  targetM[1] = baseM + rise * (targetM[1] - baseM);
  // Windowed tours own a pre-admitted movement corridor. Static packages
  // may opt into the overview while following a generated shot's action.
  if (!overview) return { ...pose, eyeM, targetM };
  const weight = overviewAt(rise), g = overviewGeometry(pose, focusM);
  eyeM[0] += g.x * weight;
  eyeM[1] += g.crane * weight;
  eyeM[2] += g.z * weight;
  if (weight > 0 && typeof groundAt === 'function') {
    const movedGround = groundAt(eyeM[0], eyeM[2]);
    if (Number.isFinite(movedGround)) eyeM[1] = Math.max(eyeM[1], baseM + rise * (movedGround - baseM) + clearance);
  }
  targetM[0] = mix(targetM[0], g.focus[0], weight);
  targetM[1] = mix(targetM[1], baseM + rise * (g.focus[1] - baseM), weight);
  targetM[2] = mix(targetM[2], g.focus[2], weight);
  const drawnFocus = [g.focus[0], baseM + rise * (g.focus[1] - baseM), g.focus[2]];
  return { ...pose, eyeM, targetM: keepFocusFramed(pose, eyeM, targetM, drawnFocus, rise, aspect) };
}
