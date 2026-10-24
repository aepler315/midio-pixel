// Scenic shot tours (docs/scenic-tours.md): what a view's shots are about.
// discoverSubjects() merges the subjects a region names (config, authored
// landmarks, the rail's own target) with landforms measured from the DEM:
//   peaks    topographic prominence by union-find on a ~70 m max grid
//   buttes   steep-walled tables standing above a fairly uniform floor
//            (height above the 1-3 km ring, flank slope, enclosure; never
//            an absolute elevation)
//   ridges   high crest lines joining neighbouring peaks
//   lakes    hydro-flattened water components (>= 20 ha)
//   valleys  D8 channels draining >= ~5 km2 with walls on both sides
// Each subject gets a grandeur (0..1) from prominence, local relief,
// isolation and size; config, landmark and rail subjects are always kept,
// DEM features inside the tour's focus area fill the rest by grandeur under
// a minimum spacing.
//
// Local frame: metres, X east, Y up, Z south (tools/lib/scenic-terrain.mjs).
import { heightAt, lonLatToLocal, slopeDegAt } from './scenic-terrain.mjs';
import { fillDepressions } from './terrain-bake.mjs';
import { SUBJECT_KINDS } from '../../src/world/terrain/ShotLibrary.js';
import { LANDFORMS } from './scenic-shots.mjs';

const DEG = Math.PI / 180;
// Point landforms: they keep minSubjectSpacingM between each other (the
// rail target is an aim point, not a landform, and blocks nothing), and a
// config subject of these kinds stands at its own point; any other config
// kind takes the geometry of a DEM feature of that kind.
const POINT_KINDS = new Set(['landmark', 'peak', 'butte']);
const LAKE_MIN_M2 = 20e4;
const sat = (v, s) => 1 - Math.exp(-Math.max(0, v) / s);
const round1 = (v) => Math.round(v * 10) / 10;
const quantile = (arr, q) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))] : NaN;
};
/** Stable id from kind + position: 'butte-w6010-s6530' (10 m units). */
const posId = (kind, x, z) => `${kind}-${x < 0 ? 'w' : 'e'}${Math.abs(Math.round(x / 10) * 10)}-${z < 0 ? 'n' : 's'}${Math.abs(Math.round(z / 10) * 10)}`;
const slug = (name) => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Shortest distance between two 2D segments [[x,z],[x,z]]. */
function segmentDistance([a, b], [c, d]) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  const toSeg = (p, [s, e]) => {
    const dx = e[0] - s[0], dz = e[1] - s[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dz) / l2)) : 0;
    return Math.hypot(p[0] - s[0] - t * dx, p[1] - s[1] - t * dz);
  };
  return Math.min(toSeg(a, [c, d]), toSeg(b, [c, d]), toSeg(c, [a, b]), toSeg(d, [a, b]));
}
const sameName = (a, b) => a.normalize('NFC').toLowerCase().trim() === b.normalize('NFC').toLowerCase().trim();

/** How grand a feature reads (0..1): prominence, local relief, isolation,
 *  size. Summits use their own; a ridge's prominence is its lower end's and
 *  its isolation its length; a lake's prominence is half the rim above the
 *  water and its isolation sqrt(area); a valley's prominence half its wall
 *  height and its isolation its length (corridors and water frame a shot
 *  less than a summit does), so every kind can compete. */
