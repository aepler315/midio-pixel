// Shared with terrain selection: additional geometric simplification must
// remain safe at the largest permitted structural land swell.
export const LAND_MAX_DISPLACEMENT_M = 180;
export const LAND_WAVE_K = 2 * Math.PI / 4800;
export const LAND_TOUR_FADE_END_M = 4000;

/** Source residual plus a conservative interpolation bound for both the
 * reference and candidate triangulations of h²(A sin(phase) + B).
 * A+B is bounded by calibration. The second directional derivative is
 * bounded over a full cell diagonal and the tile's complete height range. */
export function landDetailErrorM(tile, stride, sourceErrorM, cellSizeM, heightMin, heightMax) {
  const span = Math.max(1, heightMax - heightMin);
  const h = Math.min(1, Math.max(0, (tile.maxY - heightMin) / span));
  const dh = Math.min(1, Math.max(0, tile.maxY - tile.minY) / span);
  const phase = LAND_WAVE_K * Math.SQRT2 * cellSizeM * stride;
  const motion = LAND_MAX_DISPLACEMENT_M * (2 * dh * dh + 4 * h * dh * phase + h * h * phase * phase);
  return sourceErrorM * (1 + 2 * LAND_MAX_DISPLACEMENT_M * h / span) + motion;
}
