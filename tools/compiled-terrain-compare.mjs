// Compare the compiled terrain experiment's modes with the existing renderer
// (docs/compiled-terrain-experiment.md) on the pilot view, headless.
//
//   node tools/compiled-terrain-compare.mjs --out .smoke/<new-dir>
//        [--hardware-gpu] [--modes original,columns,mesh] [--grid classic]
//        [--quality 0] [--times 12000,24000] [--steady-frames 120]
//        [--live-seconds 20] [--cameras default,reverse] [--no-live]
//        [--browser PATH] [--group 1|2|4|8] [--profile NAME]
//
// From WSL, hardware WebGL is reliable only through native Windows Node and
// Chromium (D3D11), as tools/gpu-review.mjs runs it: Mesa's D3D12 path in
// WSL loses the GPU context after the first frames. See the experiment doc
// for the exact command.
// For every mode (each in a fresh browser, same song, seed, output
// size, grid, pinned quality rung and effects) it records:
//   cold load   upload-to-ready wall time, the view's prepare time and its
//               phases, the first frame (GPU upload happens there)
//   captures    matched PNGs at identical heard times and camera rails,
//               a zoomed frame, the strongest land-swell moment, and a seek
//               round trip (the same time drawn twice must match)
//   steady      consecutive fixed-clock frames: GPU time (timer queries)
//               split into terrain scenes (depth pre-pass and bands, which
//               include trees and cast) and the rest of the scenic context,
//               JS time inside those draws, draw calls and triangles
//   live        real playback at the default pace and the faster pace:
//               delivered frame intervals, stalls, and the same GPU split
// GPU timer results are taken only from the scene's own WebGL context; the
// 2D compositing of the output frame cannot be timed that way and is
// covered by whole-frame delivery. Evidence goes to --out (never commit it).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame, evaluationEntryUrl } from './lib/visual-evaluation-browser.mjs';
import { blankFrame } from './lib/visual-evaluation.mjs';
import { COMPILED_PILOT } from '../src/world/alpine/CompiledTerrain.js';
import { worldAnalysisReady } from './world-frame.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOFTWARE = /swiftshader|software|llvmpipe|softpipe|basic render driver|\bwarp\b/i;

export function parseCompareArgs(argv) {
  const a = { modes: ['original', 'columns', 'mesh'], grid: 'classic', quality: 0, times: [12000, 24000, 45000],
    steadyFrames: 120, liveSeconds: 20, cameras: ['default', 'reverse'], live: true, hardware: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--out') { a.out = v; i++; }
    else if (k === '--modes') { a.modes = v.split(','); i++; }
    else if (k === '--grid') { a.grid = v; i++; }
    else if (k === '--quality') { a.quality = Number(v); i++; }
    else if (k === '--times') { a.times = v.split(',').map(Number); i++; }
    else if (k === '--steady-frames') { a.steadyFrames = Number(v); i++; }
    else if (k === '--live-seconds') { a.liveSeconds = Number(v); i++; }
    else if (k === '--cameras') { a.cameras = v.split(','); i++; }
    else if (k === '--no-live') a.live = false;
    else if (k === '--hardware-gpu') a.hardware = true;
    else if (k === '--browser') { a.browser = v; i++; }
    else if (k === '--group') { a.group = Number(v); i++; }
    else if (k === '--profile') { a.profile = v; i++; }
    else throw new Error(`unknown argument ${k}`);
  }
  assert.ok(a.out, '--out DIR is required (a new directory, e.g. .smoke/compiled-terrain-<run>)');
  assert.ok(a.modes.every(m => ['original', 'columns', 'mesh'].includes(m)), 'modes: original|columns|mesh');
  assert.ok(a.cameras.every(c => c === 'default' || Object.hasOwn(COMPILED_PILOT.cameras, c)), 'unknown camera');
  assert.ok(Number.isInteger(a.quality) && a.quality >= 0 && a.quality <= 6, 'quality 0..6');
  return a;
}

