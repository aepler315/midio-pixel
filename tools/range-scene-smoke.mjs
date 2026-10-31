// Range v2 full-scene evidence: real terrain in the running show and its
// export. Named CLI (plan §10):
//
//   node tools/range-scene-smoke.mjs --url http://127.0.0.1:8092 --source-root "$PWD" \
//     --expect-sha "$(git rev-parse HEAD)" --suite <pilot|selection|motion|lifecycle|export|complete> \
//     --output .smoke/range-v2 [--view <id>] [--width 1280 --height 720] [--cycles 6]
//
// Every capture records the renderer that actually drew it (v2 or legacy,
// with the reason), the view, forcedCandidate, quality, residency and the
// served identity of the modules and assets involved. A legacy fallback is
// an operational success but never a high-fidelity pass. Exits nonzero when
// a required check fails.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { installSeedReceiver, seedBrowserConstruction } from './lib/landscape-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['pilot', 'selection', 'motion', 'lifecycle', 'export', 'short-motion', 'complete'];
const NAMED = new Set(['cycles', 'url', 'source-root', 'expect-sha', 'suite', 'output', 'view', 'width', 'height', 'fps', 'seconds']);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const IDENTITY_FILES = [
  'src/world/alpine/RangeScene.js', 'src/world/alpine/RangePresentation.js', 'src/world/alpine/RangeFrame.js',
  'src/world/alpine/TerrainMesh.js', 'src/world/alpine/TerrainGL.js', 'src/world/alpine/TerrainMaterial.js',
  'src/world/alpine/TerrainPackage.js', 'src/world/alpine/RangeAssets.js', 'src/render/GraphicsResidency.js',
  'src/world/terrain/SceneCatalog.js', 'src/world/terrain/SceneTravel.js', 'src/world/terrain/sceneCatalogData.js',
  'src/world/BiomeManager.js', 'src/render/Renderer.js', 'src/vendor/range/three-range.module.js',
  'src/world/RidgeMotionHistory.js', 'src/world/alpine/RidgeMotion.js', 'src/world/alpine/RidgeComposition.js',
  'src/world/alpine/RangeQuality.js', 'src/world/alpine/RangeAtmosphere.js', 'src/world/terrain/TerrainStripCache.js',
  'src/world/TravelSeam.js', 'src/world/alpine/ForestCover.js', 'src/world/alpine/ForestGL.js',
  'src/world/alpine/RockStage.js', 'src/world/alpine/RockStageGL.js', 'src/main.js',
];

export function parseSceneArgs(argv) {
  const out = { suite: 'pilot', width: '1280', height: '720' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !NAMED.has(key)) throw new Error(`unknown flag ${argv[i]}`);
    const value = argv[++i];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    out[key] = value;
  }
  for (const k of ['url', 'source-root', 'expect-sha', 'output']) if (!out[k]) throw new Error(`--${k} is required`);
  if (!SUITES.includes(out.suite)) throw new Error(`unknown suite ${out.suite}`);
  return out;
}

/** Served files must be byte-identical to this checkout (and the catalog's
 *  terrain assets to their manifests), or the browser is testing something else. */
async function servedIdentity(url, sourceRoot) {
  const files = [...IDENTITY_FILES];
  const { default: catalog } = await import(pathToFileURL(path.join(sourceRoot, 'src/world/terrain/sceneCatalogData.js')).href);
  for (const v of catalog.views) {
    files.push(`src/assets/range/v2/${v.terrainManifestUrl}`);
    const m = JSON.parse(await fs.readFile(path.join(sourceRoot, 'src/assets/range/v2', v.terrainManifestUrl), 'utf8'));
    files.push(path.posix.join('src/assets/range/v2', path.posix.dirname(v.terrainManifestUrl), m.payload.url));
    // The material pack and every texture it names shape the same pixels.
    if (v.materialManifestUrl) {
      const matFile = path.posix.join('src/assets/range/v2', v.materialManifestUrl);
      files.push(matFile);
      const mat = JSON.parse(await fs.readFile(path.join(sourceRoot, matFile), 'utf8'));
      for (const t of Object.values(mat.textures || {})) files.push(path.posix.join(path.posix.dirname(matFile), t.url));
    }
  }
  files.splice(0, files.length, ...new Set(files));
  const hashes = {};
  for (const file of files) {
    const local = sha256(await fs.readFile(path.join(sourceRoot, file)));
    const res = await fetch(new URL(file, url.endsWith('/') ? url : `${url}/`));
    if (!res.ok) throw new Error(`cannot fetch served ${file}: ${res.status}`);
    const served = sha256(Buffer.from(await res.arrayBuffer()));
    if (served !== local) throw new Error(`served ${file} differs from ${sourceRoot}`);
    hashes[file] = served;
  }
  return hashes;
}

