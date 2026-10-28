import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREST_FILTER, CREST_TIER_ORDER, CREST_TIERS, CREST_DARKEN, PROTECTED_HUES, PROTECTED_HUE_GAP, crestE, crestStroke, shoreStroke,
  filterCrest, filterAux, reconstructCrest, reownCrestCells, crestSpan, crestLineColor, shoreColor, snapCrestColor,
  nearProtectedHue, linkShoreChains, SHORE_SHAPE, shoreShape, solidShoreEdges, smoothShoreChain, gaussianSmooth, shoreNoise,
  smoothHeldShore,
} from '../src/render/CrestLine.js';
import { RangeCrest, CREST_GRID_SCAN_LEVEL, CREST_PIXEL_SPLIT_LEVEL, CREST_VIEW_FADE_SEC } from '../src/world/alpine/RangeCrest.js';
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

test('seeking, a gap or a new view resets the temporal state; the heavy rungs keep the line with a light probe', () => {
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
  assert.equal(crest.diagnostics.lastReset, 'view'); assert.ok(crest.snapshot.fade < 0.2, 'a new view fades in, live');
  let f = 36;
  for (; crest.snapshot.fade < 1 && f < 80; f++) run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60 });
  assert.ok(f - 36 <= CREST_VIEW_FADE_SEC * 60 + 1, `the view fade-in took ${f - 36} frames`);
  for (; f < 80; f++) run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60 });
  assert.equal(crest.snapshot.fade, 1); assert.equal(crest.mode, 'refined'); assert.equal(crest.probeMode, 'refined');
  // The heavy rungs: the probe goes light at once and the line holds at full
  // strength, with no reset (no fade out, no blank frame, no restart).
  const resets = crest.diagnostics.resets, line = crest._grid.far.line.slice();
  run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60, quality: CREST_GRID_SCAN_LEVEL }); f++;
  assert.equal(crest.mode, 'grid'); assert.equal(crest.probeMode, 'grid', 'a light probe still runs');
  assert.equal(crest.snapshot.fade, 1); assert.equal(crest.diagnostics.resets, resets);
  assert.ok(crest._grid.far.line.every((v, i) => Object.is(v, line[i]) || Math.abs(v - line[i]) < 1e-6), 'the line holds through the switch');
  const ops = recorder();
  crest.drawCrest(ops, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, f - 1);
  assert.ok(ops.ops.some(op => op[0] === 'stroke'), 'without a palette (Pixel, Cinematic) the line is still drawn');
  run(f, 1, { timeMs: 99999 + 50 + (f - 35) * 1000 / 60, quality: 0 });
  assert.equal(crest.mode, 'refined'); assert.equal(crest.snapshot.fade, 1); assert.equal(crest.diagnostics.resets, resets);
});

