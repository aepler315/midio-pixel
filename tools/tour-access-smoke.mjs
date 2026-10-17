// Real controls and camera diagnostics against an immutable copy of this
// checkout. Software Chromium evidence; this does not claim device performance.
// node tools/tour-access-smoke.mjs <output-directory> [all|startup|activation|live|motion|refinement|fallback]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '.smoke/tour-access/browser');
const suite = process.argv[3] || 'all';
assert.ok(['all', 'startup', 'activation', 'live', 'motion', 'refinement', 'fallback'].includes(suite), `unknown suite: ${suite}`);
await fs.mkdir(output, { recursive: true });
const source = await snapshotSource(root), server = await serveSnapshot(source);
const wav = path.join(output, 'tour-access-120-96.wav');
execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '96']);
const report = { suite, sourceSha256: source.digest, sourceHashes: source.hashes, browser: null, checks: [], passed: false };
const saveReport = () => fs.writeFile(path.join(output, 'tour-access.json'), JSON.stringify(report, null, 2) + '\n');
async function record(check) { report.checks.push(check); await saveReport(); }
async function within(label, operation, timeoutMs = 300000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
report.browser = browser.version();

async function open({ query = '', saved = null, blocked = false, fail = null, reducedMotion = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
    serviceWorkers: 'block', reducedMotion: 'no-preference' });
  await context.addInitScript(({ saved, blocked, reducedMotion }) => {
    if (saved) localStorage.setItem('range-tour', saved);
    localStorage.setItem('smw:reducedMotion', reducedMotion ? '1' : '0');
    localStorage.setItem('smw:reducedFlash', '0');
    if (blocked) {
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function(key, ...args) {
          if (key === 'range-tour') throw new DOMException('Storage blocked', 'SecurityError');
          return original.call(this, key, ...args);
        };
      }
    }
  }, { saved, blocked, reducedMotion });
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin !== server.url && !['blob:', 'data:'].includes(u.protocol)) return route.abort();
    if (fail === 'tour' && u.pathname.endsWith('/teton-range-tour.tour.json')) return route.fulfill({ status: 404, body: 'missing tour fixture' });
    if (fail === 'runtime' && u.pathname.endsWith('/three-range.module.js')) return route.fulfill({ status: 404, body: 'missing runtime fixture' });
    return route.continue();
  });
  const page = await context.newPage(), errors = [], warnings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Shader Error|program not valid/.test(message.text())) errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  page.setDefaultTimeout(30000);
  await page.goto(server.url + '/' + query);
  await page.waitForFunction(() => window.__SMW);
  assert.ok(await page.evaluate(() => window.__SMW.rangeState), 'title screen exposes the requested tour and its actual readiness');
  await page.locator('#titleSettings').evaluate(node => { node.open = true; });
  assert.match(await page.locator('label:has(#range-tour-toggle)').innerText(), /Camera tour: Tetons/i);
  assert.match(await page.locator('#range-tour-description').innerText(), /continuous.*music.timed.*flight/i);
  return { context, page, errors, warnings };
}

async function state(page) {
  return page.evaluate(() => {
    const app = window.__SMW, range = app.rangeState, mgr = app.sim?.biomes;
    return {
      checked: document.getElementById('range-tour-toggle').checked,
      uiState: document.getElementById('range-tour-status').dataset.state,
      text: document.getElementById('range-tour-status').textContent,
      mode: range.mode, requestedMode: range.requestedMode, resolvedMode: range.resolvedMode,
      tourMode: range.tourMode, active: range.active, viewId: range.viewId,
      selectedViewId: range.selectedViewId, runtime: range.runtime, runtimeReady: range.runtimeReady,
      tourPreparation: range.tourPreparation, fallbackReason: range.fallbackReason,
      worldId: app.worldId, worldKind: mgr?.world?.kind, paused: app.paused, nowMs: app.audioEngine?.nowMs,
      seed: app.songSeed, generation: range.generation,
      biomes: mgr?.songTerrain?.biomes, originalBiomes: mgr?.songTerrain?._rangeTourOriginalBiomes,
      chapterBiomes: mgr?._chapterInputs?.biomes, chapters: mgr?.chapterPlan?.map(c => ({ biome: c.biome, startMs: c.startMs })),
      reducedMotion: mgr?.reducedMotion, plannedReducedMotion: mgr?.rangePresentation?.tour?.reducedMotion,
      tourNotes: mgr?.rangePresentation?.tour?.notes,
    };
  });
}