// What each page actually loaded (modules, catalog, manifests, terrain
// buffers, textures, the runtime bundle), hashed as it arrived. Every
// capture carries a digest of that set, and each file is checked against
// the checkout: the pixels come from these bytes and no others.
const LOADED = new WeakMap();
const localHashes = new Map();
let identityRoot = null;
function watchLoaded(page) {
  const entry = { files: new Map(), pending: [] };
  LOADED.set(page, entry);
  page.on('response', (res) => {
    const file = new URL(res.url()).pathname.replace(/^\/+/, '');
    if (!file.startsWith('src/') || !res.ok()) return;
    entry.pending.push(res.body().then((b) => entry.files.set(file, sha256(b)), () => entry.files.set(file, 'unread')));
  });
}
async function loadedIdentity(page) {
  const entry = LOADED.get(page);
  if (!entry) return null;
  await Promise.all(entry.pending.splice(0));
  const files = [...entry.files].sort(([a], [b]) => (a < b ? -1 : 1));
  if (identityRoot) {
    for (const [file, sha] of files) {
      if (!localHashes.has(file)) localHashes.set(file, sha256(await fs.readFile(path.join(identityRoot, file))));
      if (sha !== localHashes.get(file)) throw new Error(`the page loaded ${file} (${sha.slice(0, 12)}), which differs from the checkout`);
    }
  }
  const rangeAssets = files.filter(([f]) => f.startsWith('src/assets/range/') || f.startsWith('src/vendor/range/')).map(([f]) => f);
  return { loadedDigest: sha256(files.map(([f, h]) => `${f} ${h}\n`).join('')), loadedFiles: files.length, rangeAssets };
}

async function launch() {
  return chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
}

/** Open the app in export mode with a song and the requested Range mode. */
export async function openSong(browser, { url, wav, width, height, params = {}, dpr = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, serviceWorkers: 'block' });
  if (params.seed != null) await context.addInitScript(installSeedReceiver);
  const page = await context.newPage();
  watchLoaded(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'warning' && /range v2/.test(m.text())) errors.push(`warn: ${m.text()}`);
    // A shader that fails to compile draws nothing without throwing; the
    // frame would silently lose that layer, so it fails the suite.
    if (/Shader Error|program not valid/.test(m.text())) errors.push(`gl: ${m.text().slice(0, 400)}`);
  });
  await page.route('**/soundfonts/', (route) => route.fulfill({ json: [] }));
  await context.route(/^https:\/\//, (route) => route.abort());
  const entry = new URL(url);
  entry.searchParams.set('bulkExport', '1');
  entry.searchParams.set('exportW', String(width * dpr));
  entry.searchParams.set('exportH', String(height * dpr));
  for (const [k, v] of Object.entries(params)) if (v != null) entry.searchParams.set(k, v);
  await page.goto(entry.href);
  await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
  const lyrics = page.locator('#lyricGroundingBtn');
  if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
  await page.locator('#fileInput').setInputFiles(wav);
  await page.waitForFunction(() => window.__SMW?.exportReady || window.__SMW_EXPORT_ERROR, null, { timeout: 300000 });
  const armError = await page.evaluate(() => window.__SMW_EXPORT_ERROR || null);
  if (armError) throw new Error(armError);
  await page.evaluate(() => window.__SMW.beginBulkExport(window.__SMW.exportSize));
  const state = await page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 600000 }));
  return { context, page, errors, state };
}

/** Draw one export frame at `timeMs` and return its PNG and Range state. */
export async function captureFrame(page, timeMs, { hook = null, finishGpu = false } = {}) {
  const frame = await page.evaluate(async ({ timeMs: t, hook: h, finishGpu: finish }) => {
    const smw = window.__SMW;
    // WebGL commands cross a process boundary. One-pixel readback forces
    // completion; finish() alone can measure only queued submission.
    const syncGpu = () => {
      const gl = finish && smw.sim.biomes.rangePresentation?.scene?.renderer.getContext();
      if (gl) { gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); }
    };
    if (h === 'no-far') {
      const pres = smw.sim.biomes.rangePresentation;
      if (pres) { const orig = pres.drawPartition; pres.drawPartition = function (ctx, pass, stage) { return pass === 'far' ? false : orig.call(this, ctx, pass, stage); }; }
    }
    const t0 = performance.now();
    const options = h === 'conifer' ? { beforeDraw: () => {
      smw.sim.biomes.currentBlend = { from: 'CONIFER', to: 'CONIFER', t: 1, travel: false, travelP: 1,
        fromHeightMul: 1, toHeightMul: 1, fromSnowLine01: 1, toSnowLine01: 1 };
    } } : {};
    let clock = smw.renderExportFrame(t, options);
    syncGpu();
    let drawMs = performance.now() - t0;
    // A view prepared on demand: redraw the same instant once it is ready.
    if (await smw.rangeSettle?.()) {
      const t1 = performance.now();
      clock = smw.renderExportFrame(t, options);
      syncGpu();
      drawMs = performance.now() - t1;
    }
    const canvas = document.querySelector('#stage');
    return {
      clock, drawMs, png: canvas.toDataURL('image/png').split(',')[1],
      range: smw.rangeState, quality: smw.perfLevel, generation: smw.generation, seed: smw.songSeed,
      world: smw.sim.biomes.world.kind,
    };
  }, { timeMs, hook, finishGpu });
  assert.ok(Math.abs(frame.clock.timeMs - timeMs) <= 17, `export clock did not reach ${timeMs}: ${frame.clock.timeMs}; reset before a backward sequence`);
  frame.identity = await loadedIdentity(page);
  return frame;
}