test('an isolated export frame draws the crest at full strength from the raw crest', () => {
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  const W = 64, H = 36, pr = probe(64, { far: j => 10 + Math.floor(j / 5) });
  const pixels = grid(W, H, j => 10 + Math.floor(j / 5), () => [70, 80, 60], [0, 0, 0, 0]);
  const ctx = () => { const px = pixels.slice(); return { getImageData: (x, y, w, h) => ({ data: px.slice(y * W * 4, (y + h) * W * 4) }), putImageData() {} }; };
  for (const [name, frames] of [['a cold first frame', [[1, 0]]], ['an eval redraw after a seek', [[1, 0], [2, 40000]]],
    ['a reel re-render with a few warm-up frames', [[1, 0], [2, 16.7], [3, 33.3], [4, 50], [5, 66.7], [6, 83.3], [7, 30000]]]]) {
    const crest = new RangeCrest({ makeCanvas });
    for (const [frameId, timeMs] of frames) crest.update({ probe: pr, instant: true, frameId, timeMs, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
    assert.equal(crest.snapshot.fade, 1, `${name}: line at full strength`);
    assert.equal(crest.snapshot.splitFade, 1, `${name}: split cells at full strength`);
    assert.ok(crest.prepareGrid({ ctx: ctx() }));
    assert.equal(crest.snapshot.splitAlpha, 1, `${name}: split halves drawn opaque`);
    const raw = reconstructCrest(Float32Array.from({ length: 64 }, (_, j) => 10 + Math.floor(j / 5)));
    assert.ok(crest._grid.far.line.every((v, i) => Math.abs(v - raw[i]) < 1e-6), `${name}: steadied state starts at the raw crest`);
    const ops = recorder();
    crest.drawCrest(ops, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, frames.at(-1)[0]);
    const alphas = ops.ops.filter(op => op[0] === 'set' && op[1] === 'globalAlpha').map(op => op[2]);
    assert.ok(alphas.length && alphas.every(a => a >= 0.85), `${name}: stroke opacity ${alphas}`);
  }
  // Live, the same cold frame fades in; a continuous export frame keeps the
  // live fades too (export still matches playback).
  const live = new RangeCrest({ makeCanvas });
  live.update({ probe: pr, frameId: 1, timeMs: 0, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  assert.ok(live.snapshot.fade < 0.2);
  const exported = new RangeCrest({ makeCanvas });
  exported.update({ probe: pr, instant: true, frameId: 1, timeMs: 0, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  exported.update({ probe: pr, instant: true, frameId: 2, timeMs: 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
  assert.equal(exported.snapshot.fade, 1);
  exported.update({ probe: pr, instant: true, frameId: 3, timeMs: 2000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: CREST_PIXEL_SPLIT_LEVEL });
  assert.ok(exported.snapshot.splitFade > 0.9 && exported.snapshot.splitFade < 1, 'a continuous export frame sheds split cells with the live fade');
});

test('the grid-scan fallback takes the skyline from the palette frame when no probe arrives, with no split cells', () => {
  const crest = new RangeCrest({ makeCanvas: () => { throw new Error('no split canvas without a probe'); } });
  const compiled = compilePalette(['#000000', '#ffffff', '#806040', '#5a6e8c']);
  const W = 64, H = 36, pixels = grid(W, H, j => 12 + Math.floor(j / 8), () => [128, 96, 64], [0, 0, 0, 0]);
  let drawn = 0;
  for (let f = 1; f <= 40; f++) {
    const snap = crest.update({ probe: null, scan: true, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', qualityLevel: CREST_GRID_SCAN_LEVEL,
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
  assert.ok(Number.isNaN(crest._grid.mid.line[20]));
  const cut = recorder();
  assert.equal(crest.drawTerrain(cut, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 40, () => cut.ops.push(['terrain'])), true, 'the scanned skyline is cut too');
});

test('split cells fade out and back in across the Pixel split rung instead of popping; a palette keeps them on every rung', () => {
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
  for (let n = 0; n < 40; n++) out.push(edit(f++, CREST_PIXEL_SPLIT_LEVEL));
  const steps = out.findIndex(o => o.diff === 0);
  assert.ok(steps >= 25 && steps <= 35, `the shed took the fade (${steps} frames)`);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].diff <= out[i - 1].diff + 1e-9, `the grid edit shrinks with the fade (${out[i - 1].diff} -> ${out[i].diff})`);
    assert.equal(out[i].fade, 1, 'the line stays');
  }
  const mid = out[Math.floor(steps / 2)];
  assert.ok(mid.diff > 0.2 * full.diff && mid.diff < 0.8 * full.diff, `half way through the fade the edit is partial (${mid.diff} of ${full.diff})`);
  assert.equal(crest.diagnostics.readRows, 0);
  assert.equal(crest._split, null, 'shed split cells give the canvas (and its residency hold) back');
  const back = [];
  for (let n = 0; n < 40; n++) back.push(edit(f++, 0));
  assert.ok(back[0].diff < 0.2 * full.diff, `split cells came back at ${back[0].diff} of ${full.diff}`);
  assert.ok(back.at(-1).diff >= full.diff - 1e-9);
  // A palette look reads its whole frame anyway: split cells on every rung.
  const compiled = compilePalette(['#000000', '#ffffff', '#46503c', '#5a6e8c']);
  const pal = new RangeCrest({ makeCanvas });
  for (let g = 1; g <= 40; g++) {
    pal.update({ probe: pr, frameId: g, timeMs: g * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: 6, palette: compiled });
    assert.ok(pal.prepareGrid({ frame: { width: W, height: H, data: base.slice() } }));
  }
  assert.equal(pal.mode, 'grid'); assert.equal(pal.snapshot.split, true); assert.equal(pal.snapshot.splitFade, 1);
  assert.ok(pal.diagnostics.splitCells > 0); assert.equal(pal.diagnostics.readback, 'probe+palette-frame');
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

// --- Terrain cut at output resolution ----------------------------------------

/** A 2D context that keeps paths, clips and fills as polygons, so a frame
 *  composited by compositePixelFrame/RangeCrest can be sampled point by
 *  point: what shows at (x, y) after the smooth sky ('sky'), the grid
 *  (`terrain`: the native frame, or the Cinematic stand-in), split canvases
 *  and pocket fills. */
function rasterCtx(gridData, W, scale) {
  const state = { clips: [], alpha: 1, fill: null };
  const stack = [], layers = [];
  let path = [], sub = null;
  const ctx = {
    canvas: { width: W * scale, height: 0 },
    save() { stack.push({ ...state, clips: state.clips.slice() }); },
    restore() { Object.assign(state, stack.pop()); },
    setTransform() {}, fillRect() {}, stroke() {},
    beginPath() { path = []; sub = null; },
    moveTo(x, y) { sub = [[x, y]]; path.push(sub); },
    lineTo(x, y) { if (!sub) { sub = [[x, y]]; path.push(sub); } else sub.push([x, y]); },
    closePath() { if (sub) sub = [sub[0].slice()]; path.push(sub); },
    rect(x, y, w, h) { path.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); sub = null; },
    clip(rule = 'nonzero') { state.clips = [...state.clips, { path: path.map(p => p.slice()), rule }]; },
    fill(rule = 'nonzero') { layers.push({ kind: 'fill', path: path.map(p => p.slice()), rule, clips: state.clips, alpha: state.alpha }); },
    drawImage(image) { layers.push({ kind: 'image', data: image.data || null, clips: state.clips, alpha: state.alpha }); },
    terrain() { layers.push({ kind: 'terrain', clips: state.clips, alpha: state.alpha }); return true; },
    get globalAlpha() { return state.alpha; }, set globalAlpha(v) { state.alpha = v; },
    get fillStyle() { return state.fill; }, set fillStyle(v) { state.fill = v; },
  };
  const inside = ({ path: p, rule }, x, y) => {
    let wind = 0, cross = 0;
    for (const poly of p) for (let k = 0; k < poly.length; k++) {
      const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
      if ((y0 <= y) !== (y1 <= y)) {
        const xi = x0 + (y - y0) / (y1 - y0) * (x1 - x0);
        if (xi > x) { cross++; wind += y1 > y0 ? 1 : -1; }
      }
    }
    return rule === 'evenodd' ? cross % 2 === 1 : wind !== 0;
  };
  const at = (x, y) => {
    let shown = 'sky';
    const cell = (Math.floor(y / scale) * W + Math.floor(x / scale)) * 4;
    for (const layer of layers) {
      if (layer.alpha < 0.5 || !layer.clips.every(c => inside(c, x, y))) continue;
      if (layer.kind === 'fill') { if (inside(layer, x, y)) shown = 'land'; }
      else if (layer.kind === 'terrain') { if (gridData[cell + 3] >= 128) shown = 'land'; }
      else if (layer.data && layer.data[cell + 3] >= 128) shown = 'land';
    }
    return shown;
  };
  return { ctx, layers, at };
}

/** Sample every cell n×n against the drawn line: land above it, sky below
 *  it inside the band's land or in the cells split cells would fill. */
function sampleAgainstLine(at, line, raw, W, H, scale, n = 6) {
  const lineAt = (x) => {
    if (x < 0.5) return line[0];
    if (x > W - 0.5) return line[W - 1];
    const c = Math.floor(x - 0.5), d = Math.min(W - 1, c + 1);
    return line[c] + (line[d] - line[c]) * (x - 0.5 - c);
  };
  const above = [], holes = [];
  for (let i = 1; i < W - 1; i++) for (let r = 0; r < H; r++) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const x = i + (a + 0.5) / n, y = r + (b + 0.5) / n, L = lineAt(x);
    if (!Number.isFinite(L)) continue;
    const shown = at(x * scale, y * scale);
    if (y < L - 0.02) { if (shown === 'land') above.push([i, r]); continue; }
    const [, bottom] = crestSpan(line, i);
    if (y > L + 0.02 && (r >= raw[i] || r <= Math.floor(bottom) + 1) && shown === 'sky') holes.push([i, r]);
  }
  return { above, holes };
}

// A stair-stepped skyline with a one-cell spire and a sharp notch.
const STAIR = j => (j === 30 ? 6 : j === 45 ? 22 : 10 + Math.floor(j / 6));

function shedFrame({ quality, palette = null, lagRows = 0, frames = 40 }) {
  const W = 64, H = 36, scale = 20;
  const made = [];
  const makeCanvas = (w, h) => {
    const canvas = { width: w, height: h, data: null };
    canvas.getContext = () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
      putImageData: (image) => { canvas.data = image.data; } });
    made.push(canvas); return canvas;
  };
  const crest = new RangeCrest({ makeCanvas });
  const pr = probe(W, { far: STAIR });
  let pixels;
  for (let f = 1; f <= frames; f++) {
    crest.update({ probe: { ...pr, lag: lagRows ? 1 : 0, mode: lagRows ? 'async' : 'sync' }, frameId: f, timeMs: f * 1000 / 60, viewId: 'v',
      transform: ID, stage: STAGE, grid: GRID, qualityLevel: quality, palette });
    // The grid shows this frame's terrain: `lagRows` above the probe's frame.
    pixels = grid(W, H, j => STAIR(j) - lagRows, () => [110, 92, 70], [0, 0, 0, 0]);
    const ctx = { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }),
      putImageData: (image, x, y) => pixels.set(image.data, y * W * 4) };
    if (palette) crest.prepareGrid({ frame: { width: W, height: H, data: pixels } });
    else crest.prepareGrid({ ctx });
  }
  return { crest, pixels, W, H, scale, made };
}

function composite({ crest, pixels, W, scale }, frameId, cinematic = false) {
  const { ctx, layers, at } = rasterCtx(pixels, W, scale);
  const terrain = (c, fit, draw) => crest.drawTerrain(c, fit, frameId, draw);
  const r = compositePixelFrame(ctx, { width: W, height: 36 }, W * scale, 36 * scale, 'fit', () => true, null,
    cinematic ? (c) => c.terrain() : null, null, null, null, (c, fit, options) => crest.drawCrest(c, fit, frameId, options), null, terrain);
  if (!cinematic) for (const layer of layers) if (layer.kind === 'image' && !layer.data) layer.kind = 'terrain';
  return { r, at, layers };
}

test('at the shed rungs no stepped block shows above the line: the terrain is cut at output resolution (Pixel, Cinematic)', () => {
  for (const quality of [CREST_PIXEL_SPLIT_LEVEL, 3, CREST_GRID_SCAN_LEVEL, 6]) for (const cinematic of [false, true]) {
    const frame = shedFrame({ quality });
    const { crest, W, H, scale } = frame;
    assert.equal(crest.snapshot.split, false, 'no split cells (no grid row write-back) on this rung');
    assert.equal(crest.snapshot.fade, 1, 'the line is drawn');
    const { r, at, layers } = composite(frame, 40, cinematic);
    assert.equal(r.cut, true, 'the terrain went through the cut');
    assert.ok(layers.some(l => l.kind === 'terrain'));
    const g = crest._grid.far;
    const { above, holes } = sampleAgainstLine(at, g.line, Float32Array.from({ length: W }, (_, j) => STAIR(j)), W, H, scale);
    const name = `${cinematic ? 'Cinematic' : 'Pixel'} level ${quality}`;
    assert.equal(above.length, 0, `${name}: land above the line at ${JSON.stringify(above.slice(0, 6))}`);
    assert.equal(holes.length, 0, `${name}: sky below the line at ${JSON.stringify(holes.slice(0, 6))}`);
    assert.ok(crest.diagnostics.cutColumns > 50);
  }
  // Without the cut (no smooth sky under it) the stepped blocks show: the
  // check above is not vacuous.
  const frame = shedFrame({ quality: CREST_PIXEL_SPLIT_LEVEL });
  const { ctx, at } = rasterCtx(frame.pixels, frame.W, frame.scale);
  ctx.terrain();
  const { above } = sampleAgainstLine(at, frame.crest._grid.far.line, Float32Array.from({ length: 64 }, (_, j) => STAIR(j)), 64, 36, 20);
  assert.ok(above.length > 100, `${above.length} land samples above the line uncut`);
});

test('a palette look on the heavy rungs keeps split cells: no land above the line', () => {
  const compiled = compilePalette(['#000000', '#ffffff', '#6e5c46', '#5a6e8c']);
  const frame = shedFrame({ quality: 6, palette: compiled });
  const { crest, W, H, scale } = frame;
  crest.finishGrid({ quantize: rgb => rgb });
  assert.equal(crest.snapshot.split, true); assert.equal(crest.snapshot.splitReady, true);
  const { at } = composite(frame, 40);
  const { above, holes } = sampleAgainstLine(at, crest._grid.far.line, Float32Array.from({ length: W }, (_, j) => STAIR(j)), W, H, scale);
  assert.equal(above.length, 0, `land above the line at ${JSON.stringify(above.slice(0, 6))}`);
  assert.equal(holes.length, 0, `sky below the line at ${JSON.stringify(holes.slice(0, 6))}`);
});

test('a probe a frame behind the grid is aligned to the grid: split cells cut the terrain the grid shows', () => {
  for (const lagRows of [1, -1, 2]) {
    const frame = shedFrame({ quality: 0, lagRows });
    const { crest, pixels, W, H } = frame;
    assert.equal(crest.diagnostics.lagShift, -lagRows, `lag ${lagRows}: the common shift was found`);
    assert.ok(crest.diagnostics.aligned > 40);
    const g = crest._grid.far;
    const split = crest._split.image.data;
    const raw = Float32Array.from({ length: W }, (_, j) => STAIR(j) - lagRows);
    // Grid and split halves alone (no output-resolution cut): split cells by themselves follow the moved terrain.
    const { above, holes } = compositeAgainstLine({ data: pixels, split, line: g.line, raw, crossed: g.crossed, crossedEnd: g.crossedEnd, W, H });
    assert.equal(above.length, 0, `lag ${lagRows}: land above the line at ${JSON.stringify(above.slice(0, 4))}`);
    assert.equal(holes.length, 0, `lag ${lagRows}: sky below the line at ${JSON.stringify(holes.slice(0, 4))}`);
    const lineNow = reconstructCrest(raw);
    assert.ok(g.line.every((v, i) => !Number.isFinite(v) || i === 30 || i === 45 || Math.abs(v - lineNow[i]) < 0.51), `lag ${lagRows}: the line sits on this frame's terrain`);
  }
  // A synchronous probe (export) is never shifted.
  const sync = shedFrame({ quality: 0 });
  assert.equal(sync.crest.diagnostics.lagShift, 0); assert.equal(sync.crest.diagnostics.aligned, 0);
});

test('the terrain cut fades in with the line and is redrawn identically for a recording', () => {
  const frame = shedFrame({ quality: CREST_PIXEL_SPLIT_LEVEL, frames: 1 });
  const { crest } = frame;
  assert.ok(crest.snapshot.fade < 1);
  const { layers } = composite(frame, 1);
  const terrain = layers.filter(l => l.kind === 'terrain');
  assert.equal(terrain.length, 2, 'cut terrain plus the cut rows at 1 - fade');
  assert.ok(Math.abs(terrain[1].alpha - (1 - crest.snapshot.fade)) < 1e-9);
  const live = recorder(), capture = recorder();
  crest.drawTerrain(live, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 1, () => {});
  crest.drawTerrain(capture, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 1, () => {});
  assert.deepEqual(capture.ops, live.ops);
  assert.equal(crest.drawTerrain(recorder(), { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 2, () => {}), false, 'another frame draws plainly');
});

test('compositePixelFrame cuts the terrain only over a smooth sky and tells the crest', () => {
  const calls = [];
  const ctx = { setTransform() {}, fillRect() {}, drawImage() { calls.push('native'); }, save() {}, restore() {} };
  const terrain = (c, fit, draw) => { calls.push('cut'); draw(); return true; };
  const crest = (c, fit, options) => { calls.push(`crest:${options.cut}`); return true; };
  let r = compositePixelFrame(ctx, { width: 320, height: 180 }, 1280, 720, 'fit', () => true, null, null, null, null, null, crest, null, terrain);
  assert.deepEqual(calls, ['cut', 'native', 'crest:true']); assert.equal(r.cut, true);
  calls.length = 0;
  r = compositePixelFrame(ctx, { width: 320, height: 180 }, 1280, 720, 'fit', null, null, null, null, null, null, crest, null, terrain);
  assert.deepEqual(calls, ['native', 'crest:false'], 'no smooth sky under it: drawn plainly'); assert.equal(r.cut, false);
  calls.length = 0;
  r = compositePixelFrame(ctx, { width: 320, height: 180 }, 1280, 720, 'fit', () => true, null, () => { calls.push('cinematic'); return true; }, null, null, null, crest, null, terrain);
  assert.deepEqual(calls, ['cut', 'cinematic', 'crest:true'], 'the Cinematic reconstruction is drawn through the cut'); assert.equal(r.cut, true);
});

test('a small roll keeps split cells; a large one sheds them', () => {
  const crest = new RangeCrest({ makeCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) }) });
  const roll = (theta) => [Math.cos(theta), Math.sin(theta), -Math.sin(theta), Math.cos(theta), 0, 0];
  for (let f = 1; f <= 20; f++) crest.update({ probe: probe(64, bands()), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: roll(0.002), stage: STAGE, grid: GRID });
  assert.equal(crest.snapshot.split, true, 'a landing ring-down roll (0.002 rad) keeps split cells');
  crest.update({ probe: probe(64, bands()), frameId: 21, timeMs: 21 * 1000 / 60, viewId: 'v', transform: roll(0.05), stage: STAGE, grid: GRID });
  assert.equal(crest.snapshot.split, false);
});

test('export draws pass instant to the crest; live draws do not', async () => {
  const { RangePresentation } = await import('../src/world/alpine/RangePresentation.js');
  for (const exportMode of [true, false]) {
    let seen = null, readSync = null;
    const self = { frame: { frameId: 7, timeMs: 1000, qualityLevel: 0 }, arrival: 1, exportMode, viewId: 'v', _crestTimeline: 1, crestPalette: null,
      scene: { crestProbeMode: 'refined', readCrestProbe: (id, { sync }) => { readSync = sync; return probe(64, bands()); } },
      crest: { update: (args) => { seen = args; } } };
    RangePresentation.prototype._finishCrest.call(self, { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), canvas: GRID }, STAGE);
    assert.equal(readSync, exportMode); assert.equal(seen.instant, exportMode);
  }
});

test('where split cells already cut the edge (levels 0-1, palettes) the terrain is not clipped again', () => {
  const fit = { x: 0, y: 0, width: 1280, height: 720, scale: 20 };
  for (const lagRows of [0, 1]) {
    const { crest } = shedFrame({ quality: 0, lagRows });
    assert.equal(crest.snapshot.splitAlpha, 1);
    assert.equal(crest.drawTerrain(recorder(), fit, 40, () => {}), false, `lag ${lagRows}: no clip`);
  }
  const shed = shedFrame({ quality: CREST_PIXEL_SPLIT_LEVEL });
  assert.equal(shed.crest.drawTerrain(recorder(), fit, 40, () => {}), true, 'split cells shed: clipped');
});

test('a continuous export frame on a new view (hard cut, travel handoff) fades in like live playback', () => {
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  const pr = probe(64, bands());
  // [frameId, view, probe?]: a steady view, a hard cut at frame 11; then a
  // travel (frames 21-24 draw no crest) handing off to a third view.
  const frames = [];
  for (let f = 1; f <= 10; f++) frames.push([f, 'a', true]);
  for (let f = 11; f <= 20; f++) frames.push([f, 'b', true]);
  for (let f = 21; f <= 24; f++) frames.push([f, 'b', false]);
  for (let f = 25; f <= 40; f++) frames.push([f, 'c', true]);
  const live = new RangeCrest({ makeCanvas }), exported = new RangeCrest({ makeCanvas });
  for (const [frameId, viewId, has] of frames) {
    const args = { probe: has ? pr : null, frameId, timeMs: frameId * 1000 / 60, viewId, transform: ID, stage: STAGE, grid: GRID };
    live.update(args); exported.update({ ...args, instant: true });
    if (frameId === 1) { assert.equal(exported.snapshot.fade, 1, 'the first export frame has no history: full strength'); continue; }
    if (!has) { assert.equal(exported.snapshot, null); continue; }
    if (frameId >= 11) {
      assert.equal(exported.snapshot.fade, live.snapshot.fade, `frame ${frameId}: line fade as live`);
      assert.equal(exported.snapshot.splitFade, live.snapshot.splitFade, `frame ${frameId}: split fade as live`);
    }
    if (frameId === 11 || frameId === 25) assert.ok(exported.snapshot.fade < 0.2, `frame ${frameId}: a new view fades in`);
  }
  // A seek inside the export is still isolated: full strength.
  exported.update({ probe: pr, instant: true, frameId: 41, timeMs: 99999, viewId: 'c', transform: ID, stage: STAGE, grid: GRID });
  assert.equal(exported.snapshot.fade, 1);
  exported.update({ probe: pr, instant: true, frameId: 50, timeMs: 99999 + 9 * 1000 / 60, viewId: 'd', transform: ID, stage: STAGE, grid: GRID });
  assert.equal(exported.snapshot.fade, 1, 'a frame gap with a new view is isolated too');
});

test('under steady sub-row motion the aligned line moves steadily, without whole-row jumps back and forth', () => {
  const W = 64, H = 36;
  const makeCanvas = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });
  for (const speed of [0.4, 0.5, 0.6]) {
    const truth = (j, f) => 5 + j * 0.15 + speed * f; // a sloped skyline panning down
    const crest = new RangeCrest({ makeCanvas });
    const means = [], shifts = new Set();
    for (let f = 1; f <= 30; f++) {
      // The live probe is one frame older than the grid it edits.
      const pr = probe(W, { far: j => Math.round(truth(j, f - 1)) });
      crest.update({ probe: { ...pr, lag: 1, mode: 'async' }, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
      const pixels = grid(W, H, j => Math.round(truth(j, f)), () => [110, 92, 70], [0, 0, 0, 0]);
      crest.prepareGrid({ ctx: { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }), putImageData() {} } });
      const g = crest._grid.far;
      let sum = 0, n = 0, err = 0;
      for (let i = 4; i < W - 4; i++) if (Number.isFinite(g.line[i])) { sum += g.line[i]; err += g.line[i] - truth(i, f); n++; }
      means.push({ mean: sum / n, err: err / n });
      shifts.add(crest.diagnostics.lagShift);
    }
    if (speed === 0.5) assert.ok(shifts.has(0) && shifts.has(1), `the whole-row majority offset does flip (${[...shifts]})`);
    const steps = [];
    for (let k = 12; k < means.length; k++) steps.push(means[k].mean - means[k - 1].mean);
    assert.ok(steps.every(d => d > 0.05), `speed ${speed}: the stroke never stands still or moves back (${steps.map(d => d.toFixed(2))})`);
    assert.ok(steps.every(d => Math.abs(d - speed) < 0.35), `speed ${speed}: no whole-row jumps (${steps.map(d => d.toFixed(2))})`);
    assert.ok(means.slice(12).every(m => Math.abs(m.err) < 0.25), `speed ${speed}: the line sits on this frame's terrain (${means.slice(12).map(m => m.err.toFixed(2))})`);
  }
});

