// Car mode: a wake-up tap must be swallowed, and every other tap must still
// reach the UI. Start npm start first. node tools/car-mode-smoke.mjs [url]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { withAllWorlds } from './lib/allWorlds.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
let failures = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route('**/soundfonts/', route => route.fulfill({ json: [] }));
  await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(withAllWorlds(url));
  await page.locator('#demoBtn').click();
  await page.locator('#worldSelect:not(.hidden)').waitFor();
  await page.locator('#worldChooseForMe').click();
  await page.locator('#hud:not(.hidden)').waitFor();
  await page.waitForFunction(() => !!window.__SMW?.carMode);

  const paused = () => page.evaluate(() => window.__SMW.sim && document.getElementById('pauseBtn').getAttribute('aria-pressed'));
  const run = async (name, check) => {
    try { await check(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  };

  // The HUD fades out after HUD_FADE_MS of no input and, once faded, sits
  // UNDER the canvas -- `pointer-events: none` on #hudLeft/#hudRight, by
  // design, so that a tap on a faded control reaches the stage instead of
  // being silently eaten (see hudIdleTick in main.js and docs/car-mode.md).
  // A driver therefore taps the screen to bring the HUD back and then taps
  // the control. This harness predates the fade and reached straight for
  // the button, so every click here failed with the canvas intercepting
  // pointer events -- a harness that had gone stale, not a broken control.
  // Perform the real sequence instead.
  /** Hand back a HUD with a FULL awake window in front of it: wait for the
   *  fade, then wake it with the canvas tap a driver would use. Checking
   *  "is it faded right now" and clicking if not is not enough -- the
   *  window is only 3s, and a check that lands near the end of one leaves
   *  the HUD to fade between the check and the click, which is a 30s
   *  timeout the run never recovers from. Waiting for the fade first makes
   *  the window deterministic.
   *  The wake tap itself is absorbed by main.js (`if (!hudAwake) {
   *  wakeHud(); return; }`), so it never doubles as a beat tap. */
  const freshHud = async () => {
    await page.waitForFunction(
      () => !!document.getElementById('hudRight')?.classList.contains('hud-faded'),
      null, { timeout: 10000 });
    await page.locator('#stage').click({ position: { x: 4, y: 4 } });
    await page.waitForFunction(
      () => !document.getElementById('hudRight')?.classList.contains('hud-faded'),
      null, { timeout: 5000 });
  };

  await run('a song run holds a wake lock', async () => {
    assert.equal(await page.evaluate(() => window.__SMW.carMode.keepAwake.enabled), true);
  });

  // Each of these reaches the HUD first and arms the idle state second: the
  // swallow is spent on whichever tap comes next, and that tap has to be
  // the one under test, not the one that brought the HUD back.

  await run('a long wait with no display sleep does not eat the next tap', async () => {
    const before = await paused();
    await freshHud();
    await page.evaluate(() => window.__SMW.carMode.backdateInput(60000));
    await page.locator('#pauseBtn').click();
    assert.notEqual(await paused(), before, 'idle alone must not absorb a tap');
    await page.locator('#pauseBtn').click();
  });

  await run('an ordinary tap still reaches the button', async () => {
    const before = await paused();
    await freshHud();
    await page.locator('#pauseBtn').click();
    assert.notEqual(await paused(), before, 'pause must toggle on a normal tap');
    await page.locator('#pauseBtn').click();
  });

  await run('the tap that wakes a blanked display is swallowed', async () => {
    const before = await paused();
    await freshHud();
    await page.evaluate(() => window.__SMW.carMode.simulateDisplaySleep(60000));
    await page.locator('#pauseBtn').click();
    assert.equal(await paused(), before, 'a wake-up tap must not toggle pause');
  });

  await run('the tap right after a wake-up tap works normally again', async () => {
    const before = await paused();
    await freshHud();
    await page.locator('#pauseBtn').click();
    assert.notEqual(await paused(), before, 'only the first tap is spent on waking');
    await page.locator('#pauseBtn').click();
  });

  await run('no page errors', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
}
console.log(failures === 0 ? 'car-mode smoke: OK' : `car-mode smoke: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