/** Inspect real ownership after a draw, including hidden capture and focus paths. */
export async function landscapeOwnership(page) {
  return page.evaluate(() => {
    const app = window.__SMW, sim = app.sim, mgr = sim.biomes;
    const painter = app.renderer.canvasRenderer || app.renderer;
    return {
      actorClass: sim.midio?.constructor?.name || null,
      retired: Object.fromEntries(['broshi', 'midasus', 'ensemble', 'excursions', 'focus', 'gaze', 'cuts', 'jump', 'performer']
        .map(key => [key, !!sim[key]])),
      decoration: Object.fromEntries(['farVignettes', 'skyEnsemble', 'murmuration'].map(key => [key, !!mgr[key]])),
      emitters: mgr.rangePresentation?.frame?.emitters || [],
      capture: !!painter._capture, brush: !!painter.brush,
      reflections: painter.reflectionStats?.layers?.length || 0,
      inhabitedShoreDraws: painter.inhabitedShoreDraws,
      policy: sim.presentation,
    };
  });
}

export function assertLandscapeOwnership(state) {
  assert.ok(state.actorClass === 'Object' || state.actorClass == null, 'stage coordinate alias must have no actor behavior');
  assert.ok(Object.values(state.retired).every(value => !value), 'retired actor simulation must be absent');
  assert.ok(Object.values(state.decoration).every(value => !value), 'incidental actor owners must be absent');
  assert.deepEqual(state.emitters, [], 'no private actor lights');
  assert.equal(state.capture, false, 'no performer capture resource');
  assert.equal(state.brush, false, 'no actor trails');
  assert.equal(state.reflections, 0, 'no actor reflections');
  // Midio, Broshi and Midasus live on the inhabited shore: one pass per frame.
  assert.ok(state.inhabitedShoreDraws <= 1, 'the resident/sea pass draws at most once per frame');
}

async function writePng(dir, name, b64) {
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from(b64, 'base64'));
  return file;
}

async function suitePilot(ctx) {
  const { browser, args, wav, out, report } = ctx;
  const width = Number(args.width), height = Number(args.height);
  const view = args.view || 'nc-ross-lake-north';
  const v2 = await openSong(browser, { url: args.url, wav, width, height, params: { rangeRenderer: 'v2', rangeView: view } });
  report.pilot = { view, prepared: v2.state, frames: [] };
  // Forcing a view is labelled a candidate only when it is not approved.
  const { default: catalog } = await import(pathToFileURL(path.join(path.resolve(args['source-root']), 'src/world/terrain/sceneCatalogData.js')).href);
  const expectCandidate = catalog.views.find((v) => v.id === view)?.status !== 'approved';
  assert.equal(v2.state.runtime, 'ready', `v2 runtime not ready: ${JSON.stringify(v2.state)}`);
  assert.ok(v2.state.scene?.prepared?.includes(view), `pilot view not prepared: ${JSON.stringify(v2.state.failures)}`);
  for (const t of [0, 250, 6000, 30000, 60000, 90000]) {
    if (t === 60000) {
      // Pass-disabled diagnostic at 60s, before the 60s frame: the far
      // partition's pixels must be absent. The export clock only runs forward.
      const noFar = await captureFrame(v2.page, 59000, { hook: 'no-far' });
      report.pilot.noFarPng = path.relative(root, await writePng(out, `pilot-v2-${view}-59000-no-far.png`, noFar.png));
      await v2.page.evaluate(() => { const p = window.__SMW.sim.biomes.rangePresentation; delete p.drawPartition; });
    }
    const f = await captureFrame(v2.page, t);
    const png = await writePng(out, `pilot-v2-${view}-${t}.png`, f.png);
    delete f.png;
    assert.equal(f.range.active, true, `v2 not active at ${t}ms: ${f.range.reason}`);
    assert.equal(f.range.viewId, view);
    assert.equal(f.range.forcedCandidate, expectCandidate, expectCandidate ? 'a forced candidate must be labelled' : 'an approved view is not a candidate');
    const ownership = await landscapeOwnership(v2.page);
    assertLandscapeOwnership(ownership);
    report.pilot.frames.push({ ...f, ownership, png: path.relative(root, png) });
    console.log(`pilot v2 ${t}ms: view=${f.range.viewId} u=${f.range.progress01?.toFixed(3)} draw=${f.drawMs.toFixed(0)}ms partition=${f.range.timings.lastPartitionMs.toFixed(0)}ms copy=${f.range.timings.lastCopyMs.toFixed(1)}ms`);
  }
  report.pilot.pageErrors = v2.errors;
  await v2.context.close();
  const legacy = await openSong(browser, { url: args.url, wav, width, height, params: { rangeRenderer: 'legacy' } });
  await captureFrame(legacy.page, 0); // actor-free from the opening
  const lf = await captureFrame(legacy.page, 30000);
  report.pilot.legacyPng = path.relative(root, await writePng(out, 'pilot-legacy-30000.png', lf.png));
  assert.equal(lf.range.active, false);
  await legacy.context.close();
  assert.deepEqual(v2.errors.filter((e) => !e.startsWith('warn')), [], 'page errors');
}

