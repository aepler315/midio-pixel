import { PIXEL_GRIDS, runtimePixelGrid } from './PixelRenderPolicy.js';

export const LANDSCAPE_DETAIL_RUNGS = 24;
/** Fixed aspect; fit/cover resolves the picture up to Detailed. Cache this per
 * layout, not per frame. Bound dimensions before any GPU/canvas allocation. */
export function landscapeResolutionPlan({ width, height, scaling = 'fit' } = {}) {
  const w = Number.isFinite(width) && width > 0 ? width : 320;
  const h = Number.isFinite(height) && height > 0 ? height : 180;
  const fit = (scaling === 'cover' ? Math.max : Math.min)(w / 320, h / 180);
  const scale = Math.max(1, Math.min(fit, PIXEL_GRIDS.detailed.width / 320));
  const endpoint = { width: Math.ceil(320 * scale), height: Math.ceil(180 * scale) };
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
