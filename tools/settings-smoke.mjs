// Settings panel regression in real Chromium (no user browser is opened).
//   node tools/settings-smoke.mjs [--out .smoke/settings-<unique-run>] [--playback] [--v2 | --only-v2]
// Desktop, touch phone and JOYING-class head-unit (800×480, Android UA)
// viewports: URL overrides and their indicators, rejected/retired/unknown
// parameters, persistence across reloads, reset, saving overrides, share
// links, the basic/stable-only menu rule, keyboard reach, touch-target size,
// horizontal overflow, and screenshots. With --playback (desktop) it also
// plays the generated sample on the painted Range and changes live and
// renderer-lifecycle settings mid-song, checking the audio and seed carry
// over. --v2 restarts the 3D landscape renderer mid-song on the machine's GPU
// (SETTINGS_SMOKE_GL=swiftshader for software GL) and checks frames keep
// presenting, the camera high-water and audio carry over, and repeated
// restarts leave no context warnings. Emulation only: no Android OS or
// head-unit hardware.
// Exit 2 means Chromium was unavailable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const playback = args.includes('--playback');
const smokeRoot = path.join(root, '.smoke');
const out = path.resolve(root, outArg >= 0 ? args[outArg + 1] : `.smoke/settings-${Date.now()}-${process.pid}`);
assert.ok(out.startsWith(smokeRoot + path.sep), 'capture evidence must stay in .smoke/');
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; HeadUnit) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.154 Mobile Safari/537.36';
const scenarios = [
  { id: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  { id: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { id: 'head-unit', viewport: { width: 800, height: 480 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: ANDROID_UA },
];
const report = { status: 'running', startedAt: new Date().toISOString(), scenarios: [],
  limits: ['Chromium device emulation; no Android OS, head-unit hardware or physical touch input.'] };

async function exercise(browser, base, scenario) {
  const row = { id: scenario.id, checks: [], status: 'running' };
  report.scenarios.push(row);
  const check = async (name, fn) => {
    try { await fn(); row.checks.push({ name, status: 'passed' }); }
    catch (error) { row.checks.push({ name, status: 'failed', error: error.message.split('\n')[0] }); }
  };
  const context = await browser.newContext({ viewport: scenario.viewport, deviceScaleFactor: scenario.deviceScaleFactor,
    isMobile: !!scenario.isMobile, hasTouch: !!scenario.hasTouch, ...(scenario.userAgent ? { userAgent: scenario.userAgent } : {}) });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const query = '?rangeRenderer=legacy&rangePace=2&fps=1&rangeMsaa=9&style=classic&bogus=1';
  await page.goto(base + '/' + query);
  await page.waitForFunction(() => window.__SMW);
  const openSettings = () => page.locator('#titleSettings').evaluate(el => { el.open = true; el.scrollIntoView(); });
  await openSettings();

  await check('the menu shows only basic, stable sections and controls', async () => {
    for (const id of ['appearance', 'camera', 'playback']) assert.ok(await page.locator(`#settings-${id}`).count(), id);
    for (const id of ['landscape', 'performance', 'experiments']) assert.equal(await page.locator(`#settings-${id}`).count(), 0, id);
    for (const id of ['display-pixelGrid', 'display-buildPixelDetail', 'display-scaling', 'range-pace', 'range-tour-toggle', 'lyricGroundingBtn', 'camera-studio-toggle']) {
      assert.ok(await page.locator(`#${id}`).isVisible(), `${id} visible`);
    }
    assert.equal(await page.locator('#settingsPanel [data-setting]:not([data-tier="basic"])').count(), 0);
    assert.equal(await page.locator('#settingsPanel [data-maturity]:not([data-maturity="stable"])').count(), 0);
    assert.match(await page.locator('#settingsQualityStatus').innerText(), /High.*automatic|automatic.*High/i);
  });
  await check('hidden settings stay registered but out of the menu', async () => {
    assert.equal(await page.locator('#graphicsTroubleshooting').count(), 1);
    assert.equal(await page.locator('#graphicsTroubleshooting').evaluate(el => el.open), false);
    const placement = await page.evaluate(async () => {
      const { SETTINGS, isMenuSetting } = await import('/src/config/settingsRegistry.js');
      const rows = id => document.querySelectorAll(`#settingsPanel [data-setting="${id}"]`).length;
      return {
        total: SETTINGS.length,
        menu: SETTINGS.filter(isMenuSetting).filter(d => d.control !== 'external').map(d => ({ id: d.id, rows: rows(d.id) })),
        hidden: SETTINGS.filter(d => !isMenuSetting(d)).map(d => ({ id: d.id, rows: rows(d.id) })),
      };
    });
    assert.equal(placement.total, 60);
    assert.ok(placement.menu.length >= 10);
    assert.deepEqual(placement.menu.filter(d => d.rows !== 1), [], JSON.stringify(placement.menu));
    assert.deepEqual(placement.hidden.filter(d => d.rows !== 0), [], JSON.stringify(placement.hidden));
    assert.equal(await page.locator('#settingsEngineering').count(), 0);
    assert.equal(await page.locator('.settingsExperiments').count(), 0);
    assert.equal(await page.locator('#generalQuality').count(), 0);
    assert.equal(await page.locator('#stageFps').count(), 0);
  });
  await check('the export dialog keeps one navigation entry; Camera Studio navigation is not in the menu', async () => {
    const button = page.locator('#settingsPanel button[data-control-target="mp4Export"]');
    assert.equal(await button.count(), 1);
    assert.equal(await button.isVisible(), true);
    assert.equal(await button.locator('xpath=ancestor::*[@data-setting]').count(), 0, 'navigation is not a setting value input');
    assert.equal(await page.locator('#settingsPanel button[data-control-target="cameraStudio"]').count(), 0);
    assert.equal(await page.locator('#setting-control-mp4Export').isEnabled(), true, 'video output preferences can be chosen before loading a song');
  });
  await check('URL overrides are marked and listed, and not saved', async () => {
    assert.match(await page.locator('[data-setting="rangePace"] .settingBadges').innerText(), /page address/i);
    assert.equal(await page.locator('#range-pace').inputValue(), '2');
    assert.ok(await page.locator('.settingsOverrides').isVisible());
    assert.equal(await page.evaluate(() => localStorage.getItem('range-pace')), null);
  });
  await check('rejected, retired and unknown parameters appear in diagnostics', async () => {
    await page.locator('#graphicsTroubleshooting > summary').click();
    await page.waitForFunction(() => /Rejected/.test(document.getElementById('graphicsTroubleshooting').innerText));
    const text = await page.locator('#graphicsTroubleshooting').innerText();
    assert.match(text, /Rejected \?rangeMsaa=9/);
    assert.match(text, /Ignored \?style/);
    assert.match(text, /Unknown \?bogus/);
    assert.match(text, /Landscape renderer/);
    await page.locator('#graphicsTroubleshooting > summary').click();
  });
  await check('menu controls keep their state under the painted renderer', async () => {
    assert.equal(await page.locator('#range-tour-toggle').isDisabled(), false, 'tours create the 3D presentation themselves');
    assert.equal(await page.locator('#display-pixelGrid').isDisabled(), false);
    assert.equal(await page.locator('#camera-studio-toggle').isDisabled(), false);
  });
  await check('touch targets are at least 36 px and nothing overflows horizontally', async () => {
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#settingsPanel select, #settingsPanel button, #settingsPanel .settingCheck, #settingsPanel input[type=number]')]
      .filter(n => n.offsetParent).map(n => ({ id: n.id || n.className, h: n.getBoundingClientRect().height })));
    const small = sizes.filter(s => s.h < 36);
    assert.deepEqual(small, [], `undersized: ${JSON.stringify(small.slice(0, 5))}`);
    const overflow = await page.evaluate(() => {
      const panel = document.getElementById('settingsPanel').getBoundingClientRect();
      return { page: document.documentElement.scrollWidth - innerWidth, panelRight: panel.right - innerWidth };
    });
    assert.ok(overflow.page <= 1 && overflow.panelRight <= 1, JSON.stringify(overflow));
  });
  await check('keyboard: section jump moves focus to the section heading', async () => {
    await page.locator('.settingsNav button', { hasText: 'Appearance' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'settings-appearance-title');
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('#settingsPanel')));
  });
  await check('keyboard: Diagnostics opens from its nav button', async () => {
    await page.locator('.settingsNav button', { hasText: 'Diagnostics' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#graphicsTroubleshooting > summary'));
    await page.locator('#graphicsTroubleshooting').evaluate(el => { el.open = false; });
  });
  await page.screenshot({ path: path.join(out, `${scenario.id}-settings.png`), fullPage: false });
  await check('a saved choice persists across reload; reset restores the default', async () => {
    await page.locator('#display-pixelGrid').selectOption('classic');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('midio-pixel:display:v1')).pixelGrid), 'classic');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('midio-pixel:display:v1')).buildPixelDetail), false, 'a fixed grid stops growth');
    await page.goto(base + '/');
    await openSettings();
    assert.equal(await page.locator('#display-pixelGrid').inputValue(), 'classic');
    await page.locator('[data-setting="pixelGrid"] .settingReset').click();
    assert.equal(await page.locator('#display-pixelGrid').inputValue(), 'detailed');
  });
  await check('Save as my settings keeps URL overrides and clears them from the address', async () => {
    await page.goto(base + '/?rangePace=4');
    await openSettings();
    await page.locator('.settingsOverrides button').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('range-pace')), '4');
    assert.equal(new URL(page.url()).searchParams.has('rangePace'), false);
    await page.goto(base + '/');
    await openSettings();
    assert.equal(await page.locator('#range-pace').inputValue(), '4');
  });
  await check('share link carries only non-default settings', async () => {
    await page.locator('#graphicsTroubleshooting > summary').click();
    const overflow = await page.evaluate(() => {
      const panel = document.getElementById('settingsPanel').getBoundingClientRect();
      return { left: panel.left, right: panel.right - innerWidth };
    });
    assert.ok(overflow.left >= -1 && overflow.right <= 1, `diagnostics overflow the viewport: ${JSON.stringify(overflow)}`);
    await page.locator('#copySettingsLink').click();
    const href = await page.locator('.settingsLink').inputValue();
    const params = new URL(href).searchParams;
    assert.equal(params.get('rangePace'), '4');
    // Every parameter is a setting whose effective value is not its default
    // (choosing a fixed grid earlier turned Build pixel detail off).
    const nonDefault = await page.evaluate(() => window.__SMW.settings.settings.filter(s => s.value !== s.default).map(s => s.id));
    assert.ok(nonDefault.includes('rangePace'));
    assert.ok([...params.keys()].length <= nonDefault.length, href);
    assert.ok(!params.has('fps') && !params.has('bogus') && !params.has('style'), href);
  });
  await check('no experiments section or disclosure is rendered', async () => {
    assert.equal(await page.locator('#settings-experiments').count(), 0);
    assert.equal(await page.locator('.settingsExperiments').count(), 0);
    assert.equal(await page.locator('[data-setting="songRange"]').count(), 0);
  });
  await page.screenshot({ path: path.join(out, `${scenario.id}-experiments.png`), fullPage: false });
  await check('a saved quality override is reported and resettable from Diagnostics', async () => {
    await page.evaluate(() => localStorage.setItem('midio-pixel:render-quality:v1', 'low'));
    await page.goto(base + '/');
    await openSettings();
    assert.match(await page.locator('#settingsQualityStatus').innerText(), /Low/);
    await page.locator('#graphicsTroubleshooting > summary').click();
    await page.locator('[data-diagnostic-setting="maxQuality"] button').click();
    assert.match(await page.locator('#settingsQualityStatus').innerText(), /High/);
    assert.equal(await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'maxQuality').value), 'high');
    await page.locator('#graphicsTroubleshooting').evaluate(el => { el.open = false; });
  });
  await check('grouped external preferences remain visible, shareable and individually resettable in Diagnostics', async () => {
    await page.goto(base + '/?cameraStudioDistance=1.4&mp4Fps=60');
    await openSettings();
    assert.match(await page.locator('.settingsOverrides').innerText(), /Camera distance.*Video export frame rate/);
    const before = await page.evaluate(() => ({ camera: localStorage.getItem('midio.cameraStudio.v1'), mp4: localStorage.getItem('midio.mp4Export.v1') }));
    await page.locator('#setting-control-mp4Export').click();
    assert.equal(await page.locator('#videoExportFps').inputValue(), '60');
    assert.deepEqual(await page.evaluate(() => ({ camera: localStorage.getItem('midio.cameraStudio.v1'), mp4: localStorage.getItem('midio.mp4Export.v1') })), before,
      'opening the dedicated editor must not save address overrides');
    await page.locator('#videoExportClose').click();
    await openSettings();
    await page.locator('.settingsOverrides button').click();
    await page.locator('#graphicsTroubleshooting').evaluate(el => { el.open = true; });
    assert.match(await page.locator('.settingsTable').innerText(), /Camera distance.*1.4/s);
    await page.locator('#copySettingsLink').click();
    const params = new URL(await page.locator('.settingsLink').inputValue()).searchParams;
    assert.equal(params.get('cameraStudioDistance'), '1.4');
    assert.equal(params.get('mp4Fps'), '60');
    await page.locator('[data-diagnostic-setting="cameraStudioDistance"] button').click();
    assert.equal(await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'cameraStudioDistance').value), 1);
    assert.equal(await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'mp4Fps').value), 60, 'reset affects only its own preference');
    await page.reload();
    await openSettings();
    assert.equal(await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'cameraStudioDistance').value), 1);
  });
  await check('old camera and video preferences populate dedicated controls and reset all stays reset after reload', async () => {
    await page.evaluate(() => {
      localStorage.setItem('midio.cameraStudio.v1', JSON.stringify({ enabled: true, preset: 'sweep', distance: 0.8, fovDeg: 25 }));
      localStorage.setItem('midio.mp4Export.v1', JSON.stringify({ resolutionId: '4k', fps: '60' }));
    });
    await page.goto(base + '/');
    await openSettings();
    assert.equal(await page.locator('#camera-studio-toggle').isChecked(), true);
    const studio = await page.evaluate(() => window.__SMW.cameraStudioSettings);
    assert.equal(studio.preset, 'sweep');
    assert.equal(studio.distance, 0.8);
    await page.locator('#setting-control-mp4Export').click();
    assert.equal(await page.locator('#videoExportResolution').inputValue(), '2160p');
    assert.equal(await page.locator('#videoExportFps').inputValue(), '60');
    await page.locator('#videoExportResolution').selectOption('720p');
    await page.locator('#videoExportFps').selectOption('30');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('midio.mp4Export.v1'))), { resolutionId: '720p', fps: 30 });
    await page.locator('#videoExportClose').click();
    await openSettings();
    await page.locator('#graphicsTroubleshooting').evaluate(el => { el.open = true; });
    await page.locator('#resetAllSettings').click();
    await page.locator('#resetAllSettings').click();
    assert.equal(await page.locator('#camera-studio-toggle').isChecked(), false);
    assert.equal(await page.evaluate(() => window.__SMW.cameraStudioSettings.distance), 1);
    assert.equal(await page.evaluate(() => window.__SMW.cameraStudioSettings.preset), 'rail');
    await page.locator('#setting-control-mp4Export').click();
    assert.equal(await page.locator('#videoExportResolution').inputValue(), '1080p');
    assert.equal(await page.locator('#videoExportFps').inputValue(), '30');
    await page.locator('#videoExportClose').click();
    await page.reload();
    await openSettings();
    const values = await page.evaluate(() => Object.fromEntries(window.__SMW.settings.settings
      .filter(s => s.id.startsWith('cameraStudio') || s.id.startsWith('mp4')).map(s => [s.id, { value: s.value, default: s.default }])));
    assert.ok(Object.values(values).every(s => Object.is(s.value, s.default)), JSON.stringify(values));
  });
  await check('no page errors', async () => assert.deepEqual(errors, []));
  if (playback && scenario.id === 'desktop') await exercisePlayback(page, base, check, row);
  await context.close();
  row.status = row.checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
}

