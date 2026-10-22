/** @typedef {{id: string, width: number, height: number, pixels: number}} PixelGrid */
/** @typedef {{active: boolean, grid: PixelGrid|null, unit: number, minGlyphHeight: number, materialMinPeriodPx: number, pixelScale: 'original'}} PixelPolicy */

const CLASSIC = Object.freeze({ id: 'classic', width: 320, height: 180, pixels: 57600 });
const MEDIUM = Object.freeze({ id: 'medium', width: 480, height: 270, pixels: 129600 });
const DETAILED = Object.freeze({ id: 'detailed', width: 640, height: 360, pixels: 230400 });
export const PIXEL_GRIDS = Object.freeze({ classic: CLASSIC, medium: MEDIUM, detailed: DETAILED });
export const MAX_PIXEL_PIXELS = DETAILED.pixels;
const INACTIVE = Object.freeze({ active: false, grid: null, unit: 0, minGlyphHeight: 0, materialMinPeriodPx: 0, pixelScale: 'original' });
export const PIXEL_POLICY_VERSION = 2;

/** Resolve only supported grids; preferences and legacy callers default to Classic. @returns {PixelGrid} */
export function pixelGrid(id = 'classic') { return Object.hasOwn(PIXEL_GRIDS, id) ? PIXEL_GRIDS[id] : CLASSIC; }

/** Whole grid pixels per Classic pixel. Medium's 1.5x rounds up to 2x so
 *  captions, glow, heat and stars never land on half pixels. */
export function pixelUnit(grid) { return Math.max(1, Math.round((grid?.width ?? CLASSIC.width) / CLASSIC.width)); }

/** Pixel-space dimensions only. Simulation, camera and quality remain independent. @returns {PixelPolicy} */
export function pixelRenderPolicy({ pixelated = false, grid = null } = {}) {
  if (!pixelated) return INACTIVE;
  const resolved = pixelGrid(typeof grid === 'string' ? grid : grid?.id);
  const unit = pixelUnit(resolved);
  return Object.freeze({ active: true, grid: resolved, unit, minGlyphHeight: 7 * unit,
    materialMinPeriodPx: 2, pixelScale: 'original' });
}
