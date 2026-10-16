// Real Range v2 composition with a controlled returning-section cut. The
// injection isolates the cut overlay without relying on a fixture's labels.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { manifestForCase } from './lib/visual-evaluation.mjs';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';

const source = path.resolve(process.argv[3] || '.');
const out = path.resolve(process.argv[2] || '.smoke/vfx-accessibility');
const audioPath = path.resolve(process.argv[4] || '.smoke/addendum-candidate/contrast/audio.wav');
const matrix = JSON.parse(await fs.readFile('test/fixtures/visual-evaluation-vfx.json', 'utf8'));
const settings = { ...manifestForCase(matrix, 'q2-natural-inland-flash').settings, reducedFlash: false };
await fs.mkdir(out, { recursive: false });
const snapshot = await snapshotSource(source), server = await serveSnapshot(snapshot);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const diagnostics = { errors: [], warnings: [], loadedFiles: new Set() };
const report = { passed: false, song: 'contrast', timeMs: 12000, injection: 'returning-section cut flash = 1', sourceDigest: snapshot.digest, frames: [] };
try {
  const loaded = await openEvaluationSong(browser, { url: server.url, audioPath, settings, diagnostics });
  await renderEvaluationFrame(loaded.page, { timeMs: 12000, save: false }, settings);
  report.environment = loaded.environment;
  const frames = await loaded.page.evaluate(() => {
    const { sim, renderer } = window.__SMW, canvasRenderer = renderer.canvasRenderer, ctx = canvasRenderer.ctx;
    const original = ctx.fillRect, frames = [];
    let flashes = [];
    ctx.fillRect = function (x, y, width, height) {
      if (this.fillStyle === '#ffffff' && x === 0 && y === 0 && width > 600 && height > 300) flashes.push(this.globalAlpha);
      return original.call(this, x, y, width, height);
    };
    try {
      for (const reducedFlash of [false, true]) {
        flashes = []; sim.setReducedFlash(reducedFlash); sim.biomes._cutFlash = 1;
        renderer.draw(sim, 1);
        if (!window.__SMW.rangeState.active) throw new Error('composed Range v2 view is required');
        const canvas = document.querySelector('#stage'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let luminance = 0;
        for (let i = 0; i < pixels.length; i += 4) luminance += pixels[i] + pixels[i + 1] + pixels[i + 2];
        frames.push({ reducedFlash, flashes, meanRgb: luminance / (pixels.length / 4), png: canvas.toDataURL('image/png').split(',')[1] });
      }
      return frames;
    } finally { ctx.fillRect = original; sim.setReducedFlash(false); }
  });
  for (const frame of frames) {
    const file = `cut-${frame.reducedFlash ? 'reduced' : 'normal'}.png`;
    await fs.writeFile(path.join(out, file), Buffer.from(frame.png, 'base64'));
    delete frame.png; report.frames.push({ ...frame, file });
  }
  assert.deepEqual(frames[0].flashes, [.35]);
  assert.deepEqual(frames[1].flashes, []);
  assert.ok(frames[1].meanRgb < frames[0].meanRgb, 'reduced cut must lower the final composed frame brightness');
  assert.deepEqual(diagnostics.errors, []);
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  await browser.close(); await server.close();
  report.errors = diagnostics.errors;
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, frames: report.frames, error: report.error }));
}