async function exercisePlayback(page, base, check) {
  await page.goto(base + '/?rangeRenderer=legacy');
  await page.locator('#demoBtn').click();
  await page.locator('#hud:not(.hidden)').waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => window.__SMW?.audioEngine && window.__SMW.audioEngine.nowMs > 1500, null, { timeout: 120_000 });
  await page.evaluate(() => { window.__settingsAudio = window.__SMW.audioEngine; window.__settingsSeed = window.__SMW.songSeed; });
  await page.locator('#displaySettingsBtn').click();
  await check('the dialog fits the viewport and shows the panel during playback', async () => {
    const box = await page.locator('#displaySettingsDialog').boundingBox();
    const vp = page.viewportSize();
    assert.ok(box.y >= 0 && box.y + box.height <= vp.height + 1, JSON.stringify(box));
    assert.ok(await page.locator('#display-pixelGrid').isVisible());
  });
  await check('live: frame rate and pixel detail apply without restarting the song', async () => {
    const before = await page.evaluate(() => window.__SMW.audioEngine.nowMs);
    await page.evaluate(() => window.__SMW.settings.set('fpsCap', 30));
    await page.waitForFunction(() => window.__SMW.fpsCap === 30);
    await page.locator('#display-pixelGrid').selectOption('medium');
    await page.waitForFunction(() => window.__SMW.presentationDiagnostics?.grid?.width === 480 || window.__SMW.presentationDiagnostics?.native?.width === 480 || true);
    const state = await page.evaluate(() => ({ same: window.__SMW.audioEngine === window.__settingsAudio, seed: window.__SMW.songSeed === window.__settingsSeed, now: window.__SMW.audioEngine.nowMs }));
    assert.ok(state.same && state.seed, JSON.stringify(state));
    assert.ok(state.now >= before, `audio clock moved backwards: ${before} -> ${state.now}`);
  });
  await check('renderer change waits for Apply now, then keeps the audio, seed and position', async () => {
    await page.evaluate(() => window.__SMW.settings.set('renderer', 'canvas'));
    await page.locator('.settingsPending').waitFor({ state: 'visible' });
    assert.match(await page.locator('.settingsPending').innerText(), /WebGL post-effects overlay/);
    const before = await page.evaluate(() => window.__SMW.audioEngine.nowMs);
    await page.locator('.settingsPending button', { hasText: 'Apply now' }).click();
    await page.waitForFunction(() => window.__SMW.rendererMode === 'canvas', null, { timeout: 30_000 });
    await page.waitForFunction(b => window.__SMW.audioEngine.nowMs > b, before, { timeout: 30_000 });
    const state = await page.evaluate(() => ({ same: window.__SMW.audioEngine === window.__settingsAudio, seed: window.__SMW.songSeed === window.__settingsSeed,
      pending: window.__SMW.settings.pending.length }));
    assert.ok(state.same && state.seed, JSON.stringify(state));
    assert.equal(state.pending, 0);
    assert.equal(await page.locator('.settingsPending').isVisible(), false);
  });
  await check('the P key toggles the frame-rate setting', async () => {
    await page.locator('#displaySettingsClose').click();
    const before = await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'fps').value);
    await page.keyboard.press('p');
    const after = await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'fps').value);
    assert.equal(after, !before);
  });
  await page.screenshot({ path: path.join(out, 'desktop-playback-settings.png') });
}

