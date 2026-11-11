// Landscape crest line and shorelines (docs/pixel-presentation.md, "Crest
// line"). One instance per RangePresentation. Each frame:
//
//  1. update(): decode the GPU column probe (CrestProbe.js), rebuild a
//     sub-cell crest per band, steady it in time, map it into the pixel
//     grid and freeze everything the frame draws into `snapshot`.
//  2. prepareGrid(): before the grid is composited, re-own the grid cells
//     around each smoothed line (split-cell rule, CrestLine.js), and
//     read the line's land colour and the edge's visibility from the grid.
//     A live probe a frame old is first aligned to the grid's own crest.
//  3. drawTerrain(): at output resolution, the presenter draws the terrain
//     clipped below the skyline, so land cells above the line (stair-step
//     teeth, the sky half of crossed cells) show the smooth sky drawn under
//     them. No readback: it works on every rung and look.
//  4. drawCrest() / drawShore(): at output resolution, inside the presenter's
//     composite, live and again for a recording, from the same snapshot.
//
// Nothing here advances on a redraw: a recording reproduces the frame.
import {
  CREST_BANDS, CREST_FILTER, SHORE_FILTER, CREST_LAND_SIDE, crestE, crestSpan, crestStroke, shoreStroke, filterCrest, filterSample, filterAux,
  resetFilter, medianShift, reconstructCrest, crestLineColor, shoreColor, snapCrestColor, reownCrestCells, linkShoreChains,
  REOWN_MAX_ROWS, SHORE_SHAPE, shoreShape, solidShoreEdges, smoothShoreChain, smoothHeldShore, SHORE_HELD_SIGMA,
} from '../../render/CrestLine.js';
import { PROBE_BAND_ROWS, PROBE_WATER_ROW, PROBE_WATER_SLOTS, PROBE_FINE_ROWS, PROBE_FINE_K, PROBE_EDGE_ROW, EDGE_NEIGHBOURS, probeRow, edgeCell, fineLineRow } from './CrestProbe.js';
import { CrestColorPattern } from '../../render/CrestPixelColors.js';
import { noteSyncWait } from '../../render/SyncWaits.js';

export const CREST_SPLIT_KEY = 'range:crest-split';
/** Quality rung from which the probe runs light ('grid' mode): crest rows
 *  and colours only (no depth, elevation or water passes, so no shorelines).
 *  The line holds across the switch. */
export const CREST_GRID_SCAN_LEVEL = 4;
/** Quality rung from which the grid rows are no longer read back: split
 *  cells fade out;
 *  the line and the output-resolution terrain cut (drawTerrain) stay. */
export const CREST_PIXEL_SPLIT_LEVEL = 2;
/** Split cells shed or regained across a quality change. */
export const CREST_FADE_SEC = 0.5;
/** The line (and split cells) fading in after a view change, live only:
 *  an isolated export frame (`instant`) starts at full strength. */
export const CREST_VIEW_FADE_SEC = 0.15;
/** A flattened, distant build footprint is not a geographic crest. Let
 * real relief and its authored composition arrive before outlining it. */
export function crestBuildOpacity(rise01 = 1) {
  const t = Math.max(0, Math.min(1, ((Number.isFinite(rise01) ? rise01 : 1) - .55) / .15));
  return t * t * (3 - 2 * t);
}
/** Grid rows an asynchronous (one frame old) probe may be off by that the
 *  grid itself corrects (prepareGrid) and the terrain cut covers above the
 *  raw crest (drawTerrain). */
const LAG_ROWS = 2;
const LAG_CUT_ROWS = 1;
const CHUNK = 8; // columns per stroke (one colour, width and opacity each)
const SLOW_TAU_SEC = 1.0; // elevation / band-foot smoothing
const SEEK_JUMP_MS = 250;
const CUT_PX = 6; // a raw move this large in most columns is a cut, not a kick
const SHORE_MATCH_PX = 4;
// Edge visibility (colour contrast across the line, 0..1 per channel mean).
const VIS_LOW = 0.02, VIS_HIGH = 0.09, VIS_TAU_SEC = 0.3, VIS_UNKNOWN = 0.35;
const FALLBACK_LAND = Object.freeze([60, 60, 60]);
// A grid cell this opaque is land; anything fainter on the sky side (a glow
// or haze layer drawn into the grid) is carried into the terrain cut.
const LAND_ALPHA = 250;
const GLOW_ROWS = 3; // rows above the raw crest checked for such content
// Without split cells (Pixel look, CREST_PIXEL_SPLIT_LEVEL and above) the
// grid rows are still read, without a write-back, this often (and at once
// after a reset), so the line keeps the land colour the viewer sees.
const SAMPLE_EVERY_SEC = 0.5;

/**
 * Replace a band's reconstructed crest (whole grid rows joined at their
 * step midpoints) by the probe's fine crest where it has one: the mean of
 * four native-cell sample positions' first owned rows, in target rows.
 * This is temporal/crown metadata; output paths retain every fine column.
 * The fine render is terrain only; where the grid's crest is a
 * pixel or more above it (tree crowns on the ridge) the grid crest stands,
 * so the cut never shaves a crown. Returns the columns replaced.
 */
export function fineCrest(probe, band, raw, recon) {
  const row = PROBE_FINE_ROWS[band], W = probe.width, data = probe.data, K = PROBE_FINE_K;
  if (!probe.fine && !(probe.rows & (1 << row))) return 0;
  let n = 0;
  for (let j = 0; j < W; j++) {
    if (!Number.isFinite(raw[j]) || !Number.isFinite(recon[j])) continue;
    let sum = 0, m = 0;
    for (let sub = 0; sub < K; sub++) {
      const o = ((row + (sub >> 1)) * W + j) * 4 + (sub & 1) * 2;
      // Same four source texels the legacy GPU pass sampled, now decoded
      // from the physical-width rows we already read for output geometry.
      const v = probe.fine ? fineLineRow(probe, band, Math.floor((j + (sub + .5) / K) * probe.fine.width / W))
        : data[o] + data[o + 1] * 256 - 1;
      if (v > 0) { sum += v; m++; }
    }
    if (m < K) continue;
    const y = sum / m * (probe.fine ? probe.height / probe.fine.height : 1 / K);
    if (Math.abs(y - recon[j]) > 1) continue;
    recon[j] = y; n++;
  }
  return n;
}

/**
 * The probe's edge cells (CrestProbe.js: terrain over terrain, then dry
 * pixels of wet cells) in grid cells: the target is drawn
 * onto the grid at one pixel per pixel, offset by (e, f) and sampled
 * nearest, so target pixel (i, r) is grid cell (i + ox, r + oy). `out`
 * ({ x, y, mask, n, color, count }) grows as needed. Returns the count; 0
 * when the probe has no edge cells or the target is scaled or turned
 * against the grid.
 */
