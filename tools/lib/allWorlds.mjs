// The app starts in one-world mode (The Range, no picker). The smoke tools
// that exercise the world picker or the other worlds open it with every
// world registered, which is what `?worlds=all` does (src/main.js).
export function withAllWorlds(url) {
  const u = new URL(url);
  u.searchParams.set('worlds', 'all');
  return u.href;
}

// Range v2 (real terrain on WebGL2) is the default Range renderer. Headless
// CI has only software GL, where one v2 frame takes seconds, so live
// playback cannot keep up with a short fixture song. Tools that test the app
// shell (transport, HUD, pickers) rather than the Range scenery pin legacy;
// v2 itself is covered by tools/range-scene-smoke.mjs on the export clock.
export function withLegacyRange(url) {
  const u = new URL(url);
  u.searchParams.set('rangeRenderer', 'legacy');
  return u.href;
}
