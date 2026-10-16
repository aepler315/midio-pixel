// Start npm run dev first. Representative Range frames with authored camera
// cues; generated audio is a fixture, not a claim about automatic segmentation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openSong, captureFrame } from './range-scene-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'http://127.0.0.1:8080';
const out = path.resolve(process.argv[3] || '.smoke/intentional-effects');
await fs.mkdir(out, { recursive: true });
const wav = path.join(out, 'fixture.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '72']);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const report = { fixture: '72-second WAV; authored verse/chorus/verse camera cues; local peak override; 100-second diagnostic sky cycle', browser: browser.version(), frames: [], errors: [] };
try {
  const { context, page, errors } = await openSong(browser, { url, wav, width: 640, height: 360,
    params: { rangeTour: 'off', rangeView: 'nc-ross-lake-north', seed: '315' } });
  try {
    await page.evaluate(() => {
      const mgr = window.__SMW.sim.biomes, template = mgr.sections[0];
      mgr.sections = [
        { ...template, startMs: 0, endMs: 20000, role: 'verse', kind: 'verse', relEnergy01: .3 },
        { ...template, startMs: 20000, endMs: 32000, role: 'chorus', kind: 'chorus', relEnergy01: .9 },
        { ...template, startMs: 32000, endMs: 72000, role: 'verse', kind: 'verse', relEnergy01: .35 },
      ];
      mgr.actorPeakOverride = 1;
      mgr._dayNightCycleMs = 100000;
    });
    const sample = () => page.evaluate(() => {
      const pres = window.__SMW.sim.biomes.rangePresentation, scene = pres.scene, p = scene.prepared.get(pres.viewId);
      return { effect: pres.frame.cameraEffects, fov: scene.camera.fov,
        cloudCount: p.uniforms.uCloudCount.value, moonClouds: p.uniforms.uMoonClouds.value,
        cast: Object.fromEntries(Object.entries(p.actors.groups).map(([id, g]) => [id, g.visible])),
        cohere: Object.fromEntries(Object.entries(p.actors.uniforms).map(([id, u]) => [id, u.uCohere.value])),
        giants: p.uniforms.uGiantPeak.value, giantResources: !!(p.actors.mask || p.actors.clouds || p.actors.reflection) };
    });
    for (const timeMs of [19500, 20000, 22500, 60000]) {
      const frame = await captureFrame(page, timeMs), state = await sample();
      assert.equal(frame.range.active, true);
      assert.equal(state.giantResources, false);
      assert.ok(state.giants.every(x => x === 0));
      assert.ok(Object.values(state.cast).every(Boolean));
      const repeat = await captureFrame(page, timeMs);
      assert.deepEqual(await sample(), state, 'held time preserves the camera and cast state');
      const parity = await page.evaluate(async ([a, b]) => {
        const load = async png => { const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode(); return image; };
        const images = await Promise.all([load(a), load(b)]), canvas = document.createElement('canvas');
        canvas.width = images[0].width; canvas.height = images[0].height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const pixels = images.map(image => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; });
        let maxByteDelta = 0, changedPixels = 0;
        for (let i = 0; i < pixels[0].length; i += 4) {
          let delta = 0;
          for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(pixels[0][i+c] - pixels[1][i+c]));
          maxByteDelta = Math.max(maxByteDelta, delta); if (delta) changedPixels++;
        }
        return { maxByteDelta, changedPixels, exact: a === b };
      }, [frame.png, repeat.png]);
      assert.ok(parity.maxByteDelta <= 1, 'held frame pixels differ by at most one color level');
      await fs.writeFile(path.join(out, `${timeMs}.png`), Buffer.from(frame.png, 'base64'));
      report.frames.push({ timeMs, state, parity, identity: frame.identity, range: frame.range });
      console.log(`Effects ${timeMs}ms: FOV ${state.fov.toFixed(2)}, all three cast groups enabled, maximum held-frame delta ${parity.maxByteDelta}`);
    }
    assert.equal(report.frames[0].state.effect.halfAngleScale, 1);
    assert.ok(report.frames[1].state.effect.halfAngleScale < .95);
    assert.equal(report.frames[2].state.effect.halfAngleScale, 1);
    assert.equal(report.frames[3].state.moonClouds, 1);
    assert.ok(report.frames[3].state.cloudCount > 0);
    report.errors = errors; assert.deepEqual(errors, []);
    report.passed = true;
  } finally { await context.close(); }
} finally {
  await browser.close();
  report.sourceHashes = {};
  for (const file of ['src/render/CameraLens.js', 'src/world/alpine/CloudOcclusion.js', 'src/world/alpine/RangeFrame.js', 'src/world/alpine/RangeScene.js', 'src/world/alpine/RangePresentation.js', 'src/world/alpine/TerrainMaterial.js', 'src/world/alpine/ActorsGL.js', 'src/world/alpine/RangeSkyComposition.js', 'src/world/BiomeManager.js']) {
    report.sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  }
  await fs.writeFile(path.join(out, 'browser-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
}
