import { clamp01 } from '../../utils/math.js';

/** One source-space floor for both cameras and every render pass. */
export function landRiseBase(prepared) {
  const rail = prepared?.modeWater?.rail;
  const water = rail ? rail.waterLevelM : prepared?.waterLevelM;
  if (Number.isFinite(water)) return water;
  const floor = prepared?.data?.manifest?.boundsM?.min?.[1]
    ?? rail?.heightRange?.[0] ?? prepared?.uniforms?.uHeightRange?.value?.x;
  return Number.isFinite(floor) ? floor : 0;
}

/** Follow the growing ground while keeping the authored camera clearance.
 * Missing source ground (a camera outside the bake) keeps its original height. */
export function landRiseCamera(pose, { rise01 = 1, baseM = 0, groundM = NaN } = {}) {
  const rise = Number.isFinite(rise01) ? clamp01(rise01) : 1;
  if (rise === 1) return pose;
  const ground = Number.isFinite(groundM) ? groundM : baseM;
  const clearance = Math.max(2, pose.eyeM[1] - ground);
  const eyeM = [...pose.eyeM], targetM = [...pose.targetM];
  eyeM[1] = rise * pose.eyeM[1] + (1 - rise) * (baseM + clearance);
  targetM[1] = baseM + rise * (targetM[1] - baseM);
  return { ...pose, eyeM, targetM };
}
