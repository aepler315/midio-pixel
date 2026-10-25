// The HUD's pixel-detail stepper and every-level snapshot, in a real page.
//   node tools/detail-snapshot-smoke.mjs [--out .smoke/detail-snapshot-x]
// Serves the source tree, plays a generated song in Landscape, wakes the HUD
// with a tap on the stage, steps the detail level down and up, presses the
// snapshot button and checks the five downloads: one per level, named
// midio_YYYYMMDD_<level>.png, each a full 1920×1080 PNG, all different, and
// the player's own level and playback restored afterwards. Headless, muted.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS } from './current-routes-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const out = path.resolve(root, outArg >= 0 ? argv[outArg + 1] : `.smoke/detail-snapshot-${Date.now()}`);
const LEVELS = ['classic', 'classicPlus', 'medium', 'mediumPlus', 'detailed'];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf) {
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', 'not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

await fs.mkdir(out, { recursive: true });
const audio = path.join(out, 'fixture.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audio, '120', '120']);
const port = await freePort();
const server = spawn(process.execPath, [path.join(root, 'tools/serve.js'), String(port)], {
  cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SITE_ROOT: '' }, stdio: 'ignore', windowsHide: true,
});
const url = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, args: [...SWIFTSHADER_ARGS],
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
};
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const downloads = [];
  page.on('download', (d) => downloads.push(d));

  // The ordinary route (as test:routes): upload, then pick Landscape.
  await page.goto(`${url}/`);
  await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
  const lyrics = page.locator('#lyricGroundingBtn');
  if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
  await page.locator('#display-pixelGrid').selectOption('medium');
  await page.locator('#fileInput').setInputFiles(audio);
  await page.locator('#worldSelect[open]').waitFor({ timeout: 120_000 });
  await page.locator('.worldCard[data-base-world-id="alpine"] .worldCardPlayBtn').click();
  await page.waitForFunction(() => {
    const s = window.__SMW;
    return s?.sim && !s.playbackPreparing && s.audioEngine?.playing && s.presentationDiagnostics?.frame?.presented;
  }, null, { timeout: 120_000 });
  const label = () => page.locator('#detailLevel').textContent();
  const hudAwake = () => page.evaluate(() => !document.getElementById('hudRight').classList.contains('hud-faded'));
  // Software rendering makes each click slower than the HUD's 3 s fade; tap
  // the stage to wake it first, as a player would, then press the button.
  // noWaitAfter: the snapshot's five downloads are not a navigation to wait on.
  const press = async (selector) => {
    for (let attempt = 0; ; attempt++) {
      if (!await hudAwake()) await page.locator('#stage').click({ position: { x: 640, y: 200 } });
      try { await page.locator(selector).click({ timeout: 5_000, noWaitAfter: true }); return; } catch (error) {
        if (attempt >= 2) throw error; // faded between the wake and the click: wake and press again
      }
    }
  };

  await check('the controls appear when the screen is tapped', async () => {
    await page.waitForFunction(() => document.getElementById('hudRight').classList.contains('hud-faded'), null, { timeout: 10_000 });
    await page.locator('#stage').click({ position: { x: 640, y: 200 } });
    assert.equal(await hudAwake(), true);
    assert.equal(await page.locator('#detailControls').isVisible(), true);
    assert.equal(await page.locator('#snapshotBtn').isVisible(), true);
    assert.equal(await label(), 'Medium');
  });

  await check('- and + step the detail level and persist it', async () => {
    await press('#detailUpBtn');
    assert.equal(await label(), 'Medium+');
    await press('#detailUpBtn');
    assert.equal(await label(), 'Detailed');
    assert.equal(await page.locator('#detailUpBtn').isDisabled(), true, 'held at the finest level');
    for (let i = 0; i < 3; i++) await press('#detailDownBtn');
    assert.equal(await label(), 'Classic+');
    assert.equal(await page.locator('#display-pixelGrid').inputValue(), 'classicPlus', 'the Display menu follows');
    const stored = await page.evaluate(() => Object.entries(localStorage).map(([, v]) => v).join(' '));
    assert.match(stored, /classicPlus/, 'the choice is saved like the menu\'s');
  });

  await check('the snapshot saves five full-quality PNGs, one per level', async () => {
    const before = await page.evaluate(() => ({ time: window.__SMW.sim.timeMs }));
    if (!await hudAwake()) await page.locator('#stage').click({ position: { x: 640, y: 200 } });
    assert.equal(await page.locator('#snapshotBtn').isVisible(), true, 'the snapshot button shows on the woken HUD');
    // Five full-HD software renders keep the page busy for seconds, longer
    // than Playwright's click bookkeeping tolerates; press it from the page.
    await page.locator('#snapshotBtn').evaluate((button) => button.click());
    await page.waitForFunction(() => document.getElementById('snapshotBtn').getAttribute('aria-busy') === 'false'
      && !document.getElementById('snapshotBtn').disabled, null, { timeout: 120_000 });
    for (let i = 0; i < 50 && downloads.length < 5; i++) await page.waitForTimeout(100);
    assert.equal(downloads.length, 5, `expected 5 downloads, got ${downloads.length}`);
    const day = new Date();
    const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    const names = downloads.map((d) => d.suggestedFilename());
    assert.deepEqual(names, LEVELS.map((l) => `midio_${stamp}_${l}.png`));
    const hashes = new Set();
    for (const d of downloads) {
      const file = path.join(out, d.suggestedFilename());
      await d.saveAs(file);
      const buf = await fs.readFile(file);
      assert.deepEqual(pngSize(buf), { width: 1920, height: 1080 }, `${d.suggestedFilename()} is not full 1920x1080`);
      hashes.add(createHash('sha256').update(buf).digest('hex'));
    }
    assert.equal(hashes.size, 5, 'each level is its own render');
    assert.ok(before.time > 0);
  });

  await check('the player\'s level and playback come back afterwards', async () => {
    assert.equal(await label(), 'Classic+');
    assert.equal(await page.locator('#display-pixelGrid').inputValue(), 'classicPlus');
    const state = await page.evaluate(() => ({ paused: window.__SMW.paused, playing: window.__SMW.audioEngine.playing, w: document.getElementById('stage').width }));
    assert.equal(state.paused, false, 'playback resumed');
    assert.notEqual(state.w, 1920, 'the stage is back to its live size');
  });

  await check('no page errors', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `detail-snapshot smoke: ${failures} failing (evidence in ${out})` : `detail-snapshot smoke: OK (evidence in ${out})`);
process.exit(failures ? 1 : 0);
