import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREST_FILTER, CREST_TIER_ORDER, CREST_DARKEN, PROTECTED_HUES, PROTECTED_HUE_GAP, crestE, crestStroke, shoreStroke,
  filterSample, filterCrest, reconstructCrest, reownCrestCells, crestLineColor, shoreColor, snapCrestColor,
  nearProtectedHue, linkShoreChains,
} from '../src/render/CrestLine.js';
import { RangeCrest, CREST_GRID_SCAN_LEVEL } from '../src/world/alpine/RangeCrest.js';
import { PROBE_BAND_ROWS, PROBE_ROWS, PROBE_WATER_ROW, PROBE_WATER_SLOTS, probeRow } from '../src/world/alpine/CrestProbe.js';
import { compositePixelFrame } from '../src/render/PixelPresentation.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { compilePalette } from '../src/render/PaletteQuantize.js';
import { rgbToHsl } from '../src/utils/color.js';

const DT = 1 / 60;

function runFilter(samples, opts = CREST_FILTER) {
  const y = new Float32Array([NaN]), d = new Float32Array(1);
  return samples.map(x => { filterSample(y, d, 0, x, DT, opts); return y[0]; });
}

test('the crest filter passes kicks with at least 90% amplitude and at most one frame of lag', () => {
  for (const [amp, rise] of [[2, 2], [3, 3], [5, 4], [8, 6], [10, 8], [4, 1], [1.4, 2], [2, 3], [4, 5]]) {
    const raw = Array.from({ length: 60 }, (_, f) => f < 5 ? 0 : f < 5 + rise ? amp * (f - 4) / rise : amp * Math.exp(-(f - 4 - rise) / 10));
    const out = runFilter(raw);
    const rawPeak = Math.max(...raw), peak = Math.max(...out);
    assert.ok(peak >= 0.9 * rawPeak, `kick ${amp}px/${rise}f kept ${(peak / rawPeak * 100).toFixed(1)}%`);
    assert.ok(out.indexOf(peak) - raw.indexOf(rawPeak) <= 1, `kick ${amp}px/${rise}f peaked late`);
  }
  // A cut or a large kick (> fastPx in one frame) is passed through exactly.
  const out = runFilter([0, 0, 0, 6, 6]);
  assert.equal(out[3], 6);
});

test('the deadband suppresses sub-pixel crawl and most grid-row flips', () => {
  const jitter = Array.from({ length: 600 }, (_, f) => 10.5 + 0.3 * Math.sin(f * 1.7));
  const held = runFilter(jitter);
  assert.ok(held.every(v => v === held[0]), 'sub-deadband jitter must not move the line at all');
  // A crest flickering between two rows every frame is held near their middle.
  const flicker = runFilter(Array.from({ length: 120 }, (_, f) => 20 + (f % 2)));
  for (let i = 1; i < flicker.length; i++) assert.ok(Math.abs(flicker[i] - flicker[i - 1]) < 0.15, 'row flicker is absorbed');
  const drift = Array.from({ length: 600 }, (_, f) => 10 + 0.02 * f + 0.25 * Math.sin(f * 2.3));
  const out = runFilter(drift);
  const flips = a => a.slice(1).filter((v, i) => Math.round(v) !== Math.round(a[i])).length;
  assert.ok(flips(out) <= 0.4 * flips(drift), `flips ${flips(out)} vs raw ${flips(drift)}`);
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) < 0.35, 'leaving the deadband never jumps');
  assert.ok(Math.abs(out.at(-1) - drift.at(-1)) < 1, 'a slow drift is still followed');
});

test('a whole crest filters per column and clears columns that vanish', () => {
  const state = { y: new Float32Array(3).fill(NaN), d: new Float32Array(3) };
  filterCrest(state, Float32Array.from([1, 2, 3]), DT);
  filterCrest(state, Float32Array.from([1.2, NaN, 3]), DT);
  assert.equal(state.y[0], 1); assert.ok(Number.isNaN(state.y[1])); assert.equal(state.y[2], 3);
});

