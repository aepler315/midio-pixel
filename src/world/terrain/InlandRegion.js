// A connected inland region built as one landform. Uplift belts, basins and
// the measured massifs set where the land wants to stand. A drainage-area
// erosion pass on a coarse lattice then cuts the valleys that the water
// would actually take, so ridges, spurs, passes and basins come out of one
// drainage network instead of being drawn independently of each other.
// Rivers are read from that same network: they always follow low ground and
// join downhill towards one outlet. The fine sampler shapes each reach by
// its setting: broad floors where the surrounding relief is low, narrow
// inner gorges where a river crosses high ground.
//
// Everything is a pure function of the field (seed and Songprint outline)
// and the stage geometry, so one recording always rebuilds the same region.
import { clamp01, lerp } from '../../utils/math.js';
import { INLAND_RIVER_FLOW as REGION_RIVER_FLOW, INLAND_MAX_DRY_FLOW as REGION_MAX_DRY_FLOW } from '../alpine/TerrainPackage.js';

export const INLAND_REGION_VERSION = 1;
// Rivers this large carry the low flight and keep the finest mesh.
const FLOWN_AREA_KM2 = 150;
const FLOWN_TRIBUTARIES = 3;
const MAX_DETAIL_M = 95;

const COARSE = 385;
const TRUNK_AREA_KM2 = 420;
const SEG_BUCKET_M = 1400;
const smooth = t => { const x = clamp01(t); return x * x * (3 - 2 * x); };

