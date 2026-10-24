// A maximum detail budget. Automatic shedding can still protect playback;
// recovery must never undo the player's selected Low/Medium/High ceiling.
export const RENDER_QUALITY_KEY = 'midio-pixel:render-quality:v1';
export const RENDER_QUALITIES = ['low', 'medium', 'high'];
export function renderQualityLevel(quality) { return { low: 6, medium: 3, high: 0 }[quality] ?? 0; }
export function readRenderQuality(storage, legacyQuality = 'auto') {
  try {
    const saved = storage?.getItem(RENDER_QUALITY_KEY);
    if (RENDER_QUALITIES.includes(saved)) return saved;
  } catch { /* private mode */ }
  return legacyQuality === 'economy' ? 'low' : 'high';
}
export function writeRenderQuality(storage, quality) {
  try { storage?.setItem(RENDER_QUALITY_KEY, RENDER_QUALITIES.includes(quality) ? quality : 'high'); }
  catch { /* private mode */ }
}