/**
 * Motion pilot (Task 13): a calm -> energetic -> calm song, stepped on the
 * export clock at 1280x720 (software GL cannot render the exporter's 1080p
 * minimum in reasonable time), 24 fps from 0 s so the opening is included;
 * frames encode to MP4. Then one backward seek in the same page, compared
 * with the sequence's own frame at that heard time.
 */
async function suiteMotion(ctx) {
  const { browser, args, out, report } = ctx;
  const view = args.view || 'nc-ross-lake-north';
  const wav = path.join(out, 'pilot-60s.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), wav, '60']);
  const s = await openSong(browser, { url: args.url, wav, width: 1280, height: 720, params: { rangeRenderer: 'v2', rangeView: view } });
  // Software GL renders a 1280x720 frame in ~9 s (the cost lands at pixel
  // readback, not in the draw call), so the frame rate is an option.
  const fps = Number(args.fps || 12), seconds = Number(args.seconds || 52), n = Math.round(fps * seconds);
  assert.ok(Number.isInteger(fps) && fps > 0 && fps <= 60, '--fps must be an integer from 1 to 60');
  assert.ok(seconds >= 48 && seconds <= 60, 'motion capture must include calm, hot and final calm (48-60 seconds)');
  const dir = path.join(out, 'motion-frames');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  report.motion = { view, fps, seconds, size: '1280x720', song: 'tools/gen-pilot-wav.mjs 60: calm 0-21 s, energetic 21-45 s, calm after', samples: [] };
  const grab = (t, quality) => s.page.evaluate(({ t: tt, q }) => {
    const smw = window.__SMW;
    const t0 = performance.now();
    smw.renderExportFrame(tt);
    const drawMs = performance.now() - t0;
    const c = document.querySelector('#stage');
    const st = smw.rangeState;
    return { img: c.toDataURL(q ? 'image/jpeg' : 'image/png', q || undefined).split(',')[1], drawMs,
      range: { active: st.active, reason: st.reason, viewId: st.viewId, progress01: st.progress01, frameId: st.frameId } };
  }, { t, q: quality });
  let lastSample = null;
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / fps;
    const f = await grab(t, 0.9);
    await fs.writeFile(path.join(dir, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(f.img, 'base64'));
    if (i % fps === 0) {
      report.motion.samples.push({ t, drawMs: Math.round(f.drawMs), ...f.range });
      console.log(`motion ${(t / 1000).toFixed(0)}s: active=${f.range.active} ${f.range.reason || ''} u=${f.range.progress01?.toFixed(3)} draw=${f.drawMs.toFixed(0)}ms`);
    }
    lastSample = f;
  }
  const mp4 = path.join(out, `motion-${view}-${seconds}s-${fps}fps.mp4`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
  report.motion.mp4 = path.relative(root, mp4);
  // All three phases are included in the moving sequence.
  report.motion.calmStill = path.relative(root, path.join(dir, `f${String(10 * fps).padStart(5, '0')}.jpg`));
  report.motion.finalCalmStill = path.relative(root, path.join(dir, `f${String(47 * fps).padStart(5, '0')}.jpg`));
  assert.ok(report.motion.samples.some(x => x.t >= 21000 && x.t < 45000), 'energetic section captured');
  assert.ok(report.motion.samples.some(x => x.t >= 45000), 'return to calm captured');
  const hot = await grab(32000);
  report.motion.energeticStill = path.relative(root, await writePng(out, `motion-${view}-32000-energetic.png`, hot.img));
  // One backward seek, to the sequence's 8 s frame.
  const seekT = 8000;
  const seek = await s.page.evaluate(async (t) => {
    const smw = window.__SMW;
    smw.seek(t);
    const ready = await smw.rangeReady({ timeoutMs: 600000 });
    return { ready: ready?.runtime ?? null };
  }, seekT);
  const after = await grab(seekT);
  const seqFile = path.join(dir, `f${String(Math.round((seekT / 1000) * fps)).padStart(5, '0')}.jpg`);
  const paused = await grab(seekT);
  report.motion.pausedFrameEqual = sha256(Buffer.from(after.img, 'base64')) === sha256(Buffer.from(paused.img, 'base64'));
  assert.ok(report.motion.pausedFrameEqual, 'held export time must render identical pixels');
  const afterPng = await writePng(out, `motion-${view}-after-seek-${seekT}.png`, after.img);
  const seqSample = report.motion.samples.find((x) => x.t === seekT);
  report.motion.backwardSeek = { fromMs: 32000, toMs: seekT, afterSeek: after.range, sequence: seqSample, ready: seek.ready,
    afterPng: path.relative(root, afterPng), sequenceFrame: path.relative(root, seqFile) };
  console.log(`backward seek 32s -> 8s: active=${after.range.active} view=${after.range.viewId} u=${after.range.progress01?.toFixed(4)} (sequence u=${seqSample?.progress01?.toFixed(4)})`);
  assert.equal(after.range.active, true, `v2 inactive after the backward seek: ${after.range.reason}`);
  assert.ok(Math.abs(after.range.progress01 - seqSample.progress01) < 0.002, 'the view returns to the same place on its rail');
  assert.ok(lastSample.range.active, 'v2 active through the pilot');
  report.motion.pageErrors = s.errors;
  await s.context.close();
  assert.deepEqual(s.errors.filter((e) => !e.startsWith('warn')), [], 'page errors');
}

/** Bounded full-compositor clip of an approved view, using analyzed audio.
 * The biome is controlled; camera, sky, forests, film and musical responses
 * retain their production paths. This is fixed-step evidence, not live FPS.
 */
async function suiteShortMotion({ browser, args, out, report }) {
  const view = 'teton-jackson-lake', fps = 24, count = 72, startMs = 44000;
  const wav = path.join(out, 'pilot-60s.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), wav, '60']);
  const trackedBrowser = { async newContext(options) {
    const context = await browser.newContext(options);
    await context.addInitScript(seedBrowserConstruction, 315);
    return context;
  } };
  const opened = await openSong(trackedBrowser, { url: args.url, wav, width: 1280, height: 720,
    params: { rangeRenderer: 'v2', rangeView: view, seed: '2917029651' } });
  const dir = path.join(out, 'short-motion-frames');
  await fs.mkdir(dir, { recursive: true });
  const motion = report.shortMotion = {
    classification: 'Actual Chromium full-compositor frames of the approved CONIFER/Teton v2 view; fixed-step export',
    view, fps, frameCount: count, startMs, endMs: startMs + (count - 1) * 1000 / fps,
    seed: 2917029651, constructionSeed: 315, fixtureHash: sha256(await fs.readFile(wav)),
    instrumentation: 'Seeded construction and URL song seed; CONIFER blend pinned immediately before each draw. No painter or compositor passes disabled.',
    song: 'Analyzed gen-pilot-wav 60s: energetic drums/bass until 45s, calm after; this is not an isolated-kick or silent-release fixture.',
    limitations: ['Synthetic song, not a real recording', 'Software WebGL2, not device performance', 'Controlled approved view and biome, not a natural song cast'],
    frames: [], pageErrors: opened.errors,
  };
  try {
    // Prime the normal opening before advancing the forward-only export clock.
    await captureFrame(opened.page, 250, { hook: 'conifer' });
    for (let index = 0; index < count; index++) {
      const timeMs = startMs + index * 1000 / fps;
      const frame = await captureFrame(opened.page, timeMs, { hook: 'conifer' });
      assert.equal(frame.range.active, true, `v2 fallback at ${timeMs}: ${frame.range.reason}`);
      assert.equal(frame.range.viewId, view);
      assert.equal(frame.range.forcedCandidate, false, 'motion clip must use an approved view');
      assert.equal(frame.world, 'alpine');
      assert.equal(frame.clock.draws, 1);
      const detail = await opened.page.evaluate(() => {
        const app = window.__SMW, mgr = app.sim.biomes, presentation = mgr.rangePresentation;
        return { blend: mgr.currentBlend, horizonRange: mgr.horizonRange?.id || null,
          music: presentation?.frame?.music, ridges: presentation?.frame?.ridges,
          camera: presentation?.scene?.camera?.matrixWorld?.elements };
      });
      assert.equal(detail.blend.from, 'CONIFER');
      const png = `f${String(index).padStart(5, '0')}.png`;
      await writePng(dir, png, frame.png);
      delete frame.png;
      motion.frames.push({ index, timeMs, png: path.relative(out, path.join(dir, png)), ...frame, ...detail });
      if (index % fps === 0) console.log(`short-motion ${timeMs}ms ${view} horizon=${detail.horizonRange}`);
    }
    assert.deepEqual(opened.errors, [], 'full-compositor motion page or shader errors');
    const mp4 = path.join(out, 'conifer-teton-44-47s-24fps.mp4');
    try {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, 'f%05d.png'),
        '-frames:v', String(count), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4]);
      motion.mp4 = path.relative(out, mp4);
    } catch (error) {
      // PNGs remain complete evidence when the runner has no encoder.
      if (error.code !== 'ENOENT') throw error;
      motion.encoder = 'ffmpeg unavailable; inspect the ordered PNG frames at 24fps';
    }
  } finally {
    await opened.context.close();
  }
}

