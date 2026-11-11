// What one Landscape frame asks of the GPU and of the 2D canvas, pass by
// pass, counted from the real app in headless Chromium (frame cost audit,
// docs/frame-cost-audit-2026-11-10.md).
//
//   node tools/range-frame-cost.mjs --out .smoke/<run>
//        (--view <catalog view id> | --song-range force | --song-range-layout <pilot id>)
//        [--audio song.wav] [--label NAME] [--times 12000,86000] [--quality 0]
//        [--dry] [--warm 2] [--repeats 1] [--profile N] [--png]
//
// Counts are exact and hardware independent: draw calls, triangles (instanced
// ones, the forest, apart), uniform calls, uploads, readbacks and 2D canvas
// operations, attributed to the scene method that issued them. Use them for
// before/after comparisons of geometry and pass work.
//
// --dry counts every draw call and every filtered 2D canvas operation and
// then skips it, so the software rasterizer has almost nothing to do and a
// frame returns in well under a second. Per-pass WebGL counts of a dry frame
// equal a full render's (the audit records the check). Pixels are empty, so
// work that depends on reading pixels back (the crest line's 2D canvas work)
// is smaller than in a real frame.
//
// Times are this host only. hostMs is one frame on the main thread; in a
// full render nearly all of it is software WebGL (SwiftShader) finishing
// inside a readback. "outside waits" subtracts the calls that wait for
// rendering and leaves JavaScript and command encoding. Software rendering
// is fragment bound, so its milliseconds say nothing about a GPU: take
// hardware conclusions from hardware runs.
//
// --profile N also saves a V8 CPU profile over N consecutive frames
// (<label>.cpuprofile; read it with tools/cpuprofile-top.mjs). --png saves
// each measured frame (full renders only) for pixel comparisons.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong } from './lib/visual-evaluation-browser.mjs';
import { normalizeManifest } from './lib/visual-evaluation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Runs before any page script: count every WebGL2 call by kind, attributed to
// the label on top of window.__gl.labels, and time the calls that can make
// the main thread wait for rendering.
export function installCounters({ dry = false } = {}) {
  const C = window.__gl = { dry, labels: ['other'], by: {}, canvas2d: {}, waits: {}, presenter: {},
    reset() {
      this.by = {}; this.waits = {}; this.presenter = { draws: 0, textureUploads: 0, getErrorCalls: 0 };
      this.canvas2d = { ops: 0, filteredOps: 0, filteredMs: 0, drawImage: 0, drawImageFromGL: 0, getImageData: 0, putImageData: 0 };
    } };
  C.reset();
  const bucket = () => (C.by[C.labels[C.labels.length - 1]] ||= { draws: 0, triangles: 0, instancedTriangles: 0, lines: 0, points: 0, instancedDraws: 0, uniformCalls: 0,
    programBinds: 0, framebufferBinds: 0, clears: 0, textureUploads: 0, textureUploadBytes: 0, bufferUploads: 0, bufferUploadBytes: 0, readbacks: 0, blits: 0 });
  const waited = (key, ms) => { const w = (C.waits[key] ||= { calls: 0, ms: 0 }); w.calls++; w.ms += ms; };
  const P = WebGL2RenderingContext.prototype;
  // Instanced draws are the forest (trees and billboards); the rest is
  // terrain, water and full-screen passes.
  const primitives = (b, mode, count, instances = null) => {
    const n = instances ?? 1;
    const triangles = mode === 4 ? Math.floor(count / 3) * n : mode === 5 || mode === 6 ? Math.max(0, count - 2) * n : 0;
    b.triangles += triangles;
    if (instances != null) b.instancedTriangles += triangles;
    if (mode === 1 || mode === 2 || mode === 3) b.lines += count * n;
    else if (mode === 0) b.points += count * n;
  };
  const wrap = (name, note, { draw = false, wait = null } = {}) => {
    const original = P[name];
    if (typeof original !== 'function') return;
    P[name] = function (...a) {
      note?.(bucket(), a);
      if (draw && C.dry) return undefined;
      if (!wait) return original.apply(this, a);
      const start = performance.now();
      try { return original.apply(this, a); } finally { waited(typeof wait === 'function' ? wait(a) : wait, performance.now() - start); }
    };
  };
  wrap('drawElements', (b, [mode, count]) => { b.draws++; primitives(b, mode, count); }, { draw: true });
  wrap('drawRangeElements', (b, [mode, , , count]) => { b.draws++; primitives(b, mode, count); }, { draw: true });
  wrap('drawArrays', (b, [mode, , count]) => { b.draws++; primitives(b, mode, count); }, { draw: true });
  wrap('drawElementsInstanced', (b, [mode, count, , , n]) => { b.draws++; b.instancedDraws++; primitives(b, mode, count, n); }, { draw: true });
  wrap('drawArraysInstanced', (b, [mode, , count, n]) => { b.draws++; b.instancedDraws++; primitives(b, mode, count, n); }, { draw: true });
  for (const name of Object.getOwnPropertyNames(P)) if (/^uniform(?!Block)/.test(name) && typeof P[name] === 'function') wrap(name, (b) => { b.uniformCalls++; });
  wrap('useProgram', (b) => { b.programBinds++; });
  wrap('bindFramebuffer', (b) => { b.framebufferBinds++; });
  wrap('clear', (b) => { b.clears++; });
  const viewBytes = (a) => a.find((x) => ArrayBuffer.isView(x))?.byteLength ?? 0;
  const fromCanvas = (a) => a.some((x) => x instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && x instanceof OffscreenCanvas));
  for (const name of ['texImage2D', 'texSubImage2D']) wrap(name, (b, a) => { b.textureUploads++; b.textureUploadBytes += viewBytes(a); },
    { wait: (a) => (fromCanvas(a) ? `gl.${name}(canvas)` : `gl.${name}(data)`) });
  for (const name of ['texImage3D', 'texSubImage3D']) wrap(name, (b, a) => { b.textureUploads++; b.textureUploadBytes += viewBytes(a); });
  // bufferData(target, sizeOrData, usage[, srcOffset, length]) and
  // bufferSubData(target, dstByteOffset, srcData[, srcOffset, length]): the
  // optional offset and length count elements of a typed-array source.
  const sourceBytes = (data, srcOffset = 0, length = 0) => {
    if (data == null) return 0;
    if (!ArrayBuffer.isView(data)) return data.byteLength ?? 0;
    const elementBytes = data.BYTES_PER_ELEMENT ?? 1, elements = data.byteLength / elementBytes;
    return Math.max(0, length > 0 ? Math.min(length, elements - srcOffset) : elements - srcOffset) * elementBytes;
  };
  wrap('bufferData', (b, a) => { b.bufferUploads++; b.bufferUploadBytes += typeof a[1] === 'number' ? a[1] : sourceBytes(a[1], a[3], a[4]); });
  wrap('bufferSubData', (b, a) => { b.bufferUploads++; b.bufferUploadBytes += sourceBytes(a[2], a[3], a[4]); });
  for (const name of ['readPixels', 'getBufferSubData']) wrap(name, (b) => { b.readbacks++; }, { wait: `gl.${name}` });
  for (const name of ['blitFramebuffer', 'copyTexSubImage2D', 'copyTexImage2D']) wrap(name, (b) => { b.blits++; });
  for (const name of ['finish', 'clientWaitSync', 'getError', 'checkFramebufferStatus']) wrap(name, null, { wait: `gl.${name}` });
  // WEBGL_multi_draw draws arrive through the extension object.
  const getExtension = P.getExtension;
  P.getExtension = function (name) {
    const ext = getExtension.call(this, name);
    if (ext && name === 'WEBGL_multi_draw' && !ext.__counted) {
      ext.__counted = true;
      for (const method of ['multiDrawElementsWEBGL', 'multiDrawArraysWEBGL']) {
        const original = ext[method];
        if (!original) continue;
        ext[method] = function (mode, ...a) {
          const b = bucket(), elements = method.includes('Elements');
          const counts = elements ? a[0] : a[2], offset = elements ? a[1] : a[3], n = a[a.length - 1];
          b.draws++;
          for (let i = 0; i < n; i++) primitives(b, mode, counts[offset + i]);
          return C.dry ? undefined : original.call(this, mode, ...a);
        };
      }
    }
    return ext;
  };
  // WebGL1 contexts are the Cinematic presenter (src/render/CinematicPixel.js):
  // one upload of the grid and one full-screen draw per frame. Kept out of
  // the scene's pass counts; its waiting calls are timed as gl1.*.
  if (typeof WebGLRenderingContext !== 'undefined') {
    const P1 = WebGLRenderingContext.prototype;
    const wrap1 = (name, note, { draw = false, wait = null } = {}) => {
      const original = P1[name];
      if (typeof original !== 'function') return;
      P1[name] = function (...a) {
        note?.(C.presenter, a);
        if (draw && C.dry) return undefined;
        if (!wait) return original.apply(this, a);
        const start = performance.now();
        try { return original.apply(this, a); } finally { waited(typeof wait === 'function' ? wait(a) : wait, performance.now() - start); }
      };
    };
    for (const name of ['drawArrays', 'drawElements']) wrap1(name, (p) => { p.draws++; }, { draw: true });
    for (const name of ['texImage2D', 'texSubImage2D']) wrap1(name, (p) => { p.textureUploads++; },
      { wait: (a) => (fromCanvas(a) ? `gl1.${name}(canvas)` : `gl1.${name}(data)`) });
    for (const name of ['readPixels', 'finish', 'getError', 'checkFramebufferStatus']) wrap1(name, (p) => { if (name === 'getError') p.getErrorCalls++; }, { wait: `gl1.${name}` });
  }
  // 2D canvas work that composes or reads the scene, on-screen and offscreen
  // contexts alike. An operation issued while the context has a filter is
  // counted apart: each one is rasterized through that filter on its own.
  const contexts = [CanvasRenderingContext2D.prototype];
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') contexts.push(OffscreenCanvasRenderingContext2D.prototype);
  for (const D of contexts) {
    for (const name of ['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData', 'getImageData']) {
      const original = D[name];
      D[name] = function (...a) {
        const c = C.canvas2d;
        if (name !== 'getImageData') c.ops++;
        if (name === 'drawImage') { c.drawImage++; if (a[0]?.__isGL) c.drawImageFromGL++; }
        if (name === 'getImageData') c.getImageData++;
        if (name === 'putImageData') c.putImageData++;
        const filtered = name !== 'getImageData' && name !== 'clearRect' && this.filter && this.filter !== 'none';
        const wait = name === 'getImageData' ? '2d.getImageData' : name === 'drawImage' && a[0]?.__isGL ? '2d.drawImage(gl canvas)' : null;
        if (!filtered && !wait) return original.apply(this, a);
        // A dry run counts a filtered operation and skips it, like a draw
        // call: the software blur would otherwise take minutes per frame.
        if (filtered && C.dry) { c.filteredOps++; return undefined; }
        const start = performance.now();
        try { return original.apply(this, a); } finally {
          const ms = performance.now() - start;
          if (filtered) { c.filteredOps++; c.filteredMs += ms; }
          if (wait) waited(wait, ms);
        }
      };
    }
  }
  const canvases = [HTMLCanvasElement.prototype];
  if (typeof OffscreenCanvas !== 'undefined') canvases.push(OffscreenCanvas.prototype);
  for (const K of canvases) {
    const getContext = K.getContext;
    K.getContext = function (type, ...a) {
      const context = getContext.call(this, type, ...a);
      if (context && /webgl/.test(type)) this.__isGL = true;
      return context;
    };
  }
}