function grandeurOf({ prominenceM = 0, reliefM = 0, isolationM = 0, sizeM = 0 }) {
  return Math.round((0.35 * sat(prominenceM, 400) + 0.3 * sat(reliefM, 800) + 0.2 * sat(isolationM, 4000) + 0.15 * sat(sizeM, 1500)) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Shared per-context analysis (cached: the grid must not change afterwards).

const analyses = new WeakMap();
function analysis(ctx) {
  let a = analyses.get(ctx);
  if (!a) { a = { ds: downsample(ctx.grid) }; analyses.set(ctx, a); }
  return a;
}

/** ~70 m blocks: max height (and the base sample holding it) for summits,
 *  mean height for drainage. */
function downsample(grid) {
  const { width: w, height: hgt, cellSizeM: cs, heightsM: h, valid } = grid;
  const f = Math.max(1, Math.round(70 / cs)), W = Math.ceil(w / f), H = Math.ceil(hgt / f);
  const hi = new Float32Array(W * H).fill(-Infinity), arg = new Int32Array(W * H).fill(-1), mean = new Float32Array(W * H).fill(NaN);
  const ok = new Uint8Array(W * H);
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    let sum = 0, n = 0;
    for (let r = J * f; r < Math.min(hgt, J * f + f); r++) for (let c = I * f; c < Math.min(w, I * f + f); c++) {
      const i = r * w + c;
      if ((valid && !valid[i]) || !Number.isFinite(h[i])) continue;
      sum += h[i]; n++;
      if (h[i] > hi[J * W + I]) { hi[J * W + I] = h[i]; arg[J * W + I] = i; }
    }
    if (n) { ok[J * W + I] = 1; mean[J * W + I] = sum / n; }
  }
  return { f, W, H, cellM: f * cs, hi, arg, mean, ok };
}

const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Local maxima of the max grid with their topographic prominence
 *  (union-find, highest first; a component's peak is retired at the col
 *  where it joins a higher one). Ties break by cell index. */
function prominencePeaks(ctx) {
  const a = analysis(ctx);
  if (a.peaks) return a.peaks;
  const { W, H, hi, ok, arg } = a.ds, g = ctx.grid;
  const n = W * H, order = [];
  let lowest = Infinity;
  for (let i = 0; i < n; i++) if (ok[i]) { order.push(i); lowest = Math.min(lowest, hi[i]); }
  order.sort((p, q) => hi[q] - hi[p] || p - q);
  const parent = new Int32Array(n).fill(-1), peakOf = new Int32Array(n).fill(-1);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const peaks = [];
  const record = (p, col) => {
    const i = arg[p], c = i % g.width, r = (i - c) / g.width;
    peaks.push({ cell: p, x: g.originM[0] + c * g.cellSizeM, z: g.originM[1] + r * g.cellSizeM, top: hi[p], prominenceM: hi[p] - col });
  };
  for (const i of order) {
    const I = i % W, J = (i - I) / W, roots = [];
    for (const [dx, dz] of NB8) {
      const x = I + dx, z = J + dz;
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const j = z * W + x;
      if (parent[j] < 0) continue;
      const r = find(j);
      if (!roots.includes(r)) roots.push(r);
    }
    if (!roots.length) { parent[i] = i; peakOf[i] = i; continue; }
    roots.sort((p, q) => hi[peakOf[q]] - hi[peakOf[p]] || peakOf[p] - peakOf[q]);
    const main = roots[0];
    parent[i] = main;
    for (const r of roots.slice(1)) { record(peakOf[r], hi[i]); parent[r] = main; }
  }
  // The highest peak of each remaining component (the summit of the grid).
  for (let i = 0; i < n; i++) if (parent[i] === i) record(peakOf[i], lowest);
  a.peaks = peaks.filter((p) => p.prominenceM >= 10).sort((p, q) => q.prominenceM - p.prominenceM || p.cell - q.cell);
  return a.peaks;
}

/** Shape of the terrain around a summit at (x, z):
 *   top, base (lower quartile of the 1-3 km rings), heightM = top - base,
 *   spreadM (ring p75 - p25), flankDeg (mean slope between 80% and 20% of
 *   the height along 16 radials), enclosure (fraction of radials that drop
 *   to 20% within 3 km), floorSlopeDeg (median ground slope on the 1.5 and
 *   2.5 km rings), radiusM (median distance down to half height), reliefM
 *   (top - lowest within 3 km), isolationM (to higher ground). */
function measure(ctx, x, z, top = heightAt(ctx.grid, x, z)) {
  const g = ctx.grid, ring = [];
  for (const r of [1000, 1500, 2000, 2500, 3000]) {
    for (let k = 0; k < 32; k++) ring.push(heightAt(g, x + r * Math.sin((k / 32) * 2 * Math.PI), z - r * Math.cos((k / 32) * 2 * Math.PI)));
  }
  const base = quantile(ring, 0.25);
  // Over no-data or off the grid there is nothing to measure: finite zeros,
  // so a subject placed there never carries NaN.
  if (!Number.isFinite(top) || !Number.isFinite(base)) {
    return { top, base: top, heightM: 0, spreadM: 0, flankDeg: 0, enclosure: 0, floorSlopeDeg: 0, radiusM: 150, reliefM: 0, isolationM: 0 };
  }
  const spreadM = quantile(ring, 0.75) - base, heightM = Math.max(0, top - base);
  let low = Math.min(top, quantile(ring, 0));
  const step = g.cellSizeM, flanks = [], halves = [];
  let enclosed = 0;
  for (let k = 0; k < 16; k++) {
    const sx = Math.sin((k / 16) * 2 * Math.PI), sz = -Math.cos((k / 16) * 2 * Math.PI);
    let d80 = NaN, d20 = NaN, d50 = NaN;
    for (let d = step; d <= 3000; d += step) {
      const y = heightAt(g, x + sx * d, z + sz * d);
      if (!Number.isFinite(y)) break;
      low = Math.min(low, y);
      if (!(d80 >= 0) && y < top - 0.2 * heightM) d80 = d;
      if (!(d50 >= 0) && y < top - 0.5 * heightM) d50 = d;
      if (y < top - 0.8 * heightM) { d20 = d; break; }
    }
    if (d20 >= 0) { enclosed++; flanks.push(Math.atan((0.6 * heightM) / Math.max(step, d20 - d80)) / DEG); }
    halves.push(d50 >= 0 ? d50 : 3000);
  }
  const flankDeg = flanks.length ? flanks.reduce((s, v) => s + v, 0) / flanks.length : 0;
  const floors = [];
  for (const r of [1500, 2500]) for (let k = 0; k < 32; k++) floors.push(slopeDegAt(g, x + r * Math.sin((k / 32) * 2 * Math.PI), z - r * Math.cos((k / 32) * 2 * Math.PI)));
  return { top, base, heightM, spreadM, flankDeg, enclosure: enclosed / 16, floorSlopeDeg: quantile(floors, 0.5),
    radiusM: Math.min(3000, Math.max(150, quantile(halves, 0.5))), reliefM: top - low, isolationM: isolation(ctx, x, z, top) };
}

/** Distance (m) to the nearest max-grid cell higher than `top` (<= 15 km,
 *  <= the distance to the grid edge). */
function isolation(ctx, x, z, top) {
  const { W, H, hi, cellM } = analysis(ctx).ds, g = ctx.grid;
  const ox = g.originM[0] - g.cellSizeM / 2, oz = g.originM[1] - g.cellSizeM / 2;
  const I = Math.floor((x - ox) / cellM), J = Math.floor((z - oz) / cellM), R = Math.ceil(15000 / cellM);
  // Beyond the grid edge is unknown: isolation cannot exceed the distance to it.
  let best = Math.max(0, Math.min(15000, x - g.originM[0], z - g.originM[1],
    g.originM[0] + (g.width - 1) * g.cellSizeM - x, g.originM[1] + (g.height - 1) * g.cellSizeM - z));
  for (let ring = 1; ring <= R && ring * cellM - cellM < best; ring++) {
    for (let dz = -ring; dz <= ring; dz++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
      const i = I + dx, j = J + dz;
      if (i < 0 || j < 0 || i >= W || j >= H || !(hi[j * W + i] > top + 1)) continue;
      best = Math.min(best, Math.hypot(dx, dz) * cellM);
    }
  }
  return best;
}

/** Peak and butte candidates: prominent local maxima, measured and
 *  classified. Buttes and mesas stand >= 80 m above their 1-3 km ring with
 *  steep walls (mean flank >= 30 deg) on nearly every side (enclosure
 *  >= 0.75) over a gentle, fairly uniform floor (ring median slope <= 12
 *  deg, ring spread <= half the height): steep alpine summits fail the
 *  floor tests (their rings cross 25-35 deg canyon walls). Other summits
 *  with prominence >= prominenceMinM are peaks. */
export const BUTTE = Object.freeze({ minHeightM: 80, minFlankDeg: 30, minEnclosure: 0.75, maxFloorSlopeDeg: 12, maxSpread: 0.5 });
const isButte = (m) => m.heightM >= BUTTE.minHeightM && m.flankDeg >= BUTTE.minFlankDeg && m.enclosure >= BUTTE.minEnclosure
  && m.floorSlopeDeg <= BUTTE.maxFloorSlopeDeg && m.spreadM <= BUTTE.maxSpread * m.heightM;
function summitFeatures(ctx, prominenceMinM) {
  const a = analysis(ctx);
  if (a.summits?.prominenceMinM === prominenceMinM) return a.summits.list;
  const list = [];
  for (const p of prominencePeaks(ctx)) {
    if (p.prominenceM < Math.min(30, prominenceMinM)) continue;
    const m = measure(ctx, p.x, p.z, p.top);
    const butte = isButte(m);
    if (!butte && p.prominenceM < prominenceMinM) continue;
    const kind = butte ? 'butte' : 'peak';
    list.push({
      id: posId(kind, p.x, p.z), kind, name: null, posM: [p.x, p.top, p.z], radiusM: round1(m.radiusM), heightM: round1(m.heightM),
      prominenceM: round1(p.prominenceM), source: 'dem', measure: m,
      grandeur: grandeurOf({ prominenceM: p.prominenceM, reliefM: m.reliefM, isolationM: m.isolationM, sizeM: m.radiusM }),
    });
  }
  a.summits = { prominenceMinM, list };
  return list;
}

/** Crest lines between neighbouring peaks: the straight line between them
 *  stays high (>= 70% of the lower summit's height above the floor) and
 *  falls away on both sides along its length. One per peak (its nearest
 *  partner 1.5-8 km away). */
function ridgeFeatures(ctx, peaks) {
  const g = ctx.grid, out = [], seen = new Set();
  for (const P of peaks) {
    const partners = peaks.filter((Q) => Q !== P).map((Q) => [Q, Math.hypot(Q.posM[0] - P.posM[0], Q.posM[2] - P.posM[2])])
      .filter(([, d]) => d >= 1500 && d <= 8000).sort((u, v) => u[1] - v[1] || (u[0].id < v[0].id ? -1 : 1));
    for (const [Q, len] of partners) {
      const key = [P.id, Q.id].sort().join('|');
      if (seen.has(key)) break;
      const base = Math.min(P.measure.base, Q.measure.base), lowTop = Math.min(P.posM[1], Q.posM[1]);
      const ux = (Q.posM[0] - P.posM[0]) / len, uz = (Q.posM[2] - P.posM[2]) / len;
      let minY = Infinity, sum = 0, n = 0, crest = true;
      for (let d = 0; d <= len; d += 2 * g.cellSizeM) {
        const y = heightAt(g, P.posM[0] + ux * d, P.posM[2] + uz * d);
        if (!Number.isFinite(y)) { crest = false; break; }
        minY = Math.min(minY, y); sum += y; n++;
      }
      if (!crest || minY < base + 0.7 * (lowTop - base)) continue;
      for (const f of [0.25, 0.5, 0.75]) {
        const cx = P.posM[0] + ux * len * f, cz = P.posM[2] + uz * len * f, y = heightAt(g, cx, cz);
        const drop = 0.1 * (y - base);
        for (const side of [-1, 1]) if (!(heightAt(g, cx - uz * 500 * side, cz + ux * 500 * side) < y - drop)) crest = false;
      }
      if (!crest) continue;
      seen.add(key);
      const mx = (P.posM[0] + Q.posM[0]) / 2, mz = (P.posM[2] + Q.posM[2]) / 2, heightM = sum / n - base;
      const prominenceM = Math.min(P.prominenceM, Q.prominenceM);
      out.push({
        id: posId('ridge', mx, mz), kind: 'ridge', name: null, posM: [mx, heightAt(g, mx, mz), mz], radiusM: round1(len / 2),
        heightM: round1(heightM), prominenceM, source: 'dem',
        axisM: [[P.posM[0], P.posM[2]], [Q.posM[0], Q.posM[2]]],
        grandeur: grandeurOf({ prominenceM, reliefM: heightM, isolationM: len, sizeM: len / 2 }),
      });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lakes and shorelines.

/** Water components >= 20 ha with their outer shoreline (pixel-edge loop). */
function lakeFeatures(ctx) {
  const a = analysis(ctx);
  if (a.lakes) return a.lakes;
  const g = ctx.grid, { width: w, height: hgt, cellSizeM: cs, originM } = g, water = ctx.water;
  const label = new Int32Array(w * hgt).fill(-1), lakes = [];
  if (!water) return (a.lakes = lakes);
  const stack = [];
  for (let s = 0; s < w * hgt; s++) {
    if (!water[s] || label[s] >= 0) continue;
    const id = lakes.length, cells = [];
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), c = i % w, r = (i - c) / w;
      cells.push(i);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc, rr = r + dr, j = rr * w + cc;
        if (cc < 0 || rr < 0 || cc >= w || rr >= hgt || !water[j] || label[j] >= 0) continue;
        label[j] = id; stack.push(j);
      }
    }
    lakes.push({ cells });
  }
  a.lakeLabel = label;
  const out = [];
  for (const [id, { cells }] of lakes.entries()) {
    const areaM2 = cells.length * cs * cs;
    if (areaM2 < LAKE_MIN_M2) continue;
    let sx = 0, sz = 0;
    const ys = [];
    for (const i of cells) { const c = i % w, r = (i - c) / w; sx += c; sz += r; if (ys.length < 4000) ys.push(g.heightsM[i]); }
    const mc = sx / cells.length, mr = sz / cells.length;
    let cxx = 0, cxz = 0, czz = 0;
    for (const i of cells) { const c = i % w - mc, r = (i - (i % w)) / w - mr; cxx += c * c; cxz += c * r; czz += r * r; }
    const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz), ax = Math.cos(ang), az = Math.sin(ang);
    let lo = Infinity, hi = -Infinity, best = -1, bestD = Infinity;
    for (const i of cells) {
      const c = i % w, r = (i - c) / w, t = (c - mc) * ax + (r - mr) * az;
      lo = Math.min(lo, t); hi = Math.max(hi, t);
      const d = (c - mc) ** 2 + (r - mr) ** 2;
      if (d < bestD || (d === bestD && i < best)) { bestD = d; best = i; }
    }
    const level = quantile(ys, 0.5), bc = best % w, br = (best - bc) / w;
    const px = originM[0] + bc * cs, pz = originM[1] + br * cs;
    const toLocal = (t) => [originM[0] + (mc + ax * t) * cs, originM[1] + (mr + az * t) * cs];
    const loop = outerLoop(cells, label, id, w, hgt).map(([c, r]) => [originM[0] + (c - 0.5) * cs, originM[1] + (r - 0.5) * cs]);
    const radiusM = Math.max(Math.sqrt(areaM2 / Math.PI), ((hi - lo) * cs) / 2);
    const rim = [];
    for (const [x, z] of resample(loop, 200, true)) for (const r of [1000, 2500]) {
      // Outward from the lake centre: the walls above the shore.
      const dx = x - px, dz = z - pz, l = Math.hypot(dx, dz) || 1;
      rim.push(heightAt(g, x + (dx / l) * r, z + (dz / l) * r));
    }
    const reliefM = Math.max(0, quantile(rim, 0.9) - level);
    out.push({
      id: posId('lake', px, pz), kind: 'lake', name: null, posM: [px, level, pz], radiusM: round1(radiusM), heightM: round1(reliefM),
      prominenceM: 0, source: 'dem', areaM2, label: id, axisM: [toLocal(lo), toLocal(hi)].map(([x, z]) => [round1(x), round1(z)]),
      polygonM: simplify(loop, cs).map(([x, z]) => [round1(x), round1(z)]), shoreM: loop,
      grandeur: grandeurOf({ prominenceM: reliefM / 2, reliefM, isolationM: Math.sqrt(areaM2), sizeM: Math.sqrt(areaM2) / 2 }),
    });
  }
  return (a.lakes = out);
}

