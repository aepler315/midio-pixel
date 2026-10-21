// Diagnostic companion to current-routes-smoke.mjs. It repeats one ordinary
// route against a frozen staged tree and records where frame production stops:
// rAF delivery, long animation frames with script attribution, evaluate
// round-trips that do not wait for rAF, per-thread Chromium CPU from /proc,
// an optional WebGL call wrapper, a Chromium trace and screenshot latency.
// It never decides acceptance and its long screenshot deadline is diagnostic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { attachBrowserDiagnostics } from './lib/browser-diagnostics.mjs';
import { CURRENT_ROUTES, validateRoutePlayback } from './lib/current-route-evidence.mjs';
import { playbackSample as gateSample } from './current-routes-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing', 'v8.execute', 'gpu', 'viz', 'cc', 'disabled-by-default-v8.cpu_profiler'];
// A narrower set that adds ANGLE's own events inside GPU-process tasks.
const ANGLE_TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'gpu', 'gpu.angle', 'viz'];
const GL_SYNC = ['readPixels', 'getError', 'getParameter', 'getProgramParameter', 'getShaderParameter',
  'getProgramInfoLog', 'getShaderInfoLog', 'clientWaitSync', 'getSyncParameter', 'finish',
  'getBufferSubData', 'getActiveUniform', 'getActiveAttrib', 'getUniformLocation', 'getAttribLocation',
  'checkFramebufferStatus', 'getExtension', 'getSupportedExtensions'];
const GL_WORK = ['compileShader', 'linkProgram', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D',
  'texStorage2D', 'texStorage3D', 'compressedTexImage2D', 'bufferData', 'bufferSubData', 'generateMipmap',
  'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawBuffers',
  'blitFramebuffer', 'flush', 'viewport', 'bindFramebuffer', 'useProgram'];