async function loadSong(page, world = 'alpine') {
  console.log(`Tour access: upload and choose ${world}.`);
  const lyrics = page.locator('#lyricGroundingBtn');
  if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
  await page.locator('#fileInput').setInputFiles(wav);
  console.log('Tour access: upload accepted; waiting for the world picker.');
  await page.locator('#worldSelect[open]').waitFor({ timeout: 300000 });
  // This handler follows the app's own world-selection handler in the same
  // click. Pause before its first rAF can paint a software-rendered frame.
  await page.locator('#worldSelectGrid').evaluate(node => {
    node.addEventListener('click', () => {
      if (window.__SMW?.sim && !window.__SMW.paused) document.getElementById('pauseBtn').click();
    }, { once: true });
  });
  console.log('Tour access: world picker ready; choosing and pausing in one click.');
  await page.locator(`.worldCard[data-base-world-id="${world}"]`).click();
  const kind = world === 'redline' ? 'strip' : world;
  // The picker builds a song-specific world whose public ID is "custom".
  await page.waitForFunction(kind => window.__SMW?.sim?.biomes?.world?.kind === kind, kind, { timeout: 300000 });
  // Stop the real audio/rAF through the actual Pause handler as soon as the
  // world exists. Preparation and assertions must not leave software GL
  // rendering continuously in the background.
  await page.evaluate(() => { if (!window.__SMW.paused) document.getElementById('pauseBtn').click(); });
  await page.waitForFunction(() => window.__SMW.audioEngine.ctx.state === 'suspended');
  console.log(`Tour access: ${kind} started and paused; preparing requested scenery.`);
}

async function drawCurrent(page) {
  await within('drawing and settling one actual frame', page.evaluate(async () => {
    const app = window.__SMW;
    app.renderer.draw(app.sim, 0);
    if (await app.rangeSettle({ timeoutMs: 120000 })) app.renderer.draw(app.sim, 0);
  }));
}

async function expectStatus(page, expected) {
  await page.waitForFunction(expected => document.getElementById('range-tour-status')?.dataset.state === expected, expected, { timeout: 120000 });
  return state(page);
}

async function activateTour(page, { seekMs = 0 } = {}) {
  await loadSong(page);
  if (seekMs) {
    await within('real paused seek', page.evaluate(ms => window.__SMW.seek(ms), seekMs));
    await page.waitForFunction(() => window.__SMW.audioEngine.ctx.state === 'suspended');
    assert.equal((await state(page)).nowMs, seekMs);
    console.log(`Tour access: paused at ${seekMs} ms through the real seek handler.`);
  }
  const loading = await state(page);
  await within('tour readiness', page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 120000 })));
  console.log('Tour access: prepared; drawing one actual tour frame.');
  await drawCurrent(page);
  const active = await expectStatus(page, 'active');
  assert.equal(active.viewId, 'teton-range-tour');
  assert.equal(active.runtimeReady, true);
  const camera = await page.evaluate(() => {
    const p = window.__SMW.sim.biomes.rangePresentation;
    return { at12s: p.tour.poseAt(12000), at36s: p.tour.poseAt(36000), finalPose: p.scene.movedPose(p.forced.view, p.frame).pose,
      actualEye: p.scene.camera.position.toArray(), heardTimeMs: p.frame.timeMs };
  });
  assert.notDeepEqual(camera.at12s.eyeM, camera.at36s.eyeM, 'the route must move across heard time');
  assert.equal(camera.finalPose.tour, true, 'the final camera keeps the authored tour provider');
  assert.ok([...camera.finalPose.eyeM, ...camera.finalPose.targetM].every(Number.isFinite));
  assert.deepEqual(camera.actualEye, camera.finalPose.eyeM, 'the final WebGL camera uses the tour pose');
  return { loading, active, camera };
}

