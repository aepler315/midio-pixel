// Bounded full-application A/B: only the terrain normal's deformation
// gradient changes. Headless, muted; no compiled terrain packs are needed.
// node tools/deformation-gradient-compare.mjs --out .smoke/gradient-<run>
//   [--browser /usr/bin/chromium] [--audio song.wav] [--times 12000,24000]
//   [--frames 60] [--view teton-jackson-lake] [--hardware-gpu]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { blankFrame } from './lib/visual-evaluation.mjs';
import { finalizeBrowserDiagnostics } from './lib/browser-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOFTWARE = /swiftshader|software|llvmpipe|softpipe|basic render driver|\bwarp\b/i;
const MODES = ['reference', 'factored'];

export function parseGradientArgs(argv) {
  const args = { out: null, audio: null, browser: process.env.PLAYWRIGHT_CHROMIUM_PATH || null,
    frames: 60, times: [12000, 24000], view: 'teton-jackson-lake', hardware: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--hardware-gpu') { args.hardware = true; continue; }
    const value = argv[++i];
    assert.ok(value && !value.startsWith('--'), `missing value for ${key}`);
    if (key === '--out') args.out = value;
    else if (key === '--audio') args.audio = value;
    else if (key === '--browser') args.browser = value;
    else if (key === '--frames') args.frames = Number(value);
    else if (key === '--times') args.times = value.split(',').map(Number);
    else if (key === '--view') args.view = value;
    else throw Error(`unknown argument ${key}`);
  }
  assert.ok(args.out, '--out NEW_DIRECTORY is required');
  assert.ok(Number.isInteger(args.frames) && args.frames >= 1 && args.frames <= 600, '--frames must be 1..600');
  assert.ok(args.times.length && args.times.every(t => Number.isFinite(t) && t >= 0), '--times must be nonnegative milliseconds');
  assert.equal(new Set(args.times).size, args.times.length, '--times must be unique');
  assert.ok(/^[a-z0-9-]+$/.test(args.view), 'invalid --view');
  args.times.sort((a, b) => a - b);
  return args;
}

export function gradientStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = p => sorted[Math.round(p * (sorted.length - 1))];
  return { n: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: at(.5), p95: at(.95), max: sorted.at(-1) };
}

export function assessGradientExercise(uniforms) {
  const scalarKeys = ['uDeformAmp', 'uDeformKick', 'uDeformStructural', 'uDeformMelodic', 'uDeformGesture'];
  assert.ok(uniforms && scalarKeys.every(key => Number.isFinite(uniforms[key])), 'missing or invalid deformation strengths');
  assert.ok(Array.isArray(uniforms.uLandRise) && uniforms.uLandRise.length === 2
    && uniforms.uLandRise.every(Number.isFinite) && uniforms.uLandRise[0] >= 0 && uniforms.uLandRise[0] <= 1,
  'missing or invalid land rise');
  assert.ok(Array.isArray(uniforms.uLandDance) && uniforms.uLandDance.length === 4
    && uniforms.uLandDance.every(Number.isFinite), 'missing or invalid land dance');
  const channels = scalarKeys.filter(key => uniforms[key] !== 0);
  if (uniforms.uLandDance[0] !== 0) channels.push('uLandDance.x');
  if (uniforms.uLandDance[2] !== 0) channels.push('uLandDance.z');
  const nonFlat = uniforms.uLandRise[0] < 1, nonzeroStrengths = channels.length > 0;
  return { exercised: nonFlat && nonzeroStrengths, riseSink: uniforms.uLandRise[0], nonFlat, nonzeroStrengths,
    channels, reason: !nonFlat ? 'fully flat opening bypasses terrain shading'
      : !nonzeroStrengths ? 'all deformation and dance strengths are zero' : 'non-flat rise and nonzero deformation/dance inputs' };
}

export function assertGradientWasExercised(pairs) {
  assert.ok(pairs.some(pair => pair.gradientExercised === true), 'gradient was not exercised: require a matched non-flat capture with nonzero deformation or dance strengths');
}