test('economy (8-bit) keeps the heavy rungs on the old no-probe path: no light probe, no terrain cut', () => {
  const crest = new RangeCrest();
  crest.economy = true;
  crest.update({ probe: probe(64, bands()), frameId: 1, timeMs: 0, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: 6 });
  assert.equal(crest.mode, 'grid'); assert.equal(crest.probeMode, null, 'no probe passes or readback on the economy floor');
  // A palette look scans its own frame for the line, with no cut.
  const W = 64, H = 36, pixels = grid(W, H, STAIR, () => [110, 92, 70], [0, 0, 0, 0]);
  crest.update({ probe: null, scan: true, frameId: 2, timeMs: 1000 / 60, viewId: 'v', grid: GRID, qualityLevel: 6, palette: 'rgb332' });
  assert.equal(crest.snapshot.scan, true);
  assert.ok(crest.prepareGrid({ frame: { width: W, height: H, data: pixels } }));
  assert.equal(crest.drawTerrain(recorder(), { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 2, () => {}), false);
  // Auto quality on the same rung keeps the light probe.
  crest.economy = false;
  assert.equal(crest.probeMode, 'grid');
});

test('the presenter tells the crest about the economy floor before choosing the probe mode', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/world/alpine/RangePresentation.js', import.meta.url), 'utf8');
  const set = src.indexOf('this.crest.economy = !!inputs.sim?.perf?.economy'), use = src.indexOf('this.scene.crestProbeMode = crestOn ? this.crest.probeMode');
  assert.ok(set > 0 && use > set);
});

