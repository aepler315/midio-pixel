// Exercise the real file picker, audio worker, IndexedDB and 3D landscape.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { openSong, captureFrame } from './range-scene-smoke.mjs';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.smoke/songprint-browser');
await fs.mkdir(output, { recursive: true });

// Four twelve-second passages. A and B follow different interval patterns.
// The synthesizer alone knows where they repeat.
function repeatedMotifs() {
  const a = [0,7,3,10,2,9,1,5,0,4,7,2,10,3,4,7,1,6,2,10,3,8,0,9];
  const b = [0,1,2,4,5,3,2,1,2,4,6,7,8,9,8,7,9,11,10,8,7,6,4,3];
  const notes = [...a, ...b, ...a, ...b], rate = 11025, beat = 5512;
  const pcm = Buffer.alloc(2 * beat * notes.length), header = Buffer.alloc(44);
  for (let n = 0; n < notes.length; n++) {
    const hz = 220 * 2 ** (notes[n] / 12);
    for (let sample = 0; sample < beat; sample++) {
      const t = sample / rate, phase = 2 * Math.PI * hz * t;
      const amplitude = (.64 * Math.cos(phase) + .18 * Math.cos(2 * phase)) * Math.min(1, t * 80, (.5 - t) * 40);
      pcm.writeInt16LE(Math.round(32767 * amplitude), 2 * (n * beat + sample));
    }
  }
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const file = path.join(output, 'repeating-motifs.wav');
await fs.writeFile(file, repeatedMotifs());
let server, browser;
try {
  const url = process.argv[2] || (server = await serveSnapshot(await snapshotSource(root))).url;
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
  });
  const { page, errors } = await openSong(browser, { url, wav: file, width: 640, height: 360,
    params: { songprintLandscape: 'on', songRange: 'off', rangeRenderer: 'v2', rangeTour: 'off', lyrics: '0' } });
  const terrain = () => page.evaluate(() => {
    const t = window.__SMW.sim.biomes.songTerrain;
    return { print: t.songprint, home: t.sceneByBiome.get(t.home).view.id };
  });
  const first = await terrain();
  assert.equal(first.print?.version, 1);
  assert.equal(first.print.skyline.length, 16);
  const cues = [6000, 18000, 30000].map(ms => first.print.passages.find(p => Math.abs(p.timeMs - ms) < 150 && p.strength > .65));
  assert.ok(cues.every(Boolean), 'both different motifs and the return were recognised');
  assert.ok(Math.abs(cues[0].landmark01 - cues[2].landmark01) < .06, 'A returns to its original landmark');
  assert.ok(Math.abs(cues[0].landmark01 - cues[1].landmark01) > .12, 'B has its own landmark');
  const frame = await captureFrame(page, cues[2].timeMs);
  assert.ok(frame.range.active && frame.range.runtime === 'ready', 'the measured landscape is on screen');
  assert.equal(frame.range.viewId, first.home);
  const camera = await page.evaluate(() => {
    const r = window.__SMW.sim.biomes.rangePresentation;
    return {
      targets: r.frame.performance.songprintCue?.targets || [],
      landmarks: r.scene.prepared.get(r.viewId)?.songprintLandmarks?.length || 0,
      framed: r.scene.camera.userData.rangeCameraPose?.songprintReveal?.pointM || null,
    };
  });
  assert.ok(camera.landmarks > 0, 'the surveyed view prepared real geographic landmark targets');
  assert.ok(camera.targets.some(t => Math.abs(t.landmark01 - cues[2].landmark01) < .01 && t.weight > .5),
    'the returning motif reached the camera on the heard clock');
  const png = Buffer.from(frame.png, 'base64');
  const pixels = PNG.sync.read(png), colors = new Set();
  for (let i = 0; i < pixels.data.length; i += 4 * 19) colors.add(pixels.data.readUInt32BE(i));
  assert.ok(colors.size > 32, 'nonblank geographic scene');
  await fs.writeFile(path.join(output, 'returning-landmark.png'), png);

  // Wait for the asynchronously written whole-song bundle before opening
  // the same file afresh; then require an actual hit, as well as equality.
  await page.waitForFunction(async () => {
    const cache = await import('/src/audio/AnalysisCache.js');
    return (await cache.listBundles()).some(b => b.name === 'repeating-motifs.wav');
  }, null, { timeout: 45000, polling: 250 });
  const hit = page.waitForEvent('console', { predicate: m => m.text().startsWith('[analysis] restored from cache'), timeout: 120000 });
  await page.reload();
  await page.waitForFunction(() => window.__SMW?.settings);
  await Promise.all([hit, page.locator('#fileInput').setInputFiles(file)]);
  await page.waitForFunction(() => window.__SMW?.exportReady, null, { timeout: 120000 });
  assert.deepEqual(await terrain(), first);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ view: first.home, passages: cues, camera, colors: colors.size, cachedReplay: true }));
} finally {
  await browser?.close();
  await server?.close();
}