// Deliberately excludes diagnostic timing/heap/preparation counters. These
// are the actual inputs to the paired image, not just requested settings.
export function assertGradientFrameMatch(a, b) {
  for (const key of ['timeMs', 'actualTimeMs', 'seed', 'quality', 'audio', 'controls', 'render', 'output', 'dpr', 'camera']) {
    assert.notEqual(a[key], undefined, `missing ${key}`);
    assert.deepEqual(a[key], b[key], `different ${key}`);
  }
  for (const key of ['requestedLook', 'effectiveLook', 'effectiveGrid', 'pixelScale', 'effectivePalette',
    'effectiveDitherMode', 'output', 'working', 'qualityLevel']) {
    assert.notEqual(a.presentation?.[key], undefined, `missing presentation.${key}`);
    assert.deepEqual(a.presentation[key], b.presentation?.[key], `different presentation.${key}`);
  }
  for (const key of ['camera', 'uniforms', 'geometry', 'vertexShaderSha256']) {
    assert.notEqual(a.gradientState?.[key], undefined, `missing gradient ${key}`);
    assert.deepEqual(a.gradientState[key], b.gradientState?.[key], `different gradient ${key}`);
  }
  for (const frame of [a, b]) {
    assert.deepEqual(frame.range?.scene?.pending, [], 'unsettled scene assets');
    assert.equal(frame.range?.active, true, 'inactive Range scene');
    assert.equal(frame.gradientState?.activation?.verified, true, 'unverified gradient material');
    assert.deepEqual(frame.gradientExercise, assessGradientExercise(frame.gradientState.uniforms), 'invalid gradient exercise metadata');
    assert.equal(frame.range.scene.deformationGradient?.requested, frame.gradientState.activation.mode, 'wrong requested gradient');
    assert.equal(frame.range.scene.deformationGradient?.drawn?.[frame.range.viewId]?.terrain,
      frame.gradientState.activation.mode, 'wrong drawn gradient');
    const river = frame.gradientState.activation.river;
    if (river) {
      assert.equal(river.verified, true, 'unverified river gradient material');
      assert.equal(river.mode, frame.gradientState.activation.mode, 'wrong river gradient mode');
    }
    assert.equal(frame.range.scene.deformationGradient?.drawn?.[frame.range.viewId]?.river,
      river?.mode ?? null, 'wrong drawn river gradient');
  }
  assert.equal(a.gradientState.activation.mode, 'reference', 'wrong reference mode');
  assert.equal(b.gradientState.activation.mode, 'factored', 'wrong candidate mode');
  assert.equal(!!a.gradientState.activation.river, !!b.gradientState.activation.river, 'different river material presence');
  assert.deepEqual(a.range.viewId, b.range.viewId, 'different view');
  assert.deepEqual(a.range.narrative, b.range.narrative, 'different narrative');
}

