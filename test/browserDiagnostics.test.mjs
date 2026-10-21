import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openEvaluationSong } from '../tools/lib/visual-evaluation-browser.mjs';
import { attachBrowserDiagnostics, finalizeBrowserDiagnostics } from '../tools/lib/browser-diagnostics.mjs';
import { parseReviewArgs, runLandscapeReview } from '../tools/landscape-review.mjs';

// Stop before the application upload so this test exercises the real browser
// diagnostic listeners without substituting audio analysis or rendering.
class StartupPage extends EventEmitter {
  constructor(message) { super(); this.message = message; }
  setDefaultTimeout() {}
  async exposeBinding() {}
  async addInitScript() {}
  frames() { return []; }
  isClosed() { return false; }
  async goto() {
    this.emit('console', { type: () => 'warning', text: () => this.message });
    throw new Error('test stopped before upload');
  }
}

for (const message of [
  'WebGL: INVALID_VALUE: uniform1f: location is not from the associated program',
  'WebGL: INVALID_OPERATION: drawElements: no valid shader program in use',
  'GL_INVALID_VALUE: glTexStorage2D: One or more image dimensions are not positive.',
  'GL_INVALID_OPERATION: glFramebufferTexture2D: Texture is not a valid texture object.',
  'THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false',
  'WebGL: useProgram: program not valid',
  'WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost',
]) test(`visual evaluation rejects warning: ${message}`, async () => {
  const page = new StartupPage(message);
  const context = { addInitScript: async () => {}, route: async () => {}, newPage: async () => page, close: async () => {} };
  const diagnostics = { errors: [], warnings: [], loadedFiles: new Set() };
  await assert.rejects(openEvaluationSong({ newContext: async () => context }, {
    url: 'http://127.0.0.1:8080', audioPath: 'unused.wav', settings: { width: 640, height: 360, seed: 315 }, diagnostics,
  }), /test stopped before upload/);
  assert.deepEqual(diagnostics.errors, [message], 'critical graphics warnings must fail the existing acceptance gate');
  assert.deepEqual(diagnostics.warnings, [message], 'retain the original warning alongside the fatal classification');
  assert.deepEqual(diagnostics.events, [{ source: 'console', message, severity: 'warning', phase: 'startup', fatal: true }]);
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
test('native canvas context loss fails acceptance without a console warning', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 20000,
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  try {
    const page = await browser.newPage(), diagnostics = {};
    const capture = await attachBrowserDiagnostics(page, diagnostics, { phase: 'render' });
    await page.goto('data:text/html,<canvas id="stage"></canvas>');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl');
      const lose = gl?.getExtension('WEBGL_lose_context');
      if (!lose) { reject(new Error('test requires WEBGL_lose_context')); return; }
      canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); resolve(); }, { once: true });
      lose.loseContext();
    }));
    const losses = diagnostics.events.filter(event => event.source === 'webglcontextlost');
    assert.equal(losses.length, 1, 'a native loss must be recorded even if the browser logs nothing');
    assert.deepEqual({ message: losses[0].message, severity: losses[0].severity, phase: losses[0].phase, fatal: losses[0].fatal },
      { message: 'WebGL context lost', severity: 'error', phase: 'render', fatal: true });
    assert.ok(diagnostics.errors.includes('WebGL context lost'));
    await capture.dispose();
    const count = diagnostics.events.length;
    await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost')));
    assert.equal(diagnostics.events.length, count, 'disposed native listeners cannot append stale events');
  } finally { await browser.close(); }
});

test('a detached WebGL canvas reports native context loss without needing a window event path', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 20000,
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  try {
    const page = await browser.newPage(), diagnostics = {};
    const capture = await attachBrowserDiagnostics(page, diagnostics, { phase: 'detached-terrain' });
    await page.goto('data:text/html,detached terrain renderer');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const lose = gl?.getExtension('WEBGL_lose_context');
      if (!lose) { reject(new Error('test requires WEBGL_lose_context')); return; }
      // RangeScene owns a detached renderer canvas. Its event does not travel
      // through window, and context loss must not depend on Three's logging.
      canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); resolve(); }, { once: true });
      lose.loseContext();
    }));
    const losses = diagnostics.events.filter(event => event.source === 'webglcontextlost');
    assert.equal(losses.length, 1, 'detached terrain contexts must reach the same fatal diagnostic gate');
    assert.equal(losses[0].phase, 'detached-terrain');
    assert.equal(losses[0].fatal, true);
    assert.ok(diagnostics.errors.includes('WebGL context lost'));
    await capture.dispose();
  } finally { await browser.close(); }
});