// Runs in the page before application code. Records rAF delivery independent
// of the application loop, long animation frames and, optionally, WebGL calls.
function installPageProbe({ wrapGl, sync, work }) {
  const probe = globalThis.__routeProbe = { raf: [], loaf: [], longtasks: [], slowGl: [], glFrames: {} };
  const tick = time => { probe.raf.push(Math.round(time)); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const observe = (type, map, target) => {
    try {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) target.push(map(entry)); })
        .observe({ type, buffered: true });
    } catch (error) { probe[`${type}Error`] = String(error); }
  };
  observe('long-animation-frame', entry => ({ start: entry.startTime, duration: entry.duration,
    blocking: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
    scripts: (entry.scripts || []).map(script => ({ invoker: script.invoker, type: script.invokerType,
      url: script.sourceURL, fn: script.sourceFunctionName, at: script.sourceCharPosition,
      start: script.startTime, duration: script.duration, layout: script.forcedStyleAndLayoutDuration,
      pause: script.pauseDuration })) }), probe.loaf);
  observe('longtask', entry => ({ start: entry.startTime, duration: entry.duration }), probe.longtasks);
  // Always on and cheap: attribute any texture allocation or canvas upload
  // whose size is not positive (WebGL rejects it with INVALID_VALUE).
  probe.invalidTextures = [];
  for (const proto of [globalThis.WebGL2RenderingContext?.prototype, globalThis.WebGLRenderingContext?.prototype]) {
    if (!proto) continue;
    for (const name of ['texStorage2D', 'texImage2D', 'texSubImage2D']) {
      const original = proto[name];
      if (typeof original !== 'function' || original.__trap) continue;
      const trapped = function (...args) {
        const numbers = args.filter(arg => typeof arg === 'number');
        const source = args.find(arg => arg && typeof arg === 'object' && 'width' in arg && 'height' in arg);
        const empty = name === 'texStorage2D' ? !(numbers[3] > 0 && numbers[4] > 0)
          : source ? !(source.width > 0 && source.height > 0) : false;
        if (empty && probe.invalidTextures.length < 20) {
          const scene = globalThis.__SMW?.sim?.biomes?.rangePresentation?.scene;
          probe.invalidTextures.push({ name, at: performance.now(), raf: probe.raf.length, args: numbers.slice(0, 6),
            source: source ? { type: source.constructor?.name, width: source.width, height: source.height } : null,
            backdrop: scene ? (scene.backdrop ? { width: scene.backdrop.width, height: scene.backdrop.height,
              canvas: [scene.backdrop.canvas?.width, scene.backdrop.canvas?.height], frame: scene.backdrop.frame } : null) : 'no scene',
            stack: String(new Error().stack).split('\n').slice(2, 14).map(line => line.trim()) });
        }
        return original.apply(this, args);
      };
      trapped.__trap = true;
      proto[name] = trapped;
    }
  }
  if (!wrapGl) return;
  for (const proto of [globalThis.WebGL2RenderingContext?.prototype, globalThis.WebGLRenderingContext?.prototype]) {
    if (!proto) continue;
    for (const name of [...sync, ...work]) {
      const original = proto[name];
      if (typeof original !== 'function' || original.__probe) continue;
      // Upload bytes, draw vertex counts and the bound framebuffer's viewport
      // area say what a frame submits; durations only show where it waits.
      const amount = args => {
        if (/^draw(Arrays|Elements)/.test(name)) return (name.startsWith('drawArrays') ? args[2] : args[1]) * (/Instanced$/.test(name) ? args.at(-1) : 1);
        const view = args.find(arg => ArrayBuffer.isView(arg));
        if (view) return view.byteLength;
        if (name === 'bufferData' && typeof args[1] === 'number') return args[1];
        if (/^tex(Image|Storage)/.test(name)) {
          const numbers = args.filter(arg => typeof arg === 'number');
          return name.startsWith('texStorage') ? numbers[3] * numbers[4] : numbers[3] * numbers[4];
        }
        return 0;
      };
      const wrapped = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); } finally {
          const duration = performance.now() - start, frame = probe.raf.length;
          const bucket = probe.glFrames[frame] ??= {};
          const stat = bucket[name] ??= [0, 0, 0];
          stat[0]++; stat[1] += duration;
          try { stat[2] += amount(args) || 0; } catch { /* diagnostic only */ }
          // Viewport is tracked from viewport() calls; querying it would add a round trip.
          if (name === 'viewport') this.__probeViewport = args[2] * args[3];
          else if (/^draw(Arrays|Elements)/.test(name)) {
            bucket.fragmentsUpperBound = (bucket.fragmentsUpperBound ?? 0) + (this.__probeViewport ?? 0);
          }
          if (duration >= 100) {
            probe.slowGl.push({ name, frame, start, duration, arg: typeof args[0] === 'number' ? args[0] : null,
              stack: String(new Error().stack).split('\n').slice(2, 12).map(line => line.trim()) });
          }
        }
      };
      wrapped.__probe = true;
      proto[name] = wrapped;
    }
  }
}

// /proc thread CPU, grouped by Chromium process type. Linux only.
function chromiumThreads(rootPid) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch { /* exited */ }
  }
  const pids = [], queue = [rootPid];
  while (queue.length) { const pid = queue.shift(); pids.push(pid); queue.push(...(children.get(pid) ?? [])); }
  const threads = [];
  for (const pid of pids) {
    try {
      // Chromium rewrites its process title, so arguments may be space separated.
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
      let type = cmd.find(arg => arg.startsWith('--type='))?.slice(7) ?? 'browser';
      if (type === 'utility') type += ':' + (cmd.find(arg => arg.startsWith('--utility-sub-type='))?.split('.').at(-1) ?? '?');
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        threads.push({ key: `${pid}/${tid}`, pid, type, comm, ticks: Number(fields[11]) + Number(fields[12]) });
      }
    } catch { /* exited */ }
  }
  return threads;
}

// Playwright does not expose the launched browser's pid; it is this Node
// process's Chromium child without a --type switch.
function browserPid() {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== process.pid) continue;
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').split(/[\0 ]/);
      if (/chrom/i.test(cmd[0]) && !cmd.some(arg => arg.startsWith('--type='))) return Number(name);
    } catch { /* exited */ }
  }
  throw new Error('launched Chromium process not found');
}

