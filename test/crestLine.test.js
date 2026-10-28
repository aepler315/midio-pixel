import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREST_FILTER, CREST_TIER_ORDER, CREST_TIERS, CREST_DARKEN, PROTECTED_HUES, PROTECTED_HUE_GAP, crestE, crestStroke, shoreStroke,
  filterCrest, filterAux, reconstructCrest, reownCrestCells, crestSpan, crestLineColor, shoreColor, snapCrestColor,
  nearProtectedHue, linkShoreChains, SHORE_SHAPE, shoreShape, solidShoreEdges, smoothShoreChain, gaussianSmooth, shoreNoise,
  smoothHeldShore,
} from '../src/render/CrestLine.js';
import { RangeCrest, CREST_GRID_SCAN_LEVEL, CREST_PIXEL_SPLIT_LEVEL } from '../src/world/alpine/RangeCrest.js';
import { PROBE_BAND_ROWS, PROBE_ROWS, PROBE_WATER_ROW, PROBE_WATER_SLOTS, probeRow } from '../src/world/alpine/CrestProbe.js';
import { compositePixelFrame } from '../src/render/PixelPresentation.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { compilePalette, quantizePalette, quantizeImageData, quantizeTexel } from '../src/render/PaletteQuantize.js';
import { rgbToHsl } from '../src/utils/color.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

const DT = 1 / 60;

