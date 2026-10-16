// Every registered world, through real upload, analysis, selection, playback
// and seeking -- plus a per-pass paint audit of the frame each one composes.
// Start npm start first. Usage: node tools/worlds-smoke.mjs [url] [outDir]
//
// WHY THE PAINT AUDIT. This harness used to cover three of the eight worlds
// and assert that each frame held more than sixteen distinct colors. That is
// a liveness check: it proves something rendered, not that the right things
// did. BiomeManager's fata morgana was called every frame for a week while
// drawing exactly zero pixels -- the call landed in a same-named method with
// a different signature -- and nothing here could have noticed, because the
// rest of the frame was as colorful as ever. The same blind spot had already
// swallowed ConstellationWeaver, SkyVoyage's trail and the meteor volleys for
// six world kinds when each kind was split into its own draw function and
// the deep-sky layer was not ported across (see BiomeManager.draw).
//
// So the audit wraps individual draw passes and measures what each one
// actually changes on the stage, rather than judging the composite. A pass
// that runs and paints nothing is now a failure with a name attached.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { renderWorldFrame, worldAnalysisReady } from './world-frame.mjs';
import { withAllWorlds } from './lib/allWorlds.mjs';
import { worldMotionAudit } from './lib/world-motion-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8080';
const out = path.resolve(process.argv[3] || path.join(root, '.smoke/worlds'));

async function saveStage(page, destination) {
  const data = await page.evaluate(() => document.querySelector('#stage').toDataURL('image/png'));
  await fs.writeFile(destination, Buffer.from(data.split(',')[1], 'base64'));
}

// Every world on the select screen. `kind` is what BiomeManager reports once
// the world is live -- picking a card builds a per-song VARIANT of that base
// world (see main.js), so the id changes but the kind does not.
//
// `mustPaint` are passes that cannot legitimately draw nothing in this world
// on a settled frame at full quality. Kept deliberately short: the point is a
// tripwire on the passes every frame depends on, not a second copy of each
// world's draw order. `watch` is recorded into report.json without being
// asserted, so a pass that quietly stops painting is visible in a diff even
// where it is allowed to vary.
//
// `mustNotPaint` protects interiors from astronomical layers.
// The positive lists name only passes the world actually invokes -- a pass listed for
// a world that never calls it would sit at zero forever and read like a
// finding. `drawDeepSky` is the reason `watch` exists and cannot be promoted:
// it runs in five worlds and legitimately paints nothing on a 32-second
// fixture, because the Star Atlas is still empty and Midasus has not left on
// a sky voyage yet. Watching it means a real regression -- the deep-sky layer
// going missing again, as it did once already -- still shows up in the diff.
const WORLDS = [
  { name: 'The Range', kind: 'alpine',
    // The Range keeps its existing terrain/water composition and reserves
    // the major upper-sky form for SpaceRidge. Its retired foreground ground
    // bar must stay absent (including the explicit renderer fallback).
    mustPaint: ['_drawSky', '_drawFarShore', '_drawOcean', '_drawLayer'],
    mustNotPaint: ['_drawGround', '_drawFataMorgana', '_drawGodRays'],
    watch: ['drawDeepSky', '_drawStarfield'] },
  { name: 'After Hours', kind: 'city',
    mustPaint: ['_drawSky', '_drawGround'],
    watch: ['drawDeepSky', '_drawHaze', '_drawFogBanks', '_drawMoon'] },
  { name: 'Far Side', kind: 'airless',
    mustPaint: ['_drawSky', '_drawGround'],
    watch: ['drawDeepSky'] },
  { name: 'The Fathom', kind: 'abyssal',
    mustPaint: ['_drawSky', '_drawGround'],
    watch: ['_drawCelestial'], mustNotPaint: ['_drawStarfield', 'drawDeepSky'] },
  { name: 'Redline', kind: 'strip',
    mustPaint: ['_drawSky', '_drawGround', '_drawSignature'],
    watch: ['drawDeepSky', '_drawMoon'] },
  { name: 'The Foundry', kind: 'foundry',
    mustPaint: ['_drawSky', '_drawGround', '_drawSignature'],
    watch: [], mustNotPaint: ['_drawStarfield', 'drawDeepSky', '_drawMoon', '_drawCelestial'] },
  { name: 'Understory', kind: 'overgrowth',
    mustPaint: ['_drawSky', '_drawGround', '_drawSignature'],
    watch: [], mustNotPaint: ['_drawStarfield', 'drawDeepSky', '_drawMoon', '_drawCelestial'] },
  { name: 'The Nave', kind: 'nave',
    mustPaint: ['_drawSky', '_drawGround', '_drawSignature'],
    watch: ['_drawCelestial'], mustNotPaint: ['_drawStarfield', 'drawDeepSky'] },
];