function hash32(seed, a, b = 0) {
  let h = (seed ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
const unit = (seed, a, b = 0) => hash32(seed, a, b) / 4294967296;

/** Smooth value noise on an integer lattice (C1 between lattice posts). */
export function valueNoise(seed, x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const u = x - i, v = z - j;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = unit(seed, i, j), b = unit(seed, i + 1, j), c = unit(seed, i, j + 1), d = unit(seed, i + 1, j + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

function fbm(seed, x, z, octaves) {
  let sum = 0, amp = .5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(seed + o * 1013, x * f, z * f);
    norm += amp; amp *= .5; f *= 2.03;
  }
  return sum / norm;
}

/** Ridged detail: sharp crests and rounded hollows, 0..1. */
function ridged(seed, x, z, octaves) {
  let sum = 0, amp = .5, norm = 0, f = 1, weight = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(2 * valueNoise(seed + o * 7919, x * f, z * f) - 1);
    const s = n * n * weight;
    sum += amp * s; norm += amp;
    weight = clamp01(s * 1.6);
    amp *= .5; f *= 2.11;
  }
  return sum / norm;
}

function skylineAt(skyline, t) {
  const p = clamp01(t) * (skyline.length - 1);
  const i = Math.floor(p), j = Math.min(skyline.length - 1, i + 1);
  return lerp(skyline[i], skyline[j], smooth(p - i));
}

/** Describe the region a recording builds, before any sampling. Values
 *  stay small and serialisable; the heavy lattice is built on demand.
 *  One trunk valley runs the length of the stage between two ranges,
 *  opens into a basin where the outline is lowest, then breaks through a
 *  cross range in a gorge before it leaves the stage. */
export function regionDesign(field, massifs = [], halfM = 44800) {
  const { seed, skyline, east, north } = field;
  let mean = 0, rough = 0, lo = Infinity, hi = -Infinity, loAt = 0;
  for (let i = 0; i < skyline.length; i++) {
    mean += skyline[i] / skyline.length;
    if (i) rough += Math.abs(skyline[i] - skyline[i - 1]) / (skyline.length - 1);
    if (skyline[i] < lo) { lo = skyline[i]; loAt = i / (skyline.length - 1); }
    hi = Math.max(hi, skyline[i]);
  }
  const busy = clamp01((rough - .15) / .4);
  const flow = unit(seed, 71) < .5 ? -1 : 1;
  const amplitude = lerp(.07, .16, unit(seed, 74)) * halfM;
  const waves = [lerp(.7, 1.3, unit(seed, 75)), lerp(1.6, 2.6, unit(seed, 76))];
  const phases = [unit(seed, 77) * 2 * Math.PI, unit(seed, 78) * 2 * Math.PI];
  const design = {
    seed, east, north, flow, amplitude, waves, phases, axisOffsetM: 0,
    // Upstream 0 .. downstream 1 along the trunk.
    basinAt: lerp(.18, .52, loAt), basinHalfM: lerp(5200, 8200, 1 - mean),
    gorgeAt: lerp(.66, .82, unit(seed, 79)), gorgeHalfM: lerp(380, 620, unit(seed, 80)),
    valleyHalfM: lerp(2600, 1700, busy),
    rangeOffsetM: lerp(15500, 11500, busy), rangeHalfM: lerp(5600, 4200, busy),
    crossHalfM: lerp(3600, 2600, busy),
    erodibility: lerp(.85, 1.2, unit(seed, 73)),
    // Character: how rugged the hillsides stand over the rivers, how
    // concave the valley profiles are, how rounded the crests, how many
    // channels carry visible water.
    handGain: lerp(1.6, 2.35, clamp01(.6 * busy + .5 * unit(seed, 82))),
    concavity: lerp(.38, .52, unit(seed, 83)),
    creep: lerp(.018, .05, 1 - busy),
    riverAreaKm2: lerp(24, 48, unit(seed, 84)),
    reliefM: lerp(1500, 2600, clamp01(.55 * (hi - lo) + .45 * mean)),
    roughness: rough, mean,
  };
  // Keep the trunk clear of the measured massifs: they belong on the ranges.
  let best = -Infinity;
  for (let k = -8; k <= 8; k++) {
    const offset = k * .045 * halfM;
    let clearance = Infinity;
    for (const m of massifs) {
      const along = m.x * east + m.z * north, across = m.z * east - m.x * north;
      const d = Math.abs(across - axisAcross({ ...design, axisOffsetM: offset }, along, halfM)) - m.radiusM;
      clearance = Math.min(clearance, d);
    }
    const score = Math.min(clearance, 9000) - .08 * Math.abs(offset);
    if (score > best) { best = score; design.axisOffsetM = offset; }
  }
  return design;
}

/** The valley floor and crest height a region builds for material bands,
 *  from the plan alone (no lattice needed). */
export function regionElevationSpan(field, baseM) {
  const { reliefM } = regionDesign(field);
  return { floorM: baseM + 40, topM: baseM + 40 + reliefM };
}

function axisAcross(design, along, halfM) {
  const t = along / halfM;
  return design.axisOffsetM + design.amplitude * (Math.sin(Math.PI * design.waves[0] * t + design.phases[0])
    + .45 * Math.sin(Math.PI * design.waves[1] * t + design.phases[1]));
}

/** Where (0 upstream .. 1 downstream) a stage coordinate lies along the trunk. */
function trunkStation(design, along, halfM) {
  return clamp01(.5 + design.flow * along / (1.84 * halfM));
}

function upliftAt(field, design, massifs, halfM, x, z) {
  const { seed, skyline, east, north } = field;
  const along = x * east + z * north, across = z * east - x * north;
  const s = trunkStation(design, along, halfM);
  const d = across - axisAcross(design, along, halfM);
  // Valley corridor: wide in the basin, confined through the gorge.
  const bq = (s - design.basinAt) * 1.84 * halfM / (2.2 * design.basinHalfM);
  const basin = Math.exp(-bq * bq);
  const gq = (s - design.gorgeAt) * 1.84 * halfM / (1.4 * design.crossHalfM);
  const gorge = Math.exp(-gq * gq);
  const halfWidth = lerp(lerp(design.valleyHalfM, design.basinHalfM, basin), design.gorgeHalfM, gorge);
  const headFade = smooth((s - .03) / .1);
  const vq = d / halfWidth;
  const valley = Math.exp(-vq * vq) * headFade;
  // Two flanking ranges; the outline sets their crests, low notes leave passes.
  const warp = (fbm(seed ^ 0x51ed27, along / 21000, across / 21000, 3) - .5) * 5200;
  let range = 0;
  for (const side of [-1, 1]) {
    const r = (d + warp - side * design.rangeOffsetM) / design.rangeHalfM;
    const crest = .4 + .6 * skylineAt(skyline, side < 0 ? s : 1 - s);
    const saddle = smooth((fbm(seed ^ (side < 0 ? 0x7a3 : 0x9c1), along / 8000, across / 8000, 2) - .25) / .5);
    range = Math.max(range, Math.exp(-r * r) * crest * (.6 + .4 * saddle));
  }
  // The cross range the trunk breaks through, highest beside the gorge.
  const cross = gorge * (.75 + .25 * skylineAt(skyline, .5 + .5 * Math.tanh(d / 9000)));
  let u = .5 + .62 * Math.max(range, cross) + .2 * (fbm(seed ^ 0x2c1b, x / 6000, z / 6000, 3) - .5);
  u -= (.46 + .1 * basin) * valley;
  for (const m of massifs) {
    const q = Math.hypot(x - m.x, z - m.z) / m.radiusM;
    u = Math.max(u, (.75 + .3 * m.weight) * Math.exp(-q * q));
  }
  // High ground around the stage except where the trunk leaves it.
  const edge = Math.max(Math.abs(x), Math.abs(z)) / halfM;
  const mq = d / (2 * halfWidth + 1500);
  const mouth = s > .9 ? Math.exp(-mq * mq) : 0;
  u += .35 * smooth((edge - .7) / .28) * (1 - mouth);
  return Math.max(.03, u);
}

class MinHeap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
  push(key, val) {
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

/**
 * Coarse regional landform: uplift, then implicit stream-power incision
 * (Braun & Willett 2013) with depression routing by priority flood, and a
 * little hillslope diffusion. Returns heights (0..1 relative), receivers,
 * drainage area in cells and the outlet set. A generator, one iteration per
 * step, so a browser load can yield between them.
 */
export function* coarseLandformSteps(field, design, massifs, { halfM, n = COARSE, iterations = 64 } = {}) {
  const N = n * n, dx = 2 * halfM / (n - 1);
  const xAt = i => -halfM + (i % n) * dx, zAt = i => -halfM + Math.floor(i / n) * dx;
  const U = new Float64Array(N), h = new Float64Array(N), Kmap = new Float64Array(N);
  const outlet = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = xAt(i), z = zAt(i);
    U[i] = upliftAt(field, design, massifs, halfM, x, z);
    // Cell-scale roughness seeds a branching network instead of parallel rills.
    h[i] = 4 * U[i] + 2.5 * unit(field.seed, 4000 + (i % n), Math.floor(i / n));
    Kmap[i] = .4 + .9 * fbm(field.seed ^ 0x6b1, x / 2600, z / 2600, 3);
    const gx = i % n, gz = Math.floor(i / n);
    if (gx === 0 || gz === 0 || gx === n - 1 || gz === n - 1) {
      const along = x * field.east + z * field.north, across = z * field.east - x * field.north;
      const d = Math.abs(across - axisAcross(design, along, halfM));
      if (trunkStation(design, along, halfM) > .9 && d < 2600) { outlet[i] = 1; h[i] = 0; }
    }
  }
  if (!outlet.some(Boolean)) { outlet[0] = 1; h[0] = 0; }
  const rcv = new Int32Array(N), stack = new Int32Array(N), area = new Int32Array(N);
  const diag = new Uint8Array(N);
  const filled = new Float64Array(N), done = new Uint8Array(N);
  const donors = new Int32Array(N), next = new Int32Array(N), queue = new Int32Array(N);
  const heap = new MinHeap(N);
  const K = .55 * design.erodibility, m = design.concavity, D = design.creep;
  const dt = 2.2 * 90 / iterations;
  // Drainage area is a whole number of cells: tabulate area^m once.
  const powArea = new Float64Array(N + 1);
  for (let a = 1; a <= N; a++) powArea[a] = Math.pow(a, m);
  const offsets = D8.map(([ox, oz]) => oz * n + ox);
  const border = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const gx = i % n, gz = (i / n) | 0; border[i] = gx === 0 || gz === 0 || gx === n - 1 || gz === n - 1 ? 1 : 0; }
  const inside = (i, q) => {
    if (!border[i]) return true;
    const x = i % n + D8[q][0], z = ((i / n) | 0) + D8[q][1];
    return x >= 0 && z >= 0 && x < n && z < n;
  };
  const tmp = new Float64Array(N), weights = new Float64Array(8);
  for (let it = 0; it <= iterations; it++) {
    const erode = it < iterations;
    if (erode) for (let i = 0; i < N; i++) if (!outlet[i]) h[i] += dt * U[i];
    // Steepest descent; a pit drains to itself and rises with uplift. Every
    // few iterations, and for the final network, a priority flood gives every
    // node a path to base level and a closed hollow fills to its spill level.
    const flood = !erode || it % 6 === 0;
    if (flood) {
      done.fill(0); heap.n = 0;
      for (let i = 0; i < N; i++) if (outlet[i]) { heap.push(h[i], i); done[i] = 1; filled[i] = h[i]; rcv[i] = i; }
      while (heap.n) {
        const c = heap.pop();
        for (let q = 0; q < 8; q++) {
          if (!inside(c, q)) continue;
          const k = c + offsets[q];
          if (done[k]) continue;
          done[k] = 1;
          filled[k] = Math.max(h[k], filled[c] + 1e-5);
          rcv[k] = c;
          heap.push(filled[k], k);
        }
      }
    } else {
      filled.set(h);
      for (let i = 0; i < N; i++) rcv[i] = i;
    }
    // Stochastic steepest descent: a hashed draw among the downhill
    // neighbours, weighted by slope, breaks the lattice's straight rills.
    const salt = field.seed ^ Math.imul(it + 1, 0x632be5ab);
    const o0 = offsets[0], o1 = offsets[1], o2 = offsets[2], o3 = offsets[3];
    const o4 = offsets[4], o5 = offsets[5], o6 = offsets[6], o7 = offsets[7];
    for (let i = 0; i < N; i++) {
      if (outlet[i]) continue;
      const fi = filled[i];
      let w0, w1, w2, w3, w4, w5, w6, w7;
      if (border[i]) {
        for (let q = 0; q < 8; q++) {
          if (!inside(i, q)) { weights[q] = 0; continue; }
          const sl = (fi - filled[i + offsets[q]]) * (q > 3 ? .7071 : 1);
          weights[q] = sl > 0 ? sl * sl : 0;
        }
        [w0, w1, w2, w3, w4, w5, w6, w7] = weights;
      } else {
        let t;
        t = fi - filled[i + o0]; w0 = t > 0 ? t * t : 0;
        t = fi - filled[i + o1]; w1 = t > 0 ? t * t : 0;
        t = fi - filled[i + o2]; w2 = t > 0 ? t * t : 0;
        t = fi - filled[i + o3]; w3 = t > 0 ? t * t : 0;
        t = fi - filled[i + o4]; w4 = t > 0 ? .5 * t * t : 0;
        t = fi - filled[i + o5]; w5 = t > 0 ? .5 * t * t : 0;
        t = fi - filled[i + o6]; w6 = t > 0 ? .5 * t * t : 0;
        t = fi - filled[i + o7]; w7 = t > 0 ? .5 * t * t : 0;
      }
      const total = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7;
      if (!(total > 0)) { const dd = Math.abs(rcv[i] - i); diag[i] = rcv[i] !== i && dd !== 1 && dd !== n ? 1 : 0; continue; }
      let pick = unit(salt, i) * total, q = 7;
      if ((pick -= w0) <= 0 && w0 > 0) q = 0;
      else if ((pick -= w1) <= 0 && w1 > 0) q = 1;
      else if ((pick -= w2) <= 0 && w2 > 0) q = 2;
      else if ((pick -= w3) <= 0 && w3 > 0) q = 3;
      else if ((pick -= w4) <= 0 && w4 > 0) q = 4;
      else if ((pick -= w5) <= 0 && w5 > 0) q = 5;
      else if (pick - w6 <= 0 && w6 > 0) q = 6;
      else if (!(w7 > 0)) q = w6 > 0 ? 6 : w5 > 0 ? 5 : w4 > 0 ? 4 : w3 > 0 ? 3 : w2 > 0 ? 2 : w1 > 0 ? 1 : 0;
      rcv[i] = i + offsets[q]; diag[i] = q > 3 ? 1 : 0;
    }
    donors.fill(-1);
    for (let i = 0; i < N; i++) if (rcv[i] !== i) { next[i] = donors[rcv[i]]; donors[rcv[i]] = i; }
    let head = 0, tail = 0;
    for (let i = 0; i < N; i++) if (rcv[i] === i) queue[tail++] = i;
    let top = 0;
    while (head < tail) {
      const c = queue[head++]; stack[top++] = c;
      for (let d = donors[c]; d !== -1; d = next[d]) queue[tail++] = d;
    }
    area.fill(1);
    for (let st = top - 1; st >= 0; st--) { const i = stack[st]; if (rcv[i] !== i) area[rcv[i]] += area[i]; }
    if (!erode) {
      // The final network: hollows fill to their spill level, so no dry pit
      // sits below the river that crosses it.
      for (let i = 0; i < N; i++) if (filled[i] > h[i]) h[i] = filled[i];
      break;
    }
    // Implicit stream-power incision from the outlets upwards. Hollows
    // keep sediment to their spill level.
    const kdt = K * dt;
    for (let st = 0; st < top; st++) {
      const i = stack[st], r = rcv[i];
      if (r === i) continue;
      let hi = h[i];
      if (filled[i] > hi) hi = filled[i];
      const f = kdt * Kmap[i] * powArea[area[i]] * (diag[i] ? .7071 : 1);
      h[i] = (hi + f * h[r]) / (1 + f);
    }
    // Hillslope creep rounds crests between valleys.
    for (let i = 0; i < N; i++) {
      if (outlet[i]) { tmp[i] = h[i]; continue; }
      if (border[i]) {
        const cx = i % n, cz = (i / n) | 0;
        const l = cx > 0 ? h[i - 1] : h[i], r = cx < n - 1 ? h[i + 1] : h[i];
        const u = cz > 0 ? h[i - n] : h[i], d = cz < n - 1 ? h[i + n] : h[i];
        tmp[i] = h[i] + D * (l + r + u + d - 4 * h[i]);
      } else tmp[i] = h[i] + D * (h[i - 1] + h[i + 1] + h[i - n] + h[i + n] - 4 * h[i]);
    }
    h.set(tmp);
    yield it;
  }
  return { n, dx, halfM, h, U, rcv, area, outlet, stack: stack.slice(0, N) };
}

export function finishSteps(steps) {
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

function chaikin(points, rounds) {
  let p = points;
  for (let r = 0; r < rounds; r++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      if (i > 0) out.push({ ...a, x: .75 * a.x + .25 * b.x, z: .75 * a.z + .25 * b.z, area: lerp(a.area, b.area, .25), bed: lerp(a.bed, b.bed, .25) });
      if (i < p.length - 2) out.push({ ...a, x: .25 * a.x + .75 * b.x, z: .25 * a.z + .75 * b.z, area: lerp(a.area, b.area, .75), bed: lerp(a.bed, b.bed, .75) });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/** Trace channels from the routed lattice: heads to junctions, junctions to
 *  the outlet. Each polyline ends exactly on the point it joins. */
function traceRivers(coarse, reliefM, baseM, riverAreaKm2) {
  const { n, dx, halfM, h, rcv, area } = coarse;
  const cellKm2 = dx * dx / 1e6;
  const isRiver = i => area[i] * cellKm2 >= riverAreaKm2;
  const upstream = new Int32Array(n * n);
  for (let i = 0; i < n * n; i++) if (isRiver(i) && rcv[i] !== i) upstream[rcv[i]]++;
  // Heads: river cells with no river donors. Longest path first, so the
  // trunk and the big tributaries claim their courses before small ones.
  const heads = [];
  for (let i = 0; i < n * n; i++) if (isRiver(i) && upstream[i] === 0) heads.push(i);
  const pathLength = i => { let k = 0; for (let c = i; rcv[c] !== c && k < 4 * n; c = rcv[c]) k++; return k; };
  heads.sort((a, b) => pathLength(b) - pathLength(a) || a - b);
  const owner = new Int32Array(n * n).fill(-1);
  const rivers = [];
  const pt = i => ({ x: -halfM + (i % n) * dx, z: -halfM + Math.floor(i / n) * dx, area: area[i] * cellKm2, bed: baseM + reliefM * h[i], cell: i });
  for (const head of heads) {
    const cells = [];
    let c = head, joins = null;
    for (let guard = 0; guard < 4 * n; guard++) {
      if (owner[c] >= 0) { joins = owner[c]; cells.push(c); break; }
      cells.push(c);
      owner[c] = rivers.length;
      if (rcv[c] === c) break;
      c = rcv[c];
    }
    if (cells.length < 4) continue;
    rivers.push({ id: rivers.length, joins, cells });
  }
  // Polylines with monotone beds, smoothed but pinned at both ends.
  return rivers.map(r => {
    const raw = r.cells.map(pt);
    for (let i = 1; i < raw.length; i++) raw[i].bed = Math.min(raw[i].bed, raw[i - 1].bed - .05);
    const points = chaikin(raw, 3);
    const own = r.joins === null ? raw[raw.length - 1] : raw[raw.length - 2];
    return { id: r.id, joins: r.joins, points, areaKm2: own.area, trunk: own.area >= TRUNK_AREA_KM2 && r.joins === null };
  });
}

function bicubicSampler(values, n, halfM) {
  const dx = 2 * halfM / (n - 1);
  const at = (i, j) => values[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  const cub = (a, b, c, d, t) => b + .5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  return (x, z) => {
    const gx = (x + halfM) / dx, gz = (z + halfM) / dx;
    const i = Math.floor(gx), j = Math.floor(gz), u = gx - i, v = gz - j;
    const row = k => cub(at(i - 1, j + k), at(i, j + k), at(i + 1, j + k), at(i + 2, j + k), u);
    return cub(row(-1), row(0), row(1), row(2), v);
  };
}

function segmentIndex(rivers, halfM) {
  const cols = Math.ceil(2 * halfM / SEG_BUCKET_M) + 1;
  const buckets = new Map();
  const reach = 2600;
  const key = (i, j) => j * cols + i;
  const cell = v => Math.floor((v + halfM) / SEG_BUCKET_M);
  for (const river of rivers) {
    for (let k = 1; k < river.points.length; k++) {
      const a = river.points[k - 1], b = river.points[k];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
      if (!(len2 > 0)) continue;
      const seg = { a, b, dx, dz, inv: 1 / len2, river };
      for (let j = cell(Math.min(a.z, b.z) - reach); j <= cell(Math.max(a.z, b.z) + reach); j++) {
        for (let i = cell(Math.min(a.x, b.x) - reach); i <= cell(Math.max(a.x, b.x) + reach); i++) {
          const kk = key(i, j);
          let list = buckets.get(kk);
          if (!list) buckets.set(kk, list = []);
          list.push(seg);
        }
      }
    }
  }
  return { at: (x, z) => buckets.get(key(cell(x), cell(z))) ?? [] };
}

/**
 * Build the sampled region.
 *   field    makeInlandTerrain result (seed, skyline, direction, relief)
 *   baseM    the stage datum (valley mouth sits a little above it)
 *   options  { halfM, massifs: [{ x, z, radiusM, weight }] }
 * Returns a generator; its value is the region with heightAt/sample.
 */
export function* inlandRegionSteps(field, baseM, { halfM = 44800, massifs = [], n = COARSE } = {}) {
  const design = regionDesign(field, massifs, halfM);
  const coarse = yield* coarseLandformSteps(field, design, massifs, { halfM, n });
  // Normalise the relative surface to the recording's relief.
  let lo = Infinity, hi = -Infinity;
  for (const v of coarse.h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const reliefM = design.reliefM;
  const rel = new Float64Array(coarse.h.length);
  for (let i = 0; i < rel.length; i++) rel[i] = (coarse.h[i] - lo) / (hi - lo);
  // Height above the drainage it feeds: steepen every hillslope and side
  // valley over the river network while the rivers keep their gradients.
  // Each flow path still descends, so the network is unchanged.
  {
    const cellKm2 = coarse.dx * coarse.dx / 1e6, drain = new Float64Array(rel.length);
    for (const i of coarse.stack) {
      const r = coarse.rcv[i];
      drain[i] = r === i || coarse.area[i] * cellKm2 >= design.riverAreaKm2 ? rel[i] : drain[r];
    }
    const core = [];
    const cn = coarse.n;
    for (let i = 0; i < rel.length; i++) {
      rel[i] = drain[i] + design.handGain * (rel[i] - drain[i]);
      const gx = i % cn, gz = (i / cn) | 0;
      if (Math.abs(gx - cn / 2) < cn * .3 && Math.abs(gz - cn / 2) < cn * .3) core.push(rel[i]);
    }
    // Scale to the travelled core; the outer ground may stand higher.
    core.sort((a, b) => a - b);
    const top = core[Math.floor(core.length * .995)], bottom = core[0];
    for (let i = 0; i < rel.length; i++) rel[i] = Math.max(0, (rel[i] - bottom) / (top - bottom));
  }
  coarse.h = rel;
  const floorM = baseM + 40;
  const rivers = traceRivers(coarse, reliefM, floorM, design.riverAreaKm2);
  yield 'rivers';
  const height = bicubicSampler(rel, coarse.n, halfM);
  // Local relief: how much ground stands over a river within a few km.
  // Broad floors where it is low, gorges where it is high.
  const reliefLattice = new Float64Array(rel.length);
  {
    const { n: cn } = coarse, r = 5;
    for (let j = 0; j < cn; j++) for (let i = 0; i < cn; i++) {
      let top = 0;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const a = Math.max(0, Math.min(cn - 1, i + di)), b = Math.max(0, Math.min(cn - 1, j + dj));
        if (di * di + dj * dj <= r * r) top = Math.max(top, rel[b * cn + a]);
      }
      reliefLattice[j * cn + i] = (top - rel[j * cn + i]) * reliefM;
    }
  }
  const localRelief = bicubicSampler(reliefLattice, coarse.n, halfM);
  // Reach character. A river between high walls keeps a narrow floor and
  // cuts an inner gorge; in open country, and above all in the basin, big
  // rivers spread across a broad floor.
  const { seed, east, north } = field;
  for (const river of rivers) for (const p of river.points) {
    p.relief = localRelief(p.x, p.z);
    const along = p.x * east + p.z * north;
    const s = trunkStation(design, along, halfM);
    const bq = (s - design.basinAt) * 1.84 * halfM / (1.6 * design.basinHalfM);
    const inBasin = Math.exp(-bq * bq);
    const gq = (s - design.gorgeAt) * 1.84 * halfM / (1.1 * design.crossHalfM);
    const atGorge = Math.exp(-gq * gq);
    const size = clamp01((Math.sqrt(p.area) - 5) / 25);
    p.broad = clamp01(Math.max(inBasin * size * 1.4, clamp01(1 - (p.relief - 300) / 500) * size * .8));
    p.gorge = clamp01(Math.max(atGorge * (river.trunk || p.area > 200 ? 1 : .4), (p.relief - 700) / 500 * size) * (1 - p.broad));
    p.channelM = Math.min(46, 12 + 1.1 * Math.sqrt(p.area));
    p.floorM = p.channelM * lerp(lerp(1.6, 7, p.broad), 1.05, p.gorge) + 30 * (1 - p.gorge);
  }
  // Meanders. The lattice routes water across a flat in a straight line;
  // swing each course across its own floor instead, most on flats and broad
  // floors, not at all in a gorge, and pinned at both ends so every junction
  // still meets the river it joins.
  const byId = new Map(rivers.map(r => [r.id, r]));
  const original = new Map(rivers.map(r => [r.id, r.points]));
  for (const river of rivers) {
    let pts = river.points;
    const n = pts.length;
    if (n < 6) continue;
    // Follow the parent's moved junction, easing the tail onto it.
    const parent = river.joins !== null ? byId.get(river.joins) : null;
    if (parent && parent.points !== original.get(parent.id)) {
      const end = pts[n - 1], before = original.get(parent.id);
      let k = 0, best = Infinity;
      for (let i = 0; i < before.length; i++) {
        const d = Math.hypot(before[i].x - end.x, before[i].z - end.z);
        if (d < best) { best = d; k = i; }
      }
      const dx = parent.points[k].x - before[k].x, dz = parent.points[k].z - before[k].z;
      let run = 0;
      const tail = new Float64Array(n);
      for (let i = n - 2; i >= 0; i--) { run += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z); tail[i] = run; }
      pts = pts.map((p, i) => { const w = smooth(1 - tail[i] / 1500); return { ...p, x: p.x + dx * w, z: p.z + dz * w }; });
    }
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const total = arc[n - 1], wave = lerp(1300, 2300, unit(seed, 300 + river.id));
    const phase = unit(seed, 400 + river.id) * 50;
    const offsets = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 3)], b = pts[Math.min(n - 1, i + 3)];
      const dropPerKm = (a.bed - b.bed) / Math.max(1, (arc[Math.min(n - 1, i + 3)] - arc[Math.max(0, i - 3)]) / 1000);
      const flat = clamp01(1 - dropPerKm / 4);
      const amp = Math.min(320, (.3 + .5 * flat) * Math.max(p.floorM, 90 + 160 * flat)) * (1 - p.gorge);
      const pin = smooth(arc[i] / 900) * smooth((total - arc[i]) / 900);
      const t = arc[i] / wave + phase;
      return amp * pin * (Math.sin(2 * Math.PI * t) + .35 * Math.sin(2 * Math.PI * 2.3 * t + 1.7)) / 1.35;
    });
    const moved = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      return { ...p, x: p.x - dz * offsets[i], z: p.z + dx * offsets[i] };
    });
    river.points = moved;
  }
  // The camera flies low along the trunk and its largest tributaries.
  const ranked = rivers.filter(r => !r.trunk && r.joins !== null).sort((a, b) => b.areaKm2 - a.areaKm2);
  for (const river of rivers) river.flown = river.trunk || ranked.indexOf(river) >= 0 && ranked.indexOf(river) < FLOWN_TRIBUTARIES;
  const index = segmentIndex(rivers, halfM);
  yield 'index';
  const hit = {};
  const nearest = (x, z) => {
    let best = Infinity, seg = null, tt = 0;
    for (const sg of index.at(x, z)) {
      const t = clamp01(((x - sg.a.x) * sg.dx + (z - sg.a.z) * sg.dz) * sg.inv);
      const px = sg.a.x + t * sg.dx - x, pz = sg.a.z + t * sg.dz - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) { best = d2; seg = sg; tt = t; }
    }
    hit.d = Math.sqrt(best); hit.seg = seg; hit.t = tt;
    return hit;
  };
  const smin = (a, b, k) => {
    const hh = clamp01(.5 + .5 * (b - a) / k);
    return lerp(b, a, hh) - k * hh * (1 - hh);
  };
  const region = {
    version: INLAND_REGION_VERSION, design, rivers, coarse, reliefM, floorM, halfM,
    /** Ground and surface class at (x, z), before any measured massif. */
    sample(x, z, out = {}) {
      const base = floorM + reliefM * height(x, z);
      // Downslope direction of the regional surface orients the detail.
      const gx = height(x + 60, z) - height(x - 60, z), gz = height(x, z + 60) - height(x, z - 60);
      const g = Math.hypot(gx, gz) * reliefM / 120;
      const { d, seg, t } = nearest(x, z);
      let ground = base, bed = base, floorMask = 0, wet = false, flow = 0, gorge = 0;
      if (seg && d < 4000) {
        const a = seg.a, b = seg.b;
        bed = lerp(a.bed, b.bed, t);
        const channel = lerp(a.channelM, b.channelM, t), floorHalf = lerp(a.floorM, b.floorM, t);
        gorge = lerp(a.gorge, b.gorge, t);
        const broad = lerp(a.broad, b.broad, t);
        // The floor's edge wanders; the channel follows its own course.
        const edge = Math.max(channel, floorHalf + (valueNoise(seed ^ 0x77, x / 700, z / 700) - .5) * .6 * (floorHalf - channel));
        const across = d;
        // Walls: gentle benches in open reaches, steep in a gorge.
        const wallTan = lerp(lerp(.55, .22, broad), 1.7, gorge);
        let target;
        if (across < channel) target = bed - 3 * (1 - (across / channel) ** 2);
        else if (across < edge) target = bed + 1 + 5 * ((across - channel) / Math.max(1, edge - channel)) ** 2;
        else target = bed + 6 + (across - edge) * wallTan;
        const k = lerp(30, 8, gorge);
        ground = smin(base, target, k);
        floorMask = 1 - smooth((across - edge) / 160);
        // Water needs about one atlas texel either side to read as a river.
        wet = across < Math.max(channel, 40);
        flow = wet ? REGION_RIVER_FLOW : Math.round(REGION_MAX_DRY_FLOW
          * clamp01(1 - (across - channel) / (500 + 25 * Math.sqrt(lerp(a.area, b.area, t)))) ** 1.5);
        out.distanceM = d; out.floorHalfM = floorHalf; out.broad = broad; out.areaKm2 = lerp(a.area, b.area, t); out.river = seg.river.id;
      } else {
        out.distanceM = Infinity; out.floorHalfM = 0; out.broad = 0; out.areaKm2 = 0; out.river = -1;
      }
      out.gorge = gorge;
      // Spur-and-gully detail, stretched downslope, on hillsides only.
      const hand = Math.max(0, ground - bed);
      let detail = 0;
      if (!wet) {
        const c = g > 1e-4 ? gx / Math.hypot(gx, gz) : 1, sn = g > 1e-4 ? gz / Math.hypot(gx, gz) : 0;
        const u = (x * c + z * sn) / 1500, v = (z * c - x * sn) / 430;
        const rough = clamp01(hand / 260) * (1 - floorMask) * clamp01(g * 2.5 + .25);
        detail = rough * (62 * (ridged(seed ^ 0x3d, u, v, 2) - .4) + 48 * (fbm(seed ^ 0x5e, x / 1100, z / 1100, 3) - .5)
          + 14 * (valueNoise(seed ^ 0x9a, x / 260, z / 260) - .5));
        detail = Math.max(-MAX_DETAIL_M, Math.min(MAX_DETAIL_M, detail));
      }
      out.bedM = bed;
      out.heightM = ground + detail;
      out.flowByte = flow;
      out.wet = wet;
      return out;
    },
    heightAt(x, z) { return this.sample(x, z, {}).heightM; },
    /** 2 where a flown river corridor crosses the rectangle, 1 for any
     *  other river, 0 for open hillside. Conservative in both cases. */
    corridor(x0, z0, x1, z1) {
      let level = 0;
      const margin = 1300;
      for (let z = z0 - margin; z <= z1 + margin + SEG_BUCKET_M; z += SEG_BUCKET_M) {
        for (let x = x0 - margin; x <= x1 + margin + SEG_BUCKET_M; x += SEG_BUCKET_M) {
          for (const sg of index.at(Math.min(x, x1 + margin), Math.min(z, z1 + margin))) {
            const flown = sg.river.flown;
            const pad = flown ? 900 : 300;
            for (const q of [sg.a, sg.b]) {
              if (q.x < x0 - pad || q.x > x1 + pad || q.z < z0 - pad || q.z > z1 + pad) continue;
              if (flown) return 2;
              level = 1;
            }
          }
        }
      }
      return level;
    },
  };
  let top = -Infinity;
  for (const v of rel) top = Math.max(top, v);
  region.boundsM = [floorM - 12, floorM + reliefM * top + MAX_DETAIL_M];
  return region;
}