// One column through filterCrest (kick detection included; a single column
// is trivially coherent with itself).
function runFilter(samples, opts = CREST_FILTER, dt = DT) {
  const state = { y: new Float32Array([NaN]), d: new Float32Array(1), aux: filterAux(1) };
  return samples.map(x => { filterCrest(state, Float32Array.of(x), dt, opts); return state.y[0]; });
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

test('one-frame kicks under fastPx keep at least 90% amplitude within a frame at 30 and 60 fps', () => {
  for (const fps of [30, 60]) for (const amp of [0.8, 1.0, 1.2, 1.4, -1.0]) for (const hold of [1, 2]) {
    const steady = Math.ceil(fps * 0.5);
    const raw = Array.from({ length: steady + 20 }, (_, f) => 10 + (f >= steady && f < steady + hold ? amp : 0));
    const out = runFilter(raw, CREST_FILTER, 1 / fps);
    const peak = out.reduce((best, v) => (Math.abs(v - 10) > Math.abs(best - 10) ? v : best), 10);
    assert.ok(Math.abs(peak - 10) >= 0.9 * Math.abs(amp), `${amp}px/${hold}f kick at ${fps} fps kept ${((peak - 10) / amp * 100).toFixed(0)}%`);
    assert.ok(out.indexOf(peak) - steady <= 1, `${amp}px kick at ${fps} fps peaked late`);
    assert.ok(Math.abs(out.at(-1) - 10) < 0.36, 'and returns with it');
  }
  // A row flip in a few columns while the rest of the band holds is not a
  // kick: in a 40-column band, 3 columns stepping by a row are filtered.
  const W = 40, state = { y: new Float32Array(W).fill(NaN), d: new Float32Array(W), aux: filterAux(W) };
  for (let f = 0; f < 30; f++) filterCrest(state, new Float32Array(W).fill(10), DT);
  const step = new Float32Array(W).fill(10); step[5] = step[6] = step[7] = 11;
  filterCrest(state, step, DT);
  assert.ok(state.y[6] < 10.5, `a local row flip passed as a kick (${state.y[6]})`);
  filterCrest(state, new Float32Array(W).fill(11), DT);
  assert.equal(state.y[20], 11, 'a band-wide one-row heave passes at once');
});

test('the deadband suppresses sub-pixel crawl and most grid-row flips', () => {
  const jitter = Array.from({ length: 600 }, (_, f) => 10.5 + 0.3 * Math.sin(f * 1.7));
  const held = runFilter(jitter);
  assert.ok(held.every(v => v === held[0]), 'sub-deadband jitter must not move the line at all');
  // A crest flickering between two rows every frame is held near their middle.
  const flicker = runFilter(Array.from({ length: 120 }, (_, f) => 20 + (f % 2)));
  for (let i = 1; i < flicker.length; i++) assert.ok(Math.abs(flicker[i] - flicker[i - 1]) < 0.15, 'row flicker is absorbed');
  // Flicker that starts after a steady spell: at most its first flip and
  // return pass (they look like a kick), then it is absorbed.
  const late = runFilter(Array.from({ length: 150 }, (_, f) => 20 + (f >= 30 ? f % 2 : 0)));
  for (let i = 33; i < late.length; i++) assert.ok(Math.abs(late[i] - late[i - 1]) < 0.15, `late flicker frame ${i}`);
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
      // Bands widen with rank; the skyline is the thin exception (opacity still ranks it highest).
      if (prev) { if (tier !== 'skyline') assert.ok(s.width >= prev.width, `${tier} width at e=${e}`); assert.ok(s.alpha >= prev.alpha, `${tier} alpha at e=${e}`); }
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
  // The skyline is the highest-ranked line: every skyline stroke is at least
  // as opaque as any near stroke, whatever either one's e. Its width is half
  // its original 3.0-3.5 px at 1080 lines.
  const nearMax = crestStroke('near', 1, 1080), skyMin = crestStroke('skyline', 0, 1080);
  assert.ok(skyMin.alpha >= nearMax.alpha, `skyline ${JSON.stringify(skyMin)} vs near ${JSON.stringify(nearMax)}`);
  assert.deepEqual(CREST_TIERS.skyline.width, [1.5, 1.75]);
  for (let i = 1; i < CREST_TIER_ORDER.length; i++) {
    const lower = CREST_TIERS[CREST_TIER_ORDER[i - 1]], upper = CREST_TIERS[CREST_TIER_ORDER[i]];
    assert.ok(upper.alpha[1] >= lower.alpha[1], `${CREST_TIER_ORDER[i]} tops ${CREST_TIER_ORDER[i - 1]}`);
    if (CREST_TIER_ORDER[i] !== 'skyline') assert.ok(upper.width[1] >= lower.width[1], `${CREST_TIER_ORDER[i]} is at least as wide as ${CREST_TIER_ORDER[i - 1]}`);
  }
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
  const orig = data.slice(), split = new Uint8ClampedArray(data.length), crossed = new Int16Array(W), crossedEnd = new Int16Array(W);
  const written = reownCrestCells({ data, width: W, y0: 0, rows: H }, orig, split, line, raw, null, crossed, crossedEnd);
  assert.ok(written > 0);
  for (let i = 0; i < W; i++) for (let r = 0; r < H; r++) {
    const k = (r * W + i) * 4, [top, bottom] = crestSpan(line, i);
    if (data[k + 3]) assert.ok(landColors.has(`${data[k]},${data[k + 1]},${data[k + 2]}`) || [...landColors].some(c => {
      const [a, b, cc] = c.split(',').map(Number); return Math.abs(a - data[k]) <= 1 && Math.abs(b - data[k + 1]) <= 1 && cc === data[k + 2];
    }), `grid cell ${i},${r} holds a non-land colour`);
    if (r + 1 <= top) assert.equal(data[k + 3], 0, `cell ${i},${r} fully above the line must be sky`);
    if (r >= bottom && r <= Math.floor(bottom) + 1) assert.equal(data[k + 3], 255, `cell ${i},${r} fully below the line must be land`);
    if (split[k + 3]) {
      assert.ok(r >= crossed[i] && r <= crossedEnd[i]);
      assert.equal(data[k + 3], 0, 'a crossed cell keeps its upper (sky) half in the grid');
      assert.ok(split[k] >= 80 && split[k + 1] >= 120 && split[k + 2] === 60, 'the lower half is land only');
    }
  }
  assert.ok([...crossed].some(r => r >= 0));
});

/** Composite a re-owned grid and its split halves the way drawCrest does,
 *  sampling `n`×`n` points per cell: above the drawn polyline only the grid
 *  shows; below it, inside a crossed cell, the split half does. Returns the
 *  samples above the line that show land, and those below it inside the
 *  band's land that show sky. */
function compositeAgainstLine({ data, split, line, raw, crossed, crossedEnd, W, H }, n = 8) {
  const lineAt = (x) => {
    const c = Math.min(W - 1, Math.max(0, Math.floor(x - 0.5)));
    const d = Math.min(W - 1, c + 1), u = Math.min(1, Math.max(0, x - 0.5 - c));
    if (x < 0.5) return line[0];
    if (x > W - 0.5) return line[W - 1];
    return line[c] + (line[d] - line[c]) * u;
  };
  const above = [], holes = [];
  for (let i = 0; i < W; i++) for (let r = 0; r < H; r++) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const x = i + (a + 0.5) / n, y = r + (b + 0.5) / n, k = (r * W + i) * 4;
    if (y < lineAt(x)) { if (data[k + 3]) above.push([i, r, x, y]); continue; }
    const inSplit = crossed[i] >= 0 && r >= crossed[i] && r <= crossedEnd[i] && split[k + 3];
    if (r >= raw[i] && !inSplit && !data[k + 3]) holes.push([i, r]);
  }
  return { above, holes };
}