test('sub-cell reconstruction follows a shallow rasterized edge better than its rows', () => {
  for (const slope of [0.13, 0.23, -0.31, 0.47]) {
    const truth = x => 20 + slope * x;
    const rows = Float32Array.from({ length: 80 }, (_, i) => Math.ceil(truth(i + 0.5) - 0.5));
    const rebuilt = reconstructCrest(rows);
    let errRaw = 0, errRebuilt = 0, n = 0;
    for (let i = 8; i < 72; i++) { errRaw += Math.abs(rows[i] - truth(i + 0.5)); errRebuilt += Math.abs(rebuilt[i] - truth(i + 0.5)); n++; }
    assert.ok(errRebuilt / n < 0.12, `slope ${slope}: mean error ${(errRebuilt / n).toFixed(3)}`);
    assert.ok(errRebuilt < errRaw * 0.6, `slope ${slope}: ${errRebuilt} vs raw ${errRaw}`);
  }
  // Peaks keep their row instead of being lowered into a tent.
  const peak = reconstructCrest(Float32Array.from([12, 11, 10, 10, 10, 11, 12]));
  assert.deepEqual([...peak.slice(2, 5)], [10, 10, 10]);
  assert.ok(Number.isNaN(reconstructCrest(Float32Array.from([NaN, 3]))[0]));
});

test('the width and opacity schedule is monotonic by hierarchy, scales with output height and never pulses', () => {
  for (let e = 0; e <= 1.0001; e += 0.1) {
    let prev = null;
    for (const tier of CREST_TIER_ORDER) {
      const s = crestStroke(tier, e, 1080);
      if (prev) { assert.ok(s.width >= prev.width, `${tier} width at e=${e}`); assert.ok(s.alpha >= prev.alpha, `${tier} alpha at e=${e}`); }
      prev = s;
    }
  }
  for (const tier of CREST_TIER_ORDER) {
    let prev = crestStroke(tier, 0, 1080);
    for (let e = 0.1; e <= 1.0001; e += 0.1) {
      const s = crestStroke(tier, e, 1080);
      assert.ok(s.width >= prev.width && s.alpha >= prev.alpha); prev = s;
    }
  }
  assert.deepEqual(crestStroke('far', 0, 1080), { width: 1, alpha: 0.35 });
  assert.equal(crestStroke('near', 1, 1080).width, 3);
  assert.equal(crestStroke('mid', 0.5, 2160).width, 2 * crestStroke('mid', 0.5, 1080).width);
  assert.equal(crestStroke('far', 0, 360).width, 1, 'never thinner than one output pixel');
  assert.deepEqual(crestStroke('near', 0.4, 720), crestStroke('near', 0.4, 720), 'band, rank and output height only: no music input');
  assert.equal(crestE(1, 0), 0.6); assert.equal(crestE(0, 1), 0.4); assert.equal(crestE(NaN, 0.7), 0.7);
  assert.ok(shoreStroke(1).alpha > shoreStroke(0.5).alpha && shoreStroke(0.5).alpha > shoreStroke(0).alpha, 'near shores strongest');
});

// A grid of `width` columns, rows 0..rows-1; `land(i, r)` returns the colour
// of land cells (null: upper side, coloured `upper`).
function grid(width, rows, landRow, landColor, upper) {
  const data = new Uint8ClampedArray(width * rows * 4);
  for (let r = 0; r < rows; r++) for (let i = 0; i < width; i++) {
    const k = (r * width + i) * 4, c = r >= landRow(i) ? landColor(i, r) : upper;
    data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = c[3] ?? 255;
  }
  return data;
}