/** The outer boundary of a 4-connected pixel component as corner points
 *  (pixel (c, r) spans corners c..c+1, r..r+1): boundary edges traced
 *  clockwise, linked into loops, the loop with the largest area kept. */
function outerLoop(cells, label, id, w, hgt) {
  const inside = (c, r) => c >= 0 && r >= 0 && c < w && r < hgt && label[r * w + c] === id;
  const W1 = w + 1, next = new Map();
  const add = (c0, r0, c1, r1) => {
    const k = r0 * W1 + c0, list = next.get(k);
    if (list) list.push(r1 * W1 + c1); else next.set(k, [r1 * W1 + c1]);
  };
  for (const i of cells) {
    const c = i % w, r = (i - c) / w;
    if (!inside(c, r - 1)) add(c, r, c + 1, r);
    if (!inside(c + 1, r)) add(c + 1, r, c + 1, r + 1);
    if (!inside(c, r + 1)) add(c + 1, r + 1, c, r + 1);
    if (!inside(c - 1, r)) add(c, r + 1, c, r);
  }
  let best = [], bestArea = -Infinity;
  for (const start of [...next.keys()].sort((p, q) => p - q)) {
    while (next.get(start)?.length) {
      const loop = [start];
      let cur = next.get(start).pop();
      while (cur !== start) {
        loop.push(cur);
        const list = next.get(cur);
        if (!list?.length) break;
        cur = list.pop();
      }
      let area = 0;
      for (let k = 0; k < loop.length; k++) {
        const p = loop[k], q = loop[(k + 1) % loop.length];
        area += (p % W1) * Math.floor(q / W1) - (q % W1) * Math.floor(p / W1);
      }
      if (Math.abs(area) > bestArea) { bestArea = Math.abs(area); best = loop; }
    }
  }
  return best.map((k) => [k % W1, Math.floor(k / W1)]);
}

