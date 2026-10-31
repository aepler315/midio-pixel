/** The terrain grid stays independent of the final display backing. Hybrid
 * skies use the contained picture's physical size, bounded to 1080p windowed.
 * Fullscreen uses the physical viewport, overriding adaptive output scaling.
 *
 * `scale` is the quality ladder's resolution scale
 * (PerfGovernor.resolutionScale, adaptive: 1 at rungs 0-1, then 0.85, 0.75
 * and 0.625). It used to be computed and never applied, so the heaviest
 * rungs still drew the smooth sky, the output-size water pass, the crest
 * line, mid-depth effects and the final composite at full display density
 * -- 1920x1080 on a phone at DPR 2-3, the largest area in the frame. Now
 * the ladder spends those pixels before it reaches the deepest rungs. */
export function stageOutputSize({ grid, hybrid = false, fullscreen = false, cssWidth, cssHeight, dpr = 1, exportSize = null, scale = 1 }) {
  if (exportSize) return { w: exportSize.w, h: exportSize.h };
  const native = { w: grid.width, h: grid.height };
  if (fullscreen && cssWidth > 0 && cssHeight > 0 && dpr > 0) {
    return { w: Math.max(1, Math.round(cssWidth * dpr)), h: Math.max(1, Math.round(cssHeight * dpr)) };
  }
  if (!hybrid || !(cssWidth > 0) || !(cssHeight > 0) || !(dpr > 0)) return native;
  const aspect = 16 / 9;
  let height = Math.min(1080, Math.min(cssHeight, cssWidth / aspect) * dpr);
  if (scale > 0 && scale < 1) height = reducedHybridHeight(height, scale, grid.height);
  return { w: Math.max(1, Math.round(height * aspect)), h: Math.max(1, Math.round(height)) };
}

/** A reduced height snaps down to whole terrain cells (a multiple of the
 * grid height), so the nearest-neighbour terrain keeps equal cells, and
 * never drops below two output rows per grid row (or the full height, when
 * the display is smaller than that). */
function reducedHybridHeight(full, scale, gridHeight) {
  let height = full * scale;
  if (gridHeight > 0 && height >= 2 * gridHeight) height = Math.floor(height / gridHeight) * gridHeight;
  return Math.max(Math.min(full, 2 * (gridHeight > 0 ? gridHeight : 0)), height);
}
