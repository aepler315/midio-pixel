// Both worlds, Landscape and Trio, through real upload, analysis, the
// chooser, playback and seeking -- plus a per-pass paint audit of the frame
// each one composes. Start npm start first.
// Usage: node tools/worlds-smoke.mjs [url] [outDir]
//
// WHY THE PAINT AUDIT. A liveness check (enough distinct colors) proves
// something rendered, not that the right things did. BiomeManager's fata
// morgana was once called every frame for a week while drawing exactly zero
// pixels, and the deep-sky layer that draws Midasus's voyages went missing
// once already. So the audit wraps individual draw passes and measures what
// each one actually changes on the stage, rather than judging the composite.
// A pass that runs and paints nothing is a failure with a name attached.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { renderWorldFrame, worldAnalysisReady } from './world-frame.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8080';
const out = path.resolve(process.argv[3] || path.join(root, '.smoke/worlds'));

async function saveStage(page, destination) {
  const data = await page.evaluate(() => document.querySelector('#stage').toDataURL('image/png'));
  await fs.writeFile(destination, Buffer.from(data.split(',')[1], 'base64'));
}

// The two cards on the chooser. Both are the alpine kind; `experience` is
// what tells them apart once live. Audit targets are `owner:method`, where
// owner is the BiomeManager (`mgr`), one of its members, or the renderer.
//
// `mustPaint` are passes that cannot legitimately draw nothing on a settled
// frame at full quality. `watch` is recorded without being asserted.
// `mustRun` must be called on that frame (whether or not it changes pixels).
// `mustNotRun` are passes the world must never reach.
const WORLDS = [
  { name: 'Landscape', experience: 'landscape',
    // The Range keeps its terrain/water composition; the cast and the
    // pre-terrain sky belong to Trio.
    mustPaint: ['mgr:_drawSky', 'mgr:_drawFarShore', 'mgr:_drawOcean', 'mgr:_drawLayer'],
    watch: ['mgr:_drawStarfield'],
    mustNotRun: ['renderer:_drawTrioCast', 'mgr:drawDeepSky', 'skyEnsemble:draw'] },
  { name: 'Trio', experience: 'trio',
    // The dancing ranges, the crystalline space ridge, the star catalogue,
    // the seeded planets and the cast on the ground the world draws.
    mustPaint: ['mgr:_drawSky', 'mgr:_drawLayer', 'mgr:_drawHorizonEQ', 'spaceRidge:draw', 'renderer:_drawTrioCast'],
    watch: ['mgr:_drawStarfield', 'mgr:drawDeepSky'],
    // The planets, comets and artifacts are scheduled, so a given frame may
    // paint none of them; the pass itself must run under Trio's sky.
    mustRun: ['skyEnsemble:draw'],
    mustNotRun: ['spaceRidge:drawAurora'] },
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
 *  many stage pixels each call changed. Returns {target: {calls, paintedPx}}. */
const PAINT_AUDIT = ({ targets, quality = 0 }) => {
  const { sim, renderer, perf } = window.__SMW;
  const mgr = sim.biomes;
  const owners = { mgr, renderer: renderer.canvasRenderer || renderer, spaceRidge: mgr.spaceRidge, skyEnsemble: mgr.skyEnsemble };
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
  const stats = {}, restore = [];
  for (const target of targets) {
    const [ownerName, name] = target.split(':');
    const owner = owners[ownerName];
    const proto = owner && Object.getPrototypeOf(owner);
    const fn = proto?.[name];
    if (typeof fn !== 'function') { stats[target] = { calls: 0, paintedPx: 0, missing: true }; continue; }
    stats[target] = { calls: 0, paintedPx: 0 };
    restore.push(() => { proto[name] = fn; });
    proto[name] = function wrapped(...args) {
      const before = snapshot();
      const result = fn.apply(this, args);
      stats[target].calls++;
      stats[target].paintedPx += changed(before, snapshot());
      return result;
    };
  }
  try {
    // Full quality for the audited frame: a shed rung legitimately turns
    // whole passes off, which would read as "painted nothing".
    if (perf) perf.level = quality;
    renderer.draw(sim, 1);
  } finally {
    for (const undo of restore) undo();
  }
  return stats;
};

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const report = { passed: false, seed: 315, viewport: { width: 1280, height: 720 }, browser: browser.version(),
  timingScope: 'Headless JS draw submission; not GPU time or device FPS', worlds: [] };
const failures = [];

try {
  for (const world of WORLDS) {
    const { name, experience } = world;
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
      entry.searchParams.set('rangeRenderer', 'legacy'); // software GL cannot keep up with v2 live
      await page.goto(entry.href);
      await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
      const lyrics = page.locator('#lyricGroundingBtn');
      if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
      await page.locator('#display-pixelGrid').selectOption('classic');
      await page.locator('#fileInput').setInputFiles(wav);
      // No world named on the page: the chooser opens with exactly two cards.
      await page.locator('#worldSelect:not(.hidden)').waitFor({ timeout: 90000 });
      const cards = await page.locator('#worldSelect .worldCard .worldCardName').allTextContents();
      assert.deepEqual(cards, ['Landscape', 'Trio'], 'the chooser offers exactly Landscape and Trio');
      assert.equal(await page.locator('#worldChooseForMe').count(), 0, 'two worlds need no recommendation');
      assert.ok(await page.locator('.worldCard[data-base-world-id="alpine"] .worldCardPreviewNote').isVisible(), 'Landscape illustration label is visible');
      await page.locator('.worldCard').filter({ has: page.getByText(name, { exact: true }) }).click();
      await page.waitForFunction(() => window.__SMW?.sim?.timeMs > 1200, null, { timeout: 60000 });
      const liveState = await page.evaluate(() => {
        document.querySelector('#pauseBtn').click();
        const { sim } = window.__SMW;
        return { experience: sim.experience, kind: sim.biomes.world.kind, trio: !!sim.trio,
          terrainProfiles: !!sim.biomes.terrainProfiles, rhythmMs: sim.biomes.worldRhythm?.tMs,
          control: document.getElementById('display-experience').value };
      });
      assert.equal(liveState.experience, experience);
      assert.equal(liveState.kind, 'alpine');
      assert.equal(liveState.trio, experience === 'trio', name + ' builds the cast only in Trio');
      assert.equal(liveState.terrainProfiles, experience === 'landscape', name + ' uses real terrain only in Landscape');
      assert.equal(liveState.control, experience, 'Settings shows the chosen world');
      assert.ok(Number.isFinite(liveState.rhythmMs), name + ' receives detected rhythm during live playback');
      // This fixture exceeds the opening-analysis threshold. Do not compare
      // later passages against its clamped 15-second tail.
      await page.waitForFunction(worldAnalysisReady, { throughMs: 27000 }, { timeout: 180000 });
      // Pause after real playback, then verify an actual backward seek in
      // one page task.
      const seekTimes = await page.evaluate(() => {
        window.__SMW.seek(8000);
        const before = window.__SMW.sim.timeMs - window.__SMW.sim.visualLeadMs;
        window.__SMW.seek(4000);
        return { before, after: window.__SMW.sim.timeMs - window.__SMW.sim.visualLeadMs };
      });
      assert.ok(Math.abs(seekTimes.before - 8000) < 20, name + ' reaches the first seek destination');
      assert.ok(Math.abs(seekTimes.after - 4000) < 20, name + ' seeks backward to the requested destination');
      assert.equal(await page.evaluate(() => window.__SMW.sim.experience), experience, name + ' survives seeking');

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
          const cast = sim.trio ? { midioX: sim.trio.midio.screenX, midioGroundY: sim.trio.midio.groundY,
            drawnGroundY: sim.groundField.heightAt(sim.trio.worldX) } : null;
          return { timeMs: mgr.tSec * 1000, music, colors: colors.size, cast };
        });
        assert.ok(sample.colors > 16, name + ' renders a composed ' + label + ' scene');
        assert.ok(Object.values(sample.music).every(Number.isFinite));
        if (sample.cast) assert.equal(sample.cast.midioGroundY, sample.cast.drawnGroundY, 'Midio stands on the drawn ground');
        await saveStage(page, path.join(out, `${experience}-${label}.png`));
        samples.push({ label, ...configuration, ...sample });
      }
      assert.ok(samples[1].music.energy > samples[0].music.energy,
        `${name} recognizes the louder passage (quiet=${samples[0].music.energy}, energetic=${samples[1].music.energy})`);

      // The per-pass audit, on the energetic passage -- the busiest frame,
      // and the one where every optional layer is in play.
      const auditConfiguration = await page.evaluate(renderWorldFrame, { atMs: 18000, quality: 0 });
      const paint = await page.evaluate(PAINT_AUDIT, { targets: [...world.mustPaint, ...world.watch, ...(world.mustRun || []), ...world.mustNotRun] });
      for (const target of world.mustPaint) {
        const s = paint[target];
        if (!s || s.missing) { failures.push(`${name}: ${target} is not a method`); continue; }
        if (s.calls === 0) { failures.push(`${name}: ${target} never ran`); continue; }
        if (s.paintedPx === 0) failures.push(`${name}: ${target} ran ${s.calls}x and changed 0 pixels`);
      }
      for (const target of world.mustRun || []) {
        if (!paint[target]?.calls) failures.push(`${name}: ${target} never ran`);
      }
      for (const target of world.mustNotRun) {
        if (paint[target]?.calls) failures.push(`${name}: ${target} ran ${paint[target].calls}x`);
      }

      // Trio: send Midasus to space and audit the frame where she draws.
      // Everyone is called home 25 s before the end, so on this 32-second
      // fixture a voyage can only fly in the first seven seconds.
      let voyage = null;
      if (experience === 'trio') {
        voyage = await page.evaluate(() => {
          window.__SMW.seek(1000);
          const { sim, renderer, perf } = window.__SMW;
          const midasus = sim.trio.midasus;
          // The cast keeps the heard clock; launch on it.
          midasus.forceVoyage(sim.trio.clockMs, null);
          const startMs = sim.timeMs;
          const phases = new Set();
          for (let t = startMs; t < startMs + 6000; t += 1000 / 120) {
            sim.step(1000 / 120, t);
            phases.add(midasus.voyage.phase);
            if (midasus.voyage.phase === 'DEEP_SPACE' && midasus.voyage.trail?.length > 40) break;
          }
          if (perf) perf.level = 0;
          renderer.draw(sim, 1);
          return { phases: [...phases], phase: midasus.voyage.phase, depth: midasus.voyage.depth,
            trail: midasus.voyage.trail?.length ?? null };
        });
        assert.equal(voyage.phase, 'DEEP_SPACE', 'Midasus reaches deep space: ' + JSON.stringify(voyage));
        const deepPaint = await page.evaluate(PAINT_AUDIT, { targets: ['mgr:drawDeepSky', 'renderer:_drawTrioCast'] });
        voyage.paint = deepPaint;
        if (!(deepPaint['mgr:drawDeepSky']?.paintedPx > 0)) failures.push(`${name}: drawDeepSky painted nothing while Midasus drew in deep space`);
        await saveStage(page, path.join(out, `${experience}-voyage.png`));
      }

      // Same destination at the deepest supported quality, then restored on
      // the SAME scene to exercise a live transition.
      const degradedConfiguration = await page.evaluate(renderWorldFrame, { atMs: 18000, quality: 6 });
      await saveStage(page, path.join(out, `${experience}-degraded.png`));
      await page.evaluate(() => {
        const { sim, renderer, perf } = window.__SMW;
        if (perf) perf.level = 0;
        renderer.draw(sim, 1);
      });
      await saveStage(page, path.join(out, `${experience}-quality-restored.png`));
      assert.deepEqual(errors, [], name + ' has no browser errors');
      report.worlds.push({ name, experience, liveState, seekTimes, samples, auditConfiguration, paint, voyage, degradedConfiguration, errors });
      const painted = Object.entries(paint).filter(([, s]) => s.paintedPx > 0).map(([k]) => k).join(', ');
      console.log(`PASS ${name}: chooser, 3 passages, rhythm, dynamic response, backward seek${voyage ? ', deep-space voyage' : ''}`);
      console.log(`     painted: ${painted}`);
    } finally { await context.close(); }
  }
  if (failures.length) {
    // Reported together rather than thrown at the first one: the full list
    // tells a broken shared pass apart from a broken world.
    throw new assert.AssertionError({ message: `paint audit failures:\n  ${failures.join('\n  ')}` });
  }
  report.passed = true;
} finally {
  report.failures = failures;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