// A glow layer drawn into the grid: translucent warm cells over the sky.
const GLOW = [255, 240, 200, 25];

test('split cells keep translucent sky-side content in the cells they cut', () => {
  const W = 64, H = 36, line = STAIR;
  const crest = new RangeCrest({ makeCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) }) });
  const pr = probe(W, { far: line });
  let pixels;
  for (let f = 1; f <= 40; f++) {
    crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
    pixels = grid(W, H, line, () => [110, 92, 70], GLOW);
    crest.prepareGrid({ ctx: { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }), putImageData: (image, x, y) => pixels.set(image.data, y * W * 4) } });
  }
  const g = crest._grid.far;
  let cut = 0;
  for (let i = 1; i < W - 1; i++) for (let r = 0; r < line(i); r++) {
    const k = (r * W + i) * 4;
    assert.deepEqual([...pixels.slice(k, k + 4)], GLOW, `sky-side cell (${i}, ${r}) keeps the glow`);
  }
  for (let i = 1; i < W - 1; i++) {
    const [top] = crestSpan(g.line, i);
    for (let r = line(i); r + 1 <= top; r++) {
      const k = (r * W + i) * 4;
      assert.ok(Math.abs(pixels[k + 3] - GLOW[3]) <= 1 && Math.abs(pixels[k] - GLOW[0]) <= 1, `cut land cell (${i}, ${r}) takes the glow, not alpha 0: ${[...pixels.slice(k, k + 4)]}`);
      cut++;
    }
    if (g.crossed[i] >= 0) {
      const k = (g.crossed[i] * W + i) * 4;
      assert.ok(Math.abs(pixels[k + 3] - GLOW[3]) <= 1, `crossed cell (${i}, ${g.crossed[i]}) keeps the glow above the line`);
      cut++;
    }
  }
  assert.ok(cut > 20, `${cut} cut cells checked`);
});