function settingsFor(args, mode, camera, pace = 3) {
  return { width: 1280, height: 720, seed: 315, quality: args.quality, experience: 'landscape', view: COMPILED_PILOT.viewId,
    pace, tour: 'off',
    presentation: { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective',
      pixelGrid: args.grid, pixelScale: 'original', scaling: 'fit' },
    debug: { compiledTerrain: mode === 'original' ? null : mode, compiledTerrainCamera: camera === 'default' ? null : camera,
      compiledTerrainGroup: args.group ?? null, compiledTerrainProfile: args.profile ?? null } };
}

// In-page probe: wraps the scene renderer's render() with GPU timer queries
// and counts draw calls and triangles per frame, split by terrain scenes.
function installProbe() {
  const scene = window.__SMW.sim.biomes.rangePresentation.scene;
  const r = scene.renderer, gl = r.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  r.info.autoReset = false;
  const pending = [], frames = [];
  let current = null, active = false;
  // Terrain-surface draws (band, depth, ownership and seam meshes), told
  // apart from trees, cast and ink drawn in the same scenes.
  for (const p of scene.prepared.values()) {
    const surface = new Set([p.material, p.depthMaterial, ...Object.values(p.ownershipMaterials || {})].filter(Boolean));
    const roots = [p.depthScene, ...Object.values(p.scenes || {}), ...Object.values(p.depthScenes || {}), ...(p.fringeTravel || []).map(f => f.scene)];
    for (const root of roots) root?.traverse(o => {
      if (!o.isMesh || o.userData.compiledProbe) return;
      o.userData.compiledProbe = true;
      const prior = o.onBeforeRender;
      o.onBeforeRender = function (...a) {
        if (current && surface.has(this.material)) {
          const g = this.geometry;
          current.surface.calls++;
          current.surface.triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
        }
        return prior.apply(this, a);
      };
    });
  }
  const kindOf = (s) => {
    for (const p of scene.prepared.values()) {
      if (s === p.depthScene || Object.values(p.scenes || {}).includes(s) || Object.values(p.depthScenes || {}).includes(s)
        || (p.fringeTravel || []).some(f => f.scene === s)) return 'terrain';
    }
    return 'other';
  };
  const render = r.render.bind(r);
  r.render = (s, c) => {
    if (!current || active) return render(s, c);
    const kind = kindOf(s), before = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    const q = ext ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    active = true;
    const t0 = performance.now();
    try { return render(s, c); } finally {
      current.cpu[kind] += performance.now() - t0;
      active = false;
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ frame: current, kind, q }); current.queries++; }
      current.calls[kind] += r.info.render.calls - before.calls;
      current.triangles[kind] += r.info.render.triangles - before.triangles;
    }
  };
  const poll = () => {
    const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { frame, kind, q } = pending[i];
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (disjoint) frame.disjoint = true;
      else frame.gpu[kind] += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      frame.resolved++;
      gl.deleteQuery(q);
      pending.splice(i, 1);
    }
  };
  window.__compiledProbe = {
    timer: !!ext,
    begin(label) { current = { label, cpu: { terrain: 0, other: 0 }, gpu: { terrain: 0, other: 0 }, calls: { terrain: 0, other: 0 },
      triangles: { terrain: 0, other: 0 }, surface: { calls: 0, triangles: 0 }, queries: 0, resolved: 0, disjoint: false }; return current; },
    end(extra = {}) { const f = Object.assign(current, extra); frames.push(f); current = null; poll(); return f; },
    poll,
    async flush(timeoutMs = 10000) {
      const t0 = performance.now();
      while (pending.length && performance.now() - t0 < timeoutMs) { poll(); await new Promise(r => setTimeout(r, 16)); }
      return pending.length === 0;
    },
    // GPU numbers count only when timer queries ran and all resolved.
    take() { return frames.splice(0).map(f => ({ ...f, gpuComplete: f.queries > 0 && f.resolved === f.queries && !f.disjoint })); },
  };
  return { timer: !!ext };
}

