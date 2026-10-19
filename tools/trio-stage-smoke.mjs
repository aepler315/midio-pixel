// Actual upload/analysis, pixel exports, live/paused switches and ownership.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8080';
const out = path.resolve(process.argv[3] || '.smoke/trio-stage');
await fs.mkdir(out, { recursive: true });
const audioPath = path.join(out, 'performance.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audioPath, '120', '36']);
const presentation = { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35,
  ditherMode: 'selective', pixelGrid: 'classic', pixelScale: 'depth', scaling: 'fit' };
const settings = { width: 1280, height: 720, experience: 'trio', view: null, biome: null,
  seed: 315, quality: 0, reducedFlash: false, reducedMotion: false, presentation };
const report = { status: 'failed', frames: [], switches: [], live: null, errors: [] };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
try {
  const diagnostics = { errors: [], warnings: [], loadedFiles: new Set() };
  const loaded = await openEvaluationSong(browser, { url, audioPath, settings, diagnostics });
  const page = loaded.page;
  try {
    for (const [grid, look] of [['classic', 'pixel'], ['detailed', 'pixel'], ['classic', 'palette'], ['detailed', 'palette']]) {
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
    const preview = await page.evaluate(async () => {
      const { loadPreviewRenderer, createPreviewWorld } = await import('/src/ui/WorldPreview.js');
      await loadPreviewRenderer();
      const smw = window.__SMW;
      const world = createPreviewWorld({ worldId: 'alpine', seed: smw.songSeed, data: { experience: 'trio',
        timeline: smw.conductor.timeline, durationMs: smw.durationMs, energyCurves: smw.sim.energyCurves,
        bpm: smw.sim.bpm, barGrid: smw.conductor.barGrid } });
      try { world.draw(3000); return { kind: world.kind, png: world.canvas.toDataURL('image/png').split(',')[1] }; }
      finally { world.dispose(); }
    });
    assert.equal(preview.kind, 'trio');
    await fs.writeFile(path.join(out, 'preview.png'), Buffer.from(preview.png, 'base64'));
    report.preview = { kind: preview.kind, file: 'preview.png' };
    assert.equal([...diagnostics.loadedFiles].filter(p => /\/range\/v2\/(terrain|tour|materials)\//.test(p)).length, 0,
      'Trio Stage must not request DEM, tour or material packages');
    // A separate test below covers live audio. This part exercises paused,
    // stepped exports and checks the same real UI handler repeatedly.
    await page.evaluate(() => {
      const u = new URL(location.href); u.searchParams.set('rangeRenderer', 'legacy'); u.searchParams.set('rangeTour', 'off'); history.replaceState(null, '', u);
      window.__trioTransport = { sim: window.__SMW.sim, conductor: window.__SMW.conductor, engine: window.__SMW.audioEngine };
    });
    for (let i = 0; i < 3; i++) for (const experience of ['landscape', 'trio']) {
      const before = await page.evaluate(() => ({ timeMs: window.__SMW.sim.timeMs, heard: window.__SMW.sim.heardTimeMs, paused: window.__SMW.paused }));
      await page.evaluate(mode => window.__SMW.setExperience(mode), experience);
      const state = await page.evaluate(async () => {
        const s = window.__SMW, saved = window.__trioTransport;
        const { sharedResidency } = await import('/src/render/GraphicsResidency.js');
        return { experience: s.experience, timeMs: s.sim.timeMs, heard: s.sim.heardTimeMs, paused: s.paused,
          sameTransport: s.sim === saved.sim && s.conductor === saved.conductor && s.audioEngine === saved.engine,
          actors: !!s.sim.trio, ahead: s.conductor.aheadRegs.length,
          bytes: sharedResidency().usedBytes, entries: sharedResidency().entries.size,
          pixelScale: s.presentationDiagnostics.pixelScale };
      });
      assert.equal(state.experience, experience); assert.equal(state.sameTransport, true);
      assert.equal(state.timeMs, before.timeMs); assert.equal(state.heard, before.heard); assert.equal(state.paused, before.paused);
      assert.equal(state.actors, experience === 'trio'); assert.equal(state.ahead, 0);
      assert.equal(state.pixelScale, experience === 'trio' ? 'original' : 'depth');
      report.switches.push(state);
    }
    const stages = report.switches.filter(s => s.experience === 'trio');
    assert.ok(stages.every(s => s.bytes <= stages[0].bytes && s.entries <= stages[0].entries), 'repeated switches cannot accumulate retained resources');
    assert.deepEqual(diagnostics.errors, []);
  } finally { await loaded.context.close(); }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/soundfonts/', r => r.fulfill({ json: [] }));
    await page.route('**/favicon.ico', r => r.fulfill({ status: 204 }));
    const entry = new URL(url); entry.searchParams.set('experience', 'trio'); entry.searchParams.set('rangeRenderer', 'legacy'); entry.searchParams.set('rangeTour', 'off');
    await page.goto(entry.href);
    await page.locator('#titleSettings').evaluate(n => { n.open = true; });
    if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
    await page.locator('#fileInput').setInputFiles(audioPath);
    await page.waitForFunction(() => window.__SMW?.sim?.timeMs > 500, null, { timeout: 120000 });
    await page.evaluate(() => { window.__liveTrio = { sim: window.__SMW.sim, source: window.__SMW.audioEngine.sourceNode }; });
    const live = [];
    for (const mode of ['landscape', 'trio']) {
      await page.evaluate(mode => window.__SMW.setExperience(mode), mode);
      const state = await page.evaluate(() => ({ experience: window.__SMW.experience,
        sameSim: window.__SMW.sim === window.__liveTrio.sim,
        sameSource: window.__SMW.audioEngine.sourceNode === window.__liveTrio.source,
        running: window.__SMW.audioEngine.ctx.state, paused: window.__SMW.paused,
        audioMs: window.__SMW.audioEngine.nowMs }));
      assert.equal(state.experience, mode); assert.equal(state.sameSim, true); assert.equal(state.sameSource, true);
      assert.equal(state.running, 'running'); assert.equal(state.paused, false); live.push(state);
    }
    await page.locator('#stage').click({ position: { x: 100, y: 80 } });
    await page.locator('#pauseBtn').click();
    await page.waitForFunction(() => window.__SMW.paused);
    const frozen = await page.evaluate(() => window.__SMW.audioEngine.nowMs);
    await page.evaluate(() => window.__SMW.setExperience('landscape'));
    await page.evaluate(() => window.__SMW.setExperience('trio'));
    assert.equal(await page.evaluate(() => window.__SMW.audioEngine.nowMs), frozen);
    assert.equal(await page.evaluate(() => window.__SMW.paused), true);
    await page.screenshot({ path: path.join(out, 'live-paused.png') });
    const cancelled = await page.evaluate(async () => {
      const { RangePresentation } = await import('/src/world/alpine/RangePresentation.js');
      const original = RangePresentation.prototype.whenReady;
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      RangePresentation.prototype.whenReady = () => ready;
      try {
        const u = new URL(location.href); u.searchParams.set('rangeRenderer', 'v2'); history.replaceState(null, '', u);
        const control = document.getElementById('display-experience'); control.value = 'landscape';
        const pending = window.__SMW.setExperience('landscape');
        window.__SMW.seek(6000);
        release({}); await pending;
        return { experience: window.__SMW.experience, selected: control.value,
          disabled: control.disabled, status: document.getElementById('experience-status').textContent };
      } finally { RangePresentation.prototype.whenReady = original; }
    });
    assert.equal(cancelled.experience, 'trio'); assert.equal(cancelled.selected, 'trio');
    assert.equal(cancelled.disabled, false); assert.equal(cancelled.status, 'Automatic performance');
    report.cancelledSwitch = cancelled;
    report.live = { switches: live, pausedSwitchPreservedClock: true };
    assert.deepEqual(report.errors, []);
  } finally { await context.close(); }
  report.status = 'passed';
} finally { await browser.close(); await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(`Trio Stage: ${report.status}; ${report.frames.length} pixel/palette captures, ${report.switches.length} paused switches, live and paused audio preserved.`);