test('no land texel shows above the line at a one-cell spire or a sharp V', () => {
  const H = 16, land = () => [120, 90, 70];
  const cases = {
    // A one-cell spire the filter has smoothed well below (two cells).
    spire: { raw: [8, 8, 8, 8, 4, 8, 8, 8, 8, 8], line: [8, 8, 8, 7.5, 6, 7.5, 8, 8, 8, 8] },
    // A raw spire the line still follows exactly: its cell's upper corners
    // lie above the polyline that falls away on both sides.
    peak: { raw: [9, 9, 8, 7, 5, 7, 8, 9, 9, 9], line: [9, 9, 8, 7, 5, 7, 8, 9, 9, 9] },
    // A sharp V (a notch) and a steep side.
    vee: { raw: [4, 5, 6, 7, 9, 7, 6, 5, 4, 4], line: [4.2, 5.1, 6, 7.2, 8.6, 7.1, 6, 5.2, 4.3, 4] },
  };
  for (const [name, { raw: r, line: l }] of Object.entries(cases)) {
    const W = r.length, raw = Float32Array.from(r), line = Float32Array.from(l);
    const data = grid(W, H, i => raw[i], land, [0, 0, 0, 0]);
    const orig = data.slice(), split = new Uint8ClampedArray(data.length);
    const crossed = new Int16Array(W), crossedEnd = new Int16Array(W);
    reownCrestCells({ data, width: W, y0: 0, rows: H }, orig, split, line, raw, null, crossed, crossedEnd);
    const { above, holes } = compositeAgainstLine({ data, split, line, raw, crossed, crossedEnd, W, H });
    assert.equal(above.length, 0, `${name}: land above the line at ${JSON.stringify(above.slice(0, 4))}`);
    assert.equal(holes.length, 0, `${name}: sky below the line inside the land at ${JSON.stringify(holes.slice(0, 4))}`);
  }
  // A spire taller than its neighbours' rings still finds what lies above it.
  const W = 5, raw = Float32Array.from([10, 10, 3, 10, 10]), line = Float32Array.from([10, 10, 9, 10, 10]);
  const data = grid(W, H, i => raw[i], land, [0, 0, 0, 0]), orig = data.slice();
  reownCrestCells({ data, width: W, y0: 0, rows: H }, orig, new Uint8ClampedArray(data.length), line, raw);
  for (let r = 3; r < 9; r++) assert.equal(data[(r * W + 2) * 4 + 3], 0, `spire row ${r} cut to sky`);
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

test('crest chunks meet at shared pixel columns with no gap or overlap at a bend', () => {
  const crest = new RangeCrest();
  // A zigzag crest: every chunk boundary sits on a bend.
  const zig = { far: j => 12 + (Math.floor(j / 4) % 2 ? j % 4 : 4 - (j % 4)) * 2 };
  for (let f = 1; f <= 30; f++) crest.update({ probe: probe(64, zig), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  const fit = { x: 0, y: 0, width: 1280, height: 720, scale: 20 };
  const ops = recorder();
  crest.drawCrest(ops, fit, 30);
  assert.ok(ops.ops.some(op => op[0] === 'set' && op[1] === 'lineCap' && op[2] === 'round'));
  const rects = ops.ops.filter(op => op[0] === 'rect').slice(1); // after the fit clip
  const chunks = crest._grid.far.chunks;
  assert.ok(chunks.length > 4);
  assert.equal(rects.length, chunks.length);
  for (let c = 1; c < rects.length; c++) {
    const [, x0, , w0] = rects[c - 1], [, x1] = rects[c];
    assert.equal(x0 + w0, x1, `chunk ${c - 1} ends where chunk ${c} starts`);
    assert.equal(x1, chunks[c].start * fit.scale, 'on a pixel column');
  }
  // Each interior chunk strokes past its clip on both sides (continuous joins).
  const moves = ops.ops.filter(op => op[0] === 'moveTo').slice(-chunks.length);
  for (let c = 1; c < chunks.length; c++) assert.ok(moves[c][1] < rects[c][1], `chunk ${c} path starts before its clip`);
});

test('seeking, a gap or a new view resets the temporal state; quality changes fade before switching', () => {
  const crest = new RangeCrest();
  const run = (f, t, opts = {}) => crest.update({ probe: probe(64, bands(t)), frameId: f, timeMs: opts.timeMs ?? f * 1000 / 60, viewId: opts.view || 'v',
    transform: ID, stage: STAGE, grid: GRID, qualityLevel: opts.quality ?? 0 });
  for (let f = 1; f <= 30; f++) run(f, 0);
  const before = crest._grid.far.line.slice();
  run(31, 1); // a band-wide one-row shift after a steady spell: a kick, passed at once
  assert.ok(crest._grid.far.line.every((v, i) => !Number.isFinite(v) || Math.abs(v - before[i] - 1) < 1e-6), 'kick passed within the frame');
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
  assert.equal(crest.probeMode, null, 'the grid-scan rungs render no probe');
  assert.equal(crest.snapshot, null, 'without a palette frame to scan (Pixel look) there is no line');
});

test('the grid-scan fallback takes the skyline from the palette frame, with no probe and no split cells', () => {
  const crest = new RangeCrest({ makeCanvas: () => { throw new Error('no split canvas on the grid-scan rungs'); } });
  const compiled = compilePalette(['#000000', '#ffffff', '#806040', '#5a6e8c']);
  // Already in grid mode (the switch itself is covered above).
  crest.mode = 'grid';
  const W = 64, H = 36, pixels = grid(W, H, j => 12 + Math.floor(j / 8), () => [128, 96, 64], [0, 0, 0, 0]);
  let drawn = 0;
  for (let f = 1; f <= 40; f++) {
    const snap = crest.update({ probe: probe(64, bands()), scan: true, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', qualityLevel: CREST_GRID_SCAN_LEVEL,
      grid: GRID, palette: compiled });
    assert.equal(snap.split, false); assert.deepEqual(snap.shores, []);
    assert.equal(crest.prepareGrid({ frame: { width: W, height: H, data: pixels } }), true);
    const ops = recorder();
    crest.drawCrest(ops, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, f);
    drawn = ops.ops.filter(op => op[0] === 'stroke').length;
  }
  assert.ok(drawn > 0, 'a skyline is drawn');
  assert.equal(crest.diagnostics.readback, 'palette-frame');
  assert.ok(Math.abs(crest._grid.far.line[20] - 14) < 1e-6, String(crest._grid.far.line[20]));
  assert.ok(Number.isNaN(crest._grid.mid.line[20]), 'the probe was ignored');
});

test('split cells fade with the line across a quality switch instead of popping', () => {
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  const crest = new RangeCrest({ makeCanvas });
  const W = 64, H = 36, pr = probe(64, { far: j => 10 + Math.floor(j / 5) });
  const base = grid(W, H, j => 10 + Math.floor(j / 5), () => [70, 80, 60], [0, 0, 0, 0]);
  const edit = (f, quality) => {
    crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: quality });
    const pixels = base.slice();
    const ctx = { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }),
      putImageData: (image, x, y) => pixels.set(image.data, y * W * 4) };
    crest.prepareGrid({ ctx });
    let diff = 0;
    for (let k = 0; k < pixels.length; k++) diff += Math.abs(pixels[k] - base[k]);
    return { diff, alpha: crest.snapshot?.splitAlpha ?? 0, fade: crest.fade };
  };
  let f = 1;
  for (; f <= 60; f++) edit(f, 0);
  const full = edit(f++, 0);
  assert.ok(full.diff > 0 && full.alpha === 1);
  const out = [];
  while (crest.mode === 'refined' && f < 200) out.push(edit(f++, CREST_GRID_SCAN_LEVEL));
  assert.ok(out.length > 20, 'the switch took the fade');
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].diff <= out[i - 1].diff + 1e-9, `the grid edit shrinks with the fade (${out[i - 1].diff} -> ${out[i].diff})`);
    assert.ok(out[i].alpha <= out[i].fade + 1e-9, 'split halves never outlast the line');
  }
  const mid = out[Math.floor(out.length / 2)];
  assert.ok(mid.diff > 0.2 * full.diff && mid.diff < 0.8 * full.diff, `half way through the fade the edit is partial (${mid.diff} of ${full.diff})`);
  assert.ok(out.at(-1).diff < 0.1 * full.diff, 'nearly nothing left to pop when the mode switches');
  // Back to the refined rung: the edit grows again from nothing.
  crest.update({ probe: null, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', qualityLevel: 0 }); f++;
  const back = [];
  for (let n = 0; n < 40; n++) back.push(edit(f++, 0));
  assert.ok(back[0].diff < 0.2 * full.diff, `split cells came back at ${back[0].diff} of ${full.diff}`);
  assert.ok(back.at(-1).diff >= full.diff - 1e-9);
  // The Pixel look sheds split cells (and their row readback) from
  // CREST_PIXEL_SPLIT_LEVEL with the same fade, keeping the line.
  const shed = [];
  for (let n = 0; n < 40; n++) shed.push(edit(f++, CREST_PIXEL_SPLIT_LEVEL));
  assert.ok(shed[0].diff > 0 && shed.at(-1).diff === 0 && crest.snapshot.fade === 1);
  assert.equal(crest.diagnostics.readRows, 0);
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

test('the line darkens the land the viewer sees in the grid, not the raw band render', () => {
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  const crest = new RangeCrest({ makeCanvas });
  // The probe reports the raw band colour (70, 110, 60); after haze and
  // grading the grid shows a mauve land (138, 98, 139) under a separate sky.
  const W = 64, H = 36, pr = probe(64, { near: j => 14 + Math.floor(j / 9) });
  const land = [138, 98, 139], pixels = grid(W, H, j => 14 + Math.floor(j / 9), () => land, [0, 0, 0, 0]);
  const ctx = { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }), putImageData() {} };
  for (let f = 1; f <= 20; f++) {
    crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
    crest.prepareGrid({ ctx });
  }
  const want = rgbToHsl(...land);
  for (const chunk of crest._grid.near.chunks) {
    const c = rgbToHsl(...chunk.color.match(/\d+/g).map(Number));
    assert.ok(hueDistance(c.h, want.h) < 4, `line hue ${c.h.toFixed(1)} vs land ${want.h.toFixed(1)}`);
    assert.ok(Math.abs(c.l / want.l - CREST_DARKEN) < 0.03, `line lightness ${(c.l / want.l).toFixed(3)}x of the land`);
  }
  // Without a grid reading (Pixel look past CREST_PIXEL_SPLIT_LEVEL) the
  // last reading is kept rather than falling back to the raw render.
  crest.update({ probe: pr, frameId: 21, timeMs: 21 * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: CREST_PIXEL_SPLIT_LEVEL });
  const kept = rgbToHsl(...crest._grid.near.chunks[0].color.match(/\d+/g).map(Number));
  assert.ok(hueDistance(kept.h, want.h) < 4);
  // After a reset (new view) there, a throttled sample-only read (no
  // write-back) takes the grid's colour again at once, then every 0.5 s.
  let reads = 0, writes = 0;
  const counting = { getImageData: (...args) => { reads++; return ctx.getImageData(...args); }, putImageData() { writes++; } };
  for (let f = 22; f <= 81; f++) {
    crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'w', transform: ID, stage: STAGE, grid: GRID, qualityLevel: CREST_PIXEL_SPLIT_LEVEL });
    crest.prepareGrid({ ctx: counting });
    if (f === 22) {
      const fresh = rgbToHsl(...crest._grid.near.chunks[0].color.match(/\d+/g).map(Number));
      assert.ok(hueDistance(fresh.h, want.h) < 4 && Math.abs(fresh.l / want.l - CREST_DARKEN) < 0.03, 'the first frame after a reset reads the grid');
      assert.equal(crest.diagnostics.readback, 'probe+crest-sample');
    }
  }
  assert.equal(writes, 0, 'sample-only reads never write the grid back');
  assert.ok(reads >= 2 && reads <= 4, `${reads} sample reads in 1 s`);
});