test('split cells never sample sky into land and cut the sky half away', () => {
  const W = 12, H = 20, landColors = new Set();
  const landColor = (i, r) => { const c = [80 + i, 120 + r, 60]; landColors.add(c.join()); return c; };
  const raw = Float32Array.from({ length: W }, (_, i) => 8 + (i > 5 ? 1 : 0));
  const line = Float32Array.from({ length: W }, (_, i) => 7.6 + 0.25 * i);
  const data = grid(W, H, i => raw[i], landColor, [0, 0, 0, 0]);
  const orig = data.slice(), split = new Uint8ClampedArray(data.length), crossed = new Int16Array(W);
  const written = reownCrestCells({ data, width: W, y0: 0, rows: H }, orig, split, line, raw, null, crossed);
  assert.ok(written > 0);
  for (let i = 0; i < W; i++) for (let r = 0; r < H; r++) {
    const k = (r * W + i) * 4, L = line[i];
    if (data[k + 3]) assert.ok(landColors.has(`${data[k]},${data[k + 1]},${data[k + 2]}`) || [...landColors].some(c => {
      const [a, b, cc] = c.split(',').map(Number); return Math.abs(a - data[k]) <= 1 && Math.abs(b - data[k + 1]) <= 1 && cc === data[k + 2];
    }), `grid cell ${i},${r} holds a non-land colour`);
    if (r + 1 <= L) assert.equal(data[k + 3], 0, `cell ${i},${r} fully above the line must be sky`);
    if (r >= L && r <= Math.floor(L) + 1) assert.equal(data[k + 3], 255, `cell ${i},${r} fully below the line must be land`);
    if (split[k + 3]) {
      assert.equal(r, crossed[i]);
      assert.equal(data[k + 3], 0, 'a crossed cell keeps its upper (sky) half in the grid');
      assert.ok(split[k] >= 80 && split[k + 1] >= 120 && split[k + 2] === 60, 'the lower half is land only');
    }
  }
  assert.ok([...crossed].some(r => r >= 0));
});

test('split halves average only equidistant cells on their own side', () => {
  const W = 3, H = 6;
  // Line at 2.5 across: row 2 is crossed in every column. Upper side is a far
  // band (opaque grey), lower side land with per-column colours.
  const line = Float32Array.from([2.5, 2.5, 2.5]), raw = Float32Array.from([2, 2, 2]);
  const data = grid(W, H, () => 2, (i) => [[30, 0, 0], [0, 60, 0], [0, 0, 90]][i], [200, 200, 200]);
  const orig = data.slice(), split = new Uint8ClampedArray(data.length);
  reownCrestCells({ data, width: W, y0: 0, rows: H }, orig, split, line, raw);
  const k = (2 * W + 1) * 4;
  // Middle column: below (1,3) is the only distance-1 lower cell (its
  // neighbours on row 2 are crossed, not fully below), so it is copied.
  assert.deepEqual([...split.slice(k, k + 4)], [0, 60, 0, 255]);
  assert.deepEqual([...data.slice(k, k + 4)], [200, 200, 200, 255], 'upper half takes the far band');
  const skipped = grid(W, H, () => 2, () => [10, 10, 10], [200, 200, 200]);
  const so = skipped.slice();
  reownCrestCells({ data: skipped, width: W, y0: 0, rows: H }, so, new Uint8ClampedArray(so.length), line, raw, Uint8Array.from([1, 1, 1]));
  assert.deepEqual(skipped, so, 'skipped columns (a nearer line within reach) are untouched');
});

