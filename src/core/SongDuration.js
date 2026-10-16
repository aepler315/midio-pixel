// Resolves a song's playable duration, guarding against a degenerate
// declared duration (<= 0) that would otherwise leave FractureEngine's
// idle -> about-to-freeze transition (FractureEngine.js:205) unreachable,
// so the song never completes and the engine runs forever. Pure.
export function resolveDurationMs(timeline, declaredMs) {
  if (declaredMs > 0) return declaredMs;
  if (!timeline || timeline.length === 0) return 0;
  let maxEnd = 0;
  for (const evt of timeline) {
    const end = (evt.tMs || 0) + (evt.durMs || 0);
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd > 0 ? maxEnd + 3000 : 0;
}
