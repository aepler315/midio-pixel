// The production water pass, restricted and whole, on a real GPU: the same
// frame must come back with identical bytes. Each frame renders whole, then
// restricted, then whole again, so an unstable frame cannot pass as a match.
// Mirror frames leave the seam draws hidden, so this shows them explicitly and
// covers the combined pass and each band's direct pass.
//   node tools/water-colour-smoke.mjs WAV_FILE [--url http://127.0.0.1:8195] [--view teton-jackson-lake] [--out .smoke/water-colour]
// Add --mobile for the mobile budget, --swiftshader for software rendering. Serve this tree with tools/serve.js.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { captureFrame, openSong } from './range-scene-smoke.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const wav = process.argv[2], url = arg('url', 'http://127.0.0.1:8195'), view = arg('view', 'teton-jackson-lake');
if (!wav) throw new Error('Usage: node tools/water-colour-smoke.mjs WAV_FILE');
const out = path.resolve(arg('out', '.smoke/water-colour'));
await fs.mkdir(out, { recursive: true });
const gpu = process.argv.includes('--swiftshader') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...gpu, '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const report = { view, frames: [] };
const contexts = { async newContext(options) {
  const context = await browser.newContext(options);
  if (process.argv.includes('--mobile')) await context.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 }));
  return context;
} };
try {
  const opened = await openSong(contexts, { url, wav: path.resolve(wav), width: 1280, height: 720, params: { rangeRenderer: 'v2', rangeView: view } });
  for (const timeMs of [250, 5000, 12000]) {
    await captureFrame(opened.page, timeMs);
    const frame = await opened.page.evaluate(async () => {
      const pres = window.__SMW.sim.biomes.rangePresentation, scene = pres.scene, p = scene.prepared.get(pres.viewId);
      const gl = scene.renderer.getContext(), base = pres.frame, ranges = p.waterColour;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const draws = [];
      const native = gl.drawElements;
      gl.drawElements = function (mode, count, type, offset) { draws.push(count); return native.call(this, mode, count, type, offset); };
      const seams = (p.fringeMeshes || []).map(mesh => [mesh, mesh.visible]);
      const shot = (restricted, width, height, pass) => {
        p.waterColour = restricted ? ranges : null;
        draws.length = 0;
        const canvas = scene.renderWater(base, pres.viewId, width, height, { pass });
        const copy = new OffscreenCanvas(canvas.width, canvas.height), ctx = copy.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0);
        return { pixels: ctx.getImageData(0, 0, copy.width, copy.height).data, draws: [...draws] };
      };
      try {
        const sizes = [[scene.size.width, scene.size.height], [1280, 720]], results = [];
        shot(false, ...sizes[0], null); // Refresh the mirror once, then hold every shot to the same inputs.
        for (const [mesh] of seams) mesh.visible = true;
        for (const [width, height] of sizes) for (const pass of [null, 'far', 'mid', 'near']) {
          const a = shot(false, width, height, pass), b = shot(true, width, height, pass), c = shot(false, width, height, pass);
          let wet = 0, stable = true, equal = true;
          for (let i = 0; i < a.pixels.length; i++) {
            if (a.pixels[i] !== c.pixels[i]) stable = false;
            if (a.pixels[i] !== b.pixels[i]) equal = false;
            if (i % 4 === 3 && a.pixels[i]) wet++;
          }
          const sum = list => list.reduce((n, v) => n + v, 0);
          results.push({ width, height, pass, wetPixels: wet, stable, equal, wholeDraws: c.draws.length, wholeIndices: sum(c.draws), restrictedDraws: b.draws.length, restrictedIndices: sum(b.draws) });
        }
        return { viewId: pres.viewId, frameId: base.frameId, budget: scene.budget, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, groups: ranges?.map(e => e.groups.length), results };
      } finally {
        p.waterColour = ranges;
        for (const [mesh, visible] of seams) mesh.visible = visible;
        gl.drawElements = native;
      }
    });
    report.frames.push({ timeMs, ...frame });
    for (const r of frame.results) assert.ok(r.equal, `${timeMs} ms ${r.width}x${r.height} ${r.pass}: restricted water differs (stable control: ${r.stable})`);
  }
  report.errors = opened.errors;
  await opened.context.close();
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 1));