// Timer queries cover each three.js scene render, split into terrain scenes
// and other scenic work. They include trees/cast in those terrain scenes;
// they do not isolate the gradient or cover output Canvas2D compositing.
function installGradientProbe() {
  const scene = window.__SMW.sim.biomes.rangePresentation.scene, renderer = scene.renderer;
  const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const render = renderer.render.bind(renderer), pending = [], frames = [];
  let current = null, active = false;
  renderer.info.autoReset = false;
  const kindOf = s => [...scene.prepared.values()].some(p => s === p.depthScene
    || Object.values(p.scenes || {}).includes(s) || Object.values(p.depthScenes || {}).includes(s)
    || (p.fringeTravel || []).some(f => f.scene === s)) ? 'terrain' : 'other';
  renderer.render = (s, c) => {
    if (!current || active) return render(s, c);
    const kind = kindOf(s), before = { ...renderer.info.render }, query = ext ? gl.createQuery() : null;
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    const t0 = performance.now(); active = true;
    try { return render(s, c); }
    finally {
      current.cpu[kind] += performance.now() - t0; active = false;
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ frame: current, kind, query }); current.queries++; }
      current.calls[kind] += renderer.info.render.calls - before.calls;
      current.triangles[kind] += renderer.info.render.triangles - before.triangles;
    }
  };
  const poll = () => {
    const disjoint = ext && gl.getParameter(ext.GPU_DISJOINT_EXT);
    for (let i = pending.length - 1; i >= 0; i--) {
      const { frame, kind, query } = pending[i];
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (disjoint) frame.disjoint = true;
      else frame.gpu[kind] += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      frame.resolved++; gl.deleteQuery(query); pending.splice(i, 1);
    }
  };
  window.__gradientProbe = {
    begin() { current = { cpu: { terrain: 0, other: 0 }, gpu: { terrain: 0, other: 0 }, calls: { terrain: 0, other: 0 },
      triangles: { terrain: 0, other: 0 }, queries: 0, resolved: 0, disjoint: false }; },
    end(extra) { frames.push(Object.assign(current, extra)); current = null; poll(); },
    async finish() {
      const t0 = performance.now();
      while (pending.length && performance.now() - t0 < 10000) { poll(); await new Promise(r => setTimeout(r, 16)); }
      const result = frames.splice(0).map(f => ({ ...f,
        gpuComplete: f.queries > 0 && f.resolved === f.queries && !f.disjoint }));
      // Unresolved queries are invalid samples; delete them before the next batch.
      for (const { query } of pending.splice(0)) gl.deleteQuery(query);
      return result;
    },
  };
  return { timerQueries: !!ext };
}

async function gradientState(page, view, mode) {
  return page.evaluate(async ({ view, mode }) => {
    const smw = window.__SMW, scene = smw.sim.biomes.rangePresentation.scene;
    const prepared = scene.prepared.get(view), material = prepared?.material;
    if (!material) throw Error(`no prepared terrain material for ${view}`);
    const gl = scene.renderer.getContext();
    const activationOf = m => {
      const programs = [...(scene.renderer.properties.get(m)?.programs?.values() || [])];
      const define = !!m.defines?.FACTORED_DEFORM_GRAD, actual = m.userData.deformationGradient;
      return { mode: actual, define, linkedPrograms: programs.length,
        verified: actual === mode && define === (mode === 'factored') && programs.length > 0
          && programs.every(p => gl.getProgramParameter(p.program, gl.LINK_STATUS)) };
    };
    const activation = activationOf(material);
    const bandsUseMaterial = ['far', 'mid', 'near'].every(b => prepared.scenes[b].children.some(mesh => [].concat(mesh.material).includes(material)));
    activation.verified &&= bandsUseMaterial;
    activation.river = prepared.riverMaterial ? activationOf(prepared.riverMaterial) : null;
    if (activation.river) activation.river.verified &&= Object.entries(prepared.riverGeometries || {}).every(([band, geo]) => !geo
      || prepared.scenes[band].children.some(mesh => [].concat(mesh.material).includes(prepared.riverMaterial)));
    if (!activation.verified || activation.river && !activation.river.verified) {
      throw Error(`gradient activation failed: ${JSON.stringify(activation)}`);
    }
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
      .map(v => v.toString(16).padStart(2, '0')).join('');
    // Hash actual current buffers, including seam/river meshes. Re-reading
    // each capture catches a late rebuild instead of reusing stale evidence.
    const geometry = {};
    for (const group of ['geometries', 'fringes', 'riverGeometries', 'riverFringeGeometries']) {
      geometry[group] = {};
      for (const [band, geo] of Object.entries(prepared[group] || {})) {
        if (!geo) continue;
        geometry[group][band] = {};
        for (const [key, attr] of Object.entries({ ...geo.attributes, index: geo.index })) {
          if (!attr) continue;
          const a = attr.array;
          geometry[group][band][key] = { count: attr.count, itemSize: attr.itemSize,
            sha256: await hash(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)) };
        }
      }
    }
    const uniforms = {};
    for (const [key, uniform] of Object.entries(prepared.uniforms)) {
      if (!/^u(Deform|Melody|LandDance|TourEye|LandRise|Glacier|HeightRange|GridOrigin|GridExtent|Texel)/.test(key)) continue;
      const value = uniform.value;
      uniforms[key] = value?.toArray ? value.toArray() : value;
    }
    const c = scene.camera;
    return { activation, geometry, uniforms,
      vertexShaderSha256: await hash(new TextEncoder().encode(material.vertexShader)),
      camera: { position: c.position.toArray(), quaternion: c.quaternion.toArray(), projection: c.projectionMatrix.toArray(), matrixWorld: c.matrixWorld.toArray() } };
  }, { view, mode });
}

