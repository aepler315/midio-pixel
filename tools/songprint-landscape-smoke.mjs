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

// Twelve-second passages A and B repeat three times with different interval patterns.
// The synthesizer alone knows where they repeat.
function repeatedMotifs() {
  const a = [0,7,3,10,2,9,1,5,0,4,7,2,10,3,4,7,1,6,2,10,3,8,0,9];
  const b = [0,1,2,4,5,3,2,1,2,4,6,7,8,9,8,7,9,11,10,8,7,6,4,3];
  const notes = [...a, ...b, ...a, ...b, ...a, ...b], rate = 11025, beat = 5512;
  const pcm = Buffer.alloc(2 * beat * notes.length), header = Buffer.alloc(44);
  for (let n = 0; n < notes.length; n++) {
    const hz = 220 * 2 ** (notes[n] / 12);
    const gain = n < 48 ? .45 : n < 96 ? 1 : .7;
    for (let sample = 0; sample < beat; sample++) {
      const t = sample / rate, phase = 2 * Math.PI * hz * t;
      const amplitude = gain * (.64 * Math.cos(phase) + .18 * Math.cos(2 * phase)) * Math.min(1, t * 80, (.5 - t) * 40);
      pcm.writeInt16LE(Math.round(32767 * amplitude), 2 * (n * beat + sample));
    }
  }
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function colorCount(png) {
  const pixels = PNG.sync.read(png), colors = new Set();
  for (let i = 0; i < pixels.data.length; i += 4 * 19) colors.add(pixels.data.readUInt32BE(i));
  return colors.size;
}

async function resetExportClock(page) {
  return page.evaluate(async () => {
    if (window.__SMW_EXPORT_ERROR) throw new Error(window.__SMW_EXPORT_ERROR);
    const app = window.__SMW;
    app.beginBulkExport(app.exportSize);
    await app.rangeReady({ timeoutMs: 120000 });
    return app.durationMs;
  });
}

/** Reopen the cached fixture under the same visible Settings choices and the
 * ordinary composed-range default. The export clock makes its frames exact. */
async function captureComposedSequence(page, file) {
  const url = new URL(page.url());
  url.searchParams.delete('rangeRenderer');
  url.searchParams.delete('songRange');
  url.searchParams.delete('rangeTour');
  const cacheHit = page.waitForEvent('console', {
    predicate: m => m.text().startsWith('[analysis] restored from cache'), timeout: 120000,
  });
  await page.goto(url.href);
  await page.locator('#titleSettings').evaluate(node => { node.open = true; });
  assert.equal(await page.locator('#songprintLandscape').inputValue(), 'on');
  await Promise.all([cacheHit, page.locator('#fileInput').setInputFiles(file)]);
  await page.waitForFunction(() => window.__SMW?.exportReady || window.__SMW_EXPORT_ERROR, null, { timeout: 120000 });
  const durationMs = await resetExportClock(page);
  const snap = async timeMs => {
    const rendered = await captureFrame(page, timeMs);
    assert.ok(rendered.range.active && rendered.range.runtime === 'ready', rendered.range.reason);
    const png = Buffer.from(rendered.png, 'base64');
    assert.ok(colorCount(png) > 32, 'the composed view renders a nonblank scene');
    const evidence = await page.evaluate(() => {
      const { sim } = window.__SMW;
      const range = sim.biomes.rangePresentation;
      const prepared = range.scene.prepared.get(range.viewId);
      const plan = prepared?.view?.songRange?.plan;
      const { eyeM, targetM, fovYDeg, viewOffset, songprintOrbit } = range.scene.camera.userData.rangeCameraPose;
      const composition = prepared?.view?.songprintComposition;
      return { viewId: range.viewId, key: prepared?.view?.songRange?.key, tiles: prepared?.data?.tiles?.size,
        principal: plan?.principal?.slotId, companion: plan?.companionSlot, composition, slotRise: range.frame.slotRise01,
        eyeM, targetM, fovYDeg, viewOffset, songprintOrbit };
    });
    assert.ok(evidence.key && evidence.tiles > 0, 'the draw used the prepared, composed terrain');
    assert.ok(evidence.principal && evidence.companion && evidence.principal !== evidence.companion,
      'the rendered composition establishes an identifiable pair');
    assert.equal(evidence.composition?.principal.slotId, evidence.principal);
    assert.equal(evidence.composition?.companion.slotId, evidence.companion);
    return { evidence, png };
  };
  const frames = [];
  for (const [label, timeMs] of [['opening', 10000], ['middle', Math.round(durationMs * .55)], ['finale', durationMs - 2000]]) {
    const { evidence, png } = await snap(timeMs);
    await fs.writeFile(path.join(output, `composed-${label}.png`), png);
    frames.push({ label, timeMs, ...evidence });
  }
  const [opening, middle, finale] = frames;
  assert.ok(frames.every(frame => frame.songprintOrbit && !(frame.viewOffset?.fx > 0)),
    'the normal music-timed camera uses the orbit without automatic projection crop');
  assert.ok(Math.hypot(finale.eyeM[0] - opening.eyeM[0], finale.eyeM[2] - opening.eyeM[2]) > 250,
    'the camera physically travels across the stage');
  assert.equal(opening.fovYDeg, middle.fovYDeg, 'the tour uses a constant lens after analysis');
  assert.equal(finale.fovYDeg, middle.fovYDeg);
  for (const id of [opening.principal, opening.companion]) {
    assert.ok(opening.slotRise[id] > .02, 'the opening develops both leading peaks');
    assert.ok(middle.slotRise[id] >= opening.slotRise[id], 'the pair keeps its gained height');
    assert.equal(finale.slotRise[id], 1, 'the finale shows the complete pair');
  }
  assert.ok(frames.every(frame => frame.key === opening.key), 'the chosen stage carries the entire song');
  await resetExportClock(page);
  const replay = (await snap(middle.timeMs)).evidence;
  assert.deepEqual({ label: middle.label, timeMs: middle.timeMs, ...replay }, middle,
    'the same camera and terrain heights are restored after rewinding');
  return frames;
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
    params: { songRange: 'off', rangeRenderer: 'v2', rangeTour: 'off', lyrics: '0' },
    configure: async page => {
      const landscape = page.locator('#settings-landscape');
      const weather = landscape.locator('#songprintAtmosphere');
      const summits = landscape.locator('#songprintLandscape');
      assert.equal(await summits.inputValue(), 'off');
      await weather.check();
      assert.equal(await summits.inputValue(), 'off', 'weather can be enabled on its own');
      await summits.selectOption('on');
    } });
  const terrain = () => page.evaluate(() => {
    const mgr = window.__SMW.sim.biomes, t = mgr.songTerrain;
    return { print: t.songprint, home: t.sceneByBiome.get(t.home).view.id,
      weather: mgr.songprintAtmosphere, phraseFamilies: mgr.songprintWeatherPrint?.phraseFamilies };
  });
  const first = await terrain();
  assert.equal(first.print?.version, 1);
  assert.equal(first.print.skyline.length, 16);
  assert.equal(first.weather, true);
  assert.ok(first.phraseFamilies?.families.some(family => family.occurrences.length >= 2));
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
  const colors = colorCount(png);
  assert.ok(colors > 32, 'nonblank geographic scene');
  await fs.writeFile(path.join(output, 'returning-landmark.png'), png);

  const weatherTime = await page.evaluate(async () => {
    const { landscapeScoreFor } = await import('/src/world/alpine/LandscapeScore.js');
    const score = landscapeScoreFor(window.__SMW.sim.biomes);
    return score.songprintWeatherGestures?.find(gesture => gesture.timeMs >= 30000)?.timeMs ?? null;
  });
  assert.ok(weatherTime, 'audio analysis and Settings produce a qualifying weather return');
  const weatherFrame = await captureFrame(page, weatherTime);
  assert.ok(weatherFrame.range.active && weatherFrame.range.runtime === 'ready');
  const readWeather = () => page.evaluate(async timeMs => {
    const { atmosphereMusic, mistParams } = await import('/src/world/alpine/RangeAtmosphere.js');
    const { compileLandscapeScore } = await import('/src/world/alpine/LandscapeScore.js');
    const { sim } = window.__SMW;
    const mgr = sim.biomes;
    const { frame, scene, viewId } = mgr.rangePresentation;
    const { rules, uniforms } = scene.prepared.get(viewId);
    const ordinary = mistParams({ rules, calm01: 1 - (frame.music?.groove ?? 0) }).density
      * (frame.narrative?.atmosphere ?? 1) * atmosphereMusic(frame.effects).mistDensityMul;
    const score = mgr.landscapeScore;
    const cleanScore = compileLandscapeScore({ energyCurves: mgr.energyCurves, durationMs: mgr.durationMs,
      songprintAtmosphere: mgr.songprintAtmosphere, songprintWeatherPrint: mgr.songprintWeatherPrint });
    return { cue: frame.performance.songprintWeather, mistDensity: uniforms.uMistDensity.value, ordinary,
      localClearing: uniforms.uMistSongprint?.value.toArray() ?? [0, 0, 0, 0],
      frameTimeMs: frame.timeMs, heardTimeMs: sim.heardTimeMs, viewId,
      preview: !!mgr.terrainPreview, analyzedThroughMs: mgr.analyzedThroughMs,
      admittedMs: mgr.songprintWeatherAdmittedMs, cadenceMs: score?.cadenceMs, freezeThroughMs: score?.freezeThroughMs,
      gestures: score?.songprintWeatherGestures, plannedCue: score?.at(frame.timeMs).songprintWeather,
      cleanGestures: cleanScore.songprintWeatherGestures, energy: [-3000, -2000, -1000, 0, 1000, 2000]
        .map(offset => mgr.energyCurves?.globalEnergyNorm(timeMs + offset)) };
  }, weatherTime);
  const weather = await readWeather();
  assert.ok(weather.cue?.mistDensityMul < 1 && weather.cue.windGust01 > 0);
  assert.ok(weather.mistDensity > 0, 'the real valley mist uniforms are active');
  const [x, z, radiusM, clear01] = weather.localClearing;
  if (clear01 > 0) {
    assert.ok(Number.isFinite(x) && Number.isFinite(z) && radiusM > 0);
    assert.ok(Math.abs(clear01 - (1 - weather.cue.mistDensityMul)) < 1e-9);
  }
  const expectedDensity = weather.ordinary * (clear01 > 0 ? 1 : weather.cue.mistDensityMul);
  assert.ok(Math.abs(weather.mistDensity - expectedDensity) < 1e-9, 'the terrain pass applied the scheduled clearing');
  await fs.writeFile(path.join(output, 'returning-weather.png'), Buffer.from(weatherFrame.png, 'base64'));

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
  await page.waitForFunction(() => window.__SMW?.exportReady || window.__SMW_EXPORT_ERROR, null, { timeout: 120000 });
  await resetExportClock(page);
  assert.deepEqual(await terrain(), first);
  await captureFrame(page, weatherTime);
  const replay = await readWeather();
  assert.ok(replay.cue, `cached weather return is missing ${JSON.stringify({ weatherTime, weather, replay })}`);
  assert.equal(replay.cue.timeMs, weather.cue.timeMs);
  assert.equal(replay.cue.familyIndex, weather.cue.familyIndex);
  assert.deepEqual(replay.localClearing.slice(0, 3), weather.localClearing.slice(0, 3));
  // The cache quantizes energy bands to 8 bits. Timing and geography
  // must match exactly; the scaled gesture may differ slightly.
  assert.ok(Math.abs(replay.cue.mistDensityMul - weather.cue.mistDensityMul) < .015);
  assert.ok(Math.abs(replay.cue.windGust01 - weather.cue.windGust01) < .015);
  const composed = await captureComposedSequence(page, file);
  await fs.writeFile(path.join(output, 'composed-sequence.json'), JSON.stringify(composed, null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ view: first.home, passages: cues, camera, weather, colors,
    cachedReplay: true, composed: { view: composed[0].viewId, frames: composed.map(frame => [frame.label, frame.timeMs]) } }));
} finally {
  await browser?.close();
  await server?.close();
}