/** Douglas-Peucker simplification of a closed loop to `tol` metres. */
function simplify(loop, tol) {
  if (loop.length < 4) return loop.slice();
  const keep = new Uint8Array(loop.length);
  const dp = (i, j) => {
    let worst = -1, at = -1;
    const [ax, az] = loop[i], [bx, bz] = loop[j], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((loop[k][0] - ax) * dz - (loop[k][1] - az) * dx) / l;
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > tol) { keep[at] = 1; dp(i, at); dp(at, j); }
  };
  const mid = Math.floor(loop.length / 2);
  keep[0] = keep[mid] = 1;
  dp(0, mid); dp(mid, loop.length - 1);
  // Close: the segment from the last point back to the first.
  keep[loop.length - 1] = 1;
  return loop.filter((_, k) => keep[k]);
}

/** Points every `step` metres along a polyline (closed: back to the start). */
function resample(points, step, closed = false) {
  const pts = closed ? [...points, points[0]] : points;
  if (pts.length < 2) return pts.map((p) => [...p]);
  const out = [[...pts[0]]];
  let carry = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k], l = Math.hypot(bx - ax, bz - az);
    let d = step - carry;
    while (d <= l) { out.push([ax + ((bx - ax) * d) / l, az + ((bz - az) * d) / l]); d += step; }
    carry = l - (d - step);
  }
  if (closed) { if (out.length > 1 && Math.hypot(out.at(-1)[0] - pts[0][0], out.at(-1)[1] - pts[0][1]) < step / 2) out.pop(); }
  else if (Math.hypot(out.at(-1)[0] - pts.at(-1)[0], out.at(-1)[1] - pts.at(-1)[1]) > 1e-6) out.push([...pts.at(-1)]);
  return out;
}

