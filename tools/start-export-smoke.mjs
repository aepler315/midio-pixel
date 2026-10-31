// Front-screen and playback regression. Run against a local server with a
// separate headless browser; evidence stays in the ignored smoke directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8091';
const out = path.resolve(process.argv[3] || '.smoke/start-screen');
const world = process.argv[4] || 'Trio';
assert.ok(['Trio', 'Landscape'].includes(world));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
const check = (name, actual) => { assert.ok(actual, name); checks.push(name); console.log('PASS', name); };
try {
  const target = new URL(url); target.searchParams.set('rangeRenderer', 'legacy');
  await page.goto(target.href);
  check('Random song is visible on the front screen', await page.locator('#randomSongBtn').isVisible());
  check('video recording controls are absent', await page.locator('#exportSetup, #recordBtn, #cancelExportBtn').count() === 0);
  await page.locator('#titleSettings').evaluate(el => { el.open = true; });
  await page.locator('#generalQuality').focus();
  await page.locator('#generalQuality').press('Home');
  await page.reload();
  check('general quality persists', await page.locator('#generalQuality').inputValue() === '0');
  await page.locator('#titleSettings').evaluate(el => { el.open = true; });
  if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
  const folder = path.join(out, 'music'); await fs.mkdir(folder, { recursive: true });
  for (const name of ['first', 'second']) execFileSync(process.execPath, ['tools/gen-test-wav.mjs', path.join(folder, `${name}.wav`), '120', '30']);
  await page.locator('#libraryFolderInput').setInputFiles(folder);
  await page.waitForFunction(() => document.querySelectorAll('#libraryRecent .recentChip').length === 2);
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  const playRandom = async () => {
    await page.locator('#randomSongBtn').click();
    await page.getByRole('button', { name: `Play in ${world}`, exact: true }).click({ timeout: 120000 });
    await page.waitForFunction(() => window.__SMW?.sim && !window.__SMW.paused && window.__SMW.renderReadiness?.status === 'ready');
    return page.evaluate(() => window.__SMW.trackIdentity?.title);
  };
  const first = await playRandom();
  check('the general quality slider reaches the live renderer', await page.evaluate(() => window.__SMW.perf.level === 6));
  await page.locator('#stopBtn').click({ force: true });
  const second = await playRandom();
  check('random song avoids immediately repeating the last library track', !!first && !!second && first !== second);
  await page.locator('#stopBtn').click({ force: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'mobile-start.png'), fullPage: true });
  check('mobile layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('no uncaught page errors', errors.length === 0);
} finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ world, checks, errors }, null, 2));
  await browser.close();
}
