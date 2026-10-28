// Landscape crest line and shorelines (docs/pixel-presentation.md, "Crest
// line"). One instance per RangePresentation. Each frame:
//
//  1. update(): decode the GPU column probe (CrestProbe.js), rebuild a
//     sub-cell crest per band, steady it in time, map it into the pixel
//     grid and freeze everything the frame draws into `snapshot`.
//  2. prepareGrid(): before palette quantization, re-own the grid cells
//     around each smoothed line (split-cell rule, CrestLine.js), and
//     read the line's land colour and the edge's visibility from the grid.
//     On the grid-scan rungs it instead takes the skyline from the palette
//     pass's frame (no probe, no extra readback).
//  3. finishGrid(): after palette quantization, quantize the split cells'
//     lower halves with the grid's own quantizer.
//  4. drawCrest() / drawShore(): at output resolution, inside the presenter's
//     composite, live and again for a recording, from the same snapshot.
//
// Nothing here advances on a redraw: a recording reproduces the frame.
import {
  CREST_BANDS, CREST_FILTER, SHORE_FILTER, CREST_LAND_SIDE, crestE, crestStroke, shoreStroke, filterCrest, filterSample, filterAux,
  resetFilter, medianShift, reconstructCrest, crestLineColor, shoreColor, snapCrestColor, reownCrestCells, linkShoreChains,
  REOWN_MAX_ROWS, SHORE_SHAPE, shoreShape, solidShoreEdges, smoothShoreChain, gaussianSmooth, limitCurvature,
} from '../../render/CrestLine.js';
import { PROBE_BAND_ROWS, PROBE_WATER_ROW, PROBE_WATER_SLOTS, probeRow } from './CrestProbe.js';

export const CREST_SPLIT_KEY = 'range:crest-split';
/** Quality rung from which the GPU probe stops. With a palette the crest
 *  falls back to a scan of the palette pass's own frame (skyline only:
 *  integer rows, no elevation, no split cells, no shorelines); without one
 *  (Pixel look, which has no such frame) the line fades out. */
export const CREST_GRID_SCAN_LEVEL = 4;
/** Quality rung from which the Pixel look (no palette readback to share)
 *  stops reading grid rows back: split cells fade out, the line stays. */
export const CREST_PIXEL_SPLIT_LEVEL = 2;
export const CREST_FADE_SEC = 0.5;
const CHUNK = 8; // columns per stroke (one colour, width and opacity each)
const SLOW_TAU_SEC = 1.0; // elevation / band-foot smoothing
const SEEK_JUMP_MS = 250;
const CUT_PX = 6; // a raw move this large in most columns is a cut, not a kick
const SHORE_MATCH_PX = 4;
// Edge visibility (colour contrast across the line, 0..1 per channel mean).
const VIS_LOW = 0.02, VIS_HIGH = 0.09, VIS_TAU_SEC = 0.3, VIS_UNKNOWN = 0.35;
const FALLBACK_LAND = Object.freeze([60, 60, 60]);
// Without split cells (Pixel look, CREST_PIXEL_SPLIT_LEVEL and above) the
// grid rows are still read, without a write-back, this often (and at once
// after a reset), so the line keeps the land colour the viewer sees.
const SAMPLE_EVERY_SEC = 0.5;

const hexRgb = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return null;
  return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
};
const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const filterState = (n) => ({ y: new Float32Array(n).fill(NaN), d: new Float32Array(n), aux: filterAux(n) });

function bandState(n) {
  return { raw: new Float32Array(n), recon: new Float32Array(n), filter: filterState(n), scratch: new Float32Array(n),
    elev: new Float32Array(n).fill(NaN), color: new Uint8Array(n * 3), foot: NaN, top: NaN };
}
function gridBand(n) {
  return { line: new Float32Array(n), raw: new Float32Array(n), e: new Float32Array(n), skyline: new Uint8Array(n),
    minNearer: new Float32Array(n), skip: new Uint8Array(n), crossed: new Int16Array(n), crossedEnd: new Int16Array(n), colorAt: new Int32Array(n), chunks: [],
    vis: new Float32Array(n).fill(NaN), land: new Uint8Array(n * 3), landOk: new Uint8Array(n),
    scan: filterState(n), scanRaw: new Float32Array(n), foot: NaN, top: NaN };
}