function startCpuSampler(rootPid, intervalMs = 500) {
  const samples = [];
  let previous = new Map(chromiumThreads(rootPid).map(t => [t.key, t.ticks]));
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now(), seconds = (now - last) / 1000, byType = {}, top = [];
    const threads = chromiumThreads(rootPid);
    for (const t of threads) {
      const delta = t.ticks - (previous.get(t.key) ?? t.ticks);
      if (delta <= 0) continue;
      const cores = delta / 100 / seconds; // CLK_TCK is 100 on this Linux target.
      byType[t.type] = (byType[t.type] ?? 0) + cores;
      top.push({ type: t.type, comm: t.comm, cores: +cores.toFixed(2) });
    }
    previous = new Map(threads.map(t => [t.key, t.ticks])); last = now;
    top.sort((a, b) => b.cores - a.cores);
    samples.push({ t: now, byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, +v.toFixed(2)])),
      top: top.slice(0, 8) });
  }, intervalMs);
  return { samples, stop: () => clearInterval(timer) };
}

// Evaluate round-trips are tasks, not rAF callbacks: they show whether the
// renderer main thread is free while frames are not being produced.
function startPings(page, intervalMs = 500) {
  const pings = [];
  let busy = false, stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) { if (!stopped) pings.push({ t: Date.now(), skipped: true }); return; }
    busy = true;
    const sent = Date.now();
    try {
      const value = await page.evaluate(() => {
        const s = window.__SMW;
        const scene = s?.sim?.biomes?.rangePresentation?.scene, info = scene?.renderer?.info;
        return { pageNow: performance.timeOrigin + performance.now(), raf: window.__routeProbe?.raf.length ?? null,
          audioMs: s?.audioEngine?.nowMs ?? null, simMs: s?.sim?.timeMs ?? null,
          frameId: s?.presentationDiagnostics?.frame?.frameId ?? null, preparing: s?.playbackPreparing ?? null,
          three: info ? { programs: info.programs?.length ?? null, geometries: info.memory?.geometries,
            textures: info.memory?.textures, calls: info.render?.calls, triangles: info.render?.triangles } : null,
          sceneStats: (() => { try { return scene?.stats ? JSON.parse(JSON.stringify(scene.stats)) : null; } catch { return 'unserializable'; } })() };
      });
      pings.push({ t: sent, latency: Date.now() - sent, ...value });
    } catch (error) { pings.push({ t: sent, latency: Date.now() - sent, error: String(error).split('\n')[0] }); }
    finally { busy = false; }
  }, intervalMs);
  return { pings, stop: () => { stopped = true; clearInterval(timer); } };
}

// The gate's own observation, including its 64x36 readback, so the same
// validation applies; the rAF count places it on the probe's timeline.
async function playbackSample(page) {
  const sample = await gateSample(page);
  sample.frameId = sample.frame?.frameId ?? null;
  sample.raf = await page.evaluate(() => window.__routeProbe?.raf.length ?? null);
  return sample;
}

async function timed(label, events, operation) {
  const start = Date.now();
  try { const value = await operation(); events.push({ label, start, ms: Date.now() - start, ok: true }); return value; }
  catch (error) { events.push({ label, start, ms: Date.now() - start, ok: false, error: String(error).split('\n')[0] }); throw error; }
}