/** Moving average of a polyline's xz over +-k points (ends kept; a closed
 *  loop wraps). */
function smooth(points, k, closed = false) {
  const n = points.length;
  return points.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return [...p];
    let sx = 0, sz = 0, m = 0;
    for (let d = -k; d <= k; d++) {
      let j = i + d;
      if (closed) j = ((j % n) + n) % n; else if (j < 0 || j >= n) continue;
      sx += points[j][0]; sz += points[j][1]; m++;
    }
    return [sx / m, sz / m];
  });
}

/**
 * Closed shoreline polylines of the lake subjects ([{id, lakeId, points:
 * [[x,y,z]...]}], resampled every 100 m and lightly smoothed, y = lake
 * level); lakeId is the lake subject's id. `subjects` defaults to the last
 * discoverSubjects(ctx, ...) result for this ctx.
 */
export function shorelines(ctx, subjects = analyses.get(ctx)?.subjects) {
  if (!subjects) throw new Error(`${ctx.viewId}: shorelines() needs the view's subjects (pass them, or run discoverSubjects first)`);
  const out = [];
  for (const lake of lakeFeatures(ctx)) {
    const subject = subjects.find((s) => s.kind === 'lake' && (s.featureId || s.id) === lake.id);
    if (!subject) continue;
    // Pixel stairs simplified away first, so spacing is along the true shore.
    const pts = smooth(resample(simplify(lake.shoreM, ctx.grid.cellSizeM), 100, true), 1, true);
    out.push({ id: `shore-${subject.id}`, lakeId: subject.id, points: pts.map(([x, z]) => [round1(x), round1(lake.posM[1]), round1(z)]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Valleys.

/** D8 drainage on the ~70 m mean grid (depression-filled): receiver and
 *  drainage area (m2) per cell. */
function drainage(ctx) {
  const a = analysis(ctx);
  if (a.drainage) return a.drainage;
  const { W, H, mean, ok, cellM } = a.ds, n = W * H;
  const filled = fillDepressions(mean, ok, W, H);
  const recv = new Int32Array(n).fill(-1), area = new Float64Array(n);
  const order = [];
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    order.push(i);
    const I = i % W, J = (i - I) / W;
    let drop = 0;
    for (const [dx, dz] of NB8) {
      const x = I + dx, z = J + dz;
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const j = z * W + x;
      if (!ok[j]) continue;
      const d = (filled[i] - filled[j]) / (dx && dz ? Math.SQRT2 : 1);
      if (d > drop) { drop = d; recv[i] = j; }
    }
  }
  order.sort((p, q) => filled[q] - filled[p] || p - q);
  for (const i of order) { area[i] += cellM * cellM; if (recv[i] >= 0) area[recv[i]] += area[i]; }
  return (a.drainage = { recv, area });
}

/**
 * Valley floor polylines: D8 channels draining >= minAreaM2 (m2), traced
 * from each outlet up the main stem (largest tributary), every other
 * tributary as its own path starting at its junction; paths shorter than
 * minLengthM are dropped. Points run mouth -> head, every 100 m, smoothed
 * over +-200 m, y = DEM height. Returns [{id, areaM2 (at the mouth), points}].
 */
export function valleyPaths(ctx, { minAreaM2 = 5e6, minLengthM = 3000 } = {}) {
  const a = analysis(ctx), key = `${minAreaM2}|${minLengthM}`;
  if (a.valleys?.key === key) return a.valleys.list;
  const { W, H, f, cellM } = a.ds, { recv, area } = drainage(ctx), g = ctx.grid;
  const donors = new Map();
  for (let i = 0; i < W * H; i++) {
    if (!(area[i] >= minAreaM2) || recv[i] < 0) continue;
    const list = donors.get(recv[i]);
    if (list) list.push(i); else donors.set(recv[i], [i]);
  }
  for (const list of donors.values()) list.sort((p, q) => area[q] - area[p] || p - q);
  const centre = (i) => {
    const I = i % W, J = (i - I) / W;
    return [g.originM[0] + Math.min(g.width - 1, I * f + (f - 1) / 2) * g.cellSizeM, g.originM[1] + Math.min(g.height - 1, J * f + (f - 1) / 2) * g.cellSizeM];
  };
  const starts = [];
  for (let i = 0; i < W * H; i++) if (area[i] >= minAreaM2 && recv[i] < 0) starts.push([i, -1]);
  const list = [];
  while (starts.length) {
    const [s, junction] = starts.shift(), cells = junction >= 0 ? [junction, s] : [s];
    let cur = s;
    for (;;) {
      const up = donors.get(cur);
      if (!up?.length) break;
      for (const t of up.slice(1)) starts.push([t, cur]);
      cur = up[0];
      cells.push(cur);
    }
    const raw = cells.map(centre);
    let len = 0;
    for (let k = 1; k < raw.length; k++) len += Math.hypot(raw[k][0] - raw[k - 1][0], raw[k][1] - raw[k - 1][1]);
    if (len < minLengthM || len < 2 * cellM) continue;
    const pts = resample(smooth(resample(raw, 100), 2), 100)
      .map(([x, z]) => [round1(x), round1(heightAt(g, x, z)), round1(z)]).filter((p) => Number.isFinite(p[1]));
    if (pts.length < 2) continue;
    const [ox, oz] = centre(s);
    list.push({ id: posId('valley', ox, oz), areaM2: Math.round(area[s]), points: pts });
  }
  list.sort((p, q) => q.areaM2 - p.areaM2 || (p.id < q.id ? -1 : 1));
  a.valleys = { key, list };
  return list;
}

/** Valley subjects: <= 6 km stretches of the valley paths inside the
 *  margin whose floor has walls >= 150 m on both sides within 4 km
 *  (median along the stretch; glacial valleys are wide). */
function valleyFeatures(ctx, inside) {
  const g = ctx.grid, out = [];
  for (const path of valleyPaths(ctx)) {
    // Runs of points inside the margin, cut into ~5 km stretches.
    const runs = [];
    let run = [];
    for (const p of path.points) { if (inside(p[0], p[2])) run.push(p); else if (run.length) { runs.push(run); run = []; } }
    if (run.length) runs.push(run);
    for (const r of runs) {
      for (let s = 0; s + 20 < r.length; s += 50) {
        const piece = r.slice(s, Math.min(r.length, s + 61));
        if (piece.length < 21) continue;
        const walls = [];
        for (let k = 0; k < piece.length; k += 5) {
          const p = piece[k], q = piece[Math.min(piece.length - 1, k + 1)], o = piece[Math.max(0, k - 1)];
          const tx = q[0] - o[0], tz = q[2] - o[2], l = Math.hypot(tx, tz) || 1, nx = -tz / l, nz = tx / l;
          const side = (sgn) => {
            let m = -Infinity;
            for (let d = 300; d <= 4000; d += 100) m = Math.max(m, heightAt(g, p[0] + nx * d * sgn, p[2] + nz * d * sgn));
            return m;
          };
          walls.push(Math.min(side(1), side(-1)) - p[1]);
        }
        const heightM = quantile(walls, 0.5);
        if (!(heightM >= 150)) continue;
        const mid = piece[Math.floor(piece.length / 2)], lenM = (piece.length - 1) * 100;
        out.push({
          id: posId('valley', mid[0], mid[2]), kind: 'valley', name: null, posM: [...mid], radiusM: lenM / 2, heightM: round1(heightM),
          prominenceM: 0, source: 'dem', pathId: path.id, axisM: [[piece[0][0], piece[0][2]], [piece.at(-1)[0], piece.at(-1)[2]]], floorM: piece,
          grandeur: grandeurOf({ prominenceM: heightM / 2, reliefM: heightM, isolationM: lenM, sizeM: Math.sqrt(path.areaM2) / 4 }),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subjects.

/**
 * A view's subjects:
 *   [{id, kind, name, posM:[x,y,z], radiusM, heightM, prominenceM, grandeur,
 *     source: 'config'|'landmark'|'rail'|'dem', weight?, featureId?,
 *     axisM?: [[x,z],[x,z]], polygonM?: [[x,z]...]}]
 * regionConfig is the view's entry in data/terrain/scenic-tours.json
 * regions (or null); defaults its `defaults` (discovery, clearance), with
 * regionConfig.overrides.{discovery,clearance} applied on top.
 *
 * The rail target, landmarks and config subjects come first and are always
 * kept (landmarks and config subjects unless within the boundary margin;
 * exclusions are logged). A config subject names an authored landmark or
 * gives a lonLat. Peaks and buttes stand at their summit within 200 m of
 * that point; approximate ones snap to the NEAREST DEM feature of their
 * kind within snapRadiusM (the region file's rule: "strongest" put the
 * Monument Valley hero on a butte 2.9 km off its point). Lakes, valleys
 * and ridges always take the nearest DEM feature's geometry (axisM,
 * polygonM); with none within snapRadiusM they are kept as landmarks.
 *
 * DEM features then fill up to maxSubjects by grandeur, only within the
 * tour's focus area (mirroring build-scenic-tours focusArea: centred on the
 * rail target and the region's heroes, region.focusRadiusM ?? the
 * landform's focusM ?? discovery.focusRadiusM; no focus when none is
 * given) and at least minSubjectSpacingM from any kept point landform
 * (peaks, buttes, landmarks) or, for ridges, lakes and valleys, from a kept
 * subject of the same kind. The result is remembered for shorelines(ctx).
 */
export function discoverSubjects(ctx, regionConfig = null, defaults = {}, { log = console.warn } = {}) {
  const disc = { maxSubjects: 12, minSubjectSpacingM: 1800, prominenceMinM: 80, snapRadiusM: 2500, ...defaults.discovery, ...regionConfig?.overrides?.discovery };
  const marginM = { boundaryMarginM: 1500, ...defaults.clearance, ...regionConfig?.overrides?.clearance }.boundaryMarginM;
  const g = ctx.grid, x0 = g.originM[0], z0 = g.originM[1], x1 = x0 + (g.width - 1) * g.cellSizeM, z1 = z0 + (g.height - 1) * g.cellSizeM;
  const inside = (x, z) => x >= x0 + marginM && x <= x1 - marginM && z >= z0 + marginM && z <= z1 - marginM;
  const note = (msg) => log(`${ctx.viewId}: ${msg}`);
  const summits = summitFeatures(ctx, disc.prominenceMinM).filter((s) => inside(s.posM[0], s.posM[2]));
  const peaks = summits.filter((s) => s.kind === 'peak');
  const features = [...summits, ...ridgeFeatures(ctx, peaks), ...lakeFeatures(ctx), ...valleyFeatures(ctx, inside)]
    .filter((s) => inside(s.posM[0], s.posM[2]));
  const used = new Set();
  const peaksAll = prominencePeaks(ctx);
  // Prominence of the highest local maximum within 400 m of a named point
  // (its summit, not a nearer shoulder).
  const prominenceNear = (x, z) => {
    let best = null;
    for (const p of peaksAll) if (Math.hypot(p.x - x, p.z - z) <= 400 && (!best || p.top > best.top)) best = p;
    return best ? best.prominenceM : 0;
  };
  // Highest DEM point within 200 m of an authored point (null over no-data).
  const summitNear = (x, z) => {
    let best = null;
    for (let dz = -200; dz <= 200; dz += g.cellSizeM) for (let dx = -200; dx <= 200; dx += g.cellSizeM) {
      if (dx * dx + dz * dz > 200 * 200) continue;
      const y = heightAt(g, x + dx, z + dz);
      if (y > (best ? best[1] : -Infinity)) best = [x + dx, y, z + dz];
    }
    return best;
  };
  // A subject at an authored point (y0: the authored height, used where the
  // DEM has none); null when there is no height at all.
  const named = (kind, name, source, x, z, y0, extra = {}) => {
    let pos = kind === 'peak' || kind === 'butte' ? summitNear(x, z) : [x, heightAt(g, x, z), z];
    if (!Number.isFinite(pos?.[1])) pos = Number.isFinite(y0) ? [x, y0, z] : null;
    if (!pos) return null;
    const m = measure(ctx, pos[0], pos[2], pos[1]);
    const prominenceM = round1(prominenceNear(pos[0], pos[2]));
    return {
      id: slug(name), kind, name, posM: pos.map(round1), radiusM: round1(m.radiusM), heightM: round1(m.heightM), prominenceM,
      grandeur: grandeurOf({ prominenceM, reliefM: m.reliefM, isolationM: m.isolationM, sizeM: m.radiusM }), source, ...extra,
    };
  };
  // Distance from a point to a feature (lakes: to the water; valleys: to
  // the floor; ridges: to the crest line).
  const distanceTo = (f, x, z) => {
    if (f.kind === 'lake') {
      const fx = Math.round((x - x0) / g.cellSizeM), fz = Math.round((z - z0) / g.cellSizeM);
      const label = analysis(ctx).lakeLabel;
      if (label && fx >= 0 && fz >= 0 && fx < g.width && fz < g.height && label[fz * g.width + fx] === f.label) return 0;
      let d = Infinity;
      for (const [px, pz] of f.shoreM) d = Math.min(d, Math.hypot(px - x, pz - z));
      return d;
    }
    if (f.floorM) return Math.min(...f.floorM.map((p) => Math.hypot(p[0] - x, p[2] - z)));
    if (f.kind === 'ridge') return segmentDistance(f.axisM, [[x, z], [x, z]]);
    return Math.hypot(f.posM[0] - x, f.posM[2] - z);
  };
  // The nearest unused DEM feature of a kind within `radius` (ties: grander first).
  const snap = (kind, x, z, radius) => {
    let best = null, bestD = Infinity;
    for (const f of features) {
      if (f.kind !== kind || used.has(f.id)) continue;
      const d = distanceTo(f, x, z);
      if (d > radius) continue;
      if (d < bestD || (d === bestD && (f.grandeur > best.grandeur || (f.grandeur === best.grandeur && f.id < best.id)))) { best = f; bestD = d; }
    }
    return best;
  };
  // Public fields only (the analysis keeps its working data on features).
  const strip = (f) => {
    const out = { ...f };
    for (const k of ['measure', 'shoreM', 'label', 'floorM']) delete out[k];
    return out;
  };
  const weightOf = (c) => (c?.weight != null ? { weight: c.weight } : {});
  const snapped = (f, c) => {
    used.add(f.id);
    return { ...strip(f), id: slug(c.name), name: c.name, source: 'config', featureId: f.id, ...weightOf(c) };
  };

  const kept = [];
  const cam = ctx.camera;
  if (cam) {
    const pos = [0, 1, 2].map((k) => (cam.targetStartM[k] + cam.targetEndM[k]) / 2);
    const m = measure(ctx, pos[0], pos[2]), prominenceM = prominenceNear(pos[0], pos[2]);
    kept.push({
      id: 'rail-target', kind: 'rail-target', name: null, posM: pos.map(round1), radiusM: round1(Math.max(300, m.radiusM)),
      heightM: round1(m.heightM), prominenceM: round1(prominenceM), source: 'rail',
      grandeur: grandeurOf({ prominenceM, reliefM: m.reliefM, isolationM: m.isolationM, sizeM: m.radiusM }),
    });
  }
  const config = regionConfig?.subjects || [];
  const configFor = (name) => config.find((c) => c.name && sameName(c.name, name));
  // A subject at an authored point, or excluded with a note.
  const place = (kind, name, source, x, z, y0, extra) => {
    if (!inside(x, z)) { note(`${name} lies within ${marginM} m of the grid edge: excluded`); return; }
    const s = named(kind, name, source, x, z, y0, extra);
    if (s) kept.push(s); else note(`${name} has no DEM height: excluded`);
  };
  for (const l of ctx.landmarks || []) {
    const c = configFor(l.name);
    if (c?.lonLat) continue; // the config subject places it
    const [x, y0, z] = l.localM;
    if (c && !POINT_KINDS.has(c.kind)) {
      const radius = c.snapRadiusM ?? disc.snapRadiusM, f = snap(c.kind, x, z, radius);
      if (f) { kept.push(snapped(f, c)); continue; }
      note(`no DEM ${c.kind} within ${radius} m of ${c.name}: kept as a landmark`);
    }
    place(c && (c.kind === 'peak' || c.kind === 'butte') ? c.kind : 'landmark', l.name, c ? 'config' : 'landmark', x, z, y0, weightOf(c));
  }
  for (const c of config) {
    if (!SUBJECT_KINDS.includes(c.kind)) throw new Error(`${ctx.viewId}: subject ${c.name} has unknown kind ${c.kind}`);
    if (!c.lonLat) {
      if (!(ctx.landmarks || []).some((l) => sameName(l.name, c.name))) {
        throw new Error(`${ctx.viewId}: subject ${c.name} has no lonLat and matches no authored landmark`);
      }
      continue; // placed with the landmarks above
    }
    const [x, z] = lonLatToLocal(g, c.lonLat);
    if (c.kind !== 'landmark' && (c.approximate || !POINT_KINDS.has(c.kind))) {
      const radius = c.snapRadiusM ?? disc.snapRadiusM, f = snap(c.kind, x, z, radius);
      if (f) { kept.push(snapped(f, c)); continue; }
      note(`no DEM ${c.kind} within ${radius} m of ${c.name}: ${POINT_KINDS.has(c.kind) ? 'kept at its point' : 'kept as a landmark'}`);
    }
    place(POINT_KINDS.has(c.kind) ? c.kind : 'landmark', c.name, 'config', x, z, NaN, weightOf(c));
  }
  // Unique ids (two subjects with one name slug).
  const ids = new Set();
  for (const s of kept) {
    let id = s.id, k = 2;
    while (ids.has(id)) id = `${s.id}-${k++}`;
    s.id = id; ids.add(id);
  }

  // The tour's focus area, exactly as build-scenic-tours focusArea draws it
  // from these subjects: DEM features outside it would only be dropped.
  const focusR = regionConfig?.focusRadiusM ?? LANDFORMS[regionConfig?.landform]?.focusM ?? disc.focusRadiusM;
  const anchors = [kept.find((s) => s.kind === 'rail-target'), ...kept.filter((s) => (regionConfig?.hero || []).includes(s.name))].filter(Boolean);
  const centre = [0, 2].map((k) => anchors.reduce((a, s) => a + s.posM[k], 0) / Math.max(1, anchors.length));
  const inFocus = (f) => !(focusR > 0) || Math.hypot(f.posM[0] - centre[0], f.posM[2] - centre[1]) <= focusR;
  // Ridges and valleys keep their axes apart (two stretches of one valley
  // touch), other subjects their positions.
  const far = (s) => kept.every((k) => {
    if (POINT_KINDS.has(s.kind) && POINT_KINDS.has(k.kind)) return Math.hypot(k.posM[0] - s.posM[0], k.posM[2] - s.posM[2]) >= disc.minSubjectSpacingM;
    if (k.kind !== s.kind) return true;
    const d = s.axisM && k.axisM && s.kind !== 'lake' ? segmentDistance(s.axisM, k.axisM) : Math.hypot(k.posM[0] - s.posM[0], k.posM[2] - s.posM[2]);
    return d >= disc.minSubjectSpacingM;
  });
  const ranked = features.filter((f) => !used.has(f.id) && inFocus(f)).sort((p, q) => q.grandeur - p.grandeur || (p.id < q.id ? -1 : 1));
  for (const f of ranked) {
    if (kept.length >= disc.maxSubjects) break;
    if (ids.has(f.id) || !far(f)) continue;
    kept.push(strip(f)); ids.add(f.id);
  }
  analysis(ctx).subjects = kept;
  return kept;
}
