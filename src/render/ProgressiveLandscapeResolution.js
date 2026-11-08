import { PIXEL_GRIDS, runtimePixelGrid } from './PixelRenderPolicy.js';

export const LANDSCAPE_DETAIL_RUNGS = 24;
function resolutionBounds({ width, height, scaling = 'fit' } = {}) {
  const w = Number.isFinite(width) && width > 0 ? width : 320;
  const h = Number.isFinite(height) && height > 0 ? height : 180;
  const fit = (scaling === 'cover' ? Math.max : Math.min)(w / 320, h / 180);
  const scale = Math.max(1, Math.min(fit, PIXEL_GRIDS.detailed.width / 320));
  const endpoint = { width: Math.ceil(320 * scale), height: Math.ceil(180 * scale) };
  return { scale, endpoint };
}
/** Output backing changes above the fitted endpoint share one native plan. */
export function landscapeResolutionEndpoint(options = {}) {
  return resolutionBounds(options).endpoint;
}
/** Fixed aspect; fit/cover resolves the picture up to Detailed. Cache this per
 * fitted endpoint, not per frame. Bound dimensions before allocation. */
export function landscapeResolutionPlan(options = {}) {
  const { scale, endpoint } = resolutionBounds(options);
  const grids = [];
  for (let i = 0; i <= LANDSCAPE_DETAIL_RUNGS; i++) {
    const k = scale ** (i / LANDSCAPE_DETAIL_RUNGS);
    const rw = i === LANDSCAPE_DETAIL_RUNGS ? endpoint.width : Math.round(320 * k);
    const rh = i === LANDSCAPE_DETAIL_RUNGS ? endpoint.height : Math.round(180 * k);
    const prior = grids.at(-1);
    grids.push(prior?.width === rw && prior?.height === rh ? prior : runtimePixelGrid(rw, rh));
  }
  return Object.freeze({ grids: Object.freeze(grids), endpoint: Object.freeze(endpoint), maxRung: LANDSCAPE_DETAIL_RUNGS });
}
export function landscapeResolutionAt(plan, rise01) {
  const progress = Number.isFinite(rise01) ? Math.max(0, Math.min(1, rise01)) : 0;
  const rung = Math.min(plan.maxRung, Math.floor(progress * plan.maxRung + 1e-10));
  return { rise01: progress, rung, grid: plan.grids[rung] };
}

const QUALITY_GRIDS = [PIXEL_GRIDS.detailed, PIXEL_GRIDS.detailed, PIXEL_GRIDS.mediumPlus,
  PIXEL_GRIDS.medium, PIXEL_GRIDS.classicPlus, PIXEL_GRIDS.classic, PIXEL_GRIDS.classic];
/** The finest existing growth rung affordable at this performance level.
 * Quality is reversible; memory admission retains its separate ceiling. */
export function landscapeQualityRung(plan, quality = 0) {
  const level = Number.isFinite(quality) ? Math.max(0, Math.min(6, Math.floor(quality))) : 0;
  const cap = QUALITY_GRIDS[level];
  let rung = plan.maxRung;
  while (rung > 0 && (plan.grids[rung].width > cap.width || plan.grids[rung].height > cap.height)) rung--;
  return rung;
}
