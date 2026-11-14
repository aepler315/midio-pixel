// Real upload, Camera Studio composition, cancellation and complete MP4 export.
// Native Chrome supplies H.264/AAC. Every run serves a frozen source snapshot.
// Usage: node tools/camera-studio-smoke.mjs NEW_OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && path.resolve(process.argv[2]);
assert.ok(output, 'Pass a new output directory.');
await fs.mkdir(output, { recursive: false });
const seconds = 12;
const fixture = path.join(output, 'camera-studio-fixture.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), fixture, '120', String(seconds)], { stdio: 'pipe' });
const report = { status: 'failed', checks: [], pageErrors: [], consoleErrors: [], seconds,
  scope: 'Isolated muted native Chrome with host WebGL; frozen source, real upload/analysis/render/encode/decode. No target-device or frame-rate certification.' };
const check = (description, condition) => { assert.ok(condition, description); report.checks.push(description); console.log('PASS ' + description); };
const snapshot = await snapshotSource(root);
report.sourceDigest = snapshot.digest;
report.fixtureSha256 = sha256(await fs.readFile(fixture));
const server = await serveSnapshot(snapshot);
let browser, context, page;
const state = () => page.evaluate(() => ({ playback: window.__SMW?.playbackState, export: window.__SMW?.videoExportState,
  readiness: window.__SMW?.renderReadiness,
  seed: window.__SMW?.songSeed, studio: window.__SMW?.cameraStudioSettings,
  heardTimeMs: window.__SMW?.sim?.heardTimeMs, audioMs: window.__SMW?.audioEngine?.nowMs,
  camera: window.__SMW?.rangeState?.cameraStudio, range: window.__SMW?.rangeState?.viewId }));
const wakeAndClick = async selector => {
  await page.locator('#stage').dispatchEvent('pointermove', { pointerType: 'mouse', clientX: 20, clientY: 200 });
  await page.locator(selector).click({ timeout: 10000 });
};
const capturePage = async filename => {
  try {
    await page.screenshot({ path: path.join(output, filename), timeout: 5000 });
    (report.captures ||= []).push({ file: filename, kind: 'page' });
  } catch {
    const data = await page.locator('#stage').evaluate(canvas => canvas.toDataURL('image/png'));
    const fallback = filename.replace(/\.png$/, '-stage-only.png');
    await fs.writeFile(path.join(output, fallback), Buffer.from(data.split(',')[1], 'base64'));
    (report.captures ||= []).push({ file: fallback, kind: 'stage canvas; native compositor screenshot timed out' });
  }
};
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--mute-audio'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }); });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === server.url || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  const entry = server.url + '/?rangeRenderer=v2&rangeView=teton-jackson-lake&rangeTour=off&seed=315';
  const response = await page.goto(entry);
  check('application boots', response.ok());
  await page.getByText('Browse files', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('#titleSettings').evaluate(node => { node.open = true; });
  check('Camera Studio starts off', !await page.locator('#camera-studio-toggle').isChecked());
  await page.locator('#camera-studio-toggle').check();
  await page.reload();
  await page.locator('#titleSettings').evaluate(node => { node.open = true; });
  check('Camera Studio toggle survives reload', await page.locator('#camera-studio-toggle').isChecked());
  check('overlay stays hidden before a song', !await page.locator('#camera-studio-panel').isVisible());
  const lyrics = page.locator('#lyricGroundingBtn');
  if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
  await page.locator('#display-pixelGrid').selectOption('classic');
  await page.locator('#fileInput').setInputFiles(fixture);
  // Pause in the readiness promise's own microtask. A software-rendered frame
  // can consume the entire short song before a remote UI click is scheduled.
  await page.evaluate(async () => {
    while (!window.__SMW?.sim) await new Promise(resolve => setTimeout(resolve, 10));
    await window.__SMW.renderReady;
    document.getElementById('pauseBtn').click();
  });
  check('uploaded fixture begins a ready performance', (await state()).readiness.status === 'ready');
  report.renderer = await page.evaluate(() => {
    const gl = window.__SMW.sim.biomes.rangePresentation?.scene?.renderer?.getContext();
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl?.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) || null;
  });
  await page.waitForFunction(() => window.__SMW?.paused);
  await page.evaluate(async () => { window.__SMW.seek(5000); await window.__SMW.renderReady; });
  await page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 120000 }));
  check('enabled studio overlay appears during paused Landscape', await page.locator('#camera-studio-panel').isVisible());
  const before = await state();
  report.before = before;
  const beforeCamera = await page.evaluate(() => ({ fov: window.__SMW.sim.biomes.rangePresentation?.scene?.camera?.fov,
    x: window.__SMW.sim.biomes.rangePresentation?.scene?.camera?.position?.x }));
  await page.locator('#camera-studio-distance').fill('0.65');
  await page.locator('#camera-studio-distance').press('Tab');
  await page.locator('#camera-studio-fovDeg').fill('25');
  await page.locator('#camera-studio-fovDeg').press('Tab');
  if (report.pageErrors.length) throw new Error(report.pageErrors.join('\n'));
  await page.waitForFunction(previous => {
    const camera = window.__SMW.sim.biomes.rangePresentation?.scene?.camera;
    return camera && camera.fov < previous.fov;
  }, beforeCamera);
  const after = await state();
  const afterCamera = await page.evaluate(() => ({ fov: window.__SMW.sim.biomes.rangePresentation?.scene?.camera?.fov,
    x: window.__SMW.sim.biomes.rangePresentation?.scene?.camera?.position?.x }));
  report.cameras = { before: beforeCamera, after: afterCamera };
  check('paused form edits update the live studio snapshot', after.playback.paused && after.studio.distance === 0.65 && after.studio.fovDeg === 25);
  check('paused edits redraw the lens without moving a pruned package', afterCamera.fov < beforeCamera.fov && Math.abs(afterCamera.x - beforeCamera.x) < 0.01);
  await page.locator('.cameraStudioBody').evaluate(body => { body.scrollTop = 0; });
  await page.evaluate(() => {
    window.__cameraStudioExportPoses = [];
    const prototype = Object.getPrototypeOf(window.__SMW.renderer);
    const draw = prototype.draw;
    prototype.draw = function (sim, ...args) {
      const result = draw.call(this, sim, ...args);
      if (window.__SMW?.videoExportState.phase === 'encoding' && Math.abs(sim.heardTimeMs - 5000) < 60) {
        const presentation = sim.biomes.rangePresentation, camera = presentation?.scene?.camera;
        window.__cameraStudioExportPoses.push({ timeMs: sim.timeMs, heardTimeMs: sim.heardTimeMs,
          eye: camera?.position?.toArray(), fov: camera?.fov, studio: sim.cameraStudioSettings,
          cameraRails: presentation?.status()?.cameraRails });
      }
      return result;
    };
  });
  await capturePage('landscape-studio-5000ms.png');
  await page.locator('#camera-studio-panel .cameraStudioCollapse').click();
  await capturePage('landscape-studio-collapsed-5000ms.png');
  await page.locator('#camera-studio-panel .cameraStudioCollapse').click();
  check('collapsing leaves the stationary studio header available', await page.locator('#camera-studio-panel').isVisible());
  await wakeAndClick('#videoExportBtn');
  check('Export opens a native modal dialog', await page.locator('#videoExportDialog').evaluate(dialog => dialog.open && dialog.matches(':modal')));
  check('all six video output sizes are offered', await page.locator('#videoExportResolution option').count() === 6);
  await page.locator('#videoExportResolution').selectOption('360p');
  await page.locator('#videoExportFps').selectOption('30');
  await capturePage('export-dialog.png');
  await page.locator('#videoExportStart').click();
  await page.waitForFunction(() => window.__SMW?.videoExportState?.phase === 'encoding' || window.__SMW?.videoExportState?.phase === 'error', null, { timeout: 180000 });
  report.cancelStarted = await state();
  check('native H.264/AAC support admits rendering', report.cancelStarted.export.phase === 'encoding');
  await page.locator('#videoExportCancel').click({ timeout: 120000 });
  await page.waitForFunction(() => window.__SMW?.videoExportState?.busy === false, null, { timeout: 180000 });
  const cancelled = await state();
  report.cancelled = cancelled;
  check('cancelling restores paused playback, seed and camera', cancelled.export.phase === 'cancelled'
    && cancelled.playback.running && cancelled.playback.paused && cancelled.seed === before.seed
    && cancelled.studio.distance === 0.65 && cancelled.studio.fovDeg === 25);
  check('cancelled playback returns near its original song time', Math.abs(cancelled.audioMs - before.audioMs) < 150);
  const downloadReady = page.waitForEvent('download', { timeout: 300000 });
  await page.locator('#videoExportStart').click();
  await page.waitForFunction(() => !window.__SMW?.videoExportState?.busy && ['complete', 'error'].includes(window.__SMW?.videoExportState?.phase), null, { timeout: 300000 });
  report.completed = await state();
  report.exportPosesNear5000ms = await page.evaluate(() => window.__cameraStudioExportPoses);
  check('full-song MP4 export completes', report.completed.export.phase === 'complete');
  const download = await downloadReady;
  const mp4 = path.join(output, download.suggestedFilename());
  await download.saveAs(mp4);
  report.mp4 = path.basename(mp4);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', mp4], { encoding: 'utf8' }));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  check('decoded MP4 has every requested H.264 frame', video.codec_name === 'h264' && video.width === 640 && video.height === 360
    && Number(video.nb_read_frames) === seconds * 30 && video.avg_frame_rate === '30/1');
  check('decoded MP4 contains full-length AAC music', audio?.codec_name === 'aac' && Math.abs(Number(audio.duration) - seconds) < 0.1);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 16 * 1024 * 1024 });
  let squareSum = 0;
  for (let i = 0; i < pcm.length; i += 4) squareSum += pcm.readFloatLE(i) ** 2;
  report.audioRms = Math.sqrt(squareSum / (pcm.length / 4));
  check('decoded music is non-silent', report.audioRms > 0.02);
  execFileSync('ffmpeg', ['-v', 'error', '-ss', '5', '-i', mp4, '-frames:v', '1', path.join(output, 'decoded-frame-5000ms.png')]);
  report.probe = probe;
  check('finished export restores paused playback and studio settings', report.completed.playback.running && report.completed.playback.paused
    && report.completed.seed === before.seed && report.completed.studio.distance === 0.65);
  check('no page errors occurred', report.pageErrors.length === 0);
  check('no browser console errors occurred', report.consoleErrors.length === 0);
  check('captured application source stayed unchanged', (await snapshotSource(root)).digest === snapshot.digest);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack || String(error);
  if (page) {
    report.failureState = await state().catch(() => null);
    report.failureText = await page.locator('#videoExportStatus').textContent().catch(() => null);
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await context?.close();
  await browser?.close();
  await server.close();
}