await fs.mkdir(out, { recursive: true });
const wav = path.join(out, 'worlds-fixture.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '32']);
const buffer = await fs.readFile(wav);
const rate = buffer.readUInt32LE(24);
for (let i = 44; i < buffer.length; i += 2) {
  const seconds = (i - 44) / 2 / rate;
  // Quiet opening, energetic middle, then return. Keep the same notes so
  // dynamic response can be compared without a different song/tempo.
  const gain = seconds < 10 || seconds >= 24 ? 0.12 : 1;
  buffer.writeInt16LE(Math.round(buffer.readInt16LE(i) * gain), i);
}
await fs.writeFile(wav, buffer);

/** Runs in the page: wrap each named pass, draw one frame, and report how
 *  many stage pixels each call changed. Returns {pass: {calls, paintedPx}}. */
const PAINT_AUDIT = ({ names, quality = 0 }) => {
  const { sim, renderer, perf } = window.__SMW;
  const mgr = sim.biomes;
  const proto = Object.getPrototypeOf(mgr);
  const stage = document.querySelector('#stage');
  const scratch = document.createElement('canvas');
  scratch.width = stage.width; scratch.height = stage.height;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const snapshot = () => {
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.drawImage(stage, 0, 0);
    return sctx.getImageData(0, 0, scratch.width, scratch.height).data;
  };
  const changed = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
    }
    return n;
  };

  const stats = {};
  const originals = new Map();
  for (const name of names) {
    const fn = proto[name];
    if (typeof fn !== 'function') { stats[name] = { calls: 0, paintedPx: 0, missing: true }; continue; }
    originals.set(name, fn);
    stats[name] = { calls: 0, paintedPx: 0 };
    proto[name] = function wrapped(...args) {
      const before = snapshot();
      const result = fn.apply(this, args);
      stats[name].calls++;
      stats[name].paintedPx += changed(before, snapshot());
      return result;
    };
  }
  try {
    // Full quality for the audited frame: a shed rung legitimately turns
    // whole passes off, which would read as "painted nothing".
    if (perf) perf.level = quality;
    renderer.draw(sim, 1);
  } finally {
    for (const [name, fn] of originals) proto[name] = fn;
  }
  return stats;
};


const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const report = { passed: false, seed: 315, viewport: { width: 1280, height: 720 }, browser: browser.version(), timingScope: 'Headless JS draw submission; not GPU time or device FPS', worlds: [] };
// Explicit opt-in only for pre-signature historical refactor comparisons.
if (process.env.WORLD_CAPTURE_REVISION) {
  report.historicalRevision = process.env.WORLD_CAPTURE_REVISION;
  for (const world of WORLDS) world.mustPaint = world.mustPaint.filter(name => name !== '_drawSignature');
}
const failures = [];