export class RangeCrest {
  constructor({ makeCanvas = null, residency = null } = {}) {
    this.makeCanvas = makeCanvas;
    this.residency = residency;
    this.mode = 'refined';
    this.fade = 0;
    this.splitFade = 0;
    this.snapshot = null;
    this._targetWidth = 0;
    this._gridKey = '';
    this._bands = null; // target-space state per band
    this._grid = null; // grid-space arrays per band
    this._shore = null;
    this._last = null; // { frameId, timeMs, viewId }
    this._split = null; // { canvas, image, dirty: [y0, y1] }
    this._splitUpload = null;
    this._orig = null;
    this._sky = null;
    this._palette = null;
    this._sampleAge = Infinity; // seconds since the last grid reading
    this.diagnostics = { mode: this.mode, fade: 0, splitFade: 0, splitStrength: 0, resets: 0, lastReset: null, probeMs: 0, probeRead: 'none', probeLag: 0, updateMs: 0, prepareMs: 0,
      drawMs: 0, shoreMs: 0, splitCells: 0, columns: 0, shoreChains: 0, shoreDropped: 0, readback: 'none', readRows: 0, readbackMs: 0 };
  }

  /** Drop the temporal state: the next frame starts from its raw crest. */
  reset(reason = 'reset') {
    if (this._bands) for (const b of Object.values(this._bands)) { resetFilter(b.filter); b.elev.fill(NaN); b.foot = b.top = NaN; }
    if (this._shore) { this._shore.y.fill(NaN); this._shore.kind.fill(0); }
    if (this._grid) for (const g of Object.values(this._grid)) { g.vis.fill(NaN); g.landOk.fill(0); resetFilter(g.scan); g.foot = g.top = NaN; }
    this._sampleAge = Infinity;
    this.diagnostics.resets++;
    this.diagnostics.lastReset = reason;
  }

  /** The probe mode the next frame should render (null: no probe). */
  get probeMode() { return this.mode === 'refined' ? 'refined' : null; }

