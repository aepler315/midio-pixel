#!/usr/bin/env node
// Background review of actual Landscape output. Never opens a report or a window.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ReviewRunOwner } from './lib/landscape-review-lifecycle.mjs';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { normalizeManifest, captureSchedule, compareReports, blankFrame } from './lib/visual-evaluation.mjs';
import { openEvaluationSong, renderEvaluationFrame, expectedTourPreparationFailure } from './lib/visual-evaluation-browser.mjs';
import { attachBrowserDiagnostics, finalizeBrowserDiagnostics } from './lib/browser-diagnostics.mjs';
import { renderRunReport, renderComparisonReport } from './lib/visual-evaluation-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `npm run review:landscape -- --out .smoke/review [--audio song.wav]
  --source DIR         Public source checkout (default: this repository)
  --snapshot DIR       Verified hash-addressed manifest.json + byte files (preserves case)
  --baseline DIR       Compare with a previous review using the same controls
  --grid GRID          classic, classicPlus, medium, detailed or both (default: both)
  --view ID            Default: teton-range-tour; other IDs select a static catalog view
  --start-ms N         Continuous capture start (default12000)
  --seconds N          Clip length, >0 through10 (default2)
  --fps N              Fixed export sampling rate,1 through60 (default12)
  --hardware-gpu       Require an actual hardware renderer; otherwise explicit software WebGL
  --gpu-match TEXT     Additionally require this substring in the actual renderer
  --browser FILE       Chromium executable (or PLAYWRIGHT_CHROMIUM_PATH)
  --record-baseline    Record old overlay paint without treating it as candidate acceptance
  --ablate-aurora      Save a same-clock sky ablation and verified restoration on first frame
  --live-seconds N     Optional separate real-playback/readiness trace,1 through300
  --no-mp4             Keep exact PNG/audio frame-player clips without ffmpeg MP4 previews
