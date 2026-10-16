// Forest evidence; times are seconds. Evidence stays in .smoke/.
// node tools/forest-closeup-smoke.mjs http://127.0.0.1:8092 .smoke/forest --times 0,8,16
// --sample surveys poseAt every 2 s; --debug enables representation tints.
// --motion 40 draws consecutive frames for two seconds at 24 fps.
// --flicker 40 freezes the pose/time and translates laterally in 16 subpixel steps.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openSong, captureFrame } from './range-scene-smoke.mjs';
import { FOREST_CHECKPOINTS } from './lib/forest-checkpoints.mjs';
import { fullForestWindow, resetForestSkyline } from './lib/forest-window.mjs';
import { seedBrowserConstruction } from './lib/landscape-browser.mjs';
import { flickerStats } from './lib/forest-flicker.mjs';
import { measureForestRingTone } from './lib/forest-ring-tone.mjs';
import { measureForestFarDots } from './lib/forest-far-dots.mjs';
export { fullForestWindow } from './lib/forest-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = b => createHash('sha256').update(b).digest('hex');
export function parseForestArgs(argv) {
  const [url, output, ...flags] = argv;
  assert.ok(url && output, 'URL and new output directory are required');
  const out = { url: new URL(url).href, output: path.resolve(output), debug: false, sample: false, noIsolation: false };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--times') {
      const values = flags[++i]?.split(',');
      assert.ok(values?.length && values.every(v => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 96), '--times requires comma-separated seconds in [0,96)');
      out.timesMs = [...new Set(values.map(v => Number(v) * 1000))].sort((a, b) => a - b);
    } else if (flags[i] === '--ring-tone') out.ringTone = true;
    else if (flags[i] === '--far-dots') out.farDots = true;
    else if (flags[i] === '--debug') out.debug = true;
    else if (flags[i] === '--motion') {
      const value = flags[++i];
      assert.ok(value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 94, '--motion requires seconds in [0,94]');
      out.motionStartMs = Number(value) * 1000;
    } else if (flags[i] === '--flicker') {
      const value = flags[++i];
      assert.ok(value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) < 96, '--flicker requires seconds in [0,96)');
      out.flickerTimeMs = Number(value) * 1000;
    }
    else if (flags[i] === '--sample') out.sample = true;
    else if (flags[i] === '--no-isolation') out.noIsolation = true;
    else throw new Error(`unknown flag ${flags[i]}`);
  }
  if (out.motionStartMs != null) {
    assert.equal(out.flickerTimeMs, undefined, '--motion and --flicker are separate protocols');
    out.timesMs ??= [out.motionStartMs];
    assert.deepEqual(out.timesMs, [out.motionStartMs], '--motion requires its start as the only checkpoint');
  }
  if (out.flickerTimeMs != null) {
    out.timesMs ??= [out.flickerTimeMs];
    assert.deepEqual(out.timesMs, [out.flickerTimeMs], '--flicker requires its fixed pose as the only checkpoint');
  }
  if (out.ringTone) {
    assert.equal(out.debug, false, 'ring tone requires forestDebug off');
    assert.ok(out.timesMs?.includes(76000), 'ring tone requires the original 76-second checkpoint');
  }
  if(out.farDots){
    assert.equal(out.debug,false,'far dots require forestDebug off');
    assert.ok(out.timesMs?.includes(76000),'far dots require the original 76-second checkpoint');
  }
  assert.ok(out.timesMs || out.sample, '--times or --motion is required unless surveying with --sample');
  return out;
}
export function cropRect(width, height, center = [width / 2, height / 2]) {
  return { x: Math.max(0, Math.min(width - 512, Math.round(center[0] - 256))),
    y: Math.max(0, Math.min(height - 512, Math.round(center[1] - 256))), width: 512, height: 512 };
}