const stats = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  return { n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
};
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const summarizeFrames = (frames) => ({
  frames: frames.length, gpuComplete: frames.filter(f => f.gpuComplete).length,
  gpuTerrainMs: stats(frames.filter(f => f.gpuComplete).map(f => f.gpu.terrain)),
  gpuOtherMs: stats(frames.filter(f => f.gpuComplete).map(f => f.gpu.other)),
  jsTerrainMs: stats(frames.map(f => f.cpu.terrain)), jsOtherMs: stats(frames.map(f => f.cpu.other)),
  frameJsMs: stats(frames.map(f => f.frameMs)),
  callsTerrain: stats(frames.map(f => f.calls.terrain)), callsOther: stats(frames.map(f => f.calls.other)),
  trianglesTerrain: stats(frames.map(f => f.triangles.terrain)), trianglesOther: stats(frames.map(f => f.triangles.other)),
  surfaceCalls: stats(frames.map(f => f.surface.calls)), surfaceTriangles: stats(frames.map(f => f.surface.triangles)),
});

async function sceneState(page) {
  return page.evaluate(() => {
    const smw = window.__SMW, pres = smw.sim.biomes.rangePresentation, scene = pres.scene;
    const s = scene.snapshot();
    const p = scene.prepared.get(smw.rangeState.viewId);
    return { viewId: smw.rangeState.viewId, compiledTerrain: s.compiledTerrain, prepareLog: s.prepareLog,
      residency: pres.residency?.snapshot?.() ?? smw.rangeState.residency ?? null,
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null, perfLevel: smw.perfLevel,
      prepared: p ? { triangles: p.stats?.triangles ?? null, vertices: p.stats?.vertices ?? null, trees: p.stats?.trees ?? null,
        compiled: p.compiled ? { representation: p.compiled.representation, gpuBytes: p.compiled.gpuBytes, drawGroups: p.compiled.drawGroups, bandDraws: p.compiled.bandDraws, groupTiles: p.compiled.groupTiles } : null } : null,
      music: pres.frame?.music ? { amplitudeM: pres.frame.music.amplitudeM, structuralM: pres.frame.music.structuralM } : null,
      deform: p?.uniforms ? { amp: p.uniforms.uDeformAmp.value, structural: p.uniforms.uDeformStructural.value, phase: p.uniforms.uDeformPhase.value } : null,
      camera: (() => { const c = scene.camera; return { eyeM: c.position.toArray().map(v => Math.round(v * 10) / 10), fov: c.fov, view: c.view?.enabled ? { ...c.view } : null }; })() };
  });
}

/** Strongest land-swell moment of the song: the heard time where the
 *  section-change swell (RangeFrame.landMoment01, pure in heard time) peaks.
 *  The export clock only runs forward, so this reads the schedule instead
 *  of drawing. Same song => same answer in every mode. */
async function findSwell(page, durationMs) {
  return page.evaluate(async (durationMs) => {
    const { landMoment01 } = await import('/src/world/alpine/RangeFrame.js');
    const mgr = window.__SMW.sim.biomes;
    let best = { timeMs: null, moment01: 0 };
    for (let t = 4000; t < durationMs - 4000; t += 250) {
      const m = landMoment01(mgr.sections, t, mgr._landHistory);
      if (m > best.moment01 + 1e-6) best = { timeMs: t, moment01: m };
    }
    return best;
  }, durationMs);
}

async function capture(page, dir, name, timeMs, settings) {
  const f = await renderEvaluationFrame(page, { timeMs, save: true }, settings);
  assert.equal(blankFrame(f.thumbnail), false, `${name}: blank frame at ${timeMs}`);
  const bytes = Buffer.from(f.pngData, 'base64');
  const file = `${name}.png`;
  await fs.writeFile(path.join(dir, file), bytes);
  const st = await sceneState(page);
  return { name, timeMs, file, sha256: sha256(bytes), drawn: f.range?.scene?.compiledTerrain?.drawn?.[COMPILED_PILOT.viewId] ?? null,
    camera: st.camera, land: f.controls?.land ? { amplitudeM: f.controls.land.amplitudeM, structuralM: f.controls.land.structuralM,
      phaseRad: f.controls.land.phaseRad } : null, deform: st.deform, presentation: { look: f.presentation?.effectiveLook, grid: f.presentation?.effectiveGrid?.id,
      output: f.output, qualityLevel: f.render?.qualityLevel } };
}