/** Magenta marker pixels (the diagnostic far partition) in RGBA bytes. */
export function countMarkers(rgba, { lossy = false } = {}) {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (lossy ? (r > 190 && b > 190 && g < 80) : (r === 255 && g === 0 && b === 255)) n++;
  }
  return n;
}

async function pngMarkers(file) {
  const py = process.env.MIDIO_GDAL_PYTHON || '/usr/bin/python3.12';
  const script = 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGB")\n'
    + 'print(sum(1 for (r,g,b) in im.getdata() if r>190 and b>190 and g<80))';
  return Number(execFileSync(py, ['-c', script, file], { encoding: 'utf8' }).trim());
}

async function suiteExport(ctx) {
  const { browser, args, wav, out, report } = ctx;
  const view = args.view || 'nc-ross-lake-north';
  const params = { rangeRenderer: 'v2', rangeView: view, rangeDiag: 'markers' };
  report.export = { view, checks: [] };
  const check = (name, ok, detail = '') => {
    report.export.checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} export: ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) throw new Error(`export check failed: ${name} ${detail}`);
  };
  // 1. Main stage (the canvas every output path reads).
  const s = await openSong(browser, { url: args.url, wav, width: 1280, height: 720, params });
  await captureFrame(s.page, 6000);
  const stage = await captureFrame(s.page, 20000);
  const stagePng = await writePng(out, 'export-stage-markers.png', stage.png);
  const stageCount = await pngMarkers(stagePng);
  check('markers reach the main stage canvas', stage.range.active && stageCount > 500, `${stageCount} px, active=${stage.range.active}`);
  const off = await captureFrame(s.page, 21000, { hook: 'no-far' });
  const offCount = await pngMarkers(await writePng(out, 'export-stage-no-far.png', off.png));
  check('markers vanish when their partition is disabled', offCount === 0, `${offCount} px`);
  await s.context.close();
  // 2. The actual bulk exporter, end to end through ffmpeg.
  const exportDir = path.join(out, 'bulk');
  await fs.rm(exportDir, { recursive: true, force: true });
  const u = new URL(args.url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  execFileSync(process.execPath, [path.join(root, 'tools/bulk-export.mjs'), '--url', u.href, '--res', '1080', '--fps', '30',
    '--max-seconds', '3', '--world', 'alpine', '--seed', '315', '--out', exportDir, wav], { stdio: 'inherit', timeout: 3600000 });
  const mp4 = (await fs.readdir(exportDir)).find((f) => f.endsWith('.mp4'));
  check('bulk export wrote an MP4', !!mp4, mp4 || 'none');
  const framePng = path.join(out, 'export-bulk-frame.png');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '2.5', '-i', path.join(exportDir, mp4), '-frames:v', '1', framePng]);
  const bulkCount = await pngMarkers(framePng);
  check('markers reach the bulk-exported video', bulkCount > 500, `${bulkCount} px`);
  report.export.files = { stage: path.relative(root, stagePng), bulk: path.relative(root, framePng) };
  report.export.stageIdentity = stage.identity;
}

