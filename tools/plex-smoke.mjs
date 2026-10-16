import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { createFakePms, syntheticWav } from '../test/helpers/plex-fixtures.mjs';
import { readPlexConfig } from './plex/config.mjs';
import { createPlexClient } from './plex/client.mjs';
import { createPlexServer } from './plex/server.mjs';
import { stageSite } from './stage-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.smoke/plex');
const selected = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
if (selected && !['ui', 'selection', 'playback'].includes(selected)) throw new Error('Use --case ui, selection, or playback');
await fs.mkdir(out, { recursive: true });
const report = { checks: [], errors: [], passed: false, scope: 'Real Chromium against a synthetic loopback PMS and dedicated adapter. No live Plex or device claims.' };
const check = (name, condition = true) => { assert.ok(condition, name); report.checks.push(name); console.log('PASS ' + name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const wavPath = path.join(out, 'recording.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wavPath, '120', '24']);
const wav = await fs.readFile(wavPath), localWav = syntheticWav({ durationSeconds: 24, sampleRate: 8000 });
let pms, adapter, app, browser, context, page;
let gate = null;
let apiBase = '';
let privateCredentialsExposed = false;
try {
  pms = await createFakePms({ mediaBody: wav, overrides: {
    '/library/metadata/10/thumb/1': (_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4AAAAABJRU5ErkJggg==', 'base64'));
    },
    '/library/parts/301/123/fixture.wav': async (req, res) => {
      if (gate) { const current = gate; current.started(); await current.release; }
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav);
    },
  } });
  for (const track of pms.tracks) { track.duration = 24000; track.Media[0].duration = 24000; }
  const config = readPlexConfig({ MIDIO_PLEX_ENABLED: 'true', PLEX_BASE_URL: pms.baseUrl, PLEX_TOKEN: 'fixture-private-token', PLEX_CLIENT_IDENTIFIER: 'fixture-client', PLEX_MUSIC_SECTION_IDS: '1' });
  adapter = createPlexServer({ config, client: createPlexClient(config) });
  await adapter.ready; await listen(adapter);
  apiBase = `http://127.0.0.1:${adapter.address().port}/api/plex/v1`;
  app = await serveSnapshot(await snapshotSource(root)); config.allowedOrigins.push(app.url);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
  const newPage = async ({ enabled = true, blockedStorage = false, staged = false } = {}) => {
    await context?.close();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.on('request', request => {
      const headers = request.headers();
      if (headers['x-plex-token'] || headers.authorization || /fixture-private-token|X-Plex-Token/i.test(request.url())) privateCredentialsExposed = true;
    });
    // Pin the integration workload; high-resolution render acceptance belongs
    // to the separate pixel/visual jobs, not this short audio fixture.
    await context.addInitScript(blocked => {
      try { localStorage.setItem('smw:noLyrics', '1'); localStorage.setItem('smw:stageRes', '360'); } catch { /* exercised by blocked storage case */ }
      if (blocked) {
        Object.defineProperty(window, 'indexedDB', { get: () => { throw new Error('Storage disabled'); } });
      }
    }, blockedStorage);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.message));
    if (!staged) await page.route('**/src/config/plex.json', route => route.fulfill({ json: { version: 1, apiBase: enabled ? apiBase : '' } }));
    // Startup draws the title scene, which can stall on CI's software GPU
    // like screenshots do; it gets the same rendering budget.
    await page.goto(app.url + '/?seed=315&quality=0', { timeout: 120000 });
    await page.waitForFunction(() => !!window.__SMW, null, { timeout: 120000 });
    await page.evaluate(async () => { window.__plexFingerprint = (await import('/src/audio/SongFingerprint.js')).fingerprintBuffer; });
    if (enabled) await page.locator('#plexOpenBtn:not(.hidden)').waitFor({ timeout: 120000 });
    return page;
  };
  const open = async () => {
    let button;
    for (const id of ['#plexOpenBtn', '#plexAuditionBtn', '#plexMusicBtn']) {
      if (await page.locator(id).isVisible()) { button = id; break; }
    }
    if (!button) { await page.locator('#stage').click({ position: { x: 300, y: 250 } }); button = '#plexMusicBtn'; }
    await page.locator(button).click();
    await page.locator('.plexItem').first().waitFor();
  };
  const tracks = async () => {
    await page.locator('.plexTabs [data-kind="track"]').click();
    // A search result can have the same rating key as the first catalog
    // track. Wait for this browse response, not that still-visible old row.
    await page.waitForFunction(() => /shown/.test(document.querySelector('.plexStatus')?.textContent));
    await page.locator('.plexItem[data-rating-key="30"]').waitFor();
  };
  const pick = async id => { await page.locator(`.plexItem[data-rating-key="${id}"]`).click(); };
  const waitPlaying = async ({ id = null, title = null, freeze = true } = {}) => {
    const result = await page.waitForFunction(({ id, title, freeze }) => {
      const s = window.__SMW;
      const ready = !!s?.sim && s.audioEngine?.playing && s.audioEngine?.sourceNode?.buffer && s.audioEngine.ctx.state === 'running'
        && (id == null ? !s.sourceTrack : s.sourceTrack?.id.endsWith(':' + id))
        && (!title || s.trackIdentity?.title === title);
      if (!ready) return false;
      const started = { ctxState: s.audioEngine.ctx.state, mutedTimeline: s.muteTimelineSynth };
      // Hold the short fixture while browser RPCs or shader preparation run.
      // Use application pause so its render loop also stops between assertions.
      if (freeze) document.getElementById('pauseBtn').click();
      return started;
    }, { id, title, freeze }, { timeout: 120000 });
    const started = await result.jsonValue();
    if (freeze) await page.waitForFunction(() => window.__SMW.audioEngine.ctx.state === 'suspended' && document.getElementById('pauseBtn').getAttribute('aria-pressed') === 'true');
    return started;
  };
  const advancePlayback = async ({ freeze = true } = {}) => {
    const token = String(Date.now());
    const result = await page.waitForFunction(({ token, freeze }) => {
      const s = window.__SMW, engine = s.audioEngine;
      const probe = window.__plexClockProbe;
      if (probe?.token !== token) {
        window.__plexClockProbe = { token, before: engine.nowMs, buffer: engine.sourceNode?.buffer };
        if (document.getElementById('pauseBtn').getAttribute('aria-pressed') === 'true') document.getElementById('pauseBtn').click();
        return false;
      }
      if (engine.ctx.state !== 'running' || engine.nowMs <= probe.before + 250) return false;
      const advanced = { before: probe.before, after: engine.nowMs, sameBuffer: !!probe.buffer && engine.sourceNode?.buffer === probe.buffer, ctxState: engine.ctx.state, world: s.sim.biomes.world.kind };
      if (freeze) document.getElementById('pauseBtn').click();
      return advanced;
    }, { token, freeze }, { timeout: 120000 });
    const advanced = await result.jsonValue();
    (report.clockProbes ??= []).push(advanced);
    assert.ok(advanced.sameBuffer && advanced.ctxState === 'running', 'clock advances on the active decoded recording');
    return advanced;
  };
  const bufferKey = () => page.evaluate(() => {
    const s = window.__SMW;
    return { key: window.__plexFingerprint(s.audioEngine.sourceNode?.buffer || s.audioBuffer).key, identity: s.trackIdentity, source: s.sourceTrack, world: s.sim.biomes.world.kind };
  });
  const expectedKey = bytes => page.evaluate(async bytes => {
    const { fingerprintBuffer } = await import('/src/audio/SongFingerprint.js');
    const ctx = new AudioContext();
    try { return fingerprintBuffer(await ctx.decodeAudioData(new Uint8Array(bytes).buffer)).key; }
    finally { await ctx.close(); }
  }, [...bytes]);
  const blockPlex = () => {
    let release, started;
    const reached = new Promise(resolve => { started = resolve; });
    gate = { release: new Promise(resolve => { release = resolve; }), started, unblock: () => release() };
    return { reached, release: () => { gate = null; release(); } };
  };
  const local = (name = 'Local Winner.wav') => page.locator('#fileInput').setInputFiles({ name, mimeType: 'audio/wav', buffer: localWav });
  const urlPick = async () => {
    await page.evaluate(() => document.getElementById('urlLoadOpenBtn').click());
    await page.locator('#urlLoadInput').fill(pms.baseUrl + '/browser-song.wav');
    await page.locator('#urlLoadBtn').click();
  };
  // The same fake upstream also provides a CORS-enabled file URL for regressions.
  pms.items.get('30').title = 'Duplicate title';
  const originalHandler = pms.server.listeners('request')[0];
  pms.server.removeListener('request', originalHandler);
  let urlGate = null;
  pms.server.prependListener('request', async (req, res) => {
    if (req.url !== '/browser-song.wav') return originalHandler(req, res);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (urlGate) { urlGate.started(); await urlGate.release; }
    if (!res.destroyed) { res.setHeader('Content-Type', 'audio/wav'); res.end(localWav); }
  });
  if (!selected || selected === 'ui') {
    const beforeDisabled = pms.requests.length;
    await newPage({ enabled: false });
    check('disabled config has no entry or catalog requests', !await page.locator('#plexOpenBtn').isVisible() && pms.requests.length === beforeDisabled);
    await newPage(); await open();
    check('anonymous artist listing displays remote labels as text', (await page.locator('.plexItem').first().textContent()).includes('Artist <&> 🎵') && await page.locator('.plexItem script').count() === 0);
    await page.waitForFunction(() => document.querySelector('.plexItem img')?.naturalWidth > 0);
    check('approved artwork decodes through the public adapter');
    await page.locator('.plexItem').first().click();
    await page.locator('.plexItem[data-rating-key="20"]').waitFor();
    await page.locator('.plexItem[data-rating-key="20"]').click();
    await page.locator('.plexItem[data-rating-key="30"]').waitFor();
    check('artist to album to complete track navigation', await page.locator('.plexItem').count() === 2);
    await page.locator('.plexSearch').fill('Duplicate');
    await page.waitForFunction(() => document.querySelector('.plexStatus')?.textContent === 'Search results');
    check('search groups authorized artists albums and duplicate-title tracks', await page.locator('.plexGroup').count() === 3 && await page.locator('.plexItem[data-rating-key="90"]').count() === 0);
    // Deliberately make the older real upstream search reply last.
    let releaseOld, oldStarted;
    const oldReached = new Promise(resolve => { oldStarted = resolve; });
    const oldHold = new Promise(resolve => { releaseOld = resolve; });
    const searchHandler = pms.server.listeners('request')[0];
    const outOfOrder = async (req, res) => {
      const u = new URL(req.url, pms.baseUrl);
      if (u.pathname === '/hubs/search' && u.searchParams.get('query') === 'Older') { oldStarted(); await oldHold; }
      if (u.pathname === '/hubs/search' && ['Older', 'Newer'].includes(u.searchParams.get('query'))) {
        const label = u.searchParams.get('query');
        const item = { ...pms.items.get('30'), title: label + ' result' };
        if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ MediaContainer: { Hub: [{ type: 'track', size: 1, Metadata: [item] }] } })); }
        return;
      }
      return searchHandler(req, res);
    };
    pms.server.removeListener('request', searchHandler); pms.server.prependListener('request', outOfOrder);
    await page.locator('.plexSearch').fill('Older'); await oldReached;
    await page.locator('.plexSearch').fill('Newer');
    await page.waitForFunction(() => document.querySelector('.plexStatus')?.textContent === 'Search results');
    releaseOld(); await wait(100);
    check('out-of-order search does not overwrite the latest query', (await page.locator('.plexList').textContent()).includes('Newer result') && !(await page.locator('.plexList').textContent()).includes('Older result'));
    pms.server.removeListener('request', outOfOrder); pms.server.prependListener('request', searchHandler);
    // Screenshot preparation and readback can stall on CI's software GPU.
    // Keep normal control timeouts short; give evidence the same bounded
    // rendering budget as playback preparation.
    await page.screenshot({ path: path.join(out, 'catalog-desktop.png'), timeout: 120000 });
    await page.setViewportSize({ width: 800, height: 480 });
    await page.screenshot({ path: path.join(out, 'catalog-800x480.png'), timeout: 120000 });
    check('800x480 dialog stays inside viewport', await page.locator('#plexLibraryPanel').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('plexLibraryPanel').open && document.activeElement.id === 'plexOpenBtn');
    check('Escape closes dialog and returns focus', await page.locator('#plexOpenBtn').evaluate(el => document.activeElement === el));
    await page.setViewportSize({ width: 1280, height: 720 });
    for (let i = 0; i < 53; i++) {
      const ratingKey = String(100 + i);
      const item = { ...pms.items.get('30'), ratingKey, title: 'Paged track ' + i, thumb: null };
      pms.tracks.push(item); pms.items.set(ratingKey, item);
    }
    await open(); await tracks();
    check('first catalog page is bounded to 50 tracks', await page.locator('.plexItem').count() === 50);
    await page.locator('.plexFoot button').filter({ hasText: 'Show more' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.plexItem').length === 55);
    check('Show more reaches every track without collapsing duplicate titles', await page.locator('.plexItem[data-rating-key="31"]').count() === 1);
    const held = blockPlex(); await pick('30'); await held.reached;
    await page.locator('.plexPanel .plexButton').filter({ hasText: 'Cancel load' }).click(); held.release();
    check('download cancellation is recoverable', await page.locator('.plexDownload').textContent() === 'Load cancelled.');
    await page.locator('.plexItem[data-rating-key="31"]').focus(); await page.keyboard.press('Enter');
    const started = await waitPlaying({ id: '31' });
    check('keyboard track activation unlocks and plays original recording', started.ctxState === 'running' && started.mutedTimeline);
    const advanced = await advancePlayback();
    check('decoded recording audio clock advances in normal Alpine playback', advanced.world === 'alpine');
  }
  if (!selected || selected === 'selection') {
    for (const pair of [['plex','local'], ['url','plex'], ['plex','url'], ['plex','plex']]) {
      await newPage(); await open(); await tracks();
      const winnerKey = await expectedKey(pair[1] === 'plex' ? wav : localWav);
      let held;
      if (pair[0] === 'plex') { held = blockPlex(); await pick('30'); await held.reached; }
      else {
        let started, release;
        const reached = new Promise(resolve => { started = resolve; });
        urlGate = { started, release: new Promise(resolve => { release = resolve; }) };
        await page.keyboard.press('Escape'); await urlPick(); await reached;
        held = { release: () => { urlGate = null; release(); } };
        await open(); await tracks();
      }
      if (pair[1] === 'local') { await page.keyboard.press('Escape'); await local(); }
      else if (pair[1] === 'url') { await page.keyboard.press('Escape'); await urlPick(); }
      else await pick('31');
      held.release();
      await waitPlaying(pair[1] === 'plex' ? { id: '31' } : { title: pair[1] === 'url' ? 'browser-song' : 'Local Winner' });
      const state = await bufferKey();
      check(`actual main ${pair[0]} then ${pair[1]} keeps winner identity buffer and world`, state.key === winnerKey && state.world === 'alpine' && (pair[1] === 'plex' ? !!state.source : !state.source));
    }
    for (const phase of ['decode','analysis']) {
      await newPage();
      await page.evaluate(phase => {
        const proto = phase === 'decode' ? AudioContext.prototype : OfflineAudioContext.prototype;
        const method = phase === 'decode' ? 'decodeAudioData' : 'startRendering';
        const original = proto[method]; let first = true;
        proto[method] = function(...args) {
          const result = original.apply(this, args);
          if (!first) return result;
          first = false;
          return result.then(value => { window.__phaseBlocked = true; return new Promise(resolve => { window.__releasePhase = () => resolve(value); }); });
        };
      }, phase);
      await local('Older Local.wav');
      await page.waitForFunction(() => window.__phaseBlocked, null, { timeout: 60000 });
      await open(); await tracks(); await pick('31');
      await page.evaluate(() => window.__releasePhase());
      await waitPlaying({ id: '31' });
      check(`actual main local then Plex during ${phase} discards old completion`, (await bufferKey()).source.id.endsWith(':31'));
    }
    for (const phase of ['decode', 'analysis']) {
      await newPage(); await open(); await tracks();
      await page.evaluate(phase => {
        const proto = phase === 'decode' ? AudioContext.prototype : OfflineAudioContext.prototype;
        const method = phase === 'decode' ? 'decodeAudioData' : 'startRendering';
        const original = proto[method]; let first = true;
        proto[method] = function(...args) {
          const result = original.apply(this, args);
          if (!first) return result;
          first = false;
          return result.then(value => { window.__phaseBlocked = true; return new Promise(resolve => { window.__releasePhase = () => resolve(value); }); });
        };
      }, phase);
      await pick('31');
      await page.waitForFunction(() => window.__phaseBlocked, null, { timeout: 60000 });
      await page.locator('.plexPanel .plexButton').filter({ hasText: 'Cancel load' }).click();
      await page.evaluate(() => window.__releasePhase()); await wait(500);
      check(`actual Plex cancellation during ${phase} prevents late playback`, await page.evaluate(() => !window.__SMW.audioEngine?.playing && !window.__SMW.sim));
      await page.keyboard.press('Escape'); await local(); await waitPlaying({ title: 'Local Winner' });
      check(`local recovery after Plex ${phase} cancellation plays`);
    }
  }
  if (!selected || selected === 'playback') {
    // Generated production configuration, no network interception for this pass.
    const previousApiBase = process.env.MIDIO_PLEX_PUBLIC_API_BASE;
    try { process.env.MIDIO_PLEX_PUBLIC_API_BASE = apiBase; await stageSite(root, path.join(root, '_site')); }
    finally { if (previousApiBase === undefined) delete process.env.MIDIO_PLEX_PUBLIC_API_BASE; else process.env.MIDIO_PLEX_PUBLIC_API_BASE = previousApiBase; }
    await app.close();
    app = await serveSnapshot(await snapshotSource(path.join(root, '_site'))); config.allowedOrigins.push(app.url);
    await newPage({ blockedStorage: true, staged: true }); await open(); await tracks(); await pick('31'); await waitPlaying({ id: '31' });
    const plexState = await bufferKey();
    check('generated public config and blocked IndexedDB still play', !!plexState.source);
    // Adapter loss after complete download must not stop the independent recording.
    await close(adapter); adapter = null;
    await advancePlayback();
    check('adapter disconnection after download leaves playback advancing');
    await page.waitForFunction(() => window.__SMW.audioEngine.ctx.state === 'suspended' && document.getElementById('pauseBtn').getAttribute('aria-pressed') === 'true');
    await page.locator('#pauseBtn').focus();
    const resumeProof = page.waitForFunction(() => {
      const engine = window.__SMW.audioEngine, button = document.getElementById('pauseBtn');
      if (engine.ctx.state !== 'running' || !engine.sourceNode?.buffer || button.getAttribute('aria-pressed') !== 'false') return false;
      button.click();
      return true;
    });
    await page.keyboard.press('Enter');
    const resumed = await resumeProof;
    assert.equal(await resumed.jsonValue(), true, 'native resume restores the decoded recording');
    await page.waitForFunction(() => window.__SMW.audioEngine.ctx.state === 'suspended');
    const seeked = await page.evaluate(async () => {
      const { VISUAL_LEAD_MS } = await import('/src/core/ChoreoClock.js');
      const engine = window.__SMW.audioEngine, buffer = engine.sourceNode.buffer;
      const original = engine.playBuffer; let offset;
      engine.playBuffer = function(buffer, at) { offset = at; return original.call(this, buffer, at); };
      try {
        window.__SMW.seek(4000);
        return { offset, timeMs: window.__SMW.sim.timeMs, leadMs: VISUAL_LEAD_MS, sameBuffer: engine.sourceNode.buffer === buffer, id: window.__SMW.sourceTrack.id };
      } finally { engine.playBuffer = original; }
    });
    report.seek = seeked;
    check('Plex pause resume and seek use normal playback', seeked.offset === 4 && Math.abs(seeked.timeMs - 4000 - seeked.leadMs) < 17 && seeked.sameBuffer && seeked.id.endsWith(':31'));
    await page.evaluate(() => { window.__SMW.seek(window.__SMW.durationMs - 10); document.getElementById('pauseBtn').click(); });
    await page.locator('#completePanel:not(.hidden)').waitFor();
    await page.locator('#replaySameSeedBtn').click({ timeout: 120000, noWaitAfter: true }); await waitPlaying({ id: '31', freeze: true });
    check('Plex replay retains original recording and selected source', (await bufferKey()).key === plexState.key);
    const exported = await page.evaluate(async () => {
      await window.__SMW.rangeReady({ timeoutMs: 120000 });
      window.__SMW.beginBulkExport({ width: 320, height: 180 });
      const frame = await window.__SMW.renderExportFrame(4000);
      return !!frame && window.__SMW.exportReady;
    });
    check('full-analysis export renders with the Plex recording', exported);
    await page.locator('#fileInput').setInputFiles({ name: 'Local Equivalent.wav', mimeType: 'audio/wav', buffer: wav });
    await waitPlaying({ title: 'Local Equivalent' });
    const localState = await bufferKey();
    check('identical PCM from local and Plex has the same decoded fingerprint', localState.key === plexState.key);
    check('Plex audio never invokes writeback requests', pms.requests.every(req => !/scrobble|timeline|playQueues|\/:\//.test(req.path)));
    // Offline UI leaves local loading fully available.
    await newPage({ staged: true });
    await page.locator('#plexOpenBtn').click();
    await page.waitForFunction(() => document.querySelector('.plexStatus')?.textContent.includes('unavailable'));
    check('offline catalog explains recovery and offers Retry', await page.locator('.plexFoot button').filter({ hasText: 'Retry' }).isVisible());
    await page.keyboard.press('Escape'); await local(); await waitPlaying({ title: 'Local Winner' });
    check('local audio loads after offline Plex initialization');
  }
  check('browser requests contain no private Plex credentials', !privateCredentialsExposed);
  check('no uncaught browser errors', report.errors.length === 0);
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error);
  report.panel = await page?.locator('#plexLibraryPanel').textContent().catch(() => null);
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  gate?.unblock();
  await browser?.close(); if (adapter) await close(adapter); await app?.close(); await pms?.close();
  await fs.writeFile(path.join(out, `report${selected ? '-' + selected : ''}.json`), JSON.stringify(report, null, 2) + '\n');
}
