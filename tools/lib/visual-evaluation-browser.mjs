import assert from 'node:assert/strict';
import { seedBrowserConstruction, installSeedReceiver } from './landscape-browser.mjs';
import { attachBrowserDiagnostics } from './browser-diagnostics.mjs';

export function validateEvaluationSeeds(info, settings) {
  assert.equal(info.constructionSeed, settings.seed, 'construction seed did not match the pinned seed');
  assert.ok(Number.isInteger(info.seed) && info.seed >= 0 && info.seed <= 0xffffffff, 'invalid song-derived seed');
}

export function expectedTourPreparationFailure(request) {
  const url = new URL(request.url());
  return request.failure()?.errorText === 'net::ERR_ABORTED' && url.pathname.startsWith('/src/assets/range/v2/')
    && `cancelled tour preparation request ${url.pathname}`;
}

// Both fixed-clock and live reviews use the same product camera controls.
export function evaluationEntryUrl(url, settings, { bulkExport = true } = {}) {
  const entry = new URL(url);
  const controls = { bulkExport: bulkExport ? 1 : null,
    exportW: bulkExport ? settings.width : null, exportH: bulkExport ? settings.height : null,
    experience: settings.experience, rangeRenderer: 'v2', rangeTour: settings.tour,
    rangePace: settings.pace, rangeView: settings.view, seed: settings.seed, perf: 'high',
    rangeShots: process.env.VISUAL_RANGE_SHOTS === 'all' ? 'all' : null };
  for (const [key, value] of Object.entries({ ...controls, ...settings.debug })) {
    if (value != null) entry.searchParams.set(key, value);
    else entry.searchParams.delete(key);
  }
  return entry.href;
}

// Uses the real upload/analysis and existing export APIs. No synthetic control
// bus is substituted for the decoded audio.
export async function openEvaluationSong(browser, { url, audioPath, settings, diagnostics }) {
  const context = await browser.newContext({ viewport: { width: settings.width, height: settings.height },
    deviceScaleFactor: 1, serviceWorkers: 'block' });
  try {
    await context.addInitScript(seedBrowserConstruction, settings.seed);
    await context.addInitScript(installSeedReceiver);
    const origin = new URL(url).origin;
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      return u.origin === origin || ['data:', 'blob:'].includes(u.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const browserDiagnostics = await attachBrowserDiagnostics(page, diagnostics, { origin,
      // Analysis revisions cancel old tour preparation fetches; the active
      // backend is still verified per frame. Other cancellations remain fatal.
      isExpectedRequestFailure: settings.tour === 'tetons' ? expectedTourPreparationFailure : undefined });
    await page.goto(evaluationEntryUrl(url, settings));
    await page.locator('#titleSettings').evaluate(node => { node.open = true; });
    const lyrics = page.locator('#lyricGroundingBtn');
    if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
    browserDiagnostics.setPhase('audio-analysis');
    await page.locator('#fileInput').setInputFiles(audioPath);
    await page.waitForFunction(() => window.__SMW?.exportReady || window.__SMW_EXPORT_ERROR, null, { timeout: 300000 });
    browserDiagnostics.setPhase('render-preparation');
    const info = await page.evaluate(async settings => {
      if (window.__SMW_EXPORT_ERROR) throw new Error(window.__SMW_EXPORT_ERROR);
      window.__resetLandscapeRandom();
      window.__SMW.beginBulkExport({ width: settings.width, height: settings.height, presentation: settings.presentation });
      await window.__SMW.rangeReady({ timeoutMs: 120000 });
      window.__SMW.perf.setFixtureLevel(settings.quality);
      const gl = window.__SMW.sim.biomes.rangePresentation?.scene?.renderer?.getContext();
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { durationMs: window.__SMW.durationMs, seed: window.__SMW.songSeed, constructionSeed: window.__landscapeConstructionSeed,
        environment: { gl: gl ? gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) : null,
          vendor: gl ? gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL || gl.VENDOR) : null,
          deviceMemory: navigator.deviceMemory ?? null, dpr: devicePixelRatio } };
    }, settings);
    validateEvaluationSeeds(info, settings);
    browserDiagnostics.setPhase('ready');
    return { context, page, browserDiagnostics, ...info };
  } catch (err) { await context.close(); throw err; }
}