// Decode actual saved PNGs at full output size; the existing 64x36 thumbnail
// metric cannot detect fine normal/shading differences. Values are RGB 0..255.
async function comparePngs(page, reference, candidate) {
  return page.evaluate(async ({ reference, candidate }) => {
    const decode = async data => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(reference), b = await decode(candidate);
    if (a.width !== b.width || a.height !== b.height) throw Error('incompatible PNG sizes');
    let absolute = 0, squared = 0, maximum = 0, changed = 0;
    for (let i = 0; i < a.pixels.length; i += 4) {
      let pixelMax = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.pixels[i + c] - b.pixels[i + c]); absolute += d; squared += d * d; pixelMax = Math.max(pixelMax, d);
      }
      maximum = Math.max(maximum, pixelMax); if (pixelMax > 2) changed++;
    }
    const pixels = a.width * a.height;
    return { width: a.width, height: a.height, meanAbsoluteRgb: absolute / (pixels * 3),
      rootMeanSquareRgb: Math.sqrt(squared / (pixels * 3)), maxRgb: maximum, changedFractionOver2: changed / pixels };
  }, { reference, candidate });
}

export function summarizeGradientFrames(frames) {
  const valid = frames.filter(f => f.gpuComplete);
  return { frames: frames.length, validGpuSamples: valid.length,
    gpuTerrainMs: gradientStats(valid.map(f => f.gpu.terrain)), gpuOtherMs: gradientStats(valid.map(f => f.gpu.other)),
    frameSubmissionMs: gradientStats(frames.map(f => f.frameMs)), jsTerrainMs: gradientStats(frames.map(f => f.cpu.terrain)),
    callsTerrain: gradientStats(frames.map(f => f.calls.terrain)), trianglesTerrain: gradientStats(frames.map(f => f.triangles.terrain)) };
}

function summaryMarkdown(report) {
  const lines = ['# Deformation gradient comparison', '', `Status: ${report.status}.`,
    ...(report.error ? ['', `Failure: ${report.error.split('\n')[0]}`] : []), '',
    `Renderer: ${report.environment?.gl || 'unobserved'}${report.software ? ' (software rendering)' : ''}.`,
    'Full-resolution image error measures RGB differences, not artistic quality.', '',
    '| mode | valid GPU samples | terrain scene GPU p50 / p95 ms | frame submission p50 ms |', '|---|---:|---:|---:|'];
  const value = n => Number.isFinite(n) ? n.toFixed(3) : 'unavailable';
  for (const run of report.runs) {
    const s = run.steady;
    lines.push(`| ${run.mode} | ${s?.validGpuSamples ?? 0} | ${value(s?.gpuTerrainMs?.p50)} / ${value(s?.gpuTerrainMs?.p95)} | ${value(s?.frameSubmissionMs?.p50)} |`);
  }
  lines.push('', '| time ms | exercised inputs | identical PNG | RGB MAE / RMSE / max | pixels changed >2 |', '|---:|---|---|---:|---:|');
  for (const pair of report.comparison) lines.push(`| ${pair.timeMs} | ${pair.gradientExercised} | ${pair.identical} | ${value(pair.error.meanAbsoluteRgb)} / ${value(pair.error.rootMeanSquareRgb)} / ${pair.error.maxRgb} | ${(pair.error.changedFractionOver2 * 100).toFixed(3)}% |`);
  lines.push('', ...report.limitations.map(s => `- ${s}`), '');
  return lines.join('\n');
}

