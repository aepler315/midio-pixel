// Ordinary upload/play routes against a frozen copy of the staged public tree.
// No bulkExport, forced renderer, forced world, or synthetic playback bus.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { attachBrowserDiagnostics } from './lib/browser-diagnostics.mjs';
import { CURRENT_ROUTES, validateRoutePlayback, summarizeRouteRun } from './lib/current-route-evidence.mjs';
import { requireHardwareRenderer } from './landscape-review.mjs';
import { isWsl, toWindowsPath, writePlaywrightLoader, runChild } from './lib/windows-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The default gate renders with SwiftShader. The opt-in hardware configuration
// uses route-stall-probe.mjs --hardware-gpu's flags (the GPU flags of
// landscape-review.mjs --hardware-gpu, plus --mute-audio) and is a separate
// result: it must prove its renderer and never replaces the default.
export const SWIFTSHADER_ARGS = Object.freeze(['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']);
export const HARDWARE_GPU_ARGS = Object.freeze(['--mute-audio', '--enable-gpu', '--ignore-gpu-blocklist']);

export function routeGateConfiguration({ hardwareGpu = false, gpuMatch = null, browserPath = null } = {}) {
  assert.ok(!gpuMatch || hardwareGpu, '--gpu-match requires --hardware-gpu');
  const executablePath = browserPath || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  return hardwareGpu
    ? { id: 'hardware-gpu', label: 'Opt-in hardware GPU; the actual renderer must not be software',
      hardwareRequired: true, gpuMatch: gpuMatch || null, args: [...HARDWARE_GPU_ARGS], executablePath }
    : { id: 'swiftshader', label: 'Default SwiftShader software WebGL gate',
      hardwareRequired: false, gpuMatch: null, args: [...SWIFTSHADER_ARGS], executablePath };
}

// The same check as landscape-review --hardware-gpu (and so test:gpu), not a
// copy: it rejects SwiftShader, llvmpipe, softpipe, Windows WARP and the masked
// renderer string.
export const requireRouteHardwareRenderer = requireHardwareRenderer;

// Landscape and tours sample the range presentation's own WebGL context. Trio
// draws through Canvas 2D and has none, so it relies on the browser probes.
export function verifyHardwareRoute(row, match) {
  assert.ok(row.samples?.length, `${row.id}: no playback samples to attribute a renderer`);
  for (const sample of row.samples) {
    if (row.id === 'trio' && sample?.gpu == null) continue;
    requireRouteHardwareRenderer(sample?.gpu, match);
  }
}

export function summarizeConfiguredRun(routes, configuration, browserProbe = {}) {
  const status = summarizeRouteRun(routes);
  if (status !== 'passed' || !configuration.hardwareRequired) return status;
  try {
    for (const renderer of [browserProbe.before, browserProbe.after]) requireRouteHardwareRenderer(renderer, configuration.gpuMatch);
    for (const row of routes) verifyHardwareRoute(row, configuration.gpuMatch);
    return 'passed';
  } catch { return 'failed'; }
}

// Native Windows git cannot follow a worktree created from WSL. Record that
// instead of failing the run; the staged digest stays the authoritative identity.
export function checkoutIdentity(cwd = root) {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=normal') }; }
  catch (error) {
    return { commit: null, dirty: null, identity: 'unavailable', authoritative: 'staged digest',
      reason: String(error.stderr || error.message).trim().split('\n')[0] };
  }
}

async function bestEffort(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function playbackSample(page) {
  return page.evaluate(() => {
    const s = window.__SMW, frame = s.presentationDiagnostics?.frame;
    const capture = s.renderer.getCaptureSource();
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(document.getElementById('stage'), 0, 0, 64, 36);
    const pixels = ctx.getImageData(0, 0, 64, 36).data, colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    const gl = s.sim.biomes.rangePresentation?.scene?.renderer?.getContext();
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { audioMs: s.audioEngine.nowMs, bufferDurationMs: (s.audioEngine.sourceNode?.buffer?.duration ?? 0) * 1000,
      contextTime: s.audioEngine.ctx.currentTime,
      simMs: s.sim.timeMs, heardMs: s.sim.heardTimeMs, audioState: s.audioEngine.ctx.state,
      playing: s.audioEngine.playing, hasBuffer: !!s.audioEngine.sourceNode?.buffer,
      paused: s.paused, preparing: s.playbackPreparing, hidden: document.hidden,
      generation: s.generation, experience: s.experience, worldKind: s.sim.biomes.world.kind,
      trio: !!s.sim.trio, pickerOpen: !!document.getElementById('worldSelect')?.open,
      frame, capture: capture ? { presented: capture.presented,
        frameId: capture.frameId, generation: capture.generation } : null,
      colors: colors.size, range: s.sim.biomes.rangePresentation?.status() ?? { active: false }, readiness: s.renderReadiness,
      gpu: gl ? gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) : null };
  });
}