  _ensure(targetWidth, grid) {
    if (targetWidth && this._targetWidth !== targetWidth) {
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
   * is drawn at. `palette` is null, 'rgb332' or a compiled palette. `scan`
   * marks a steady grid-scan frame (no probe on the heavy rungs): the crest
   * then comes from the palette frame in prepareGrid().
   */
  update({ probe, frameId, timeMs = 0, viewId = null, qualityLevel = 0, transform, stage, grid, sky = null, palette = null, scan = false } = {}) {
    const t0 = performance.now();
    const last = this._last;
    const rawDt = last && Number.isFinite(timeMs) ? (timeMs - last.timeMs) / 1000 : 0;
    const dt = rawDt > 0 && rawDt < SEEK_JUMP_MS / 1000 ? rawDt : 1 / 60;
    // Quality changes fade the line (and split cells) out, switch, then fade back in.
    const desired = qualityLevel >= CREST_GRID_SCAN_LEVEL ? 'grid' : 'refined';
    const switching = desired !== this.mode;
    if (switching) {
      this.fade = Math.max(0, this.fade - dt / CREST_FADE_SEC);
      this.splitFade = Math.min(this.splitFade, this.fade);
      if (this.fade === 0) { this.mode = desired; this.reset('quality'); }
    }
    this.diagnostics.mode = this.mode;
    if (this.mode !== 'refined') probe = null; // the probe does not run on the grid-scan rungs
    const scanning = !probe && !!scan && this.mode === 'grid' && !!palette;
    // A frame without a probe or scan (travel, arrival) breaks the filter's chain.
    this._last = { frameId: probe || scanning ? frameId : NaN, timeMs, viewId };
    if (!(probe || scanning) || !grid?.width || probe && (!transform || !stage?.width)) {
      this.snapshot = null;
      this.diagnostics.fade = this.fade;
      this.diagnostics.readback = 'none';
      return null;
    }
    this._ensure(probe ? probe.width : 0, grid);
    if (!last || last.viewId !== viewId) { this.reset('view'); this.fade = this.splitFade = 0; }
    else if (last.frameId !== frameId - 1) this.reset('gap');
    else if (rawDt < -0.001 || rawDt > SEEK_JUMP_MS / 1000) this.reset('seek');
    if (!switching) this.fade = Math.min(1, this.fade + dt / CREST_FADE_SEC);
    // Split cells: refined only. The Pixel look reads grid rows back for
    // them, so it sheds them from CREST_PIXEL_SPLIT_LEVEL (with the fade).
    const splitWanted = !switching && !!probe && (!!palette || qualityLevel < CREST_PIXEL_SPLIT_LEVEL);
    this.splitFade = splitWanted ? Math.min(1, this.fade, this.splitFade + dt / CREST_FADE_SEC) : Math.max(0, this.splitFade - dt / CREST_FADE_SEC);
    this._sky = hexRgb(sky);
    this._palette = palette;
    let rotated = false, columns = 0, shores = [];
    if (probe) ({ rotated, columns, shores } = this._fromProbe(probe, dt, transform, stage, grid));
    else for (const band of CREST_BANDS) {
      const g = this._grid[band];
      g.line.fill(NaN); g.raw.fill(NaN); g.skip.fill(1); g.crossed.fill(-1); g.crossedEnd.fill(-1); g.colorAt.fill(-1); g.chunks = [];
    }
    const split = !!probe && !rotated && !!this.makeCanvas && this.splitFade > 0;
    this.snapshot = Object.freeze({ frameId, dt, grid: { width: grid.width, height: grid.height }, mode: this.mode, fade: this.fade,
      splitFade: this.splitFade, split, scan: scanning, prepared: false, splitPending: false, splitReady: false, splitAlpha: 0, palette, shores });
    this.diagnostics.fade = this.fade;
    this.diagnostics.splitFade = this.splitFade;
    this.diagnostics.columns = columns;
    this.diagnostics.probeMs = probe ? probe.readMs || 0 : 0;
    this.diagnostics.probeRead = probe ? probe.mode || 'sync' : 'none';
    this.diagnostics.probeLag = probe ? probe.lag || 0 : 0;
    this.diagnostics.readback = probe ? 'probe' : 'none';
    this.diagnostics.readRows = 0;
    this.diagnostics.readbackMs = 0;
    this.diagnostics.shoreChains = shores.length;
    this.diagnostics.updateMs = performance.now() - t0;
    return this.snapshot;
  }

  _fromProbe(probe, dt, transform, stage, grid) {
    const W = probe.width, data = probe.data, Wg = grid.width;
    const [a, b, c, d, e, f] = transform;
    // Target pixels -> stage units (the partition is drawn stretched over the stage).
    // (The probe's own target size: the scene canvas may since have been
    // resized for the water pass.)
    const sx = stage.width / W, sy = stage.height / (probe.height || stage.targetHeight || stage.height);
    const rotated = Math.abs(b) + Math.abs(c) > 1e-3 * Math.abs(a);
    const k = 1 - Math.exp(-dt / SLOW_TAU_SEC);
    let columns = 0, cut = false;
    const shift = {};
    for (const band of CREST_BANDS) {
      const s = this._bands[band], g = this._grid[band], row = PROBE_BAND_ROWS[band];
      const valid = probe.rows & (1 << row);
      for (let j = 0; j < W; j++) {
        // Inline probeRow(): row, depth flag and elevation of this column.
        const o = (row * W + j) * 4, present = valid && data[o + 3] > 0;
        const r = present ? data[o] + (data[o + 1] & 31) * 256 - 1 : -1;
        // A crest on the target's top row is cut off by the frame: not a crest.
        s.raw[j] = r > 0 ? r : NaN;
        if (r > 0 && data[o + 3] > 200) { const v = data[o + 2] / 255; s.elev[j] = Number.isFinite(s.elev[j]) ? s.elev[j] + k * (v - s.elev[j]) : v; }
        else if (r <= 0) s.elev[j] = NaN;
        const ci = ((row + 1) * W + j) * 4;
        s.color[j * 3] = data[ci]; s.color[j * 3 + 1] = data[ci + 1]; s.color[j * 3 + 2] = data[ci + 2];
      }
      reconstructCrest(s.raw, s.recon);
      const input = s.recon, prevRaw = s.filter.aux.raw;
      // The band's common shift since the last frame (camera motion and
      // heave), and whether most of it jumped at once (a cut).
      shift[band] = medianShift(input, prevRaw, s.scratch);
      let present = 0, jumped = 0;
      for (let j = 0; j < W; j++) {
        if (!Number.isFinite(input[j])) continue;
        present++;
        if (Math.abs(input[j] - prevRaw[j]) > CUT_PX) jumped++;
      }
      filterCrest(s.filter, input, dt, CREST_FILTER);
      // A cut moves most columns at once: the slow terms restart with it.
      if (present && jumped > present / 2) { s.foot = s.top = NaN; s.elev.fill(NaN); cut = true; }
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
      this._rank(g, s, Wg, k, (i) => s.elev[g.colorAt[i]]);
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
        g.crossed[i] = -1; g.crossedEnd[i] = -1;
      }
    }
    for (const band of CREST_BANDS) this._grid[band].chunks = this._chunks(band, this._bands[band], this._grid[band], Wg);
    // Shorelines move with the nearest band that has a crest (camera, heave).
    const carry = [shift.near, shift.mid, shift.far].find(Number.isFinite);
    const shores = this._updateShores(probe, dt, { a, b, c, d, e, f, sx, sy }, cut ? NaN : carry ?? NaN, cut);
    return { rotated, columns, shores };
  }

  /** e per grid column from elevation (`elev(i)`) and height above the
   *  band's slowly followed foot. `s` holds the slow foot/top (band state or
   *  the grid band itself). */
  _rank(g, s, Wg, k, elev) {
    let foot = -Infinity, top = Infinity;
    for (let i = 0; i < Wg; i++) { const L = g.line[i]; if (Number.isFinite(L)) { if (L > foot) foot = L; if (L < top) top = L; } }
    if (Number.isFinite(foot)) {
      s.foot = Number.isFinite(s.foot) ? s.foot + k * (foot - s.foot) : foot;
      s.top = Number.isFinite(s.top) ? s.top + k * (top - s.top) : top;
    }
    const span = Math.max(2, s.foot - s.top);
    for (let i = 0; i < Wg; i++) {
      const L = g.line[i];
      g.e[i] = Number.isFinite(L) ? crestE(elev ? elev(i) : NaN, (s.foot - L) / span) : 0;
    }
  }

  _chunks(band, s, g, Wg) {
    const out = [];
    let i = 0;
    while (i < Wg) {
      if (!Number.isFinite(g.line[i])) { i++; continue; }
      let j = i;
      while (j + 1 < Wg && Number.isFinite(g.line[j + 1]) && j + 1 - i < CHUNK) j++;
      let e = 0, sky1 = 0;
      for (let x = i; x <= j; x++) { e += g.e[x]; sky1 += g.skyline[x]; }
      const count = j - i + 1;
      const tier = sky1 * 2 > count ? 'skyline' : band;
      // A chunk continues into the next column so strokes join.
      const end = j + 1 < Wg && Number.isFinite(g.line[j + 1]) ? j + 1 : j;
      out.push({ start: i, end, last: j, tier, e: e / count, color: this._chunkColor(band, s, g, i, j) });
      i = j + 1;
    }
    return out;
  }

  /** The stroke colour of columns i..j: the land the viewer sees just below
   *  the line in the grid (sampled by prepareGrid, after haze and grading),
   *  else the probe's band colour, darkened, receded and snapped. */
  _chunkColor(band, s, g, i, j) {
    const rgb = [0, 0, 0];
    let n = 0;
    for (let x = i; x <= j; x++) if (g.landOk[x]) { rgb[0] += g.land[x * 3]; rgb[1] += g.land[x * 3 + 1]; rgb[2] += g.land[x * 3 + 2]; n++; }
    if (!n && s) for (let x = i; x <= j; x++) {
      const t = g.colorAt[x];
      if (t >= 0) { rgb[0] += s.color[t * 3]; rgb[1] += s.color[t * 3 + 1]; rgb[2] += s.color[t * 3 + 2]; n++; }
    }
    const land = n ? rgb.map(v => v / n) : FALLBACK_LAND;
    return css(snapCrestColor(crestLineColor(land, this._sky, band), this._palette));
  }

  _recolor() {
    for (const band of CREST_BANDS) {
      const g = this._grid[band], s = this._bands?.[band] || null;
      for (const chunk of g.chunks) chunk.color = this._chunkColor(band, s, g, chunk.start, chunk.last);
    }
  }

  _updateShores(probe, dt, m, carry, cut) {
    const t0 = performance.now();
    const W = probe.width, data = probe.data, st = this._shore, palette = this._palette;
    const valid = probe.rows & (1 << PROBE_WATER_ROW);
    st.nextY.fill(NaN); st.nextKind.fill(0);
    // Camera motion carries the held shore with the land; a cut drops it.
    if (cut) { st.y.fill(NaN); st.kind.fill(0); }
    else if (Number.isFinite(carry) && carry) for (let q = 0; q < st.y.length; q++) if (Number.isFinite(st.y[q])) st.y[q] += carry;
    // 1. This frame's raw shore edges per column.
    // Only edges that bound a real land/water region on both sides (not a
    // sliver: a wave crest over a sandbar, a trough) and that are not the
    // frame's own edge (solidShoreEdges).
    const cols = new Array(W), edges = [], H = probe.height || Infinity;
    for (let j = 0; j < W; j++) {
      const list = [];
      edges.length = 0;
      for (let s = 0; valid && s < PROBE_WATER_SLOTS; s++) {
        const info = probeRow(data, ((PROBE_WATER_ROW + s) * W + j) * 4);
        if (info.row < 0) break;
        edges.push(info);
      }
      for (const s of solidShoreEdges(edges, H)) {
        const info = edges[s], ci = ((PROBE_WATER_ROW + PROBE_WATER_SLOTS + s) * W + j) * 4;
        list.push({ y: info.row, kind: info.kind, nearness: info.value, maxStep: shoreShape(info.value).maxStep,
          rgb: [data[ci], data[ci + 1], data[ci + 2]] });
      }
      cols[j] = list;
    }
    // 2. Chains across columns (near edges link over larger steps), shaped
    // along their length with smoothing that grows with nearness; chains too
    // short or too jagged to be one coherent shore are dropped (SHORE_SHAPE).
    // 3. Each point then follows the same edge from the last frame (same
    // column and kind, nearest row) through the shore filter: a wide
    // deadband and a low cutoff, so music water waves never ripple it.
    const step = dt > 0 ? Math.min(dt, 1 / 15) : 1 / 60;
    const chains = [];
    let dropped = 0;
    for (const chain of linkShoreChains(cols, 2, SHORE_SHAPE.maxGap)) {
      const n = chain.length, rows = new Float32Array(n);
      let nearness = 0;
      chain.forEach(([j, s], p) => { rows[p] = cols[j][s].y; nearness += cols[j][s].nearness; });
      const shape = shoreShape(nearness / n);
      if (n < shape.minColumns) { dropped++; continue; }
      const { ys, residual } = smoothShoreChain(rows, shape.sigma);
      if (residual > SHORE_SHAPE.maxResidual) { dropped++; continue; }
      const pts = new Float32Array(n * 2), held = new Float32Array(n);
      let near = 0;
      const rgb = [0, 0, 0];
      const kind = cols[chain[0][0]][chain[0][1]].kind;
      chain.forEach(([j, s], p) => {
        const t = cols[j][s];
        let best = -1, bestD = SHORE_MATCH_PX;
        for (let q = j * PROBE_WATER_SLOTS; q < (j + 1) * PROBE_WATER_SLOTS; q++) {
          if (st.kind[q] !== kind || !Number.isFinite(st.y[q])) continue;
          const dd = Math.abs(st.y[q] - ys[p]);
          if (dd < bestD) { bestD = dd; best = q; }
        }
        let slot = j * PROBE_WATER_SLOTS;
        while (slot < (j + 1) * PROBE_WATER_SLOTS - 1 && st.nextKind[slot]) slot++;
        st.nextY[slot] = best >= 0 ? st.y[best] : NaN; st.nextD[slot] = best >= 0 ? st.d[best] : 0;
        if (best >= 0) st.kind[best] = 0; // consumed
        filterSample(st.nextY, st.nextD, slot, ys[p], step, SHORE_FILTER);
        st.nextKind[slot] = kind;
        held[p] = st.nextY[slot];
        near += t.nearness; rgb[0] += t.rgb[0]; rgb[1] += t.rgb[1]; rgb[2] += t.rgb[2];
      });
      // Per-column deadbands hold neighbouring points up to half a row
      // apart: the drawn chain is shaped again (the held state is not).
      limitCurvature(gaussianSmooth(held, Math.max(1, shape.sigma / 2), held), SHORE_SHAPE.maxCurvature);
      chain.forEach(([j], p) => {
        const y = held[p], x = j + 0.5;
        pts[p * 2] = m.a * m.sx * x + m.c * m.sy * y + m.e;
        pts[p * 2 + 1] = m.b * m.sx * x + m.d * m.sy * y + m.f;
      });
      chains.push(Object.freeze({ points: pts, kind, nearness: near / n,
        color: css(snapCrestColor(shoreColor(rgb.map(v => v / n)), palette)) }));
    }
    st.y.set(st.nextY); st.d.set(st.nextD); st.kind.set(st.nextKind);
    this.diagnostics.shoreMs = performance.now() - t0;
    this.diagnostics.shoreDropped = dropped;
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
   * Before palette quantization: re-own the grid cells around each
   * smoothed line, fading the edit in and out with the line, and read the
   * line's land colour and visibility. `frame` is the whole grid's
   * ImageData when the palette pass has already read it back (free: done
   * every frame, split cells or not); otherwise, and only while split cells
   * are on, each band's own rows (±3 cells around its lines) are read from
   * `ctx` and written back.
   */
  prepareGrid({ ctx = null, frame = null } = {}) {
    const snap = this.snapshot;
    if (!snap || snap.prepared || !(snap.fade > 0)) return false;
    const t0 = performance.now();
    if (snap.scan) return frame ? this._scanGrid(frame, t0) : false;
    const strength = snap.split ? Math.min(snap.fade, snap.splitFade) : 0;
    this._sampleAge += snap.dt || 1 / 60;
    // No split cells and no palette frame: only a throttled sample-only read.
    const sampleOnly = !(strength > 0) && !frame;
    if (sampleOnly && (!ctx || this._sampleAge < SAMPLE_EVERY_SEC)) return false;
    const { width: W, height: H } = snap.grid;
    // Each band's rows (its lines and any raw crest above them, e.g. a
    // spire the line has smoothed away), merged where they meet.
    const spans = [];
    for (const band of CREST_BANDS) {
      const g = this._grid[band];
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < W; i++) {
        const L = g.line[i];
        if (!Number.isFinite(L)) continue;
        const R = g.raw[i], top = Number.isFinite(R) && R < L ? Math.max(R, L - REOWN_MAX_ROWS) : L;
        if (top < lo) lo = top; if (L > hi) hi = L;
      }
      if (Number.isFinite(lo)) spans.push({ y0: Math.max(0, Math.floor(lo) - 3), y1: Math.min(H, Math.floor(hi) + 4), bands: [band] });
    }
    spans.sort((p, q) => p.y0 - q.y0);
    const groups = [];
    for (const sp of spans) {
      if (sp.y1 <= sp.y0) continue;
      const prev = groups.at(-1);
      if (prev && sp.y0 <= prev.y1) { prev.y1 = Math.max(prev.y1, sp.y1); prev.bands.push(...sp.bands); }
      else groups.push(sp);
    }
    if (!groups.length) return false;
    const split = strength > 0 ? this._ensureSplit(W, H) : null;
    if (!split && !frame && !sampleOnly) return false;
    if (!this._orig || this._orig.length < W * H * 4) this._orig = new Uint8ClampedArray(W * H * 4);
    const sdata = split?.image.data;
    if (split?.dirty) sdata.fill(0, split.dirty[0] * W * 4, split.dirty[1] * W * 4);
    const kv = 1 - Math.exp(-Math.min(this._sampleAge, 1) / VIS_TAU_SEC);
    this._sampleAge = 0;
    let cells = 0, readRows = 0, readMs = 0;
    for (const { y0, y1, bands } of groups) {
      let image;
      try {
        if (frame) image = { data: frame.data.subarray(y0 * W * 4, y1 * W * 4), width: W, y0, rows: y1 - y0 };
        else {
          const r0 = performance.now();
          const read = ctx.getImageData(0, y0, W, y1 - y0);
          readMs += performance.now() - r0; readRows += y1 - y0;
          image = { data: read.data, width: W, y0, rows: y1 - y0, read };
        }
      } catch { return false; }
      const orig = this._orig.subarray(y0 * W * 4, y1 * W * 4);
      orig.set(image.data);
      for (const band of bands) {
        const g = this._grid[band];
        this._visibility(g, orig, W, y0, y1, kv);
        this._sampleLand(g, orig, W, y0, y1);
        if (split) cells += reownCrestCells(image, orig, sdata.subarray(y0 * W * 4, y1 * W * 4), g.line, g.raw, g.skip, g.crossed, g.crossedEnd);
      }
      if (split && strength < 1) {
        // Fading: the re-owned cells blend back toward the raw grid.
        const out = image.data;
        for (let k = 0; k < out.length; k++) if (out[k] !== orig[k]) out[k] = orig[k] + (out[k] - orig[k]) * strength;
      }
      if (split && image.read) {
        try { ctx.putImageData(image.read, 0, y0); } catch { return false; }
      }
    }
    this._recolor();
    let ready = false;
    if (split) {
      const n0 = groups[0].y0, n1 = groups.at(-1).y1;
      this._splitUpload = split.dirty ? [Math.min(split.dirty[0], n0), Math.max(split.dirty[1], n1)] : [n0, n1];
      split.dirty = [n0, n1];
      // With a palette the lower halves are quantized first (finishGrid).
      if (!frame) ready = this._uploadSplit();
    }
    this.snapshot = Object.freeze({ ...snap, prepared: true, splitPending: !!split && !!frame, splitReady: ready, splitAlpha: split ? strength : 0 });
    this.diagnostics.splitCells = cells;
    this.diagnostics.splitStrength = split ? strength : 0;
    this.diagnostics.readback = frame ? 'probe+palette-frame' : sampleOnly ? 'probe+crest-sample' : 'probe+crest-rows';
    this.diagnostics.readRows = readRows;
    this.diagnostics.readbackMs = readMs;
    this.diagnostics.prepareMs = performance.now() - t0;
    return true;
  }

  /** After palette quantization: the split cells' lower halves go through
   *  the grid's own quantizer (`quantize(rgb, x, y)`, PaletteQuantize.js) at
   *  their cell, so they match the terrain cells beside them. */
  finishGrid({ quantize = null } = {}) {
    const snap = this.snapshot;
    if (!snap?.splitPending || !this._split || typeof quantize !== 'function') return false;
    const W = snap.grid.width, sdata = this._split.image.data;
    for (const band of CREST_BANDS) {
      const g = this._grid[band];
      for (let i = 0; i < W; i++) {
        if (g.crossed[i] < 0) continue;
        for (let r = g.crossed[i]; r <= g.crossedEnd[i]; r++) {
          const q = (r * W + i) * 4;
          if (!sdata[q + 3]) continue;
          const c = quantize([sdata[q], sdata[q + 1], sdata[q + 2]], i, r);
          sdata[q] = c[0]; sdata[q + 1] = c[1]; sdata[q + 2] = c[2];
        }
      }
    }
    const ready = this._uploadSplit();
    this.snapshot = Object.freeze({ ...snap, splitPending: false, splitReady: ready });
    return ready;
  }

  _uploadSplit() {
    const split = this._split, range = this._splitUpload;
    if (!split || !range) return false;
    try { split.canvas.getContext('2d').putImageData(split.image, 0, 0, 0, range[0], split.canvas.width, range[1] - range[0]); }
    catch { return false; }
    return true;
  }

  /** Grid-scan fallback (heavy rungs, palette looks only): the skyline is
   *  the first opaque row per column of the palette pass's frame (the sky
   *  is a separate layer there); integer rows through the same filter. */
  _scanGrid(frame, t0) {
    const snap = this.snapshot, { width: W, height: H } = snap.grid, data = frame.data;
    if (frame.width && frame.width !== W || data.length < W * H * 4) return false;
    const g = this._grid.far;
    for (let i = 0; i < W; i++) {
      let r = -1;
      for (let y = 0; y < H; y++) if (data[(y * W + i) * 4 + 3] >= 128) { r = y; break; }
      g.scanRaw[i] = r > 0 ? r : NaN; // row 0: the sky is in the grid, or the frame cuts the crest
    }
    filterCrest(g.scan, g.scanRaw, snap.dt, CREST_FILTER);
    g.line.set(g.scan.y); g.raw.set(g.scanRaw);
    g.skyline.fill(1); g.minNearer.fill(Infinity); g.skip.fill(1); g.crossed.fill(-1); g.crossedEnd.fill(-1); g.colorAt.fill(-1);
    this._rank(g, g, W, 1 - Math.exp(-(snap.dt || 1 / 60) / SLOW_TAU_SEC), null);
    this._visibility(g, data, W, 0, H, 1 - Math.exp(-(snap.dt || 1 / 60) / VIS_TAU_SEC));
    this._sampleLand(g, data, W, 0, H);
    g.chunks = this._chunks('far', null, g, W);
    this.snapshot = Object.freeze({ ...snap, prepared: true });
    this.diagnostics.readback = 'palette-frame';
    this.diagnostics.readRows = 0;
    this.diagnostics.readbackMs = 0;
    this.diagnostics.prepareMs = performance.now() - t0;
    return true;
  }

  /** The land the viewer sees 1-2 cells below each column's line (opaque
   *  cells of this band, above any nearer band's line), from the grid. */
  _sampleLand(g, orig, W, y0, y1) {
    for (let i = 0; i < W; i++) {
      const L = g.line[i];
      g.landOk[i] = 0;
      if (!Number.isFinite(L)) continue;
      const R = g.raw[i];
      let r0 = 0, g0 = 0, b0 = 0, n = 0;
      for (let r = Math.floor(L) + 1; r <= Math.floor(L) + 2; r++) {
        if (r < y0 || r >= y1 || Number.isFinite(R) && r < R || r >= g.minNearer[i]) continue;
        const k = ((r - y0) * W + i) * 4;
        if (orig[k + 3] < 250) continue;
        r0 += orig[k]; g0 += orig[k + 1]; b0 += orig[k + 2]; n++;
      }
      if (!n) continue;
      g.land[i * 3] = r0 / n; g.land[i * 3 + 1] = g0 / n; g.land[i * 3 + 2] = b0 / n; g.landOk[i] = 1;
    }
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
      if (snap.splitReady && this._split && snap.splitAlpha > 0) this._drawSplit(ctx, fit, X, Y, snap.splitAlpha);
      // One continuous polyline per run of columns, cut into chunks (each
      // its own colour, width and opacity) by abutting column clips: each
      // chunk strokes the run's path two vertices past its ends and is
      // clipped to its own cells, so neighbours meet at a shared pixel
      // column with no butt-cap wedge at a bend and no doubled overlap.
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
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
          ctx.save();
          const x0 = chunk.start > 0 && Number.isFinite(g.line[chunk.start - 1]) ? Math.round(X(chunk.start)) : fit.x;
          const x1 = chunk.last + 1 < snap.grid.width && Number.isFinite(g.line[chunk.last + 1]) ? Math.round(X(chunk.last + 1)) : fit.x + fit.width;
          ctx.beginPath(); ctx.rect(x0, fit.y, x1 - x0, fit.height); ctx.clip();
          ctx.globalAlpha = alpha * seen * snap.fade;
          ctx.strokeStyle = chunk.color; ctx.lineWidth = width;
          ctx.beginPath();
          let a = chunk.start, b = chunk.last;
          while (a > chunk.start - 2 && Number.isFinite(g.line[a - 1])) a--;
          while (b < chunk.last + 2 && Number.isFinite(g.line[b + 1])) b++;
          for (let i = a; i <= b; i++) {
            const prev = Number.isFinite(g.line[i - 1]) ? g.line[i - 1] : g.line[i];
            const next = Number.isFinite(g.line[i + 1]) ? g.line[i + 1] : g.line[i];
            const dx = 2 * s, dy = (next - prev) * s, len = Math.hypot(dx, dy) || 1;
            const px = X(i + 0.5) - (dy / len) * shift, py = Y(g.line[i]) + (dx / len) * shift;
            if (i === a) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }
    } finally { ctx.restore(); }
    this.diagnostics.drawMs = performance.now() - t0;
    return true;
  }

  _drawSplit(ctx, fit, X, Y, alpha) {
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
        // Top: the line across the run (the same polyline as the stroke);
        // bottom: the lowest crossed cell's lower edge per column.
        const mid = (x, y) => (Number.isFinite(g.line[x]) ? (g.line[x] + y) / 2 : y);
        ctx.moveTo(X(i), Y(mid(i - 1, g.line[i])));
        for (let x = i; x <= j; x++) ctx.lineTo(X(x + 0.5), Y(g.line[x]));
        ctx.lineTo(X(j + 1), Y(mid(j + 1, g.line[j])));
        for (let x = j; x >= i; x--) { ctx.lineTo(X(x + 1), Y(g.crossedEnd[x] + 1)); ctx.lineTo(X(x), Y(g.crossedEnd[x] + 1)); }
        ctx.closePath();
        any = true;
        i = j + 1;
      }
    }
    if (any) {
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = alpha;
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
