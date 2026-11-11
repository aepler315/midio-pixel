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
// The governor's work signal is the whole callback (src/main.js `frame`), so
// a call that makes the callback wait for the GPU counts as work. This tool
// times those calls inside every callback (WebGL2 scene calls as gl.*, the
// Cinematic presenter's WebGL1 calls as gl1.*, 2D canvas calls as 2d.*) and
// logs the governor's level.
//
// It runs software WebGL (SwiftShader). Which calls wait is a property of
// the code path and carries to hardware; how long they wait is this host's.
// --dry skips every draw call and filtered 2D operation, so callbacks hold
// main-thread work and the governor runs with most GPU work taken out.
// --level pins a rung (a seek builds a new governor and drops the pin);
// without it the governor decides, as in the product.
//
// --hardware-gpu asks Chromium for a real GPU and fails if it gets a software
// renderer. That path has not been run on a GPU yet; `npm run test:gpu` is
// the tested route to the RTX 3060.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { evaluationEntryUrl } from './lib/visual-evaluation-browser.mjs';
import { normalizeManifest } from './lib/visual-evaluation.mjs';
import { installCounters } from './range-frame-cost.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Runs before any page script, after installCounters: one record per rAF
// callback while window.__live.on.
function installCallbackLog() {
  const L = window.__live = { on: false, frames: [] };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => raf((t) => {
    if (!L.on) return callback(t);
    const C = window.__gl, start = performance.now();
    C.reset();
    try { return callback(t); } finally {
      const smw = window.__SMW, ms = performance.now() - start;
      const draws = Object.values(C.by).reduce((n, b) => n + b.draws, 0);
      // Callbacks that drew nothing (HUD timers, a paused loop) are not frames.
      if (draws > 0 || ms > 1) {
        L.frames.push({ at: start, ms, draws, level: smw?.perfLevel ?? null, heardMs: smw?.sim?.heardTimeMs ?? null,
          waits: Object.fromEntries(Object.entries(C.waits).map(([k, w]) => [k, w.ms])),
          ops2d: C.canvas2d.ops, filteredOps: C.canvas2d.filteredOps });
      }
    }
  });
}

