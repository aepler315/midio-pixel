// Cut whole massifs out of a complete normalized DEM grid (song range
// composition, Phase 1). Offline only; no runtime module imports this.
//
// 1. Seeds: named landmarks, then summits found by prominence.
// 2. Partition: a marker-controlled watershed floods downhill from every seed
//    at once, highest cell first, so neighbouring massifs meet along the
//    valleys between them.
// 3. Region: the seed's own watershed cells above a level L, 8-connected to
//    the seed. L is the lowest level at which the region fits the size budget
//    and stays clear of the source grid's edge. Where the region ends on a
//    valley its outline follows the valley; where it ends on L it follows that
//    contour.
// 4. Base: a smooth surface B through the outline heights (inverse-distance
//    weighting of the outline). Relief is max(0, h - B): exactly zero on the
//    whole outline, the measured DEM above a gently varying base inside.
//
// Pieces are tile-aligned blocks (multiples of 64 cells) with a zero ring of at
// least two cells, stored in a frame whose +Z points toward the source view's
// camera. Only lossless quarter turns reach that frame; the angle left over is
// recorded.
//
// Grid axes follow tools/lib/terrain-source.mjs: X east, Z south, row-major,
// heightsM[j * width + i] at (originM[0] + i * cell, originM[1] + j * cell).

export const TILE_CELLS = 64;
export const ZERO_RING_CELLS = 2;
export const CUT_DEFAULTS = Object.freeze({
  maxTiles: 10,           // longest side of a piece block, in tiles
  minReliefM: 300,        // a summit standing less than this above its base is no massif
  levelStepM: 2,          // binary-search resolution of L
  edgeMarginCells: 4,     // the region must stay this far inside the source grid
  peakRadiusM: 3000,      // prominence seeds: highest sample within this radius
  seedSpacingM: 2500,     // a new seed this close to an earlier one is the same massif
  coarseM: 200,           // prominence search lattice
  baseSamples: 720,       // outline points the base surface interpolates
});

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Highest sample within `radiusM` of (i, j); returns its index. */
export function snapToPeak(grid, i, j, radiusM = 300) {
  const { width: W, height: H, cellSizeM: c, heightsM: h, valid } = grid;
  const r = Math.max(0, Math.round(radiusM / c));
  let best = -1, bestH = -Infinity;
  for (let y = clampInt(j - r, 0, H - 1); y <= clampInt(j + r, 0, H - 1); y++) {
    for (let x = clampInt(i - r, 0, W - 1); x <= clampInt(i + r, 0, W - 1); x++) {
      if ((x - i) ** 2 + (y - j) ** 2 > r * r) continue;
      const k = y * W + x;
      if (valid[k] && h[k] > bestH) { bestH = h[k]; best = k; }
    }
  }
  return best;
}

/** Grid index nearest a local point [x, z] in metres, or -1 outside. */
export function indexAt(grid, [x, z]) {
  const i = Math.round((x - grid.originM[0]) / grid.cellSizeM), j = Math.round((z - grid.originM[1]) / grid.cellSizeM);
  return i >= 0 && j >= 0 && i < grid.width && j < grid.height ? j * grid.width + i : -1;
}

/**
 * Massif seeds: named landmarks first, then summits found by prominence on a
 * coarse lattice (the highest sample within peakRadiusM), each snapped to the
 * true highest sample nearby. A seed within seedSpacingM of an earlier one is
 * dropped. Returns [{ index, name, kind: 'landmark' | 'prominence', heightM }].
 */