async function steady(page, startMs, frames, label) {
  await page.evaluate(async ({ startMs, frames, label }) => {
    const smw = window.__SMW, probe = window.__compiledProbe;
    for (let i = 0; i < frames; i++) {
      probe.begin(label);
      const t0 = performance.now();
      smw.renderExportFrame(startMs + i * 1000 / 60);
      probe.end({ frameMs: performance.now() - t0, timeMs: startMs + i * 1000 / 60 });
    }
    await probe.flush();
  }, { startMs, frames, label });
  return page.evaluate(() => window.__compiledProbe.take());
}

async function fixedClockRun(browser, server, audio, args, mode, camera, dir, plan) {
  const settings = settingsFor(args, mode, camera);
  const diagnostics = { errors: [], warnings: [], events: [], loadedFiles: new Set() };
  const t0 = Date.now();
  const loaded = await openEvaluationSong(browser, { url: server.url, audioPath: audio, settings, diagnostics });
  const run = { mode, camera, uploadToReadyMs: Date.now() - t0, environment: loaded.environment, durationMs: loaded.durationMs, captures: [], errors: diagnostics.errors };
  try {
    if (args.hardware) assert.ok(!SOFTWARE.test(loaded.environment.gl || ''), `hardware GPU required, got ${loaded.environment.gl}`);
    run.timer = (await loaded.page.evaluate(installProbe)).timer;
    run.ready = await sceneState(loaded.page);
    plan.swell ??= await findSwell(loaded.page, loaded.durationMs);
    // The fixed export clock only runs forward: capture in time order.
    const times = [...new Set([...plan.times, plan.swell?.timeMs].filter(Number.isFinite))].sort((a, b) => a - b);
    // The first frame uploads the view's buffers and textures; drawn one
    // step past the start so the clock advance is not counted with it.
    const first = await steady(loaded.page, 1000 / 60, 1, 'first');
    run.firstFrame = first[0];
    for (const t of times) {
      const swell = t === plan.swell?.timeMs ? '-swell' : '';
      run.captures.push(await capture(loaded.page, dir, `${mode}-${camera}-${t}${swell}`, t, settings));
    }
    const last = times[times.length - 1];
    // The listener's zoom (projection zoom, eased in real time), towards
    // the right third of the frame; export disables it, so enable it here
    // for every mode alike.
    run.zoom = await loaded.page.evaluate(async () => {
      const { rangeUserCamera } = await import('/src/world/alpine/RangeCamera.js');
      window.__SMW.sim.userCameraEnabled = true;
      rangeUserCamera.zoomAt(1.8, 0.35, 0.1);
      // Snap the real-time ease, so every mode draws the identical offset.
      Object.assign(rangeUserCamera.current, rangeUserCamera.target);
      return { ...rangeUserCamera.target };
    });
    run.captures.push(await capture(loaded.page, dir, `${mode}-${camera}-zoom-${last}`, last, settings));
    await loaded.page.evaluate(async () => {
      const { rangeUserCamera } = await import('/src/world/alpine/RangeCamera.js');
      rangeUserCamera.reset(); window.__SMW.sim.userCameraEnabled = false;
    });
    // Steady state on the fixed clock.
    run.steady = summarizeFrames(await steady(loaded.page, last + 1000 / 60, args.steadyFrames, 'steady'));
    run.after = await sceneState(loaded.page);
    return run;
  } finally {
    await loaded.context.close();
    await loaded.browserDiagnostics?.dispose();
  }
}