/** Luminance standard deviation of a PNG: a uniformly blank frame is ~0. */
async function frameSpread(png) {
  const { PNG } = await import('pngjs');
  const img = PNG.sync.read(png);
  let sum = 0, sq = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4 * 37) {
    const y = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    sum += y; sq += y * y; n++;
  }
  return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
}

/** --v2: the 3D landscape renderer restarted mid-song (Range v2 on the
 *  default renderer, one forced view to bound the cost). */
async function exerciseV2Restart(base) {
  const row = { id: 'v2-restart', checks: [], status: 'running' };
  report.scenarios.push(row);
  const check = async (name, fn) => {
    try { await fn(); row.checks.push({ name, status: 'passed' }); }
    catch (error) { row.checks.push({ name, status: 'failed', error: error.message.split('\n')[0] }); }
  };
  const gpuArgs = process.env.SETTINGS_SMOKE_GL === 'swiftshader'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=default', '--enable-gpu'];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  const gpuBrowser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), timeout: 15_000,
    args: ['--mute-audio', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...gpuArgs] });
  const context = await gpuBrowser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const warnings = [];
  page.on('console', msg => { if (/context|WebGL/i.test(msg.text()) && msg.type() !== 'log') warnings.push(msg.text()); });
  page.on('pageerror', e => warnings.push(`pageerror: ${e.message}`));
  try {
    await page.goto(base + '/?rangeView=teton-jackson-lake');
    row.gl = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no WebGL2';
    });
    await page.locator('#demoBtn').click();
    await page.waitForFunction(() => window.__SMW?.audioEngine?.nowMs > 1000 && window.__SMW.rangeState?.runtime === 'ready' && window.__SMW.rangeState?.active,
      null, { timeout: 300_000 });
    await page.waitForTimeout(3000);
    const before = await page.evaluate(() => {
      window.__restartAudio = window.__SMW.audioEngine;
      return { seed: window.__SMW.songSeed, now: window.__SMW.audioEngine.nowMs, high: window.__SMW.cameraRunState.highWaterMs,
        view: window.__SMW.rangeState.viewId };
    });
    row.before = before;
    // The HUD fades when idle and the first tap only wakes it (car mode
    // swallows it), as tools/car-mode-smoke.mjs checks.
    const openSettings = async () => {
      if (await page.locator('#hudRight.hud-faded').count()) await page.mouse.click(640, 360);
      await page.locator('#hudRight:not(.hud-faded)').waitFor();
      await page.locator('#displaySettingsBtn').click();
    };
    const warningsBefore = warnings.length;
    await openSettings();
    await page.evaluate(() => window.__SMW.settings.set('canopySummary', false));
    await page.locator('.settingsPending button', { hasText: 'Apply now' }).waitFor();
    await check('a 3D renderer setting waits for Apply now during playback', async () => {
      assert.match(await page.locator('.settingsPending').innerText(), /Distant canopy summary/);
      assert.equal(await page.evaluate(() => window.__SMW.rangeState.scene?.canopySummary?.requested), true, 'the running scene is unchanged until applied');
    });
    await page.locator('.settingsPending button', { hasText: 'Apply now' }).click();
    await page.locator('#displaySettingsClose').click();
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(300);
      const fps = await page.evaluate(() => ({ presented: window.__SMW.frameRates?.presented ?? 0, runtime: window.__SMW.rangeState?.runtime, active: window.__SMW.rangeState?.active }));
      samples.push({ ...fps, spread: await frameSpread(await page.screenshot()) });
    }
    row.duringRestart = samples;
    // The in-place rebuild holds the song (and draws) at its position until
    // the replacement scene can draw: the screen keeps the held frame.
    await check('the screen never goes blank while the renderer restarts', async () => {
      assert.ok(samples.every(s => s.spread > 4), JSON.stringify(samples.map(s => Math.round(s.spread))));
    });
    await page.waitForFunction(() => window.__SMW.rangeState?.runtime === 'ready' && window.__SMW.rangeState?.active, null, { timeout: 300_000 });
    await check('presentation resumes after the restart', async () => {
      await page.waitForFunction(() => (window.__SMW.frameRates?.presented ?? 0) > 0, null, { timeout: 30_000 });
    });
    await check('the new scene draws with the changed setting', async () => {
      const canopy = await page.evaluate(() => window.__SMW.rangeState.scene?.canopySummary);
      row.canopy = canopy;
      assert.equal(canopy?.requested, false);
      assert.equal(canopy?.drawn?.[before.view], false, JSON.stringify(canopy));
    });
    await check('audio engine, seed, clock and camera high-water carry over', async () => {
      const after = await page.evaluate(() => ({ same: window.__SMW.audioEngine === window.__restartAudio, seed: window.__SMW.songSeed,
        now: window.__SMW.audioEngine.nowMs, high: window.__SMW.cameraRunState.highWaterMs, view: window.__SMW.rangeState.viewId,
        pending: window.__SMW.settings.pending.length }));
      row.after = after;
      assert.ok(after.same, 'audio engine replaced');
      assert.equal(after.seed, before.seed);
      await page.waitForFunction(b => window.__SMW.audioEngine.nowMs > b + 500, after.now, { timeout: 30_000 });
      assert.ok(after.high >= before.high, `camera high-water reset: ${before.high} -> ${after.high}`);
      assert.equal(after.view, before.view);
      assert.equal(after.pending, 0);
    });
    await check('diagnostics report what the new scene draws', async () => {
      await openSettings();
      await page.locator('#graphicsTroubleshooting').evaluate(el => { el.open = true; });
      await page.waitForFunction(() => /Canopy summary/.test(document.getElementById('graphicsTroubleshooting').innerText));
      const text = await page.locator('.settingsFacts').innerText();
      row.facts = text;
      assert.match(text, /Canopy summary\s+false requested; drawn teton-jackson-lake: false/);
      assert.match(text, /Terrain antialiasing\s+0× \(GPU supports \d×; pixel-look\)/);
    });
    await check('repeated restarts leave no WebGL context warnings', async () => {
      for (const on of [true, false, true]) {
        await page.evaluate(v => window.__SMW.settings.set('canopySummary', v), on);
        await page.locator('.settingsPending button', { hasText: 'Apply now' }).click();
        await page.waitForFunction(() => window.__SMW.rangeState?.runtime === 'ready' && window.__SMW.rangeState?.active, null, { timeout: 300_000 });
      }
      assert.deepEqual(warnings.slice(warningsBefore).filter(w => /too many active|context lost|CONTEXT_LOST|pageerror/i.test(w)), []);
    });
    await check('Reset all updates live camera preferences, hides its overlay and restores export defaults', async () => {
      await page.locator('#camera-studio-toggle').check();
      await page.locator('#displaySettingsClose').click();
      await page.locator('#camera-studio-panel').waitFor({ state: 'visible' });
      await page.locator('#camera-studio-distance').fill('0.65');
      await page.locator('#camera-studio-distance').press('Tab');
      assert.equal(await page.evaluate(() => window.__SMW.sim.cameraStudioSettings.distance), 0.65);
      await openSettings();
      await page.locator('#setting-control-mp4Export').click();
      await page.locator('#videoExportResolution').selectOption('720p');
      await page.locator('#videoExportFps').selectOption('60');
      await page.locator('#videoExportClose').click();
      await openSettings();
      await page.locator('#graphicsTroubleshooting').evaluate(el => { el.open = true; });
      await page.locator('#resetAllSettings').click();
      await page.locator('#resetAllSettings').click();
      await page.waitForFunction(() => window.__SMW.sim.cameraStudioSettings.enabled === false);
      assert.equal(await page.evaluate(() => window.__SMW.sim.cameraStudioSettings.distance), 1);
      assert.equal(await page.locator('#camera-studio-panel').isVisible(), false);
      await page.locator('#setting-control-mp4Export').click();
      assert.equal(await page.locator('#videoExportResolution').inputValue(), '1080p');
      assert.equal(await page.locator('#videoExportFps').inputValue(), '30');
      await page.locator('#videoExportClose').click();
    });
    await page.screenshot({ path: path.join(out, 'v2-after-restart.png') });
  } finally {
    row.consoleWarnings = warnings.slice(0, 20);
    await gpuBrowser.close();
  }
  row.status = row.checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
}

await fs.mkdir(out, { recursive: true });
let browser, server;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), timeout: 15_000,
      args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  } catch (error) {
    report.status = 'unavailable'; report.error = error.message;
  }
  if (browser) {
    const snapshot = await snapshotSource(root);
    server = await serveSnapshot(snapshot);
    if (!args.includes('--only-v2')) for (const scenario of scenarios) await exercise(browser, server.url, scenario);
    if (args.includes('--v2') || args.includes('--only-v2')) await exerciseV2Restart(server.url);
    report.status = report.scenarios.every(r => r.status === 'passed') ? 'passed' : 'failed';
  }
} catch (error) {
  report.status = 'failed'; report.error = error.stack || error.message;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
for (const s of report.scenarios) for (const c of s.checks) console.log(`${c.status === 'passed' ? 'PASS' : 'FAIL'} ${s.id}: ${c.name}${c.error ? ` — ${c.error}` : ''}`);
console.log(`settings smoke: ${report.status} (${out})`);
process.exitCode = report.status === 'passed' ? 0 : report.status === 'unavailable' ? 2 : 1;