/**
 * Natural casts (plan §10, Task 15): songs opened with no forced view, so
 * the production selector chooses. Every biome of each song gets an
 * approved view of its own biome, the musical skyline pool still assigns
 * each biome its own legacy ranges, the assignment is deterministic (the
 * same song opened again draws the same views), and every sampled frame
 * draws its v2 view. Frames are written for review.
 */
async function suiteSelection(ctx) {
  const { browser, args, out, report } = ctx;
  const specs = [[120, 96], [80, 150], [150, 120], [174, 100], [100, 180]];
  report.selection = { songs: [], checks: [] };
  const check = (name, ok, detail = '') => {
    report.selection.checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} selection: ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) throw new Error(`selection check failed: ${name} ${detail}`);
  };
  const cast = async (wav) => {
    const s = await openSong(browser, { url: args.url, wav, width: 960, height: 540, params: { rangeRenderer: 'v2' } });
    const song = await s.page.evaluate(async () => {
      const t = window.__SMW.sim.biomes.songTerrain;
      if (t?.whenAll) await Promise.race([t.whenAll, new Promise((r) => setTimeout(r, 60000))]);
      const id = (r) => r?.id || r?.range?.id || null;
      return {
        seed: window.__SMW.songSeed, biomes: t?.biomes, catalogVersion: t?.catalogVersion, horizon: id(t?.horizon), massif: id(t?.massif),
        perBiome: (t?.biomes || []).map((b) => {
          const e = t.byBiome.get(b), sc = t.sceneByBiome.get(b);
          return { biome: b, skyline: e ? Object.values(e.ranges || {}).map(id).filter(Boolean) : [],
            view: sc?.view?.id || null, viewBiome: sc?.view?.biome || null, status: sc?.view?.status || null };
        }),
      };
    });
    for (const w of [0, 400, 800, 1200, 1600, 2000]) await s.page.evaluate((ms) => window.__SMW.renderExportFrame(ms), w);
    song.frames = [];
    for (const t of [10000, 40000, 70000]) {
      const f = await captureFrame(s.page, t);
      const file = await writePng(out, `selection-${path.basename(wav, '.wav')}-${t}.png`, f.png);
      song.frames.push({ t, active: f.range.active, viewId: f.range.viewId, reason: f.range.reason || null, file: path.relative(root, file), identity: f.identity });
    }
    song.errors = s.errors.filter((e) => !e.startsWith('warn:'));
    await s.context.close();
    return song;
  };
  for (const [bpm, sec] of specs) {
    const wav = path.join(out, `synthetic-${bpm}bpm-${sec}s.wav`);
    execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, String(bpm), String(sec)]);
    const song = await cast(wav);
    song.wav = path.basename(wav);
    report.selection.songs.push(song);
    const tag = `${bpm} bpm ${sec} s`;
    check(`${tag}: every biome has an approved view of its own biome`,
      song.perBiome.every((b) => b.view && b.viewBiome === b.biome && b.status === 'approved'), JSON.stringify(song.perBiome.map((b) => [b.biome, b.view])));
    check(`${tag}: the musical skyline pool assigns every biome its ranges`, song.perBiome.every((b) => b.skyline.length > 0));
    check(`${tag}: every sampled frame draws its v2 view`, song.frames.every((f) => f.active), JSON.stringify(song.frames.map((f) => f.viewId || f.reason)));
    check(`${tag}: no page or shader errors`, song.errors.length === 0, song.errors.slice(0, 2).join(' | '));
  }
  // Deterministic: the first song again draws the same views.
  const again = await cast(path.join(out, `synthetic-${specs[0][0]}bpm-${specs[0][1]}s.wav`));
  const first = report.selection.songs[0];
  check('the same song draws the same views again', JSON.stringify(again.perBiome.map((b) => b.view)) === JSON.stringify(first.perBiome.map((b) => b.view)));
  const shown = new Set(report.selection.songs.flatMap((x) => x.frames.map((f) => f.viewId)).filter(Boolean));
  report.selection.viewsOnScreen = [...shown];
  console.log(`selection: ${shown.size} distinct views on screen across ${specs.length} songs`);
}