export function findMassifSeeds(grid, { landmarks = [], ...options } = {}) {
  const o = { ...CUT_DEFAULTS, ...options };
  const { width: W, height: H, cellSizeM: c, heightsM: h, valid } = grid;
  const seeds = [];
  const near = (k) => {
    const x = k % W, y = (k - x) / W;
    return seeds.some((s) => { const sx = s.index % W, sy = (s.index - sx) / W; return Math.hypot(sx - x, sy - y) * c < o.seedSpacingM; });
  };
  for (const l of landmarks) {
    const k0 = l.localM ? indexAt(grid, l.localM) : -1;
    if (k0 < 0) continue;
    const k = snapToPeak(grid, k0 % W, Math.floor(k0 / W));
    if (k >= 0 && !near(k)) seeds.push({ index: k, name: l.name, kind: 'landmark', heightM: h[k] });
  }
  const s = Math.max(1, Math.round(o.coarseM / c));
  const cw = Math.ceil(W / s), ch = Math.ceil(H / s);
  const top = new Int32Array(cw * ch).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    if (!valid[k]) continue;
    const q = Math.floor(y / s) * cw + Math.floor(x / s);
    if (top[q] < 0 || h[k] > h[top[q]]) top[q] = k;
  }
  const r = Math.max(1, Math.round(o.peakRadiusM / o.coarseM));
  const peaks = [];
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const k = top[cy * cw + cx];
    if (k < 0) continue;
    let isMax = true;
    for (let dy = -r; dy <= r && isMax; dy++) for (let dx = -r; dx <= r; dx++) {
      if ((!dx && !dy) || dx * dx + dy * dy > r * r) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
      const m = top[ny * cw + nx];
      // Ties break by index so a flat summit yields one seed.
      if (m >= 0 && (h[m] > h[k] || (h[m] === h[k] && m < k))) { isMax = false; break; }
    }
    if (isMax) peaks.push(k);
  }
  peaks.sort((a, b) => h[b] - h[a] || a - b);
  for (const k of peaks) if (!near(k)) seeds.push({ index: k, name: null, kind: 'prominence', heightM: h[k] });
  return seeds;
}

/** Max-heap of grid indices keyed by height, ties broken by lower index. */
class HeightHeap {
  constructor(h, capacity) { this.h = h; this.a = new Int32Array(capacity); this.n = 0; }
  above(i, j) { const hi = this.h[i], hj = this.h[j]; return hi > hj || (hi === hj && i < j); }
  push(k) {
    const a = this.a; let i = this.n++; a[i] = k;
    while (i) { const p = (i - 1) >> 1; if (!this.above(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0]; a[0] = a[--this.n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < this.n && this.above(a[l], a[m])) m = l;
      if (r < this.n && this.above(a[r], a[m])) m = r;
      if (m === i) break;
      [a[i], a[m]] = [a[m], a[i]]; i = m;
    }
    return top;
  }
}

/**
 * Marker-controlled watershed on the terrain flooded downhill: every seed
 * starts its own label and the highest unprocessed cell next to any label is
 * taken next, so labels meet along valleys. Returns Int32Array labels
 * (seed position in `seeds`, -1 for no-data). Deterministic.
 */
export function watershedLabels(grid, seeds) {
  const { width: W, height: H, heightsM: h, valid } = grid;
  const labels = new Int32Array(W * H).fill(-1);
  const queued = new Uint8Array(W * H);
  const heap = new HeightHeap(h, W * H);
  seeds.forEach((s, n) => { if (labels[s.index] < 0) { labels[s.index] = n; queued[s.index] = 1; heap.push(s.index); } });
  while (heap.n) {
    const k = heap.pop();
    const x = k % W, y = (k - x) / W, lab = labels[k];
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const m = ny * W + nx;
      if (queued[m] || !valid[m]) continue;
      queued[m] = 1; labels[m] = lab; heap.push(m);
    }
  }
  return labels;
}

/**
 * The 8-connected region of cells labelled `label` and above `levelM` that
 * contains `seed`. Fills `mark` with `stamp` for members and returns
 * { count, minX, minY, maxX, maxY, maxIndex, touchesEdge }.
 */
export function massifRegion(grid, seed, levelM, labels, label, mark, stamp, stack, edgeMargin = 0) {
  const { width: W, height: H, heightsM: h, valid } = grid;
  let top = 0, count = 0, minX = W, minY = H, maxX = -1, maxY = -1, maxIndex = seed, touchesEdge = false;
  const member = (m) => valid[m] && labels[m] === label && h[m] > levelM;
  if (!member(seed)) return { count: 0, minX, minY, maxX, maxY, maxIndex, touchesEdge };
  stack[top++] = seed; mark[seed] = stamp;
  while (top) {
    const k = stack[--top];
    const x = k % W, y = (k - x) / W;
    count++;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (h[k] > h[maxIndex] || (h[k] === h[maxIndex] && k < maxIndex)) maxIndex = k;
    if (x <= edgeMargin || y <= edgeMargin || x >= W - 1 - edgeMargin || y >= H - 1 - edgeMargin) touchesEdge = true;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const m = ny * W + nx;
      if (mark[m] === stamp || !member(m)) continue;
      mark[m] = stamp; stack[top++] = m;
    }
  }
  return { count, minX, minY, maxX, maxY, maxIndex, touchesEdge };
}