export function decodeEdges(probe, map, out) {
  out.count = 0;
  if (!probe?.edges || !map) return 0;
  const { a, b, c, d, e, f, sx, sy, Wg, Hg } = map, W = probe.width, H = probe.height, data = probe.data;
  if (Math.abs(a * sx - 1) > 1e-3 || Math.abs(d * sy - 1) > 1e-3 || Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) return 0;
  const blocks = probe.edges & 2 ? 2 : 1;
  const edgeRow = probe.edgeRow ?? PROBE_EDGE_ROW;
  if (!data || data.length < (edgeRow + blocks * H) * W * 4) return 0;
  const ox = -Math.floor(0.5 - e), oy = -Math.floor(0.5 - f);
  let n = 0;
  for (let block = 0; block < blocks; block++) for (let r = 0; r < H; r++) {
    const gy = r + oy;
    if (gy < 0 || gy >= Hg || !(probe.edges & (1 << block))) continue;
    const base = (edgeRow + block * H + H - 1 - r) * W * 4;
    for (let i = 0; i < W; i++) {
      const gx = i + ox;
      if (gx < 0 || gx >= Wg || data[base + i * 4 + 3] < 128) continue;
      const cell = edgeCell(data, base + i * 4);
      if (!cell) continue;
      if (n >= out.x.length) growEdges(out, n * 2);
      out.x[n] = gx; out.y[n] = gy; out.mask[n] = cell.mask; out.n[n] = cell.neighbour; out.color[n] = -1;
      n++;
    }
  }
  out.count = n;
  return n;
}
function growEdges(out, size) {
  for (const [k, T] of [['x', Int16Array], ['y', Int16Array], ['mask', Uint16Array], ['n', Uint8Array], ['color', Int32Array]]) {
    const next = new T(size); next.set(out[k]); out[k] = next;
  }
}
export function edgeState(size = 1024) {
  return { x: new Int16Array(size), y: new Int16Array(size), mask: new Uint16Array(size), n: new Uint8Array(size), color: new Int32Array(size), count: 0 };
}

/**
 * Each edge cell's neighbour colour from grid rows `y0`..`y0 + rows` of
 * `data` (RGBA, `width` wide), or −1 where there is nothing to paint: a
 * cell or neighbour outside those rows or not opaque terrain, the same
 * colour on both sides, or a cell `busy(x, y)` already split by a crest
 * line. `dy` moves every cell by whole rows (a lagged probe's shift).
 * Returns the cells left to paint.
 */
export function colorEdges(edges, data, width, y0, rows, { dy = 0, busy = null } = {}) {
  let painted = 0;
  for (let k = 0; k < edges.count; k++) {
    edges.color[k] = -1;
    const x = edges.x[k], y = edges.y[k] + dy, [ddx, ddy] = EDGE_NEIGHBOURS[edges.n[k]];
    const nx = x + ddx, ny = y + ddy;
    if (y < y0 || y >= y0 + rows || ny < y0 || ny >= y0 + rows || nx < 0 || nx >= width) continue;
    if (busy?.(x, y)) continue;
    const o = ((y - y0) * width + x) * 4, q = ((ny - y0) * width + nx) * 4;
    if (data[o + 3] < LAND_ALPHA || data[q + 3] < LAND_ALPHA) continue;
    if (data[o] === data[q] && data[o + 1] === data[q + 1] && data[o + 2] === data[q + 2]) continue;
    edges.color[k] = data[q] << 16 | data[q + 1] << 8 | data[q + 2];
    painted++;
  }
  return painted;
}

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
    above: new Uint8Array(n * 3), aboveOk: new Uint8Array(n),
    scan: filterState(n), scanRaw: new Float32Array(n), foot: NaN, top: NaN };
}

