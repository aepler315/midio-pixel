// A seek can leave a coarse resident while its replacement is pending.
export async function fullForestWindow(cache, timeMs) {
  const index = Math.max(0, Math.floor(timeMs / cache.windowMs));
  cache.current = index; cache.prune();
  const w = await cache.request(index, { replace: cache.resident.get(index)?.coarse === true });
  if (!w || w.coarse) throw new Error(`Full tour window unavailable at ${timeMs}`);
  return w;
}

// The first seek draw can latch a held-window skyline at this same time.
// Re-read the complete window and let rangeSettle redraw its sky echo.
export function resetForestSkyline(biomes) {
  biomes._skyline = null;
  biomes._skylineUnsettled = false;
  if (biomes.spaceRidge) {
    biomes.spaceRidge.skyline = null;
    biomes.spaceRidge.lastEchoed = false;
  }
}