// Accessibility preferences (A1/A2): reduced flashing and reduced motion are
// separate, persisted, and reachable by pointer, keyboard (Enter/Space on
// the chip and the R shortcut) and assistive technology (aria-pressed). Run
// at a desktop and a phone viewport, and once with storage blocked while
// the OS asks for reduced motion.
async function preferenceSmoke(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/soundfonts/', route => route.fulfill({ json: [] }));
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    const entry = new URL(url);
    entry.searchParams.set('seed', '315');
    const open = async () => {
      await page.goto(withAllWorlds(entry.href));
      await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
    };
    const state = () => page.evaluate(() => ({
      flashPressed: document.querySelector('#reducedFlashBtn').getAttribute('aria-pressed'),
      motionPressed: document.querySelector('#reducedMotionBtn').getAttribute('aria-pressed'),
      flashLabel: document.querySelector('#reducedFlashBtn').textContent,
      storedFlash: localStorage.getItem('smw:reducedFlash'), storedMotion: localStorage.getItem('smw:reducedMotion'),
      simFlash: window.__SMW?.sim ? !!window.__SMW.sim.reducedFlash : null,
      simMotion: window.__SMW?.sim ? !!window.__SMW.sim.reducedMotion : null,
    }));
    await open();
    const flash = page.locator('#reducedFlashBtn'), motion = page.locator('#reducedMotionBtn');
    assert.ok(await flash.isVisible(), `reduced-flash chip is visible at ${viewport.width}x${viewport.height}`);
    let s = await state();
    assert.deepEqual([s.flashPressed, s.motionPressed], ['false', 'false']);
    await flash.click();
    s = await state();
    assert.deepEqual([s.flashPressed, s.flashLabel, s.storedFlash, s.motionPressed], ['true', 'Reduced flashing: on', '1', 'false'], 'pointer toggles reduced flash only');
    await flash.focus();
    await page.keyboard.press('Enter');
    assert.equal((await state()).flashPressed, 'false', 'Enter toggles the chip');
    await page.keyboard.press(' ');
    assert.equal((await state()).flashPressed, 'true', 'Space toggles the chip');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('r');
    s = await state();
    assert.deepEqual([s.flashPressed, s.storedFlash], ['false', '0'], 'R reaches the same toggle, chip included');
    await page.keyboard.press('r');
    await motion.click();
    s = await state();
    assert.deepEqual([s.flashPressed, s.motionPressed, s.storedMotion], ['true', 'true', '1'], 'motion is independent of flash');
    // Reload: both persist. A song then starts with both applied, and seeking keeps them.
    await open();
    s = await state();
    assert.deepEqual([s.flashPressed, s.motionPressed], ['true', 'true'], 'reload preserves both preferences');
    await page.locator('#fileInput').setInputFiles(wav);
    await page.locator('#worldSelect:not(.hidden)').waitFor({ timeout: 90000 });
    await page.locator('.worldCard').filter({ has: page.getByText('After Hours', { exact: true }) }).click();
    await page.waitForFunction(() => window.__SMW?.sim?.timeMs > 500, null, { timeout: 60000 });
    s = await state();
    assert.deepEqual([s.simFlash, s.simMotion], [true, true], 'a started song receives both preferences');
    await page.evaluate(() => { document.querySelector('#pauseBtn').click(); window.__SMW.seek(8000); window.__SMW.seek(2000); });
    s = await state();
    assert.deepEqual([s.simFlash, s.simMotion], [true, true], 'seeking preserves both preferences');
    await page.keyboard.press('r');
    s = await state();
    assert.deepEqual([s.simFlash, s.simMotion, s.flashPressed], [false, true, 'false'], 'R during playback changes flash only, and the chip follows');
    assert.deepEqual(errors, [], 'preference smoke has no browser errors');
  } finally { await context.close(); }

  // Blocked storage with the OS asking for reduced motion: both default on,
  // and the chip still toggles for this session.
  const blocked = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  try {
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const page = await blocked.newPage();
    await page.route('**/soundfonts/', route => route.fulfill({ json: [] }));
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    await page.goto(withAllWorlds(new URL(url).href));
    await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
    const pressed = () => page.evaluate(() => ['#reducedFlashBtn', '#reducedMotionBtn'].map(q => document.querySelector(q).getAttribute('aria-pressed')));
    assert.deepEqual(await pressed(), ['true', 'true'], 'OS reduction applies to both when storage is blocked');
    await page.locator('#reducedFlashBtn').click();
    assert.deepEqual(await pressed(), ['false', 'true'], 'the chip works without storage');
  } finally { await blocked.close(); }
}