test('palette split halves go through the grid quantizer at their own cell', () => {
  const colors = ['#000000', '#ffffff', '#3a6b4c', '#806040', '#5a6e8c', '#a07850', '#704830'];
  const compiled = compilePalette(colors);
  // quantizeTexel is exactly what the frame pass writes, cell by cell.
  const W = 16, H = 8, frame = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let k = 0; k < frame.data.length; k += 4) { frame.data[k] = 130 + (k % 37); frame.data[k + 1] = 92 + (k % 11); frame.data[k + 2] = 66; frame.data[k + 3] = 255; }
  const input = frame.data.slice(), weights = new Uint8Array(W * H).fill(255);
  for (const dither of [0, 0.35, 1]) {
    const pal = quantizePalette({ width: W, height: H, data: input.slice() }, compiled, { dither, weights });
    const rgb = quantizeImageData({ width: W, height: H, data: input.slice() }, { dither });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4, c = [input[k], input[k + 1], input[k + 2]];
      assert.deepEqual(quantizeTexel(c, x, y, { compiled, dither, weights, width: W }), [...pal.data.slice(k, k + 3)]);
      assert.deepEqual(quantizeTexel(c, x, y, { dither }), [...rgb.data.slice(k, k + 3)]);
    }
  }
  // Through applyPalette: the crest's split halves come out as the entry the
  // grid itself would hold at that cell for that colour.
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  const crest = new RangeCrest({ makeCanvas });
  const GW = 320, GH = 180, pr = probe(64, { far: j => 10 + Math.floor(j / 5) });
  const pixels = grid(GW, GH, i => 50 + Math.floor(i / 25), (i, r) => [140 + (i % 9), 100 + (r % 7), 70], [0, 0, 0, 0]);
  for (let f = 1; f <= 30; f++) crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: [5, 0, 0, 5, 0, 0], stage: STAGE, grid: { width: GW, height: GH }, palette: compiled });
  crest.update({ probe: pr, frameId: 31, timeMs: 31 * 1000 / 60, viewId: 'v', transform: [5, 0, 0, 5, 0, 0], stage: STAGE, grid: { width: GW, height: GH }, palette: compiled });
  const full = { width: GW, height: GH, data: pixels.slice() };
  assert.equal(crest.prepareGrid({ frame: full }), true);
  assert.equal(crest.snapshot.splitPending, true);
  const before = crest._split.image.data.slice();
  quantizePalette(full, compiled, { dither: 0.35 });
  const options = { compiled, dither: 0.35, weights: null, width: GW };
  assert.equal(crest.finishGrid({ frame: full, quantize: (c, x, y) => quantizeTexel(c, x, y, options) }), true);
  assert.equal(crest.snapshot.splitReady, true);
  const entries = new Set(compiled.rgb.map(c => c.join()));
  let checked = 0;
  for (let i = 0; i < GW; i++) {
    const r = crest._grid.far.crossed[i];
    if (r < 0) continue;
    const k = (r * GW + i) * 4, out = crest._split.image.data;
    if (!out[k + 3]) continue;
    assert.ok(entries.has([...out.slice(k, k + 3)].join()), 'a palette entry');
    assert.deepEqual([...out.slice(k, k + 3)], quantizeTexel([before[k], before[k + 1], before[k + 2]], i, r, options), 'the grid quantizer at this cell');
    checked++;
  }
  assert.ok(checked > 10, `checked ${checked} split cells`);
});

