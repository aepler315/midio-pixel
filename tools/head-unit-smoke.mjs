// Bounded Android head-unit shell regression. No user browser is opened.
//   node tools/head-unit-smoke.mjs [--out .smoke/head-unit-<unique-run>]
// Uses a generated WAV, ordinary library selection/playback, and the painted
// Range fixture used by other shell smokes. It does not assess Range v2 scenery
// or an Android OS file manager. Exit 2 means Chromium was unavailable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { withLegacyRange } from './lib/allWorlds.mjs';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--out', 'usage: head-unit-smoke.mjs [--out .smoke/<run>]');
const smokeRoot = path.join(root, '.smoke');
const out = path.resolve(root, args[1] || `.smoke/head-unit-${Date.now()}-${process.pid}`);
assert.ok(out.startsWith(smokeRoot + path.sep), 'capture evidence must stay in .smoke/');
const userAgent = 'Mozilla/5.0 (Linux; Android 10; HeadUnit) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.154 Mobile Safari/537.36';
const scenarios = [
  { id: 'head-unit', viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 },
  { id: 'portrait-dpr2', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
];
const plannedChecks = ['title final control clearance', 'no video controls', 'ordinary multi-file library chooser',
  'paused fullscreen physical dimensions and cover', 'fullscreen exit restores settings and redraws',
  'one current-frame PNG and playback/UI recovery'];
const report = {
  status: 'running', startedAt: new Date().toISOString(), userAgent, scenarios: [],
  fixture: { audio: 'generated 60-second WAV', world: 'Landscape, rangeRenderer=legacy',
    platformCapabilityShim: 'showDirectoryPicker unavailable, matching Android Chrome' },
  limits: ['Desktop Chromium with Android UA/viewport emulation; no Android OS or head-unit hardware.',
    'The OS chooser UI, Android download permissions and Range v2 GPU scenery are not covered.'],
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'download must be a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function state(page) {
  return page.evaluate(() => {
    const s = window.__SMW, canvas = document.getElementById('stage');
    const box = canvas.getBoundingClientRect();
    return { width: canvas.width, height: canvas.height, css: { x: box.x, y: box.y, width: box.width, height: box.height },
      viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
      fullscreen: !!document.fullscreenElement, paused: s.paused, playing: s.audioEngine.playing,
      timeMs: s.sim.timeMs, prefs: s.displayPrefs, scaling: s.renderer.output.presentation.scaling,
      frame: s.presentationDiagnostics.frame, integer: canvas.classList.contains('integerPixels') };
  });
}

async function press(page, selector) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await page.locator('#hudRight').evaluate(node => node.classList.contains('hud-faded'))) {
      await page.locator('#stage').click({ position: { x: 4, y: 4 } });
    }
    try { await page.locator(selector).click({ timeout: 3000, noWaitAfter: true }); return; }
    catch (error) { if (attempt === 2) throw error; }
  }
}

async function check(row, name, work) {
  const started = Date.now();
  try {
    const detail = await work();
    row.checks.push({ name, status: 'passed', elapsedMs: Date.now() - started, detail });
    console.log(`PASS ${row.id}: ${name}`);
  } catch (error) {
    row.checks.push({ name, status: 'failed', elapsedMs: Date.now() - started, error: error.stack || error.message });
    throw error;
  }
}