test('line colours keep hue at 0.55 lightness, recede toward the sky, and respect palette and protected hues', () => {
  const land = [100, 120, 70], sky = [150, 180, 220];
  const near = crestLineColor(land, sky, 'near'), far = crestLineColor(land, sky, 'far');
  const a = rgbToHsl(...land), b = rgbToHsl(...near);
  assert.ok(Math.abs(a.h - b.h) < 3, 'hue kept');
  assert.ok(Math.abs(b.l - a.l * CREST_DARKEN) < 0.02, 'lightness at 0.55x');
  assert.ok(far[2] > near[2], 'far lines lean toward the sky');
  // Protected hues: an aquamarine land colour is rotated out of the band.
  const aqua = crestLineColor([60, 200, 190], sky, 'near');
  assert.equal(nearProtectedHue(aqua), false);
  for (const p of PROTECTED_HUES) {
    const c = snapCrestColor([...hslRgb(p, 0.8, 0.5)], null);
    assert.ok(hueDistance(rgbToHsl(...c).h, p) >= PROTECTED_HUE_GAP - 0.5, `hue ${p} not guarded`);
  }
  const colors = ['#000000', '#ffffff', '#3a6b4c', '#4cd9d0', '#ff4d4d', '#ffd75e', '#806040', '#5a6e8c'];
  const compiled = compilePalette(colors), entries = new Set(colors.map(c => c.slice(1).match(/../g).map(h => parseInt(h, 16)).join()));
  for (const input of [land, [60, 200, 190], [250, 80, 80], [250, 215, 90], [10, 10, 10], near, far, shoreColor([40, 90, 140])]) {
    const out = snapCrestColor(input, compiled);
    assert.ok(entries.has(out.join()), `${out} is not a palette entry`);
    assert.equal(nearProtectedHue(out), false, `${out} is a protected hue`);
  }
  const retro = snapCrestColor([123, 45, 200], 'rgb332');
  assert.ok([0, 36, 73, 109, 146, 182, 219, 255].includes(retro[0]) && [0, 85, 170, 255].includes(retro[2]));
  // Shorelines are pale, and dimmer over dark (night) water.
  const day = shoreColor([60, 110, 150]), night = shoreColor([10, 14, 24]);
  assert.ok(lum(day) > lum([60, 110, 150]), 'pale on the water side');
  assert.ok(lum(night) < lum(day) / 3, 'dimmed at night');
});

function hslRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
const hueDistance = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('shore transitions link across columns by kind and nearness of row', () => {
  const cols = [[{ y: 10, kind: 1 }, { y: 20, kind: 2 }], [{ y: 10.5, kind: 1 }, { y: 21, kind: 2 }], [{ y: 11, kind: 1 }], [{ y: 30, kind: 1 }]];
  const chains = linkShoreChains(cols);
  assert.deepEqual(chains.map(c => c.length).sort(), [1, 2, 3]);
  assert.deepEqual(chains.find(c => c.length === 3).map(([x]) => x), [0, 1, 2]);
});

// --- RangeCrest with a synthetic probe ---------------------------------------

function probe(W, bands, water = null) {
  const data = new Uint8Array(W * PROBE_ROWS * 4);
  let rows = 0;
  for (const [band, crest] of Object.entries(bands)) {
    const row = PROBE_BAND_ROWS[band]; rows |= 1 << row | 1 << (row + 1);
    for (let j = 0; j < W; j++) {
      const r = crest(j); if (r == null) continue;
      const k = (row * W + j) * 4, v = r + 1;
      data[k] = v & 255; data[k + 1] = v >> 8; data[k + 2] = 128; data[k + 3] = 255;
      const c = ((row + 1) * W + j) * 4;
      data[c] = band === 'far' ? 90 : 70; data[c + 1] = band === 'near' ? 110 : 80; data[c + 2] = 60; data[c + 3] = 255;
    }
  }
  if (water) {
    rows |= 1 << PROBE_WATER_ROW;
    for (let j = 0; j < W; j++) water(j).forEach(({ row, kind }, s) => {
      const k = ((PROBE_WATER_ROW + s) * W + j) * 4, v = row + 1;
      data[k] = v & 255; data[k + 1] = (v >> 8) | (kind === 2 ? 32 : 0) | 64; data[k + 2] = 200; data[k + 3] = 255;
      const c = ((PROBE_WATER_ROW + PROBE_WATER_SLOTS + s) * W + j) * 4;
      data[c] = 60; data[c + 1] = 110; data[c + 2] = 150; data[c + 3] = 255;
    });
  }
  return { width: W, height: 36, data, rows, readMs: 0.01 };
}

function recorder() {
  const ops = [];
  const ctx = new Proxy({ ops }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { ops.push([key, ...args.map(a => (typeof a === 'number' ? Math.round(a * 1000) / 1000 : a?.width ? 'canvas' : a))]); };
    },
    set(target, key, value) { ops.push(['set', key, value]); return true; },
  });
  return ctx;
}