/** Tiles a block needs for a region bbox plus the zero ring on every side. */
export function blockTiles(region, ring = ZERO_RING_CELLS) {
  const wCells = region.maxX - region.minX + 2 * ring, hCells = region.maxY - region.minY + 2 * ring;
  return [Math.max(1, Math.ceil(wCells / TILE_CELLS)), Math.max(1, Math.ceil(hCells / TILE_CELLS))];
}

function gridMin(grid) {
  let lo = Number.POSITIVE_INFINITY;
  for (let i = 0; i < grid.heightsM.length; i++) if (grid.valid[i] && grid.heightsM[i] < lo) lo = grid.heightsM[i];
  return lo;
}

/**
 * The lowest level L (to levelStepM) whose region fits maxTiles a side and
 * stays edgeMarginCells inside the grid. Both limits are monotone in L.
 * Returns { ok, levelM, region, stamp, reason }.
 */
export function chooseLevel(grid, seed, labels, label, options = {}, scratch = {}) {
  const o = { ...CUT_DEFAULTS, ...options };
  const n = grid.width * grid.height;
  scratch.mark ??= new Int32Array(n);
  scratch.stack ??= new Int32Array(n);
  scratch.stamp ??= 0;
  scratch.minM ??= gridMin(grid);
  const peakM = grid.heightsM[seed];
  const fails = (L) => {
    const r = massifRegion(grid, seed, L, labels, label, scratch.mark, ++scratch.stamp, scratch.stack, o.edgeMarginCells);
    const [tw, th] = blockTiles(r);
    return r.touchesEdge ? 'touches-source-edge' : Math.max(tw, th) > o.maxTiles ? 'too-large' : null;
  };
  let hi = peakM - o.minReliefM;
  const first = fails(hi);
  if (first) return { ok: false, reason: `no-room-at-min-relief:${first}` };
  let lo = scratch.minM - 1;
  if (!fails(lo)) hi = lo;
  while (hi - lo > o.levelStepM) {
    const mid = Math.floor(((hi + lo) / 2) / o.levelStepM) * o.levelStepM;
    if (mid <= lo || mid >= hi) break;
    if (fails(mid)) lo = mid; else hi = mid;
  }
  const region = massifRegion(grid, seed, hi, labels, label, scratch.mark, ++scratch.stamp, scratch.stack, o.edgeMarginCells);
  return { ok: true, levelM: hi, region, stamp: scratch.stamp, reason: null };
}

/**
 * Base surface over a block: the harmonic (Laplace) surface with B = h on
 * every outline cell, so B and therefore the relief are continuous up to the
 * outline. Solved by successive over-relaxation from an inverse-square-distance
 * first guess over up to `samples` outline points. `inside(k)` tests block
 * cells; `hAt(k)` reads block heights. Returns { B (Float32Array, NaN outside
 * the region), outlineCells, iterations, residualM }.
 */
export function baseSurface(bw, bh, inside, hAt, samples, { tolM = 0.005, maxIterations = 4000, omega = 1.94 } = {}) {
  const outline = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const k = y * bw + x;
    if (!inside(k)) continue;
    if (x === 0 || y === 0 || x === bw - 1 || y === bh - 1
      || !inside(k - 1) || !inside(k + 1) || !inside(k - bw) || !inside(k + bw)) outline.push(k);
  }
  const stride = Math.max(1, Math.ceil(outline.length / samples));
  const px = [], py = [], ph = [];
  for (let n = 0; n < outline.length; n += stride) { const k = outline[n]; px.push(k % bw); py.push(Math.floor(k / bw)); ph.push(hAt(k)); }
  const onOutline = new Uint8Array(bw * bh);
  for (const k of outline) onOutline[k] = 1;
  const B = new Float64Array(bw * bh).fill(NaN);
  const free = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const k = y * bw + x;
    if (!inside(k)) continue;
    if (onOutline[k]) { B[k] = hAt(k); continue; }
    free.push(k);
    let ws = 0, s = 0;
    for (let p = 0; p < px.length; p++) {
      const w = 1 / ((px[p] - x) ** 2 + (py[p] - y) ** 2);
      ws += w; s += w * ph[p];
    }
    B[k] = s / ws;
  }
  // A free cell's four neighbours are all in the region (else it would be
  // on the outline), so the five-point stencil never reads outside it.
  const cells = Int32Array.from(free);
  let iterations = 0, residualM = 0;
  for (; iterations < maxIterations; iterations++) {
    residualM = 0;
    for (let n = 0; n < cells.length; n++) {
      const k = cells[n];
      const target = 0.25 * (B[k - 1] + B[k + 1] + B[k - bw] + B[k + bw]);
      const d = omega * (target - B[k]);
      B[k] += d;
      const a = Math.abs(d);
      if (a > residualM) residualM = a;
    }
    if (residualM < tolM) break;
  }
  return { B: Float32Array.from(B), outlineCells: outline.length, iterations: iterations + 1, residualM };
}