export function makeInlandRegion(field, baseM, options) {
  return finishSteps(inlandRegionSteps(field, baseM, options));
}

/** Compact, serialisable features for the camera and diagnostics, in stage
 *  coordinates: the flown rivers as sampled courses, their confluences,
 *  gorges and broad reaches, and passes between neighbouring basins. */
export function regionAnchors(region, centre = [0, 0]) {
  const [cx, cz] = centre;
  const r1 = v => Math.round(v);
  const big = region.rivers.filter(r => r.flown || r.areaKm2 >= FLOWN_AREA_KM2);
  const rivers = big.map(r => {
    const out = [];
    let last = null;
    for (const p of r.points) {
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 400 && p !== r.points[r.points.length - 1]) continue;
      out.push([r1(p.x + cx), r1(p.z + cz), r1(p.bed), r1(p.area), Math.round(p.gorge * 100) / 100, Math.round(p.broad * 100) / 100]);
      last = p;
    }
    return { id: r.id, joins: r.joins, trunk: !!r.trunk, flown: !!r.flown, areaKm2: r1(r.areaKm2), course: out };
  });
  const ids = new Set(big.map(r => r.id));
  const confluences = big.filter(r => r.joins !== null && ids.has(r.joins)).map(r => {
    const p = r.points[r.points.length - 1];
    return { id: `confluence-${r.id}`, x: r1(p.x + cx), z: r1(p.z + cz), bedM: r1(p.bed), areaKm2: r1(p.area) };
  });
  const runs = (key, threshold, kind) => {
    const found = [];
    for (const r of big) {
      let start = -1;
      for (let i = 0; i <= r.points.length; i++) {
        const on = i < r.points.length && r.points[i][key] > threshold;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          const a = r.points[start], b = r.points[i - 1];
          const lengthM = Math.hypot(b.x - a.x, b.z - a.z);
          if (lengthM > 900) {
            const m = r.points[(start + i - 1) >> 1];
            found.push({ id: `${kind}-${r.id}-${start}`, river: r.id, x: r1(m.x + cx), z: r1(m.z + cz), bedM: r1(m.bed),
              lengthM: r1(lengthM), from: [r1(a.x + cx), r1(a.z + cz)], to: [r1(b.x + cx), r1(b.z + cz)] });
          }
          start = -1;
        }
      }
    }
    return found.sort((a, b) => b.lengthM - a.lengthM).slice(0, 8);
  };
  return { version: INLAND_REGION_VERSION, rivers, confluences, gorges: runs('gorge', .55, 'gorge'),
    broadReaches: runs('broad', .45, 'broad'), passes: regionPasses(region, big).map(p => ({ ...p, x: r1(p.x + cx), z: r1(p.z + cz) })) };
}