async function liveRun(browser, server, audio, args, mode) {
  const settings = settingsFor(args, mode, 'default');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const result = { mode, scope: 'Headless live playback; display compositor not measured.', segments: [] };
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(evaluationEntryUrl(server.url, settings, { bulkExport: false }));
    await page.locator('#titleSettings').evaluate(n => { n.open = true; });
    await page.locator('#lyricGroundingBtn').evaluate(n => { if (n.getAttribute('aria-pressed') === 'true') n.click(); });
    // The display controls sit in a collapsed panel: set them as a change.
    const choose = (id, value) => page.evaluate(([id, value]) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === value;
    }, [id, value]);
    assert.ok(await choose('display-look', 'pixel'), 'look');
    assert.ok(await choose('display-pixelGrid', args.grid), 'grid');
    assert.ok(await choose('stageFps', '60'), 'fps cap');
    await choose('display-pixelScale', 'original');
    const started = Date.now();
    await page.locator('#fileInput').setInputFiles(audio);
    await page.waitForFunction(() => window.__SMW?.sim && (window.__SMW.renderReady || window.__SMW.rangeState?.active), null, { timeout: 180000 });
    result.ready = await page.evaluate(async () => { const s = window.__SMW; const r = await s.renderReady; return { status: r?.status ?? null, heardMs: s.sim.heardTimeMs }; });
    result.uploadToReadyMs = Date.now() - started;
    // Live playback starts on the opening analysis; the whole-song one is
    // adopted mid-song with a timeline rebuild. Measure only after it.
    const throughMs = await page.evaluate(() => Math.max(0, window.__SMW.durationMs - 1000));
    await page.waitForFunction(worldAnalysisReady, { throughMs }, { timeout: 180000 });
    await page.evaluate(() => window.__SMW.renderReady);
    await page.waitForFunction(() => window.__SMW.renderReadiness?.status === 'ready' && !window.__SMW.playbackPreparing, null, { timeout: 120000 });
    result.analysisAdoptedMs = Date.now() - started;
    await page.evaluate((q) => window.__SMW.perf.setFixtureLevel(q), args.quality);
    result.timer = (await page.evaluate(installProbe)).timer;
    for (const pace of [3, 4]) {
      if (pace !== 3) assert.ok(await choose('range-pace', String(pace)), 'pace');
      const seg = await page.evaluate(async (seconds) => {
        const { FrameDeliveryAggregator } = await import('/src/render/FrameDelivery.js');
        const meter = new FrameDeliveryAggregator(), probe = window.__compiledProbe, start = performance.now();
        const S = () => window.__SMW;
        const heard0 = S().sim.heardTimeMs, generation0 = S().generation;
        // Probe the scene's work between consecutive rAF callbacks.
        await new Promise(resolve => {
          probe.begin('live');
          const tick = (wallMs) => {
            const s = S(), f = s.presentationDiagnostics.frame;
            probe.end({ frameMs: null, drew: f.reason !== 'not-rendered' });
            meter.push({ wallMs, generation: s.generation, frameId: `${f.generation}:${f.frameId}`, presented: f.presented,
              attempted: f.reason !== 'not-rendered', paused: s.paused, hidden: document.hidden, capFps: s.fpsCap });
            if (wallMs - start < seconds * 1000) { probe.begin('live'); requestAnimationFrame(tick); } else resolve();
          };
          requestAnimationFrame(tick);
        });
        await probe.flush();
        const s = S();
        return { delivery: meter.summary(), heardAdvanceMs: s.sim.heardTimeMs - heard0, perfLevel: s.perfLevel,
          pace: s.cameraRunState.requestedMultiplier, rebuilt: s.generation !== generation0, frames: probe.take() };
      }, args.liveSeconds);
      // Scene work only from intervals in which the app drew.
      const drew = seg.frames.filter(f => f.drew && (f.queries > 0 || f.calls.terrain + f.calls.other > 0));
      result.segments.push({ pace, delivery: seg.delivery, heardAdvanceMs: seg.heardAdvanceMs, perfLevel: seg.perfLevel,
        requestedPace: seg.pace, rebuilt: seg.rebuilt, emptyIntervals: seg.frames.length - drew.length, scene: summarizeFrames(drew) });
    }
    // Pause holds the picture and the heard clock; seeking while paused
    // redraws that moment, and seeking away and back gives the same camera
    // pose, swell and (stage hash) picture; resume continues.
    result.pauseSeekResume = await page.evaluate(async () => {
      // seek() rebuilds the timeline and replaces window.__SMW: read it fresh.
      const S = () => window.__SMW, btn = () => document.getElementById('pauseBtn');
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const until = async (pred, ms = 20000) => { const t0 = performance.now(); while (!pred() && performance.now() - t0 < ms) await wait(50); return pred(); };
      const stage = async () => {
        const c = document.querySelector('#stage');
        const bytes = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      };
      const pose = () => { const pres = S().sim.biomes.rangePresentation, c = pres.scene.camera, f = pres.frame;
        return JSON.stringify({ eye: c.position.toArray().map(v => v.toFixed(2)), fov: c.fov.toFixed(4), amp: f?.music?.amplitudeM?.toFixed(4), heard: Math.round(S().sim.heardTimeMs) }); };
      const seekTo = async (ms) => {
        S().seek(ms);
        const arrived = await until(() => Math.abs(S().sim.heardTimeMs - ms) < 50 && !S().playbackPreparing);
        await S().rangeSettle?.({ timeoutMs: 20000 }); await wait(800);
        return arrived;
      };
      btn().click(); await until(() => S().paused); await wait(300);
      const h0 = S().sim.heardTimeMs; await wait(1000);
      const held = S().paused && S().sim.heardTimeMs === h0;
      const target = 30000;
      const arrivedA = await seekTo(target);
      const a = { pose: pose(), stage: await stage() };
      const arrivedB = await seekTo(52000);
      const arrivedC = await seekTo(target);
      const b = { pose: pose(), stage: await stage() };
      const pausedAfterSeek = S().paused;
      const hResume = S().sim.heardTimeMs;
      btn().click(); await until(() => !S().paused); await wait(1500);
      return { held, seeksArrived: arrivedA && arrivedB && arrivedC, pausedAfterSeek, seekPoseIdentical: a.pose === b.pose,
        seekStageIdentical: a.stage === b.stage, poseA: a.pose, poseB: b.pose, resumed: !S().paused && S().sim.heardTimeMs > hResume + 500 };
    });
    result.state = await sceneState(page);
    result.errors = errors;
    return result;
  } finally { await context.close(); }
}