test('shorelines hold still under 1-2 px music waves but move with the camera', () => {
  const crest = new RangeCrest();
  const shoreAt = (y) => j => (j > 10 && j < 50 ? [{ row: Math.round(y(j)), kind: 1 }] : []);
  const run = (f, band, water) => crest.update({ probe: probe(64, band, water), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  const steady = { far: j => 8 + Math.round(2 * Math.sin(j / 9)), near: () => 24 };
  for (let f = 1; f <= 30; f++) run(f, steady, shoreAt(() => 20));
  const point = () => crest.snapshot.shores.find(s => s.kind === 1).points[2 * 15 + 1];
  const rest = point();
  let f = 31;
  for (const [amp, hz] of [[1, 2], [2, 1], [2, 3], [1.5, 0.5]]) {
    const ys = [];
    for (const end = f + 240; f < end; f++) {
      run(f, steady, shoreAt(j => 20 + amp * Math.sin(2 * Math.PI * hz * f / 60 + j / 6)));
      ys.push(point());
    }
    const spread = Math.max(...ys) - Math.min(...ys);
    assert.ok(spread < 0.6, `${amp}px ${hz}Hz waves moved the shore by ${spread.toFixed(2)} px`);
    assert.ok(Math.abs(ys.at(-1) - rest) < 0.8, `${amp}px ${hz}Hz: ${ys.at(-1)} vs ${rest}`);
  }
  // A camera heave moves every band and the water together: the shore
  // moves with it in the same frame instead of trailing behind.
  const heave = { far: j => 10 + Math.round(2 * Math.sin(j / 9)), near: () => 26 };
  const y0 = point();
  run(f++, heave, shoreAt(() => 22));
  assert.ok(Math.abs(point() - y0 - 2) < 0.3, `shore moved ${point() - y0} with a 2-row heave`);
});

test('pressure eviction cannot take the split canvas from under an edited grid', () => {
  const W = 64, H = 36, bytes = W * H * 8;
  const residency = new GraphicsResidency({ budgetBytes: bytes + 1000, name: 'test' });
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  const crest = new RangeCrest({ makeCanvas, residency });
  const split = crest._ensureSplit(W, H);
  assert.ok(split, 'the split canvas is committed');
  // A later reservation (e.g. the Cinematic cell buffer) that would need the
  // split's bytes is denied instead of evicting it mid-frame.
  assert.equal(residency.reserve({ key: 'cinematic:cells', bytes: 4000, owner: 'cinematic' }), null);
  assert.equal(crest._split, split);
  assert.equal(crest._ensureSplit(W, H), split, 'still live and reused');
  // Releasing the crest gives the bytes back.
  crest.release();
  assert.ok(residency.reserve({ key: 'cinematic:cells', bytes: 4000, owner: 'cinematic' }));
});

test('only edges bounding real land and water on both sides count as shore', () => {
  const e = (row, shore = true) => ({ row, shore });
  // A wave crest over a sandbar: a 1-row water sliver above the shore.
  assert.deepEqual(solidShoreEdges([e(40), e(41), e(60)], 100), [2]);
  // A sliver against a non-shore edge (reflection boundary) is still a sliver.
  assert.deepEqual(solidShoreEdges([e(40, false), e(42), e(70)], 100), [2]);
  // The frame's own bottom row is not a shore; thick regions are.
  assert.deepEqual(solidShoreEdges([e(30), e(50), e(99)], 100), [0, 1]);
  assert.deepEqual(solidShoreEdges([e(30), e(30 + SHORE_SHAPE.minRunRows)], 100), [0, 1]);
});

test('near shore chains link larger steps, need more columns and are smoothed more', () => {
  const far = shoreShape(0), near = shoreShape(1);
  assert.ok(near.maxStep > far.maxStep && near.minColumns > far.minColumns && near.sigma > far.sigma);
  assert.equal(linkShoreChains([[{ y: 10, kind: 2 }], [{ y: 13, kind: 2 }]]).length, 2, 'default step 2');
  assert.equal(linkShoreChains([[{ y: 10, kind: 2, maxStep: 4 }], [{ y: 13, kind: 2, maxStep: 4 }]]).length, 1);
  // Bridging empty columns, with the step allowance growing per column.
  const gap = [[{ y: 10, kind: 2 }], [], [], [{ y: 13, kind: 2 }]];
  assert.equal(linkShoreChains(gap, 2, 0).length, 2);
  assert.equal(linkShoreChains(gap, 2, 2).length, 1);
  assert.equal(linkShoreChains([[{ y: 10, kind: 2 }], [], [{ y: 16, kind: 2 }]], 2, 2).length, 2, 'too steep across the gap');
});

test('a jittery near waterline becomes one smooth curve; an incoherent chain is rejected', () => {
  // A gentle true shore with ±2-3 row raster jitter (waves at a grazing angle).
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 80, truth = p => 150 + 6 * Math.sin(p / 25);
  const rows = Float32Array.from({ length: n }, (_, p) => Math.round(truth(p) + (rnd() - 0.5) * 5));
  const { ys, residual } = smoothShoreChain(rows, shoreShape(0.75).sigma);
  assert.ok(residual < SHORE_SHAPE.maxResidual, `residual ${residual}`);
  for (let p = 1; p < n - 1; p++) assert.ok(Math.abs(ys[p - 1] - 2 * ys[p] + ys[p + 1]) <= SHORE_SHAPE.maxCurvature + 1e-3, `curvature at ${p}`);
  // The ends follow the local trend of the data (no pull toward the
  // interior), so their scatter is a little wider than the interior's.
  for (let p = 0; p < n; p++) assert.ok(Math.abs(ys[p] - truth(p)) < (p < 3 || p > n - 4 ? 2 : 1.6), `point ${p}: ${ys[p]} vs ${truth(p)}`);
  // Edges scattered over ±8 rows are not one shore.
  const junk = Float32Array.from({ length: n }, () => Math.round(150 + (rnd() - 0.5) * 16));
  assert.ok(smoothShoreChain(junk, shoreShape(0.75).sigma).residual > SHORE_SHAPE.maxResidual);
});

test('the near shore is drawn as one coherent line, not squiggle fragments', () => {
  const crest = new RangeCrest();
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const jitter = Array.from({ length: 64 }, () => Math.round((rnd() - 0.5) * 4));
  // Near shore (water above, land below) with ±2-row raster jitter (steps
  // of up to 4 rows, which broke it into fragments before) and a 1-row
  // wave sliver above it in some columns (whose column then has no shore).
  const water = j => {
    if (j < 4 || j > 60) return [];
    const y = 28 + Math.round(j / 20) + jitter[j];
    return j % 9 === 0 ? [{ row: y - 6, kind: 1 }, { row: y - 5, kind: 2 }] : j % 13 === 0 ? [{ row: y - 1, kind: 1 }, { row: y, kind: 2 }] : [{ row: y, kind: 2 }];
  };
  const run = f => crest.update({ probe: probe(64, { far: () => 8 }, water), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  for (let f = 1; f <= 20; f++) run(f);
  const shores = crest.snapshot.shores;
  assert.equal(shores.length, 1, `${shores.length} chains: ${JSON.stringify(shores.map(c => [c.kind, c.points.length / 2, c.points[0], c.points.at(-2)]))}`);
  const p = shores[0].points, m = p.length / 2;
  assert.ok(m >= 45 && p[0] < 6 && p.at(-2) > 58, `${m} columns from ${p[0]} to ${p.at(-2)}`);
  for (const i of [0, m - 1]) {
    const j = p[2 * i] - 0.5;
    assert.ok(Math.abs(p[2 * i + 1] - (28.5 + j / 20)) < 1.5, `end at column ${j}: ${p[2 * i + 1]}`);
  }
  let worst = 0;
  for (let i = 1; i < m - 1; i++) worst = Math.max(worst, Math.abs(p[2 * i - 1] - 2 * p[2 * i + 1] + p[2 * i + 3]));
  assert.ok(worst <= SHORE_SHAPE.maxCurvature + 0.05, `curvature ${worst}`);
});

const sampleRows = (truth, n) => Float32Array.from({ length: n }, (_, p) => Math.round(truth(p)));
const worstOff = (ys, truth) => ys.reduce((w, y, p) => Math.max(w, Math.abs(y - truth(p))), 0);

test('clean sloped, bent and cove shores survive shaping with their ends on the edge', () => {
  const cases = [];
  for (const nearness of [0, 0.5, 1]) for (const slope of [1, 1.5, 2, 2.5, 3, 4, -2, 0.3]) cases.push([`slope ${slope} at ${nearness}`, nearness, 40, p => 100.3 + slope * p]);
  cases.push(['flat then slope 2, near', 1, 40, p => 100 + (p < 20 ? 0 : 2 * (p - 20))]);
  cases.push(['slope-3 bend, far (8 + 8 columns)', 0, 16, p => 100 + 3 * Math.abs(p - 8)]);
  cases.push(['±2 rows/column cove at 0.3', 0.3, 31, p => 100 + 2 * Math.abs(p - 15)]);
  cases.push(['1.5 rows/column point, near', 1, 41, p => 130.2 - 1.5 * Math.abs(p - 20)]);
  cases.push(['gentle curve, near', 1, 60, p => 100 + 12 * Math.sin(p / 15)]);
  for (const [name, nearness, n, truth] of cases) {
    const { ys, residual } = smoothShoreChain(sampleRows(truth, n), shoreShape(nearness).sigma);
    assert.ok(residual < 0.5 && residual < SHORE_SHAPE.maxResidual, `${name}: residual ${residual.toFixed(2)}`);
    assert.ok(worstOff(ys, truth) <= 1, `${name}: ${worstOff(ys, truth).toFixed(2)} rows off`);
    assert.ok(Math.abs(ys[0] - truth(0)) <= 1 && Math.abs(ys[n - 1] - truth(n - 1)) <= 1, `${name}: ends ${ys[0]}, ${ys[n - 1]}`);
  }
});

test('a far chain with a real zigzag keeps it; raster quantization alone is not jitter', () => {
  for (const [legs, slope] of [[4, 1], [4, 1.5], [6, 1.5], [8, 2]]) {
    const truth = p => 100.2 + slope * Math.abs((p % (2 * legs)) - legs), n = 48;
    const { ys, residual } = smoothShoreChain(sampleRows(truth, n), shoreShape(0).sigma);
    assert.ok(residual < SHORE_SHAPE.maxResidual, `legs ${legs}: residual ${residual}`);
    assert.ok(worstOff(ys, truth) <= 1, `legs ${legs} slope ${slope}: flattened by ${worstOff(ys, truth).toFixed(2)} rows`);
  }
  assert.equal(shoreNoise(sampleRows(p => 3.7 + 1.37 * p, 50)), 0, 'a rasterized straight edge');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  assert.ok(shoreNoise(Float32Array.from({ length: 50 }, () => 100 + Math.round((rnd() - 0.5) * 5))) > SHORE_SHAPE.noiseRows, '±2-row jitter');
});

test('shore smoothing is symmetric in place and keeps a slope at the ends', () => {
  const step = Float32Array.from({ length: 40 }, (_, p) => 100 + (p < 20 ? 0 : 2 * (p - 20)) + (p % 3 === 0 ? 0.4 : 0));
  const out = gaussianSmooth(step, 2.5), inPlace = Float32Array.from(step);
  gaussianSmooth(inPlace, 2.5, inPlace);
  assert.deepEqual([...inPlace], [...out]);
  const line = Float32Array.from({ length: 30 }, (_, p) => 10 + 3 * p), sm = gaussianSmooth(line, 5);
  for (let p = 0; p < 30; p++) assert.ok(Math.abs(sm[p] - line[p]) < 1e-3, `point ${p}: ${sm[p]}`);
  const held = Float32Array.from(step), copy = gaussianSmooth(step, 1.25);
  smoothHeldShore(held, 1.25, Infinity);
  assert.deepEqual([...held], [...copy]);
});

test('a clean near cove is drawn on its edge, ends included', () => {
  const crest = new RangeCrest();
  const truth = j => 8.2 + 1.5 * Math.abs(j - 24);
  const water = j => (j >= 8 && j <= 40 ? [{ row: Math.round(truth(j)), kind: 2 }] : []);
  for (let f = 1; f <= 20; f++) {
    crest.update({ probe: probe(64, { far: () => 2 }, water), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  }
  const shores = crest.snapshot.shores;
  assert.equal(shores.length, 1, `${shores.length} chains, ${crest.diagnostics.shoreDropped} dropped`);
  const p = shores[0].points, m = p.length / 2;
  assert.equal(m, 33);
  for (let i = 0; i < m; i++) {
    const j = p[2 * i] - 0.5;
    assert.ok(Math.abs(p[2 * i + 1] - (truth(j) + 0.5)) <= 1.1, `column ${j}: ${p[2 * i + 1]} vs edge ${truth(j) + 0.5}`);
  }
});
