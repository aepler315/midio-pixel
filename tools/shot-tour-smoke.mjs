// Scenic shot tours in the actual app (docs/scenic-tours.md): a song is
// uploaded and analysed for real, a view with a shot library is pinned, and
// on the fixed export clock the smoke checks that
//   - the view's tour plans and draws (status ready, Range v2 active),
//   - the drawn camera is the planned pose (eye, look, lens) at payoffs,
//   - a redraw at the same heard time is pixel-identical (pause parity),
//   - a full rebuild (the seek path) replans the identical camera,
//   - switching tours off draws the authored rail instead.
//
//   VISUAL_ANGLE=gl node tools/shot-tour-smoke.mjs --view monument-valley-163 --song .smoke/tour-audio/anthem.wav [--out DIR]
//
// Candidate (unapproved) libraries play here through ?rangeShots=all.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { DEFAULT_SETTINGS } from './lib/visual-evaluation.mjs';
import SCENE_CATALOG from '../src/world/terrain/sceneCatalogData.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const viewId = opt('--view') || 'monument-valley-163', song = path.resolve(opt('--song') || '.smoke/tour-audio/anthem.wav');
  const out = path.resolve(opt('--out') || `.smoke/shot-tour-smoke/${viewId}`);
  const view = SCENE_CATALOG.views.find((v) => v.id === viewId);
  assert.ok(view?.shotsManifestUrl, `${viewId} has no shot library in the catalog`);
  await fs.mkdir(out, { recursive: true });
  process.env.VISUAL_RANGE_SHOTS = 'all';
  const settings = { ...DEFAULT_SETTINGS, width: 640, height: 360, view: viewId, biome: view.biome, quality: 0 };
  const snapshot = await snapshotSource(root), server = await serveSnapshot(snapshot);
  const angle = process.env.VISUAL_ANGLE || 'swiftshader';
  const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const report = { viewId, song: path.basename(song), sourceDigest: snapshot.digest, checks: [], frames: [] };
  try {
    const row = { errors: [], warnings: [], events: [] };
    const loaded = await openEvaluationSong(browser, { url: server.url, audioPath: song, settings, diagnostics: { ...row, loadedFiles: new Set() } });
    try {
      const page = loaded.page;
      const status = await page.evaluate((id) => window.__SMW.sim.biomes.rangePresentation.status().shotTours.views[id], viewId);
      report.status = status;
      assert.equal(status?.state, 'ready', `tour not ready: ${JSON.stringify(status)}`);
      report.checks.push('planned');
      const payoffs = (status.payoffs || []).map((p) => Math.round(p.plannedMs ?? p.actualMs)).filter(Number.isFinite);
      const times = [...new Set([4000, ...payoffs.slice(0, 6)])].sort((a, b) => a - b);
      // The first export frame after loading differs from its repeats with
      // tours on or off alike (a warm-up of the renderer, not the camera), so
      // parity is checked from the second frame on.
      await renderEvaluationFrame(page, { timeMs: times[0], checkpoint: false, clips: [], save: false }, settings);
      for (const timeMs of times) {
        const point = { timeMs, checkpoint: true, clips: [], save: true };
        const frame = await renderEvaluationFrame(page, point, settings);
        const planned = await page.evaluate(([id, t]) => {
          const p = window.__SMW.sim.biomes.rangePresentation.shots.timeline(id).poseAt(t);
          return { eyeM: p.eyeM, targetM: p.targetM, fovYDeg: p.fovYDeg, shot: p.shot || null };
        }, [viewId, frame.actualTimeMs]);
        const cam = frame.camera;
        assert.ok(cam && near(cam.eyeM, planned.eyeM, 0.5), `drawn eye ${cam?.eyeM} != planned ${planned.eyeM} at ${timeMs}`);
        const look = planned.targetM.map((v, i) => v - planned.eyeM[i]), l = Math.hypot(...look);
        assert.ok(near(cam.forward, look.map((v) => v / l), 2e-3), `drawn look differs from the plan at ${timeMs}`);
        const again = await renderEvaluationFrame(page, point, settings);
        assert.equal(sha(Buffer.from(again.pngData, 'base64')), sha(Buffer.from(frame.pngData, 'base64')), `pause parity at ${timeMs}`);
        const file = `frame-${timeMs}.png`;
        await fs.writeFile(path.join(out, file), Buffer.from(frame.pngData, 'base64'));
        report.frames.push({ timeMs, actualTimeMs: frame.actualTimeMs, file, planned, camera: cam });
        console.log(`${viewId} ${timeMs} ms: ${planned.shot?.kind || '?'} ${planned.shot?.id || ''} phase ${planned.shot?.phase ?? '-'}; pause parity ok`);
      }
      report.checks.push('drawn camera is the plan', 'pause parity');
      // The seek path rebuilds the scene from scratch; the camera must be the same.
      const before = await page.evaluate(([id, ts]) => ts.map((t) => window.__SMW.sim.biomes.rangePresentation.shots.timeline(id).poseAt(t).eyeM), [viewId, times]);
      await page.evaluate(async (s) => { window.__SMW.beginBulkExport({ width: s.width, height: s.height }); await window.__SMW.rangeReady({ timeoutMs: 120000 }); }, settings);
      const after = await page.evaluate(([id, ts]) => ts.map((t) => window.__SMW.sim.biomes.rangePresentation.shots.timeline(id).poseAt(t).eyeM), [viewId, times]);
      before.forEach((e, i) => assert.ok(near(e, after[i], 1e-3), `rebuild replanned a different camera at ${times[i]}`));
      report.checks.push('rebuild replans the identical camera');
      console.log(`${viewId}: rebuild replans the identical camera`);
      assert.deepEqual(row.errors, []);
    } finally { await loaded.context.close(); await loaded.browserDiagnostics.dispose(); }
    // Tours off (as the toggle stores it and an evaluation loads it): the
    // same song at the same time draws the authored rail, without a shot.
    const offSettings = { ...settings, tour: 'off' }, offRow = { errors: [], warnings: [], events: [] };
    const off = await openEvaluationSong(browser, { url: server.url, audioPath: song, settings: offSettings, diagnostics: { ...offRow, loadedFiles: new Set() } });
    try {
      const railStatus = await off.page.evaluate(() => window.__SMW.sim.biomes.rangePresentation.status().shotTours);
      assert.equal(railStatus.enabled, false);
      await renderEvaluationFrame(off.page, { timeMs: 4000, checkpoint: false, clips: [], save: true }, offSettings);
      const rail = await renderEvaluationFrame(off.page, { timeMs: 8000, checkpoint: true, clips: [], save: true }, offSettings);
      assert.ok(rail.camera && !rail.camera.shot?.shot, 'tours off draws without a shot');
      await fs.writeFile(path.join(out, 'rail-8000.png'), Buffer.from(rail.pngData, 'base64'));
      report.rail = { timeMs: 8000, camera: rail.camera };
      report.checks.push('tours off draws the rail');
      assert.deepEqual(offRow.errors, []);
    } finally { await off.context.close(); await off.browserDiagnostics.dispose(); }
    report.status.ok = true;
  } finally {
    await browser.close(); await server.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  }
  console.log(`${viewId}: ${report.checks.join('; ')}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