/** Rotate a row-major W x H field a quarter turn mapping +X onto +Z:
 *  (x, z) -> (-z, x). Returns { data, width, height }. Lossless. */
export function quarterTurn(data, W, H) {
  const out = new data.constructor(data.length);
  const nW = H, nH = W;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out[i * nW + (H - 1 - j)] = data[j * W + i];
  return { data: out, width: nW, height: nH };
}

/** Mirror a row-major field across its Z axis (x -> -x). */
export function mirrorX(data, W, H) {
  const out = new data.constructor(data.length);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out[j * W + (W - 1 - i)] = data[j * W + i];
  return out;
}

/** Quarter turns (0..3) that bring direction [dx, dz] closest to +Z, and
 *  the angle left over in degrees (signed). */
export function facingTurns([dx, dz]) {
  let best = 0, bestDot = -Infinity, v = [dx, dz];
  const len = Math.hypot(dx, dz) || 1;
  for (let k = 0; k < 4; k++) {
    const dot = v[1] / len;
    if (dot > bestDot + 1e-12) { bestDot = dot; best = k; }
    v = [-v[1], v[0]];
  }
  v = [dx, dz];
  for (let k = 0; k < best; k++) v = [-v[1], v[0]];
  return { turns: best, residualDeg: Math.round(Math.atan2(v[0], v[1]) * 1800 / Math.PI) / 10 };
}

/**
 * Cut one piece. `seed` from findMassifSeeds, `label` its position in the
 * seed list given to watershedLabels; `viewerM` the source camera's eye
 * [x, z] in the grid's local metres (sets the facing frame).
 * Returns { ok: false, reason } or { ok: true, piece } where piece carries the
 * relief block (Float32Array, (tw*64+1) x (th*64+1) samples, row-major, +Z
 * toward the source viewer) and its measurements.
 */