async function probeRoute(browser, url, audioPath, routeId, outDir, options) {
  const result = { route: routeId, events: [], samples: [], screenshots: [], errors: [], warnings: [] };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const diagnostics = { errors: result.errors, warnings: result.warnings, events: [], loadedFiles: new Set() };
  const controls = await attachBrowserDiagnostics(page, diagnostics, { origin: url, phase: 'entry' });
  result.consoleTimeline = [];
  page.on('console', entry => {
    if (['error', 'warning'].includes(entry.type()) && result.consoleTimeline.length < 200) {
      result.consoleTimeline.push({ t: Date.now(), type: entry.type(), text: entry.text().slice(0, 300) });
    }
  });
  await page.addInitScript(installPageProbe, { wrapGl: options.wrapGl, sync: GL_SYNC, work: GL_WORK });
  await context.route('**/*', route => {
    const request = new URL(route.request().url());
    return request.origin === url || ['data:', 'blob:'].includes(request.protocol) ? route.continue() : route.abort();
  });
  let cpu, pings, tracing = false;
  try {
    await page.goto(url + '/?experience=landscape');
    await page.locator('#titleSettings').evaluate(node => { node.open = true; });
    const lyrics = page.locator('#lyricGroundingBtn');
    if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
    await page.locator('#display-pixelGrid').selectOption('classic');
    if (routeId.startsWith('tour-')) {
      await page.locator('#range-tour-toggle').check();
      if (routeId === 'tour-persisted') {
        await page.goto(url + '/?experience=landscape');
        await page.locator('#titleSettings').evaluate(node => { node.open = true; });
        assert.equal(await page.locator('#range-tour-toggle').isChecked(), true);
      }
    } else if (routeId === 'trio') {
      await page.locator('#display-experience').selectOption('trio');
    }
    result.entryUrl = page.url();
    controls.setPhase('upload-and-prepare');
    if (options.trace) {
      await browser.startTracing(page, { categories: options.trace === 'angle' ? ANGLE_TRACE_CATEGORIES : TRACE_CATEGORIES });
      tracing = true;
    }
    if (options.browserPid) cpu = startCpuSampler(options.browserPid);
    pings = startPings(page);
    result.uploadAt = Date.now();
    await page.locator('#fileInput').setInputFiles(audioPath);
    await timed('ready-wait', result.events, () => page.waitForFunction(() => {
      const s = window.__SMW;
      return s?.renderReadiness?.status === 'failed'
        || (s?.sim && !s.playbackPreparing && s.audioEngine?.playing && s.presentationDiagnostics?.frame?.presented);
    }, null, { timeout: options.timeoutMs }));
    controls.setPhase('live-playback');
    result.samples.push(await timed('sample-1', result.events, () => playbackSample(page)));
    const first = result.samples[0];
    await timed('advance-wait', result.events, () => page.waitForFunction(firstSample => {
      const s = window.__SMW, frame = s?.presentationDiagnostics?.frame;
      return s?.audioEngine?.nowMs > firstSample.audioMs + 1000 && s.sim.timeMs > firstSample.simMs
        && frame?.presented && frame.frameId > firstSample.frameId;
    }, first, { timeout: options.timeoutMs }));
    result.samples.push(await timed('sample-2', result.events, () => playbackSample(page)));
    try { validateRoutePlayback(routeId, result.samples); result.playbackValidation = 'passed'; }
    catch (error) { result.playbackValidation = String(error.message || error).split('\n')[0]; }
    for (let i = 0; i < options.screenshots; i++) {
      if (i && options.screenshotIntervalMs) await new Promise(resolve => setTimeout(resolve, options.screenshotIntervalMs));
      const file = path.join(outDir, `${routeId}-${i + 1}.png`), start = Date.now();
      try {
        await page.screenshot({ path: file, timeout: options.screenshotTimeoutMs });
        result.screenshots.push({ start, ms: Date.now() - start, ok: true, file: path.basename(file) });
      } catch (error) {
        result.screenshots.push({ start, ms: Date.now() - start, ok: false, error: String(error).split('\n')[0] });
      }
      result.samples.push(await timed(`sample-after-screenshot-${i + 1}`, result.events, () => playbackSample(page)).catch(() => null));
    }
  } catch (error) {
    result.failure = String(error.stack || error);
  } finally {
    pings?.stop(); cpu?.stop();
    result.pings = pings?.pings ?? []; result.cpu = cpu?.samples ?? [];
    result.page = await Promise.race([page.evaluate(() => {
      const p = window.__routeProbe;
      return p && { timeOrigin: performance.timeOrigin, raf: p.raf, loaf: p.loaf, longtasks: p.longtasks, slowGl: p.slowGl,
        glFrames: p.glFrames, invalidTextures: p.invalidTextures, loafError: p.loafError ?? null,
        longtaskError: p.longtaskError ?? null };
    }), new Promise(resolve => setTimeout(() => resolve({ unavailable: 'page probe did not answer within 20 s' }), 20000))])
      .catch(error => ({ unavailable: String(error) }));
    if (tracing) {
      const trace = await browser.stopTracing();
      await fs.writeFile(path.join(outDir, `${routeId}-trace.json`), trace);
      result.trace = { file: `${routeId}-trace.json`, bytes: trace.length };
    }
    result.loadedFiles = [...diagnostics.loadedFiles].sort();
    await context.close().catch(() => {});
    await Promise.resolve(controls.dispose?.()).catch(() => {});
  }
  return result;
}