// After the song is ready: name the scene's passes.
export function labelPasses() {
  const scene = window.__SMW.sim.biomes.rangePresentation.scene, C = window.__gl;
  const label = (object, method, tag) => {
    const original = object?.[method];
    if (typeof original !== 'function') return;
    object[method] = function (...a) {
      C.labels.push(typeof tag === 'function' ? tag(a) : tag);
      try { return original.apply(this, a); } finally { C.labels.pop(); }
    };
  };
  label(scene, 'renderPartition', (a) => `partition:${a[1]}`);
  label(scene, '_prepareMirror', 'mirror');
  label(scene, 'renderWater', (a) => (a[2] > scene.size.width ? 'water:output' : 'water:grid'));
  label(scene, '_probeCrest', 'crest');
  label(scene, '_probeFineCrest', 'crest:fine');
  label(scene, 'readCrestProbe', 'crest:read');
  label(scene, 'renderGround', 'ground');
  label(scene, 'captureBackdrop', 'backdrop');
  label(scene, 'prepareShafts', 'shafts');
  label(scene, 'renderDirectShaft', 'shafts');
  label(scene, '_renderOwnership', 'ownership');
  label(scene, '_drawRiseGround', 'rise-ground');
  if (scene.shafts) label(scene.shafts, 'render', 'shafts');
}