const STAGE = { width: 64, height: 36, targetHeight: 36 };
const GRID = { width: 64, height: 36 };
const ID = [1, 0, 0, 1, 0, 0];
const bands = (t = 0) => ({ far: j => 8 + Math.round(2 * Math.sin(j / 9) + t), mid: j => 15 + Math.round(j / 16), near: j => (j > 20 && j < 50 ? 24 : null) });

test('the crest freezes per frame: a recording redraw reproduces the live draw exactly', () => {
  const crest = new RangeCrest();
  for (let f = 1; f <= 40; f++) crest.update({ probe: probe(64, bands()), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, sky: '#8899aa' });
  const fit = { x: 0, y: 0, width: 1920, height: 1080, scale: 30 };
  const live = recorder(), capture = recorder();
  crest.drawCrest(live, fit, 40); crest.drawCrest(capture, fit, 40);
  assert.ok(live.ops.some(op => op[0] === 'stroke'), 'strokes drawn');
  assert.deepEqual(capture.ops, live.ops, 'a second draw of the same frame is identical');
  const small = recorder();
  crest.drawCrest(small, { x: 0, y: 0, width: 640, height: 360, scale: 10 }, 40);
  assert.equal(small.ops.filter(op => op[0] === 'stroke').length, live.ops.filter(op => op[0] === 'stroke').length, 'same strokes at recording size');
  const stale = recorder();
  crest.drawCrest(stale, fit, 41);
  assert.equal(stale.ops.length, 0, 'another frame never redraws this snapshot');
  assert.equal(crest.snapshot.fade, 1);
});

test('seeking, a gap or a new view resets the temporal state; quality changes fade before switching', () => {
  const crest = new RangeCrest();
  const run = (f, t, opts = {}) => crest.update({ probe: probe(64, bands(t)), frameId: f, timeMs: opts.timeMs ?? f * 1000 / 60, viewId: opts.view || 'v',
    transform: ID, stage: STAGE, grid: GRID, qualityLevel: opts.quality ?? 0 });
  for (let f = 1; f <= 30; f++) run(f, 0);
  const before = crest._grid.far.line.slice();
  run(31, 1); // a one-row shift: within fastPx, so it is filtered
  assert.ok(crest._grid.far.line.some((v, i) => Math.abs(v - before[i]) > 0 && Math.abs(v - before[i]) < 1), 'filtered move');
  run(32, 1, { timeMs: 99999 }); // seek
  assert.equal(crest.diagnostics.lastReset, 'seek');
  const rawFar = probeRow(probe(64, bands(1)).data, (PROBE_BAND_ROWS.far * 64 + 10) * 4).row;
  assert.ok(Math.abs(crest._bands.far.filter.y[10] - rawFar) < 0.51, 'after a seek the line restarts at the raw crest');
  run(34, 1, { timeMs: 99999 + 33 });
  assert.equal(crest.diagnostics.lastReset, 'gap');
  run(35, 1, { timeMs: 99999 + 50, view: 'w' });
  assert.equal(crest.diagnostics.lastReset, 'view'); assert.ok(crest.snapshot.fade < 0.1, 'a new view fades in');
  for (let f = 36; f < 80; f++) run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60 });
  assert.equal(crest.snapshot.fade, 1); assert.equal(crest.mode, 'refined');
  let f = 80, fades = [];
  while (crest.mode === 'refined' && f < 200) { run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60, quality: CREST_GRID_SCAN_LEVEL }); fades.push(crest.fade); f++; }
  assert.equal(crest.mode, 'grid');
  assert.ok(fades.length >= 25 && fades.length <= 35, `fade out took ${fades.length} frames: ${fades}`);
  for (let i = 1; i < fades.length; i++) assert.ok(fades[i] <= fades[i - 1]);
  run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60, quality: CREST_GRID_SCAN_LEVEL });
  assert.equal(crest.snapshot.split, false, 'the grid-scan fallback drops split cells');
  assert.deepEqual(crest.snapshot.shores, []);
});