test('the terrain cut carries translucent sky-side content into the cut: no step at the cut top', () => {
  for (const quality of [CREST_PIXEL_SPLIT_LEVEL, CREST_GRID_SCAN_LEVEL]) for (const fresh of [true, false]) {
    const W = 64, H = 36, scale = 20;
    const crest = new RangeCrest();
    const pr = probe(W, { far: STAIR });
    const pixels = grid(W, H, STAIR, () => [110, 92, 70], GLOW);
    const ctx = { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * W * 4, (y + h) * W * 4) }), putImageData() {} };
    const frames = fresh ? 40 : 41;
    for (let f = 1; f <= frames; f++) {
      crest.update({ probe: pr, frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: quality });
      // Without split cells the rows are read only every 0.5 s: frame 41 has no reading of its own.
      crest.prepareGrid({ ctx: f === frames && !fresh ? null : ctx });
    }
    const fit = { x: 0, y: 0, width: W * scale, height: H * scale, scale };
    const out = recorder();
    assert.equal(crest.drawTerrain(out, fit, frames, () => out.drawImage({ width: W }, 0, 0, W * scale, H * scale), { width: W, height: H }), true);
    const recorded = out.ops.filter(op => op[0] === 'drawImage').map(op => ({ args: op.slice(2) }));
    const refills = recorded.filter(d => d.args.length === 8);
    assert.ok(refills.length > 0, `level ${quality}${fresh ? '' : ' (no reading this frame)'}: the cut is refilled`);
    assert.ok(crest.diagnostics.glowRefill > 50);
    // Every cut column is refilled from the translucent cell just above its cut top, down past the line.
    const c = crest._cut, covered = new Uint8Array(W);
    for (const { args: [sx, sy, sw, sh, dx, dy, dw, dh] } of refills) {
      assert.equal(sh, 1);
      for (let i = sx; i < sx + sw; i++) {
        assert.equal(sy, c.top[i] - 1, `column ${i}: source row`);
        const k = (sy * W + i) * 4;
        assert.ok(pixels[k + 3] > 0 && pixels[k + 3] < 250, 'only translucent source cells');
        assert.ok(Math.abs(dy - c.top[i] * scale) < 1e-6 && dy + dh >= crest._grid.far.line[i] * scale, `column ${i}: covers the cut down to the line`);
        covered[i] = 1;
      }
      assert.ok(Math.abs(dx - sx * scale) < 1e-6 && Math.abs(dw - sw * scale) < 1e-6);
    }
    for (let i = 0; i < W; i++) if (c.band[i] >= 0 && c.top[i] > 0) assert.equal(covered[i], 1, `column ${i} refilled`);
  }
  // No glow: nothing extra is drawn.
  const crest = new RangeCrest();
  const pixels = grid(64, 36, STAIR, () => [110, 92, 70], [0, 0, 0, 0]);
  for (let f = 1; f <= 40; f++) {
    crest.update({ probe: probe(64, { far: STAIR }), frameId: f, timeMs: f * 1000 / 60, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: CREST_PIXEL_SPLIT_LEVEL });
    crest.prepareGrid({ ctx: { getImageData: (x, y, w, h) => ({ data: pixels.slice(y * 64 * 4, (y + h) * 64 * 4) }), putImageData() {} } });
  }
  const ops = recorder();
  crest.drawTerrain(ops, { x: 0, y: 0, width: 1280, height: 720, scale: 20 }, 40, () => {}, { width: 64, height: 36 });
  assert.equal(ops.ops.filter(op => op[0] === 'drawImage').length, 0); assert.equal(crest.diagnostics.glowRefill, 0);
});