export async function renderEvaluationFrame(page, point, settings) {
  return page.evaluate(async ({ point, settings }) => {
    const smw = window.__SMW;
    const beforeDraw = () => {
      if (settings.biome) smw.sim.biomes.currentBlend = { from: settings.biome, to: settings.biome, t: 1,
        travel: false, travelP: 1, fromHeightMul: 1, toHeightMul: 1, fromSnowLine01: 1, toSnowLine01: 1 };
    };
    let clock = smw.renderExportFrame(point.timeMs, { beforeDraw });
    if (await smw.rangeSettle({ timeoutMs: 120000 })) clock = smw.renderExportFrame(point.timeMs, { beforeDraw });
    const state = structuredClone(smw.rangeState);
    if (Math.abs(clock.timeMs - point.timeMs) > 1000 / 60 + 0.01) throw new Error(`clock drift at ${point.timeMs}: ${clock.timeMs}`);
    if (clock.width !== settings.width || clock.height !== settings.height || clock.draws !== 1) throw new Error('wrong frame size or draw count');
    if (smw.perfLevel !== settings.quality) throw new Error('quality drift');
    if (settings.experience === 'trio' && (smw.experience !== 'trio' || !smw.sim.trio || state.active)) throw new Error('Trio Stage is inactive or terrain is still active');
    if (settings.experience !== 'trio' && (state.mode !== 'v2' || !state.active || state.runtime !== 'ready')) throw new Error(`Range v2 inactive: ${JSON.stringify(state)}`);
    const expectedView = settings.tour === 'tetons' ? 'teton-range-tour' : settings.view;
    if (settings.experience !== 'trio' && expectedView && state.viewId !== expectedView) throw new Error(`wrong view ${state.viewId}`);
    // The rung the scene actually drew with, not only the governor's value.
    const rangeFrame = smw.sim.biomes.rangePresentation?.frame;
    if (rangeFrame && (rangeFrame.qualityLevel ?? 0) !== settings.quality) throw new Error(`effective quality ${rangeFrame.qualityLevel} != ${settings.quality}`);
    if (!point.save) return null;
    const canvas = document.querySelector('#stage');
    const thumb = document.createElement('canvas'); thumb.width = 64; thumb.height = 36;
    const ctx = thumb.getContext('2d', { willReadFrequently: true }); ctx.drawImage(canvas, 0, 0, 64, 36);
    const thumbnail = [...ctx.getImageData(0, 0, 64, 36).data];
    const sim = smw.sim, frame = sim.biomes.rangePresentation?.frame;
    return { ...(settings.experience ? { experience: smw.experience } : {}), timeMs: point.timeMs, actualTimeMs: clock.timeMs, checkpoint: point.checkpoint, clips: point.clips,
      pngData: canvas.toDataURL('image/png').split(',')[1], thumbnail, range: state, cameraRails: state.cameraRails ?? null,
      renderReadiness: structuredClone(smw.renderReadiness ?? null), quality: smw.perfLevel,
      audio: { heardTimeMs: sim.heardTimeMs, energy: sim.energyCurves?.globalEnergyNorm(sim.heardTimeMs) ?? null,
        bands: sim.energyCurves?.sampleAll(sim.heardTimeMs) ?? null },
      controls: { camera: sim.camera, cameraMove: frame?.cameraMove ?? null, storm: frame?.storm ?? null,
        land: frame?.music ?? null, sectionId: frame?.sectionId ?? null, motifId: frame?.motifId ?? null },
      presentation: smw.presentationDiagnostics, requestedPresentation: settings.presentation ?? null,
      output: { width: canvas.width, height: canvas.height }, dpr: devicePixelRatio,
      // Provenance of the scenic pixels: target size, multisampling and its
      // reason, drawing buffer, the rung's effects and the exposure used.
      render: (() => {
        const presentation = sim.biomes.rangePresentation, scene = presentation?.scene;
        const prepared = scene?.prepared?.get?.(state.viewId);
        return { scene: scene?.renderDiagnostics?.() ?? null, qualityLevel: frame?.qualityLevel ?? null,
          scenicViewport: frame?.scenicViewport ? { backingWidth: frame.scenicViewport.backingWidth, backingHeight: frame.scenicViewport.backingHeight,
            logicalWidth: frame.scenicViewport.logicalWidth, logicalHeight: frame.scenicViewport.logicalHeight, overscanPx: frame.scenicViewport.overscanPx ?? 0,
            pixelRatio: frame.scenicViewport.pixelRatio ?? null } : null,
          cinematicLight: prepared?.uniforms?.uCinematic?.value?.toArray?.() ?? null, cinematicAir: prepared?.uniforms?.uCinematicAir?.value?.toArray?.() ?? null,
          mist: prepared?.uniforms ? { density: prepared.uniforms.uMistDensity?.value, fill: prepared.uniforms.uMistFill?.value, base: prepared.uniforms.uMistBase?.value } : null,
          exposure: prepared?.uniforms?.uExposure?.value ?? null, lightDir: prepared?.uniforms?.uLightDir?.value?.toArray?.() ?? null,
          cameraPos: prepared?.uniforms?.uCameraPos?.value?.toArray?.() ?? null, horizonSize: prepared?.uniforms?.uHorizonSize?.value?.toArray?.() ?? null, forestKeep: prepared?.uniforms?.uForestKeep?.value ?? null,
          mirror: prepared?.uniforms?.uMirrorAmount?.value ?? null, shafts: !!scene?.shafts, trees: prepared?.stats?.trees ?? null };
      })(),
      // The perspective camera the scenic partitions were drawn with, and the
      // tour shot that placed it (null on an authored rail).
      camera: (() => {
        const presentation = sim.biomes.rangePresentation, cam = presentation?.scene?.camera;
        if (!cam?.position) return null;
        const e = cam.matrixWorld?.elements;
        return { eyeM: cam.position.toArray(), forward: e ? [-e[8], -e[9], -e[10]] : null, fovYDeg: cam.fov, aspect: cam.aspect,
          near: cam.near, far: cam.far, viewOffset: cam.view?.enabled ? { ...cam.view } : null,
          shot: presentation?.shotState?.(state.viewId, sim.heardTimeMs) ?? null };
      })(),
      generation: smw.generation, seed: smw.songSeed };
  }, { point, settings });
}
