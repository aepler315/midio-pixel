// Matched real-app evidence. Source root may be an immutable baseline checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { finalizeBrowserDiagnostics } from './lib/browser-diagnostics.mjs';
const root = path.resolve(process.argv[2] || '.'), out = path.resolve(process.argv[3] || '.smoke/range-stars'), tour = process.argv[4] === 'tour';
const resume = process.argv[5] === 'resume';
await fs.mkdir(out, { recursive: true });
const snapshot = await snapshotSource(root), server = await serveSnapshot(snapshot);
const audioPath = path.join(out, 'audio.wav');
execFileSync(process.execPath, ['tools/gen-test-wav.mjs', audioPath, '120', '96']);
const settings = { width: 1280, height: 720, seed: 315, quality: 3, view: tour ? 'teton-range-tour' : 'teton-jackson-lake', biome: 'CONIFER', reducedFlash: false, reducedMotion: false,
  presentation: { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid: 'classic', scaling: 'fit', pixelScale: 'original' }, debug: { rangeTour: tour ? 'tetons' : 'off' } };
const report = { status: 'running', source: { root, digest: snapshot.digest, hashes: snapshot.hashes }, settings, audioSha256: sha256(await fs.readFile(audioPath)), errors: [], warnings: [], events: [], loadedFiles: new Set(), frames: [] };
const previous = resume ? JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8')) : null;
if (previous) {
  assert.equal(previous.source.digest, snapshot.digest, 'resume requires the identical served source');
  assert.equal(previous.audioSha256, report.audioSha256);
  assert.deepEqual(previous.settings, report.settings, 'resume requires identical view, mode and display settings');
  for (const frame of previous.frames) {
    assert.equal(frame.range.viewId, settings.view, 'retained frames must belong to the requested view');
    assert.equal(frame.sha256, sha256(await fs.readFile(path.join(out, frame.file))), 'retained PNG must match its recorded hash');
  }
  report.frames = previous.frames;
  report.errors = previous.errors || [];
  report.warnings = previous.warnings || [];
  report.events = previous.events || [];
  report.previousAttempts = [...previous.previousAttempts || [], { status: previous.status, error: previous.error || null, errors: previous.errors || [] }];
}
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let loaded, failed = false;
const saveReport = () => fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ ...report, loadedFiles: [...report.loadedFiles] }, null, 2));
try {
  loaded = await openEvaluationSong(browser, { url: server.url, audioPath, settings: { ...settings, ...(tour ? { tour: 'tetons' } : {}) }, diagnostics: report });
  report.environment = loaded.environment; report.browser = browser.version(); report.seed = loaded.seed;
  if (previous) {
    assert.deepEqual(previous.environment, report.environment);
    assert.equal(previous.browser, report.browser);
    assert.equal(previous.seed, report.seed);
  }
  const page = loaded.page;
  const captured = id => report.frames.some(f => f.file === `${id}.png`);
  const profile = async p => {
    loaded.browserDiagnostics.setPhase(`star-profile:${p.pixelGrid}/${p.look}`);
    settings.presentation = p;
    await page.evaluate(async p => { const { resolvePresentation, resolveDisplayPrefs } = await import('/src/render/DisplayProfile.js');
      window.__SMW.renderer.setPresentation(resolvePresentation(resolveDisplayPrefs({ saved: p })));
    }, p);
  };
  const capture = async (timeMs, id, disabled = false) => {
    loaded.browserDiagnostics.setPhase(`star-capture:${id}:${timeMs}ms`);
    if (tour) await page.evaluate(async timeMs => {
      // Readiness covers the view, but a seek can still have a coarse
      // terrain window while its worker builds. Settle that real work so
      // on/off and before/after compare the same terrain, without changing
      // its pixel policy, memory budget or authored camera.
      const scene = window.__SMW.sim.biomes.rangePresentation.scene;
      const p = scene.prepared.get('teton-range-tour');
      const index = Math.floor(Math.min(timeMs, p.view.tour.durationMs - 1) / 8000);
      for (let attempt = 0; attempt < 3; attempt++) {
        scene._ensureTourWindow(p, timeMs);
        await Promise.allSettled([...p.windowCache.pending.values(), ...[...p.rawAhead?.values() || []].map(entry => entry.job)]);
        const current = p.windowCache.resident.get(index);
        if (current && !current.coarse) { scene._ensureTourWindow(p, timeMs); return; }
      }
      throw new Error(`Terrain window ${index} did not settle: ${p.windowNote || 'coarse terrain only'}`);
    }, timeMs);
    await page.evaluate(disabled => {
      const m = window.__SMW.sim.biomes;
      window.__starPainter ??= m._drawStarfield;
      m._drawStarfield = disabled ? () => {} : window.__starPainter;
    }, disabled);
    const f = await renderEvaluationFrame(page, { timeMs, save: true, checkpoint: true, clips: [] }, settings);
    const bytes = Buffer.from(f.pngData, 'base64'); delete f.pngData;
    f.file = `${id}.png`; f.sha256 = sha256(bytes); f.starsDisabled = disabled;
    f.sky = await page.evaluate(() => { const m = window.__SMW.sim.biomes, p = m.rangePresentation;
      return { night: m._night01, narrative: m.rangeNarrative, starCount: m.stars.length, skyPan: p.skyPan,
        eye: p.scene.camera.position.toArray(), orientation: p.scene.camera.quaternion.toArray(), transform: m._scenicTransform,
        requested: p.tourMode, preparation: p.snapshot().tourPreparation, fallback: p.snapshot().reason };
    });
    const old = report.frames.findIndex(row => row.file === f.file);
    if (old >= 0) report.frames[old] = f; else report.frames.push(f);
    await fs.writeFile(path.join(out, f.file), bytes); await saveReport();
    console.log(`${id}: ${timeMs}ms night=${f.sky.night.toFixed(3)} active=${f.range.active}`);
    return f;
  };
  const initial = { ...settings.presentation };
  for (const pixelGrid of ['classic', 'detailed']) for (const look of ['pixel', 'palette']) {
    const pixelScale = 'original';
    const id = `${pixelGrid}-${pixelScale}-${look}`;
    if (captured(`${id}-on`) && captured(`${id}-off`)) continue;
    await profile({ ...initial, pixelGrid, pixelScale, look });
    await capture(3000, `${id}-on`);
    await page.evaluate(() => { const c = window.__SMW.renderer.output.source; window.__starOn = [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data]; });
    const off = await capture(3000, `${id}-off`, true);
    off.contribution = await page.evaluate(() => {
      const c = window.__SMW.renderer.output.source, off = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let changed = 0, maximumY = -1, upperHalf = 0;
      for (let i = 0; i < off.length; i += 4) if ([0,1,2].some(k => off[i+k] !== window.__starOn[i+k])) {
        changed++; const y = Math.floor(i / 4 / c.width); maximumY = Math.max(maximumY, y); if (y < c.height / 2) upperHalf++;
      }
      return { nativeWidth: c.width, nativeHeight: c.height, changed, upperHalf, maximumY };
    });
    await saveReport();
  }
  await profile(initial);
  const remaining = [{ timeMs: 30000, id: 'day-on' }, { timeMs: 30000, id: 'day-off', disabled: true }];
  if (tour) {
    // Select a substantial authored turn before viewing either revision.
    report.turn = await page.evaluate(() => {
      const tour = window.__SMW.sim.biomes.rangePresentation.tour;
      const direction = p => { const d = p.targetM.map((x,i) => x-p.eyeM[i]), n = Math.hypot(...d); return d.map(x => x/n); };
      let best = { startMs: 0, durationMs: 6000, angleDeg: 0 };
      // Look through the entire song and retain the shortest window with a
      // substantial authored turn. A late-song-only window can miss it.
      for (const durationMs of [6000, 8000, 10000, 12000, 16000, 20000, 24000]) {
        for (let t = 0; t <= tour.durationMs - durationMs; t += 500) {
          const a = direction(tour.poseAt(t)), b = direction(tour.poseAt(t + durationMs));
          const angleDeg = Math.acos(Math.max(-1, Math.min(1, a.reduce((s,v,i) => s+v*b[i],0)))) * 180 / Math.PI;
          if (angleDeg > best.angleDeg) best = { startMs: t, durationMs, angleDeg };
        }
        if (best.angleDeg >= 20) break;
      }
      return { ...best, frameIntervalMs: best.durationMs / 12 };
    });
    assert.ok(report.turn.angleDeg >= 20, 'fixture must actually include a substantial turn');
    for (let i = 0; i <= 12; i++) {
      const t = report.turn.startMs + i * report.turn.frameIntervalMs;
      remaining.push({ timeMs: t, id: `turn-${t}` });
    }
    remaining.push({ timeMs: 93000, id: 'night-return-on' }, { timeMs: 93000, id: 'night-return-off', disabled: true });
  }
  // The fixed export clock only advances. A turn can straddle the day
  // checkpoint, so schedule all remaining captures in chronological order.
  for (const point of remaining.sort((a, b) => a.timeMs - b.timeMs)) {
    if (!captured(point.id)) await capture(point.timeMs, point.id, point.disabled);
  }
  report.cancelledStartupRequests = report.events.filter(event => event.source === 'requestfailed' && event.expected).map(event => event.message);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (e) { failed = true; report.status = 'failed'; report.error = String(e.stack || e); console.error(e); process.exitCode = 1; }
finally {
  await loaded?.context.close(); await loaded?.browserDiagnostics.dispose(); await browser.close(); await server.close();
  try { finalizeBrowserDiagnostics(report, report, { preserveFailure: failed }); }
  catch (error) { console.error(error); process.exitCode = 1; }
  await saveReport();
}