/** Export-clock spacing of consecutive frames: just over one 60 Hz step, so
 *  every frame advances the simulation. */
export const FRAME_STEP_MS = 17;

/**
 * When each measurement row starts, and when the profile may start. The
 * export clock only runs forward (stepExportClock in
 * src/render/BulkExport.js): a row starts 400 ms after the row before it, or
 * right after that row's last frame when its warm-up and repeats ran longer,
 * and never at a time the clock has already passed.
 */
export function rowSchedule(times, qualities, { warm = 2, repeats = 1 } = {}) {
  const rows = [];
  let offset = 0, free = -Infinity;
  for (const base of times) for (const quality of qualities) {
    const startMs = Math.max(base + offset, free);
    rows.push({ base, quality, startMs });
    offset += 400;
    free = startMs + (warm + repeats + 1) * FRAME_STEP_MS;
  }
  return { rows, profileStartMs: Math.max((times[times.length - 1] ?? 0) + offset + 500, free) };
}

async function measure(page, timeMs, quality, { warm, repeats }) {
  return page.evaluate(async ({ timeMs, quality, warm, repeats, stepMs }) => {
    const smw = window.__SMW, C = window.__gl;
    smw.perf.setFixtureLevel(quality);
    // Draw at `t` and confirm the export clock is there: a request behind the
    // clock would silently redraw a later state under an earlier label.
    const draw = (t) => {
      const clock = smw.renderExportFrame(t);
      if (Math.abs(clock.timeMs - t) > 1000 / 60 + 0.01) throw new Error(`export clock reached ${clock.timeMs.toFixed(0)} ms for a frame requested at ${t} ms; it only runs forward`);
      return clock;
    };
    draw(timeMs);
    if (await smw.rangeSettle({ timeoutMs: 180000 })) draw(timeMs);
    // Warm: programs linked, targets allocated, caches filled.
    for (let i = 1; i <= warm; i++) draw(timeMs + i * stepMs);
    const frames = [];
    for (let i = 1; i <= repeats; i++) {
      C.reset();
      const start = performance.now();
      const clock = draw(timeMs + (warm + i) * stepMs);
      frames.push({ hostMs: performance.now() - start, clockMs: clock.timeMs, passes: structuredClone(C.by), canvas2d: { ...C.canvas2d }, presenter: { ...C.presenter }, waits: structuredClone(C.waits) });
    }
    const state = structuredClone(smw.rangeState);
    const presentation = smw.sim.biomes.rangePresentation, scene = presentation.scene, frame = presentation.frame;
    const p = scene.prepared.get(state.viewId);
    const strides = {};
    for (const t of p?.manifest?.tiles || []) { const s = t.lod?.[scene.budget] ?? t.stride; strides[s] = (strides[s] || 0) + 1; }
    return { timeMs, clockMs: frames[frames.length - 1]?.clockMs ?? null, quality, viewId: state.viewId, rise01: frame?.rise01 ?? null, slotRise01: frame?.slotRise01 ?? null, frames,
      scene: { size: { ...scene.size }, budget: scene.budget, crestProbeMode: scene.crestProbeMode ?? null },
      geometryTriangles: p ? Object.fromEntries(Object.entries(p.geometries || {}).map(([band, g]) => [band, (g.index?.count ?? 0) / 3])) : null,
      tiles: p?.manifest?.tiles?.length ?? null, tilesVisible: p?.manifest?.tiles?.filter((t) => t.visible !== false).length ?? null, strides,
      trees: p?.stats?.trees ?? null, mirrorAmount: p?.uniforms?.uMirrorAmount?.value ?? null, slotRise: !!p?.slotRise, riseGround: !!p?.riseGround,
      night: smw.sim.biomes.rangeSkyLayer?.night ?? null,
      crest: state.crest ?? null, timings: state.timings ?? null, prepareLog: state.scene?.prepareLog ?? null, songRange: state.songRange ?? null };
  }, { timeMs, quality, warm, repeats, stepMs: FRAME_STEP_MS });
}