async function readyFrame(page, timeMs) {
  await captureFrame(page, timeMs, { finishGpu: true });
  await page.evaluate(async ({ timeMs: t, waitWindow, resetSkyline }) => {
    const scene = window.__SMW.sim.biomes.rangePresentation.scene;
    const p = [...scene.prepared.values()].find(p => p.windowCache);
    if (!p) throw new Error('Teton window cache unavailable');
    const heardMs = window.__SMW.sim.heardTimeMs ?? t;
    // The dev server exposes public sources only, not tools/. This helper
    // is our own browser-safe code; no external input is evaluated.
    const wait = new Function(`return (${waitWindow})`)();
    const w = await wait(p.windowCache, heardMs);
    scene._swapTourWindow(p, w);
    const reset = new Function(`return (${resetSkyline})`)();
    reset(window.__SMW.sim.biomes);
  }, { timeMs, waitWindow: fullForestWindow.toString(), resetSkyline: resetForestSkyline.toString() });
  const frame = await captureFrame(page, timeMs, { finishGpu: true });
  assert.equal(frame.range.active, true, JSON.stringify(frame.range.failures));
  const state = await page.evaluate(t => {
    const pres = window.__SMW.sim.biomes.rangePresentation;
    const p = [...pres.scene.prepared.values()].find(p => p.windowCache);
    const heardMs = window.__SMW.sim.heardTimeMs ?? t;
    const camera = pres.scene.camera;
    return { heardMs, pose: pres.tour.poseAt(heardMs),
      compositorCamera: Object.fromEntries(['_shakeSeed', 'shakeX', 'shakeY', 'ambientX', 'ambientY', 'roll', 'zoom'].map(key => [key, window.__SMW.sim.camera[key]])),
      renderedCamera: { eyeM: camera.position.toArray(), forward: camera.getWorldDirection(new pres.scene.THREE.Vector3()).toArray(), fovYDeg: camera.fov, aspect: camera.aspect },
      trees: p.stats.trees, windowIndex: p.windowIndex, coarse: p.activeWindow.coarse,
      detail: p.activeWindow.detail,
      shaderInputs: Object.fromEntries(Object.entries(p.uniforms).flatMap(([key, { value }]) => {
        if (typeof value === 'number') return [[key, value]];
        if (value?.toArray && !value.isTexture) return [[key, value.toArray()]];
        if (Array.isArray(value) || ArrayBuffer.isView(value)) return [[key, Array.from(value)]];
        return [];
      })),
      skyline: window.__SMW.sim.biomes._skyline && { ...window.__SMW.sim.biomes._skyline,
        ys: Array.from(window.__SMW.sim.biomes._skyline.ys) },
    };
  }, timeMs);
  assert.equal(state.coarse, false);
  assert.equal(state.windowIndex, Math.floor(state.heardMs / 8000), 'a held neighbouring window is not this baseline');
  return { frame, state };
}

