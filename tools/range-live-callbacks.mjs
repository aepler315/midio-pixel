// Live playback (the real rAF loop, not the export clock): how long each
// frame callback works, which calls inside it wait for rendering, and what
// the quality governor does about it (frame cost audit,
// docs/frame-cost-audit-2026-11-10.md).
//
//   node tools/range-live-callbacks.mjs --out .smoke/<run>
//        (--view <catalog view id> | --song-range 1|force | --song-range-layout <pilot id>)
//        [--audio song.wav] [--label NAME] [--seconds 30] [--level N]
//        [--seek-at SEC --seek-to MS] [--dry] [--profile]
//        [--hardware-gpu] [--browser FILE]
//
// Records whole presented callbacks, product synchronous waits and governor
// CPU work separately. Preparation and playback share one pre-upload CPU
// profile; the frame log has exact page-clock capture boundaries and scene
// transitions. Timed rendering calls remain a distinct instrument signal.
//
// It runs software WebGL (SwiftShader). Which calls wait is a property of
// the code path and carries to hardware; how long they wait is this host's.
// --dry skips every draw call and filtered 2D operation, so callbacks hold
// main-thread work and the governor runs with most GPU work taken out.
// --level pins a rung before loading and survives rebuilds and seeks;
// without it the governor decides, as in the product.
//
// --hardware-gpu asks Chromium for a real GPU and fails if it gets a software
// or unidentifiable renderer. --hardware-gpu --dry uses the same live loader
// with drawing suppressed, for a matched main-thread comparison.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { evaluationEntryUrl } from './lib/visual-evaluation-browser.mjs';
import { normalizeManifest } from './lib/visual-evaluation.mjs';
import { installCounters } from './range-frame-cost.mjs';
import { seedBrowserConstruction, installSeedReceiver } from './lib/landscape-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Runs before any page script, after installCounters: one record per rAF
// callback while window.__live.on.
export function installCallbackLog() {
  let previousRafAt = null, identityKey = null;
  const observe = (at) => {
    const s = window.__SMW, current = s?.sceneIdentity;
    const key = current ? `${current.sceneEpoch}:${current.analysisStage}:${current.songSeed}:${current.worldId}:${current.viewId}:${current.stageKey}:${current.incomingViewId}:${current.incomingStageKey}` : null;
    if (key === identityKey) return;
    identityKey = key;
    L.transitions.push({ at, identity: structuredClone(current ?? null), range: structuredClone(s?.rangeState ?? null),
      playback: structuredClone(s?.playbackState ?? null),
      presentation: structuredClone(s?.presentationDiagnostics ?? null) });
  };
  const L = window.__live = { on: false, frames: [], transitions: [], boundaries: {},
    arm() {
      this.frames = []; this.transitions = []; this.boundaries = { armedAt: performance.now() };
      previousRafAt = null; identityKey = null; this.on = true; observe(this.boundaries.armedAt);
      return this.boundaries.armedAt;
    },
    mark(name) { const at = performance.now(); this.boundaries[name] = at; observe(at); return at; },
    stop() {
      // Disarm and copy on the page thread before any protocol/file await.
      this.on = false; this.mark('stoppedAt');
      const s = window.__SMW, state = s?.rangeState;
      const end = { viewId: state?.viewId ?? null, songRange: state?.songRange ?? null, crest: state?.crest ?? null,
        level: s?.perfLevel ?? null, heardMs: s?.sim?.heardTimeMs ?? null,
        rise01: s?.sim?.biomes?.rangePresentation?.frame?.rise01 ?? null, frameRates: s?.frameRates ?? null,
        performance: s?.performanceSnapshot?.() ?? null, identity: s?.sceneIdentity ?? null,
        presentation: s?.presentationDiagnostics ?? null };
      return structuredClone({ frames: this.frames, transitions: this.transitions, boundaries: this.boundaries, end });
    },
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => raf((t) => {
    if (!L.on) return callback(t);
    const C = window.__gl, start = performance.now(), before = window.__SMW?.frameRates?.renderedFrames ?? 0;
    C.reset();
    try { return callback(t); } finally {
      const smw = window.__SMW, ms = performance.now() - start;
      observe(start + ms);
      const frameId = smw?.frameRates?.renderedFrames ?? 0;
      // Presentation identity includes fast Canvas2D frames and excludes
      // slow HUD callbacks, capped ticks and asynchronous preparation draws.
      if (frameId > before) {
        const timing = smw.lastFrameTiming?.frameId === frameId ? smw.lastFrameTiming : null;
        const totals = Object.values(C.by).reduce((n, b) => ({ draws: n.draws + (b.draws || 0), triangles: n.triangles + (b.triangles || 0) }), { draws: 0, triangles: 0 });
        const phase = smw.playbackState?.preparing ? 'preparation' : 'playback';
        L.boundaries.firstPresentedAt ??= start;
        L.boundaries.lastPresentedAt = start;
        L.frames.push({ at: start, endAt: start + ms, rafAt: t, rafDeltaMs: timing?.rafDeltaMs ?? null,
          presentedDeltaMs: previousRafAt == null ? null : t - previousRafAt, frameId, phase, ms, ...totals,
          productCallbackMs: timing?.callbackMs ?? null, productSyncWaitMs: timing?.syncWaitMs ?? null,
          governorCpuMs: timing?.workMs ?? null, sceneEpoch: timing?.sceneEpoch ?? smw.sceneIdentity?.sceneEpoch ?? null,
          presentationId: timing?.presentationId ?? null, presentationGeneration: timing?.presentationGeneration ?? null,
          level: smw?.perfLevel ?? null, heardMs: smw?.sim?.heardTimeMs ?? null,
          waits: Object.fromEntries(Object.entries(C.waits).map(([k, w]) => [k, w.ms])),
          ops2d: C.canvas2d.ops, filteredOps: C.canvas2d.filteredOps });
        previousRafAt = t;
      }
    }
  });
}

export function parseArgs(argv) {
  const a = { seconds: '30', songSeconds: '90', dry: false, profile: false, hardware: false };
  const keys = { '--out': 'out', '--audio': 'audio', '--view': 'view', '--song-range': 'songRange', '--song-range-layout': 'songRangeLayout', '--label': 'label',
    '--seconds': 'seconds', '--level': 'level', '--seek-at': 'seekAt', '--seek-to': 'seekTo', '--browser': 'browser', '--song-seconds': 'songSeconds' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') { a.dry = true; continue; }
    if (argv[i] === '--profile') { a.profile = true; continue; }
    if (argv[i] === '--hardware-gpu') { a.hardware = true; continue; }
    if (!keys[argv[i]]) throw new Error(`unknown argument ${argv[i]}`);
    a[keys[argv[i]]] = argv[++i];
  }
  if (!a.out) throw new Error('--out is required');
  if (!a.view && !a.songRange && !a.songRangeLayout) throw new Error('give --view, --song-range or --song-range-layout');
  for (const k of ['seconds', 'songSeconds', 'level', 'seekAt', 'seekTo']) if (a[k] != null) a[k] = Number(a[k]);
  if ((a.seekAt == null) !== (a.seekTo == null)) throw new Error('--seek-at and --seek-to go together');
  return a;
}

export function hardwareRendererProblem(renderer) {
  if (!renderer || /swiftshader|llvmpipe|software|microsoft basic|lavapipe/i.test(renderer)
    || !/nvidia|geforce|radeon|amd|intel|apple|adreno|mali|powervr/i.test(renderer)) {
    return `--hardware-gpu needs an identified hardware renderer, got ${renderer || 'unknown'}`;
  }
  return null;
}

/** Why a settled readiness result is no basis for a measurement, or null when
 *  playback is ready. Preparation that fails or is cancelled resolves its
 *  promise with that status; callbacks recorded after it are no playback. */
export function readinessProblem(result) {
  if (result?.status === 'ready') return null;
  return `playback did not become ready (status ${result?.status ?? 'unknown'}${result?.error ? `: ${result.error}` : ''}); nothing was measured`;
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

/** Per-second rows and whole-run figures from the callback log. */
export function summarizeCallbacks(frames, startAt) {
  const seconds = new Map();
  for (const f of frames) {
    const s = Math.floor((f.at - startAt) / 1000);
    if (!seconds.has(s)) seconds.set(s, []);
    seconds.get(s).push(f);
  }
  const waitsOf = (list) => {
    const total = {};
    for (const f of list) for (const [k, ms] of Object.entries(f.waits)) total[k] = (total[k] || 0) + ms;
    return total;
  };
  const row = (list) => {
    const work = list.map((f) => f.ms).sort((x, y) => x - y), waits = waitsOf(list);
    const waited = Object.values(waits).reduce((n, ms) => n + ms, 0), total = work.reduce((n, ms) => n + ms, 0);
    const metrics = {};
    for (const [field, prefix] of [['productCallbackMs', 'productCallback'], ['productSyncWaitMs', 'productSyncWait'], ['governorCpuMs', 'governorCpu']]) {
      const values = list.map(f => f[field]).filter(Number.isFinite).sort((a, b) => a - b);
      metrics[`${prefix}Samples`] = values.length;
      metrics[`${prefix}MedianMs`] = percentile(values, 0.5);
      metrics[`${prefix}P95Ms`] = percentile(values, 0.95);
      metrics[`${prefix}MaxMs`] = values.at(-1) ?? null;
    }
    return { callbacks: list.length, callbackMedianMs: percentile(work, 0.5), callbackP95Ms: percentile(work, 0.95), callbackMaxMs: work.at(-1) ?? null,
      // Compatibility aliases for prior reports; these measure full callbacks.
      workMedianMs: percentile(work, 0.5), workP95Ms: percentile(work, 0.95), workMaxMs: work.at(-1) ?? null,
      ...metrics,
      waitShare: total ? waited / total : 0, levelMin: Math.min(...list.map((f) => f.level)), levelMax: Math.max(...list.map((f) => f.level)),
      filteredOpsPerCallback: list.reduce((n, f) => n + f.filteredOps, 0) / list.length, ops2dPerCallback: list.reduce((n, f) => n + f.ops2d, 0) / list.length, waits };
  };
  const changes = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].level !== frames[i - 1].level) changes.push({ atSec: (frames[i].at - startAt) / 1000, from: frames[i - 1].level, to: frames[i].level });
  }
  return { total: frames.length ? row(frames) : null, levelChanges: changes,
    perSecond: [...seconds].sort((x, y) => x[0] - y[0]).map(([second, list]) => ({ second, ...row(list) })) };
}

