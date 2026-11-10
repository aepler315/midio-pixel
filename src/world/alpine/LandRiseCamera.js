import { clamp01 } from '../../utils/math.js';
import { projectPoint } from '../terrain/SceneTravel.js';
import { openingZoomRelease01 } from '../../core/OpeningTimeline.js';

export const BUILD_CAMERA = Object.freeze({ settleRise: .7, openingMagnification: 24 });
const mix = (a, b, t) => a + (b - a) * t;
const overviewAt = rise => {
  const u = clamp01(rise / BUILD_CAMERA.settleRise);
  return 1 - u * u * (3 - 2 * u);
};
const focusAt = (pose, focusM) => Array.isArray(focusM) && focusM.length === 3 && focusM.every(Number.isFinite)
  ? focusM : pose.targetM;

/** Tight opening lens, widening smoothly to the authored lens as relief grows,
 * and in any case by the end of the opening (`timeMs`, heard song time;
 * OpeningTimeline.openingZoomRelease01) while the land keeps building.
 * Crop in half-angle space so magnification is independent of the base lens. */
export function landRiseFov(fovYDeg, rise01 = 1, timeMs = NaN) {
  const rise = Number.isFinite(rise01) ? clamp01(rise01) : 1;
  const weight = overviewAt(rise), release = openingZoomRelease01(timeMs);
  if (!weight || release >= 1 || !Number.isFinite(fovYDeg)) return fovYDeg;
  const excess = (BUILD_CAMERA.openingMagnification - 1) * weight;
  // Vertical mesh error contracts with rise. Smoothly limit the extra
  // magnification so rise * magnification <= 1 throughout the opening.
  const ratio = excess * rise / (1 - rise);
  // The opening clock eases the terrain-safe close-up out evenly.
  const magnification = 1 + excess / Math.hypot(1, ratio) * (1 - release);
  return 360 / Math.PI * Math.atan(Math.tan(fovYDeg * Math.PI / 360) / magnification);
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

/** Open close to the future range, then widen to its authored composition as
 * relief builds. The source summit/action follows the same vertical map as
 * terrain; framing is a pure function of rise, including on a seek.
 * Missing source ground keeps the authored height. */
export function landRiseCamera(pose, { rise01 = 1, baseM = 0, groundM = NaN, focusM = null,
  aspect = 16 / 9, overview = !pose.tour, timeMs = NaN } = {}) {
  const rise = Number.isFinite(rise01) ? clamp01(rise01) : 1;
  if (rise === 1) return pose;
  const ground = Number.isFinite(groundM) ? groundM : baseM;
  const clearance = Math.max(2, pose.eyeM[1] - ground);
  const eyeM = [...pose.eyeM], targetM = [...pose.targetM];
  eyeM[1] = rise * pose.eyeM[1] + (1 - rise) * (baseM + clearance);
  targetM[1] = baseM + rise * (targetM[1] - baseM);
  // Windowed tours own their moving aim. Static packages may follow their
  // source summit instead. Both keep the admitted horizontal eye position.
  if (!overview) return { ...pose, eyeM, targetM };
  const weight = overviewAt(rise) * (1 - openingZoomRelease01(timeMs)), focus = focusAt(pose, focusM);
  targetM[0] = mix(targetM[0], focus[0], weight);
  targetM[1] = mix(targetM[1], baseM + rise * (focus[1] - baseM), weight);
  targetM[2] = mix(targetM[2], focus[2], weight);
  const drawnFocus = [focus[0], baseM + rise * (focus[1] - baseM), focus[2]];
  return { ...pose, eyeM, targetM: keepFocusFramed(pose, eyeM, targetM, drawnFocus, rise, aspect) };
}