test('browser diagnostics retain ordinary warnings, original severity, phases, and stop after disposal', async () => {
  const page = new StartupPage('unused'), diagnostics = {};
  const capture = await attachBrowserDiagnostics(page, diagnostics);
  page.emit('console', { type: () => 'warning', text: () => 'AudioContext resumed after a user gesture' });
  capture.setPhase('playback');
  page.emit('console', { type: () => 'error', text: () => 'uncaught playback failure' });
  await capture.dispose();
  page.emit('console', { type: () => 'warning', text: () => 'WebGL: INVALID_OPERATION: after disposal' });
  assert.deepEqual(diagnostics.errors, ['uncaught playback failure']);
  assert.deepEqual(diagnostics.warnings, ['AudioContext resumed after a user gesture']);
  assert.deepEqual(diagnostics.events, [
    { source: 'console', message: 'AudioContext resumed after a user gesture', severity: 'warning', phase: 'startup', fatal: false },
    { source: 'console', message: 'uncaught playback failure', severity: 'error', phase: 'playback', fatal: true },
  ]);
});

test('shader compile and program link failures are fatal even when logged below error severity', async () => {
  const page = new StartupPage('unused'), diagnostics = {};
  await attachBrowserDiagnostics(page, diagnostics, { phase: 'render' });
  const messages = ['Failed to compile fragment shader', 'shader compilation failed', 'invalid program', 'program link failed'];
  for (const message of messages) page.emit('console', { type: () => 'warning', text: () => message });
  assert.deepEqual(diagnostics.errors, messages);
  assert.deepEqual(diagnostics.warnings, messages);
  assert.ok(diagnostics.events.every(event => event.fatal && event.severity === 'warning' && event.phase === 'render'));
});

test('an unrelated context warning is retained without being classified as WebGL loss', async () => {
  const page = new StartupPage('unused'), diagnostics = {};
  await attachBrowserDiagnostics(page, diagnostics);
  page.emit('console', { type: () => 'warning', text: () => 'Audio context lost its device connection; waiting for a new device' });
  assert.deepEqual(diagnostics.errors, []);
  assert.equal(diagnostics.warnings.length, 1);
  assert.equal(diagnostics.events[0].fatal, false);
});