export async function runRouteStallProbe({ siteRoot = path.join(root, '_site'), outDir, audioPath = null,
  routes = ['landscape', 'tour-persisted'], trace = true, wrapGl = false, screenshots = 2,
  screenshotTimeoutMs = 180000, screenshotIntervalMs = 0, timeoutMs = 300000, hardwareGpu = false, browserPath = null } = {}) {
  assert.ok(outDir, 'an explicit --out directory is required');
  for (const id of routes) assert.ok(CURRENT_ROUTES.includes(id), `unknown route ${id}`);
  outDir = path.resolve(outDir);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir); // Never overwrite an earlier evidence run.
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  // Native Windows git cannot follow a worktree created from WSL; record that.
  const git = (...args) => {
    try { return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const report = { version: 1, kind: 'diagnostic', commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=normal'), platform: process.platform, node: process.version,
    options: { routes, trace, wrapGl, screenshots, screenshotTimeoutMs, screenshotIntervalMs, timeoutMs, hardwareGpu }, routes: [] };
  const source = await snapshotSource(path.resolve(siteRoot));
  report.source = { siteRoot: path.resolve(siteRoot), digest: source.digest };
  if (!audioPath) {
    audioPath = path.join(outDir, 'fixture.wav');
    execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audioPath, '120', '120']);
    report.fixture = 'generated 120-second kick/hat/melody';
  } else report.fixture = 'provided recording';
  report.audio = { file: path.resolve(audioPath), sha256: sha256(await fs.readFile(audioPath)) };
  const server = await serveSnapshot(source);
  // Software flags match current-routes-smoke.mjs; hardware flags match
  // landscape-review.mjs --hardware-gpu. Nothing else differs between them.
  const browser = await chromium.launch({ executablePath: browserPath || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    headless: true, args: hardwareGpu ? ['--mute-audio', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  report.browser = browser.version();
  try {
    const pid = process.platform === 'linux' ? browserPid() : null;
    for (const id of routes) {
      console.log(`Probe route: ${id}`);
      const row = await probeRoute(browser, server.url, path.resolve(audioPath), id, outDir,
        { trace, wrapGl, screenshots, screenshotTimeoutMs, screenshotIntervalMs, timeoutMs, browserPid: pid });
      row.renderer = row.samples.find(sample => sample?.gpu)?.gpu ?? null;
      if (hardwareGpu && row.renderer && /swiftshader/i.test(row.renderer)) row.failure ??= `hardware GPU requested but renderer is ${row.renderer}`;
      report.routes.push(row);
      console.log(`${id}: ${row.failure ? 'incomplete — ' + row.failure.split('\n')[0] : 'observed'}; screenshots ${row.screenshots.map(s => `${s.ok ? 'ok' : 'FAILED'} ${s.ms} ms`).join(', ')}`);
      await fs.writeFile(path.join(outDir, 'probe.json'), JSON.stringify(report, null, 1) + '\n');
    }
    report.source.changedDuringRun = (await snapshotSource(path.resolve(siteRoot))).digest !== source.digest;
  } finally {
    await browser.close(); await server.close();
    await fs.writeFile(path.join(outDir, 'probe.json'), JSON.stringify(report, null, 1) + '\n');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  const names = { '--site-root': 'siteRoot', '--out': 'outDir', '--audio': 'audioPath', '--routes': 'routes',
    '--trace': 'trace', '--wrap-gl': 'wrapGl', '--screenshots': 'screenshots',
    '--screenshot-timeout-ms': 'screenshotTimeoutMs', '--screenshot-interval-ms': 'screenshotIntervalMs',
    '--timeout-ms': 'timeoutMs', '--browser': 'browserPath' };
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--hardware-gpu') { options.hardwareGpu = true; i--; continue; }
      const name = names[args[i]], value = args[i + 1];
      assert.ok(name && value !== undefined, `unknown or incomplete option ${args[i]}`);
      if (name === 'routes') options.routes = value.split(',');
      else if (name === 'trace') options.trace = value === 'angle' ? 'angle' : value === 'on';
      else if (name === 'wrapGl') options.wrapGl = value === 'on';
      else if (['screenshots', 'screenshotTimeoutMs', 'screenshotIntervalMs', 'timeoutMs'].includes(name)) options[name] = Number(value);
      else options[name] = value;
    }
    await runRouteStallProbe(options);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