/** The AudioContext rate the song is analysed at. The song analysis, and with
 *  it a composed stage and the camera, depend on the rate, and a headless
 *  AudioContext takes the host's output device rate unless pinned: the same
 *  WAV composed song-range-911f810a0bd86424 at 44.1 kHz (the audit's host),
 *  song-range-61a1efc03691a322 at 48 kHz and song-range-8a5bb600fa6dcb9e at
 *  96 kHz. 44.1 kHz reproduces docs/frame-cost-audit-2026-11-10.md exactly.
 *  landscape-review and range-live-callbacks pin 48 kHz, yet a live review of
 *  the same WAV composed another stage again, so a dry count at any rate is
 *  not yet the live run's stage. */
export const DEFAULT_SAMPLE_RATE = 44100;

export function parseArgs(argv) {
  const a = { times: '12000,86000', quality: '0', warm: '2', repeats: '1', profile: '0', seconds: '90', sampleRate: String(DEFAULT_SAMPLE_RATE), dry: false, png: false };
  const keys = { '--out': 'out', '--audio': 'audio', '--view': 'view', '--song-range': 'songRange', '--song-range-layout': 'songRangeLayout',
    '--label': 'label', '--times': 'times', '--quality': 'quality', '--warm': 'warm', '--repeats': 'repeats', '--profile': 'profile', '--seconds': 'seconds', '--sample-rate': 'sampleRate' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') { a.dry = true; continue; }
    if (argv[i] === '--png') { a.png = true; continue; }
    if (!keys[argv[i]]) throw new Error(`unknown argument ${argv[i]}`);
    a[keys[argv[i]]] = argv[++i];
  }
  if (!a.out) throw new Error('--out is required');
  if (!a.view && !a.songRange && !a.songRangeLayout) throw new Error('give --view, --song-range or --song-range-layout');
  if (a.dry && a.png) throw new Error('--png needs a full render: drop --dry');
  if (!/^\d+$/.test(a.sampleRate) || Number(a.sampleRate) < 8000 || Number(a.sampleRate) > 192000) throw new Error('--sample-rate must be an integer from 8000 to 192000');
  return { ...a, times: a.times.split(',').map(Number).sort((x, y) => x - y), quality: a.quality.split(',').map(Number),
    warm: Number(a.warm), repeats: Number(a.repeats), profile: Number(a.profile), seconds: Number(a.seconds), sampleRate: Number(a.sampleRate) };
}

