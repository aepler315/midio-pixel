/** @typedef {{id: string, width: number, height: number, pixels: number}} PixelGrid */
/** @typedef {{active: boolean, grid: PixelGrid|null, unit: number, minGlyphHeight: number, heatMaxOffset: number, materialMinPeriodPx: number, pixelScale: 'depth'|'original'}} PixelPolicy */

const CLASSIC = Object.freeze({ id: 'classic', width: 320, height: 180, pixels: 57600 });
const DETAILED = Object.freeze({ id: 'detailed', width: 640, height: 360, pixels: 230400 });
export const PIXEL_GRIDS = Object.freeze({ classic: CLASSIC, detailed: DETAILED });
export const MAX_PIXEL_PIXELS = DETAILED.pixels;
const INACTIVE = Object.freeze({ active: false, grid: null, unit: 0, minGlyphHeight: 0, heatMaxOffset: 0, materialMinPeriodPx: 0, pixelScale: 'original' });
export const PIXEL_POLICY_VERSION = 2;

/** Resolve only supported grids; preferences and legacy callers default to Classic. @returns {PixelGrid} */
export function pixelGrid(id = 'classic') { return Object.hasOwn(PIXEL_GRIDS, id) ? PIXEL_GRIDS[id] : CLASSIC; }

/** Pixel-space dimensions only. Simulation, camera and quality remain independent. @returns {PixelPolicy} */
export function pixelRenderPolicy({ pixelated = false, grid = null, reducedMotion = false, reducedFlash = false, pixelScale = 'depth' } = {}) {
  if (!pixelated) return INACTIVE;
  const resolved = pixelGrid(typeof grid === 'string' ? grid : grid?.id);
  const unit = resolved.width / CLASSIC.width;
  return Object.freeze({ active: true, grid: resolved, unit, minGlyphHeight: 7 * unit,
    heatMaxOffset: reducedMotion ? 0 : unit, materialMinPeriodPx: 2, pixelScale: pixelScale === 'original' ? 'original' : 'depth' });
}