Always headless. No --open or headful option. Output must be new. Artistic judgment remains unreviewed.
`;
export function parseReviewArgs(argv) {
  const a = { source: root, grids: ['classic', 'detailed'], view: 'teton-range-tour', startMs: 12000, seconds: 2, fps: 12, liveSeconds: 0, mp4: true };
  const values = { '--out': 'out', '--source': 'source', '--snapshot': 'snapshot', '--baseline': 'baseline', '--audio': 'audio', '--grid': 'grid', '--view': 'view', '--start-ms': 'startMs', '--seconds': 'seconds', '--fps': 'fps', '--live-seconds': 'liveSeconds', '--browser': 'browser', '--gpu-match': 'gpuMatch' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') return { help: true };
    if (k === '--hardware-gpu') { a.hardware = true; continue; }
    if (k === '--ablate-aurora') { a.ablateAurora = true; continue; }
    if (k === '--record-baseline') { a.recordBaseline = true; continue; }
    if (k === '--no-mp4') { a.mp4 = false; continue; }
    if (!values[k]) throw Error(`Unknown option ${k}`);
    const v = argv[++i]; if (!v || v.startsWith('--')) throw Error(`${k} requires a value`); a[values[k]] = v;
  }
  assert.ok(a.out, '--out is required');
  for (const k of ['startMs', 'seconds', 'fps', 'liveSeconds']) a[k] = Number(a[k]);
  assert.ok(Number.isFinite(a.startMs) && a.startMs >= 0, 'invalid start-ms');
  assert.ok(a.seconds > 0 && a.seconds <= 10, 'seconds must be >0 through10');
  assert.ok(Number.isInteger(a.fps) && a.fps >= 1 && a.fps <= 60, 'fps must be1 through60');
  assert.ok(Number.isInteger(a.liveSeconds) && a.liveSeconds >= 0 && a.liveSeconds <= 300, 'live-seconds must be0 through300');
  if (a.grid) { assert.ok(['classic', 'classicPlus', 'medium', 'detailed', 'both'].includes(a.grid), 'invalid grid'); a.grids = a.grid === 'both' ? ['classic', 'detailed'] : [a.grid]; }
  if (a.gpuMatch) assert.ok(a.hardware, '--gpu-match requires --hardware-gpu');
  return a;
}
export function makeReviewManifest(a, grid) {
  return normalizeManifest({ version: 1, settings: { width: 1280, height: 720, seed: 315, quality: 0,
    experience: 'landscape', view: a.view, ...(a.view === 'teton-range-tour' ? { tour: 'tetons' } : {}),
    fps: a.fps, mode: 'continuous', startMs: a.startMs,
    presentation: { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35,
      ditherMode: 'selective', pixelGrid: grid, pixelScale: 'original', scaling: 'fit' } },
  songs: [{ id: 'review-audio', fixture: 'contrast', seconds: Math.max(90, a.liveSeconds + 15, Math.ceil((a.startMs / 1000 + a.seconds + 1))),
    timesMs: [a.startMs, a.startMs + a.seconds * 1000], clips: [{ startMs: a.startMs, durationMs: a.seconds * 1000 }] }] });
}
export function requireHardwareRenderer(renderer, match) {
  assert.ok(typeof renderer === 'string' && renderer.length && !/swiftshader|software|llvmpipe|softpipe/i.test(renderer), `Hardware GPU unavailable: ${renderer}`);
  if (match) assert.ok(renderer.toLowerCase().includes(match.toLowerCase()), `Actual GPU does not match ${match}: ${renderer}`);
}
export function validateReviewFrame(frame, grid) {
  assert.equal(frame.presentation?.pixelScale, 'original', 'actual Uniform scale');
  assert.equal(frame.presentation?.effectiveGrid?.id, grid, 'actual selected grid');
  assert.equal(frame.range?.active, true, 'actual terrain active'); assert.equal(frame.range?.runtime, 'ready');
  assert.deepEqual(frame.output, { width: 1280, height: 720 });
}
export function liveReviewGates({delivery,state,errors,seconds,startHeardMs}) {
  const d=delivery?.delivered,r=state?.residency;
  return { noFailedPresentations: delivery?.failedPresentations===0, deliveredFrames: Number.isFinite(d?.frames)&&d.frames>0,
    deliveredP95: Number.isFinite(d?.p95Ms)&&d.p95Ms<=20,
    gapsOver100ms: Number.isFinite(seconds)&&seconds>0&&Number.isFinite(d?.stallsOver100ms)&&d.stallsOver100ms/(seconds/60)<=1,
    visible: delivery?.excluded?.hidden===0,
    graphicsBudget: !!r&&Number.isFinite(r.budgetBytes)&&r.budgetBytes>0&&r.overcommits===0&&r.peakBytes<=r.budgetBytes&&r.budgetBytes<=512*1048576&&r.liveBytes+r.pendingBytes<=r.budgetBytes,
    heardClockAdvanced: Number.isFinite(state?.heardMs)&&Number.isFinite(startHeardMs)&&state.heardMs-startHeardMs>=seconds*1000*.9&&state.paused===false,
    browserErrors: Array.isArray(errors)&&errors.length===0 };
}
export async function loadReviewSnapshot(args) {
  if (!args.snapshot) return snapshotSource(path.resolve(args.source));
  const dir=path.resolve(args.snapshot), manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'))), {hashes,digest}=manifest;
  assert.ok(hashes&&typeof hashes==='object'&&!Array.isArray(hashes),'snapshot hashes required');assert.equal(sha256(JSON.stringify(hashes)),digest,'snapshot manifest digest');
  const files=new Map();
  for(const[name,hash]of Object.entries(hashes)){
    assert.ok((name==='index.html'||name.startsWith('src/'))&&!name.includes('\\')&&!name.split('/').some(p=>p.startsWith('.')),'unsafe snapshot source path');
    assert.match(hash,/^[a-f0-9]{64}$/,'invalid snapshot byte filename');const bytes=await fs.readFile(path.join(dir,hash));assert.equal(sha256(bytes),hash,'snapshot byte hash: '+name);files.set('/'+name,bytes);
  }
  assert.ok(files.has('/index.html'),'snapshot needs index.html');return{files,hashes,digest,capturedSource:manifest.source??null};
}
const json = (p, value) => fs.writeFile(p, JSON.stringify(value, null, 2));
const escape = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
async function newDir(dir) { await fs.mkdir(path.dirname(dir), { recursive: true }); await fs.mkdir(dir); }
async function gitSource(source, owner) {
  const env = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  try { const git = async (...args) => (await owner.execFile('git', args, { cwd: source, env, encoding: 'utf8' })).trim(); return { commit: await git('rev-parse', 'HEAD'), dirty: await git('status', '--porcelain', '--untracked-files=normal') }; }
  catch { owner.check(); return { commit: null, dirty: 'Git provenance unavailable; runtime hashes remain authoritative' }; }
}
async function instrumentReview(page) {
  await page.evaluate(async () => {
    const { BiomeManager } = await import('/src/world/BiomeManager.js');
    const names = ['_drawHorizonEQ', '_drawSpectrumMassif', '_drawDistantWave', '_drawOcean', '_drawFlood', '_drawForegroundSwell', 'drawForeground', '_drawCrestLight'];
    const events = window.__landscapeReviewPaint = {};
    for (const name of names) {
      const original = BiomeManager.prototype[name]; if (!original) continue;
      events[name] = { calls: 0, paints: 0 };
      BiomeManager.prototype[name] = function (ctx, ...args) {
        if (this.world?.kind !== 'alpine') return original.call(this, ctx, ...args);
        const event = events[name], saved = {}; event.calls++;
        for (const k of ['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'putImageData']) {
          saved[k] = ctx[k]; ctx[k] = function (...values) { event.paints++; return saved[k].apply(this, values); };
        }
        try { return original.call(this, ctx, ...args); } finally { for (const [k, value] of Object.entries(saved)) ctx[k] = value; }
      };
    }
  });
}
async function diagnostics(page) {
  return page.evaluate(() => {
    const s = window.__SMW, p = s.sim.biomes.rangePresentation, scene = p.scene, gl=scene.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu:gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL||gl.RENDERER), heardMs: s.sim.heardTimeMs, playheadMs: s.sim.timeMs, paused: s.paused, presentation: structuredClone(s.presentationDiagnostics),
      skyMode: s.presentationDiagnostics.hybridSky ? 'high-resolution-sky/native-grid-terrain' : 'native-grid-all', sky: s.sim.biomes.rangeSkyLayer ? {sourceWidth:s.sim.biomes.rangeSkyLayer.sourceWidth,sourceHeight:s.sim.biomes.rangeSkyLayer.sourceHeight,timeSec:s.sim.biomes.rangeSkyLayer.timeSec,night:s.sim.biomes.rangeSkyLayer.night,sun:s.sim.biomes.rangeSkyLayer.sun,moon:s.sim.biomes.rangeSkyLayer.moon,authority:s.sim.biomes.rangeSkyLayer.authority,storm:s.sim.biomes.rangeSkyLayer.storm,stormLight:s.sim.biomes.rangeSkyLayer.stormLight,output:s.presentationDiagnostics.output} : null, renderReadiness: s.renderReadiness ?? null,
      playbackPreparing: !!s.playbackPreparing, pose: scene.camera ? { eye: scene.camera.position.toArray(), projection: scene.camera.projectionMatrix.toArray() } : null,
      forbiddenOverlayPaint: structuredClone(window.__landscapeReviewPaint),
      windows: scene.snapshot().windows.map(w => ({ index: w.index, coverage: w.coverage,
        detail: Object.fromEntries(Object.entries(w.detail || {}).filter(([k]) => !['strides', 'visible', 'poses'].includes(k))), forestDetail: w.forestDetail })),
      residency: p.residency.snapshot(), forest: [...scene.prepared.values()].map(v => ({ viewId: v.view.id, counts: v.forest?.counts, detail: v.forestDetailViews })) };
  });
}
async function pausedLifecycle(page, before) {
  return page.evaluate(async before => {
    const { pixelGrid } = await import('/src/render/PixelRenderPolicy.js');
    const s = window.__SMW, p = s.sim.biomes.rangePresentation, canvas = document.querySelector('#stage');
    const previous = { ...s.renderer.output.presentation }, size = [canvas.width, canvas.height];
    const held = { heard: s.sim.heardTimeMs, playhead: s.sim.timeMs, engine: s.audioEngine }, states = [];
    try {
      for (const [grid, width, height] of [['detailed', 1920, 1080], ['classic', 1280, 720], [before, ...size]]) {
        canvas.width = width; canvas.height = height;
        s.renderer.setPresentation({ ...previous, grid: pixelGrid(grid), pixelScale: 'original' });
        s.renderer.draw(s.sim, 1); await s.rangeReady({ timeoutMs: 120000 });
        await s.rangeSettle({ timeoutMs: 120000 }); s.renderer.draw(s.sim, 1);
        states.push({ grid, heardMs: s.sim.heardTimeMs, playheadMs: s.sim.timeMs, paused: s.paused,
          sameEngine: s.audioEngine === held.engine, output: [canvas.width, canvas.height],
          presentation: structuredClone(s.presentationDiagnostics), residency: p.residency.snapshot() });
      }
    } finally { [canvas.width, canvas.height] = size; s.renderer.setPresentation(previous); s.renderer.draw(s.sim, 1); }
    return { scope: 'Paused production presenter grid and backing-size round trip; does not simulate a live UI switch or a delayed worker.', states,
      unchanged: states.every(v => v.heardMs === held.heard && v.playheadMs === held.playhead && v.paused && v.sameEngine
        && v.presentation.effectiveGrid.id === v.grid && v.presentation.pixelScale === 'original'
        && v.residency.overcommits === 0 && v.residency.peakBytes <= v.residency.budgetBytes) };
  }, before);
}
async function auroraAblation(page,dir,frame,point,settings) {
  const repeat=await renderEvaluationFrame(page,point,settings);
  const result={timeMs:frame.timeMs,baseline:frame.png,baselineSha256:frame.sha256,
    repeatMatches:sha256(Buffer.from(repeat.pngData,'base64'))===frame.sha256,
    scope:'Experimental runtime-only removal of RangeSkyRenderer._aurora at identical clock/camera; restored immediately. Source bytes unchanged. Attribution requires repeated/restored baseline matches.'};
  await page.evaluate(async()=>{const{RangeSkyRenderer}=await import('/src/world/alpine/RangeSkyRenderer.js');const original=RangeSkyRenderer.prototype._aurora;window.__restoreReviewAurora=()=>{RangeSkyRenderer.prototype._aurora=original;};RangeSkyRenderer.prototype._aurora=()=>{};});
  try {const off=await renderEvaluationFrame(page,point,settings);result.ablated='aurora-disabled.png';const bytes=Buffer.from(off.pngData,'base64');result.ablatedSha256=sha256(bytes);await fs.writeFile(path.join(dir,result.ablated),bytes);result.sameControls=JSON.stringify(off.controls)===JSON.stringify(frame.controls)&&off.actualTimeMs===frame.actualTimeMs;}
  finally {await page.evaluate(()=>window.__restoreReviewAurora());}
  const restored=await renderEvaluationFrame(page,point,settings),bytes=Buffer.from(restored.pngData,'base64');result.restored='aurora-restored.png';result.restoredMatches=sha256(bytes)===frame.sha256;await fs.writeFile(path.join(dir,result.restored),bytes);
  result.status=result.repeatMatches&&result.restoredMatches&&result.sameControls?'matched-ablation':'unmatched-history';await json(path.join(dir,'aurora-ablation.json'),result);return result;
}
async function saveMedia(page, dir, row, settings, mp4, owner) {
  const selected = Array.from({ length: Math.min(8, row.frames.length) }, (_, i) => row.frames[Math.round(i * (row.frames.length - 1) / Math.max(1, Math.min(8, row.frames.length) - 1))]);
  const images = await Promise.all(selected.map(async f => ({ timeMs: f.timeMs, data: (await fs.readFile(path.join(dir, f.png))).toString('base64') })));
  const png = await page.evaluate(async images => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = Math.ceil(images.length / 4) * 204;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#172331'; ctx.fillRect(0, 0, c.width, c.height); ctx.imageSmoothingEnabled = false;
    for (const [i, f] of images.entries()) { const image = new Image(); image.src = 'data:image/png;base64,' + f.data; await image.decode();
      const x = i % 4 * 320, y = Math.floor(i / 4) * 204; ctx.drawImage(image, x, y + 24, 320, 180);
      ctx.fillStyle = '#ffffff'; ctx.font = '16px sans-serif'; ctx.fillText((f.timeMs / 1000).toFixed(3) + ' s', x + 8, y + 18); }
    return c.toDataURL('image/png').split(',')[1];
  }, images);
  await fs.writeFile(path.join(dir, 'contact-sheet.png'), Buffer.from(png, 'base64'));
  const media = { contactSheet: 'contact-sheet.png', matchingAudioFramePlayer: 'index.html', mp4: null, scope: 'Exact PNG/audio clips are authoritative. Contact sheet uses nearest-neighbour thumbnails. MP4 is an optional lossy preview; no fixed-clock capture measures live pacing.' };
  if (mp4) {
    try { await owner.execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-framerate', String(settings.fps), '-i', path.join(dir, row.id, 'frame-%05d.png'), '-ss', String(settings.startMs / 1000), '-i', path.join(dir, row.audio), '-t', String(row.clips[0].durationMs / 1000), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(dir, 'motion.mp4')]); media.mp4 = 'motion.mp4'; }
    catch (error) { owner.check(); media.mp4Unavailable = error.message; }
  }
  media.sha256 = { 'contact-sheet.png': sha256(await fs.readFile(path.join(dir, 'contact-sheet.png'))), ...(media.mp4 ? { 'motion.mp4': sha256(await fs.readFile(path.join(dir, 'motion.mp4'))) } : {}) };
  return media;
}
async function liveReview(browser, url, audio, args, dir) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  const result = { status: 'failed', seconds: args.liveSeconds, errors: [], warnings: [], events: [], scope: 'Separate headless live delivery after the real upload and render-ready audio gate; initial asset wait is separate. No physical-display or foreground/OSfullscreen timing claim.' };
  let browserDiagnostics;
  let failed = false;
  try {
    const page = await context.newPage(), errors = result.errors;
    browserDiagnostics = await attachBrowserDiagnostics(page, { ...result, loadedFiles: new Set() }, {
      origin: new URL(url).origin, isExpectedRequestFailure: expectedTourPreparationFailure });
    await context.addInitScript(() => { const Native = window.AudioContext; window.AudioContext = class extends Native { constructor(o = {}) { super({ ...o, sampleRate: 48000 }); } }; });
    await page.goto(url + '/?experience=landscape&rangeTour=tetons&rangeRenderer=v2&seed=315');
    await page.locator('#titleSettings').evaluate(n => { n.open = true; });
    await page.locator('#lyricGroundingBtn').evaluate(n => { if (n.getAttribute('aria-pressed') === 'true') n.click(); });
    await page.locator('#display-look').selectOption('pixel');await page.locator('#display-pixelGrid').selectOption(args.grids[0]);await page.locator('#stageFps').selectOption('60');if(await page.locator('#display-pixelScale').count())await page.locator('#display-pixelScale').selectOption('original');
    browserDiagnostics.setPhase('audio-analysis');
    const started = Date.now(); await page.locator('#fileInput').setInputFiles(audio);
    await page.waitForFunction(() => window.__SMW?.sim && (window.__SMW.renderReady || window.__SMW.rangeState?.active), null, { timeout: 180000 });
    const ready = await page.evaluate(async () => { const s = window.__SMW, result = s.renderReady ? await s.renderReady : {status:'legacy-ready'}; return { result, preparing: !!s.playbackPreparing, state: s.renderReadiness ?? null, sampleRate: s.audioEngine.ctx.sampleRate, durationMs:s.durationMs, songSeed:s.songSeed, heardMs:s.sim.heardTimeMs }; });
    result.ready = ready;
    assert.ok(ready.result.status === 'ready' || (args.recordBaseline && ready.result.status === 'legacy-ready'), `live readiness failed: ${JSON.stringify(ready)}`);assert.equal(ready.preparing, false);assert.ok(ready.durationMs-ready.heardMs>=args.liveSeconds*1000,'recording too short for requested live trace');
    const uploadToReadyMs = Date.now() - started;Object.assign(result,{uploadToReadyMs,ready});await json(path.join(dir,'live-report.json'),result);
    browserDiagnostics.setPhase('live-playback');
    const delivery = await page.evaluate(async seconds => {
      const { FrameDeliveryAggregator } = await import('/src/render/FrameDelivery.js'); const meter = new FrameDeliveryAggregator(), start = performance.now();
      await new Promise(resolve => { const tick = wallMs => { const s = window.__SMW, f = s.presentationDiagnostics.frame;
        meter.push({ wallMs, generation: s.generation, frameId: `${f.generation}:${f.frameId}`, presented: f.presented,
          attempted: f.reason !== 'not-rendered', paused: s.paused, hidden: document.hidden, capFps: s.fpsCap });
        if (wallMs - start < seconds * 1000) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
      return meter.summary();
    }, args.liveSeconds);
    browserDiagnostics.setPhase('live-acceptance');
    const state = await diagnostics(page);if(args.hardware)requireHardwareRenderer(state.gpu,args.gpuMatch); assert.equal(state.playbackPreparing, false); assert.deepEqual(errors, []);
    assert.equal(state.presentation.pixelScale, 'original');assert.equal(state.presentation.effectiveGrid.id,args.grids[0]);
    Object.assign(result,{uploadToReadyMs,ready,delivery,state,errors,startHeardMs:ready.heardMs});result.targets={deliveredP95Ms:20,gapsOver100msPerMinute:1,maxAccountedGraphicsMiB:512,minHeardAdvanceFraction:.9};result.gates=liveReviewGates(result);result.status=Object.values(result.gates).every(Boolean)?'passed':'failed';assert.equal(result.status,'passed','live delivery or residency targets failed; observed metrics retained');return result;
  } catch(error) { failed = true; result.failure={message:error.message,stack:error.stack};throw error; }
  finally {
    result.finishedAt=new Date().toISOString();await context.close();await browserDiagnostics?.dispose();
    try { finalizeBrowserDiagnostics(result, result, { preserveFailure: failed }); }
    finally { await json(path.join(dir,'live-report.json'),result); }
  }

}
export async function verifyReviewSource(args, expectedDigest, source) {
  source.changedDuringRun = (await loadReviewSnapshot(args)).digest !== expectedDigest;
  assert.equal(source.changedDuringRun, false, 'review source changed during capture');
  return source;
}

export async function runLandscapeReview(args, { launch = options => chromium.launch(options), signals = process } = {}) {
  const out = path.resolve(args.out), source = path.resolve(args.source); await newDir(out);
  const report = { version: 1, status: 'failed', artisticVerdict: 'unreviewed', createdAt: new Date().toISOString(), headless: true,
    tooling: { entrySha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))) }, requestedHardware: !!args.hardware, recordBaseline: !!args.recordBaseline, grids: [], limitations: ['Fixed-clock clips do not measure live pacing.', 'Passing technical gates and changed pixels do not establish artistic quality. Inspect the retained frames and matching audio.'] };
  let browser, server;
  const owner = new ReviewRunOwner(signals);
  try {
    const snapshot = await loadReviewSnapshot(args); owner.check();
    report.source = { ...(snapshot.capturedSource || (args.snapshot ? {commit:null,dirty:'Snapshot supplied without Git provenance'} : await gitSource(source, owner))), digest: snapshot.digest, hashes: snapshot.hashes };
    server = await serveSnapshot(snapshot);
    owner.own(() => server.close()); owner.check();
    browser = await launch({ headless: true, handleSIGINT: false, handleSIGTERM: false,
      ...(args.browser || process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: args.browser || process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
      args: args.hardware ? ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    owner.own(() => browser.close()); owner.check();
    report.browser = browser.version();
    const make = browser.newContext.bind(browser); browser.newContext = async options => { const c = await make(options); await c.addInitScript(() => { const Native = window.AudioContext; window.AudioContext = class extends Native { constructor(o = {}) { super({ ...o, sampleRate: 48000 }); } }; }); return c; };
    const sharedAudio = path.join(out, 'input' + (args.audio ? path.extname(args.audio) : '.wav'));
    if (args.audio) await fs.copyFile(path.resolve(args.audio), sharedAudio);
    else await owner.execFile(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), sharedAudio, String(makeReviewManifest(args, args.grids[0]).songs[0].seconds)]);
    for (const grid of args.grids) {
      owner.check();
      const manifest = makeReviewManifest(args, grid), settings = manifest.settings, song = manifest.songs[0], dir = path.join(out, grid); await newDir(dir); await fs.mkdir(path.join(dir, song.id));
      const audio = `${song.id}/audio${path.extname(sharedAudio)}`; await fs.copyFile(sharedAudio, path.join(dir, audio));
      const row = { id: song.id, audio, audioSha256: sha256(await fs.readFile(sharedAudio)), clips: song.clips, frames: [], errors: [], warnings: [], events: [] };
      const run = { version: 1, status: 'failed', source: report.source, browser: report.browser, settings, songs: [row], captureTransport: { headless: true, hardwareRequired: !!args.hardware }, timingScope: 'Continuous fixed export clock; not live pacing.' };
      report.grids.push({ grid, path: grid + '/index.html', report: grid + '/report.json' });
      await json(path.join(dir, 'manifest.json'), manifest);
      console.log(`Capturing ${grid}: headless ${args.hardware ? 'hardware required' : 'software WebGL'}`);
      let loaded;
      let failed = false;
      try {
        loaded = await openEvaluationSong(browser, { url: server.url, audioPath: sharedAudio, settings, diagnostics: { ...row, loadedFiles: new Set() } });
        run.environment = loaded.environment;console.log(`Actual renderer: ${loaded.environment.gl}`); if (args.hardware) requireHardwareRenderer(loaded.environment.gl, args.gpuMatch);
        row.durationMs = loaded.durationMs; row.schedule = captureSchedule(song, row.durationMs, settings); loaded.browserDiagnostics.setPhase('review-instrumentation'); await instrumentReview(loaded.page);
        for (const point of row.schedule) { loaded.browserDiagnostics.setPhase(`capture:${point.timeMs}ms`); const frame = await renderEvaluationFrame(loaded.page, point, settings); if (!frame) continue;
          validateReviewFrame(frame, grid); assert.equal(blankFrame(frame.thumbnail), false); frame.review = await diagnostics(loaded.page);
          const bytes = Buffer.from(frame.pngData, 'base64'); delete frame.pngData; frame.png = `${song.id}/frame-${String(row.frames.length).padStart(5, '0')}.png`; frame.sha256 = sha256(bytes); await fs.writeFile(path.join(dir, frame.png), bytes); row.frames.push(frame);if(args.ablateAurora&&row.frames.length===1)run.auroraAblation=await auroraAblation(loaded.page,dir,frame,point,settings); }
        loaded.browserDiagnostics.setPhase('paused-lifecycle'); run.lifecycle = await pausedLifecycle(loaded.page, grid); assert.equal(run.lifecycle.unchanged, true);
        run.absenceChecks = await loaded.page.evaluate(() => window.__landscapeReviewPaint); if (!args.recordBaseline) assert.ok(Object.values(run.absenceChecks).every(v => v.paints === 0), 'removed overlay painted');
        loaded.browserDiagnostics.setPhase('review-media'); run.media = await saveMedia(loaded.page, dir, row, settings, args.mp4, owner);report.grids.at(-1).media=run.media; assert.deepEqual(row.errors, []);
        await verifyReviewSource(args, snapshot.digest, run.source);
        owner.check();
        run.status = 'passed';console.log(`Saved ${grid}: ${row.frames.length} actual frames, paused lifecycle and absence checks passed`);
      } catch (error) { failed = true; throw error; }
      finally {
        await loaded?.context.close(); await loaded?.browserDiagnostics.dispose();
        try { finalizeBrowserDiagnostics(row, run, { preserveFailure: failed }); }
        finally { await json(path.join(dir, 'report.json'), run); await fs.writeFile(path.join(dir, 'index.html'), renderRunReport(run)); }
      }
      if (args.baseline) {
        const beforeDir = path.resolve(args.baseline, grid), before = JSON.parse(await fs.readFile(path.join(beforeDir, 'report.json'))), diff = compareReports(before, run), comparison = path.join(out, 'comparison-' + grid); await newDir(comparison);assert.deepEqual(before.captureTransport,run.captureTransport,'review capture transport must match');
        for (const [name, original, data] of [['baseline', beforeDir, before], ['candidate', dir, run]]) {
          const destination = path.join(comparison, name); await fs.mkdir(destination);
          for (const file of new Set(['report.json', 'index.html', 'manifest.json', ...data.songs.flatMap(s => [s.audio, ...s.frames.map(f => f.png)])])) {
            assert.ok(!path.isAbsolute(file) && !file.includes('\\') && !file.split('/').some(p => p.startsWith('.')), 'unsafe evidence path');
            const from = await fs.realpath(path.join(original, file)); assert.ok(from.startsWith(await fs.realpath(original) + path.sep));
            const dest = path.join(destination, file); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(from, dest);
          }
          for (const s of data.songs) { assert.equal(sha256(await fs.readFile(path.join(destination, s.audio))), s.audioSha256); for (const f of s.frames) assert.equal(sha256(await fs.readFile(path.join(destination, f.png))), f.sha256); }
        }
        await json(path.join(comparison, 'comparison.json'), diff); await fs.writeFile(path.join(comparison, 'index.html'), renderComparisonReport(diff, before, run)); report.grids.at(-1).comparison = 'comparison-' + grid + '/index.html';
      }
    }
    if (args.liveSeconds) {report.livePath='live-report.json';report.live = await liveReview(browser, server.url, sharedAudio, args, out);}
    await verifyReviewSource(args, snapshot.digest, report.source); owner.check(); report.status = 'passed';
  } catch (caught) {
    const error = owner.error || caught;
    report.status = error.code === 'REVIEW_CANCELLED' ? 'cancelled' : 'failed';
    report.failure = { message: error.message, stack: error.stack, ...(error.signal ? { signal: error.signal, exitCode: error.exitCode } : {}) };
    throw error;
  }
  finally {
    const cleanupErrors = await owner.close();
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; if (report.status === 'passed') report.status = 'failed'; }
    if (owner.error) {
      report.status = 'cancelled';
      report.failure = { message: owner.error.message, signal: owner.error.signal, exitCode: owner.error.exitCode };
    }
    report.finishedAt = new Date().toISOString(); await json(path.join(out, 'report.json'), report);
    await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Landscape review</title><style>body{font:16px system-ui;background:#15202d;color:#e8eff7;max-width:1400px;margin:28px auto;line-height:1.6}a{color:#a4d9ff}img,video{max-width:100%}</style><h1>Background Landscape review</h1><p>Technical status: ${escape(report.status)}. Artistic judgment: unreviewed. Headless ${args.hardware ? 'verified hardware required' : 'software WebGL'}; actual renderer is in each report.</p><p>Frozen runtime digest: ${escape(report.source?.digest)}</p>${report.grids.map(v => `<section><h2>${v.grid}</h2><a href="${v.path}">Exact consecutive PNGs and matching-audio frame player</a> · <a href="${v.report}">Controls, source, time/pose, sky, lifecycle and absence checks</a>${v.comparison ? ` · <a href="${v.comparison}">Paired comparison</a>` : ''}${v.media?.contactSheet ? `<p><img src="${v.grid}/contact-sheet.png" alt="Time-labelled contact sheet"></p>` : ''}${v.media?.mp4 ? `<video controls preload="metadata" src="${v.grid}/motion.mp4"></video>` : ''}</section>`).join('')}<p><a href="report.json">Complete review report</a>${report.livePath ? ' · <a href="live-report.json">Separate live readiness/delivery trace</a>' : ''}</p><ul>${report.limitations.map(v => `<li>${escape(v)}</li>`).join('')}</ul>`);
  }
  owner.check();
  assert.equal(report.status, 'passed', 'review cleanup failed');
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const args = parseReviewArgs(process.argv.slice(2)); if (args.help) console.log(help); else { const report = await runLandscapeReview(args); console.log(`Saved background review: ${path.resolve(args.out)}/index.html (${report.status}; artistic judgment unreviewed)`); } }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