try {
  for (const spec of (['all', 'startup'].includes(suite) ? [
    { name: 'fresh off', enabled: false },
    { name: 'persisted on', saved: 'tetons', enabled: true },
    { name: 'query off overrides saved on', query: '?rangeTour=off', saved: 'tetons', enabled: false },
    { name: 'query on overrides fresh off', query: '?rangeTour=tetons', enabled: true },
    { name: 'query on overrides legacy renderer', query: '?rangeRenderer=legacy&rangeTour=tetons', enabled: true },
    { name: 'blocked storage query on', query: '?rangeTour=tetons', blocked: true, enabled: true },
  ] : [])) {
    const { context, page, errors } = await open(spec);
    try {
      const value = await expectStatus(page, spec.enabled ? 'ready' : 'off');
      assert.equal(value.checked, spec.enabled);
      assert.equal(value.active, false);
      if (spec.enabled) assert.equal(value.tourPreparation.state, 'idle');
      if (spec.blocked) {
        await page.locator('#range-tour-toggle').uncheck();
        assert.equal((await expectStatus(page, 'off')).checked, false);
        await page.locator('#range-tour-toggle').check();
        assert.equal((await expectStatus(page, 'ready')).checked, true);
      }
      assert.deepEqual(errors, []);
      await record({ name: spec.name, state: value });
      console.log(`Tour access: ${spec.name} passed.`);
    } finally { await context.close(); }
  }

  for (const spec of (['all', 'activation'].includes(suite) ? [
    { name: 'fresh UI preference activates the final tour camera', saved: null, enable: true },
    { name: 'persisted preference activates the final tour camera', saved: 'tetons', enable: false },
  ] : [])) {
    const h = await open({ query: '?worlds=all', saved: spec.saved });
    try {
      if (spec.enable) await h.page.locator('#range-tour-toggle').check();
      const evidence = await activateTour(h.page);
      assert.deepEqual(h.errors, []);
      await record({ name: spec.name, ...evidence });
      console.log(`Tour access: ${spec.name} passed.`);
    } finally { await h.context.close(); }
  }

  if (['all', 'live', 'motion', 'refinement'].includes(suite)) {
    const live = await open({ query: '?worlds=all&rangeTour=tetons' });
    try {
    const { page } = live;
    const { loading, active, camera } = await activateTour(page, { seekMs: 12000 });
    await record({ name: 'live tour activity and final camera', loading, active, camera });
    if (suite !== 'refinement') {
    console.log('Tour access: active camera passed; rebuilding ordinary geography through the real toggle.');
    const paused = await state(page);
    await page.evaluate(() => { window.__tourAccessAudio = window.__SMW.audioEngine; });
    await page.locator('#displaySettingsBtn').click();
    await page.locator('#range-tour-toggle').uncheck({ timeout: 300000 });
    const off = await expectStatus(page, 'off');
    assert.equal(off.seed, paused.seed);
    assert.equal(off.nowMs, paused.nowMs);
    assert.equal(off.paused, true);
    assert.deepEqual(off.biomes, active.originalBiomes);
    assert.deepEqual(off.chapterBiomes, active.originalBiomes);
    assert.ok(off.chapters.every(c => active.originalBiomes.includes(c.biome)));
    assert.equal(await page.evaluate(() => window.__SMW.audioEngine === window.__tourAccessAudio), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('range-tour')), null);
    assert.equal(new URL(page.url()).searchParams.get('rangeTour'), 'off');
    await record({ name: 'paused disable restores geography and chapters', paused, off });
    console.log('Tour access: paused disable passed; re-enabling the tour.');
    await page.locator('#range-tour-toggle').check({ timeout: 300000 });
    const onPaused = await state(page);
    assert.equal(onPaused.seed, paused.seed);
    assert.equal(onPaused.nowMs, paused.nowMs);
    assert.equal(onPaused.paused, true);
    assert.equal(onPaused.active, false, 'paused rebuild cannot report the previous camera as active');
    assert.deepEqual(onPaused.chapterBiomes, ['CONIFER']);
    assert.ok(onPaused.chapters.every(c => c.biome === 'CONIFER'));
    assert.equal(await page.evaluate(() => localStorage.getItem('range-tour')), 'tetons');
    assert.equal(new URL(page.url()).searchParams.get('rangeTour'), 'tetons');
    await record({ name: 'paused enable retains clock and seed without stale activity', onPaused });
    if (suite !== 'motion') {
    console.log('Tour access: paused off/on preserved clock, seed and chapters; checking playing toggle.');
    const playingToggle = await within('playing tour toggle', page.evaluate(async () => {
      document.getElementById('displaySettingsClose').click();
      document.getElementById('pauseBtn').click();
      await window.__SMW.audioEngine.ctx.resume();
      const before = { nowMs: window.__SMW.audioEngine.nowMs, seed: window.__SMW.songSeed, paused: window.__SMW.paused };
      document.getElementById('displaySettingsBtn').click();
      document.getElementById('range-tour-toggle').click();
      const after = { nowMs: window.__SMW.audioEngine.nowMs, seed: window.__SMW.songSeed, paused: window.__SMW.paused,
        sameAudio: window.__SMW.audioEngine === window.__tourAccessAudio };
      document.getElementById('displaySettingsClose').click();
      document.getElementById('pauseBtn').click();
      return { before, after };
    }));
    assert.equal(playingToggle.before.paused, false);
    assert.equal(playingToggle.after.paused, false);
    assert.equal(playingToggle.after.seed, playingToggle.before.seed);
    assert.equal(playingToggle.after.sameAudio, true);
    assert.ok(playingToggle.after.nowMs >= playingToggle.before.nowMs);
    await record({ name: 'playing toggle retains the audio engine, clock and seed', playingToggle });
    await page.waitForFunction(() => window.__SMW.audioEngine.ctx.state === 'suspended');
    await page.locator('#displaySettingsBtn').click();
    await page.locator('#range-tour-toggle').check({ timeout: 300000 });
    }
    await within('rebuilt tour readiness', page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 120000 })));
    await drawCurrent(page);
    } else {
      await page.locator('#displaySettingsBtn').click({ timeout: 300000 });
    }
    console.log('Tour access: checking reduced-motion refinement on the owned song.');
    await page.locator('#reducedMotionBtn').click();
    await drawCurrent(page);
    await within('reduced-motion refinement', page.evaluate(() => window.__SMW.sim.biomes.rangePresentation._replanPromise));
    await drawCurrent(page);
    let reduced = await state(page);
    report.lastObserved = { name: 'reduced-motion refinement result', state: reduced };
    await saveReport();
    assert.equal(reduced.reducedMotion, true);
    assert.equal(reduced.tourPreparation.requestedReducedMotion, true);
    assert.equal(reduced.tourPreparation.effectiveReducedMotion, reduced.plannedReducedMotion);
    const applied = reduced.plannedReducedMotion;
    if (applied) assert.equal(reduced.tourPreparation.refinement.state, 'applied');
    else {
      assert.equal(reduced.tourPreparation.refinement.state, 'held');
      assert.ok(reduced.tourPreparation.refinement.reason);
      await page.waitForFunction(() => document.getElementById('range-tour-status').textContent.includes('motion change unavailable'));
      reduced = await state(page);
      assert.match(reduced.text, /motion change unavailable/);
      report.limitations = [`At 12 seconds this fixture retains the previous motion setting: ${reduced.tourPreparation.refinement.reason}. The requested reduced-motion change remains unmet; the active flight and its committed prefix are retained.`];
    }
    assert.equal(reduced.active, true);
    const retainedPose = await page.evaluate(() => window.__SMW.sim.biomes.rangePresentation.tour.poseAt(12000));
    assert.deepEqual(retainedPose.eyeM, camera.at12s.eyeM, 'refinement must preserve the committed camera');
    assert.deepEqual(retainedPose.targetM, camera.at12s.targetM);
    assert.deepEqual(live.errors, []);
    await record({ name: 'owned-song motion refinement reports its actual outcome', outcome: applied ? 'applied' : 'held', requestedMotionSatisfied: applied,
      reduced, retainedPose, warnings: live.warnings });
    console.log(`Tour access: ${applied ? 'applied' : 'explicitly held'} motion refinement and committed camera verified; capturing the real control.`);
    await page.screenshot({ path: path.join(output, 'camera-tour-control.png'), timeout: 300000 });
    report.screenshot = 'camera-tour-control.png';
    console.log('Tour access: camera and playback controls passed.');
    } finally { await live.context.close(); }
  }

  for (const fail of (['all', 'fallback'].includes(suite) ? ['tour', 'runtime'] : [])) {
    const h = await open({ query: '?worlds=all&rangeTour=tetons', fail });
    try {
      await loadSong(h.page);
      await within('fallback readiness', h.page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 120000 })));
      await drawCurrent(h.page);
      const unavailable = await expectStatus(h.page, 'unavailable');
      assert.equal(unavailable.active, false);
      assert.equal(unavailable.resolvedMode, 'legacy');
      assert.ok(unavailable.fallbackReason);
      if (fail === 'tour') assert.match(unavailable.fallbackReason, /HTTP 404/);
      else assert.match(unavailable.fallbackReason, /runtime-unavailable/);
      assert.deepEqual(h.errors, []);
      await record({ name: `${fail} assets unavailable`, state: unavailable, warnings: h.warnings });
      console.log(`Tour access: ${fail} fallback passed.`);
    } finally { await h.context.close(); }
  }
  if (['all', 'fallback'].includes(suite)) {
    const other = await open({ query: '?worlds=all&rangeTour=tetons' });
    try {
    await loadSong(other.page, 'redline');
    const ready = await other.page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 120000 }));
    assert.equal(ready.tourPreparation.state, 'idle');
    const value = await expectStatus(other.page, 'unavailable');
    assert.match(value.text, /The Range/);
    assert.equal(value.active, false);
    assert.deepEqual(other.errors, []);
      await record({ name: 'tour preference retained in another world', state: value });
    } finally { await other.context.close(); }
  }
  report.passed = true;
  console.log(`Tour access: ${report.checks.length} browser checks passed (${report.browser}).`);
} catch (error) {
  report.error = error.stack || String(error);
  throw error;
} finally {
  await browser.close();
  await server.close();
  await saveReport();
}
