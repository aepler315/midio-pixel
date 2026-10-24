// Trio, end to end: actual upload/analysis, pixel exports, the Trio chooser
// preview, and live/paused world switches. Trio is its own world (the
// pre-terrain Range with the cast on it), so a switch rebuilds the scene at
// the heard position while the audio keeps playing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { attachBrowserDiagnostics, finalizeBrowserDiagnostics } from './lib/browser-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8080';
const out = path.resolve(process.argv[3] || '.smoke/trio-stage');
await fs.mkdir(out, { recursive: true });
const audioPath = path.join(out, 'performance.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audioPath, '120', '36']);
const presentation = { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35,
  ditherMode: 'selective', pixelGrid: 'classic', pixelScale: 'original', scaling: 'fit' };
const settings = { width: 1280, height: 720, experience: 'trio', view: null, biome: null,
  seed: 315, quality: 0, presentation };
const report = { status: 'failed', frames: [], live: null, errors: [], warnings: [], events: [] };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
let failed = false;
try {
  const diagnostics = { errors: report.errors, warnings: report.warnings, events: report.events, loadedFiles: new Set() };
  const loaded = await openEvaluationSong(browser, { url, audioPath, settings, diagnostics });
  const page = loaded.page;
  let captureFailed = false;
  try {
    for (const [grid, look] of [['classic', 'pixel'], ['detailed', 'pixel'], ['classic', 'palette'], ['detailed', 'palette']]) {
      loaded.browserDiagnostics.setPhase(`trio-capture:${grid}/${look}:3000ms`);
      settings.presentation = { ...presentation, pixelGrid: grid, look };
      await page.evaluate(p => window.__SMW.beginBulkExport({ width: 1280, height: 720, presentation: p }), settings.presentation);
      const frame = await renderEvaluationFrame(page, { timeMs: 3000, checkpoint: true, clips: [], save: true }, settings);
      const repeated = await renderEvaluationFrame(page, { timeMs: 3000, checkpoint: true, clips: [], save: true }, settings);
      assert.equal(frame.pngData, repeated.pngData, `${grid}/${look}: repeated paused draw must agree`);
      assert.equal(frame.presentation.pixelScale, 'original');
      assert.equal(frame.presentation.effectiveGrid.id, grid);
      const name = `${grid}-${look}.png`;
      await fs.writeFile(path.join(out, name), Buffer.from(frame.pngData, 'base64'));
      report.frames.push({ grid, look, file: name, pauseParity: true, presentation: frame.presentation });
    }
    loaded.browserDiagnostics.setPhase('trio-world');
    const world = await page.evaluate(() => {
      const { sim } = window.__SMW;
      return { experience: sim.experience, worldKind: sim.biomes.world.kind, trio: !!sim.trio,
        terrainProfiles: !!sim.biomes.terrainProfiles, skyEnsemble: !!sim.biomes.skyEnsemble,
        crystalSpaceRidge: !!sim.biomes.presentation.crystalSpaceRidge };
    });
    assert.deepEqual(world, { experience: 'trio', worldKind: 'alpine', trio: true, terrainProfiles: false,
      skyEnsemble: true, crystalSpaceRidge: true }, 'Trio plays on the procedural pre-terrain range');
    report.world = world;
    loaded.browserDiagnostics.setPhase('trio-preview');
    const preview = await page.evaluate(async () => {
      const { loadPreviewRenderer, createPreviewWorld } = await import('/src/ui/WorldPreview.js');
      await loadPreviewRenderer();
      const smw = window.__SMW;
      const world = createPreviewWorld({ worldId: 'trio', seed: smw.songSeed, data: {
        timeline: smw.conductor.timeline, durationMs: smw.durationMs, energyCurves: smw.sim.energyCurves,
        bpm: smw.sim.bpm, barGrid: smw.conductor.barGrid } });
      try { world.draw(3000); return { kind: world.kind, png: world.canvas.toDataURL('image/png').split(',')[1] }; }
      finally { world.dispose(); }
    });
    assert.equal(preview.kind, 'trio');
    await fs.writeFile(path.join(out, 'preview.png'), Buffer.from(preview.png, 'base64'));
    report.preview = { kind: preview.kind, file: 'preview.png' };
    assert.equal([...diagnostics.loadedFiles].filter(p => /\/range\/v2\/(terrain|tour|materials)\//.test(p)).length, 0,
      'Trio must not request DEM, tour or material packages');
    assert.deepEqual(diagnostics.errors, []);
  } catch (error) { captureFailed = true; throw error; }
  finally {
    await loaded.context.close(); await loaded.browserDiagnostics.dispose();
    finalizeBrowserDiagnostics(diagnostics, report, { preserveFailure: captureFailed });
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let liveDiagnostics;
  let liveFailed = false;
  try {
    const page = await context.newPage();
    liveDiagnostics = await attachBrowserDiagnostics(page, { ...diagnostics, loadedFiles: new Set() }, { origin: new URL(url).origin, phase: 'trio-live-startup' });
    await page.route('**/soundfonts/', r => r.fulfill({ json: [] }));
    await page.route('**/favicon.ico', r => r.fulfill({ status: 204 }));
    const entry = new URL(url); entry.searchParams.set('experience', 'trio'); entry.searchParams.set('rangeRenderer', 'legacy'); entry.searchParams.set('rangeTour', 'off');
    await page.goto(entry.href);
    await page.locator('#titleSettings').evaluate(n => { n.open = true; });
    if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
    liveDiagnostics.setPhase('trio-live-analysis');
    await page.locator('#fileInput').setInputFiles(audioPath);
    await page.waitForFunction(() => window.__SMW?.sim?.timeMs > 500, null, { timeout: 120000 });
    await page.evaluate(() => { window.__liveTrio = { source: window.__SMW.audioEngine.sourceNode, conductor: window.__SMW.conductor }; });
    const snapshot = () => page.evaluate(async () => {
      const s = window.__SMW;
      const { sharedResidency } = await import('/src/render/GraphicsResidency.js');
      return { experience: s.experience, simExperience: s.sim.experience, actors: !!s.sim.trio,
        selected: document.getElementById('display-experience').value,
        sameBuffer: !!s.audioEngine.sourceNode?.buffer && s.audioEngine.sourceNode.buffer === window.__liveTrio.source.buffer,
        sameConductor: s.conductor === window.__liveTrio.conductor,
        running: s.audioEngine.ctx.state, paused: s.paused, audioMs: s.audioEngine.nowMs, simMs: s.sim.timeMs,
        ahead: s.conductor.aheadRegs.length, bytes: sharedResidency().usedBytes, entries: sharedResidency().entries.size };
    });
    const start = await snapshot();
    assert.deepEqual([start.experience, start.simExperience, start.actors], ['trio', 'trio', true], 'the page-named world starts without the chooser');
    const live = [];
    for (let i = 0; i < 3; i++) for (const mode of ['landscape', 'trio']) {
      liveDiagnostics.setPhase(`live-switch:${i}:${mode}`);
      const before = await snapshot();
      await page.evaluate(mode => window.__SMW.setExperience(mode), mode);
      await page.waitForFunction(mode => window.__SMW.sim?.experience === mode && window.__SMW.audioEngine.playing, mode, { timeout: 60000 });
      const state = await snapshot();
      assert.equal(state.experience, mode); assert.equal(state.simExperience, mode); assert.equal(state.selected, mode);
      assert.equal(state.actors, mode === 'trio');
      // The rebuild rejoins the same decoded recording at the heard position,
      // as a seek does; the song never restarts or changes.
      assert.equal(state.sameBuffer, true, 'the recording keeps playing through a world switch');
      assert.equal(state.sameConductor, true);
      assert.equal(state.running, 'running'); assert.equal(state.paused, false);
      assert.ok(state.audioMs >= before.audioMs, 'the heard position does not move backward');
      assert.ok(Math.abs(state.simMs - state.audioMs) < 1500, 'the rebuilt world starts at the heard position');
      live.push(state);
    }
    const stages = live.filter(s => s.experience === 'trio');
    assert.ok(stages.every(s => s.bytes <= stages[0].bytes && s.entries <= stages[0].entries), 'repeated switches cannot accumulate retained resources');
    liveDiagnostics.setPhase('live-paused-switch');
    await page.locator('#stage').click({ position: { x: 100, y: 80 } });
    await page.locator('#pauseBtn').click();
    await page.waitForFunction(() => window.__SMW.paused);
    const frozen = await page.evaluate(() => window.__SMW.audioEngine.nowMs);
    for (const mode of ['landscape', 'trio']) {
      await page.evaluate(mode => window.__SMW.setExperience(mode), mode);
      await page.waitForFunction(mode => window.__SMW.sim?.experience === mode, mode, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.__SMW.audioEngine.nowMs), frozen, 'a paused switch keeps the clock');
      assert.equal(await page.evaluate(() => window.__SMW.paused), true, 'a paused switch stays paused');
    }
    await page.screenshot({ path: path.join(out, 'live-paused.png') });
    report.live = { start, switches: live, pausedSwitchPreservedClock: true };
    assert.deepEqual(report.errors, []);
  } catch (error) { liveFailed = true; throw error; }
  finally {
    await context.close(); await liveDiagnostics?.dispose();
    finalizeBrowserDiagnostics(report, report, { preserveFailure: liveFailed });
  }
  report.status = 'passed';
} catch (error) { failed = true; report.error = String(error.stack || error); throw error; }
finally {
  await browser.close();
  try { finalizeBrowserDiagnostics(report, report, { preserveFailure: failed }); }
  finally { await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
}
console.log(`Trio: ${report.status}; ${report.frames.length} pixel/palette captures, ${report.live?.switches.length ?? 0} live world switches, paused clock preserved.`);
