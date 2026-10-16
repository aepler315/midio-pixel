// Smoke test for the per-MIDI SoundFont recommendation engine
// (FontRecommender + FontAudition). Injects three fixture fonts — one
// healthy, one silent, one playing two octaves low — drops a generated
// multi-track MIDI, and verifies the engine auditions all three, hard-
// disqualifies the broken two (with the right reasons), auto-activates the
// healthy one, badges the switcher popup, and honors a manual user pick
// until the next song.
//
// Usage: node tools/smoke-recommend.mjs [url]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAuditionSf2 } from '../test/helpers/sf2Fixture.js';

const url = process.argv[2] || 'http://localhost:5173';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));

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

// Fixture MIDI: 12 bars, drums/bass/pad/melody — same generator the other
// smoke tests use, written to a temp file so this test is self-contained.
const midPath = path.join(os.tmpdir(), `smw-recommend-${process.pid}.mid`);
execFileSync(process.execPath, [path.join(toolsDir, 'gen-test-midi.mjs'), midPath, '12']);
const midBytes = Array.from(fs.readFileSync(midPath));

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message));

let step = 0;
function checkpoint(label, cond) {
  step++;
  console.log(`${cond ? '✔' : '✗'} Step ${step}: ${label}`);
  if (!cond) throw new Error(`Checkpoint ${step} failed: ${label}`);
}

// Deterministic empty library baseline (the real soundfonts/ folder may
// hold anything) — same rationale as smoke-soundfont.mjs.
await page.route('**/soundfonts/', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));

await page.goto(url, { waitUntil: 'load' });

// Boot audio + library WITHOUT starting a song yet: the demo button boots
// everything, and we need fontLibrary to exist to inject fixtures.
await page.click('#demoBtn');
await page.waitForFunction(() => !!window.__SMW?.fontLibrary);

// Inject fonts. Order matters: the SILENT font goes first so it becomes the
// auto-activated font. The demo song is already playing and gets auditioned
// like any MIDI, so fonts added now are auditioned as they land — the
// engine should already refuse to sit on the silent font.
const fonts = [
  { name: 'SilentFont', bytes: Array.from(new Uint8Array(buildAuditionSf2({ name: 'SilentFont', silent: true }))) },
  { name: 'RumbleFont', bytes: Array.from(new Uint8Array(buildAuditionSf2({ name: 'RumbleFont', rootKey: 84 }))) }, // plays 2 octaves low
  { name: 'GoodFont', bytes: Array.from(new Uint8Array(buildAuditionSf2({ name: 'GoodFont', rootKey: 60 }))) },
];
for (const f of fonts) {
  await page.evaluate(async ({ name, bytes }) => {
    await window.__SMW.fontLibrary.addBuffer(name, new Uint8Array(bytes).buffer);
  }, f);
}
checkpoint('three fixture fonts injected', await page.evaluate(() =>
  window.__SMW.fontLibrary.count === 3));

// Demo-phase rescue: once every font's audition lands, the engine must have
// walked away from the silent first font on its own.
await page.waitForFunction(() => window.__SMW?.fontRecommender?.isDone(), null, { timeout: 90000 });
checkpoint('demo-song audition rescued playback from the silent font', await page.evaluate(() =>
  window.__SMW.fontLibrary.active?.name === 'GoodFont'));

// Drop the MIDI through the global drop path (mid-song hotswap) — this must
// start a FRESH audition run against the new song. The generation counter
// bumps synchronously when the new run starts, so waiting on it is race-free.
const genBefore = await page.evaluate(() => window.__SMW.fontRecommender._gen);
await page.evaluate(({ bytes }) => {
  const file = new File([new Uint8Array(bytes)], 'fixture.mid', { type: 'audio/midi' });
  const dt = new DataTransfer();
  dt.items.add(file);
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
}, { bytes: midBytes });

await page.waitForFunction((g) =>
  window.__SMW?.fontRecommender?._gen > g && window.__SMW.fontRecommender.isDone(),
genBefore, { timeout: 90000 });
checkpoint('per-MIDI audition completed for all fonts', true);

const verdicts = await page.evaluate(() =>
  window.__SMW.fontLibrary.fonts.map((f) => ({ name: f.name, review: f.review })));
console.log('   verdicts:', JSON.stringify(verdicts.map((v) => ({
  name: v.name, status: v.review?.status, dq: v.review?.dq, score: v.review?.score,
}))));

const byName = Object.fromEntries(verdicts.map((v) => [v.name, v.review]));
checkpoint('hard rule: silent output disqualified as "silent"',
  byName.SilentFont?.status === 'disqualified' && byName.SilentFont?.dq === 'silent');
checkpoint('hard rule: octaves-low output disqualified as "register"',
  byName.RumbleFont?.status === 'disqualified' && byName.RumbleFont?.dq === 'register');
checkpoint('healthy font qualified with a positive score',
  byName.GoodFont?.status === 'ok' && byName.GoodFont.score > 0);

checkpoint('engine auto-activated the healthy font (rescued from silence)',
  await page.evaluate(() => window.__SMW.fontLibrary.active?.name === 'GoodFont'));
checkpoint('recommendation points at the healthy font',
  await page.evaluate(() =>
    window.__SMW.fontLibrary.fonts[window.__SMW.fontRecommender.recommendedIndex]?.name === 'GoodFont'));

// Switcher popup: star on the recommended row, warning badges on the two
// disqualified rows, summary line naming the best fit.
await page.keyboard.press('f');
await page.waitForSelector('#fontModal:not(.hidden)');
checkpoint('popup shows 1 recommended star', await page.locator('.fontRowStar').count() === 1);
checkpoint('popup shows 2 disqualification badges', await page.locator('.fontRowBadge.dq').count() === 2);
checkpoint('popup shows a numeric fit score on the healthy font',
  await page.locator('.fontRowBadge.ok').count() === 1);
const statusText = await page.locator('#fontAuditionStatus').textContent();
checkpoint('status line names the best fit', /Best fit/.test(statusText) && /GoodFont/.test(statusText));

// Manual pick pins for the rest of this song: choose the rumbling font on
// purpose; the recommender must respect it and stop auto-switching.
await page.evaluate(() => {
  document.querySelector('.fontRow[data-index="1"] .fontRowName').click();
});
checkpoint('manual pick activates the chosen font', await page.evaluate(() =>
  window.__SMW.fontLibrary.active?.name === 'RumbleFont'));
checkpoint('manual pick is pinned', await page.evaluate(() =>
  window.__SMW.fontRecommender.userPinned === true));

// A NEW song clears the pin and re-auditions — the engine takes back over.
const genBeforeSecond = await page.evaluate(() => window.__SMW.fontRecommender._gen);
await page.evaluate(({ bytes }) => {
  const file = new File([new Uint8Array(bytes)], 'fixture2.mid', { type: 'audio/midi' });
  const dt = new DataTransfer();
  dt.items.add(file);
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
}, { bytes: midBytes });
await page.waitForFunction((g) =>
  window.__SMW?.fontRecommender?._gen > g && window.__SMW.fontRecommender.isDone(),
genBeforeSecond, { timeout: 90000 });
checkpoint('next song: pin cleared and healthy font re-selected', await page.evaluate(() =>
  window.__SMW.fontRecommender.userPinned === false
  && window.__SMW.fontLibrary.active?.name === 'GoodFont'));

checkpoint('zero page errors', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));

await browser.close();
fs.rmSync(midPath, { force: true });
console.log('smoke-recommend: all checkpoints passed');