async function noVideoControls(page) {
  const names = await page.evaluate(() => [...document.querySelectorAll('button, select, [role="button"]')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
    .map(node => `${node.id} ${node.textContent} ${node.getAttribute('aria-label') || ''} ${node.title || ''}`.trim())
    .filter(name => /\bexport\b|\brecord(?:ing)?\s+video\b|\bstart\s+recording\b|\bsave\s+video\b|\brecordBtn\b/i.test(name)));
  assert.deepEqual(names, [], 'video export/record controls must not appear');
  return { unexpectedControls: names };
}

async function exercise(browser, url, audio, scenario) {
  const row = { ...scenario, checks: [], errors: [], status: 'running' };
  report.scenarios.push(row);
  const context = await browser.newContext({ viewport: scenario.viewport, deviceScaleFactor: scenario.deviceScaleFactor,
    userAgent, isMobile: true, hasTouch: true, acceptDownloads: true, serviceWorkers: 'block' });
  // Desktop Chromium exposes this desktop-only capability even with a mobile
  // UA. Remove it so the real Android fallback button/handler is exercised.
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
    const original = HTMLCanvasElement.prototype.toBlob;
    window.__headUnitPngProbe = [];
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      if (this.id === 'stage' && args[1] === 'image/png') {
        const button = document.getElementById('snapshotBtn');
        window.__headUnitPngProbe.push({ width: this.width, height: this.height,
          pixels: this.getContext('2d').getImageData(0, 0, this.width, this.height).data,
          busy: button.disabled && button.getAttribute('aria-busy') === 'true' });
      }
      return original.apply(this, args);
    };
  });
  await context.route('**/*', route => {
    const request = new URL(route.request().url());
    return request.origin === url || ['data:', 'blob:'].includes(request.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => row.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') row.errors.push(message.text()); });
  const downloads = [];
  page.on('download', download => downloads.push(download));
  try {
    await page.goto(withLegacyRange(url), { waitUntil: 'domcontentloaded' });
    await page.locator('#titleSettings > summary').click();
    await page.locator('#graphicsTroubleshooting > summary').click();
    await check(row, 'title final control clearance', async () => {
      await page.locator('#loader').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const geometry = await page.locator('#copyGraphicsReport').evaluate(button => {
        const box = button.getBoundingClientRect(), loader = document.getElementById('loader');
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { top: box.top, bottom: box.bottom, clearance: innerHeight - box.bottom,
          reachable: button === hit || button.contains(hit), scrollTop: loader.scrollTop,
          scrollHeight: loader.scrollHeight, clientHeight: loader.clientHeight };
      });
      assert.ok(geometry.scrollHeight > geometry.clientHeight, 'settings need a scrollable title');
      assert.ok(geometry.scrollTop > 0 && geometry.top >= 0 && geometry.clearance >= 60,
        `last control needs 60 CSS px clearance: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.reachable, true, 'last control must receive a real tap');
      await page.screenshot({ path: path.join(out, `${row.id}-title.png`) });
      return geometry;
    });
    await check(row, 'no video controls', () => noVideoControls(page));
    if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
    await page.locator('#display-pixelGrid').selectOption('classic');
    await page.locator('#display-scaling').selectOption('integer');
    await page.locator('#stageFps').selectOption('30');
    if (await page.locator('#range-tour-toggle').isChecked()) await page.locator('#range-tour-toggle').uncheck();
    await check(row, 'ordinary multi-file library chooser', async () => {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('#libraryFolderFallback').click(),
      ]);
      const input = await chooser.element().evaluate(node => ({ id: node.id, multiple: node.multiple,
        directory: node.hasAttribute('directory'), webkitdirectory: node.hasAttribute('webkitdirectory'), accept: node.accept }));
      assert.equal(input.id, 'libraryFolderInput');
      assert.equal(input.multiple, true);
      assert.equal(chooser.isMultiple(), true);
      assert.equal(input.directory || input.webkitdirectory, false, 'old Android must receive an ordinary file input');
      assert.match(input.accept, /audio\/\*/);
      await chooser.setFiles(audio);
      await page.locator('#libraryPanel[open] .libraryRow:not(.hidden)').first().waitFor();
      assert.equal(await page.locator('#libraryPanel .libraryRow:not(.hidden)').count(), 1);
      const title = await page.locator('#libraryPanel .libraryRowTitle').first().textContent();
      assert.match(title, /Head Unit Fixture/i, 'the actual selected audio must reach the library');
      return { input, libraryRows: 1, title };
    });
    await page.locator('#libraryPanel .libraryRow:not(.hidden)').first().click();
    await page.locator('#worldSelect[open]').waitFor({ timeout: 60_000 });
    await page.locator('.worldCard[data-base-world-id="alpine"] .worldCardPlayBtn').click();
    await page.waitForFunction(() => window.__SMW?.audioEngine?.playing && !window.__SMW.playbackPreparing
      && window.__SMW.presentationDiagnostics?.frame?.presented, null, { timeout: 60_000 });
    await noVideoControls(page);
    await press(page, '#pauseBtn');
    await page.waitForFunction(() => window.__SMW.paused && !window.__SMW.audioEngine.playing);
    const before = await state(page);
    assert.equal(before.fullscreen, false);
    assert.equal(before.prefs.scaling, 'integer');
    await check(row, 'paused fullscreen physical dimensions and cover', async () => {
      await press(page, '#fullscreenBtn');
      await page.waitForFunction(() => {
        const canvas = document.getElementById('stage');
        return !!document.fullscreenElement && canvas.width === Math.round(innerWidth * devicePixelRatio)
          && canvas.height === Math.round(innerHeight * devicePixelRatio) && window.__SMW.presentationDiagnostics.frame.presented;
      });
      const current = await state(page);
      assert.equal(current.paused, true);
      assert.equal(current.playing, false);
      assert.equal(current.timeMs, before.timeMs, 'fullscreen must redraw the held moment');
      assert.equal(current.scaling, 'cover');
      assert.deepEqual(current.prefs, before.prefs, 'temporary cover must not overwrite saved preferences');
      assert.equal(current.integer, false);
      assert.ok(Math.abs(current.css.x) < 1 && Math.abs(current.css.y) < 1);
      assert.ok(Math.abs(current.css.width - current.viewport.width) < 1 && Math.abs(current.css.height - current.viewport.height) < 1,
        'fullscreen canvas must cover the viewport');
      assert.ok(current.frame.frameId > before.frame.frameId, 'paused entry must present a new frame');
      await page.screenshot({ path: path.join(out, `${row.id}-fullscreen.png`) });
      return { before, fullscreen: current };
    });
    await check(row, 'fullscreen exit restores settings and redraws', async () => {
      const full = await state(page);
      await press(page, '#fullscreenBtn');
      await page.waitForFunction(() => !document.fullscreenElement && window.__SMW.presentationDiagnostics.frame.presented);
      const current = await state(page);
      assert.equal(current.paused, true);
      assert.equal(current.playing, false);
      assert.equal(current.timeMs, before.timeMs);
      assert.deepEqual(current.prefs, before.prefs);
      assert.equal(current.scaling, 'integer');
      assert.equal(current.integer, true);
      assert.deepEqual([current.width, current.height], [before.width, before.height]);
      assert.ok(current.frame.frameId > full.frame.frameId, 'paused exit must present a new frame');
      return current;
    });
    await press(page, '#pauseBtn');
    await page.waitForFunction(() => !window.__SMW.paused && window.__SMW.audioEngine.playing);
    await check(row, 'one current-frame PNG and playback/UI recovery', async () => {
      const prior = await state(page);
      assert.equal(await page.locator('#snapshotBtn').getAttribute('aria-label'), 'Save the current frame as a PNG');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        press(page, '#snapshotBtn'),
      ]);
      await page.waitForFunction(() => document.getElementById('snapshotBtn').getAttribute('aria-busy') === 'false'
        && !document.getElementById('snapshotBtn').disabled && !window.__SMW.paused && window.__SMW.audioEngine.playing);
      const filename = download.suggestedFilename();
      assert.match(filename, /^midio_\d{8}_classic\.png$/);
      const saved = path.join(out, `${row.id}-${filename}`);
      await download.saveAs(saved);
      const bytes = await fs.readFile(saved);
      assert.deepEqual(pngSize(bytes), { width: prior.width, height: prior.height }, 'Android PNG must retain live dimensions');
      const pixels = await page.evaluate(async encoded => {
        const records = window.__headUnitPngProbe;
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
        const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data, expected = records[0]?.pixels;
        let differences = 0;
        if (expected?.length !== actual.length) differences = -1;
        else for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) differences++;
        const colors = new Set();
        for (let i = 0; expected && i < expected.length; i += 4) colors.add(`${expected[i]},${expected[i + 1]},${expected[i + 2]}`);
        return { captures: records.length, busy: records[0]?.busy, differingChannels: differences, colors: colors.size };
      }, bytes.toString('base64'));
      assert.equal(pixels.captures, 1, 'one click must encode only the current detail level');
      assert.equal(pixels.busy, true, 'the snapshot must protect UI while encoding');
      assert.equal(pixels.differingChannels, 0, 'downloaded PNG must contain the exact captured frame');
      assert.ok(pixels.colors > 3, 'the saved frame must contain rendered scenery');
      await page.waitForFunction(time => window.__SMW.sim.timeMs > time + 100, prior.timeMs);
      await sleep(400);
      assert.equal(downloads.length, 1, 'one click must start exactly one download');
      const current = await state(page);
      assert.deepEqual(current.prefs, prior.prefs);
      assert.deepEqual([current.width, current.height], [prior.width, prior.height]);
      await press(page, '#pauseBtn');
      await page.waitForFunction(() => window.__SMW.paused);
      await press(page, '#pauseBtn');
      await page.waitForFunction(() => !window.__SMW.paused && window.__SMW.audioEngine.playing);
      assert.equal(await page.locator('#errorBanner:not(.hidden)').count(), 0, 'snapshot must not leave an error banner');
      return { filename, size: pngSize(bytes), downloads: downloads.length, pixels, recovered: current };
    });
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed'; row.error = error.stack || error.message;
    for (const name of plannedChecks) if (!row.checks.some(check => check.name === name)) row.checks.push({ name, status: 'unverified' });
    try { await page.screenshot({ path: path.join(out, `${row.id}-failure.png`), timeout: 3000 }); } catch { /* evidence is best effort */ }
  } finally {
    await context.close();
    if (row.errors.length) row.status = 'failed';
  }
}

await fs.mkdir(out, { recursive: true });
let browser, server, deadline;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
    || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'].find(existsSync);
  report.browser = { executablePath: executablePath || 'Playwright default', playwrightChromiumPath: chromium.executablePath(),
    playwrightChromiumExists: existsSync(chromium.executablePath()) };
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), timeout: 15_000,
      args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  } catch (error) {
    report.status = 'unavailable'; report.browser.error = error.message;
    report.unverified = scenarios.map(({ id }) => ({ id, checks: plannedChecks }));
  }
  if (browser) {
    report.browser.version = browser.version();
    deadline = setTimeout(() => { report.deadlineExceeded = true; void browser.close(); }, 180_000);
    const snapshot = await snapshotSource(root);
    report.sourceDigest = snapshot.digest;
    server = await serveSnapshot(snapshot);
    const audio = path.join(out, 'Head Unit Fixture.wav');
    execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audio, '120', '60'], { stdio: 'pipe', timeout: 15_000, windowsHide: true });
    for (const scenario of scenarios) await exercise(browser, server.url, audio, scenario);
    report.status = !report.deadlineExceeded && report.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
  }
} catch (error) {
  report.status = 'failed'; report.error = error.stack || error.message;
} finally {
  clearTimeout(deadline);
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`head-unit smoke: ${report.status} (report: ${path.join(out, 'report.json')})`);
if (report.status === 'unavailable') console.error(report.browser.error);
process.exitCode = report.status === 'passed' ? 0 : report.status === 'unavailable' ? 2 : 1;
