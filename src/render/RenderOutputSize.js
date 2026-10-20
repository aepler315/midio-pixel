/** The terrain grid stays independent of the final display backing. Hybrid
 * skies use the contained picture's physical size, bounded to 1080p live. */
export function stageOutputSize({ grid, hybrid = false, cssWidth, cssHeight, dpr = 1, exportSize = null }) {
  if (exportSize) return { w: exportSize.w, h: exportSize.h };
  const native = { w: grid.width, h: grid.height };
  if (!hybrid || !(cssWidth > 0) || !(cssHeight > 0) || !(dpr > 0)) return native;
  const aspect = 16 / 9;
  const height = Math.min(1080, Math.min(cssHeight, cssWidth / aspect) * dpr);
  return { w: Math.max(1, Math.round(height * aspect)), h: Math.max(1, Math.round(height)) };
}