// Hardware configuration only: one throwaway WebGL2 context in its own browser
// context shows the GPU-process backend that every page of this browser uses.
async function probeBrowserRenderer(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await bestEffort(page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) : null;
    }), 30000);
  } finally { await context.close(); }
}

async function exerciseRoute(browser, url, audioPath, row, timeoutMs, outDir, configuration) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1, serviceWorkers: 'block' });
  let page, controls, diagnostics, timedOut = false, accepting = true;
  try {
    page = await context.newPage(); page.setDefaultTimeout(30000);
    diagnostics = { ...row, loadedFiles: new Set() };
    controls = await attachBrowserDiagnostics(page, diagnostics, { origin: url, phase: 'entry' });
    await context.route('**/*', route => {
      const request = new URL(route.request().url());
      return request.origin === url || ['data:', 'blob:'].includes(request.protocol)
        ? route.continue() : route.abort();
    });
    const run = async () => {
      // Camera tours are on by default (each approved view's shot tour); the
      // Teton highway tour is chosen by ?rangeTour=tetons, or by a saved
      // 'range-tour' preference, never by the toggle (which writes shots/off).
      // See resolveRangeMode in src/world/alpine/RangePresentation.js.
      if (row.id === 'tour-persisted') {
        controls.setPhase('persisted-preference');
        await page.goto(url + '/');
        await page.evaluate(() => localStorage.setItem('range-tour', 'tetons'));
      }
      await page.goto(url + (row.id === 'tour-selected' ? '/?rangeTour=tetons' : '/'));
      await page.locator('#titleSettings').evaluate(node => { node.open = true; });
      const lyrics = page.locator('#lyricGroundingBtn');
      if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
      await page.locator('#display-pixelGrid').selectOption('classic');
      if (row.id.startsWith('tour-')) {
        assert.equal(await page.locator('#range-tour-toggle').isChecked(), true, 'the Teton tour counts as tours on');
        if (row.id === 'tour-persisted') {
          // A clean load with no query honours the saved choice.
          assert.equal(new URL(page.url()).searchParams.has('rangeTour'), false);
          assert.equal(await page.evaluate(() => localStorage.getItem('range-tour')), 'tetons');
        }
      }
      row.entry = { url: page.url(), tourChecked: await page.locator('#range-tour-toggle').isChecked(),
        savedTour: await page.evaluate(() => localStorage.getItem('range-tour')),
        experience: await page.locator('#display-experience').inputValue() };
      for (const key of ['experience', 'rangeRenderer', 'rangeView', 'bulkExport']) {
        assert.equal(new URL(page.url()).searchParams.has(key), false, `ordinary route must not force ${key}`);
      }
      controls.setPhase('upload-and-prepare');
      await page.locator('#fileInput').setInputFiles(audioPath);
      // The ordinary route: the chooser opens once the song is ready and the
      // listener picks this route's world.
      await page.locator('#worldSelect[open]').waitFor({ timeout: timeoutMs });
      await page.locator(`.worldCard[data-base-world-id="${row.id === 'trio' ? 'trio' : 'alpine'}"] .worldCardPlayBtn`).click();
      await page.waitForFunction(() => {
        const s = window.__SMW;
        return s?.renderReadiness?.status === 'failed'
          || (s?.sim && !s.playbackPreparing && s.audioEngine?.playing && s.presentationDiagnostics?.frame?.presented)
          || (!document.getElementById('errorBanner')?.classList.contains('hidden')
            && document.getElementById('errorBanner')?.textContent.trim());
      }, null, { timeout: timeoutMs });
      const failure = await page.evaluate(() => ({ readiness: window.__SMW?.renderReadiness,
        range: window.__SMW?.sim?.biomes?.rangePresentation?.status(), banner: document.getElementById('errorBanner')?.textContent }));
      row.preparation = failure;
      assert.notEqual(failure.readiness?.status, 'failed', `ordinary playback preparation failed: ${JSON.stringify(failure)}`);
      controls.setPhase('live-playback');
      row.samples.push(await playbackSample(page));
      // A software renderer fails the hardware row here, with its own reason.
      if (configuration.hardwareRequired) verifyHardwareRoute(row, configuration.gpuMatch);
      assert.ok(row.samples[0].audioMs + 1000 < row.samples[0].bufferDurationMs,
        'recording ended before live observation; supply longer audio, not a timeout allowance');
      await page.waitForFunction(first => {
        const s = window.__SMW, frame = s?.presentationDiagnostics?.frame;
        return s?.audioEngine?.nowMs > first.audioMs + 1000
          && s.sim.timeMs > first.simMs && s.sim.heardTimeMs > first.heardMs
          && frame?.presented && frame.frameId > first.frame.frameId;
      }, row.samples[0], { timeout: timeoutMs });
      row.samples.push(await playbackSample(page));
      validateRoutePlayback(row.id, row.samples);
      if (configuration.hardwareRequired) verifyHardwareRoute(row, configuration.gpuMatch);
      await page.screenshot({ path: path.join(outDir, `${row.id}.png`) });
      assert.deepEqual(row.errors, [], 'browser diagnostics contain failures');
      assert.ok(accepting, 'late route completion cannot overwrite a timeout');
      row.status = 'passed';
    };
    let timer;
    try {
      await Promise.race([run(), new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true; accepting = false;
          // The owner closes a blocked page. Do not queue diagnostic evaluate
          // calls behind the same hung renderer that triggered the deadline.
          void context.close().catch(() => {});
          reject(new Error(`${row.id} exceeded ${timeoutMs} ms`));
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  } catch (error) {
    row.failure = error.stack || String(error);
    if (!timedOut && page && !page.isClosed()) {
      row.lastObserved = await bestEffort(page.evaluate(() => ({ range: window.__SMW?.sim?.biomes?.rangePresentation?.status(),
        readiness: window.__SMW?.renderReadiness, error: document.getElementById('errorBanner')?.textContent })), 2000);
      await page.screenshot({ path: path.join(outDir, `${row.id}-failure.png`), timeout: 10000 }).catch(() => {});
    }
  } finally {
    accepting = false;
    row.loadedFiles = [...(diagnostics?.loadedFiles ?? [])].sort();
    row.renderer = row.samples.find(sample => sample?.gpu)?.gpu ?? null;
    await context.close();
    await bestEffort(controls?.dispose(), 2000);
    if (row.status === 'passed' && row.errors.length) {
      row.status = 'failed'; row.failure = 'browser diagnostics reported a late failure';
    }
  }
}

export async function runCurrentRoutesSmoke({ siteRoot = path.join(root, '_site'), outDir = null, audioPath = null,
  timeoutMs = 180000, hardwareGpu = false, gpuMatch = null, browserPath = null } = {}) {
  const configuration = routeGateConfiguration({ hardwareGpu, gpuMatch, browserPath });
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000, 'invalid route timeout');
  outDir = path.resolve(outDir ?? path.join(root, '.smoke', `current-routes-${hardwareGpu ? 'hardware-gpu-' : ''}${Date.now()}`));
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir); // Never overwrite an earlier evidence run.
  const report = { version: 1, status: 'failed', configuration: { id: configuration.id, label: configuration.label,
    hardwareRequired: configuration.hardwareRequired, gpuMatch: configuration.gpuMatch, launchArgs: configuration.args,
    executablePath: configuration.executablePath ?? null, platform: process.platform, node: process.version }, routes: [], limitations: [
    'Headless Chromium integration evidence; no physical-device, performance or artistic acceptance.',
    'The default fixture is generated audio; it does not establish real-song tour coverage.',
    'The frozen server serves staged index.html/src bytes; optional soundfont discovery is empty.'
  ] };
  if (configuration.hardwareRequired) report.limitations.push(
    'Opt-in hardware GPU configuration: a separate result for this machine\'s GPU and driver. It neither replaces nor relabels the default SwiftShader gate.',
    'Trio draws through Canvas 2D and has no WebGL context of its own; its renderer is the browser probe taken before and after the routes.');
  let server, browser;
  try {
    const source = await snapshotSource(path.resolve(siteRoot));
    report.source = { ...checkoutIdentity(), siteRoot: path.resolve(siteRoot), digest: source.digest, hashes: source.hashes };
    if (!audioPath) {
      audioPath = path.join(outDir, 'fixture.wav');
      execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audioPath, '120', '120']);
      report.fixture = 'generated 120-second kick/hat/melody';
    } else { report.fixture = 'provided recording'; }
    audioPath = path.resolve(audioPath);
    report.audio = { file: audioPath, sha256: sha256(await fs.readFile(audioPath)) };
    server = await serveSnapshot(source);
    browser = await chromium.launch({ executablePath: configuration.executablePath, headless: true, args: configuration.args });
    report.browser = browser.version();
    console.log(`Configuration: ${configuration.id} (${configuration.args.join(' ')}); Chromium ${report.browser}`);
    const probe = report.configuration.browserProbe = configuration.hardwareRequired ? {} : undefined;
    if (probe) {
      probe.before = await probeBrowserRenderer(browser);
      console.log(`Actual renderer before routes: ${probe.before}`);
      requireRouteHardwareRenderer(probe.before, configuration.gpuMatch);
    }
    for (const id of CURRENT_ROUTES) {
      const row = { id, status: 'failed', errors: [], warnings: [], events: [], samples: [] };
      report.routes.push(row);
      console.log(`Current route: ${id}`);
      await exerciseRoute(browser, server.url, audioPath, row, timeoutMs, outDir, configuration);
      console.log(`${id}: ${row.status}${row.failure ? ' — ' + row.failure.split('\n')[0] : ''}`);
      await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    if (probe) {
      probe.after = await probeBrowserRenderer(browser);
      console.log(`Actual renderer after routes: ${probe.after}`);
    }
    report.configuration.renderers = [...new Set([probe?.before, ...report.routes.map(row => row.renderer), probe?.after]
      .filter(renderer => renderer != null))];
    report.source.changedDuringRun = (await snapshotSource(path.resolve(siteRoot))).digest !== source.digest;
    assert.equal(report.source.changedDuringRun, false, 'staged source changed during the run');
    report.status = summarizeConfiguredRun(report.routes, configuration, probe);
  } catch (error) { report.failure = error.stack || String(error); }
  finally {
    await browser?.close(); await server?.close();
    await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.status, 'passed', `current-route acceptance failed (${configuration.id}); see ${path.join(outDir, 'report.json')}`);
  return report;
}