const ms = (s, k = 'p50') => (s ? round(s[k], 2) : '–');
function summaryMarkdown(report) {
  const noTimer = report.runs.some(r => r.timer === false);
  const lines = [`# Compiled terrain comparison`, '', `Renderer: ${report.renderer}${report.software ? ' (SOFTWARE: timings are CPU rasterization, not GPU)' : ''}`,
    ...(noTimer ? ['GPU timer queries unavailable: GPU columns are blank.'] : []),
    `Song ${report.song.sha256.slice(0, 12)}, ${report.settings.width}x${report.settings.height}, grid ${report.settings.grid}, quality rung ${report.settings.quality} pinned, view ${COMPILED_PILOT.viewId}.`, ''];
  lines.push('| mode | camera | drawn | prepare ms | first frame JS ms | terrain scenes GPU ms p50/p95 | other scene GPU ms p50 | surface draws p50 | surface triangles p50 | all terrain-scene triangles p50 | frame JS ms p50 |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of report.runs) {
    const s = r.steady;
    lines.push(`| ${r.mode} | ${r.camera} | ${r.captures[0]?.drawn ?? '?'} | ${round(r.ready?.prepareLog?.[COMPILED_PILOT.viewId]?.ms, 0)} | ${round(r.firstFrame?.frameMs, 1)} | ${ms(s.gpuTerrainMs)} / ${ms(s.gpuTerrainMs, 'p95')} | ${ms(s.gpuOtherMs)} | ${ms(s.surfaceCalls)} | ${ms(s.surfaceTriangles)} | ${ms(s.trianglesTerrain)} | ${ms(s.frameJsMs)} |`);
  }
  if (report.live?.length) {
    lines.push('', '| mode | drawn | pace | delivered fps | interval p50/p95/max ms | stalls >100 ms | terrain scenes GPU ms p50 | other scene GPU ms p50 | surface triangles p50 | heard advance s |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of report.live) for (const seg of r.segments) {
      const d = seg.delivery?.delivered || {};
      lines.push(`| ${r.mode} | ${r.state?.compiledTerrain?.drawn?.[COMPILED_PILOT.viewId] ?? '?'} | ${seg.pace} | ${round(d.fps, 1)} | ${round(d.medianMs, 1)} / ${round(d.p95Ms, 1)} / ${round(d.maxMs, 0)} | ${d.stallsOver100ms ?? '–'} | ${ms(seg.scene.gpuTerrainMs)} | ${ms(seg.scene.gpuOtherMs)} | ${ms(seg.scene.surfaceTriangles)} | ${round(seg.heardAdvanceMs / 1000, 1)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function runCompare(args) {
  const out = path.resolve(args.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out);
  const audio = path.join(out, 'song.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), audio, '90']);
  const snapshot = await snapshotSource(root, { include: ['src/assets/range/v2/compiled'] });
  const server = await serveSnapshot(snapshot);
  const executablePath = args.browser || process.env.PLAYWRIGHT_CHROMIUM_PATH;
  // A fresh browser per measured run: shader, driver and HTTP caches are
  // cold for every mode, whatever the order.
  const launch = () => chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
    args: [...(args.hardware ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const fresh = async (work) => { const b = await launch(); try { return await work(b); } finally { await b.close(); } };
  const probeBrowser = await launch();
  const browserVersion = probeBrowser.version();
  await probeBrowser.close();
  const report = { version: 1, createdAt: new Date().toISOString(), source: { digest: snapshot.digest }, browser: browserVersion,
    song: { file: 'song.wav', sha256: sha256(await fs.readFile(audio)) }, settings: { width: 1280, height: 720, grid: args.grid, quality: args.quality },
    args: { ...args, out: path.relative(root, out) }, runs: [], live: [], limitations: [
      'Headless Chromium; the display compositor and a physical panel are not measured.',
      'Each measured run uses a fresh browser (cold shader/driver/HTTP caches); live runs start after the whole-song analysis is adopted.',
      'GPU timer queries cover the scene WebGL context only; 2D output compositing is covered by whole-frame delivery.',
      'Fixed-clock frames are rendered back to back without vsync: their JS times are submission times, not completed GPU work.'] };
  try {
    const plan = { times: args.times };
    for (const camera of args.cameras) for (const mode of args.modes) {
      const dir = path.join(out, 'frames');
      await fs.mkdir(dir, { recursive: true });
      console.log(`fixed clock: ${mode} / ${camera}`);
      const run = await fresh(browser => fixedClockRun(browser, server, audio, args, mode, camera, dir, plan));
      report.renderer ??= run.environment.gl;
      report.software = SOFTWARE.test(report.renderer || '');
      report.runs.push(run);
      const s = run.steady;
      console.log(`  drawn ${run.captures[0]?.drawn}, terrain GPU p50 ${ms(s.gpuTerrainMs)} ms, calls ${ms(s.callsTerrain)}, tris ${ms(s.trianglesTerrain)}`);
    }
    report.swell = plan.swell ?? null;
    if (args.live) for (const mode of args.modes) {
      console.log(`live: ${mode}`);
      report.live.push(await fresh(browser => liveRun(browser, server, audio, args, mode)));
    }
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    await fs.writeFile(path.join(out, 'summary.md'), summaryMarkdown(report));
    await server.close();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseCompareArgs(process.argv.slice(2));
  const report = await runCompare(args);
  console.log(`Saved ${path.join(args.out, 'summary.md')} (${report.renderer})`);
}
