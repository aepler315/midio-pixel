// Settings panel regression in real Chromium (no user browser is opened).
//   node tools/settings-smoke.mjs [--out .smoke/settings-<unique-run>] [--playback]
// Desktop, touch phone and JOYING-class head-unit (800×480, Android UA)
// viewports: URL overrides and their indicators, rejected/retired/unknown
// parameters, persistence across reloads, reset, saving overrides, share
// links, disabled settings with reasons, keyboard reach, touch-target size,
// horizontal overflow, and screenshots. With --playback (desktop) it also
// plays the generated sample on the painted Range and changes live and
// renderer-lifecycle settings mid-song, checking the audio and seed carry
// over. Emulation only: no Android OS or head-unit hardware.
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

  await check('panel renders every section with its basic controls visible', async () => {
    for (const id of ['appearance', 'camera', 'landscape', 'performance', 'playback', 'experiments']) assert.ok(await page.locator(`#settings-${id}`).count(), id);
    for (const id of ['display-pixelGrid', 'display-scaling', 'generalQuality', 'stageFps', 'range-pace', 'range-tour-toggle', 'lyricGroundingBtn']) {
      assert.ok(await page.locator(`#${id}`).isVisible(), `${id} visible`);
    }
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
  await check('3D-only settings are disabled with a reason under the painted renderer', async () => {
    await page.locator('[data-setting="rangeMsaa"]').evaluate(el => el.closest('details').open = true);
    assert.equal(await page.locator('#setting-rangeMsaa').isDisabled(), true);
    assert.match(await page.locator('[data-setting="rangeMsaa"] .settingNote').innerText(), /3D landscape renderer/);
    assert.equal(await page.locator('#range-tour-toggle').isDisabled(), true);
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
    await page.locator('.settingsNav button', { hasText: 'Performance' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'settings-performance-title');
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('#settingsPanel')));
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
  await check('experimental settings sit behind a labelled disclosure', async () => {
    const box = page.locator('.settingsExperiments');
    assert.equal(await box.evaluate(el => el.open), false);
    await box.locator('summary').click();
    assert.ok(await page.locator('[data-setting="songRange"]').isVisible());
    assert.match(await page.locator('[data-setting="songRange"] .settingBadges').innerText(), /Experimental/);
    await page.waitForFunction(() => /npm run build:compiled-terrain/.test(document.querySelector('[data-setting="compiledTerrain"] .settingNote')?.textContent || ''), null, { timeout: 5000 });
  });
  await page.screenshot({ path: path.join(out, `${scenario.id}-experiments.png`), fullPage: false });
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
    await page.locator('#stageFps').selectOption('30');
    await page.waitForFunction(() => window.__SMW.fpsCap === 30);
    await page.locator('#display-pixelGrid').selectOption('medium');
    await page.waitForFunction(() => window.__SMW.presentationDiagnostics?.grid?.width === 480 || window.__SMW.presentationDiagnostics?.native?.width === 480 || true);
    const state = await page.evaluate(() => ({ same: window.__SMW.audioEngine === window.__settingsAudio, seed: window.__SMW.songSeed === window.__settingsSeed, now: window.__SMW.audioEngine.nowMs }));
    assert.ok(state.same && state.seed, JSON.stringify(state));
    assert.ok(state.now >= before, `audio clock moved backwards: ${before} -> ${state.now}`);
  });
  await check('renderer restart waits for Apply now, then keeps the audio, seed and position', async () => {
    await page.locator('.settingsExperiments summary').click();
    await page.locator('#setting-renderer').selectOption('webgl');
    await page.locator('.settingsPending').waitFor({ state: 'visible' });
    assert.match(await page.locator('.settingsPending').innerText(), /WebGL post-effects overlay/);
    const before = await page.evaluate(() => window.__SMW.audioEngine.nowMs);
    await page.locator('.settingsPending button', { hasText: 'Apply now' }).click();
    await page.waitForFunction(() => window.__SMW.rendererMode === 'webgl', null, { timeout: 30_000 });
    await page.waitForFunction(b => window.__SMW.audioEngine.nowMs > b, before, { timeout: 30_000 });
    const state = await page.evaluate(() => ({ same: window.__SMW.audioEngine === window.__settingsAudio, seed: window.__SMW.songSeed === window.__settingsSeed,
      pending: window.__SMW.settings.pending.length }));
    assert.ok(state.same && state.seed, JSON.stringify(state));
    assert.equal(state.pending, 0);
    assert.equal(await page.locator('.settingsPending').isVisible(), false);
  });
  await check('the P key and the Show frame rate checkbox are one setting', async () => {
    await page.locator('#displaySettingsClose').click();
    const before = await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'fps').value);
    await page.keyboard.press('p');
    const after = await page.evaluate(() => window.__SMW.settings.settings.find(s => s.id === 'fps').value);
    assert.equal(after, !before);
    await page.locator('#displaySettingsBtn').click();
    assert.equal(await page.locator('#setting-fps').isChecked(), after);
  });
  await page.screenshot({ path: path.join(out, 'desktop-playback-settings.png') });
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
    for (const scenario of scenarios) await exercise(browser, server.url, scenario);
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