// Survey roots and actual terrain ray intersections, not an assumed itinerary.
// Striding roots keeps this developer-only probe small; visibility is checked
// against the DEM. The saved images remain the final choice of framing.
async function survey(page) {
  return page.evaluate(async () => {
    const { terrainHeightAt } = await import('/src/world/alpine/TerrainMesh.js');
    const { RULE_DEFAULTS } = await import('/src/world/alpine/MaterialPackage.js');
    const pres = window.__SMW.sim.biomes.rangePresentation, scene = pres.scene;
    const p = [...scene.prepared.values()].find(p => p.windowCache), T = scene.THREE;
    const camera = new T.PerspectiveCamera(40, 16 / 9, 1, 150000), point = new T.Vector3();
    const samples = []; let raw, index = -1;
    for (let timeMs = 0; timeMs < pres.tour.durationMs; timeMs += 2000) {
      const next = Math.floor(timeMs / 8000);
      if (next !== index) { raw = await p.windowWorker.build(next, p.windowOptions); index = next; }
      const pose = pres.tour.poseAt(timeMs), eye = pose.eyeM;
      camera.position.fromArray(eye); camera.fov = pose.fovYDeg;
      camera.lookAt(...pose.targetM); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      const visible = (x, y, z) => {
        const d = Math.hypot(x - eye[0], y - eye[1], z - eye[2]);
        for (let s = 40; s < d - 35; s += Math.max(40, d / 80)) {
          const u = s / d, h = terrainHeightAt(p.data, eye[0] + (x - eye[0]) * u, eye[2] + (z - eye[2]) * u);
          if (h > eye[1] + (y - eye[1]) * u + 4) return false;
        }
        return true;
      };
      const bins = [0, 0, 0, 0], targets = [null, null, null, null];
      let nearest = null, treeline = null;
      for (const data of [raw.placed.meshDetail || [], raw.placed.mesh, raw.placed.billboard]) for (let o = 0; o < data.length; o += data === raw.placed.billboard ? 8 * 16 : 8) {
        const x = data[o], y = data[o + 1] + data[o + 3] * .65, z = data[o + 2];
        point.set(x, y, z).project(camera);
        if (Math.abs(point.x) > .85 || Math.abs(point.y) > .85 || point.z < -1 || point.z > 1) continue;
        const d = Math.hypot(x - eye[0], y - eye[1], z - eye[2]);
        const bin = d < 300 ? 0 : d >= 1000 && d <= 3000 ? 1 : d >= 4000 && d <= 8000 ? 2 : d >= 6000 && d <= 14000 ? 3 : -1;
        const pixel = [(point.x + 1) * 960, (1 - point.y) * 540];
        if (bin >= 0 && (!targets[bin] || bins[bin] < 5) && visible(x, y, z)) {
          bins[bin]++; targets[bin] ??= { distanceM: d, rootM: [x, data[o + 1], z], pixel };
        }
        if ((!nearest || d < nearest.distanceM) && visible(x, y, z)) nearest = { distanceM: d, rootM: [x, data[o + 1], z], pixel };
        const below = p.rules.treelineM - data[o + 1];
        if (Math.abs(below) < 150 && (!treeline || Math.abs(below) < Math.abs(treeline.belowM)) && visible(x, y, z)) treeline = { belowM: below, distanceM: d, pixel };
      }
      const faces = [];
      for (const sx of [-.9, -.6, -.3, 0, .3, .6, .9]) for (const sy of [-.9, -.6, -.3, 0, .3, .6, .9]) {
        const ray = new T.Vector3(sx, sy, .5).unproject(camera).sub(camera.position).normalize();
        for (let d = 40; d < 30000; d += 40) {
          const x = eye[0] + ray.x * d, z = eye[2] + ray.z * d, h = terrainHeightAt(p.data, x, z);
          if (!(h >= eye[1] + ray.y * d)) continue;
          const cs = p.data.grid.cellSizeM;
          const slope = Math.atan(Math.hypot(terrainHeightAt(p.data, x + cs, z) - terrainHeightAt(p.data, x - cs, z), terrainHeightAt(p.data, x, z + cs) - terrainHeightAt(p.data, x, z - cs)) / (2 * cs)) * 180 / Math.PI;
          if (h < p.rules.treelineM && h > (p.rules.forestFloorM ?? RULE_DEFAULTS.forestFloorM) && slope < p.rules.forestMaxSlopeDeg) faces.push({ distanceM: d, rootM: [x, h, z], belowM: p.rules.treelineM - h, pixel: [(sx + 1) * 960, (1 - sy) * 540] });
          break;
        }
      }
      const ground = terrainHeightAt(p.data, eye[0], eye[2]);
      samples.push({ timeMs, pose, aboveGroundM: eye[1] - ground,
        pitchDeg: Math.atan2(pose.targetM[1] - eye[1], Math.hypot(pose.targetM[0] - eye[0], pose.targetM[2] - eye[2])) * 180 / Math.PI,
        nearest, treeline, bins, targets, faces });
    }
    return samples;
  });
}

// Seed the compositor camera's construction as well as the song input.
export function forestBrowser(browser, { noIsolation = false } = {}) {
  return { async newContext(options) {
    const context = await browser.newContext(options);
    await context.addInitScript(seedBrowserConstruction, 315);
    if (noIsolation) await context.route('**/*', async route => {
      const response = await route.fetch(), headers = response.headers();
      delete headers['cross-origin-opener-policy']; delete headers['cross-origin-embedder-policy'];
      await route.fulfill({ response, headers });
    });
    return context;
  } };
}

