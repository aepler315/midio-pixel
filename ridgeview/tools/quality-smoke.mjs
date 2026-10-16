// Real WebGL startup coverage; this does not judge rendered terrain quality.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from './serve.mjs';

const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
function pauseAtStartup() {
  // Pause through the app's existing test hook before its first frame.
  let rv;
  Object.defineProperty(window, '__rv', { configurable: true, get: () => rv, set: value => { rv = value; rv.paused = true; } });
}

const cases = [
  ...['low', 'medium', 'high', 'ultra'].map(value => ({ label: `URL ${value}`, url: value, expected: value })),
  { label: 'unknown URL', url: 'bogus', expected: 'high' },
  { label: 'uppercase URL', url: 'HIGH', expected: 'high' },
  { label: 'mixed-case stored', stored: 'MeDiUm', expected: 'medium' },
  { label: 'unknown stored', stored: 'bogus', expected: 'high' },
  { label: 'empty URL overrides stored low', url: '', stored: 'low', expected: 'high' },
  ...['constructor', '__proto__', 'toString'].map(value => ({ label: `prototype URL ${value}`, url: value, expected: 'high' })),
  { label: 'no stored value, desktop', expected: 'high' },
  { label: 'no stored value, small screen', screen: { width: 390, height: 844 }, expected: 'medium' },
];
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const entry of cases.filter(entry => !process.env.RIDGEVIEW_QUALITY_FILTER || new RegExp(process.env.RIDGEVIEW_QUALITY_FILTER).test(entry.label))) {
    const context = await browser.newContext({ viewport: { width: 800, height: 450 }, screen: entry.screen ?? { width: 1280, height: 800 } });
    await context.addInitScript(pauseAtStartup);
    await context.addInitScript(value => {
      localStorage.clear();
      if (value !== undefined) localStorage.setItem('rv-quality', value);
    }, entry.stored);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(origin) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    try {
      const params = new URLSearchParams({ test: '1', instant: '1' });
      if (entry.url !== undefined) params.set('quality', entry.url);
      await page.goto(`${origin}/?${params}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => window.__rv || document.querySelector('#ui h2'), null, { timeout: 60000, polling: 100 });
      const actual = await page.evaluate(() => {
        const rv = window.__rv;
        if (!rv) throw new Error('Ridgeview did not initialize');
        rv.paused = true;
        const e = rv.engine;
        return { quality: e.tiles.qualityName, shadowSize: e.shadows.size, micro: e.globals.uMicro.value,
          treeFar: e.tiles.q.treeFar, enabled: e.trees.enabled, webgl: e.renderer.getContext() instanceof WebGL2RenderingContext };
      });
      const settings = { low: [1024, 0, 0], medium: [2048, 1, 800], high: [2048, 1, 1400], ultra: [4096, 1, 2200] }[entry.expected];
      assert.deepEqual(actual, { quality: entry.expected, shadowSize: settings[0], micro: settings[1],
        treeFar: settings[2], enabled: settings[2] > 0, webgl: true }, entry.label);
      assert.deepEqual(errors, [], entry.label);
      console.log(`PASS ${entry.label} ${JSON.stringify(actual)}`);
    } catch (error) {
      throw new Error(`${entry.label}: ${error.message}; page errors: ${errors.join('; ')}`, { cause: error });
    } finally { await context.close(); }
  }
  // Direct constructor and setters use the same resolver as the URL entry.
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  await page.addInitScript(pauseAtStartup);
  await page.goto(`${origin}/?test=1&quality=low`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__rv, null, { timeout: 60000, polling: 100 });
  const direct = await page.evaluate(async () => {
    window.__rv.paused = true;
    const { Engine } = await import('/src/engine/Engine.js');
    const values = ['low', 'medium', 'high', 'ultra', 'bogus', 'HIGH', '', 'constructor', '__proto__', undefined];
    const results = [];
    for (const value of values) {
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const e = new Engine(canvas, { quality: value });
      results.push({ value: value ?? null, quality: e.tiles.qualityName, shadowSize: e.shadows.size });
      for (const input of values) {
        e.setQuality(input);
        const expected = ['low', 'medium', 'high', 'ultra'].includes(input?.toLowerCase()) ? input.toLowerCase() : 'high';
        if (e.tiles.qualityName !== expected || e.shadows.size !== e.tiles.q.shadowSize) throw new Error(`setter ${input}`);
      }
      for (const worker of e.tiles.workers) worker.terminate();
      e.renderer.dispose(); e.renderer.forceContextLoss(); canvas.remove();
    }
    return results;
  });
  for (const row of direct) {
    const expected = ['low', 'medium', 'high', 'ultra'].includes(row.value?.toLowerCase()) ? row.value.toLowerCase() : 'high';
    assert.equal(row.quality, expected);
    assert.equal(row.shadowSize, { low: 1024, medium: 2048, high: 2048, ultra: 4096 }[expected]);
  }
  console.log(`PASS direct constructors and setters ${JSON.stringify(direct)}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
