// Landscape crest line and shorelines (docs/pixel-presentation.md, "Crest
// line"). One instance per RangePresentation. Each frame:
//
//  1. update(): decode the GPU column probe (CrestProbe.js), rebuild a
//     sub-cell crest per band, steady it in time, map it into the pixel
//     grid and freeze everything the frame draws into `snapshot`.
//  2. prepareGrid(): before palette quantization, re-own the grid cells
//     within ±1 of each smoothed line (split-cell rule, CrestLine.js).
//  3. drawCrest() / drawShore(): at output resolution, inside the presenter's
//     composite, live and again for a recording, from the same snapshot.
//
// Nothing here advances on a redraw: a recording reproduces the frame.
import {
  CREST_BANDS, CREST_FILTER, CREST_LAND_SIDE, crestE, crestStroke, shoreStroke, filterCrest, filterSample,
  reconstructCrest, crestLineColor, shoreColor, snapCrestColor, reownCrestCells, linkShoreChains,
} from '../../render/CrestLine.js';
import { PROBE_BAND_ROWS, PROBE_WATER_ROW, PROBE_WATER_SLOTS, probeRow } from './CrestProbe.js';

export const CREST_SPLIT_KEY = 'range:crest-split';
/** Quality rung from which the crest falls back to the plain grid scan
 *  (integer rows, no elevation, no split cells, no shorelines). */
export const CREST_GRID_SCAN_LEVEL = 4;
export const CREST_FADE_SEC = 0.5;
const CHUNK = 8; // columns per stroke (one colour, width and opacity each)
const SLOW_TAU_SEC = 1.0; // elevation / band-foot smoothing
const SEEK_JUMP_MS = 250;
// Edge visibility (colour contrast across the line, 0..1 per channel mean).
const VIS_LOW = 0.02, VIS_HIGH = 0.09, VIS_TAU_SEC = 0.3, VIS_UNKNOWN = 0.35;

const hexRgb = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return null;
  return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
};
const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

function bandState(n) {
  return { raw: new Float32Array(n), recon: new Float32Array(n), filter: { y: new Float32Array(n).fill(NaN), d: new Float32Array(n) },
    elev: new Float32Array(n).fill(NaN), color: new Uint8Array(n * 3), foot: NaN, top: NaN };
}
function gridBand(n) {
  return { line: new Float32Array(n), raw: new Float32Array(n), e: new Float32Array(n), skyline: new Uint8Array(n),
    minNearer: new Float32Array(n), skip: new Uint8Array(n), crossed: new Int16Array(n), colorAt: new Int32Array(n), chunks: [],
    vis: new Float32Array(n).fill(NaN) };
}

export class RangeCrest {
  constructor({ makeCanvas = null, residency = null } = {}) {
    this.makeCanvas = makeCanvas;
    this.residency = residency;
    this.mode = 'refined';
    this.fade = 0;
    this.snapshot = null;
    this._targetWidth = 0;
    this._gridKey = '';
    this._bands = null; // target-space state per band
    this._grid = null; // grid-space arrays per band
    this._shore = null;
    this._last = null; // { frameId, timeMs, viewId }
    this._split = null; // { canvas, image, dirty: [y0, y1] }
    this._orig = null;
    this.diagnostics = { mode: this.mode, fade: 0, resets: 0, lastReset: null, probeMs: 0, updateMs: 0, prepareMs: 0, drawMs: 0, shoreMs: 0,
      splitCells: 0, columns: 0, shoreChains: 0, readback: 'none' };
  }

  /** Drop the temporal state: the next frame starts from its raw crest. */
  reset(reason = 'reset') {
    if (this._bands) for (const b of Object.values(this._bands)) { b.filter.y.fill(NaN); b.filter.d.fill(0); b.elev.fill(NaN); b.foot = b.top = NaN; }
    if (this._shore) { this._shore.y.fill(NaN); this._shore.kind.fill(0); }
    if (this._grid) for (const g of Object.values(this._grid)) g.vis.fill(NaN);
    this.diagnostics.resets++;
    this.diagnostics.lastReset = reason;
  }

  /** The probe mode the next frame should render. */
  get probeMode() { return this.mode; }