export function parseCurrentRoutesArgs(argv) {
  const options = {};
  const names = { '--site-root': 'siteRoot', '--out': 'outDir', '--audio': 'audioPath', '--timeout-ms': 'timeoutMs',
    '--gpu-match': 'gpuMatch', '--browser': 'browserPath' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hardware-gpu') { options.hardwareGpu = true; continue; }
    const name = names[argv[i]], value = argv[i + 1];
    assert.ok(name && value && !value.startsWith('--'), `unknown or incomplete option ${argv[i]}`);
    options[name] = name === 'timeoutMs' ? Number(value) : value; i++;
  }
  assert.ok(!options.gpuMatch || options.hardwareGpu, '--gpu-match requires --hardware-gpu');
  return options;
}

// From WSL the hardware run crosses to native Windows Node and Chromium, as
// gpu-review.mjs does. The child writes report.json. Windows git cannot read
// this worktree, so launcher.json adds the WSL checkout identity and checks
// that the child served the same staged digest.
async function runOnWindows(options) {
  const node = process.env.MIDIO_WINDOWS_NODE || '/mnt/c/Program Files/nodejs/node.exe';
  const browserPath = options.browserPath || process.env.MIDIO_WINDOWS_CHROME;
  assert.ok(browserPath, 'a WSL hardware run needs a Windows Chromium executable: --browser or MIDIO_WINDOWS_CHROME');
  await fs.access(node);
  const siteRoot = path.resolve(options.siteRoot ?? path.join(root, '_site'));
  const outDir = path.resolve(options.outDir ?? path.join(root, '.smoke', `current-routes-hardware-gpu-${Date.now()}`));
  const launcher = { kind: 'wsl-to-native-windows', node: process.version, release: os.release(), windowsNode: node,
    checkout: checkoutIdentity(), stagedDigestBefore: (await snapshotSource(siteRoot)).digest };
  const args = ['--hardware-gpu', '--site-root', await toWindowsPath(siteRoot), '--out', await toWindowsPath(outDir),
    '--browser', await toWindowsPath(browserPath)];
  if (options.audioPath) args.push('--audio', await toWindowsPath(options.audioPath));
  if (options.timeoutMs !== undefined) args.push('--timeout-ms', String(options.timeoutMs));
  if (options.gpuMatch) args.push('--gpu-match', options.gpuMatch);
  launcher.windowsArgs = args;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-routes-windows-'));
  try {
    const loader = await writePlaywrightLoader(temp);
    launcher.exitCode = await runChild(node, ['--import', loader, await toWindowsPath(fileURLToPath(import.meta.url)), ...args], root);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  launcher.stagedDigestAfter = (await snapshotSource(siteRoot)).digest;
  const report = await fs.readFile(path.join(outDir, 'report.json'), 'utf8').then(JSON.parse, () => null);
  if (!report) { console.error(`the Windows run wrote no report under ${outDir}`); return launcher.exitCode || 1; }
  Object.assign(launcher, { reportStatus: report.status, reportDigest: report.source?.digest ?? null });
  launcher.sameStagedSource = launcher.reportDigest === launcher.stagedDigestBefore
    && launcher.stagedDigestAfter === launcher.stagedDigestBefore;
  await fs.writeFile(path.join(outDir, 'launcher.json'), JSON.stringify(launcher, null, 2) + '\n');
  if (!launcher.sameStagedSource) {
    console.error(`staged source differs between the WSL launcher and the Windows run; see ${path.join(outDir, 'launcher.json')}`);
    return launcher.exitCode || 1;
  }
  return launcher.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseCurrentRoutesArgs(process.argv.slice(2));
    if (options.hardwareGpu && isWsl()) process.exitCode = await runOnWindows(options);
    else await runCurrentRoutesSmoke(options);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
