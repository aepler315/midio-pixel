// Select full camera terrain through Settings, then inspect bounded Arc motion
// and a terrain-budget fallback in the real renderer. Images need visual review.
// Usage: node tools/camera-studio-tour-smoke.mjs NEW_OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { evaluationEntryUrl, renderEvaluationFrame, expectedTourPreparationFailure } from './lib/visual-evaluation-browser.mjs';
import { normalizeManifest } from './lib/visual-evaluation.mjs';
import { seedBrowserConstruction, installSeedReceiver } from './lib/landscape-browser.mjs';
import { attachBrowserDiagnostics } from './lib/browser-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && path.resolve(process.argv[2]);
assert.ok(output, 'Pass a new output directory.');
await fs.mkdir(output, { recursive: false });
const audioPath = path.join(output, 'tour-fixture.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audioPath, '120', '30'], { stdio: 'pipe' });
const report = { status: 'failed', frames: [], scope: 'Isolated muted native Chrome, actual host renderer recorded, fixed-clock full-coverage tour; no delivered-FPS or target-device claim.' };
const snapshot = await snapshotSource(root);
report.sourceDigest = snapshot.digest;
const server = await serveSnapshot(snapshot);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : { channel: 'chrome' }), args: ['--mute-audio'] });
report.browser = browser.version();
const makeContext = browser.newContext.bind(browser);
browser.newContext = async options => {
  const context = await makeContext(options);
  await context.addInitScript(() => { localStorage.setItem('midio.cameraStudio.v1', JSON.stringify({ enabled: true, preset: 'orbit' })); });
  return context;
};
const settings = normalizeManifest({ version: 1, settings: { width: 640, height: 360, seed: 315, quality: 0,
  tour: 'tetons', pace: 3, view: null, presentation: { version: 2, look: 'cinematic', quality: 'auto', pixelGrid: 'classic', pixelScale: 'original', scaling: 'fit', buildPixelDetail: false } },
  songs: [{ id: 'fixture', fixture: 'contrast' }] }).settings;
const diagnostics = { errors: [], warnings: [], events: [], loadedFiles: new Set() };
let loaded;
try {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await context.addInitScript(seedBrowserConstruction, settings.seed);
  await context.addInitScript(installSeedReceiver);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === server.url || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const browserDiagnostics = await attachBrowserDiagnostics(page, diagnostics, { origin: server.url, isExpectedRequestFailure: expectedTourPreparationFailure });
  loaded = { context, page, browserDiagnostics };
  await page.goto(evaluationEntryUrl(server.url, { ...settings, tour: null }));
  await page.locator('#titleSettings').evaluate(node => { node.open = true; });
  assert.equal(new URL(page.url()).searchParams.has('rangeTour'), false);
  await page.locator('#range-tour-toggle-kind').selectOption('tetons');
  report.selectedFullTerrainThroughSettings = await page.locator('#range-tour-toggle-kind').inputValue() === 'tetons';
  report.afterSelection = await page.evaluate(() => ({ href: location.href, saved: localStorage.getItem('range-tour'), range: window.__SMW?.rangeState }));
  assert.equal(report.selectedFullTerrainThroughSettings, true);
  const lyrics = page.locator('#lyricGroundingBtn');
  if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
  await page.locator('#fileInput').setInputFiles(audioPath);
  await page.waitForFunction(() => window.__SMW?.exportReady || window.__SMW_EXPORT_ERROR, null, { timeout: 300000 });
  report.environment = await page.evaluate(async settings => {
    if (window.__SMW_EXPORT_ERROR) throw Error(window.__SMW_EXPORT_ERROR);
    window.__resetLandscapeRandom();
    window.__SMW.beginBulkExport({ width: settings.width, height: settings.height, presentation: settings.presentation });
    await window.__SMW.rangeReady({ timeoutMs: 120000 });
    window.__SMW.perf.setFixtureLevel(settings.quality);
    const gl = window.__SMW.sim.biomes.rangePresentation?.scene?.renderer?.getContext();
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { renderer: gl?.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER), seed: window.__SMW.songSeed };
  }, settings);
  for (const timeMs of [4000, 12000, 16000, 24000]) {
    const frame = await renderEvaluationFrame(loaded.page, { timeMs, save: true }, settings);
    const filename = `orbit-${timeMs}.png`;
    await fs.writeFile(path.join(output, filename), Buffer.from(frame.pngData, 'base64'));
    delete frame.pngData; delete frame.thumbnail;
    assert.equal(frame.range.cameraStudio.capability, 'full');
    assert.equal(frame.range.cameraStudio.budgetFallback, false);
    assert.ok(frame.camera.eyeM.every(Number.isFinite));
    report.frames.push({ file: filename, ...frame });
    console.log('Captured ' + filename);
  }
  const first = report.frames[0].camera.eyeM, last = report.frames.at(-1).camera.eyeM;
  report.eyeTravelM = Math.hypot(...last.map((value, i) => value - first[i]));
  assert.ok(report.eyeTravelM > 100, 'orbit must move across heard song times');
  await loaded.page.evaluate(() => {
    window.__SMW.sim.cameraStudioSettings = { enabled: true, preset: 'orbit', distance: .35,
      elevation: -15, azimuthDeg: 0, direction: 'ccw', focusX: .2, focusY: -.2, focusZ: .2, fovDeg: 70,
      durationSec: 1, holdSec: 0, orbitSeconds: 20, overshoot: .5 };
  });
  const extreme = await renderEvaluationFrame(loaded.page, { timeMs: 26000, save: true }, settings);
  await fs.writeFile(path.join(output, 'extreme-26000.png'), Buffer.from(extreme.pngData, 'base64'));
  delete extreme.pngData; delete extreme.thumbnail;
  report.extreme = extreme;
  assert.ok(extreme.camera.eyeM.every(Number.isFinite));
  assert.equal(extreme.range.cameraStudio.budgetFallback, true);
  assert.ok(extreme.range.cameraStudio.maxErrorPx <= 16);
  report.diagnostics = { errors: diagnostics.errors, warnings: diagnostics.warnings };
  assert.deepEqual(diagnostics.errors, []);
  assert.equal((await snapshotSource(root)).digest, snapshot.digest, 'source changed during capture');
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  report.diagnostics = { errors: diagnostics.errors, warnings: diagnostics.warnings };
  if (loaded) report.finalRange = await loaded.page.evaluate(() => window.__SMW?.rangeState).catch(() => null);
  if (loaded) { await loaded.context.close(); await loaded.browserDiagnostics.dispose(); }
  await browser.close(); await server.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}