export async function runForestSmoke(args) {
  // Never overwrite an earlier baseline, even after a failed run.
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.mkdir(args.output);
  const wav = path.join(args.output, 'forest-120-96.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '96']);
  const report = { song: 'forest-120-96', bpm: 120, seconds: 96, width: 1920, height: 1080,
    constructionSeed: 315, params: { rangeTour: 'tetons', seed: '315', ...(args.debug ? { forestDebug: '1' } : {}) },
    timesMs: args.timesMs, audioSha256: hash(await fs.readFile(wav)),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    timingNote: 'SwiftShader relative cost only. Window: worker round trip including terrain, placement and transfer; frame: renderExportFrame + gl.finish + one-pixel readback, excludes PNG encoding.',
    windows: [], frames: [], errors: [] };
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    report.browser = browser.version();
    const s = await openSong(forestBrowser(browser, args), { url: args.url, wav, width: 1920, height: 1080, params: report.params });
    report.errors = s.errors;
    report.environment = await s.page.evaluate(() => {
      const scene = window.__SMW.sim.biomes.rangePresentation.scene, gl = scene.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const p = [...scene.prepared.values()].find(p => p.windowCache);
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), crossOriginIsolated,
        deviceMemoryGB: navigator.deviceMemory ?? null, budgetBytes: scene.residency?.budgetBytes,
        sharedTerrain: typeof SharedArrayBuffer !== 'undefined' && [...p.data.tiles.values()][0].heightsM.buffer instanceof SharedArrayBuffer };
    });
    assert.match(report.environment.renderer, /SwiftShader/i);
    if (args.noIsolation) assert.equal(report.environment.crossOriginIsolated, false);
    if (args.sample) {
      report.samples = await survey(s.page);
      await fs.writeFile(path.join(args.output, 'survey.json'), JSON.stringify(report.samples, null, 2) + '\n');
      console.log(`Surveyed ${report.samples.length} tour poses at 2 s intervals`);
      if (!args.timesMs) { await s.context.close(); return; }
    }
    for (const index of [0, 1, 2]) {
      const build = await s.page.evaluate(async index => {
        const scene = window.__SMW.sim.biomes.rangePresentation.scene;
        const p = [...scene.prepared.values()].find(p => p.windowCache);
        const t0 = performance.now(), raw = await p.windowWorker.build(index, p.windowOptions);
        const buildMs = performance.now() - t0;
        p.windowCache.current = index; p.windowCache.prune();
        const w = await p.windowCache.request(index, { replace: p.windowCache.resident.get(index)?.coarse === true });
        if (!w || w.coarse) throw new Error(`Full measurement window ${index} unavailable`);
        scene._swapTourWindow(p, w);
        return { index, buildMs, rawTrees: { ...(raw.placed.meshDetail ? { meshDetail: raw.placed.meshDetail.length / 8 } : {}),
          mesh: raw.placed.mesh.length / 8, billboard: raw.placed.billboard.length / 8 }, trees: p.stats.trees };
      }, index);
      assert.deepEqual(build.trees, build.rawTrees);
      report.windows.push(build);
      console.log(`Window ${index}: ${build.trees.mesh} mesh, ${build.trees.billboard} billboards; ${build.buildMs.toFixed(1)} ms build`);
    }
    await s.page.evaluate(() => { window.__resetLandscapeRandom(); window.__SMW.beginBulkExport(window.__SMW.exportSize); });
    for (const timeMs of args.timesMs || []) {
      const { frame, state } = await readyFrame(s.page, timeMs);
      const again = await captureFrame(s.page, timeMs, { finishGpu: true });
      assert.equal(frame.png, again.png, `pause parity at ${timeMs}`);
      const timingMs = [];
      if (!args.debug) {
        const third = await captureFrame(s.page, timeMs, { finishGpu: true });
        assert.equal(frame.png, third.png, `third pause parity at ${timeMs}`);
        timingMs.push(frame.drawMs, again.drawMs, third.drawMs);
      }
      const checkpoint = FOREST_CHECKPOINTS.find(c => c.timeMs === timeMs);
      const filename = `frame-${timeMs}.png`, crop = cropRect(1920, 1080, checkpoint?.center);
      const cropPng = await s.page.evaluate(rect => {
        const c = document.createElement('canvas'); c.width = rect.width; c.height = rect.height;
        c.getContext('2d').drawImage(document.querySelector('#stage'), rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        return c.toDataURL('image/png').split(',')[1];
      }, crop);
      const png = Buffer.from(frame.png, 'base64');
      const depthWork = await s.page.evaluate(() => {
        const scene = window.__SMW.sim.biomes.rangePresentation.scene;
        const p = [...scene.prepared.values()].find(p => p.windowCache);
        return { depthPasses: scene.stats.depthPasses, narrativeInk: p.uniforms.uNarrativeInk.value,
          visibleActors: Object.values(p.actors?.groups || {}).filter(g => g.visible).length };
      });
      await fs.writeFile(path.join(args.output, filename), png);
      await fs.writeFile(path.join(args.output, `crop-${timeMs}.png`), Buffer.from(cropPng, 'base64'));
      report.frames.push({ timeMs, actualMs: frame.clock.timeMs, quality: frame.quality, filename, crop, checkpoint, ...state, pauseParity: true,
        timingMs, medianFrameMs: timingMs.length ? [...timingMs].sort((a, b) => a - b)[1] : null, depthWork, pngSha256: hash(png), identity: frame.identity });
      if (args.ringTone && timeMs === 76000) {
        report.ringTone = await measureForestRingTone(s.page, crop);
        console.log('ring tone', JSON.stringify({ ...report.ringTone, inside: { ...report.ringTone.inside, pixels: undefined }, outside: { ...report.ringTone.outside, pixels: undefined } }));
      }
      if(args.farDots&&timeMs===76000){
        report.farDots=await measureForestFarDots(s.page);
        console.log('far dots',JSON.stringify(report.farDots));
        assert.equal(report.farDots.pass,true,'original far view must contain resolved painted crowns');
      }
      console.log(`${timeMs / 1000}s: full window ${state.windowIndex}; ${timingMs.length ? `median ${report.frames.at(-1).medianFrameMs.toFixed(1)} ms` : 'debug, untimed'}`);
    }
    if (args.flickerTimeMs != null) {
      const timeMs = args.flickerTimeMs, rect = report.frames[0].crop;
      const flicker = report.flicker = { timeMs, steps: 16, referenceDepthM: 6000,
        metric: 'Mean absolute step-to-step change of crop mean Rec.709 brightness in sRGB byte levels; frozen heard time, gusts and orientation.', frames: [] };
      const dir = path.join(args.output, 'flicker'); await fs.mkdir(dir);
      await s.page.evaluate(() => {
        const scene = window.__SMW.sim.biomes.rangePresentation.scene, setCamera = scene._setCamera;
        scene._setCamera = function (...args) {
          const pose = setCamera.apply(this, args), camera = this.camera;
          const metresPerPixel = 2 * 6000 / (camera.projectionMatrix.elements[0] * this.size.width);
          const offsetM = window.__forestOffsetPx * metresPerPixel;
          const right = new this.THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
          camera.position.addScaledVector(right, offsetM); camera.updateMatrixWorld();
          window.__forestOffsetM = offsetM;
          return pose;
        };
        window.__forestOffsetPx = 0;
      });
      for (let index = 0; index <= 16; index++) {
        await s.page.evaluate(({ offsetPx, reset }) => {
          window.__forestOffsetPx = offsetPx;
          new Function(`return (${reset})`)()(window.__SMW.sim.biomes);
        }, { offsetPx: index / 16, reset: resetForestSkyline.toString() });
        const frame = await captureFrame(s.page, timeMs, { finishGpu: true });
        assert.equal(frame.range.active, true, JSON.stringify(frame.range.failures));
        const detail = await s.page.evaluate(rect => {
          const crop = document.createElement('canvas'); crop.width = crop.height = 512;
          const ctx = crop.getContext('2d'); ctx.drawImage(document.querySelector('#stage'), rect.x, rect.y, 512, 512, 0, 0, 512, 512);
          const data = ctx.getImageData(0, 0, 512, 512).data;
          let sum = 0; for (let i = 0; i < data.length; i += 4) sum += .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
          const pres = window.__SMW.sim.biomes.rangePresentation, camera = pres.scene.camera;
          const p = [...pres.scene.prepared.values()].find(p => p.windowCache);
          return { meanBrightness: sum / (512 * 512), offsetPx: window.__forestOffsetPx, offsetM: window.__forestOffsetM,
            heardMs: window.__SMW.sim.heardTimeMs, windowIndex: p.windowIndex, coarse: p.activeWindow.coarse,
            renderedCamera: { eyeM: camera.position.toArray(), forward: camera.getWorldDirection(new pres.scene.THREE.Vector3()).toArray(), fovYDeg: camera.fov, aspect: camera.aspect },
            cropPng: crop.toDataURL('image/png').split(',')[1] };
        }, rect);
        assert.equal(detail.coarse, false);
        const filename = `step-${String(index).padStart(2, '0')}.png`;
        await fs.writeFile(path.join(dir, filename), Buffer.from(frame.png, 'base64'));
        await fs.writeFile(path.join(dir, `crop-${filename}`), Buffer.from(detail.cropPng, 'base64')); delete detail.cropPng;
        flicker.frames.push({ index, actualMs: frame.clock.timeMs, filename: `flicker/${filename}`, ...detail });
        console.log(`flicker ${index}/16 at ${detail.offsetPx.toFixed(4)} px: brightness ${detail.meanBrightness.toFixed(6)}`);
        if (index === 16) {
          await s.page.evaluate(reset => new Function(`return (${reset})`)()(window.__SMW.sim.biomes), resetForestSkyline.toString());
          const repeated = await captureFrame(s.page, timeMs, { finishGpu: true });
          assert.equal(frame.png, repeated.png, 'fixed-pose final-step pause parity'); flicker.pauseParity = true;
        }
      }
      flicker.stats = flickerStats(flicker.frames.map(f => f.meanBrightness));
      console.log(`flicker statistics ${JSON.stringify(flicker.stats)}`);
    }
    if (args.motionStartMs != null) {
      const motion = report.motion = { startMs: args.motionStartMs, durationMs: 2000, fps: 24, frames: [],
        classification: 'Consecutive full-compositor fixed-step export draws after a full-window seek; opening history is not sampled.' };
      const dir = path.join(args.output, 'motion'); await fs.mkdir(dir);
      const rect = report.frames[0].crop;
      for (let index = 0; index < 48; index++) {
        const timeMs = args.motionStartMs + index * 1000 / 24;
        const frame = await captureFrame(s.page, timeMs);
        assert.equal(frame.range.active, true, JSON.stringify(frame.range.failures));
        const detail = await s.page.evaluate(rect => {
          const stage = document.querySelector('#stage'), crop = document.createElement('canvas'); crop.width = crop.height = 512;
          const ctx = crop.getContext('2d'); ctx.drawImage(stage, rect.x, rect.y, 512, 512, 0, 0, 512, 512);
          const data = ctx.getImageData(0, 0, 512, 512).data, previous = window.__forestPreviousCrop;
          let sum = 0;
          if (previous) for (let i = 0; i < data.length; i++) if (i % 4 !== 3) sum += Math.abs(data[i] - previous[i]);
          window.__forestPreviousCrop = new Uint8ClampedArray(data);
          const pres = window.__SMW.sim.biomes.rangePresentation;
          const p = [...pres.scene.prepared.values()].find(p => p.windowCache);
          return { madRGB: previous ? sum / (512 * 512 * 3) : null, cropPng: crop.toDataURL('image/png').split(',')[1],
            heardMs: window.__SMW.sim.heardTimeMs, pose: pres.tour.poseAt(window.__SMW.sim.heardTimeMs), windowIndex: p.windowIndex, coarse: p.activeWindow.coarse };
        }, rect);
        assert.equal(detail.coarse, false);
        assert.equal(detail.windowIndex, Math.floor(detail.heardMs / 8000), 'motion stays in its own full window');
        const filename = `f${String(index).padStart(3, '0')}.png`;
        await fs.writeFile(path.join(dir, filename), Buffer.from(frame.png, 'base64'));
        await fs.writeFile(path.join(dir, `crop-${filename}`), Buffer.from(detail.cropPng, 'base64')); delete detail.cropPng;
        motion.frames.push({ index, timeMs, actualMs: frame.clock.timeMs, filename: `motion/${filename}`, ...detail });
        if (index % 12 === 0) console.log(`motion ${index + 1}/48 at ${(timeMs / 1000).toFixed(3)}s`);
        if (index === 47) {
          const repeated = await captureFrame(s.page, timeMs);
          assert.equal(frame.png, repeated.png, 'motion final-frame pause parity'); motion.pauseParity = true;
        }
      }
      motion.meanAbsoluteFrameDifference = motion.frames.slice(1).reduce((sum, f) => sum + f.madRGB, 0) / 47;
      try {
        execFileSync('ffmpeg', ['-loglevel', 'error', '-framerate', '24', '-i', path.join(dir, 'f%03d.png'),
          '-ss', String(args.motionStartMs / 1000), '-i', wav, '-t', '2', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', path.join(args.output, 'motion.mp4')]);
        motion.video = 'motion.mp4';
      } catch (error) { if (error.code !== 'ENOENT') throw error; motion.encoder = 'ffmpeg unavailable; ordered PNGs retained'; }
      console.log(`motion MAD RGB ${motion.meanAbsoluteFrameDifference.toFixed(4)} / 255`);
    }
    assert.deepEqual(s.errors, []);
    await s.context.close();
  } catch (error) { report.failure = error.stack; throw error; }
  finally {
    await browser?.close();
    await fs.writeFile(path.join(args.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(args.output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Forest evidence</title><style>body{background:#171b20;color:#e2e8ef;font:16px system-ui;margin:24px}img,video{max-width:100%}article{margin:32px 0}a{color:#9dcaff}</style><h1>Forest · 120 bpm / 96 s</h1><p>Seed 315 · Teton tour · 1920×1080 · debug ${args.debug ? 'on' : 'off'}</p><audio controls src="forest-120-96.wav"></audio><p><a href="report.json">Poses, tree counts, timing and provenance</a></p>${report.motion?.video ? `<video controls src="motion.mp4"></video><p>Consecutive ${report.motion.fps} fps frames; crop mean absolute RGB difference ${report.motion.meanAbsoluteFrameDifference.toFixed(4)} / 255.</p>` : ''}${report.flicker?.frames.length ? `<h2>Fixed 40s pose · subpixel lateral steps</h2><p>${report.flicker.metric}</p><pre>${JSON.stringify(report.flicker.stats ?? {}, null, 2)}</pre><input type="range" min="0" max="${report.flicker.frames.length - 1}" value="0" oninput="document.getElementById('flickerCrop').src='flicker/crop-step-'+String(this.value).padStart(2,'0')+'.png';document.getElementById('flickerOffset').textContent=(this.value/16).toFixed(4)+' px'"><span id="flickerOffset">0 px</span><p><img id="flickerCrop" src="flicker/crop-step-00.png"></p>` : ''}${report.frames.map(f => `<article><h2>${f.timeMs / 1000}s · window ${f.windowIndex}</h2><p>${f.trees.mesh} meshes / ${f.trees.billboard} billboards · ${f.medianFrameMs == null ? 'Debug (untimed)' : `${f.medianFrameMs.toFixed(1)} ms SwiftShader`}</p><a href="${f.filename}"><img src="${f.filename}"></a><img src="crop-${f.timeMs}.png"></article>`).join('')}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runForestSmoke(parseForestArgs(process.argv.slice(2)));
}