/** Passes: the lowest crossing of the divide between two neighbouring river
 *  basins on the coarse lattice, kept where it stands well above both rivers
 *  (a saddle on a ridge, not a low swell on a shared floor). */
function regionPasses(region, rivers) {
  const { coarse, reliefM, floorM } = region;
  const { n, dx, halfM, h, rcv } = coarse;
  const label = new Int32Array(n * n).fill(-1);
  const riverOf = new Map();
  for (const r of rivers) for (const p of r.points) if (p.cell !== undefined && !riverOf.has(p.cell)) riverOf.set(p.cell, r.id);
  for (const i of coarse.stack) label[i] = riverOf.has(i) ? riverOf.get(i) : rcv[i] === i ? -1 : label[rcv[i]];
  const best = new Map();
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    const a = j * n + i;
    for (const b of [a + 1, a + n]) {
      const la = label[a], lb = label[b];
      if (la < 0 || lb < 0 || la === lb) continue;
      const key = la < lb ? `${la}:${lb}` : `${lb}:${la}`;
      const saddle = Math.max(h[a], h[b]);
      const hit = best.get(key);
      if (!hit || saddle < hit.saddle) best.set(key, { saddle, cell: h[a] > h[b] ? a : b, pair: [la, lb] });
    }
  }
  const byId = new Map(rivers.map(r => [r.id, r]));
  const bedNear = (id, x, z) => {
    let bed = Infinity, d = Infinity;
    for (const p of byId.get(id).points) {
      const q = Math.hypot(p.x - x, p.z - z);
      if (q < d) { d = q; bed = p.bed; }
    }
    return bed;
  };
  return [...best.entries()].map(([key, { saddle, cell, pair }]) => {
    const x = -halfM + (cell % n) * dx, z = -halfM + Math.floor(cell / n) * dx;
    const heightM = Math.round(floorM + reliefM * saddle);
    return { id: `pass-${key.replace(':', '-')}`, x, z, heightM, reliefM: heightM - Math.max(bedNear(pair[0], x, z), bedNear(pair[1], x, z)) };
  }).filter(p => Math.max(Math.abs(p.x), Math.abs(p.z)) < .62 * halfM && p.reliefM >= 180 && p.reliefM <= 1400)
    .sort((a, b) => Math.abs(a.reliefM - 450) - Math.abs(b.reliefM - 450)).slice(0, 8)
    .map(({ reliefM: rise, ...p }) => ({ ...p, reliefM: Math.round(rise) }));
}
