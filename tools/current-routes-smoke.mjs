// Ordinary upload/play routes against a frozen copy of the staged public tree.
// No bulkExport, forced renderer, forced world, or synthetic playback bus.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { attachBrowserDiagnostics } from './lib/browser-diagnostics.mjs';
import { CURRENT_ROUTES, validateRoutePlayback, summarizeRouteRun } from './lib/current-route-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkoutIdentity() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=normal') };
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

async function exerciseRoute(browser, url, audioPath, row, timeoutMs, outDir) {
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
      await page.goto(url + '/');
      await page.locator('#titleSettings').evaluate(node => { node.open = true; });
      const lyrics = page.locator('#lyricGroundingBtn');
      if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
      await page.locator('#display-pixelGrid').selectOption('classic');
      if (row.id.startsWith('tour-')) {
        await page.locator('#range-tour-toggle').check();
        assert.equal(await page.evaluate(() => localStorage.getItem('range-tour')), 'tetons');
        if (row.id === 'tour-persisted') {
          controls.setPhase('persisted-reload');
          // The actual UI wrote the preference. Reload cleanly, without the
          // query override that the toggle adds, and keep this same profile.
          await page.goto(url + '/');
          await page.locator('#titleSettings').evaluate(node => { node.open = true; });
          assert.equal(await page.locator('#range-tour-toggle').isChecked(), true);
          assert.equal(new URL(page.url()).searchParams.has('rangeTour'), false);
        }
      } else if (row.id === 'trio') {
        await page.locator('#display-experience').selectOption('trio');
      }
      row.entry = { url: page.url(), tourChecked: await page.locator('#range-tour-toggle').isChecked(),
        savedTour: await page.evaluate(() => localStorage.getItem('range-tour')),
        experience: await page.locator('#display-experience').inputValue() };
      for (const key of ['worlds', 'rangeRenderer', 'rangeView', 'bulkExport']) {
        assert.equal(new URL(page.url()).searchParams.has(key), false, `ordinary route must not force ${key}`);
      }
      controls.setPhase('upload-and-prepare');
      await page.locator('#fileInput').setInputFiles(audioPath);
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
    await context.close();
    await bestEffort(controls?.dispose(), 2000);
    if (row.status === 'passed' && row.errors.length) {
      row.status = 'failed'; row.failure = 'browser diagnostics reported a late failure';
    }
  }
}

export async function runCurrentRoutesSmoke({ siteRoot = path.join(root, '_site'),
  outDir = path.join(root, '.smoke', `current-routes-${Date.now()}`), audioPath = null, timeoutMs = 180000 } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000, 'invalid route timeout');
  outDir = path.resolve(outDir);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir); // Never overwrite an earlier evidence run.
  const report = { version: 1, status: 'failed', routes: [], limitations: [
    'Headless Chromium integration evidence; no physical-device, performance or artistic acceptance.',
    'The default fixture is generated audio; it does not establish real-song tour coverage.',
    'The frozen server serves staged index.html/src bytes; optional soundfont discovery is empty.'
  ] };
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
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      headless: true, args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    report.browser = browser.version();
    for (const id of CURRENT_ROUTES) {
      const row = { id, status: 'failed', errors: [], warnings: [], events: [], samples: [] };
      report.routes.push(row);
      console.log(`Current route: ${id}`);
      await exerciseRoute(browser, server.url, audioPath, row, timeoutMs, outDir);
      console.log(`${id}: ${row.status}${row.failure ? ' — ' + row.failure.split('\n')[0] : ''}`);
      await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    report.source.changedDuringRun = (await snapshotSource(path.resolve(siteRoot))).digest !== source.digest;
    assert.equal(report.source.changedDuringRun, false, 'staged source changed during the run');
    report.status = summarizeRouteRun(report.routes);
  } catch (error) { report.failure = error.stack || String(error); }
  finally {
    await browser?.close(); await server?.close();
    await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.status, 'passed', `current-route acceptance failed; see ${path.join(outDir, 'report.json')}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  const names = { '--site-root': 'siteRoot', '--out': 'outDir', '--audio': 'audioPath', '--timeout-ms': 'timeoutMs' };
  try {
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(names[args[i]] && args[i + 1], `unknown or incomplete option ${args[i]}`);
      options[names[args[i]]] = args[i] === '--timeout-ms' ? Number(args[i + 1]) : args[i + 1];
    }
    await runCurrentRoutesSmoke(options);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