/**
 * Task 16 lifecycle: repeated song replacement, stage resizes, A/B travels
 * and a real WebGL context loss/restore in one page, with the shared
 * residency ledger read after every cycle. Ownership must stay inside the
 * budget, never overcommit, hold no entry of a replaced song, and return to
 * a stable level instead of rising per cycle.
 */
async function suiteLifecycle(ctx) {
  const { browser, args, wav, out, report } = ctx;
  const wavB = path.join(out, 'synthetic-150bpm-80s.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wavB, '150', '80']);
  const songs = [wav, wavB];
  const sizes = [{ width: 1280, height: 720 }, { width: 960, height: 540 }];
  const cycles = Number(args.cycles ?? 6);
  // Five is the least that exercises every check: song replacement (cycle
  // 1), a resize (2), a context loss (2) and one same-song-and-size
  // ownership comparison (4 vs 0).
  if (!Number.isInteger(cycles) || cycles < 5) throw new Error(`--cycles must be an integer of at least 5, got ${args.cycles}`);
  // Expected length of each song, to confirm a replacement actually landed.
  const songMs = [96000, 80000];
  report.lifecycle = { cycles: [], checks: [] };
  const check = (name, ok, detail = '') => {
    report.lifecycle.checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} lifecycle: ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) throw new Error(`lifecycle check failed: ${name} ${detail}`);
  };
  const MiB = 1024 * 1024;
  const s = await openSong(browser, { url: args.url, wav: songs[0], width: sizes[0].width, height: sizes[0].height, params: { rangeRenderer: 'v2' } });
  const { page } = s;
  // Arms the export at `size` once the song of `expectMs` has loaded: a
  // replacement's decode is asynchronous and arming too early would rebuild
  // the previous song.
  const arm = async (size, expectMs) => {
    const deadline = Date.now() + 600000;
    for (;;) {
      const r = await page.evaluate((sz) => { try { return { ok: window.__SMW.beginBulkExport(sz) }; } catch (e) { return { err: String(e.message || e) }; } }, size);
      if (r.ok && Math.abs(r.ok.durationMs - expectMs) < 2000) break;
      if (!r.ok && !/Load a song|Still analysing|Still loading/.test(r.err)) throw new Error(`arm: ${r.err}`);
      if (Date.now() > deadline) throw new Error(`arm: song of ${expectMs} ms never loaded (${r.err || `got ${r.ok?.durationMs} ms`})`);
      await new Promise((res) => setTimeout(res, 500));
    }
    await page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 600000 }));
  };
  const read = () => page.evaluate(() => {
    const st = window.__SMW.rangeState;
    return { generation: window.__SMW.generation, rangeGeneration: st.generation, active: st.active, viewId: st.viewId, reason: st.reason,
      stripOwner: window.__SMW.sim?.biomes?.strips?.owner ?? null,
      residency: st.residency, prepared: st.scene?.prepared || [], heap: performance.memory?.usedJSHeapSize ?? null };
  });
  const frames = async () => {
    const out2 = [];
    for (const t of [8000, 30000, 55000]) {
      const f = await captureFrame(page, t);
      out2.push({ t, active: f.range.active, viewId: f.range.viewId, incoming: f.range.incomingViewId, reason: f.range.reason, loadedDigest: f.identity?.loadedDigest });
    }
    return out2;
  };
  let song = 0;
  for (let i = 0; i < cycles; i++) {
    const wantSong = i % 2, size = sizes[Math.floor(i / 2) % 2];
    if (wantSong !== song) {
      await page.locator('#fileInput').setInputFiles(songs[wantSong]);
      song = wantSong;
    }
    await arm(size, songMs[wantSong]);
    const drawn = await frames();
    let contextCycle = null;
    if (i % 3 === 2) {
      const lost = await page.evaluate(() => {
        const r = window.__SMW.sim.biomes.rangePresentation.scene.renderer;
        // Keep the extension object: a lost context returns null for it.
        const ext = r.getContext().getExtension('WEBGL_lose_context');
        window.__rangeLoseContext = ext;
        ext.loseContext();
        return !!ext;
      });
      await new Promise((res) => setTimeout(res, 200));
      const during = await captureFrame(page, 55000);
      await page.evaluate(() => {
        window.__rangeLoseContext.restoreContext();
      });
      await new Promise((res) => setTimeout(res, 300));
      const after = await captureFrame(page, 55000);
      contextCycle = { lost, duringActive: during.range.active, duringReason: during.range.reason, afterActive: after.range.active, afterView: after.range.viewId };
      check(`cycle ${i}: context loss draws legacy, restore draws v2 again`, lost && !during.range.active && after.range.active,
        JSON.stringify(contextCycle));
    }
    const st = await read();
    const r = st.residency;
    const row = { cycle: i, song: wantSong, size: `${size.width}x${size.height}`, generation: st.rangeGeneration,
      liveMiB: +(r.liveBytes / MiB).toFixed(1), pendingMiB: +(r.pendingBytes / MiB).toFixed(1),
      ownedMiB: +((r.liveBytes + r.pendingBytes) / MiB).toFixed(1), entries: r.entryCount,
      generations: r.generations, overcommits: r.overcommits, denials: r.denials,
      byOwnerMiB: Object.fromEntries(Object.entries(r.byOwner).map(([k, v]) => [k, +((v.live + v.pending) / MiB).toFixed(1)])),
      prepared: st.prepared, heapMiB: st.heap ? +(st.heap / MiB).toFixed(1) : null, frames: drawn, context: contextCycle };
    report.lifecycle.cycles.push(row);
    console.log(`cycle ${i}: song ${wantSong} ${row.size} gen ${row.generation} live ${row.liveMiB} MiB pending ${row.pendingMiB} entries ${row.entries} gens ${row.generations} heap ${row.heapMiB} frames ${drawn.map((d) => d.active ? d.viewId : `legacy(${d.reason})`).join(',')}`);
    check(`cycle ${i}: inside the budget`, r.liveBytes + r.pendingBytes <= r.budgetBytes, `${row.liveMiB + row.pendingMiB} MiB`);
    check(`cycle ${i}: nothing of a replaced song remains`, r.generations.every((g) => g === 0 || g === st.rangeGeneration), `generations ${r.generations}, current ${st.rangeGeneration}`);
    // Legacy strips are adopted at generation 0 but are owned per song
    // (one BiomeManager each): only the current manager may own any.
    const stripOwners = Object.keys(r.byOwner).filter((o) => o.startsWith('legacy-strips'));
    check(`cycle ${i}: no replaced song's legacy strips remain`, stripOwners.every((o) => o === st.stripOwner), `${stripOwners} (current ${st.stripOwner})`);
    const pageErrors = s.errors.filter((e) => !e.startsWith('warn:'));
    check(`cycle ${i}: no page or shader errors`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check(`cycle ${i}: every frame drew its v2 view`, drawn.every((d) => d.active), JSON.stringify(drawn));
  }
  const rows = report.lifecycle.cycles;
  check('no overcommit in any cycle', rows.every((x) => x.overcommits === 0), rows.map((x) => x.overcommits).join(','));
  // Same song and size recur every 4 cycles: ownership returns to the same
  // level (within one view's worth of LRU leftovers), not rising per cycle.
  for (let i = 4; i < rows.length; i++) {
    const a = rows[i - 4], b = rows[i];
    // Live and pending both count, and so do entries: a leak of pending
    // reservations or small entries would not move the live bytes.
    check(`cycle ${i} vs ${i - 4}: ownership stable`, b.ownedMiB <= a.ownedMiB + 100 && b.entries <= a.entries + 4,
      `${a.ownedMiB} -> ${b.ownedMiB} MiB, ${a.entries} -> ${b.entries} entries`);
  }
  const heaps = rows.map((x) => x.heapMiB).filter((x) => x != null);
  if (heaps.length > 3) check('JS heap does not climb per cycle', heaps.at(-1) <= Math.max(...heaps.slice(0, 3)) * 1.5, heaps.join(','));
  await s.context.close();
}