function parseArgs(argv) {
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
  if (a.dry && a.hardware) throw new Error('--dry removes the GPU work a hardware run exists to measure');
  for (const k of ['seconds', 'songSeconds', 'level', 'seekAt', 'seekTo']) if (a[k] != null) a[k] = Number(a[k]);
  if ((a.seekAt == null) !== (a.seekTo == null)) throw new Error('--seek-at and --seek-to go together');
  return a;
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
    return { callbacks: list.length, workMedianMs: percentile(work, 0.5), workP95Ms: percentile(work, 0.95), workMaxMs: work.at(-1) ?? null,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  const label = args.label || `live-${args.view || (args.songRangeLayout ? `stage-${args.songRangeLayout}` : 'stage')}`;
  await fs.mkdir(out, { recursive: true });
  const audio = args.audio ? path.resolve(args.audio) : path.join(out, `input-${args.songSeconds}s.wav`);
  if (!args.audio) await promisify(execFile)(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), audio, String(args.songSeconds)]);
  const debug = { ...(args.songRange ? { songRange: args.songRange } : {}), ...(args.songRangeLayout ? { songRangeLayout: args.songRangeLayout } : {}) };
  const { settings } = normalizeManifest({ version: 1, settings: { width: 1280, height: 720, seed: 315, quality: 0, fps: 12, mode: 'sparse',
    experience: 'landscape', pace: 3, tour: 'shots',
    presentation: { version: 2, look: 'cinematic', quality: 'auto', pixelGrid: 'detailed', pixelScale: 'original', scaling: 'fit' },
    ...(args.view ? { view: args.view } : { view: null, biome: null, debug }) },
  songs: [{ id: 'live', fixture: 'contrast', seconds: args.songSeconds, timesMs: [0], clips: [] }] });
  const report = { label, dry: args.dry, hardwareRequested: args.hardware, pinnedLevel: args.level ?? null, seconds: args.seconds, settings,
    note: 'Callback work is this machine only. Under software WebGL the waits are not device timing; which calls wait is a property of the code path.' };
  const server = await serveSnapshot(await snapshotSource(root));
  const executablePath = args.browser || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  // The server keeps the process alive: everything after it starts, the
  // browser launch included, runs inside the cleanup scope.
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
      args: ['--autoplay-policy=no-user-gesture-required', ...(args.hardware ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
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
    const started = Date.now();
    await page.locator('#fileInput').setInputFiles(audio);
    await page.waitForFunction(() => window.__SMW?.sim && (window.__SMW.renderReady || window.__SMW.rangeState?.active), null, { timeout: 600000 });
    report.ready = await page.evaluate(async () => {
      const s = window.__SMW, settled = s.renderReady ? await s.renderReady : { status: 'legacy-ready' };
      const gl = s.sim.biomes.rangePresentation?.scene?.renderer?.getContext(), info = gl?.getExtension('WEBGL_debug_renderer_info');
      // The readiness promise resolves on failure too (RenderReadyPlayback.js).
      const result = { status: settled?.status ?? null, error: settled?.error ? String(settled.error.message || settled.error) : null };
      return { result, heardMs: s.sim.heardTimeMs, level: s.perfLevel, gpu: gl ? gl.getParameter(info?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) : null };
    });
    const problem = readinessProblem(report.ready.result);
    if (problem) throw new Error(problem);
    report.uploadToReadyMs = Date.now() - started;
    if (args.hardware && /swiftshader|llvmpipe|software/i.test(report.ready.gpu || '')) throw new Error(`--hardware-gpu, but the renderer is ${report.ready.gpu}`);
    if (args.level != null) await page.evaluate((level) => window.__SMW.perf.setFixtureLevel(level), args.level);
    const client = args.profile ? await context.newCDPSession(page) : null;
    if (client) {
      await client.send('Profiler.enable');
      await client.send('Profiler.setSamplingInterval', { interval: 200 });
      await client.send('Profiler.start');
    }
    const startAt = await page.evaluate(() => { window.__live.on = true; return performance.now(); });
    if (args.seekAt != null) {
      await page.waitForTimeout(args.seekAt * 1000);
      report.seek = await page.evaluate((ms) => { const at = performance.now(); window.__SMW.seek(ms); return { at, toMs: ms }; }, args.seekTo);
      report.seek.atSec = (report.seek.at - startAt) / 1000;
      await page.waitForTimeout(Math.max(0, args.seconds - args.seekAt) * 1000);
    } else await page.waitForTimeout(args.seconds * 1000);
    if (client) {
      const { profile } = await client.send('Profiler.stop');
      report.profile = `${label}.cpuprofile`;
      await fs.writeFile(path.join(out, report.profile), JSON.stringify(profile));
    }
    const live = await page.evaluate(() => {
      const L = window.__live, s = window.__SMW;
      L.on = false;
      const state = structuredClone(s.rangeState);
      return { frames: L.frames, viewId: state.viewId, songRange: state.songRange ?? null, crest: state.crest ?? null, level: s.perfLevel,
        heardMs: s.sim.heardTimeMs, rise01: s.sim.biomes.rangePresentation?.frame?.rise01 ?? null, frameRates: s.frameRates,
        performance: s.performanceSnapshot?.() ?? null };
    });
    report.errors = errors;
    report.summary = summarizeCallbacks(live.frames, startAt);
    report.end = { ...live, frames: undefined };
    report.frames = live.frames;
    const t = report.summary.total;
    console.log(`${label}: view ${live.viewId}, renderer ${report.ready.gpu}, ${t?.callbacks ?? 0} callbacks in ${args.seconds} s, `
      + `work median ${t?.workMedianMs?.toFixed(1)} ms, p95 ${t?.workP95Ms?.toFixed(1)} ms, max ${t?.workMaxMs?.toFixed(1)} ms, `
      + `${((t?.waitShare ?? 0) * 100).toFixed(0)}% of callback time inside waiting calls, final level ${live.level}`);
    if (t) for (const [k, ms] of Object.entries(t.waits).sort((x, y) => y[1] - x[1]).slice(0, 6)) console.log(`  ${k.padEnd(28)} ${ms.toFixed(0).padStart(8)} ms in total`);
    console.log(`  level changes: ${report.summary.levelChanges.map((c) => `${c.atSec.toFixed(1)} s ${c.from}->${c.to}`).join(', ') || 'none'}`
      + `${report.seek ? `; seek to ${report.seek.toMs} ms at ${report.seek.atSec.toFixed(1)} s` : ''}`);
    await context.close();
  } catch (error) {
    report.error = error.message;
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