test('a frame without a probe draws nothing and breaks the filter chain', () => {
  const crest = new RangeCrest();
  crest.update({ probe: probe(64, bands()), frameId: 1, timeMs: 0, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  crest.update({ probe: null, frameId: 2, timeMs: 16, viewId: 'v' });
  assert.equal(crest.snapshot, null);
  crest.update({ probe: probe(64, bands()), frameId: 3, timeMs: 33, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  assert.equal(crest.diagnostics.lastReset, 'gap');
});

test('prepareGrid re-owns only rows around the lines and splits the crossed cells', () => {
  const made = [];
  const makeCanvas = (w, h) => {
    const canvas = { width: w, height: h, puts: [] };
    canvas.getContext = () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
      putImageData: (...args) => canvas.puts.push(args.slice(1)) });
    made.push(canvas); return canvas;
  };
  const crest = new RangeCrest({ makeCanvas });
  const pr = probe(64, { far: j => 10 + Math.floor(j / 5) });
  for (let f = 1; f <= 40; f++) crest.update({ probe: pr, frameId: f, timeMs: f * 16, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, palette: null });
  const W = 64, H = 36, pixels = grid(W, H, j => 10 + Math.floor(j / 5), () => [70, 80, 60], [0, 0, 0, 0]);
  let read = null, written = null;
  const ctx = { getImageData(x, y, w, h) { read = [x, y, w, h]; return { data: pixels.slice(y * W * 4, (y + h) * W * 4) }; },
    putImageData(image, x, y) { written = [x, y]; } };
  assert.equal(crest.prepareGrid({ ctx }), true);
  assert.ok(read[1] > 0 && read[3] < H, `bounded readback ${read}`);
  assert.deepEqual(written, [0, read[1]]);
  assert.equal(made.length, 1);
  assert.equal(crest.prepareGrid({ ctx }), false, 'one preparation per frame');
  const fit = { x: 0, y: 0, width: 1280, height: 720, scale: 20 };
  const live = recorder();
  crest.drawCrest(live, fit, 40);
  assert.ok(live.ops.some(op => op[0] === 'drawImage'), 'split cells drawn at output resolution');
});

test('shorelines come from probe edges, are pale on the water side and are drawn steady', () => {
  const crest = new RangeCrest();
  const water = j => (j > 10 && j < 50 ? [{ row: 20, kind: 1 }, { row: 26, kind: 2 }] : []);
  for (let f = 1; f <= 20; f++) crest.update({ probe: probe(64, bands(), water), frameId: f, timeMs: f * 16, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  assert.equal(crest.snapshot.shores.length, 2);
  // A one-row ripple of the water edge each frame (music waves) barely moves the line.
  const ripple = (f) => j => (j > 10 && j < 50 ? [{ row: 20 + (f % 2), kind: 1 }, { row: 26, kind: 2 }] : []);
  const ys = [];
  for (let f = 21; f <= 60; f++) {
    crest.update({ probe: probe(64, bands(), ripple(f)), frameId: f, timeMs: f * 16, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
    ys.push(crest.snapshot.shores.find(s => s.kind === 1).points[21]);
  }
  for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) < 0.2, `shore moved ${ys[i] - ys[i - 1]}`);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 0.6);
  const ops = recorder();
  crest.drawShore(ops, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 60);
  assert.equal(ops.ops.filter(op => op[0] === 'stroke').length, 2);
});

test('composite order: terrain, crest, water, shore; live and recorded alike', () => {
  const order = [];
  const make = (w, h, name) => {
    const canvas = { width: w, height: h };
    const stack = [];
    const ctx = { canvas, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, setTransform() {}, fillRect() {},
      save() { stack.push(this.globalCompositeOperation); }, restore() { this.globalCompositeOperation = stack.pop(); },
      beginPath() {}, rect() {}, clip() {}, drawImage() { order.push([name, 'pixels']); },
      getImageData() { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }, putImageData() {} };
    canvas.getContext = () => ctx;
    canvas.ownerDocument = { createElement: () => make(0, 0, 'scratch') };
    return canvas;
  };
  const canvas = make(1280, 720, 'live');
  let prepared = 0;
  const range = { enabled: true, crestEnabled: false, crestPalette: undefined,
    prepareCrestGrid({ ctx, frame }) { prepared++; assert.ok(ctx || frame); return true; },
    drawCrestForeground(ctx, fit) { order.push([ctx === canvas.getContext() ? 'live' : 'recorded', 'crest', ctx.globalCompositeOperation, fit.width]); return true; },
    drawWaterForeground(ctx, fit) { order.push([ctx === canvas.getContext() ? 'live' : 'recorded', 'water', fit.width]); return true; },
    drawShoreForeground(ctx, fit) { order.push([ctx === canvas.getContext() ? 'live' : 'recorded', 'shore', fit.width]); return true; } };
  const inner = { rangePresentation: range, draw() { assert.equal(range.crestEnabled, true); assert.equal(range.crestPalette, null); }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, rendererFactory: () => inner,
    presentation: { pixelated: true, grid: { width: 320, height: 180 }, paletteId: 'none', dither: 1, quality: 'auto', scaling: 'fit' } });
  assert.equal(adapter.draw({ biomes: { world: { kind: 'alpine' } } }, 0).presented, true);
  assert.equal(prepared, 1, 'the grid is prepared once, before the composite');
  assert.deepEqual(order.slice(-4), [['live', 'pixels'], ['live', 'crest', 'source-over', 1280], ['live', 'water', 1280], ['live', 'shore', 1280]]);
  assert.equal(adapter.diagnostics.crestForeground, true);
  const recorded = make(640, 360, 'recorded');
  assert.equal(adapter.getCaptureSource().drawCaptureFrame(recorded.getContext(), 640, 360), true);
  assert.deepEqual(order.slice(-4), [['recorded', 'pixels'], ['recorded', 'crest', 'source-over', 640], ['recorded', 'water', 640], ['recorded', 'shore', 640]]);
  assert.equal(prepared, 1, 'a recording never prepares the grid again');
  adapter.dispose();
});

test('compositePixelFrame reports the crest and shore layers it drew', () => {
  const ctx = { setTransform() {}, fillRect() {}, drawImage() {}, save() {}, restore() {} };
  const r = compositePixelFrame(ctx, { width: 320, height: 180 }, 1280, 720, 'fit', null, null, null, null, null, null, () => true, () => true);
  assert.equal(r.crest, true); assert.equal(r.shore, true);
});

test('the crest maps from the probe target through the stage transform into the grid', () => {
  // Target 64x36 stretched over a 256x144 stage, drawn at 0.25 with a 2-cell margin.
  const crest = new RangeCrest();
  crest.update({ probe: probe(64, { far: () => 20 }), frameId: 1, timeMs: 0, viewId: 'v', transform: [0.25, 0, 0, 0.25, -2, -2],
    stage: { width: 256, height: 144, targetHeight: 999 }, grid: { width: 60, height: 32 } });
  // Row 20 of the target is y = 20 · (144/36) · 0.25 − 2 = 18 in the grid,
  // whatever height the scene canvas has since been resized to.
  assert.ok(Math.abs(crest._grid.far.line[10] - 18) < 1e-6, String(crest._grid.far.line[10]));
});

test('a band boundary lost in haze gets no line; a contrasting one does', () => {
  const run = (upper) => {
    const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
    const crest = new RangeCrest({ makeCanvas });
    const pr = probe(64, { mid: j => 12 + Math.floor(j / 6) });
    const W = 64, H = 36, pixels = grid(W, H, j => 12 + Math.floor(j / 6), () => [100, 100, 100], upper);
    const ctx = { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }), putImageData() {} };
    for (let f = 1; f <= 30; f++) {
      crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
      crest.prepareGrid({ ctx });
    }
    const ops = recorder();
    crest.drawCrest(ops, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 30);
    return ops.ops.filter(op => op[0] === 'stroke').length;
  };
  assert.equal(run([101, 100, 99, 255]), 0, 'an invisible boundary is not outlined');
  assert.ok(run([60, 80, 140, 255]) > 0, 'a visible boundary is');
  assert.ok(run([0, 0, 0, 0]) > 0, 'a skyline over the separate sky is');
});