test('a boolean request expectation retains the original failure description', async () => {
  const page = new StartupPage('unused'), diagnostics = {};
  await attachBrowserDiagnostics(page, diagnostics, { isExpectedRequestFailure: () => true });
  page.emit('requestfailed', { url: () => 'http://127.0.0.1:8080/superseded.bin', failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
  assert.deepEqual(diagnostics.errors, []);
  assert.deepEqual(diagnostics.warnings, ['request failed /superseded.bin: net::ERR_ABORTED']);
  assert.equal(diagnostics.events[0].message, 'request failed /superseded.bin: net::ERR_ABORTED');
});

test('network and page failures share phase diagnostics and narrowly retain expected request cancellations', async () => {
  const page = new StartupPage('unused'), diagnostics = { loadedFiles: new Set() };
  const capture = await attachBrowserDiagnostics(page, diagnostics, {
    origin: 'http://127.0.0.1:8080', phase: 'analysis',
    isExpectedRequestFailure: request => request.url() === 'http://127.0.0.1:8080/src/assets/range/v2/superseded.bin'
      && request.failure()?.errorText === 'net::ERR_ABORTED' && 'cancelled tour preparation request /src/assets/range/v2/superseded.bin',
  });
  page.emit('response', { url: () => 'http://127.0.0.1:8080/src/main.js', status: () => 200 });
  page.emit('response', { url: () => 'http://127.0.0.1:8080/src/missing.js', status: () => 404 });
  page.emit('response', { url: () => 'https://example.org/unrelated.js', status: () => 503 });
  const fail = (url, errorText) => page.emit('requestfailed', { url: () => url, failure: () => ({ errorText }) });
  fail('http://127.0.0.1:8080/src/assets/range/v2/superseded.bin', 'net::ERR_ABORTED');
  fail('http://127.0.0.1:8080/src/main.js', 'net::ERR_ABORTED');
  capture.setPhase('playback');
  page.emit('pageerror', new Error('renderer crashed'));
  assert.deepEqual([...diagnostics.loadedFiles], ['/src/main.js', '/src/missing.js']);
  assert.deepEqual(diagnostics.errors, ['HTTP 404 /src/missing.js', 'request failed /src/main.js: net::ERR_ABORTED', 'renderer crashed']);
  assert.deepEqual(diagnostics.warnings, ['cancelled tour preparation request /src/assets/range/v2/superseded.bin']);
  assert.deepEqual(diagnostics.events.map(({ source, phase, severity, fatal, expected }) => ({ source, phase, severity, fatal, expected })), [
    { source: 'response', phase: 'analysis', severity: 'error', fatal: true, expected: undefined },
    { source: 'requestfailed', phase: 'analysis', severity: 'warning', fatal: false, expected: true },
    { source: 'requestfailed', phase: 'analysis', severity: 'error', fatal: true, expected: undefined },
    { source: 'pageerror', phase: 'playback', severity: 'error', fatal: true, expected: undefined },
  ]);
  await capture.dispose();
  page.emit('pageerror', new Error('after disposal'));
  assert.equal(diagnostics.events.length, 4);
});

test('a landscape startup failure retains structured diagnostics in its failed grid report', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'landscape-startup-diagnostics-'));
  try {
    const source = path.join(dir, 'source'), out = path.join(dir, 'review'), audio = path.join(dir, 'input.wav');
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await fs.writeFile(path.join(source, 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(source, 'src', 'main.js'), '');
    await fs.writeFile(audio, 'not decoded because startup stops before upload');
    const message = 'WebGL: INVALID_OPERATION: drawArrays: no valid shader program in use', page = new StartupPage(message);
    const context = { addInitScript: async () => {}, route: async () => {}, newPage: async () => page, close: async () => {} };
    const browser = { newContext: async () => context, version: () => 'test-browser', close: async () => {} };
    await assert.rejects(runLandscapeReview(parseReviewArgs(['--out', out, '--source', source, '--audio', audio, '--grid', 'classic']), {
      launch: async () => browser, signals: new EventEmitter(),
    }), /test stopped before upload/);
    const reportPath = path.join(out, 'classic', 'report.json');
    assert.equal(existsSync(reportPath), true, 'failure must keep its diagnostic report even before audio loads');
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.songs[0].errors, [message]);
    assert.deepEqual(report.songs[0].events, [{ source: 'console', message, severity: 'warning', phase: 'startup', fatal: true }]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('only aborted same-origin tour preparation requests stay warnings in visual evaluation', async () => {
  for (const { tour, url, errorText, expected } of [
    { tour: 'tetons', url: 'http://127.0.0.1:8080/src/assets/range/v2/old.bin', errorText: 'net::ERR_ABORTED', expected: true },
    { tour: undefined, url: 'http://127.0.0.1:8080/src/assets/range/v2/old.bin', errorText: 'net::ERR_ABORTED', expected: false },
    { tour: 'tetons', url: 'http://127.0.0.1:8080/src/main.js', errorText: 'net::ERR_ABORTED', expected: false },
    { tour: 'tetons', url: 'http://127.0.0.1:8080/src/assets/range/v2/active.bin', errorText: 'net::ERR_FAILED', expected: false },
  ]) {
    const page = new StartupPage('unused');
    page.goto = async () => { page.emit('requestfailed', { url: () => url, failure: () => ({ errorText }) }); throw new Error('test stopped before upload'); };
    const context = { addInitScript: async () => {}, route: async () => {}, newPage: async () => page, close: async () => {} }, diagnostics = {};
    await assert.rejects(openEvaluationSong({ newContext: async () => context }, {
      url: 'http://127.0.0.1:8080', audioPath: 'unused.wav', settings: { tour, width: 640, height: 360, seed: 315 }, diagnostics,
    }), /test stopped before upload/);
    assert.equal(diagnostics.errors.length, expected ? 0 : 1);
    assert.equal(diagnostics.warnings.length, expected ? 1 : 0);
    assert.equal(diagnostics.events[0].fatal, !expected);
  }
});

test('a fatal diagnostic emitted during context close downgrades the final saved result', async () => {
  const page = new StartupPage('unused'), diagnostics = {}, report = { status: 'passed' };
  const capture = await attachBrowserDiagnostics(page, diagnostics, { phase: 'capture:12000ms' });
  const context = { close: async () => page.emit('console', {
    type: () => 'warning', text: () => 'GL_INVALID_OPERATION: late draw failure during context close',
  }) };
  await context.close();
  await capture.dispose();
  assert.throws(() => finalizeBrowserDiagnostics(diagnostics, report), /Browser diagnostics failed/);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /GL_INVALID_OPERATION: late draw failure during context close/);
  assert.deepEqual(diagnostics.events, [{ source: 'console', message: 'GL_INVALID_OPERATION: late draw failure during context close',
    severity: 'warning', phase: 'capture:12000ms', fatal: true }]);
});

test('late diagnostics preserve an earlier failure while invalidating a boolean acceptance result', async () => {
  const page = new StartupPage('unused'), diagnostics = {}, report = { passed: true, error: 'original analysis failure' };
  const capture = await attachBrowserDiagnostics(page, diagnostics);
  const original = new Error('original analysis failure');
  const run = async () => {
    try { throw original; }
    finally {
      page.emit('console', { type: () => 'warning', text: () => 'GL_INVALID_VALUE: teardown failure' });
      await capture.dispose();
      finalizeBrowserDiagnostics(diagnostics, report, { preserveFailure: true });
    }
  };
  await assert.rejects(run(), error => error === original, 'teardown diagnostics must not replace the original failure');
  assert.equal(report.passed, false);
  assert.equal(report.error, 'original analysis failure');
});