/** One live upload path for full/dry and hardware/software comparisons. */
export async function captureLivePlayback({ page, client = null, audio, seconds, seekAt, seekTo, onReady }) {
  let capture, profile = null, ready = null, seek = null, failure = null, profiling = false;
  await page.evaluate(() => window.__live.arm());
  try {
    if (client) {
      await client.send('Profiler.enable');
      await client.send('Profiler.setSamplingInterval', { interval: 200 });
      await page.evaluate(() => window.__live.mark('profilerStartRequestedAt'));
      await client.send('Profiler.start'); profiling = true;
      await page.evaluate(() => window.__live.mark('profilerStartedAt'));
    }
    await page.evaluate(() => window.__live.mark('uploadAt'));
    await page.locator('#fileInput').setInputFiles(audio);
    await page.waitForFunction(() => window.__SMW?.sim && window.__SMW.renderReady, null, { timeout: 600000 });
    ready = await page.evaluate(async () => {
      // Full-analysis adoption may replace/cancel an opening's preparation.
      // Await whichever readiness promise still owns the current simulation.
      for (;;) {
        const owner = window.__SMW, promise = owner.renderReady, settled = await promise;
        if (window.__SMW !== owner || window.__SMW.renderReady !== promise) continue;
        return { result: { status: settled?.status ?? null, error: settled?.error ? String(settled.error.message || settled.error) : null },
          at: window.__live.mark('readyAt') };
      }
    });
    const problem = readinessProblem(ready.result);
    if (problem) throw new Error(problem);
    await onReady?.(ready);
    await page.waitForFunction(() => window.__live.boundaries.firstPresentedAt != null, null, { timeout: 120000 });
    const waitUntil = async offsetSec => {
      const remaining = await page.evaluate((offset) => Math.max(0,
        window.__live.boundaries.firstPresentedAt + offset * 1000 - performance.now()), offsetSec);
      if (remaining > 0) await page.waitForTimeout(remaining);
    };
    if (seekAt != null) {
      await waitUntil(seekAt);
      seek = await page.evaluate(ms => { const at = performance.now(); window.__SMW.seek(ms); return { at, toMs: ms }; }, seekTo);
    }
    await waitUntil(seconds);
  } catch (error) { failure = error; } finally {
    // This is the measurement boundary. Profile transfer and disk I/O can be
    // slow; no callback after this point may enter the captured frame rows.
    capture = await page.evaluate(() => window.__live.stop());
    if (profiling) ({ profile } = await client.send('Profiler.stop'));
  }
  const result = { capture, profile, ready, seek };
  if (failure) { failure.liveCapture = result; throw failure; }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  const label = args.label || `live-${args.view || (args.songRangeLayout ? `stage-${args.songRangeLayout}` : 'stage')}`;
  await fs.mkdir(out, { recursive: true });
  const audio = args.audio ? path.resolve(args.audio) : path.join(out, `input-${args.songSeconds}s.wav`);
  if (!args.audio) await promisify(execFile)(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), audio, String(args.songSeconds)], { windowsHide: true });
  const debug = { ...(args.songRange ? { songRange: args.songRange } : {}), ...(args.songRangeLayout ? { songRangeLayout: args.songRangeLayout } : {}) };
  const { settings } = normalizeManifest({ version: 1, settings: { width: 1280, height: 720, seed: 315, quality: 0, fps: 12, mode: 'sparse',
    experience: 'landscape', pace: 3, tour: 'shots',
    presentation: { version: 2, look: 'cinematic', quality: 'auto', pixelGrid: 'detailed', pixelScale: 'original', scaling: 'fit' },
    ...(args.view ? { view: args.view } : { view: null, biome: null, debug }) },
  songs: [{ id: 'live', fixture: 'contrast', seconds: args.songSeconds, timesMs: [0], clips: [] }] });
  const snapshot = await snapshotSource(root);
  const git = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true });
  const report = { label, dry: args.dry, hardwareRequested: args.hardware, pinnedLevel: args.level ?? null, seconds: args.seconds, settings,
    source: { commit: git.stdout.trim(), digest: snapshot.digest, hashes: snapshot.hashes,
      instrumentSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))) },
    audio: { path: audio, sha256: sha256(await fs.readFile(audio)), generated: !args.audio, requestedSampleRate: 48000 },
    note: 'Whole callback, product sync waits and governor CPU are separate. Instrument wait timings are not GPU timings. Dry skips drawing and changes pixel-dependent work.' };
  const server = await serveSnapshot(snapshot);
  const executablePath = args.browser || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  // The server keeps the process alive: everything after it starts, the
  // browser launch included, runs inside the cleanup scope.
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', ...(args.hardware ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])] });
    report.browser = { version: browser.version(), executablePath: executablePath ?? chromium.executablePath(), headless: true, muted: true };
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.addInitScript(seedBrowserConstruction, settings.seed);
    await context.addInitScript(installSeedReceiver);
    await context.addInitScript(() => {
      const Native = window.AudioContext;
      window.AudioContext = class extends Native { constructor(options = {}) { super({ ...options, sampleRate: 48000 }); } };
    });
    await context.addInitScript(installCounters, { dry: args.dry });
    await context.addInitScript(installCallbackLog);
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(evaluationEntryUrl(server.url, settings, { bulkExport: false }));
    await page.locator('#titleSettings').evaluate((node) => { node.open = true; });
    await page.locator('#lyricGroundingBtn').evaluate((node) => { if (node.getAttribute('aria-pressed') === 'true') node.click(); });
    await page.locator('#display-pixelGrid').selectOption('detailed');
    await page.locator('#stageFps').selectOption('60');
    if (args.level != null) await page.evaluate((level) => window.__SMW.setFixtureLevel(level), args.level);
    const client = args.profile ? await context.newCDPSession(page) : null;
    const captured = await captureLivePlayback({ page, client, audio, seconds: args.seconds, seekAt: args.seekAt, seekTo: args.seekTo,
      onReady: async (ready) => {
        report.ready = { ...ready, ...await page.evaluate(() => {
          const s = window.__SMW, gl = s.sim.biomes.rangePresentation?.scene?.renderer?.getContext();
          const info = gl?.getExtension('WEBGL_debug_renderer_info');
          return { heardMs: s.sim.heardTimeMs, level: s.perfLevel, fixtureLevel: s.fixtureLevel,
            gpu: gl ? gl.getParameter(info?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) : null,
            vendor: gl ? gl.getParameter(info?.UNMASKED_VENDOR_WEBGL || gl.VENDOR) : null,
            constructionSeed: window.__landscapeConstructionSeed, songSeed: s.songSeed, identity: s.sceneIdentity,
            sampleRate: s.audioBuffer?.sampleRate ?? null, audioDurationSec: s.audioBuffer?.duration ?? null,
            presentation: s.presentationDiagnostics, displayPrefs: s.displayPrefs, frameRates: s.frameRates,
            fpsCap: s.fpsCap, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } };
        }) };
        const gpuProblem = args.hardware && hardwareRendererProblem(report.ready.gpu);
        if (gpuProblem) throw new Error(gpuProblem);
        if (args.level != null && report.ready.level !== args.level) throw new Error(`fixture level ${report.ready.level} != requested ${args.level}`);
      } });
    if (captured.profile) {
      report.profile = `${label}.cpuprofile`;
      await fs.writeFile(path.join(out, report.profile), JSON.stringify(captured.profile));
    }
    const live = captured.capture.end;
    const { frames, boundaries, transitions } = captured.capture;
    const startAt = boundaries.firstPresentedAt ?? boundaries.readyAt;
    report.boundaries = { ...boundaries, requestedPlaybackMs: args.seconds * 1000,
      actualPlaybackMs: boundaries.stoppedAt - startAt, endOvershootMs: boundaries.stoppedAt - startAt - args.seconds * 1000,
      preparationMs: startAt - boundaries.uploadAt, captureMs: boundaries.stoppedAt - boundaries.armedAt };
    report.uploadToReadyMs = boundaries.readyAt - boundaries.uploadAt;
    report.transitions = transitions;
    if (captured.seek) report.seek = { ...captured.seek, atSec: (captured.seek.at - startAt) / 1000 };
    report.errors = errors;
    report.summary = summarizeCallbacks(frames, startAt);
    report.end = live;
    report.frames = frames;
    const t = report.summary.total;
    console.log(`${label}: view ${live.viewId}, renderer ${report.ready.gpu}, ${t?.callbacks ?? 0} callbacks in ${args.seconds} s, `
      + `callback median ${t?.callbackMedianMs?.toFixed(1)} ms, p95 ${t?.callbackP95Ms?.toFixed(1)} ms, max ${t?.callbackMaxMs?.toFixed(1)} ms, `
      + `${((t?.waitShare ?? 0) * 100).toFixed(0)}% of callback time inside waiting calls, final level ${live.level}`);
    if (t) for (const [k, ms] of Object.entries(t.waits).sort((x, y) => y[1] - x[1]).slice(0, 6)) console.log(`  ${k.padEnd(28)} ${ms.toFixed(0).padStart(8)} ms in total`);
    console.log(`  level changes: ${report.summary.levelChanges.map((c) => `${c.atSec.toFixed(1)} s ${c.from}->${c.to}`).join(', ') || 'none'}`
      + `${report.seek ? `; seek to ${report.seek.toMs} ms at ${report.seek.atSec.toFixed(1)} s` : ''}`);
    await context.close();
  } catch (error) {
    report.error = error.message;
    if (error.liveCapture) {
      report.boundaries = error.liveCapture.capture.boundaries;
      report.frames = error.liveCapture.capture.frames;
      report.transitions = error.liveCapture.capture.transitions;
      if (error.liveCapture.profile) {
        report.profile = `${label}.cpuprofile`;
        await fs.writeFile(path.join(out, report.profile), JSON.stringify(error.liveCapture.profile));
      }
    }
    throw error;
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
    await fs.writeFile(path.join(out, `${label}.json`), `${JSON.stringify(report, null, 1)}\n`);
  }
  console.log(`report: ${path.join(args.out, `${label}.json`)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