  _ensure(targetWidth, grid) {
    if (this._targetWidth !== targetWidth) {
      this._targetWidth = targetWidth;
      this._bands = Object.fromEntries(CREST_BANDS.map(b => [b, bandState(targetWidth)]));
      this._shore = { y: new Float32Array(targetWidth * PROBE_WATER_SLOTS).fill(NaN), d: new Float32Array(targetWidth * PROBE_WATER_SLOTS),
        kind: new Uint8Array(targetWidth * PROBE_WATER_SLOTS), nextY: new Float32Array(targetWidth * PROBE_WATER_SLOTS),
        nextD: new Float32Array(targetWidth * PROBE_WATER_SLOTS), nextKind: new Uint8Array(targetWidth * PROBE_WATER_SLOTS) };
      this.reset('resize');
    }
    const key = `${grid.width}x${grid.height}`;
    if (this._gridKey !== key) {
      this._gridKey = key;
      this._grid = Object.fromEntries(CREST_BANDS.map(b => [b, gridBand(grid.width)]));
      this._releaseSplit();
      this.reset('grid');
    }
  }

  /**
   * Freeze this frame. `probe` is CrestProbe.read() (null: nothing this
   * frame, e.g. travel or arrival); `transform` maps the stage into the grid
   * (the scenic canvas transform) and `stage` is the stage size the target
   * is drawn at. `palette` is null, 'rgb332' or a compiled palette.
   */
  update({ probe, frameId, timeMs = 0, viewId = null, qualityLevel = 0, transform, stage, grid, sky = null, palette = null } = {}) {
    const t0 = performance.now();
    const last = this._last;
    const rawDt = last && Number.isFinite(timeMs) ? (timeMs - last.timeMs) / 1000 : 0;
    const dt = rawDt > 0 && rawDt < SEEK_JUMP_MS / 1000 ? rawDt : 1 / 60;
    // Quality changes fade the line out, switch the probe, then fade back in.
    const desired = qualityLevel >= CREST_GRID_SCAN_LEVEL ? 'grid' : 'refined';
    const switching = desired !== this.mode;
    if (switching) {
      this.fade = Math.max(0, this.fade - dt / CREST_FADE_SEC);
      if (this.fade === 0) { this.mode = desired; this.reset('quality'); }
    }
    this.diagnostics.mode = this.mode;
    // A frame without a probe (travel, arrival) breaks the filter's chain.
    this._last = { frameId: probe ? frameId : NaN, timeMs, viewId };
    if (!probe || !grid?.width || !transform || !stage?.width) {
      this.snapshot = null;
      this.diagnostics.fade = this.fade;
      return null;
    }
    this._ensure(probe.width, grid);
    if (!last || last.viewId !== viewId) { this.reset('view'); this.fade = 0; }
    else if (last.frameId !== frameId - 1) this.reset('gap');
    else if (rawDt < -0.001 || rawDt > SEEK_JUMP_MS / 1000) this.reset('seek');
    if (!switching) this.fade = Math.min(1, this.fade + dt / CREST_FADE_SEC);
    const refined = this.mode === 'refined';
    const W = probe.width, data = probe.data, Wg = grid.width;
    const [a, b, c, d, e, f] = transform;
    // Target pixels -> stage units (the partition is drawn stretched over the stage).
    // (The probe's own target size: the scene canvas may since have been
    // resized for the water pass.)
    const sx = stage.width / W, sy = stage.height / (probe.height || stage.targetHeight || stage.height);
    const rotated = Math.abs(b) + Math.abs(c) > 1e-3 * Math.abs(a);
    const k = 1 - Math.exp(-dt / SLOW_TAU_SEC);
    let columns = 0;
    for (const band of CREST_BANDS) {
      const s = this._bands[band], g = this._grid[band], row = PROBE_BAND_ROWS[band];
      const valid = probe.rows & (1 << row);
      for (let j = 0; j < W; j++) {
        // Inline probeRow(): row, depth flag and elevation of this column.
        const o = (row * W + j) * 4, present = valid && data[o + 3] > 0;
        const r = present ? data[o] + (data[o + 1] & 31) * 256 - 1 : -1;
        // A crest on the target's top row is cut off by the frame: not a crest.
        s.raw[j] = r > 0 ? r : NaN;
        if (r > 0 && refined && data[o + 3] > 200) { const v = data[o + 2] / 255; s.elev[j] = Number.isFinite(s.elev[j]) ? s.elev[j] + k * (v - s.elev[j]) : v; }
        else if (!refined || r <= 0) s.elev[j] = NaN;
        const ci = ((row + 1) * W + j) * 4;
        s.color[j * 3] = data[ci]; s.color[j * 3 + 1] = data[ci + 1]; s.color[j * 3 + 2] = data[ci + 2];
      }
      if (refined) reconstructCrest(s.raw, s.recon); else s.recon.set(s.raw);
      const input = s.recon;
      const fast = filterCrest(s.filter, input, dt, CREST_FILTER);
      // A cut moves most columns at once: the slow terms restart with it.
      let present = 0; for (let j = 0; j < W; j++) if (Number.isFinite(input[j])) present++;
      if (present && fast > present / 2) { s.foot = s.top = NaN; s.elev.fill(NaN); }
      // Target -> grid, resampled at grid column centres (x increases with j).
      const sxa = a * sx, syc = c * sy, sxb = b * sx, syd = d * sy;
      const yAt = (j, y) => sxb * (j + 0.5) + syd * y + f;
      const xAt = (j, y) => sxa * (j + 0.5) + syc * y + e;
      let j = 0;
      for (let i = 0; i < Wg; i++) {
        const xc = i + 0.5;
        while (j + 1 < W && xAt(j + 1, 0) < xc) j++;
        const y0 = s.filter.y[j], y1 = s.filter.y[Math.min(W - 1, j + 1)];
        const x0 = xAt(j, Number.isFinite(y0) ? y0 : 0), x1 = xAt(Math.min(W - 1, j + 1), Number.isFinite(y1) ? y1 : 0);
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || xc < x0 - 1 || xc > x1 + 1) { g.line[i] = NaN; g.raw[i] = NaN; g.colorAt[i] = -1; continue; }
        const u = x1 > x0 ? Math.min(1, Math.max(0, (xc - x0) / (x1 - x0))) : 0;
        g.line[i] = yAt(j, y0) + (yAt(Math.min(W - 1, j + 1), y1) - yAt(j, y0)) * u;
        const near = u < 0.5 ? j : Math.min(W - 1, j + 1);
        g.raw[i] = Number.isFinite(s.raw[near]) ? Math.ceil(yAt(near, s.raw[near]) - 0.5) : NaN;
        g.colorAt[i] = near;
        columns++;
      }
      // Height above the band's foot, normalized by its slowly followed span.
      let foot = -Infinity, top = Infinity;
      for (let i = 0; i < Wg; i++) { const L = g.line[i]; if (Number.isFinite(L)) { if (L > foot) foot = L; if (L < top) top = L; } }
      if (Number.isFinite(foot)) {
        s.foot = Number.isFinite(s.foot) ? s.foot + k * (foot - s.foot) : foot;
        s.top = Number.isFinite(s.top) ? s.top + k * (top - s.top) : top;
      }
      const span = Math.max(2, s.foot - s.top);
      for (let i = 0; i < Wg; i++) {
        const L = g.line[i];
        g.e[i] = Number.isFinite(L) ? crestE(refined ? s.elev[g.colorAt[i]] : NaN, (s.foot - L) / span) : 0;
      }
    }
    // Skyline and occlusion between bands (far 0, mid 1, near 2).
    for (let bi = 0; bi < CREST_BANDS.length; bi++) {
      const g = this._grid[CREST_BANDS[bi]];
      for (let i = 0; i < Wg; i++) {
        const L = g.line[i];
        let farther = false, nearer = Infinity;
        for (let o = 0; o < CREST_BANDS.length; o++) {
          if (o === bi) continue;
          const M = this._grid[CREST_BANDS[o]].line[i];
          if (!Number.isFinite(M)) continue;
          if (o < bi && M < L - 0.5) farther = true;
          if (o > bi && M < nearer) nearer = M;
        }
        g.skyline[i] = farther ? 0 : 1;
        g.minNearer[i] = nearer;
        g.skip[i] = !Number.isFinite(L) || nearer < L + 1.5 ? 1 : 0;
        g.crossed[i] = -1;
      }
    }
    const skyRgb = hexRgb(sky);
    for (const band of CREST_BANDS) this._grid[band].chunks = this._chunks(band, this._bands[band], this._grid[band], Wg, skyRgb, palette);
    const shores = refined ? this._updateShores(probe, dt, { a, b, c, d, e, f, sx, sy }, palette) : [];
    this.snapshot = Object.freeze({ frameId, dt, grid: { width: grid.width, height: grid.height }, mode: this.mode, fade: this.fade,
      split: refined && !rotated && !!this.makeCanvas, splitReady: false, palette, shores });
    this.diagnostics.fade = this.fade;
    this.diagnostics.columns = columns;
    this.diagnostics.mapping = { transform: [a, b, c, d, e, f], stage: { ...stage }, target: W };
    this.diagnostics.probeMs = probe.readMs || 0;
    this.diagnostics.shoreChains = shores.length;
    this.diagnostics.updateMs = performance.now() - t0;
    return this.snapshot;
  }

  _chunks(band, s, g, Wg, sky, palette) {
    const out = [];
    let i = 0;
    while (i < Wg) {
      if (!Number.isFinite(g.line[i])) { i++; continue; }
      let j = i;
      while (j + 1 < Wg && Number.isFinite(g.line[j + 1]) && j + 1 - i < CHUNK) j++;
      let rgb = [0, 0, 0], n = 0, e = 0, sky1 = 0;
      for (let x = i; x <= j; x++) {
        const t = g.colorAt[x];
        if (t >= 0) { rgb[0] += s.color[t * 3]; rgb[1] += s.color[t * 3 + 1]; rgb[2] += s.color[t * 3 + 2]; n++; }
        e += g.e[x]; sky1 += g.skyline[x];
      }
      if (n) rgb = rgb.map(v => v / n);
      const count = j - i + 1;
      const tier = sky1 * 2 > count ? 'skyline' : band;
      const color = snapCrestColor(crestLineColor(rgb, sky, band), palette);
      // A chunk continues into the next column so strokes join.
      const end = j + 1 < Wg && Number.isFinite(g.line[j + 1]) ? j + 1 : j;
      out.push(Object.freeze({ start: i, end, tier, e: e / count, color: css(color) }));
      i = j + 1;
    }
    return out;
  }

  _updateShores(probe, dt, m, palette) {
    const t0 = performance.now();
    const W = probe.width, data = probe.data, st = this._shore;
    const valid = probe.rows & (1 << PROBE_WATER_ROW);
    st.nextY.fill(NaN); st.nextKind.fill(0);
    // 1. This frame's raw shore edges per column.
    const cols = new Array(W);
    for (let j = 0; j < W; j++) {
      const list = [];
      for (let s = 0; valid && s < PROBE_WATER_SLOTS; s++) {
        const info = probeRow(data, ((PROBE_WATER_ROW + s) * W + j) * 4);
        if (info.row < 0) break;
        if (!info.shore || info.row <= 0) continue;
        const ci = ((PROBE_WATER_ROW + PROBE_WATER_SLOTS + s) * W + j) * 4;
        list.push({ y: info.row, kind: info.kind, nearness: info.value, rgb: [data[ci], data[ci + 1], data[ci + 2]] });
      }
      cols[j] = list;
    }
    // 2. Chains across columns, rebuilt to sub-cell positions and lightly
    // smoothed along their length (a water mask edge is noisier than land).
    // 3. Each point then follows the same edge from the last frame (same
    // column and kind, nearest row) through the crest filter: steady, and
    // music water waves below the deadband never ripple it.
    const step = dt > 0 ? Math.min(dt, 1 / 15) : 1 / 60;
    const chains = [];
    for (const chain of linkShoreChains(cols)) {
      if (chain.length < 3) continue;
      const n = chain.length, rows = new Float32Array(n);
      chain.forEach(([j, s], p) => { rows[p] = cols[j][s].y; });
      const ys = reconstructCrest(rows);
      for (let pass = 0; pass < 2; pass++) {
        let prev = ys[0];
        for (let p = 1; p < n - 1; p++) { const cur = ys[p]; ys[p] = (prev + 2 * cur + ys[p + 1]) / 4; prev = cur; }
      }
      const pts = new Float32Array(n * 2);
      let near = 0;
      const rgb = [0, 0, 0];
      const kind = cols[chain[0][0]][chain[0][1]].kind;
      chain.forEach(([j, s], p) => {
        const t = cols[j][s];
        let best = -1, bestD = 3;
        for (let q = j * PROBE_WATER_SLOTS; q < (j + 1) * PROBE_WATER_SLOTS; q++) {
          if (st.kind[q] !== kind || !Number.isFinite(st.y[q])) continue;
          const dd = Math.abs(st.y[q] - ys[p]);
          if (dd < bestD) { bestD = dd; best = q; }
        }
        let slot = j * PROBE_WATER_SLOTS;
        while (slot < (j + 1) * PROBE_WATER_SLOTS - 1 && st.nextKind[slot]) slot++;
        st.nextY[slot] = best >= 0 ? st.y[best] : NaN; st.nextD[slot] = best >= 0 ? st.d[best] : 0;
        if (best >= 0) st.kind[best] = 0; // consumed
        filterSample(st.nextY, st.nextD, slot, ys[p], step, CREST_FILTER);
        st.nextKind[slot] = kind;
        const y = st.nextY[slot], x = j + 0.5;
        pts[p * 2] = m.a * m.sx * x + m.c * m.sy * y + m.e;
        pts[p * 2 + 1] = m.b * m.sx * x + m.d * m.sy * y + m.f;
        near += t.nearness; rgb[0] += t.rgb[0]; rgb[1] += t.rgb[1]; rgb[2] += t.rgb[2];
      });
      chains.push(Object.freeze({ points: pts, kind, nearness: near / n,
        color: css(snapCrestColor(shoreColor(rgb.map(v => v / n)), palette)) }));
    }
    st.y.set(st.nextY); st.d.set(st.nextD); st.kind.set(st.nextKind);
    this.diagnostics.shoreMs = performance.now() - t0;
    return chains;
  }

  _ensureSplit(width, height) {
    const s = this._split;
    if (s && s.canvas.width === width && s.canvas.height === height && (!this.residency || this.residency.get(CREST_SPLIT_KEY) === s.canvas)) return s;
    this._releaseSplit();
    if (!this.makeCanvas) return null;
    const bytes = width * height * 8; // the canvas and its CPU image
    const res = this.residency?.reserve({ key: CREST_SPLIT_KEY, bytes, owner: 'range-crest' });
    if (this.residency && !res) return null;
    const canvas = this.makeCanvas(width, height);
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) { if (res) this.residency.releaseReservation?.(res); return null; }
    const image = ctx.createImageData ? ctx.createImageData(width, height) : { width, height, data: new Uint8ClampedArray(width * height * 4) };
    if (res && !this.residency.commit(res, canvas, x => { x.width = x.height = 0; if (this._split?.canvas === x) this._split = null; })) return null;
    this._split = { canvas, image, dirty: null };
    return this._split;
  }

  _releaseSplit() {
    if (!this._split) return;
    if (this.residency) this.residency.release(CREST_SPLIT_KEY);
    else this._split.canvas.width = this._split.canvas.height = 0;
    this._split = null;
  }

  /**
   * Before palette quantization: re-own the grid cells within ±1 of each
   * smoothed line. `frame` is the whole grid's ImageData when the palette
   * pass has already read it back; otherwise only the rows the lines cross
   * are read from `ctx` and written back.
   */
  prepareGrid({ ctx = null, frame = null } = {}) {
    const snap = this.snapshot;
    if (!snap?.split || snap.splitReady || !(snap.fade > 0)) return false;
    const t0 = performance.now();
    const { width: W, height: H } = snap.grid;
    let lo = Infinity, hi = -Infinity;
    for (const band of CREST_BANDS) {
      const g = this._grid[band];
      for (let i = 0; i < W; i++) if (!g.skip[i]) { const L = g.line[i]; if (L < lo) lo = L; if (L > hi) hi = L; }
    }
    if (!Number.isFinite(lo)) return false;
    const y0 = Math.max(0, Math.floor(lo) - 3), y1 = Math.min(H, Math.floor(hi) + 4);
    if (y1 <= y0) return false;
    const split = this._ensureSplit(W, H);
    if (!split) return false;
    let image;
    try {
      if (frame) image = { data: frame.data.subarray(y0 * W * 4, y1 * W * 4), width: W, y0, rows: y1 - y0 };
      else {
        const read = ctx.getImageData(0, y0, W, y1 - y0);
        image = { data: read.data, width: W, y0, rows: y1 - y0, read };
      }
    } catch { return false; }
    const length = image.data.length;
    if (!this._orig || this._orig.length < length) this._orig = new Uint8ClampedArray(W * H * 4);
    const orig = this._orig.subarray(0, length);
    orig.set(image.data);
    const sdata = split.image.data;
    if (split.dirty) sdata.fill(0, split.dirty[0] * W * 4, split.dirty[1] * W * 4);
    const splitView = sdata.subarray(y0 * W * 4, y1 * W * 4);
    let cells = 0;
    const kv = 1 - Math.exp(-(snap.dt || 1 / 60) / VIS_TAU_SEC);
    for (const band of CREST_BANDS) {
      const g = this._grid[band];
      this._visibility(g, orig, W, y0, y1, kv);
      cells += reownCrestCells(image, orig, splitView, g.line, g.raw, g.skip, g.crossed);
    }
    if (snap.palette) {
      for (const band of CREST_BANDS) {
        const g = this._grid[band];
        for (let i = 0; i < W; i++) {
          const r = g.crossed[i];
          if (r < 0) continue;
          const q = (r * W + i) * 4;
          if (!sdata[q + 3]) continue;
          const c = snapCrestColor([sdata[q], sdata[q + 1], sdata[q + 2]], snap.palette);
          sdata[q] = c[0]; sdata[q + 1] = c[1]; sdata[q + 2] = c[2];
        }
      }
    }
    try {
      if (image.read) ctx.putImageData(image.read, 0, y0);
      const d0 = split.dirty ? Math.min(split.dirty[0], y0) : y0, d1 = split.dirty ? Math.max(split.dirty[1], y1) : y1;
      split.canvas.getContext('2d').putImageData(split.image, 0, 0, 0, d0, W, d1 - d0);
      split.dirty = [y0, y1];
    } catch { return false; }
    this.snapshot = Object.freeze({ ...snap, splitReady: true });
    this.diagnostics.splitCells = cells;
    this.diagnostics.readback = frame ? 'palette-frame' : 'crest-rows';
    this.diagnostics.prepareMs = performance.now() - t0;
    return true;
  }

  /** How visible each column's edge is in the grid itself: colour contrast
   * between the land two cells below the line and what lies two cells above
   * (sky drawn separately counts as full contrast). A band boundary lost in
   * haze gets no line; followed slowly so it never flickers. */
  _visibility(g, orig, W, y0, y1, k) {
    for (let i = 0; i < W; i++) {
      const L = g.line[i];
      if (!Number.isFinite(L)) continue;
      const ra = Math.floor(L) - 2, rb = Math.floor(L) + 2;
      if (ra < y0 || rb >= y1) continue;
      let sum = 0, n = 0, open = false;
      for (let x = Math.max(0, i - 1); x <= Math.min(W - 1, i + 1); x++) {
        const a = ((ra - y0) * W + x) * 4, b = ((rb - y0) * W + x) * 4;
        if (orig[a + 3] < 128) { open = true; break; }
        sum += (Math.abs(orig[a] - orig[b]) + Math.abs(orig[a + 1] - orig[b + 1]) + Math.abs(orig[a + 2] - orig[b + 2])) / 765; n++;
      }
      const c = open ? 1 : n ? sum / n : 0;
      const v = c <= VIS_LOW ? 0 : c >= VIS_HIGH ? 1 : ((c - VIS_LOW) / (VIS_HIGH - VIS_LOW)) ** 2 * (3 - 2 * (c - VIS_LOW) / (VIS_HIGH - VIS_LOW));
      g.vis[i] = Number.isFinite(g.vis[i]) ? g.vis[i] + k * (v - g.vis[i]) : v;
    }
  }

  /** Split cells and crest strokes at output resolution (after the terrain,
   *  before water). Draws only this frame's frozen snapshot. */
  drawCrest(ctx, fit, frameId) {
    const snap = this.snapshot;
    if (!snap || snap.frameId !== frameId || !(snap.fade > 0) || !(fit?.scale > 0)) return true;
    const t0 = performance.now();
    const s = fit.scale, X = x => fit.x + x * s, Y = y => fit.y + y * s;
    const outH = fit.height;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      if (snap.splitReady && this._split) this._drawSplit(ctx, fit, X, Y);
      ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      for (const band of CREST_BANDS) {
        const g = this._grid[band];
        if (!g.chunks.length) continue;
        ctx.save();
        // Clip to the region above every nearer band's line.
        if (band !== 'near') {
          ctx.beginPath();
          ctx.moveTo(X(0), fit.y - 4);
          for (let i = 0; i < snap.grid.width; i++) {
            const m = g.minNearer[i], y = Number.isFinite(m) ? Y(m) : fit.y + fit.height + 4;
            ctx.lineTo(X(i), y); ctx.lineTo(X(i + 1), y);
          }
          ctx.lineTo(X(snap.grid.width), fit.y - 4); ctx.closePath(); ctx.clip();
        }
        for (const chunk of g.chunks) {
          const { width, alpha } = crestStroke(chunk.tier, chunk.e, outH);
          let vis = 0, nv = 0;
          for (let i = chunk.start; i <= chunk.end; i++) if (Number.isFinite(g.vis[i])) { vis += g.vis[i]; nv++; }
          // Without a grid reading (grid-scan fallback, first frame) only the
          // skyline is assumed visible.
          const seen = nv ? vis / nv : chunk.tier === 'skyline' ? 1 : VIS_UNKNOWN;
          if (!(seen > 0.01)) continue;
          const shift = (CREST_LAND_SIDE - 0.5) * width;
          ctx.globalAlpha = alpha * seen * snap.fade;
          ctx.strokeStyle = chunk.color; ctx.lineWidth = width;
          ctx.beginPath();
          for (let i = chunk.start; i <= chunk.end; i++) {
            const prev = Number.isFinite(g.line[i - 1]) ? g.line[i - 1] : g.line[i];
            const next = Number.isFinite(g.line[i + 1]) ? g.line[i + 1] : g.line[i];
            const dx = 2 * s, dy = (next - prev) * s, len = Math.hypot(dx, dy) || 1;
            const px = X(i + 0.5) - (dy / len) * shift, py = Y(g.line[i]) + (dx / len) * shift;
            if (i === chunk.start) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    } finally { ctx.restore(); }
    this.diagnostics.drawMs = performance.now() - t0;
    return true;
  }

  _drawSplit(ctx, fit, X, Y) {
    const W = this._split.canvas.width;
    ctx.save();
    ctx.beginPath();
    let any = false;
    for (const band of CREST_BANDS) {
      const g = this._grid[band];
      let i = 0;
      while (i < W) {
        if (g.crossed[i] < 0) { i++; continue; }
        let j = i;
        while (j + 1 < W && g.crossed[j + 1] >= 0) j++;
        // Top: the line across the run; bottom: the crossed cells' lower edges.
        const mid = (x, y) => (Number.isFinite(g.line[x]) ? (g.line[x] + y) / 2 : y);
        ctx.moveTo(X(i), Y(mid(i - 1, g.line[i])));
        for (let x = i; x <= j; x++) ctx.lineTo(X(x + 0.5), Y(g.line[x]));
        ctx.lineTo(X(j + 1), Y(mid(j + 1, g.line[j])));
        for (let x = j; x >= i; x--) { ctx.lineTo(X(x + 1), Y(g.crossed[x] + 1)); ctx.lineTo(X(x), Y(g.crossed[x] + 1)); }
        ctx.closePath();
        any = true;
        i = j + 1;
      }
    }
    if (any) {
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1;
      ctx.drawImage(this._split.canvas, fit.x, fit.y, fit.width, fit.height);
    }
    ctx.restore();
  }

  /** Shorelines at output resolution, after the water layer. */
  drawShore(ctx, fit, frameId) {
    const snap = this.snapshot;
    if (!snap || snap.frameId !== frameId || !(snap.fade > 0) || !snap.shores.length || !(fit?.scale > 0)) return true;
    const s = fit.scale;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const chain of snap.shores) {
        const { width, alpha } = shoreStroke(chain.nearness, fit.height);
        // 70% of the stroke on the water side: below a far shore, above a near one.
        const shift = (CREST_LAND_SIDE - 0.5) * width * (chain.kind === 1 ? 1 : -1);
        ctx.globalAlpha = alpha * snap.fade;
        ctx.strokeStyle = chain.color; ctx.lineWidth = width;
        ctx.beginPath();
        const p = chain.points, n = p.length / 2;
        for (let i = 0; i < n; i++) {
          const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
          const dx = (p[b * 2] - p[a * 2]) * s, dy = (p[b * 2 + 1] - p[a * 2 + 1]) * s, len = Math.hypot(dx, dy) || 1;
          const x = fit.x + p[i * 2] * s - (dy / len) * shift, y = fit.y + p[i * 2 + 1] * s + (dx / len) * shift;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    } finally { ctx.restore(); }
    return true;
  }

  release() { this._releaseSplit(); this.snapshot = null; this._orig = null; }
}
