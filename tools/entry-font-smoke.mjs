// Browser entry/font lifecycle checks, sequential to avoid competing renderers.
// Synthetic PCM uses the real file/URL decoder; no device/listening claim.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { buildMinimalSf2 } from '../test/helpers/sf2Fixture.js';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[3] || '.smoke/master-implementation/WP18-browser');
const url = process.argv[2] || 'http://127.0.0.1:4218';
await mkdir(out, { recursive: true });
const fixture = resolve(out, 'fixture.wav');
execFileSync(process.execPath, ['tools/gen-test-wav.mjs', fixture, '120', '16'], { cwd: root });
const pcm = await readFile(fixture);
const font = Buffer.from(buildMinimalSf2('ExplicitFont'));
const server = process.argv[2] ? null : spawn(process.execPath, ['tools/serve.js', '4218'], {
  cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PORT: '4218', HOST: '127.0.0.1' },
});
const report = { cases: [], errors: [], passed: false };
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(url); await response.body?.cancel(); if (response.ok) break; }
    catch { /* development server is starting */ }
    if (attempt > 100) throw new Error('App unavailable at ' + url);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: ['--enable-automation'], executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium' });
  const cdp = await browser.newBrowserCDPSession();
  report.launchArguments = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
  await cdp.detach();
  async function open(mode) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.addInitScript(() => {
      const NativeAudioContext = window.AudioContext;
      window.__entryContexts = 0;
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) { super(...args); window.__entryContexts++; }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const requests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/soundfonts/')) requests.push(request.url());
    });
    page.on('pageerror', error => report.errors.push(`${mode}: ${error.message}`));
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    await page.route('**/wp18-fixture.wav', route => route.fulfill({ body: pcm, contentType: 'audio/wav' }));
    await page.route('**/soundfonts/', route => route.fulfill({ json: ['wp18-fixture.sf2'] }));
    await page.route('**/soundfonts/wp18-fixture.sf2', route => route.fulfill({ body: font, contentType: 'application/octet-stream' }));
    const entry = new URL(url);
    // Audio/copy checks use the supported Canvas fallback; no heavy v2
    // renderer or visual/performance acceptance is attempted here.
    entry.searchParams.set('rangeRenderer', 'legacy');
    // The chooser opens per song unless the page already names a world.
    if (mode === 'direct') entry.searchParams.set('experience', 'landscape');
    await page.goto(entry.href);
    await page.locator('#browseBtn').waitFor();
    if (!report.graphicsProbe) report.graphicsProbe = await page.evaluate(async () => {
      const { resolveRangeMode } = await import('/src/world/alpine/RangePresentation.js');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { classification: 'unavailable', defaultRangeMode: resolveRangeMode('').mode };
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const result = { defaultRangeMode: resolveRangeMode('').mode,
        unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: debug ? renderer : null, version: gl.getParameter(gl.VERSION),
        renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR),
        timerQueryWebGL2: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
        timerQueryWebGL1: !!gl.getExtension('EXT_disjoint_timer_query'),
        classification: /swiftshader|llvmpipe|softpipe|software/i.test(renderer) ? 'software' : 'unclassified' };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return result;
    });
    assert.equal(await page.locator('#titleWorld').count(), 0, 'the world is chosen in the chooser, not on the title screen');
    await page.locator('#titleSettings > summary').click();
    if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
    await page.locator('#display-pixelGrid').selectOption('classic');
    await page.locator('#titleSettings > summary').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(out, `${mode}-title.png`) });
    return { page, context, requests, mode };
  }
  async function chooseAndWait(h) {
    if (h.mode === 'picker') {
      await h.page.locator('#worldSelect:not(.hidden)').waitFor();
      assert.equal(await h.page.locator('.worldCard').count(), 2);
      const card = h.page.locator('.worldCard[data-base-world-id="alpine"]');
      await card.focus(); await card.press('Enter');
    }
    await h.page.waitForFunction(() => window.__SMW && window.__SMW !== window.__entryPreviousOwner
      && window.__SMW.sim?.timeMs > 250 && document.getElementById('loader').classList.contains('hidden'));
    assert.equal(await h.page.locator('#worldSelect').isVisible(), false);
  }
  async function sample(h) {
    await h.page.evaluate(() => { window.__entryPreviousOwner = window.__SMW || null; });
    await h.page.locator('#demoBtn').focus(); await h.page.locator('#demoBtn').press('Enter');
    await chooseAndWait(h);
  }
  async function dropRecording(h) {
    await h.page.evaluate(encoded => {
      window.__entryPreviousOwner = window.__SMW || null;
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'wp18-fixture.wav', { type: 'audio/wav' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, pcm.toString('base64'));
    await chooseAndWait(h);
  }
  async function stop(h) {
    // Native keyboard activation also works while the HUD pointer targets
    // have faded; avoid treating that documented auto-hide as a dead control.
    await h.page.locator('#stopBtn').focus();
    await h.page.locator('#stopBtn').press('Enter');
    await h.page.locator('#loader:not(.hidden)').waitFor();
    await h.page.waitForFunction(() => window.__SMW.synth.fallback._voices.size === 0);
  }
  async function snapshot(h) {
    return h.page.evaluate(() => {
      const smw = window.__SMW;
      return { contexts: window.__entryContexts, worldId: smw.worldId, worldKind: smw.sim.biomes.world.kind, rangeRenderer: smw.rangeRenderer,
        muted: smw.muteTimelineSynth, enabled: smw.synth.enabled,
        fallback: smw.synth.current === smw.synth.fallback, voices: smw.synth.fallback._voices.size,
        hasRecording: !!smw.audioEngine.sourceNode?.buffer,
        originalBuffer: !!smw.audioBuffer && smw.audioEngine.sourceNode?.buffer === smw.audioBuffer,
        sf2: !!smw.sf2Engine, fonts: !!smw.fontLibrary, audioState: smw.audioEngine.ctx.state };
    });
  }
  for (const mode of ['picker', 'direct']) for (const source of ['sample', 'local', 'url']) {
    console.log(`START ${mode}/${source}`);
    const h = await open(mode);
    const record = { mode, source, fontRequests: h.requests, passed: false };
    report.cases.push(record);
    try {
      if (source === 'sample') await sample(h);
      if (source === 'local') {
        const ready = h.page.waitForEvent('filechooser');
        await h.page.locator('#browseBtn').click(); await (await ready).setFiles(fixture);
        await chooseAndWait(h);
      }
      if (source === 'url') {
        await h.page.locator('#urlLoadOpenBtn').click();
        await h.page.locator('#urlLoadInput').fill(new URL('/wp18-fixture.wav', url).href);
        await h.page.locator('#urlLoadInput').press('Enter');
        await chooseAndWait(h);
      }
      const initial = await snapshot(h); record.initial = initial;
      assert.equal(initial.contexts, 1); assert.equal(initial.worldKind, 'alpine', 'the song-tailored Range retains its alpine contract');
      assert.equal(initial.rangeRenderer, 'legacy', 'audio regression uses the supported fallback');
      assert.equal(report.graphicsProbe.defaultRangeMode, 'v2', 'default product mode remains v2');
      assert.equal(initial.sf2, false); assert.equal(initial.fonts, false);
      assert.equal(initial.fallback, true); assert.equal(initial.audioState, 'running');
      assert.equal(initial.muted, source !== 'sample'); assert.equal(initial.enabled, source === 'sample');
      if (source === 'sample') assert.ok(initial.voices > 0, 'the sample has live fallback voices');
      else assert.equal(initial.originalBuffer, true, 'the decoded original is the playing buffer');
      assert.equal(h.requests.length, 0, 'fresh source load performs zero font requests');
      await h.page.evaluate(() => { window.__entryOriginalBuffer = window.__SMW.audioBuffer; window.__entryEngine = window.__SMW.audioEngine; window.__SMW.seek(1000); });
      await h.page.waitForFunction(() => window.__SMW.sim.timeMs > 1100);
      const sought = await snapshot(h); record.sought = sought;
      assert.equal(sought.contexts, 1);
      assert.equal(await h.page.evaluate(() => window.__SMW.audioEngine === window.__entryEngine), true);
      if (source !== 'sample') assert.equal(await h.page.evaluate(() => window.__SMW.audioEngine.sourceNode.buffer === window.__entryOriginalBuffer), true);
      if (source === 'sample') {
        await stop(h); await sample(h);
        assert.equal((await snapshot(h)).contexts, 1, 'title/restart reuses the audio unlock');
        await dropRecording(h);
        const switched = await snapshot(h); record.switched = switched;
        assert.equal(switched.muted, true); assert.equal(switched.enabled, false);
        assert.equal(switched.originalBuffer, true);
        await h.page.waitForFunction(() => window.__SMW.synth.fallback._voices.size === 0);
      }
      assert.equal(h.requests.length, 0, 'seek/title/repeated unlock/switching needs no SoundFonts');
      await stop(h);
      assert.equal(await h.page.locator('#errorBanner').isVisible(), false);
      record.passed = true;
      console.log(`PASS ${mode}/${source}`);
    } finally { await h.context.close(); }
  }
  console.log('START explicit optional font consumer');
  const h = await open('default');
  try {
    await sample(h); assert.equal(h.requests.length, 0);
    const optional = await h.page.evaluate(async () => {
      const first = window.__SMW.ensureSoundfonts(); const second = window.__SMW.ensureSoundfonts();
      const library = await first;
      const shared = library === await second && library === await window.__SMW.ensureSoundfonts();
      const smw = window.__SMW;
      const routed = smw.synth.current === smw.sf2Engine;
      smw.synth.noteOn({ role: 'MELODY', pitch: 60, vel: 0.8, durMs: 200, channel: 0, program: 0 });
      const voiceStarted = smw.sf2Engine._voices.length > 0;
      const count = library.count;
      library.deselect();
      return { shared, routed, voiceStarted, count, fallback: smw.synth.current === smw.synth.fallback };
    });
    assert.deepEqual(optional, { shared: true, routed: true, voiceStarted: true, count: 1, fallback: true });
    assert.equal(h.requests.length, 2, 'one explicit manifest and one font asset');
    await dropRecording(h);
    assert.equal(await h.page.evaluate(() => !window.__SMW.synth.enabled && !window.__SMW.sf2Engine.enabled), true);
    assert.equal((await snapshot(h)).originalBuffer, true);
    assert.equal(h.requests.length, 2, 'recording selection does not rediscover fonts');
    await stop(h);
    report.cases.push({ source: 'explicit-font-consumer', optional, fontRequests: h.requests, passed: true });
    console.log('PASS explicit optional font consumer');
  } finally { await h.context.close(); }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  if (server) { server.kill('SIGTERM'); }
}
