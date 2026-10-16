// Smoke test for the SoundFont feature. Plays the demo, injects a test SF2,
// cycles fonts via raw mouse events (avoiding Playwright click timeout on the
// auto-hiding fontBar), and verifies the SF2 engine is active with zero page errors.
//
// Usage: node tools/smoke-soundfont.mjs [url]
import { chromium } from 'playwright';
import { buildMinimalSf2 } from '../test/helpers/sf2Fixture.js';

const url = process.argv[2] || 'http://localhost:5173';

const CHROMIUM_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);

async function launch() {
  for (const executablePath of CHROMIUM_CANDIDATES) {
    try { return await chromium.launch({ executablePath }); } catch { /* try next */ }
  }
  return chromium.launch();
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message));

let step = 0;
function checkpoint(label, cond) {
  step++;
  const ok = cond;
  console.log(`${ok ? '✔' : '✗'} Step ${step}: ${label}`);
  if (!ok) throw new Error(`Checkpoint ${step} failed: ${label}`);
}

// Mock the soundfonts/ manifest to empty BEFORE navigating: the real folder
// can (and, on this machine, does) hold gigabytes of real user-dropped
// fonts that would take minutes to fetch+parse sequentially and make every
// count this test asserts a moving target. This test is about the library
// API and switcher UI, not the real-folder auto-load mechanism (that's
// covered by smoke-multitrack.mjs), so a clean, deterministic empty
// baseline is the right environment for it.
await page.route('**/soundfonts/', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));

// Step 1: Load page and start demo
await page.goto(url, { waitUntil: 'load' });
await page.click('#demoBtn');
await page.waitForTimeout(1500);
checkpoint('Demo started', await page.evaluate(() => !!window.__SMW));
// Observe-only recommender: this test's fixture fonts are one-shot clicks
// the audition (rightly) disqualifies, and its assertions script exact
// active-font sequences. Recommendation policy is covered by
// smoke-recommend.mjs.
await page.evaluate(() => { window.__SMW.fontRecommender.autoApply = false; });

// Step 2: Verify font library + SF2 engine are exposed
checkpoint('fontLibrary exposed', await page.evaluate(() => !!window.__SMW.fontLibrary));
checkpoint('sf2Engine exposed', await page.evaluate(() => !!window.__SMW.sf2Engine));
checkpoint('SynthRouter is the synth', await page.evaluate(() => !!window.__SMW.synth));
checkpoint('library starts empty (manifest mocked)', await page.evaluate(() => window.__SMW.fontLibrary.count === 0));

// Step 3: Inject a test SoundFont via the library
const sf2Buffer = buildMinimalSf2('SmokeFont');
const sf2Bytes = Array.from(new Uint8Array(sf2Buffer));
const added = await page.evaluate(async (arr) => {
  const buf = new Uint8Array(arr).buffer;
  await window.__SMW.fontLibrary.addBuffer('smoke.sf2', buf);
  return window.__SMW.fontLibrary.count;
}, sf2Bytes);
checkpoint('SF2 added to library', added === 1);

// Step 4: Verify SF2 engine loaded the font
const sf2Loaded = await page.evaluate(() => !!window.__SMW.sf2Engine.sf2);
checkpoint('SF2 engine has loaded font', sf2Loaded);

// Step 5: Verify SynthRouter routes to SF2 (not fallback)
const routing = await page.evaluate(() => window.__SMW.synth.current === window.__SMW.sf2Engine);
checkpoint('Router routes to SF2 engine', routing);

// Step 6: Switch fonts via the new switcher popup (replaces the old </>
// arrow cycler). Add a second font, open the popup, click its row to
// activate it, and confirm the pill + fontLibrary both reflect the switch.
const sf2Bytes2 = Array.from(new Uint8Array(buildMinimalSf2('SecondFont')));
await page.evaluate(async (arr) => {
  await window.__SMW.fontLibrary.addBuffer('second.sf2', new Uint8Array(arr).buffer);
}, sf2Bytes2);
await page.click('#fontBarBtn');
const modalVisible = await page.evaluate(() => !document.getElementById('fontModal').classList.contains('hidden'));
checkpoint('font switcher popup opens', modalVisible);
const rowCount = await page.evaluate(() => document.querySelectorAll('#fontModalList .fontRow').length);
checkpoint('popup lists both fonts', rowCount === 2);
// Click the row for SecondFont specifically (order in the list follows
// fonts[] index order, so find it by its rendered name rather than assuming a position).
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#fontModalList .fontRow')].find((r) => r.textContent.includes('SecondFont'));
  row.click();
});
await page.waitForTimeout(100);
const fontName = await page.evaluate(() => document.getElementById('fontName')?.textContent);
checkpoint('Font name displayed', fontName === 'SecondFont');
await page.click('#fontModalClose');
const modalClosed = await page.evaluate(() => document.getElementById('fontModal').classList.contains('hidden'));
checkpoint('popup closes', modalClosed);

// Step 7: Verify SF2 synth is receiving note events
// Monkey-patch noteOn to count calls
const noteCount = await page.evaluate(() => {
  const engine = window.__SMW.sf2Engine;
  if (!engine._smokeOrigNoteOn) {
    engine._smokeOrigNoteOn = engine.noteOn;
    engine._smokeNoteCount = 0;
    engine.noteOn = function(evt) { this._smokeNoteCount++; this._smokeOrigNoteOn(evt); };
  }
  return engine._smokeNoteCount;
});
await page.waitForTimeout(2000); // let some notes play
const afterCount = await page.evaluate(() => window.__SMW.sf2Engine._smokeNoteCount);
checkpoint('SF2 synth received note events', afterCount > noteCount);

// Step 8: Verify zero page errors
checkpoint('Zero page errors', errors.length === 0);

// Screenshot
await page.screenshot({ path: '.smoke-soundfont.png' });
console.log(`\nSMOKE PASSED (${step}/${step} checkpoints, ${afterCount - noteCount} note events, ${errors.length} errors)`);
await browser.close();