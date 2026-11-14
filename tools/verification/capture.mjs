// Small production-path corpus. Does not approve or replace references.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { normalizeManifest, blankFrame } from '../lib/visual-evaluation.mjs';
import { snapshotSource, serveSnapshot } from '../lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from '../lib/visual-evaluation-browser.mjs';
import { finalizeBrowserDiagnostics } from '../lib/browser-diagnostics.mjs';
import { hash, readJson, writeJson, argumentsOf, gitState, newDirectory } from './io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = argumentsOf(process.argv.slice(2), ['--out', '--source', '--scenarios']);
assert.ok(args.out, 'Usage: npm run verify:visual:capture -- --out NEW_DIR [--source CHECKOUT] [--scenarios JSON]');
const out = path.resolve(args.out), source = path.resolve(args.source || root);
const corpus = await readJson(path.resolve(args.scenarios || path.join(root, 'tools/verification/scenarios.json')));
assert.equal(corpus.version, 1); assert.ok(corpus.scenarios.length > 0 && corpus.scenarios.length <= 12);
assert.equal(new Set(corpus.scenarios.map(s => s.id)).size, corpus.scenarios.length);
await newDirectory(out);
const report = { version: 1, status: 'failed', controlsHash: hash(corpus), corpus, frames: [], source: gitState(source),
  scope: 'Fixed-clock software WebGL export; technical references, no artistic, live-motion, GPU-time or JOYING certification.' };
let server, browser;
try {
  const snapshot = await snapshotSource(source); report.source.digest = snapshot.digest;
  server = await serveSnapshot(snapshot);
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  report.browserVersion = browser.version(); report.browser = `chromium-${browser.version().split('.')[0]}`;
  // Pin decoding as well as generated WAV rate: browser defaults vary by host.
  const make = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const c = await make(options);
    await c.addInitScript(rate => { const Native = window.AudioContext; window.AudioContext = class extends Native { constructor(options = {}) { super({ ...options, sampleRate: rate }); } }; }, corpus.fixture.sampleRate);
    return c;
  };
  const audioPath = path.join(out, 'fixture.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), audioPath, String(corpus.fixture.seconds)], { stdio: 'pipe' });
  report.audioSha256 = hash(await fs.readFile(audioPath));
  // Include fixture bytes and harness bytes: a generator/tool change needs review too.
  report.controlsHash = hash({ corpus, audio: report.audioSha256,
    capture: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    browserHarness: hash(await fs.readFile(path.join(root, 'tools/lib/visual-evaluation-browser.mjs'))) });
  for (const scenario of corpus.scenarios) {
    assert.match(scenario.id, /^[a-z0-9-]+$/);
    const settings = normalizeManifest({ version: 1, settings: { ...corpus.settings, quality: scenario.quality ?? corpus.settings.quality,
      ...(scenario.debug ? { debug: scenario.debug } : {}), presentation: { version: 2, look: 'cinematic', quality: 'auto',
        pixelGrid: scenario.grid, pixelScale: 'original', scaling: 'fit', buildPixelDetail: false } }, songs: [{ id: 'fixture', fixture: 'contrast' }] }).settings;
    const diagnostics = { errors: [], warnings: [], events: [], loadedFiles: new Set() };
    const started = performance.now();
    const loaded = await openEvaluationSong(browser, { url: server.url, audioPath, settings, diagnostics });
    const initializationMs = performance.now() - started;
    let failed = false;
    try {
      if (report.renderer) assert.equal(loaded.environment.gl, report.renderer);
      report.renderer = loaded.environment.gl;
      for (const timeMs of scenario.timesMs) {
        loaded.browserDiagnostics.setPhase(`verification:${scenario.id}:${timeMs}`);
        const before = performance.now();
        const frame = await renderEvaluationFrame(loaded.page, { timeMs, save: true, checkpoint: scenario.id, clips: [] }, settings);
        const exportWallMs = performance.now() - before;
        assert.equal(blankFrame(frame.thumbnail), false, `blank ${scenario.id}:${timeMs}`);
        assert.equal(frame.presentation.effectiveLook, 'cinematic');
        assert.equal(frame.presentation.effectiveGrid.id, scenario.grid);
        const id = `${scenario.id}-${timeMs}`, bytes = Buffer.from(frame.pngData, 'base64'); delete frame.pngData; delete frame.thumbnail;
        const png = `${id}.png`; await fs.writeFile(path.join(out, png), bytes);
        report.frames.push({ id, png, sha256: hash(bytes), width: frame.output.width, height: frame.output.height,
          scenario, settings, initializationMs, exportWallMs, state: frame });
        console.log(`Captured ${id} (${exportWallMs.toFixed(0)} ms fixed-export wall time)`);
        await writeJson(path.join(out, 'report.json'), report);
      }
      finalizeBrowserDiagnostics(diagnostics, { status: 'passed' });
    } catch (error) { failed = true; throw error; }
    finally {
      report.diagnostics ??= []; report.diagnostics.push({ id: scenario.id, failed, errors: diagnostics.errors, warnings: diagnostics.warnings });
      await loaded.context.close(); await loaded.browserDiagnostics.dispose();
    }
  }
  assert.equal((await snapshotSource(source)).digest, snapshot.digest, 'source changed during capture');
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  await browser?.close(); await server?.close();
  await writeJson(path.join(out, 'report.json'), report);
  await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Verification corpus</title><style>body{background:#172331;color:#fff;font:16px sans-serif}figure{display:inline-block}img{width:640px;image-rendering:pixelated}</style>' + report.frames.map(f => `<figure><figcaption>${f.id}</figcaption><img src="${f.png}"></figure>`).join(''));
}