async function main() {
  const args = parseSceneArgs(process.argv);
  const sourceRoot = path.resolve(args['source-root']);
  identityRoot = sourceRoot;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  if (!sha.startsWith(args['expect-sha'])) throw new Error(`source is ${sha}, not ${args['expect-sha']}`);
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'tools'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const out = path.resolve(args.output);
  await fs.mkdir(out, { recursive: true });
  const wav = path.join(out, 'synthetic-96s.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '96']);
  const report = {
    sha, dirty: dirty || null, suite: args.suite, served: await servedIdentity(args.url, sourceRoot),
    renderer: 'Chromium SwiftShader (software WebGL2); timings are not device measurements',
  };
  const browser = await launch();
  report.browser = browser.version();
  const ctx = { browser, args, wav, out, report };
  let failed = null;
  try {
    const suites = args.suite === 'complete' ? SUITES.filter((s) => s !== 'complete') : [args.suite];
    const impl = { pilot: suitePilot, selection: suiteSelection, export: suiteExport, motion: suiteMotion, 'short-motion': suiteShortMotion, lifecycle: suiteLifecycle };
    for (const s of suites) {
      // A requested suite that does not exist yet fails the run: an empty
      // "pass" would be evidence of nothing.
      if (!impl[s]) { report[s] = { status: 'unimplemented' }; throw new Error(`suite ${s} is not implemented yet`); }
      await impl[s](ctx);
    }
    assert.deepEqual(await servedIdentity(args.url, sourceRoot), report.served, 'served source or assets changed during capture');
  } catch (err) {
    failed = err;
    report.error = String(err?.stack || err);
  } finally {
    await browser.close();
    await fs.writeFile(path.join(out, 'range-scene-report.json'), JSON.stringify(report, null, 1));
  }
  if (failed) { console.error(failed); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
