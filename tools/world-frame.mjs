// Whole-song comparisons require the completed analysis in both readers.
// Playback readiness alone also permits the intentionally provisional opening.
export function worldAnalysisReady({ throughMs }) {
  const sim = window.__SMW?.sim;
  const curves = sim?.energyCurves;
  return !!(sim && !sim.analysisOpening && curves && sim.biomes?.energyCurves === curves
    && curves.rateHz > 0 && Number.isFinite(curves.rateHz)
    && (curves.n - 1) * 1000 / curves.rateHz >= throughMs);
}

// Runs inside page.evaluate; captures the scene at an explicit audible seek
// destination. The caller pauses playback before invoking this helper.
export function renderWorldFrame({ atMs, quality = 0, constructionSeed = 315 }) {
  // Scope deterministic construction to the synchronous seek; production RNG
  // and subsequent playback retain their normal behavior.
  const random = Math.random;
  let state = constructionSeed >>> 0;
  Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  try { window.__SMW.seek(atMs); } finally { Math.random = random; }
  // Seeking reconstructs BOTH objects. Never keep a pre-seek reference.
  const { sim, renderer, perf } = window.__SMW;
  if (perf) perf.level = quality;
  renderer.draw(sim, 1);
  const stage = document.querySelector('#stage');
  return {
    requestedMs: atMs,
    constructionSeed,
    renderer: renderer.constructor.name,
    songSeed: sim.songSeed ?? sim.biomes.songSeed ?? null,
    camera: sim.camera ? { x: sim.camera.x, zoom: sim.camera.zoom, shakeX: sim.camera.shakeX, shakeY: sim.camera.shakeY, roll: sim.camera.roll } : null,
    timeMs: sim.biomes.tSec * 1000,
    simulationMs: sim.timeMs,
    response: sim.biomes.world.response || null,
    quality: perf?.level ?? null,
    backingStore: { width: stage.width, height: stage.height },
  };
}