try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await preferenceSmoke(viewport);
    console.log(`PASS preferences ${viewport.width}x${viewport.height}: reduced flash (pointer, Enter, Space, R), reduced motion, persistence, blocked storage`);
  }
  for (const world of WORLDS) {
    const { name, kind } = world;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
      await page.route('**/soundfonts/', route => route.fulfill({ json: [] }));
      await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
      const entry = new URL(url);
      entry.searchParams.set('seed', '315');
      entry.searchParams.set('perf', 'high'); // start the ladder at full quality
      await page.goto(withAllWorlds(entry.href));
      // The title screen's settings live behind a disclosure now, so that a
      // returning player's first screenful is their music rather than a
      // wall of preferences. Open it before reaching for one.
      await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
      const lyrics = page.locator('#lyricGroundingBtn');
      if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
      await page.locator('#display-pixelGrid').selectOption('classic');
      await page.locator('#fileInput').setInputFiles(wav);
      await page.locator('#worldSelect:not(.hidden)').waitFor({ timeout: 90000 });
      assert.ok(await page.locator('.worldCardPreviewNote').isVisible(), 'Range illustration label is visible');
      assert.match(await page.locator('.worldCardPreviewNote').textContent(), /illustration/);
      await page.locator('.worldCard').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.waitForFunction(() => window.__SMW?.sim?.timeMs > 1200, null, { timeout: 60000 });
      const liveState = await page.evaluate(() => {
        document.querySelector('#pauseBtn').click();
        const mgr = window.__SMW.sim.biomes;
        return { kind: mgr.world.kind, rhythmMs: mgr.worldRhythm?.tMs };
      });
      assert.equal(liveState.kind, kind);
      assert.ok(Number.isFinite(liveState.rhythmMs), name + ' receives detected rhythm during live playback');
      // This fixture exceeds the opening-analysis threshold. Do not compare
      // later passages against its clamped 15-second tail or mix admissions.
      await page.waitForFunction(worldAnalysisReady, { throughMs: 27000 }, { timeout: 180000 });
      const analysisState = await page.evaluate(() => {
        const { sim } = window.__SMW;
        const curves = sim.energyCurves;
        return { opening: sim.analysisOpening, frames: curves.n, rateHz: curves.rateHz,
          spanMs: (curves.n - 1) * 1000 / curves.rateHz };
      });
      // Pause after real playback, then verify an actual backward seek in
      // one page task. A wall-clock wait for 4.5–12s could miss that entire
      // interval on a loaded software renderer and fail after song end.
      // R is the reduced-FLASH shortcut; reduced motion is its own chip.
      await page.keyboard.press('r');
      const seekTimes = await page.evaluate(() => {
        window.__SMW.seek(8000);
        const before = window.__SMW.sim.timeMs - window.__SMW.sim.visualLeadMs;
        window.__SMW.seek(4000);
        return { before, after: window.__SMW.sim.timeMs - window.__SMW.sim.visualLeadMs };
      });
      assert.ok(Math.abs(seekTimes.before - 8000) < 20, name + ' reaches the first seek destination');
      assert.ok(Math.abs(seekTimes.after - 4000) < 20, name + ' seeks backward to the requested destination');
      assert.equal(await page.evaluate(() => window.__SMW.sim.biomes.reducedFlash), true, name + ' reduced flash survives seeking');
      await saveStage(page, path.join(out, `${kind}-reduced-flash.png`));
      // Keep reduced-flash assertions isolated from the per-world paint and
      // dynamics checks below.
      await page.keyboard.press('r');
      assert.equal(await page.evaluate(() => window.__SMW.sim.biomes.reducedFlash), false);
      // Reduced motion: its own chip, independent of flash, reaching the
      // running world.
      await page.locator('#reducedMotionBtn').evaluate((b) => b.click());
      const motionState = await page.evaluate(() => ({ motion: window.__SMW.sim.biomes.reducedMotion, flash: window.__SMW.sim.biomes.reducedFlash }));
      assert.deepEqual(motionState, { motion: true, flash: false }, name + ' reduced motion applies without reduced flash');
      await page.evaluate(renderWorldFrame, { atMs: 6000, quality: 0 });
      await saveStage(page, path.join(out, `${kind}-reduced-motion.png`));
      await page.locator('#reducedMotionBtn').evaluate((b) => b.click());
      assert.equal(await page.evaluate(() => window.__SMW.sim.biomes.reducedMotion), false);
      assert.equal(await page.locator('#pauseBtn').getAttribute('aria-pressed'), 'true');
      const reducedMotionSamples = await page.evaluate(worldMotionAudit);
      if (reducedMotionSamples) {
        const [normal, reduced] = reducedMotionSamples.samples;
        assert.ok(normal.geometryCount > 0 && normal.geometryChanged, name + ' geometry moves between the two normal frames');
        assert.equal(reduced.geometryChanged, false, name + ' reduced motion holds the same drawn geometry');
        assert.ok(normal.changedPixels > 0, name + ' normal movement reaches rendered pixels');
        if (kind !== 'city') assert.equal(reduced.changedPixels, 0, name + ' reduced motion holds rendered pixels');
      }
      const samples = [];
      for (const [label, atMs] of [['quiet', 6000], ['energetic', 18000], ['return', 27000]]) {
        const configuration = await page.evaluate(renderWorldFrame, { atMs, quality: 0 });
        const sample = await page.evaluate(async () => {
          const { sim } = window.__SMW;
          const mgr = sim.biomes;
          const { sampleManagerMusic } = await import('/src/world/WorldMusic.js');
          const music = sampleManagerMusic(mgr);
          const c = document.createElement('canvas'); c.width = 64; c.height = 36;
          const ctx = c.getContext('2d'); ctx.drawImage(document.querySelector('#stage'), 0, 0, 64, 36);
          const pixels = ctx.getImageData(0, 0, 64, 36).data;
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4) colors.add(pixels.slice(i, i + 3).join(','));
          return { timeMs: mgr.tSec * 1000, music, rhythmMs: mgr.worldRhythm?.tMs, colors: colors.size,
            curves: { manager: !!mgr.energyCurves, simulation: !!sim.energyCurves,
              managerFrames: mgr.energyCurves?.n, simulationFrames: sim.energyCurves?.n,
              opening: sim.analysisOpening,
              spanMs: (sim.energyCurves.n - 1) * 1000 / sim.energyCurves.rateHz } };
        });
        assert.ok(sample.colors > 16, name + ' renders a composed ' + label + ' scene');
        assert.ok(sample.rhythmMs == null || Number.isFinite(sample.rhythmMs), name + ' rhythm is absent or finite after destination rebuild');
        assert.ok(Object.values(sample.music).every(Number.isFinite));
        await saveStage(page, path.join(out, `${kind}-${label}.png`));
        samples.push({ label, ...configuration, ...sample });
      }
      report.currentWorld = { name, kind, samples };
      assert.ok(samples[1].music.energy > samples[0].music.energy,
        `${name} recognizes the louder passage (quiet=${samples[0].music.energy}, energetic=${samples[1].music.energy})`);

      // The per-pass audit, on the energetic passage -- the busiest frame,
      // and the one where every optional layer is in play.
      const auditConfiguration = await page.evaluate(renderWorldFrame, { atMs: 18000, quality: 0 });
      let paint = null;
      {
        paint = await page.evaluate(PAINT_AUDIT, { names: [...world.mustPaint, ...world.watch, ...(world.mustNotPaint || [])] });
        for (const pass of world.mustPaint) {
          const s = paint[pass];
          if (!s || s.missing) { failures.push(`${name}: ${pass} is not a method on BiomeManager`); continue; }
          if (s.calls === 0) { failures.push(`${name}: ${pass} never ran`); continue; }
          if (s.paintedPx === 0) failures.push(`${name}: ${pass} ran ${s.calls}x and changed 0 pixels`);
        }
      }

      for (const pass of world.mustNotPaint || []) {
        assert.equal(paint[pass]?.missing, undefined, `${name}: missing ${pass} audit target`);
        assert.equal(paint[pass]?.paintedPx, 0, `${name}: ${pass} must not paint this world`);
      }
      // Same destination at deepest supported quality and reduced flash.
      await page.keyboard.press('r');
      const degradedConfiguration = await page.evaluate(renderWorldFrame, { atMs: 18000, quality: 6 });
      assert.equal(degradedConfiguration.reducedFlash, true);
      let degradedPaint = null;
      if (world.mustPaint.includes('_drawSignature')) {
        degradedPaint = await page.evaluate(PAINT_AUDIT, { names: ['_drawSignature'], quality: 6 });
        assert.ok(degradedPaint._drawSignature.paintedPx > 0, name + ' retains its defining structure at lowest quality');
      }
      await saveStage(page, path.join(out, `${kind}-degraded.png`));
      // Restore quality on the SAME destination scene to exercise a live
      // transition, rather than hiding state bugs behind another seek.
      await page.evaluate(() => {
        const { sim, renderer, perf } = window.__SMW;
        if (perf) perf.level = 0;
        renderer.draw(sim, 1);
      });
      await saveStage(page, path.join(out, `${kind}-quality-restored.png`));
      await page.keyboard.press('r');
      await page.evaluate(renderWorldFrame, { atMs: 18000, quality: 0 });
      // Fixed-step motion samples, not sleep-based comparisons. Drawing cost
      // is headless JS submission time; it is not device FPS or GPU time.
      const motion = [];
      if (['overgrowth', 'nave', 'strip', 'foundry'].includes(kind)) {
        for (let segment = 0; segment < 6; segment++) {
          const timing = await page.evaluate(() => {
            const { sim, renderer, perf } = window.__SMW;
            const costs = [];
            for (let i = 0; i < 15; i++) {
              if (perf) perf.level = 0;
              sim.step(1000 / 60, sim.timeMs + 1000 / 60);
              const before = performance.now();
              renderer.draw(sim, 1);
              costs.push(performance.now() - before);
            }
            return { timeMs: sim.timeMs, submissionMs: costs };
          });
          await saveStage(page, path.join(out, `${kind}-motion-${segment}.png`));
          motion.push(timing);
        }
      }
            assert.deepEqual(errors, [], name + ' has no browser errors');
      report.worlds.push({ name, kind, liveState, analysisState, seekTimes, samples, auditConfiguration, paint, degradedConfiguration, degradedPaint, motion, reducedMotionSamples, errors });
      delete report.currentWorld;
      const painted = paint
        ? Object.entries(paint).filter(([, s]) => s.paintedPx > 0).map(([k]) => k).join(', ')
        : 'pixel renderer';
      console.log(`PASS ${name}: selection, 3 passages, rhythm, dynamic response, backward seek, reduced flash, reduced motion`);
      console.log(`     painted: ${painted}`);
    } finally { await context.close(); }
  }
  if (failures.length) {
    // Reported together rather than thrown at the first one: a pass that
    // stopped painting in several worlds at once is a different story from
    // one that stopped in a single world, and only the full list tells them
    // apart.
    throw new assert.AssertionError({
      message: `passes that ran without painting:\n  ${failures.join('\n  ')}`,
    });
  }
  report.passed = true;
} finally {
  report.failures = failures;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
