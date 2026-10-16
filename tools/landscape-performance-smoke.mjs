// Assembled landscape correctness. Use installed Chrome explicitly for hardware
// pixels; this fixed-step matrix never measures live playback performance.
// node tools/landscape-performance-smoke.mjs --url URL --fixtures DIR --output DIR
//   [--suite matrix|motion|handoff|shared|midi-travel|all] [--source-root DIR]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openSong, captureFrame, landscapeOwnership, assertLandscapeOwnership } from './range-scene-smoke.mjs';
import { seedBrowserConstruction, installSeedReceiver } from './lib/landscape-browser.mjs';
import { measureTerrainSnapshot } from './lib/range-motion-evidence.mjs';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
assert.ok(args.url && args.fixtures && args.output, '--url, --fixtures, --output required');
assert.ok(['all', 'matrix', 'motion', 'handoff', 'shared', 'midi-travel'].includes(args.suite || 'all'), 'unknown suite');
const root = path.resolve(args['source-root'] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const out = path.resolve(args.output), fixtures = path.resolve(args.fixtures);
await fs.mkdir(out, { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const report = { classification: 'Assembled correctness and fixed-step pixels; no device timing claim',
  instrumentation: 'Construction RNG315; hidden seedInput restores existing URL receiver before module evaluation. Served source bytes unchanged. Export clock rebuilt before descending sequences.',
  seed: 2917029651, sources: {}, fixtures: {}, cases: [], unavailable: ['Android hardware', 'real-recording pop/metal/progressive/ambient artistic matrix'] };
report.evidenceSources = {};
for (const file of ['tools/lib/range-motion-metrics.mjs', 'tools/lib/range-motion-evidence.mjs']) {
  report.evidenceSources[file] = hash(await fs.readFile(path.join(root, file)));
}
report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
report.sourceChanges = execFileSync('git', ['status', '--porcelain', '--', 'src', 'tools', 'test'], { cwd: root, encoding: 'utf8' }).trim();
const pending = [];
for (const file of ['pilot-120s.wav', 'quiet-120s.wav', 'silence-120s.wav', 'authored-120s.mid']) report.fixtures[file] = hash(await fs.readFile(path.join(fixtures, file)));
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  args: process.env.PLAYWRIGHT_CHROMIUM_PATH ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [],
});
report.browser = browser.version();
const trackedBrowser = { async newContext(options) {
  const c = await browser.newContext(options);
  await c.addInitScript(seedBrowserConstruction, 315);
  await c.addInitScript(installSeedReceiver);
  c.on('page', page => page.on('response', response => {
    const file = new URL(response.url()).pathname.replace(/^\/+/, '');
    if (!file.startsWith('src/') || !response.ok()) return;
    pending.push(response.body().then(async bytes => {
      const actual = hash(bytes), expected = hash(await fs.readFile(path.join(root, file)));
      assert.equal(actual, expected, `loaded bytes differ: ${file}`);
      report.sources[file] = actual;
    }, error => {
      (report.sourceReadErrors ||= []).push({ file, error: String(error) });
    }).catch(error => {
      // A readable response mismatch or missing local file must never be
      // excused by a different, readable response for the same worker URL.
      (report.sourceIdentityErrors ||= []).push({ file, error: String(error) });
    }));
  }));
  return c;
} };
async function row(page, label, t, { reducedMotion = false, reducedFlash = false, quality = 0, measureMotion = false } = {}) {
  await page.evaluate(({ reducedMotion, reducedFlash, quality }) => {
    const app = window.__SMW;
    app.sim.setReducedMotion(reducedMotion); app.sim.setReducedFlash(reducedFlash);
    app.perf?.setFixtureLevel(quality);
  }, { reducedMotion, reducedFlash, quality });
  const frame = await captureFrame(page, t);
  const ownership = await landscapeOwnership(page); assertLandscapeOwnership(ownership);
  const state = await page.evaluate(measureMotion => {
    const app = window.__SMW, m = app.sim.biomes, p = m.rangePresentation, s = p?.scene, f = p?.frame;
    const gl = s?.renderer?.getContext(), e = gl?.getExtension('WEBGL_debug_renderer_info');
    // Read the actual scenic/stage receiver uniforms after the draw, rather
    // than copying the frame's expected celestial values as a lighting proof.
    const prepared = s?.prepared.get(p.viewId), u = prepared?.uniforms, stage = prepared?.stageGL?.uniforms;
    const receiver = u && stage ? {
      lightColor: u.uLightColor.value.toArray(), lightDir: u.uLightDir.value.toArray(),
      solarTransmission: u.uSolarTransmission.value, ambientScale: u.uAmbientScale.value,
      stageKeyColor: stage.uKeyColor.value.toArray(), stageKeyDir: stage.uKeyDir.value.toArray(),
    } : null;
    const shaftEntry = s?.residency?.entries.get('range:sun-shafts');
    const motionSnapshot = measureMotion && prepared && f ? { view: prepared.view, frame: f, budget: s.budget,
      camera: { world: s.camera.matrixWorld.toArray(), projection: s.camera.projectionMatrix.toArray() } } : null;
    return { motionSnapshot, stateKey: app.ridgeStateKey, music: f?.music, ridges: f?.ridges && {
      dance: { displacement01: f.ridges.dance.displacement01, velocity01: f.ridges.dance.velocity01 },
      space: { displacement01: f.ridges.space.displacement01, velocity01: f.ridges.space.velocity01 } },
    celestial: m.celestialState, camera: s?.camera?.matrixWorld?.elements, viewport: f?.scenicViewport,
    shafts: !!s?.shafts, receiver,
    shaftAllocation: { ledgerEntry: !!shaftEntry, bytes: shaftEntry?.bytes || 0,
      buffers: Object.keys(s?.shafts?.buffers || {}) },
    essentialKeys: [...(s?.residency?.entries.keys() || [])].filter(k => k !== 'range:sun-shafts').sort(),
    midiEvents: app.conductor.timeline.filter(e => e.src === 'midi').length,
    renderer: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : app.renderer.backend,
    actualTime: app.sim.heardTimeMs, stage: [document.querySelector('#stage').width, document.querySelector('#stage').height] };
  }, measureMotion);
  if (measureMotion) {
    assert.ok(state.motionSnapshot, 'motion evidence requires prepared v2 terrain');
    state.projectedMotion = await measureTerrainSnapshot({ root, ...state.motionSnapshot,
      outputWidth: state.stage[0], outputHeight: state.stage[1] });
    assert.equal(state.projectedMotion.waterMaxDisplacementM, 0, 'hydro receivers must remain pinned');
  }
  delete state.motionSnapshot;
  assert.equal(frame.seed, report.seed);
  assert.ok(Math.abs(state.actualTime - t) <= 17);
  if (frame.range?.residency) {
    const r = frame.range.residency;
    assert.ok(r.liveBytes + r.pendingBytes <= r.budgetBytes); assert.equal(r.overcommits, 0);
  }
  if (reducedMotion && state.music) {
    for (const k of ['amplitudeM', 'kickM', 'gestureM', 'melodicM', 'structuralM']) assert.equal(state.music[k], 0, k);
    assert.equal(state.ridges.dance.displacement01, 0); assert.equal(state.ridges.space.displacement01, 0);
  }
  if (quality >= 3) assert.equal(state.shafts, false);
  await fs.writeFile(path.join(out, `${label}.png`), Buffer.from(frame.png, 'base64'));
  delete frame.png;
  return { label, ...frame, ...state, ownership, reducedMotion, reducedFlash };
}
async function matrix() {
  const specs = [
    ['wide', 'pilot-120s.wav', 960, 540, 1], ['portrait', 'pilot-120s.wav', 540, 960, 2],
    ['quiet', 'quiet-120s.wav', 960, 540, 1], ['silence', 'silence-120s.wav', 960, 540, 1],
    ['legacy', 'pilot-120s.wav', 960, 540, 1],
  ];
  for (const [name, wav, width, height, dpr] of specs) {
    if (args.case && args.case !== name) continue;
    console.log(`matrix ${name}`);
    const opened = await openSong(trackedBrowser, { url: args.url, wav: path.join(fixtures, wav), width, height, dpr,
      params: { rangeRenderer: name === 'legacy' ? 'legacy' : 'v2', rangeView: 'teton-jackson-lake', seed: String(report.seed) } });
    const rows = [];
    const times = ['wide', 'portrait'].includes(name) ? [0, 21000, 41900, 45000, 71000, 96000] : [0, 42000];
    for (const t of times) {
      const value = await row(opened.page, `${name}-${t}`, t);
      assert.equal(value.range.active, name !== 'legacy');
      if ([45000, 96000].includes(t)) { assert.equal(value.celestial.activeBody, null); assert.equal(value.shafts, false); }
      if (name === 'midi') assert.ok(value.midiEvents > 0);
      if (name === 'silence') assert.equal(value.music.activity01, 0);
      rows.push(value);
    }
    if (name === 'wide') {
      for (const [label, options] of [['dense', {}], ['reduced-motion', { reducedMotion: true }], ['reduced-flash', { reducedFlash: true }]]) {
        await opened.page.evaluate(() => { window.__resetLandscapeRandom(); window.__SMW.beginBulkExport(window.__SMW.exportSize); });
        const value = await row(opened.page, label, 42000, options);
        if (label === 'reduced-flash') assert.ok((value.music.source ?? value.music).amplitudeM > 0, 'reduced flash retains the heard mountain motion');
        rows.push(value);
      }
      // Descending from the dense 42 s checks must rebuild the forward-only
      // clock. Both quality levels then draw the identical active-sun instant.
      await opened.page.evaluate(() => { window.__resetLandscapeRandom(); window.__SMW.beginBulkExport(window.__SMW.exportSize); });
      const baseline = await row(opened.page, 'quality0-sun', 21000);
      assert.ok(baseline.range.active, 'quality0 positive control uses v2');
      assert.equal(baseline.quality, 0);
      assert.equal(baseline.celestial.activeBody, 'sun');
      assert.ok(baseline.receiver?.lightColor.some(v => v > 0), 'actual receiver has direct solar light');
      assert.ok(baseline.receiver.solarTransmission > 0 && baseline.receiver.stageKeyColor.some(v => v > 0));
      assert.ok(baseline.shafts && baseline.shaftAllocation.ledgerEntry && baseline.shaftAllocation.bytes > 0);
      assert.ok(baseline.shaftAllocation.buffers.includes('A'), 'actual shaft target allocated');
      const shed = await row(opened.page, 'quality3', 21000, { quality: 3 });
      assert.ok(shed.range.active, 'quality3 retains v2');
      assert.equal(shed.quality, 3);
      assert.equal(shed.shaftAllocation.ledgerEntry, false, 'shaft ledger ownership released');
      assert.deepEqual(shed.shaftAllocation.buffers, [], 'shaft buffers released');
      assert.deepEqual(shed.celestial, baseline.celestial, 'same active solar state');
      assert.deepEqual(shed.receiver, baseline.receiver, 'actual essential direct-light state unchanged');
      assert.deepEqual(shed.essentialKeys, baseline.essentialKeys, 'essential resources preserved');
      report.qualityShedding = { heardTimeMs: 21000, baseline: baseline.label, shed: shed.label,
        assertions: { activeV2: true, directSolarReceiver: true, allocatedShaftsBefore: true,
          releasedShaftsAfter: true, receiverUnchanged: true, essentialResourcesPreserved: true } };
      rows.push(baseline, shed);
      await opened.page.evaluate(() => { const a = window.__SMW; a.perf.setFixtureLevel(0); window.__contextExt = a.sim.biomes.rangePresentation.scene.renderer.getContext().getExtension('WEBGL_lose_context'); window.__contextExt.loseContext(); });
      await opened.page.waitForFunction(() => window.__SMW.sim.biomes.rangePresentation.scene.contextLost);
      const lost = await row(opened.page, 'context-lost', 42000); assert.equal(lost.range.active, false); rows.push(lost);
      await opened.page.evaluate(() => window.__contextExt.restoreContext());
      await opened.page.waitForFunction(() => !window.__SMW.sim.biomes.rangePresentation.scene.contextLost);
      const restored = await row(opened.page, 'context-restored', 42000); assert.ok(restored.range.active); rows.push(restored);
    }
    assert.deepEqual(opened.errors, []);
    report.cases.push({ name, wav, width, height, dpr, rows, errors: opened.errors });
    await Promise.all(pending);
    await opened.context.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
}

// These rows retain the actual source-derived music snapshot and the exact
// painted camera. The paired neutral geometry changes no clock or light. The
// CPU probe tool supplies separately labeled isolated channel measurements;
// source passages here are never renamed "kick" or "bass" without evidence.
async function motion() {
  report.motion = [];
  for (const view of ['teton-jackson-lake-coherent', 'monument-valley-163-coherent', 'pend-oreille-valley']) {
    for (const wav of ['pilot-120s.wav', 'quiet-120s.wav']) {
      const opened = await openSong(trackedBrowser, { url: args.url, wav: path.join(fixtures, wav), width: 1280, height: 720,
        params: { rangeRenderer: 'v2', rangeView: view, seed: String(report.seed) } });
      const rows = [];
      for (const timeMs of wav.startsWith('quiet') ? [21000] : [21000, 42000, 42500]) {
        const result = await row(opened.page, `motion-${view}-${wav}-${timeMs}`, timeMs, { measureMotion: true });
        assert.ok(result.range.active, 'motion capture cannot count legacy fallback as v2 evidence');
        rows.push(result);
      }
      assert.deepEqual(opened.errors, []);
      report.motion.push({ view, wav, rows });
      await Promise.all(pending); await opened.context.close();
      await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
}

async function sharedWorlds() {
  const opened = await openSong(trackedBrowser, { url: args.url, wav: path.join(fixtures, 'pilot-120s.wav'), width: 960, height: 540,
    params: { rangeRenderer: 'legacy', seed: String(report.seed) } });
  await captureFrame(opened.page, 1000);
  const rows = await opened.page.evaluate(async () => {
    const [{ Simulation }, { Conductor }, { ParamBus }, { createRenderer }, { getWorld }] = await Promise.all([
      import('/src/sim/Simulation.js'), import('/src/core/Conductor.js'), import('/src/core/ParamBus.js'),
      import('/src/render/WebGLRenderer.js'), import('/src/world/Worlds.js')]);
    const rows = [];
    for (const [world, mode] of [['fathom', 'canvas'], ['farside', 'webgl']]) {
      const c = new Conductor(); c.load({ timeline: window.__SMW.conductor.timeline, durationMs: 120000, bpm: 120, barGrid: [] });
      const sim = new Simulation(c, new ParamBus(), { worldId: world, songSeed: 2917029651, energyCurves: window.__SMW.sim.energyCurves });
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540; document.body.append(canvas);
      const r = createRenderer(canvas, mode, getWorld(world)), painter = r.canvasRenderer || r;
      let bossDraws = 0; const boss = r._drawBoss;
      if (boss) r._drawBoss = function (...args) { bossDraws++; return boss.apply(this, args); };
      const forbidden = ['_drawMidio', '_drawBroshi', '_drawMidasus', '_captureCastForReflections'];
      for (const name of forbidden) if (typeof painter[name] === 'function') painter[name] = () => { throw new Error('retired draw called: ' + name); };
      sim.startAt(20000); r.draw(sim, 1);
      const rgba = canvas.getContext('2d').getImageData(0, 0, 960, 540).data, colors = new Set();
      for (let i = 0; i < rgba.length; i += 64) colors.add(`${rgba[i]},${rgba[i+1]},${rgba[i+2]}`);
      rows.push({ world, mode, backend: r.backend || 'canvas', actors: !!sim.broshi || !!sim.midasus || !!sim.ensemble || !!sim.focus,
        policy: sim.presentation, bossDraws, bossCells: r._bossBody ? r._bossBody.w * r._bossBody.h : 0,
        colors: colors.size, png: canvas.toDataURL('image/png').split(',')[1] });
      sim.dispose(); r.dispose?.(); canvas.remove();
    }
    return rows;
  });
  for (const r of rows) {
    assert.equal(r.actors, false); assert.ok(r.colors > 16);
    if (r.mode === 'webgl') assert.equal(r.backend, 'webgl');
    await fs.writeFile(path.join(out, `shared-${r.world}.png`), Buffer.from(r.png, 'base64')); delete r.png;
  }
  assert.deepEqual(opened.errors, []);
  report.sharedWorlds = rows;
  await Promise.all(pending);
    await opened.context.close();
}

async function midiAndTravel() {
  const opened = await openSong(trackedBrowser, { url: args.url, wav: path.join(fixtures, 'pilot-120s.wav'), width: 960, height: 540,
    params: { rangeRenderer: 'v2', rangeView: 'teton-jackson-lake', seed: String(report.seed) } });
  await captureFrame(opened.page, 21000);
  const bytes = (await fs.readFile(path.join(fixtures, 'authored-120s.mid'))).toString('base64');
  const midi = await opened.page.evaluate(async b64 => {
    const [{ midiToTimeline }, { synthesizeEnergyCurves }, { Simulation }, { Conductor }, { ParamBus }] = await Promise.all([
      import('/src/core/MidiAdapter.js'), import('/src/core/EnergyCurvesSynth.js'), import('/src/sim/Simulation.js'),
      import('/src/core/Conductor.js'), import('/src/core/ParamBus.js')]);
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer, data = midiToTimeline(buf);
    const energyCurves = synthesizeEnergyCurves(data.timeline, data.durationMs), c = new Conductor(); c.load(data);
    const app = window.__SMW, sim = new Simulation(c, new ParamBus(), { worldId: 'alpine', songSeed: app.songSeed,
      energyCurves, songTerrain: app.sim.biomes.songTerrain, terrainProfiles: app.sim.biomes.terrainProfiles });
    sim.exportMode = true;
    const rows = [];
    for (const t of [21000, 42000, 42500]) {
      sim.startAt(t); app.renderer.draw(sim, 1);
      if (await app.rangeSettle()) app.renderer.draw(sim, 1);
      const m = sim.biomes, f = m.rangePresentation.frame;
      rows.push({ time: sim.heardTimeMs, active: m.rangePresentation.active,
        stateKey: m.ridgeMusicSession.stateKey, sample: m.ridgeMusicSession.sample(t), music: f.music,
        png: document.querySelector('#stage').toDataURL('image/png').split(',')[1] });
    }
    const result = { classification: 'Genuine SMF parsed by production adapter into real Simulation and v2 renderer; audio-only file picker does not accept MIDI',
      notes: data.timeline.length, midiNotes: data.timeline.filter(e => e.src === 'midi').length,
      lanes: [...new Set(data.timeline.map(e => e.lane))], pitchProvenance: [...new Set(data.timeline.map(e => e.pitchProvenance))], rows };
    sim.dispose(); return result;
  }, bytes);
  assert.ok(midi.notes > 0 && midi.midiNotes === midi.notes);
  for (const r of midi.rows) {
    assert.ok(r.active); assert.ok(r.sample.activity01 > 0 && (r.music.source ?? r.music).amplitudeM > 0);
    await fs.writeFile(path.join(out, `midi-${r.time}.png`), Buffer.from(r.png, 'base64')); delete r.png;
  }
  report.midi = midi;
  // Return to the actual loaded song, then exercise an explicit controlled
  // biome travel. The ordinary synthetic song has no natural chapter change.
  await opened.page.evaluate(() => window.__SMW.beginBulkExport(window.__SMW.exportSize));
  await captureFrame(opened.page, 21000);
  const travel = await opened.page.evaluate(async () => {
    const { default: catalog } = await import('/src/world/terrain/sceneCatalogData.js');
    const app = window.__SMW, m = app.sim.biomes, p = m.rangePresentation;
    const a = catalog.views.find(v => v.id === 'teton-jackson-lake'), b = catalog.views.find(v => v.id === 'nc-ross-lake-north');
    p.forced = null; p.sceneByBiome = new Map([['TAIGA', { view: a }], ['CONIFER', { view: b }]]);
    await p.whenReady({ timeoutMs: 600000 });
    const rows = [];
    for (const amount of [.2, .5, .8]) {
      m.currentBlend = { from: 'TAIGA', to: 'CONIFER', t: amount, travel: true, travelP: amount,
        fromHeightMul: 1, toHeightMul: 1, fromSnowLine01: 1, toSnowLine01: 1 };
      app.renderer.draw(app.sim, 1);
      if (await p.settle()) app.renderer.draw(app.sim, 1);
      rows.push({ amount, state: app.rangeState, sideB: !!p.scene.sideTargets.B,
        png: document.querySelector('#stage').toDataURL('image/png').split(',')[1] });
    }
    return { classification: 'Controlled currentBlend fixture; actual prepared distinct scenic views and production A/B seam. No natural-travel or timing claim', rows };
  });
  report.travel = travel;
  for (const r of travel.rows) {
    assert.ok(r.state.active && r.sideB); assert.notEqual(r.state.viewId, r.state.incomingViewId); assert.ok(r.state.incomingViewId);
    assert.equal(r.state.residency.overcommits, 0);
    await fs.writeFile(path.join(out, `travel-${r.amount}.png`), Buffer.from(r.png, 'base64')); delete r.png;
  }
  report.travel = travel; assert.deepEqual(opened.errors, []);
  await Promise.all(pending); await opened.context.close();
}

async function handoff() {
  const context = await trackedBrowser.newContext({ viewport: { width: 960, height: 640 }, serviceWorkers: 'block', acceptDownloads: true });
  // Delay exactly the background whole-song kickoff. Retain the original
  // callback; release only after the real provisional audio is running.
  await context.addInitScript(() => {
    const native = window.setTimeout.bind(window);
    window.setTimeout = function (fn, ms, ...rest) {
      const stack = new Error().stack;
      if (ms === 150 && /loadAudioFiles/.test(stack) && !window.__analysisDelay) {
        const record = window.__analysisDelay = { requestedMs: ms, stack, scheduledAt: performance.now() };
        let fired = false;
        const release = () => { if (fired) return; fired = true; record.releasedAt = performance.now(); fn(...rest); };
        window.__releaseWholeAnalysis = release;
        return native(release, 120000);
      }
      return native(fn, ms, ...rest);
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|program not valid/.test(m.text())) errors.push(m.text()); });
  await page.route('**/soundfonts/', route => route.fulfill({ json: [] }));
  await context.route(/^https:\/\//, route => route.abort());
  const entry = new URL(args.url); entry.searchParams.set('seed', String(report.seed)); entry.searchParams.set('rangeView', 'teton-jackson-lake'); entry.searchParams.set('worlds', 'all');
  await page.goto(entry.href);
  await page.locator('#titleSettings').evaluate(n => { n.open = true; });
  if (await page.locator('#lyricGroundingBtn').getAttribute('aria-pressed') === 'true') await page.locator('#lyricGroundingBtn').click();
  await page.locator('#fileInput').setInputFiles(path.join(fixtures, 'pilot-120s.wav'));
  await page.locator('#worldSelect[open]').waitFor({ timeout: 180000 });
  await page.locator('.worldCard[data-world-id="alpine"]').click();
  await page.waitForFunction(() => window.__SMW?.sim?.heardTimeMs > 1800, null, { timeout: 120000 });
  const before = await page.evaluate(() => {
    const a = window.__SMW, history = a.sim.biomes.ridgeMusicSession.primary;
    window.__openingHistory = history;
    window.__openingSamples = [0, 1000, 5000, 10000].map(t => history.sample(t));
    return { heard: a.sim.heardTimeMs, audio: a.audioEngine.ctx.state, stateKey: a.ridgeStateKey,
      samples: window.__openingSamples, delayed: window.__analysisDelay, frozen: Object.isFrozen(history) };
  });
  assert.equal(before.audio, 'running'); assert.ok(before.delayed, 'exact loader timer was not found'); assert.equal(before.stateKey.previousGeneration, null);
  await page.evaluate(() => window.__releaseWholeAnalysis());
  await page.waitForFunction(() => window.__SMW?.ridgeStateKey?.previousGeneration != null, null, { timeout: 180000 });
  const arrived = await page.evaluate(() => {
    const a = window.__SMW, session = a.sim.biomes.ridgeMusicSession;
    return { stateKey: a.ridgeStateKey, heard: a.sim.heardTimeMs, audio: a.audioEngine.ctx.state,
      retainedObject: session.previous === window.__openingHistory,
      samplesUnchanged: JSON.stringify(window.__openingSamples) === JSON.stringify([0, 1000, 5000, 10000].map(t => session.previous.sample(t))),
      frozen: Object.isFrozen(session) && Object.isFrozen(session.primary) && Object.isFrozen(session.previous),
      timer: window.__analysisDelay };
  });
  assert.equal(arrived.audio, 'running'); assert.ok(arrived.retainedObject && arrived.samplesUnchanged && arrived.frozen);
  assert.ok(arrived.stateKey.handoffStartMs > 0); assert.equal(arrived.stateKey.handoffDurationMs, 500);
  await page.locator('#pauseBtn').click();
  const target = Math.floor((arrived.stateKey.handoffStartMs + 250) * 60 / 1000) * 1000 / 60;
  const snapshot = async () => page.evaluate(t => {
    const a = window.__SMW, s = a.sim, m = s.biomes;
    (a.renderer.canvasRenderer || a.renderer).draw(s, 1);
    return { stateKey: a.ridgeStateKey, sample: m.ridgeMusicSession.sample(t), actual: s.heardTimeMs,
      seed: a.songSeed, celestial: m.celestialState,
      metrics: m._frameRidges && { dance: m._frameRidges.dance.displacement01, space: m._frameRidges.space.displacement01 } };
  }, target);
  const seeks = await page.evaluate(t => {
    let request = t; const rows = [];
    for (let i = 0; i < 4; i++) { window.__SMW.seek(request); const actual = window.__SMW.sim.heardTimeMs; rows.push({ request, actual, lag: window.__SMW.sim.visualLagMs }); if (Math.abs(actual - t) < .01) break; request += t - actual; }
    return rows;
  }, target);
  await page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 600000 }));
  const sought = await snapshot(), repeated = await snapshot();
  assert.deepEqual(repeated, sought);
  await page.locator('#rangeNavigation').evaluate(n => { n.open = true; });
  await page.locator('#rangeRestart').click();
  const restartTime = await page.evaluate(() => window.__SMW.sim.heardTimeMs); assert.ok(restartTime < 1000);
  if (await page.evaluate(() => window.__SMW.audioEngine.ctx.state === 'running')) await page.locator('#pauseBtn').click();
  const restartSeeks = await page.evaluate(t => {
    let request = t; const rows = [];
    for (let i = 0; i < 4; i++) { window.__SMW.seek(request); const actual = window.__SMW.sim.heardTimeMs; rows.push({ request, actual, lag: window.__SMW.sim.visualLagMs }); if (Math.abs(actual - t) < .01) break; request += t - actual; }
    return rows;
  }, target);
  await page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 600000 }));
  const restarted = await snapshot();
  await page.evaluate(() => window.__SMW.beginBulkExport({ width: 960, height: 540 }));
  await captureFrame(page, target);
  const exported = await snapshot();
  report.handoff = { classification: 'Controlled-latency actual production callback during audio playback', before, arrived, target, restartTime, seeks, restartSeeks, sought, repeated, restarted, exported, errors };
  for (const state of [sought, restarted, exported]) {
    assert.deepEqual(state.stateKey, arrived.stateKey); assert.deepEqual(state.sample, sought.sample);
    for (const k of ['dance', 'space']) assert.ok(Math.abs(state.metrics[k] - sought.metrics[k]) < 1e-9, k + ' reconstruction');
    for (const body of ['sun', 'moon']) for (const k of ['xFrac', 'yFrac', 'radiusFrac', 'visibility', 'directGain'])
      assert.ok(Math.abs(state.celestial[body][k] - sought.celestial[body][k]) < 1e-9, body + '.' + k);
    assert.equal(state.seed, report.seed); assert.ok(Math.abs(state.actual - target) < 17, `actual ${state.actual}, requested ${target}`);
  }
  assertLandscapeOwnership(await landscapeOwnership(page));
  report.handoff = { classification: 'Controlled-latency actual production callback during audio playback', before, arrived, target, restartTime, seeks, restartSeeks, sought, repeated, restarted, exported, errors };
  assert.deepEqual(errors, []);
  await Promise.all(pending);
  await context.close();
}
try {
  if (!args.suite || ['all', 'matrix'].includes(args.suite)) await matrix();
  if (!args.suite || ['all', 'motion'].includes(args.suite)) await motion();
  if (!args.suite || ['all', 'midi-travel'].includes(args.suite)) await midiAndTravel();
  if (!args.suite || ['all', 'shared'].includes(args.suite)) await sharedWorlds();
  if (!args.suite || ['all', 'handoff'].includes(args.suite)) await handoff();
  await Promise.all(pending);
  assert.deepEqual(report.sourceIdentityErrors || [], [], 'served source identity failed');
  for (const failure of report.sourceReadErrors || []) assert.ok(report.sources[failure.file], `no readable identical response for ${failure.file}`);
  if (report.sourceReadErrors?.length) report.sourceReadNote = 'Worker shutdown made duplicate response bodies unavailable; every named URL also has a readable response hash matched to disk.';
} catch (error) { report.error = String(error.stack); console.error(error); process.exitCode = 1; }
finally {
  await browser.close();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