/** A frame's host time outside the calls that wait for rendering: JavaScript
 *  and command encoding on this host's main thread. */
export function mainThreadMs(frame) {
  return frame.hostMs - Object.values(frame.waits).reduce((sum, w) => sum + w.ms, 0);
}

/** One frame's passes as text, heaviest first, and the frame totals. */
export function passTable(frame) {
  const lines = [], total = { draws: 0, triangles: 0, instancedTriangles: 0, uniformCalls: 0 };
  for (const [name, b] of Object.entries(frame.passes).sort((x, y) => y[1].triangles - x[1].triangles)) {
    for (const k of Object.keys(total)) total[k] += b[k];
    lines.push(`  ${name.padEnd(16)} ${String(b.draws).padStart(4)} draws ${String(b.triangles).padStart(9)} triangles (${String(b.instancedTriangles).padStart(8)} instanced) ${String(b.uniformCalls).padStart(5)} uniform calls`
      + `${b.readbacks ? `  ${b.readbacks} readback` : ''}${b.textureUploads ? `  ${b.textureUploads} texture upload` : ''}`);
  }
  return { total, text: lines.join('\n') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  const label = args.label || args.view || (args.songRangeLayout ? `stage-${args.songRangeLayout}` : 'stage');
  await fs.mkdir(out, { recursive: true });
  const audio = args.audio ? path.resolve(args.audio) : path.join(out, `input-${args.seconds}s.wav`);
  if (!args.audio) await promisify(execFile)(process.execPath, [path.join(root, 'tools/gen-pilot-wav.mjs'), audio, String(args.seconds)]);
  const debug = { ...(args.songRange ? { songRange: args.songRange } : {}), ...(args.songRangeLayout ? { songRangeLayout: args.songRangeLayout } : {}) };
  const { settings } = normalizeManifest({ version: 1, settings: { width: 1280, height: 720, seed: 315, quality: 0, fps: 12, mode: 'sparse',
    experience: 'landscape', pace: 3, tour: 'shots',
    presentation: { version: 2, look: 'cinematic', quality: 'auto', pixelGrid: 'detailed', pixelScale: 'original', scaling: 'fit' },
    ...(args.view ? { view: args.view } : { view: null, biome: null, debug }) },
  songs: [{ id: 'cost', fixture: 'contrast', seconds: args.seconds, timesMs: args.times, clips: [] }] });
  const report = { label, dry: args.dry, sampleRate: args.sampleRate, settings,
    note: 'Counts are exact. Times are this host only (software WebGL); take hardware conclusions from hardware runs.', rows: [] };
  const save = () => fs.writeFile(path.join(out, `${label}.json`), `${JSON.stringify(report, null, 1)}\n`);
  const server = await serveSnapshot(await snapshotSource(root));
  // The server keeps the process alive: everything after it starts, the
  // browser launch included, runs inside the cleanup scope.
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      // Pin the audio rate (see DEFAULT_SAMPLE_RATE): a headless AudioContext
      // otherwise takes the host device's rate, and the composed stage follows it.
      await context.addInitScript((sampleRate) => {
        const Native = window.AudioContext;
        window.AudioContext = class extends Native { constructor(options = {}) { super({ ...options, sampleRate }); } };
      }, args.sampleRate);
      await context.addInitScript(installCounters, { dry: args.dry });
      return context;
    };
    const opened = Date.now();
    const loaded = await openEvaluationSong(browser, { url: server.url, audioPath: audio, settings,
      diagnostics: { errors: [], warnings: [], events: [], loadedFiles: new Set() } });
    report.environment = loaded.environment;
    report.openMs = Date.now() - opened;
    await loaded.page.evaluate(labelPasses);
    // The export clock only runs forward: times ascend, and each row draws
    // later than every frame of the one before it (rowSchedule).
    const schedule = rowSchedule(args.times, args.quality, args);
    for (const { base, quality, startMs } of schedule.rows) {
      const row = await measure(loaded.page, startMs, quality, args);
      if (args.png) {
        row.png = `${label}-q${quality}-${base}.png`;
        const url = await loaded.page.evaluate(() => document.querySelector('#stage').toDataURL('image/png'));
        await fs.writeFile(path.join(out, row.png), Buffer.from(url.split(',')[1], 'base64'));
      }
      report.rows.push(row);
      await save();
      const frame = row.frames[row.frames.length - 1], { total, text } = passTable(frame);
      const waits = Object.entries(frame.waits).filter(([, w]) => w.ms >= 1).map(([k, w]) => `${k} ${w.ms.toFixed(0)} ms`).join(', ');
      console.log(`${label} quality ${quality} at ${(row.timeMs / 1000).toFixed(1)} s, view ${row.viewId}, rise ${row.rise01?.toFixed(3)}: `
        + `${total.draws} draws, ${total.triangles} triangles (${total.instancedTriangles} instanced), ${total.uniformCalls} uniform calls, host ${frame.hostMs.toFixed(0)} ms, `
        + `outside waits ${mainThreadMs(frame).toFixed(0)} ms${waits ? ` (waits: ${waits})` : ''}\n${text}\n`
        + `  2D canvas: ${frame.canvas2d.ops} operations, ${frame.canvas2d.drawImage} drawImage, ${frame.canvas2d.getImageData} getImageData, `
        + `${frame.canvas2d.filteredOps} through a filter (${frame.canvas2d.filteredMs.toFixed(0)} ms on this host)`);
    }
    if (args.profile > 0) {
      const client = await loaded.page.context().newCDPSession(loaded.page);
      await client.send('Profiler.enable');
      await client.send('Profiler.setSamplingInterval', { interval: 200 });
      const start = schedule.profileStartMs;
      await loaded.page.evaluate((t) => { window.__SMW.perf.setFixtureLevel(0); window.__SMW.renderExportFrame(t); }, start);
      await client.send('Profiler.start');
      const hostMs = await loaded.page.evaluate(({ t, n, stepMs }) => {
        const begun = performance.now();
        for (let i = 1; i <= n; i++) window.__SMW.renderExportFrame(t + i * stepMs);
        return performance.now() - begun;
      }, { t: start, n: args.profile, stepMs: FRAME_STEP_MS });
      const { profile } = await client.send('Profiler.stop');
      report.profile = { frames: args.profile, hostMs, file: `${label}.cpuprofile` };
      await fs.writeFile(path.join(out, report.profile.file), JSON.stringify(profile));
      console.log(`profile: ${args.profile} frames in ${hostMs.toFixed(0)} ms, ${report.profile.file}`);
    }
    await loaded.context.close();
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
    await save();
  }
  console.log(`report: ${path.join(args.out, `${label}.json`)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