// A binary search keeps path work proportional to the physical edge, even
// when many native cells/chunks clip different portions of the same line.
function geometryIndex(geometry, x) {
  let lo = 0, hi = geometry.count;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (geometry.x[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function lineY(g, x) {
  const geo = g.geometry;
  if (!geo) {
    const a = Math.max(0, Math.min(g.line.length - 1, Math.floor(x - .5))), b = Math.min(g.line.length - 1, a + 1);
    return g.line[a] + (g.line[b] - g.line[a]) * Math.max(0, Math.min(1, x - .5 - a));
  }
  const b = Math.min(geo.count - 1, geometryIndex(geo, x)), a = Math.max(0, b - 1), dx = geo.x[b] - geo.x[a];
  return dx > 0 ? geo.y[a] + (geo.y[b] - geo.y[a]) * Math.max(0, Math.min(1, (x - geo.x[a]) / dx)) : geo.y[b];
}
function traceLine(ctx, g, start, end, X, Y, reverse = false) {
  const geo = g.geometry;
  if (geo) {
    const a = geometryIndex(geo, start), b = geometryIndex(geo, end);
    if (reverse) for (let i = b - 1; i >= a; i--) { if (Number.isFinite(geo.y[i])) ctx.lineTo(X(geo.x[i]), Y(geo.y[i])); }
    else for (let i = a; i < b; i++) { if (Number.isFinite(geo.y[i])) ctx.lineTo(X(geo.x[i]), Y(geo.y[i])); }
  } else if (reverse) for (let i = Math.floor(end - .5); i >= Math.ceil(start - .5); i--) ctx.lineTo(X(i + .5), Y(g.line[i]));
  else for (let i = Math.ceil(start - .5); i <= Math.floor(end - .5); i++) ctx.lineTo(X(i + .5), Y(g.line[i]));
}

export class RangeCrest {
  constructor({ makeCanvas = null, residency = null } = {}) {
    this.makeCanvas = makeCanvas;
    this.residency = residency;
    this.mode = 'refined';
    // Economy / 8-bit (PerfGovernor `economy`, pinned to the cheapest rung):
    // the heavy rungs keep the old no-probe path. No probe passes or
    // readback, no terrain cut and no line. Set by the presenter each frame.
    this.economy = false;
    this.fade = 0;
    this.splitFade = 0;
    this._viewFade = false;
    this.snapshot = null;
    this._targetWidth = 0;
    this._gridKey = '';
    this._bands = null; // target-space state per band
    this._grid = null; // grid-space arrays per band
    this._shore = null;
    this._last = null; // { frameId, timeMs, viewId }
    this._split = null; // { canvas, image, dirty: [y0, y1] }
    this._splitHold = null; // residency retain() release for the split canvas
    this._edges = edgeState(); // terrain-over-terrain edge cells (decodeEdges)
    this._edgeFrame = -1; // the frame whose edge colours are ready to draw
    this._edgeStyles = new Map();
    this._splitUpload = null;
    this._orig = null;
    this._sky = null;
    this._sampleAge = Infinity; // seconds since the last grid reading
    this._colorPattern = null;
    this._origRead = null; // { frameId, groups }: rows of `_orig` this frame read
    this._glow = null; // translucent content above the skyline at the last reading (null: unknown)
    this.diagnostics = { mode: this.mode, fade: 0, splitFade: 0, splitStrength: 0, resets: 0, lastReset: null, probeMs: 0, probeRead: 'none', probeLag: 0, updateMs: 0, prepareMs: 0,
      drawMs: 0, shoreMs: 0, splitCells: 0, columns: 0, shoreChains: 0, shoreDropped: 0, readback: 'none', readRows: 0, readbackMs: 0,
      lagShift: 0, lagLineShift: 0, aligned: 0, cutColumns: 0, cutMs: 0, pockets: 0, glowRefill: 0 };
  }

  /** Drop the temporal state: the next frame starts from its raw crest. */
  reset(reason = 'reset') {
    if (this._bands) for (const b of Object.values(this._bands)) { resetFilter(b.filter); b.elev.fill(NaN); b.foot = b.top = NaN; }
    if (this._shore) { this._shore.y.fill(NaN); this._shore.kind.fill(0); }
    if (this._grid) for (const g of Object.values(this._grid)) { g.geometry = null; g.vis.fill(NaN); g.landOk.fill(0); resetFilter(g.scan); g.foot = g.top = NaN; }
    this._sampleAge = Infinity;
    this._origRead = null;
    this._glow = null;
    this.diagnostics.resets++;
    this.diagnostics.lastReset = reason;
  }

  /** The probe mode the next frame should render: 'refined' (depth,
   *  elevation, water), 'grid' (crest rows and colours only) or null (none:
   *  the economy floor on the heavy rungs, see `economy`). */
  get probeMode() { return this.economy && this.mode === 'grid' ? null : this.mode; }

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
   * is drawn at. `instant` (export draws) starts a discontinuous frame at
   * full strength.
   */
  update({ probe, frameId, timeMs = 0, viewId = null, qualityLevel = 0, transform, stage, grid, sky = null, instant = false, opacity = 1 } = {}) {
    const t0 = performance.now();
    const last = this._last;
    const rawDt = last && Number.isFinite(timeMs) ? (timeMs - last.timeMs) / 1000 : 0;
    const dt = rawDt > 0 && rawDt < SEEK_JUMP_MS / 1000 ? rawDt : 1 / 60;
    const seek = !!last && (rawDt < -0.001 || rawDt > SEEK_JUMP_MS / 1000);
    // Consecutive history: the frame right after the last one drawn (a
    // travel or arrival frame counts: it is drawn, with no crest), no seek.
    const consecutive = !!last && last.drawnId === frameId - 1 && !seek;
    // The probe runs light from CREST_GRID_SCAN_LEVEL. The line holds
    // across the switch (same rows, same filter); only elevation (held) and
    // shorelines (refined only) differ.
    const desired = qualityLevel >= CREST_GRID_SCAN_LEVEL ? 'grid' : 'refined';
    if (desired !== this.mode) this.mode = desired;
    this.diagnostics.mode = this.mode;
    // A frame without a probe or scan (travel, arrival) breaks the filter's
    // chain, but still counts as drawn history for `instant`.
    this._last = { frameId: probe ? frameId : NaN, drawnId: frameId, timeMs, viewId };
    if (!probe || !grid?.width || probe && (!transform || !stage?.width)) {
      if (this._grid) for (const g of Object.values(this._grid)) g.geometry = null;
      this._colorPattern?.release();
      this.snapshot = null;
      this.diagnostics.fade = this.fade;
      this.diagnostics.readback = 'none';
      return null;
    }
    this._ensure(probe ? probe.width : 0, grid);
    if (!last || last.viewId !== viewId) { this.reset('view'); this.fade = this.splitFade = 0; this._viewFade = true; }
    else if (last.frameId !== frameId - 1) this.reset('gap');
    else if (seek) this.reset('seek');
    // Split cells need a probe and read grid rows back for it, so they shed
    // from CREST_PIXEL_SPLIT_LEVEL (with the fade).
    const outputGeometry = !!probe && Object.hasOwn(probe, 'fine');
    const shapeAvailable = !outputGeometry || !!probe.fine;
    if (!probe || !shapeAvailable) this._colorPattern?.release();
    const splitWanted = !!probe && shapeAvailable && qualityLevel < CREST_PIXEL_SPLIT_LEVEL;
    if (instant && !consecutive) {
      // An isolated export frame (visual evaluation, the 4K reel re-render, a
      // seek inside an export) has no history to fade from: full strength,
      // from the raw crest (the reset above). A continuous export (each
      // frame right after the last drawn one) keeps the live fades, a view
      // change included, so it still matches live playback.
      this.fade = 1; this.splitFade = splitWanted ? 1 : 0; this._viewFade = false;
    } else {
      const fadeIn = dt / (this._viewFade ? CREST_VIEW_FADE_SEC : CREST_FADE_SEC);
      this.fade = Math.min(1, this.fade + dt / CREST_VIEW_FADE_SEC);
      this.splitFade = splitWanted ? Math.min(1, this.fade, this.splitFade + fadeIn) : Math.max(0, this.splitFade - dt / CREST_FADE_SEC);
      if (this.fade >= 1 && (this.splitFade >= 1 || !splitWanted)) this._viewFade = false;
    }
    this._sky = hexRgb(sky);
    let rotated = false, columns = 0, shores = [];
    if (probe) ({ rotated, columns, shores } = this._fromProbe(probe, dt, transform, stage, grid));
    else for (const band of CREST_BANDS) {
      const g = this._grid[band];
      g.geometry = null;
      g.line.fill(NaN); g.raw.fill(NaN); g.skip.fill(1); g.crossed.fill(-1); g.crossedEnd.fill(-1); g.colorAt.fill(-1); g.chunks = [];
    }
    if (!probe || rotated) this._edges.count = 0;
    this._edgeFrame = -1;
    const split = !!probe && shapeAvailable && !rotated && !!this.makeCanvas && this.splitFade > 0;
    // Split cells fully shed (Pixel from its split rung, grid-scan rungs):
    // this frame's snapshot draws no lower halves, so neither its display
    // nor its capture needs the canvas. Give it, and its hold, back.
    if (!split && !(this.splitFade > 0)) this._releaseSplit();
    const shown = this.fade * Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
    this.snapshot = Object.freeze({ frameId, dt, grid: { width: grid.width, height: grid.height }, mode: this.mode, fade: shown,
      splitFade: this.splitFade, split, cut: shapeAvailable, outputGeometry, prepared: false, splitPending: false, splitReady: false, splitAlpha: 0, shores,
      lag: probe ? probe.lag || 0 : 0, aligned: 0 });
    this.diagnostics.fade = shown;
    this.diagnostics.splitFade = this.splitFade;
    this.diagnostics.columns = columns;
    this.diagnostics.fineColumns = probe ? CREST_BANDS.reduce((n, b) => n + (this._bands[b]?.fineCount || 0), 0) : 0;
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
    // Split cells assume each grid column maps to one target column at every
    // row. The resample below is affine in y, but finds columns at y = 0:
    // a roll moves x by c·y, so it only counts once that drift over the
    // target's height reaches a quarter column (a landing's ring-down roll
    // stays well under it).
    const rotated = Math.abs(c * sy) * (probe.height || stage.targetHeight || stage.height) > 0.25;
    this._probeMap = { a, b, c, d, e, f, sx, sy, W, H: probe.height || stage.targetHeight || stage.height, Wg, Hg: grid.height };
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
      s.fineCount = fineCrest(probe, band, s.raw, s.recon);
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
      this._fineGeometry(probe, band, s, g, { a, b, c, d, e, f, sx, sy, Wg });
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
    decodeEdges(probe, this._probeMap, this._edges);
    return { rotated, columns, shores };
  }

  /** Retain every real output silhouette sample; native arrays remain only
   * ownership, crown protection and temporal-motion metadata. */
  _fineGeometry(probe, band, state, g, map) {
    const fine = probe.fine;
    if (!fine?.width) { g.geometry = null; return; }
    const n = fine.width, W = probe.width, H = probe.height;
    let geo = g.geometry;
    if (geo?.count !== n) geo = { x: new Float32Array(n), y: new Float32Array(n), column: new Int32Array(n), count: n };
    const { a, b, c, d, e, f, sx, sy, Wg } = map;
    for (let i = 0; i < n; i++) {
      const tx = (i + .5) * W / n, j = Math.min(W - 1, Math.floor(tx));
      const centre = fineLineRow(probe, band, Math.min(n - 1, Math.floor((j + .5) * n / W))) * H / fine.height;
      const raw = fineLineRow(probe, band, i) * H / fine.height;
      const crown = Number.isFinite(state.raw[j]) && (!Number.isFinite(centre) || state.raw[j] < centre - 1);
      const y = crown ? state.filter.y[j] : raw + (state.filter.y[j] - state.recon[j]);
      geo.x[i] = a * sx * tx + c * sy * (Number.isFinite(y) ? y : 0) + e;
      geo.y[i] = b * sx * tx + d * sy * y + f;
      geo.column[i] = Math.max(0, Math.min(Wg - 1, Math.floor(geo.x[i])));
    }
    g.geometry = geo;
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
      out.push({ start: i, end, last: j, tier, e: e / count, ...this._chunkColor(band, s, g, i, j) });
      i = j + 1;
    }
    return out;
  }

  /** The stroke colour of columns i..j: the land the viewer sees just below
   *  the line in the grid (sampled by prepareGrid, after haze and grading),
   *  else the probe's band colour, darkened, receded and snapped. `land` is
   *  that land itself, which fills sky pockets just
   *  below the line where the terrain cut stands in for split cells. */
  _chunkColor(band, s, g, i, j) {
    const rgb = [0, 0, 0];
    let n = 0;
    for (let x = i; x <= j; x++) if (g.landOk[x]) { rgb[0] += g.land[x * 3]; rgb[1] += g.land[x * 3 + 1]; rgb[2] += g.land[x * 3 + 2]; n++; }
    if (!n && s) for (let x = i; x <= j; x++) {
      const t = g.colorAt[x];
      if (t >= 0) { rgb[0] += s.color[t * 3]; rgb[1] += s.color[t * 3 + 1]; rgb[2] += s.color[t * 3 + 2]; n++; }
    }
    const land = n ? rgb.map(v => v / n) : FALLBACK_LAND;
    // Above the line: a farther ridge's land where the grid shows one, else
    // the sky (Ashton, 2026-11-03: the outline is the mean of the two).
    const up = [0, 0, 0];
    let m = 0, open = 0;
    for (let x = i; x <= j; x++) {
      if (g.aboveOk[x]) { up[0] += g.above[x * 3]; up[1] += g.above[x * 3 + 1]; up[2] += g.above[x * 3 + 2]; m++; } else open++;
    }
    const sky = this._sky || land;
    const above = m > open ? up.map(v => v / m) : sky;
    return { color: css(snapCrestColor(crestLineColor(land, above, band))), land: css(land) };
  }

  _recolor() {
    for (const band of CREST_BANDS) {
      const g = this._grid[band], s = this._bands?.[band] || null;
      for (const chunk of g.chunks) Object.assign(chunk, this._chunkColor(band, s, g, chunk.start, chunk.last));
    }
  }

  _updateShores(probe, dt, m, carry, cut) {
    const t0 = performance.now();
    const W = probe.width, data = probe.data, st = this._shore;
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
      const { ys, residual, maxCurvature, sigma } = smoothShoreChain(rows, shape.sigma);
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
      // apart: the drawn chain is smoothed again (out of place, local
      // linear, so ends and slopes stay put), as lightly as a clean chain
      // allows; the held state is not changed.
      smoothHeldShore(held, Math.max(SHORE_HELD_SIGMA, sigma / 2), maxCurvature);
      chain.forEach(([j], p) => {
        const y = held[p], x = j + 0.5;
        pts[p * 2] = m.a * m.sx * x + m.c * m.sy * y + m.e;
        pts[p * 2 + 1] = m.b * m.sx * x + m.d * m.sy * y + m.f;
      });
      chains.push(Object.freeze({ points: pts, kind, nearness: near / n,
        color: css(snapCrestColor(shoreColor(rgb.map(v => v / n)))) }));
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
    // Held against pressure eviction while it exists: prepareGrid edits the
    // grid cells it crosses, and only this canvas restores their lower
    // halves for display and capture. An eviction between those two steps
    // (e.g. a Cinematic reservation) would leave the grid edited with no
    // lower halves. Pixel sheds split cells from its own rung instead.
    this._splitHold = this.residency?.retain(CREST_SPLIT_KEY) ?? null;
    return this._split;
  }

  _releaseSplit() {
    this._splitHold?.(); this._splitHold = null;
    if (!this._split) return;
    if (this.residency) this.residency.release(CREST_SPLIT_KEY);
    else this._split.canvas.width = this._split.canvas.height = 0;
    this._split = null;
  }

  /**
   * Before the grid is composited: re-own the grid cells around each
   * smoothed line, fading the edit in and out with the line, and read the
   * line's land colour and visibility. While split cells are on, each
   * band's own rows (±3 cells around its lines) are read from `ctx` and
   * written back.
   */
  prepareGrid(options = {}) {
    const prepared = this._prepareCrest(options);
    // Edge colours come from the grid as drawn.
    if (options.ctx) this._prepareEdges(options.ctx);
    return prepared;
  }

  _prepareCrest({ ctx = null } = {}) {
    const snap = this.snapshot;
    if (!snap || snap.prepared || !(snap.fade > 0)) return false;
    const t0 = performance.now();
    const strength = snap.split ? Math.min(snap.fade, snap.splitFade) : 0;
    this._sampleAge += snap.dt || 1 / 60;
    // No split cells: only a throttled sample-only read.
    const sampleOnly = !(strength > 0);
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
    if (!split && !sampleOnly) return false;
    if (!this._orig || this._orig.length < W * H * 4) this._orig = new Uint8ClampedArray(W * H * 4);
    const sdata = split?.image.data;
    if (split?.dirty) sdata.fill(0, split.dirty[0] * W * 4, split.dirty[1] * W * 4);
    const kv = 1 - Math.exp(-Math.min(this._sampleAge, 1) / VIS_TAU_SEC);
    this._sampleAge = 0;
    let cells = 0, readRows = 0, readMs = 0;
    const images = [];
    for (const { y0, y1 } of groups) {
      let image;
      try {
        {
          const r0 = performance.now();
          const read = ctx.getImageData(0, y0, W, y1 - y0);
          readMs += performance.now() - r0; readRows += y1 - y0;
          image = { data: read.data, width: W, y0, rows: y1 - y0, read };
        }
      } catch { return false; }
      this._orig.subarray(y0 * W * 4, y1 * W * 4).set(image.data);
      images.push(image);
    }
    // A live (asynchronous) probe is a frame or more older than this grid:
    // under camera motion, heave or a kick the terrain has since moved. Take
    // that shift from the grid itself, every frame its rows are read anyway.
    const aligned = snap.lag > 0 && split ? this._alignToGrid(W, H, groups) : null;
    for (let gi = 0; gi < groups.length; gi++) {
      const { y0, y1, bands } = groups[gi], image = images[gi];
      const orig = this._orig.subarray(y0 * W * 4, y1 * W * 4);
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
    this._origRead = { frameId: snap.frameId, groups };
    this._glow = this._findGlow(W, (r, i) => groups.some(gr => r >= gr.y0 && r < gr.y1) ? this._orig[(r * W + i) * 4 + 3] : -1);
    this._recolor();
    let ready = false;
    if (split) {
      const n0 = groups[0].y0, n1 = groups.at(-1).y1;
      this._splitUpload = split.dirty ? [Math.min(split.dirty[0], n0), Math.max(split.dirty[1], n1)] : [n0, n1];
      split.dirty = [n0, n1];
      ready = this._uploadSplit();
    }
    this.snapshot = Object.freeze({ ...snap, prepared: true, splitPending: false, splitReady: ready, splitAlpha: split ? strength : 0,
      aligned: aligned?.columns || 0, alignShift: aligned?.shift || 0 });
    this.diagnostics.lagShift = aligned?.shift || 0;
    this.diagnostics.lagLineShift = aligned?.lineShift || 0;
    this.diagnostics.aligned = aligned?.columns || 0;
    this.diagnostics.splitCells = cells;
    this.diagnostics.splitStrength = split ? strength : 0;
    this.diagnostics.readback = sampleOnly ? 'probe+crest-sample' : 'probe+crest-rows';
    this.diagnostics.readRows = readRows;
    this.diagnostics.readbackMs = readMs;
    noteSyncWait('crestRead', readMs);
    this.diagnostics.prepareMs = performance.now() - t0;
    return true;
  }

  /**
   * Lag correction from the grid rows just read (`this._orig`, rows of
   * `groups` only). In each skyline column the grid's own crest is the
   * first opaque row below a transparent one (the sky is drawn separately)
   * within LAG_ROWS of the probe's raw crest. Their common offset (most
   * columns agreeing on one whole row) is the camera or heave shift since
   * the probe's frame: every band's raw crest moves by that whole row and
   * skyline columns then take their grid crest exactly, so split cells are
   * classified against the terrain this grid shows. The drawn line and the
   * nearer-band clip move by the sub-row mean offset of those columns
   * instead, so steady motion never flips the stroke by a whole row.
   */
  _alignToGrid(W, H, groups) {
    const orig = this._orig;
    const valid = (r) => r >= 0 && r < H && groups.some(gr => r >= gr.y0 && r < gr.y1);
    const alpha = (r, i) => orig[(r * W + i) * 4 + 3];
    const found = this._gridCrest ||= {};
    const counts = new Map();
    let n = 0;
    for (const band of CREST_BANDS) {
      const g = this._grid[band], at = found[band] = found[band]?.length === W ? found[band] : new Float32Array(W);
      at.fill(NaN);
      for (let i = 0; i < W; i++) {
        const R = g.raw[i];
        if (!g.skyline[i] || g.skip[i] || !Number.isFinite(R) || !Number.isFinite(g.line[i])) continue;
        for (let r = R - LAG_ROWS; r <= R + LAG_ROWS; r++) {
          if (!valid(r) || !valid(r - 1) || alpha(r, i) < 250) continue;
          if (alpha(r - 1, i) < 128) { at[i] = r; counts.set(r - R, (counts.get(r - R) || 0) + 1); n++; }
          break;
        }
      }
    }
    let shift = 0, best = 0;
    for (const [d, c] of counts) if (c > best) { best = c; shift = d; }
    if (n < 8 || best * 2 <= n) return { shift: 0, lineShift: 0, columns: 0 };
    // The drawn line moves by the sub-row mean of the columns near the
    // majority offset: each column's offset is quantized to whole rows, but
    // across a sloped skyline their mean follows the true motion, so steady
    // motion of a fraction of a row per frame moves the stroke steadily
    // instead of flipping it a whole row between 0 and 1.
    let sum = 0, m = 0;
    for (const band of CREST_BANDS) {
      const g = this._grid[band], at = found[band];
      for (let i = 0; i < W; i++) {
        if (!Number.isFinite(at[i])) continue;
        const d = at[i] - g.raw[i];
        if (Math.abs(d - shift) <= 1) { sum += d; m++; }
      }
    }
    const lineShift = Math.max(-LAG_ROWS, Math.min(LAG_ROWS, m ? sum / m : shift));
    let columns = 0;
    for (const band of CREST_BANDS) {
      const g = this._grid[band], at = found[band];
      // Classification (raw crest, split-cell spans) snaps to whole rows.
      if (shift) for (let i = 0; i < W; i++) g.raw[i] += shift;
      if (lineShift) for (let i = 0; i < W; i++) { g.line[i] += lineShift; g.minNearer[i] += lineShift; }
      if (lineShift && g.geometry) for (let i = 0; i < g.geometry.count; i++) g.geometry.y[i] += lineShift;
      for (let i = 0; i < W; i++) if (Number.isFinite(at[i]) && Math.abs(at[i] - g.raw[i]) <= 1) { g.raw[i] = at[i]; columns++; }
    }
    return { shift, lineShift, columns };
  }

  /** Edge colours from the grid as drawn: its rows
   *  spanning the edge cells, read once. */
  _prepareEdges(ctx) {
    const snap = this.snapshot, edges = this._edges;
    if (!snap || !edges.count || this._edgeFrame === snap.frameId) return false;
    const { width: W, height: H } = snap.grid;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < edges.count; k++) { lo = Math.min(lo, edges.y[k]); hi = Math.max(hi, edges.y[k]); }
    const dy = snap.lag > 0 ? snap.alignShift || 0 : 0;
    const y0 = Math.max(0, lo + dy - 1), y1 = Math.min(H, hi + dy + 2);
    if (!(y1 > y0)) return false;
    let image;
    const r0 = performance.now();
    try { image = ctx.getImageData(0, y0, W, y1 - y0); } catch { return false; } finally { noteSyncWait('crestEdges', performance.now() - r0); }
    return this._colorEdges(image.data, W, y0, y1 - y0);
  }

  _colorEdges(data, W, y0, rows) {
    const snap = this.snapshot, edges = this._edges;
    if (!snap || !edges.count) return false;
    const dy = snap.lag > 0 ? snap.alignShift || 0 : 0;
    const bands = CREST_BANDS.map(b => this._grid[b]);
    const busy = (x, y) => bands.some(g => g.crossed[x] >= 0 && y >= g.crossed[x] && y <= g.crossedEnd[x]);
    this.diagnostics.edgeCells = colorEdges(edges, data, W, y0, rows, { dy, busy });
    this._edgeDy = dy;
    this._edgeFrame = snap.frameId;
    return true;
  }

  /** Paint each edge cell's neighbour-owned output pixels in that
   *  neighbour's colour: terrain over terrain at output resolution. */
  _drawEdges(ctx, fit) {
    const edges = this._edges, K = PROBE_FINE_K, s = fit.scale, dy = this._edgeDy || 0;
    const styles = this._edgeStyles;
    if (styles.size > 4096) styles.clear();
    let runs = 0;
    for (let k = 0; k < edges.count; k++) {
      const c = edges.color[k];
      if (c < 0) continue;
      let style = styles.get(c);
      if (!style) { style = `rgb(${c >> 16 & 255},${c >> 8 & 255},${c & 255})`; styles.set(c, style); }
      ctx.fillStyle = style;
      const x = fit.x + edges.x[k] * s, y = fit.y + (edges.y[k] + dy) * s, m = edges.mask[k];
      for (let sy = 0; sy < K; sy++) {
        const top = Math.round(y + sy * s / K), bottom = Math.round(y + (sy + 1) * s / K);
        let sx = 0;
        while (sx < K) {
          if (!(m >> (sy * K + sx) & 1)) { sx++; continue; }
          let e = sx;
          while (e + 1 < K && m >> (sy * K + e + 1) & 1) e++;
          const left = Math.round(x + sx * s / K), right = Math.round(x + (e + 1) * s / K);
          if (right > left && bottom > top) { ctx.fillRect(left, top, right - left, bottom - top); runs++; }
          sx = e + 1;
        }
      }
    }
    this.diagnostics.edgeRuns = runs;
  }

  _uploadSplit() {
    const split = this._split, range = this._splitUpload;
    if (!split || !range) return false;
    try { split.canvas.getContext('2d').putImageData(split.image, 0, 0, 0, range[0], split.canvas.width, range[1] - range[0]); }
    catch { return false; }
    return true;
  }

  /** The land the viewer sees 1-2 cells below each column's line (opaque
   *  cells of this band, above any nearer band's line), and the opaque land
   *  1-2 cells above its top (a farther ridge; none where it is sky), from
   *  the grid. */
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
      if (n) { g.land[i * 3] = r0 / n; g.land[i * 3 + 1] = g0 / n; g.land[i * 3 + 2] = b0 / n; g.landOk[i] = 1; }
      // What lies directly above the band's own top: a farther ridge's land
      // (opaque), or the sky drawn separately (left to the frame's sky).
      g.aboveOk[i] = 0;
      const top = Math.min(Number.isFinite(R) ? R : Math.floor(L), Math.floor(L));
      r0 = 0; g0 = 0; b0 = 0; n = 0;
      for (let r = top - 2; r <= top - 1; r++) {
        if (r < y0 || r >= y1) continue;
        const k = ((r - y0) * W + i) * 4;
        if (orig[k + 3] < 250) continue;
        r0 += orig[k]; g0 += orig[k + 1]; b0 += orig[k + 2]; n++;
      }
      if (n) { g.above[i * 3] = r0 / n; g.above[i * 3 + 1] = g0 / n; g.above[i * 3 + 2] = b0 / n; g.aboveOk[i] = 1; }
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

  /** Whether any skyline column holds translucent content (0 < alpha <
   *  LAND_ALPHA) in the GLOW_ROWS above its raw crest. `alphaAt(r, i)`: −1
   *  where nothing was read. */
  _findGlow(W, alphaAt) {
    for (const band of CREST_BANDS) {
      const g = this._grid[band];
      for (let i = 0; i < W; i++) {
        const R = g.raw[i];
        if (!g.skyline[i] || g.skip[i] || !Number.isFinite(R)) continue;
        for (let r = R - GLOW_ROWS; r < R; r++) { const a = alphaAt(r, i); if (a > 0 && a < LAND_ALPHA) return true; }
      }
    }
    return false;
  }

  /**
   * Skyline columns the terrain cut applies to: per grid column the band
   * (index into CREST_BANDS, −1 none) whose line has only sky above it and
   * no nearer band within reach, and the top row of the cut there: the raw
   * crest (or the line's own top, if lower), less LAG_CUT_ROWS when the
   * probe was a frame old, never more than REOWN_MAX_ROWS above the line.
   * Rows from there down to the line are this band's land (or sky) above
   * the line, which split cells would make transparent.
   */
  _cutColumns(W) {
    const c = this._cut?.band.length === W ? this._cut : (this._cut = { band: new Int8Array(W), top: new Float32Array(W), spanTop: new Float32Array(W), spanBottom: new Float32Array(W) });
    const snap = this.snapshot, margin = snap.lag > 0 && !snap.aligned ? LAG_CUT_ROWS : 0, span = [0, 0];
    let n = 0;
    c.band.fill(-1);
    for (let i = 0; i < W; i++) {
      for (let b = 0; b < CREST_BANDS.length; b++) {
        const g = this._grid[CREST_BANDS[b]], L = g.line[i];
        if (!Number.isFinite(L) || !g.skyline[i] || g.skip[i]) continue;
        crestSpan(g.line, i, span);
        const R = g.raw[i], top = Math.floor(span[0]);
        c.band[i] = b; c.spanTop[i] = span[0]; c.spanBottom[i] = span[1];
        c.top[i] = Math.max(0, top - REOWN_MAX_ROWS, (Number.isFinite(R) ? Math.min(R, top) : top) - margin);
        n++;
        break;
      }
    }
    for (const band of CREST_BANDS) {
      const g = this._grid[band], geo = g.geometry;
      if (!geo) continue;
      const bi = CREST_BANDS.indexOf(band);
      for (let j = 0; j < geo.count; j++) {
        const i = geo.column[j], y = geo.y[j];
        if (c.band[i] !== bi || !Number.isFinite(y)) continue;
        c.top[i] = Math.min(c.top[i], Math.floor(y));
        c.spanTop[i] = Math.min(c.spanTop[i], y); c.spanBottom[i] = Math.max(c.spanBottom[i], y);
      }
    }
    return n;
  }

  /**
   * Draw the terrain (`draw()`: the grid, nearest or the Cinematic
   * reconstruction) clipped below the skyline at output resolution, over
   * the smooth sky the presenter drew first. Land cells above the line
   * (stair-step teeth the split cells did not cut: no split cells on this
   * rung, a split canvas denied, a probe a frame behind) and the upper part
   * of every crossed cell show that sky; the line then covers the edge.
   * Path work over the grid's columns only, no readback, every rung and
   * look. While the line fades in, the cut rows are drawn again at
   * 1 − fade, so the silhouette never pops. False (nothing drawn) when there
   * is nothing to cut.
   */
  drawTerrain(ctx, fit, frameId, draw, source = null) {
    const snap = this.snapshot;
    if (!snap || !snap.cut || snap.frameId !== frameId || !(snap.fade > 0) || !(fit?.scale > 0) || typeof draw !== 'function') return false;
    // Split cells at full strength on terrain this grid shows (a synchronous
    // probe, or one aligned to the grid) already cut every crossed cell:
    // nothing is left to clip, and the clip's raster cost is saved.
    this.diagnostics.cutColumns = 0;
    if (!CREST_BANDS.some(band => this._grid[band].geometry) && snap.splitReady && snap.splitAlpha >= 1
      && this._split && (!(snap.lag > 0) || snap.aligned > 0)) return false;
    const t0 = performance.now();
    const W = snap.grid.width, cut = this._cutColumns(W);
    this.diagnostics.cutColumns = cut;
    if (!cut) return false;
    const s = fit.scale, X = x => fit.x + x * s, Y = y => fit.y + y * s;
    const c = this._cut;
    const strips = () => {
      let i = 0;
      while (i < W) {
        const b = c.band[i];
        if (b < 0) { i++; continue; }
        let j = i;
        while (j + 1 < W && c.band[j + 1] === b) j++;
        const g = this._grid[CREST_BANDS[b]];
        // Top: stepped along each column's cut top; bottom: the line's own
        // polyline (the stroke's and the split clip's), back to the start.
        // (one vertex pair per change of row: the clip's raster cost grows
        // with its edges)
        ctx.moveTo(X(i), Y(c.top[i]));
        for (let x = i + 1; x <= j; x++) if (c.top[x] !== c.top[x - 1]) { ctx.lineTo(X(x), Y(c.top[x - 1])); ctx.lineTo(X(x), Y(c.top[x])); }
        ctx.lineTo(X(j + 1), Y(c.top[j]));
        ctx.lineTo(X(j + 1), Y(lineY(g, j + 1)));
        traceLine(ctx, g, i, j + 1, X, Y, true);
        ctx.lineTo(X(i), Y(lineY(g, i)));
        ctx.closePath();
        i = j + 1;
      }
    };
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(fit.x - 1, fit.y - 1, fit.width + 2, fit.height + 2);
      strips();
      ctx.clip('evenodd');
      draw();
    } finally { ctx.restore(); }
    this.diagnostics.glowRefill = source ? this._refillGlow(ctx, source, X, Y, s, W, strips, snap) : 0;
    if (snap.fade < 1) {
      ctx.save();
      try {
        ctx.beginPath(); strips(); ctx.clip();
        ctx.globalAlpha = 1 - snap.fade;
        draw();
      } finally { ctx.restore(); }
    }
    this.diagnostics.cutMs = performance.now() - t0;
    return true;
  }

  /**
   * Translucent sky-side content drawn into the grid (a glow or haze layer)
   * lies over the cut rows too, and the clip removed it with the land: the
   * cut's stepped top would show as a staircase of bare sky against the
   * glow-tinted sky above it. Refill from the last alpha-verified glow
   * colour, under the same strips. Grid reads are throttled on heavy rungs:
   * the current source can already contain opaque rock at that row, so a
   * previous glow reading must never authorize copying its current pixels.
   * Returns the number of columns refilled, without another grid read.
   */
  _refillGlow(ctx, source, X, Y, s, W, strips, snap) {
    const groups = this._origRead?.groups;
    if (!groups || !this._orig || this._glow === false) return 0;
    const c = this._cut, orig = this._orig;
    const ok = (i) => {
      const r = c.top[i] - 1;
      if (c.band[i] < 0 || !(r >= 0)) return false;
      if (!groups.some(gr => r >= gr.y0 && r < gr.y1)) return false;
      const a = orig[(r * W + i) * 4 + 3];
      return a > 0 && a < LAND_ALPHA;
    };
    let refilled = 0;
    ctx.save();
    try {
      ctx.beginPath(); strips(); ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = snap.fade;
      let i = 0;
      while (i < W) {
        if (!ok(i)) { i++; continue; }
        const top = c.top[i];
        const k = ((top - 1) * W + i) * 4;
        const sameColor = x => {
          const o = ((top - 1) * W + x) * 4;
          return orig[o] === orig[k] && orig[o + 1] === orig[k + 1] && orig[o + 2] === orig[k + 2] && orig[o + 3] === orig[k + 3];
        };
        let j = i, bottom = c.spanBottom[i];
        while (j + 1 < W && c.band[j + 1] === c.band[i] && c.top[j + 1] === top && ok(j + 1) && sameColor(j + 1)) { j++; bottom = Math.max(bottom, c.spanBottom[j]); }
        const rows = Math.floor(bottom) + 2 - top;
        if (rows > 0) {
          ctx.fillStyle = `rgba(${orig[k]},${orig[k + 1]},${orig[k + 2]},${orig[k + 3] / 255})`;
          ctx.fillRect(X(i), Y(top), (j - i + 1) * s, rows * s);
          refilled += j - i + 1;
        }
        i = j + 1;
      }
    } finally { ctx.restore(); }
    return refilled;
  }

  /** Sky pockets just below the line in cut columns (the line smoothed a
   *  notch upward; split cells would fill them with the land beside them):
   *  filled with each chunk's land colour, as deep as split cells reach. */
  _drawPockets(ctx, X, Y, alpha) {
    const c = this._cut, W = c.band.length;
    let pockets = 0;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let b = 0; b < CREST_BANDS.length; b++) {
      const g = this._grid[CREST_BANDS[b]];
      for (const chunk of g.chunks) {
        let any = false;
        for (let x = chunk.start; x <= chunk.last && x < W; x++) {
          if (c.band[x] !== b) continue;
          const R = g.raw[x], top = c.spanTop[x], bottom = c.spanBottom[x];
          if (!(R > top)) continue;
          const depth = Math.max(bottom, Math.min(R, Math.floor(bottom) + 2));
          if (!any) { ctx.beginPath(); any = true; }
          ctx.moveTo(X(x), Y(lineY(g, x))); traceLine(ctx, g, x, x + 1, X, Y); ctx.lineTo(X(x + 1), Y(lineY(g, x + 1)));
          ctx.lineTo(X(x + 1), Y(depth)); ctx.lineTo(X(x), Y(depth)); ctx.closePath();
          pockets++;
        }
        if (any) { ctx.fillStyle = chunk.land || css(FALLBACK_LAND); ctx.fill(); }
      }
    }
    ctx.restore();
    this.diagnostics.pockets = pockets;
  }

  /** Split cells and crest strokes at output resolution (after the terrain,
   *  before water). Draws only this frame's frozen snapshot. `cut`: the
   *  presenter drew the terrain through drawTerrain() in this composite. */
  drawCrest(ctx, fit, frameId, { cut = false } = {}) {
    const snap = this.snapshot;
    if (!snap || snap.frameId !== frameId || !(snap.fade > 0) || !(fit?.scale > 0)) return true;
    const t0 = performance.now();
    const s = fit.scale, X = x => fit.x + x * s, Y = y => fit.y + y * s;
    const outH = fit.height;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      this.diagnostics.edgeRuns = 0;
      if (this._edgeFrame === snap.frameId && this._edges.count) this._drawEdges(ctx, fit);
      const splitAlpha = snap.splitReady && this._split && snap.splitAlpha > 0 ? snap.splitAlpha : 0;
      if (splitAlpha > 0) this._drawSplit(ctx, fit, X, Y, splitAlpha);
      this.diagnostics.pockets = 0;
      const fine = CREST_BANDS.some(band => this._grid[band].geometry);
      if (cut && this._cut && (splitAlpha < 1 || fine)) this._drawPockets(ctx, X, Y, snap.fade * (fine ? 1 : 1 - splitAlpha));
      // Freeze a GPU-backed mean of the corrected visible terrain and sky
      // before any band strokes; no output canvas CPU readback is needed.
      const pattern = fine ? (this._colorPattern ||= new CrestColorPattern({ makeCanvas: this.makeCanvas, residency: this.residency }))
        .prepare(ctx, fit, CREST_BANDS.map(band => this._grid[band].geometry)) : null;
      if (!fine) this._colorPattern?.release();
      // One continuous polyline per run of columns, cut into chunks (each
      // its own colour, width and opacity) by abutting column clips: each
      // chunk strokes the run's path two vertices past its ends and is
      // clipped to its own cells, so neighbours meet at a shared pixel
      // column with no butt-cap wedge at a bend and no doubled overlap.
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const band of CREST_BANDS) {
        const g = this._grid[band];
        if (g.geometry) { this._drawFineCrest(ctx, fit, g, pattern); continue; }
        if (snap.outputGeometry) continue; // shed/denied fine pass: no invented coarse outline
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

  _drawFineCrest(ctx, fit, g, pattern) {
    const geo = g.geometry, s = fit.scale, snap = this.snapshot;
    if (!pattern) return;
    ctx.save();
    try {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const bandIndex = CREST_BANDS.findIndex(band => this._grid[band] === g);
      if (bandIndex < CREST_BANDS.length - 1) {
        ctx.beginPath(); ctx.moveTo(fit.x, fit.y - 4);
        for (let i = 0; i < geo.count; i++) {
          const x = geo.x[i];
          if (!(x >= 0 && x <= snap.grid.width)) continue;
          let nearer = Infinity;
          for (let b = bandIndex + 1; b < CREST_BANDS.length; b++) {
            const y = lineY(this._grid[CREST_BANDS[b]], x);
            if (Number.isFinite(y)) nearer = Math.min(nearer, y);
          }
          ctx.lineTo(fit.x + x * s, Number.isFinite(nearer) ? fit.y + nearer * s : fit.y + fit.height + 4);
        }
        ctx.lineTo(fit.x + fit.width, fit.y - 4); ctx.closePath(); ctx.clip();
      }
      // One physical-pixel edge, coloured by the actual composite mean.
      // Native rank/visibility tiers would attenuate that mean and split a
      // single GPU pattern into hundreds of expensive clipped strokes.
      ctx.globalAlpha = snap.fade;
      ctx.strokeStyle = pattern;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let connected = false, any = false;
      for (let i = 0; i < geo.count; i++) {
        if (g.skip[geo.column[i]] || !Number.isFinite(geo.x[i]) || !Number.isFinite(geo.y[i])) { connected = false; continue; }
        const x = fit.x + geo.x[i] * s, y = fit.y + geo.y[i] * s;
        if (connected) { ctx.lineTo(x, y); any = true; }
        else ctx.moveTo(x, y);
        connected = true;
      }
      if (any) ctx.stroke();
    } finally { ctx.restore(); }
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
        ctx.moveTo(X(i), Y(lineY(g, i)));
        traceLine(ctx, g, i, j + 1, X, Y);
        ctx.lineTo(X(j + 1), Y(lineY(g, j + 1)));
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
  drawShore(ctx, fit, frameId, opacity = 1) {
    const snap = this.snapshot;
    if (!snap || snap.frameId !== frameId || !(snap.fade > 0) || !(opacity > 0) || !snap.shores.length || !(fit?.scale > 0)) return true;
    const s = fit.scale;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const chain of snap.shores) {
        const { width, alpha } = shoreStroke(chain.nearness, fit.height);
        // 70% of the stroke on the water side: below a far shore, above a near one.
        const shift = (CREST_LAND_SIDE - 0.5) * width * (chain.kind === 1 ? 1 : -1);
        ctx.globalAlpha = alpha * snap.fade * Math.min(1, opacity);
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

  release() {
    this._releaseSplit(); this.snapshot = null; this._orig = null; this._origRead = null;
    this._colorPattern?.release(); this._colorPattern = null;
    if (this._grid) for (const g of Object.values(this._grid)) g.geometry = null;
  }
}