export function cutMassif(grid, seed, labels, label, { viewerM = null, ...options } = {}, scratch = {}) {
  const o = { ...CUT_DEFAULTS, ...options };
  const lv = chooseLevel(grid, seed.index, labels, label, o, scratch);
  if (!lv.ok) return { ok: false, reason: lv.reason, seed };
  const { width: W, cellSizeM: c, heightsM: h } = grid;
  const reg = lv.region;
  const [tw, th] = blockTiles(reg);
  const bw = tw * TILE_CELLS + 1, bh = th * TILE_CELLS + 1;
  // Centre the region in its block; the zero ring falls out of blockTiles.
  const x0 = reg.minX - Math.floor((bw - (reg.maxX - reg.minX + 1)) / 2);
  const y0 = reg.minY - Math.floor((bh - (reg.maxY - reg.minY + 1)) / 2);
  const gIndex = (k) => { const x = k % bw, y = (k - x) / bw; return (y0 + y) * W + (x0 + x); };
  const inside = (k) => {
    const x = k % bw, y = (k - x) / bw, gx = x0 + x, gy = y0 + y;
    return gx >= 0 && gy >= 0 && gx < W && gy < grid.height && scratch.mark[gy * W + gx] === lv.stamp;
  };
  const { B, outlineCells, iterations: baseIterations, residualM: baseResidualM } = baseSurface(bw, bh, inside, (k) => h[gIndex(k)], o.baseSamples);
  let relief = new Float32Array(bw * bh);
  let peakReliefM = 0, peakK = -1, sum = 0, area = 0, baseSum = 0;
  for (let k = 0; k < bw * bh; k++) {
    if (Number.isNaN(B[k])) continue;
    const r = Math.max(0, h[gIndex(k)] - B[k]);
    relief[k] = r; area++; sum += r; baseSum += B[k];
    if (r > peakReliefM) { peakReliefM = r; peakK = k; }
  }
  if (peakReliefM < o.minReliefM) return { ok: false, reason: 'relief-below-minimum', seed };
  // Outline check before rotation: relief slope on the outline band against
  // the source DEM's slope on the same cells.
  const source = new Float32Array(bw * bh);
  for (let k = 0; k < bw * bh; k++) {
    const x = k % bw, y = (k - x) / bw, gx = x0 + x, gy = y0 + y;
    source[k] = gx >= 0 && gy >= 0 && gx < W && gy < grid.height ? h[gy * W + gx] : 0;
  }
  const outline = outlineSlopes(relief, bw, bh, c, { source });
  const peakGlobal = gIndex(peakK), px = peakGlobal % W, py = (peakGlobal - px) / W;
  const facing = viewerM ? facingTurns([viewerM[0] - (grid.originM[0] + px * c), viewerM[1] - (grid.originM[1] + py * c)]) : { turns: 0, residualDeg: null };
  let width = bw, height = bh;
  for (let k = 0; k < facing.turns; k++) ({ data: relief, width, height } = quarterTurn(relief, width, height));
  return { ok: true, piece: {
    name: seed.name, seedKind: seed.kind, seedHeightM: seed.heightM, levelM: lv.levelM,
    peakM: h[peakGlobal], peakReliefM, baseAtPeakM: B[peakK], meanBaseM: baseSum / area,
    meanReliefM: sum / area, regionCells: reg.count, regionAreaKm2: reg.count * c * c / 1e6, outlineCells,
    base: { method: 'harmonic', iterations: baseIterations, residualM: baseResidualM },
    tiles: facing.turns % 2 ? [th, tw] : [tw, th], width, height, cellSizeM: c, relief,
    sourceBlockOriginM: [grid.originM[0] + x0 * c, grid.originM[1] + y0 * c],
    sourcePeakLocalM: [grid.originM[0] + px * c, grid.originM[1] + py * c],
    quarterTurns: facing.turns, facingResidualDeg: facing.residualDeg, outline,
    // The source DEM is complete around the whole region, so every side is
    // measured terrain: a slot may see a piece from any azimuth.
    coverageFanDeg: [0, 360],
  } };
}

/** Largest |relief| on the outer `ring` cells of a block (must be zero). */
export function borderRelief(relief, W, H, ring = ZERO_RING_CELLS) {
  let max = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (i >= ring && j >= ring && i < W - ring && j < H - ring) continue;
    max = Math.max(max, Math.abs(relief[j * W + i]));
  }
  return max;
}

/** Slope (rise over run) quantiles inside a piece: the band within
 *  `bandCells` of its outline against its interior. With `source` (the
 *  unmodified heights on the same block), also the source slope on the band
 *  cells, so base removal can be shown not to steepen the outline. */
export function outlineSlopes(relief, W, H, cellM, { bandCells = 10, quantiles = [0.5, 0.95], source = null } = {}) {
  const inside = (k) => relief[k] > 0;
  const big = W + H;
  const dist = new Int32Array(W * H);
  for (let k = 0; k < W * H; k++) dist[k] = inside(k) ? big : 0;
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    for (let jj = 1; jj < H - 1; jj++) for (let ii = 1; ii < W - 1; ii++) {
      const j = fwd ? jj : H - 1 - jj, i = fwd ? ii : W - 1 - ii, k = j * W + i, d = fwd ? 1 : -1;
      if (!dist[k]) continue;
      dist[k] = Math.min(dist[k], dist[k - d * W] + 1, dist[k - d] + 1, dist[k - d * W - d] + 1, dist[k - d * W + d] + 1);
    }
  }
  const band = [], core = [], bandSource = [];
  const slope = (f, k) => Math.hypot(f[k + 1] - f[k - 1], f[k + W] - f[k - W]) / (2 * cellM);
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = j * W + i;
    if (!inside(k)) continue;
    if (dist[k] <= bandCells) { band.push(slope(relief, k)); if (source) bandSource.push(slope(source, k)); }
    else core.push(slope(relief, k));
  }
  const q = (v) => { const a = Float64Array.from(v).sort(); return quantiles.map((p) => (a.length ? +a[Math.floor(p * (a.length - 1))].toFixed(4) : 0)); };
  return { band: q(band), core: q(core), ...(source ? { bandSource: q(bandSource) } : {}), bandSamples: band.length, coreSamples: core.length };
}