export async function runGradientCompare(args) {
  const out = path.resolve(args.out);
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.mkdir(out);
  const settings = { width: 1280, height: 720, seed: 315, quality: 0, experience: 'landscape', view: args.view,
    pace: 3, tour: 'off', presentation: { version: 2, look: 'pixel', quality: 'auto', palette: 'world',
      dither: .35, ditherMode: 'selective', pixelGrid: 'classic', pixelScale: 'original', scaling: 'fit' } };
  const dt = 1000 / 60, lastCheckpoint = args.times.at(-1);
  const sequenceTimes = Array.from({ length: 6 }, (_, i) => lastCheckpoint + (i + 1) * dt);
  const captureTimes = [...new Set([...args.times, ...sequenceTimes])].sort((a, b) => a - b);
  const report = { version: 1, status: 'failed', createdAt: new Date().toISOString(), settings,
    schedule: { checkpointsMs: args.times, sequence: { startMs: sequenceTimes[0], frames: 6, fps: 60,
      purpose: 'Matched consecutive rendered images after the final checkpoint; not live frame delivery.' }, captureTimesMs: captureTimes,
    warmupFrames: 30, steadyFrames: args.frames, steadyStartMs: captureTimes.at(-1) + 31 * dt },
    args, runs: [], comparison: [], limitations: [
      'One bounded view and generated diagnostic music unless --audio is supplied; not representative genre/device coverage.',
      'Headless fixed-clock frames; no live playback, display compositor, physical panel or listener review.',
      'GPU queries cover terrain scenes including trees/cast and depth passes, not the gradient alone or Canvas2D output.',
      'Frame/JS times measure CPU submission; they are not completed GPU work or delivered FPS.',
      'Reference then candidate, one warm steady batch per mode; no hardware performance conclusion from software timing or a single pair.',
      'Exercised-input checks require non-flat rise and nonzero deformation/dance uniforms; they do not prove a visible normal change at every pixel.',
      'Image error describes full output RGB differences; an artistic verdict remains unreviewed.' ] };
  let server, browser;
  try {
    const audio = path.join(out, `audio${args.audio ? path.extname(args.audio) : '.wav'}`);
    if (args.audio) await fs.copyFile(path.resolve(args.audio), audio);
    else execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audio, '120', '40']);
    report.song = { file: path.basename(audio), sha256: sha256(await fs.readFile(audio)), generated: !args.audio };
    const snapshot = await snapshotSource(root);
    report.source = { digest: snapshot.digest, hashes: snapshot.hashes,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() };
    server = await serveSnapshot(snapshot);
    const launchArgs = [...(args.hardware ? ['--enable-gpu', '--ignore-gpu-blocklist']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--mute-audio'];
    report.launchArgs = launchArgs;
    await fs.mkdir(path.join(out, 'frames'));
    for (const mode of MODES) {
      const run = { mode, captures: [], errors: [], warnings: [], events: [], loadedFiles: new Set() };
      report.runs.push(run);
      let loaded, failed = false;
      try {
        browser = await chromium.launch({ headless: true, ...(args.browser ? { executablePath: args.browser } : {}), args: launchArgs });
        const version = browser.version();
        if (report.browser) assert.equal(report.browser, version, 'different browser versions'); else report.browser = version;
        loaded = await openEvaluationSong(browser, { url: server.url, audioPath: audio,
          settings: { ...settings, debug: { deformGradient: mode } }, diagnostics: run });
        run.environment = loaded.environment;
        if (report.environment) assert.deepEqual(report.environment, run.environment, 'different render environment');
        else report.environment = run.environment;
        report.software = SOFTWARE.test(run.environment.gl || '');
        if (args.hardware) assert.equal(report.software, false, `hardware required, got ${run.environment.gl}`);
        assert.ok(captureTimes.every(t => Number.isFinite(t) && t >= 0)
          && captureTimes.at(-1) + (30 + args.frames) * dt < loaded.durationMs,
        'capture sequence, warmup or steady frames exceed audio duration');
        run.durationMs = loaded.durationMs;
        for (const timeMs of captureTimes) {
          const frame = await renderEvaluationFrame(loaded.page, { timeMs, save: true, checkpoint: true, clips: [] }, settings);
          assert.equal(blankFrame(frame.thumbnail), false, `blank ${mode}@${timeMs}`);
          frame.gradientState = await gradientState(loaded.page, args.view, mode);
          frame.gradientExercise = assessGradientExercise(frame.gradientState.uniforms);
          const png = frame.pngData; delete frame.pngData;
          frame.png = `frames/${mode}-${timeMs}.png`; frame.sha256 = sha256(Buffer.from(png, 'base64'));
          await fs.writeFile(path.join(out, frame.png), Buffer.from(png, 'base64'));
          if (mode === 'factored') {
            const reference = report.runs[0].captures.find(f => f.timeMs === timeMs);
            assertGradientFrameMatch(reference, frame);
            report.comparison.push({ timeMs, reference: reference.png, candidate: frame.png, identical: reference.sha256 === frame.sha256,
              gradientExercised: reference.gradientExercise.exercised && frame.gradientExercise.exercised,
              error: await comparePngs(loaded.page, (await fs.readFile(path.join(out, reference.png))).toString('base64'), png) });
          }
          run.captures.push(frame);
          await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, (_, v) => v instanceof Set ? [...v].sort() : v, 2));
        }
        run.probe = await loaded.page.evaluate(installGradientProbe);
        const frames = await loaded.page.evaluate(async ({ start, count }) => {
          const smw = window.__SMW, probe = window.__gradientProbe, dt = 1000 / 60;
          for (let i = 0; i < 30; i++) smw.renderExportFrame(start + i * dt);
          for (let i = 0; i < count; i++) {
            probe.begin(); const t0 = performance.now(), timeMs = start + (30 + i) * dt;
            smw.renderExportFrame(timeMs); probe.end({ frameMs: performance.now() - t0, timeMs });
            if (smw.perfLevel !== 0 || !smw.rangeState.active) throw Error('inactive scene or quality drift during timing');
          }
          return probe.finish();
        }, { start: captureTimes.at(-1) + dt, count: args.frames });
        run.steadyFrames = frames; run.steady = summarizeGradientFrames(frames);
        assert.ok(frames.every(f => f.calls.terrain > 0), 'no terrain scene draws during timing');
        run.steadyState = await gradientState(loaded.page, args.view, mode);
      } catch (error) { failed = true; throw error; }
      finally {
        await loaded?.context.close(); await loaded?.browserDiagnostics.dispose(); await browser?.close(); browser = null;
        run.loadedFiles = [...run.loadedFiles].sort();
        finalizeBrowserDiagnostics(run, report, { preserveFailure: failed });
      }
    }
    assert.deepEqual(report.runs[0].loadedFiles, report.runs[1].loadedFiles, 'different loaded assets');
    assert.equal(report.runs[0].durationMs, report.runs[1].durationMs, 'different decoded audio duration');
    for (const key of ['camera', 'uniforms', 'geometry', 'vertexShaderSha256']) {
      assert.deepEqual(report.runs[0].steadyState[key], report.runs[1].steadyState[key], `different steady ${key}`);
    }
    const drawSchedule = run => run.steadyFrames.map(({ timeMs, calls, triangles }) => ({ timeMs, calls, triangles }));
    assert.deepEqual(drawSchedule(report.runs[0]), drawSchedule(report.runs[1]), 'different timing draw schedule');
    assertGradientWasExercised(report.comparison);
    report.source.changedDuringRun = (await snapshotSource(root)).digest !== report.source.digest;
    assert.equal(report.source.changedDuringRun, false, 'source changed during capture');
    report.status = 'passed';
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    await browser?.close(); await server?.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(out, 'summary.md'), summaryMarkdown(report));
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGradientCompare(parseGradientArgs(process.argv.slice(2))).then(report => {
    console.log(`${report.status}: ${path.join(report.args.out, 'summary.md')}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
