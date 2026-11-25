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
// A recording with a measured Songprint timeline builds a sea of peaks
// instead: its heard time is laid out as distance along a spine through the
// region, so the ground under the flight at a moment was raised by that
// moment of the song. Catalog massif blocks supply the foreground summits.
//
// The river region is a pure function of the field (the Songprint outline) and the
// stage geometry, so one recording always rebuilds the same region. No value
// is drawn from a hash of the recording: every design choice is a continuous
// function of the outline, and the fine noise is one fixed ground shared by
// every song, laid out in the region's own frame. A close outline (another
// recording of the song) therefore builds a close landform, and a small turn
// of the region turns the same land. The erosion itself still amplifies
// small differences, as drainage does, so close is not identical.
import { clamp01, lerp } from '../../utils/math.js';
import { INLAND_RIVER_FLOW as REGION_RIVER_FLOW, INLAND_MAX_DRY_FLOW as REGION_MAX_DRY_FLOW } from '../alpine/TerrainPackage.js';

export const INLAND_REGION_VERSION = 4;
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

/** A 0..1 trait from the outline's standardised cosine coefficients
 *  (InlandTerrain: about -2..2 across a library). The library's typical
 *  song sits at 0.5 and songs use most of the range. */
const trait = z => .5 + .5 * Math.tanh(z / 1.2);
const blend = (a, b) => (a + b) * Math.SQRT1_2;
/** Stage coordinates in the region's frame: along the trunk and across it. */
const alongOf = (field, x, z) => x * field.east + z * field.north;
const acrossOf = (field, x, z) => z * field.east - x * field.north;

/** Describe the region a recording builds, before any sampling. Values
 *  stay small and serialisable; the heavy lattice is built on demand.
 *  One trunk valley runs the length of the stage between two ranges,
 *  opens into a basin where the outline is lowest, then breaks through a
 *  cross range in a gorge before it leaves the stage. */
export function regionDesign(field, massifs = [], halfM = 44800) {
  const { ground, skyline, shape, east, north } = field;
  let mean = 0, rough = 0, lo = Infinity, hi = -Infinity, loAt = 0;
  for (let i = 0; i < skyline.length; i++) {
    mean += skyline[i] / skyline.length;
    if (i) rough += Math.abs(skyline[i] - skyline[i - 1]) / (skyline.length - 1);
    if (skyline[i] < lo) { lo = skyline[i]; loAt = i / (skyline.length - 1); }
    hi = Math.max(hi, skyline[i]);
  }
  const busy = clamp01((rough - .15) / .4);
  // Which way the trunk drains is carried by the region's turn (a half turn
  // reverses it), so no switch decides it.
  const flow = 1;
  // Each choice the seed used to draw now follows one standardised outline
  // coefficient, or an even blend of two. c8 moves most between recordings
  // of one song (InlandTerrain OUTLINE_CAL), so it carries nothing.
  const [c1, c2, c3, c4, c5, c6, c7] = shape;
  const amplitude = lerp(.07, .16, trait(c7)) * halfM;
  const waves = [lerp(.7, 1.3, trait(c1)), lerp(1.6, 2.6, trait(c3))];
  const phases = [trait(c5) * 2 * Math.PI, trait(c2) * 2 * Math.PI];
  const design = {
    ground, east, north, flow, amplitude, waves, phases, axisOffsetM: 0,
    // Upstream 0 .. downstream 1 along the trunk.
    basinAt: lerp(.18, .52, loAt), basinHalfM: lerp(5200, 8200, 1 - mean),
    gorgeAt: lerp(.66, .82, trait(c4)), gorgeHalfM: lerp(380, 620, trait(c6)),
    valleyHalfM: lerp(2600, 1700, busy),
    rangeOffsetM: lerp(15500, 11500, busy), rangeHalfM: lerp(5600, 4200, busy),
    crossHalfM: lerp(3600, 2600, busy),
    erodibility: lerp(.85, 1.2, trait(blend(c7, -c1))),
    // Character: how rugged the hillsides stand over the rivers, how
    // concave the valley profiles are, how rounded the crests, how many
    // channels carry visible water.
    handGain: lerp(1.6, 2.35, clamp01(.6 * busy + .5 * trait(blend(c2, c5)))),
    concavity: lerp(.38, .52, trait(blend(c3, -c6))),
    creep: lerp(.018, .05, 1 - busy),
    riverAreaKm2: lerp(24, 48, trait(blend(c4, -c1))),
    reliefM: lerp(1500, 2600, clamp01(.55 * (hi - lo) + .45 * mean)),
    roughness: rough, mean,
  };
  if (field.song?.measured) Object.assign(design, peakCharacter(field.song));
  // Keep the trunk clear of the measured massifs: they belong on the ranges.
  let best = -Infinity;
  for (let k = -8; !design.peaks && k <= 8; k++) {
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
  if (design.peaks) {
    design.spine = songSpine(field, design, halfM);
    design.passes = songPasses(field.song, design.spine);
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

// ---------------------------------------------------------------------------
// Song spine. Heard time becomes distance: the spine's arc length per second
// follows loudness, so loud passages cover more ground and quiet ones linger
// among near slopes. Peaks stand beside the spine where the song put them.

const SPINE_STEP_M = 100;

/** Overall character from the whole song: relief from its dynamics, crest
 *  sharpness from its tension, a sea of peaks drained to every edge. */
function peakCharacter(song) {
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const tension = mean(song.tension), loud = mean(song.loudness);
  return {
    peaks: true,
    handGain: lerp(2.6, 3.6, clamp01(1.4 * tension)),
    creep: lerp(.012, .004, tension),
    concavity: .45,
    reliefM: lerp(650, 1050, clamp01(.55 * song.dynamics + .45 * loud)),
    riverAreaKm2: lerp(28, 46, tension),
  };
}

function seriesAt(series, stepMs, timeMs) {
  const p = Math.max(0, Math.min(series.length - 1, timeMs / stepMs - .5));
  const i = Math.floor(p), j = Math.min(series.length - 1, i + 1);
  return lerp(series[i], series[j], p - i);
}

/** The spine: dense samples { x, z, along, arc, timeMs } and lookups from
 *  time to arc and from the along-axis coordinate to time. */
export function songSpine(field, design, halfM) {
  const { song, east, north } = field;
  const n = song.loudness.length, stepMs = song.stepMs;
  // Pace: smoothed loudness, never stalling.
  const pace = song.loudness.map((_, i) => {
    let sum = 0, w = 0;
    for (let k = -3; k <= 3; k++) { const j = Math.max(0, Math.min(n - 1, i + k)); sum += (4 - Math.abs(k)) * song.loudness[j]; w += 4 - Math.abs(k); }
    return .45 + sum / w;
  });
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + pace[i];
  const lengthM = Math.max(18000, Math.min(66000, n * stepMs / 1000 * 118));
  // Arc length of the axis curve as a function of the along coordinate.
  const axisPoint = a => { const c = axisAcross(design, a, halfM); return [a * east - c * north, a * north + c * east]; };
  const arcOver = span => {
    let arc = 0, prev = axisPoint(-span / 2);
    for (let k = 1; k <= 400; k++) { const q = axisPoint(-span / 2 + span * k / 400); arc += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
    return arc;
  };
  let span = lengthM * .9;
  for (let it = 0; it < 4; it++) span *= lengthM / arcOver(span);
  span = Math.min(span, 2 * halfM - 9000);
  const start = -design.flow * span / 2, dir = design.flow;
  const points = [];
  let arc = 0, prev = null;
  for (let k = 0; ; k++) {
    const a = start + dir * Math.min(span, k * SPINE_STEP_M * .8);
    const [x, z] = axisPoint(a);
    if (prev) arc += Math.hypot(x - prev[0], z - prev[1]);
    points.push({ x, z, along: a, arc });
    prev = [x, z];
    if (k * SPINE_STEP_M * .8 >= span) break;
  }
  const total = arc;
  const timeAtArc = d => {
    const target = d / total * cum[n];
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
    return (lo + clamp01((target - cum[lo]) / Math.max(1e-9, cum[lo + 1] - cum[lo]))) * stepMs;
  };
  for (const p of points) p.timeMs = timeAtArc(p.arc);
  const arcAtTime = t => {
    const x = Math.max(0, Math.min(n, t / stepMs)), i = Math.min(n - 1, Math.floor(x));
    return total * (cum[i] + (x - i) * pace[i]) / cum[n];
  };
  const pointAtArc = d => {
    const k = Math.max(0, Math.min(points.length - 2, Math.floor(d / total * (points.length - 1))));
    let i = k;
    while (i > 0 && points[i].arc > d) i--;
    while (i < points.length - 2 && points[i + 1].arc < d) i++;
    const a = points[i], b = points[i + 1], u = clamp01((d - a.arc) / Math.max(1e-6, b.arc - a.arc));
    const tx = b.x - a.x, tz = b.z - a.z, len = Math.hypot(tx, tz) || 1;
    return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), along: lerp(a.along, b.along, u), tx: tx / len, tz: tz / len };
  };
  const lo = Math.min(start, start + dir * span), hi = Math.max(start, start + dir * span);
  /** Song time at an along-axis coordinate, and how far past either end. */
  const timeAtAlong = a => {
    const c = Math.max(lo, Math.min(hi, a));
    const f = dir > 0 ? (c - lo) / (hi - lo) : (hi - c) / (hi - lo);
    const i = Math.max(0, Math.min(points.length - 2, Math.floor(f * (points.length - 1))));
    const pa = points[i], pb = points[i + 1];
    const u = clamp01((c - pa.along) / ((pb.along - pa.along) || 1e-6));
    return { timeMs: lerp(pa.timeMs, pb.timeMs, u), beyondM: Math.max(lo - a, a - hi, 0) };
  };
  return { points, lengthM: total, durationMs: n * stepMs, arcAtTime, pointAtArc, timeAtAlong };
}

/** Local maxima of a series above a floor, at least `gap` steps apart. */
function maxima(series, floor, gap) {
  const found = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] < floor || series[i] < series[i - 1] || series[i] < series[i + 1]) continue;
    if (found.length && i - found.at(-1) < gap) {
      if (series[i] > series[found.at(-1)]) found[found.length - 1] = i;
      continue;
    }
    found.push(i);
  }
  return found;
}

function songPasses(song, spine) {
  const passes = [], stepMs = song.stepMs;
  // Changes: a cross ridge over the spine, crossed at a col.
  for (const i of maxima(song.novelty, .55, 8)) {
    const t = i * stepMs;
    const arc = spine.arcAtTime(t);
    if (arc < 1500 || arc > spine.lengthM - 1500) continue;
    const p = spine.pointAtArc(arc);
    passes.push({ x: p.x, z: p.z, tx: p.tx, tz: p.tz, arc, timeMs: t, h: .75 + .45 * song.novelty[i] });
  }
  return passes;
}

/** Uplift of a sea of peaks laid out along the song spine. */
function peakUpliftAt(field, design, massifs, halfM, x, z) {
  const { ground, east, north, song } = field;
  const spine = design.spine;
  const along = x * east + z * north, across = z * east - x * north;
  const { timeMs, beyondM } = spine.timeAtAlong(along);
  const d = across - axisAcross(design, along, halfM);
  const loud = seriesAt(song.loudness, song.stepMs, timeMs);
  // A background sea of jittered summits everywhere.
  let sea = 0;
  const P = 3400, gx = Math.floor(x / P), gz = Math.floor(z / P);
  for (let j = gz - 1; j <= gz + 1; j++) for (let i = gx - 1; i <= gx + 1; i++) {
    const px = (i + .15 + .7 * unit(ground, 500 + i, j)) * P, pz = (j + .15 + .7 * unit(ground, 900 + i, j)) * P;
    const tall = .35 + .65 * unit(ground, 1300 + i, j) ** .7;
    const q = Math.hypot(x - px, z - pz) / (1300 + 900 * unit(ground, 1700 + i, j));
    sea = Math.max(sea, tall * Math.exp(-(q ** 1.6)));
  }
  let u = .5 + .55 * sea + .15 * (fbm(ground ^ 0x2c1b, x / 7000, z / 7000, 3) - .5);
  // The corridor the flight threads: narrow when quiet, wider when loud.
  const width = lerp(420, 900, loud) * (1 + beyondM / 4000);
  let col = 0;
  for (const pass of design.passes) {
    const ds = (along - (pass.x * east + pass.z * north)) / 1300;
    const w = Math.exp(-ds * ds) * Math.exp(-((d / 9000) ** 2));
    col = Math.max(col, w);
    u = Math.max(u, (.45 + pass.h * (1 - .65 * Math.exp(-((d / 750) ** 2)))) * Math.exp(-ds * ds) * Math.exp(-((d / 9000) ** 4)));
  }
  const vq = d / width;
  u -= .32 * Math.exp(-vq * vq) * (1 - .6 * col);
  for (const m of massifs) {
    const q = Math.hypot(x - m.x, z - m.z) / m.radiusM;
    u = Math.max(u, (.75 + .3 * m.weight) * Math.exp(-q * q));
  }
  return Math.max(.03, u);
}

function upliftAt(field, design, massifs, halfM, x, z) {
  if (design.peaks) return peakUpliftAt(field, design, massifs, halfM, x, z);
  const { ground, skyline, east, north } = field;
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
  const warp = (fbm(ground ^ 0x51ed27, along / 21000, across / 21000, 3) - .5) * 5200;
  let range = 0;
  for (const side of [-1, 1]) {
    const r = (d + warp - side * design.rangeOffsetM) / design.rangeHalfM;
    const crest = .4 + .6 * skylineAt(skyline, side < 0 ? s : 1 - s);
    const saddle = smooth((fbm(ground ^ (side < 0 ? 0x7a3 : 0x9c1), along / 8000, across / 8000, 2) - .25) / .5);
    range = Math.max(range, Math.exp(-r * r) * crest * (.6 + .4 * saddle));
  }
  // The cross range the trunk breaks through, highest beside the gorge.
  const cross = gorge * (.75 + .25 * skylineAt(skyline, .5 + .5 * Math.tanh(d / 9000)));
  let u = .5 + .62 * Math.max(range, cross) + .2 * (fbm(ground ^ 0x2c1b, along / 6000, across / 6000, 3) - .5);
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
  let mouthCell = 0, mouthCost = Infinity;
  for (let i = 0; i < N; i++) {
    const x = xAt(i), z = zAt(i);
    U[i] = upliftAt(field, design, massifs, halfM, x, z);
    // Cell-scale roughness seeds a branching network instead of parallel
    // rills. It is the same fixed ground for every song. Erodibility lies in
    // the region's frame, like the uplift, so it turns with the region.
    const along = alongOf(field, x, z), across = acrossOf(field, x, z);
    h[i] = 4 * U[i] + 2.5 * unit(field.ground, 4000 + (i % n), Math.floor(i / n));
    Kmap[i] = .4 + .9 * fbm(field.ground ^ 0x6b1, along / 2600, across / 2600, 3);
    const gx = i % n, gz = Math.floor(i / n);
    if (gx === 0 || gz === 0 || gx === n - 1 || gz === n - 1) {
      const d = Math.abs(across - axisAcross(design, along, halfM));
      const cost = d + 4 * Math.max(0, .9 * halfM - design.flow * along);
      if (cost < mouthCost) { mouthCell = i; mouthCost = cost; }
    }
  }
  outlet[mouthCell] = 1; h[mouthCell] = 0;
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
    const salt = field.ground ^ Math.imul(it + 1, 0x632be5ab);
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

// An inside bank folds to a point where the bend radius drops below the
// channel's half-width. Relax just those turns and their immediate shoulders.
// Every moved station stays inside its original wet footprint. Both ends and
// all bed elevations are fixed; tributaries then join the finished parent.
export function roundChannelBends(points) {
  const n = points.length, origin = new Float64Array(n * 2), dirty = new Uint8Array(n);
  for (let i = 0; i < n; i++) { origin[2 * i] = points[i].x; origin[2 * i + 1] = points[i].z; }
  for (let pass = 0; pass < 48; pass++) {
    let changed = false;
    for (let j = 1; j < n - 1; j++) {
      const i = pass % 2 ? n - 1 - j : j;
      if (dirty[i] < pass) continue;
      const a = points[i - 1], p = points[i], b = points[i + 1];
      const ux = p.x - a.x, uz = p.z - a.z, vx = b.x - p.x, vz = b.z - p.z;
      const u = Math.hypot(ux, uz), v = Math.hypot(vx, vz);
      if (u === 0 || v === 0) continue;
      // Circumradius = |u| |v| |u+v| / (2 |u cross v|). Also unfold
      // reaches that have reversed direction on nearly the same line.
      const diameter = 2 * 1.4 * p.channelM;
      const limit = diameter * Math.abs(ux * vz - uz * vx);
      const product = u * v * Math.hypot(ux + vx, uz + vz);
      const reversed = ux * vx + uz * vz < 0;
      if (!reversed && product >= limit) continue;
      const gain = .7 * (reversed ? 1 : Math.min(1, 2 * (1 - product / limit)));
      const t = u / (u + v), x = origin[2 * i], z = origin[2 * i + 1];
      const dx = p.x + gain * (lerp(a.x, b.x, t) - p.x) - x;
      const dz = p.z + gain * (lerp(a.z, b.z, t) - p.z) - z;
      const scale = Math.min(1, .95 * p.channelM / (Math.hypot(dx, dz) || 1));
      const nextX = x + scale * dx, nextZ = z + scale * dz;
      if (Math.hypot(nextX - p.x, nextZ - p.z) < .01) continue;
      p.x = nextX; p.z = nextZ;
      dirty[i - 1] = dirty[i] = dirty[i + 1] = pass + 1;
      changed = true;
    }
    if (!changed) break;
  }
}

// Capture a larger channel only across low ground. A ridge between two
// nearby channels keeps both basins intact. Search is bounded in metres.
function valleyConfluence(cell, owner, { n, dx, h, area, rcv }, reliefM) {
  const x = cell % n, z = Math.floor(cell / n), next = rcv[cell];
  const vx = next % n - x, vz = Math.floor(next / n) - z;
  const radius = Math.max(1, Math.min(5, Math.floor(850 / dx)));
  let best = -1, bestDistance = Infinity;
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    const distance = dx * dx + dz * dz;
    if (!distance || distance > radius * radius || distance >= bestDistance) continue;
    const xx = x + dx, zz = z + dz;
    if (xx < 0 || zz < 0 || xx >= n || zz >= n) continue;
    const k = zz * n + xx;
    if (owner[k] < 0 || area[k] <= area[cell] || h[k] > h[cell] || reliefM * (h[cell] - h[k]) > 30) continue;
    const down = rcv[k];
    if (vx * (down % n - xx) + vz * (Math.floor(down / n) - zz) <= 0) continue;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    let previous = h[cell], open = true;
    for (let t = 1; t <= steps; t++) {
      const v = h[Math.round(z + dz*t/steps) * n + Math.round(x + dx*t/steps)];
      if ((v - previous) * reliefM > 1 || (v - h[cell]) * reliefM > 1) { open = false; break; }
      previous = v;
    }
    if (open) { best = k; bestDistance = distance; }
  }
  return best;
}

/** Trace channels from the routed lattice: heads to junctions, junctions to
 *  the outlet. Each polyline ends exactly on the point it joins. */
export function traceRivers(coarse, reliefM, baseM, riverAreaKm2) {
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
      const join = valleyConfluence(c, owner, coarse, reliefM);
      if (join >= 0) { joins = owner[join]; cells.push(join); break; }
      if (rcv[c] === c) break;
      c = rcv[c];
    }
    if (cells.length < 4) continue;
    for (const cell of cells) if (owner[cell] < 0) owner[cell] = rivers.length;
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

/** The spine as the region's one flown course: its floor follows the carved
 *  corridor and rises to each col, so the flight crests every change. */
function spineCourse(field, design, height, reliefM, floorM) {
  const { song } = field, spine = design.spine;
  const pts = spine.points.map(p => {
    const loud = seriesAt(song.loudness, song.stepMs, p.timeMs);
    return { x: p.x, z: p.z, timeMs: p.timeMs, ground: floorM + reliefM * height(p.x, p.z), loud,
      tension: seriesAt(song.tension, song.stepMs, p.timeMs) };
  });
  const n = pts.length;
  const lowest = pts.map((_, i) => {
    let m = Infinity;
    for (let k = -3; k <= 3; k++) m = Math.min(m, pts[Math.max(0, Math.min(n - 1, i + k))].ground);
    return m;
  });
  const bed = lowest.map((_, i) => {
    let sum = 0, w = 0;
    for (let k = -5; k <= 5; k++) { const j = Math.max(0, Math.min(n - 1, i + k)); sum += (6 - Math.abs(k)) * lowest[j]; w += 6 - Math.abs(k); }
    return sum / w - 12;
  });
  const points = pts.map((p, i) => ({ x: p.x, z: p.z, bed: bed[i], area: 0, timeMs: p.timeMs, tension: p.tension,
    channelM: 8, floorM: lerp(20, 70, p.loud), gorge: 1 - .3 * p.loud, broad: 0, relief: 0 }));
  return { id: 0, joins: null, trunk: true, flown: true, spine: true, areaKm2: 0, points };
}

/**
 * Build the sampled region.
 *   field    makeInlandTerrain result (outline, its shape, direction, relief)
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
  const { ground, east, north } = field;
  const flightCourse = design.peaks ? spineCourse(field, design, height, reliefM, floorM) : null;
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
    p.channelM = Math.min(92, 8 + 1.85 * Math.sqrt(p.area));
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
    if (n < 6 || river.spine) continue;
    // Follow the parent's moved junction, easing the tail onto it.
    const parent = river.joins !== null ? byId.get(river.joins) : null;
    if (parent && parent.points !== original.get(parent.id)) {
      const end = pts[n - 1], before = original.get(parent.id);
      let k = 0, best = Infinity;
      for (let i = 0; i < before.length; i++) {
        const d = Math.hypot(before[i].x - end.x, before[i].z - end.z);
        if (d < best) { best = d; k = i; }
      }
      const junction = parent.points[k];
      const dx = junction.x - end.x, dz = junction.z - end.z, dy = junction.bed - end.bed;
      let run = 0;
      const tail = new Float64Array(n);
      for (let i = n - 2; i >= 0; i--) { run += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z); tail[i] = run; }
      pts = pts.map((p, i) => { const w = smooth(1 - tail[i] / 1500); return { ...p, x: p.x + dx * w, z: p.z + dz * w, bed: p.bed + dy * w }; });
      for (let i = n - 2; i >= 0; i--) pts[i].bed = Math.max(pts[i].bed, pts[i + 1].bed);
    }
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    // Wavelength and phase follow where the river rises, in the region's
    // frame, not its index: a river that appears or drops out elsewhere
    // leaves every other river's meanders where they were.
    const headAlong = alongOf(field, pts[0].x, pts[0].z) / 9000, headAcross = acrossOf(field, pts[0].x, pts[0].z) / 9000;
    const total = arc[n - 1], wave = lerp(1300, 2300, valueNoise(ground ^ 0x300, headAlong, headAcross));
    const phase = valueNoise(ground ^ 0x400, headAlong, headAcross) * 50;
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
    roundChannelBends(moved);
    river.points = moved;
  }
  // The camera flies low along the trunk and its largest tributaries.
  const ranked = rivers.filter(r => !r.trunk && r.joins !== null).sort((a, b) => b.areaKm2 - a.areaKm2);
  for (const river of rivers) river.flown = river.trunk || ranked.indexOf(river) >= 0 && ranked.indexOf(river) < FLOWN_TRIBUTARIES;
  const index = segmentIndex(rivers, halfM);
  yield 'index';
  const hit = {};
  const nearest = (x, z) => {
    let best = Infinity, seg = null, tt = 0, wet = false;
    for (const sg of index.at(x, z)) {
      const t = clamp01(((x - sg.a.x) * sg.dx + (z - sg.a.z) * sg.dz) * sg.inv);
      const px = sg.a.x + t * sg.dx - x, pz = sg.a.z + t * sg.dz - z;
      const d2 = px * px + pz * pz;
      // A wide receiving channel can cover the dry shoulder of its nearer
      // tributary. Where both are wet, retain the closer routed bed.
      const halfWidth = lerp(sg.a.channelM, sg.b.channelM, t);
      const inside = d2 < halfWidth * halfWidth;
      if (inside && !wet || inside === wet && d2 < best) { best = d2; seg = sg; tt = t; wet = inside; }
    }
    hit.d = Math.sqrt(best); hit.seg = seg; hit.t = tt;
    return hit;
  };
  const smin = (a, b, k) => {
    const hh = clamp01(.5 + .5 * (b - a) / k);
    return lerp(b, a, hh) - k * hh * (1 - hh);
  };
  const region = {
    version: INLAND_REGION_VERSION, design, rivers, flightCourse, coarse, reliefM, floorM, halfM,
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
        // The bank-distance atlas resolves the course at its own width.
        const bankDistance = Math.max(0, d - channel);
        const edge = Math.max(channel + 1, floorHalf + (valueNoise(field.ground ^ 0x77,
          alongOf(field, x, z) / 700, acrossOf(field, x, z) / 700) - .5) * .6 * (floorHalf - channel));
        // Inland water is painted directly on this surface. Keep its
        // cross-section level and its longitudinal profile on the routed
        // bed. Ease the dry bank into the surrounding eroded floor.
        wet = d < channel;
        const wallTan = lerp(lerp(.55, .22, broad), 1.7, gorge);
        const target = d <= edge ? bed + 6 * (bankDistance / (edge - channel)) ** 2
          : bed + 6 + (d - edge) * wallTan;
        const k = lerp(30, 8, gorge);
        ground = lerp(target, smin(base, target, k), smooth(bankDistance / 160));
        floorMask = 1 - smooth((d - edge) / 160);
        flow = wet ? REGION_RIVER_FLOW : Math.round(REGION_MAX_DRY_FLOW
          * clamp01(1 - bankDistance / (500 + 25 * Math.sqrt(lerp(a.area, b.area, t)))) ** 1.5);
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
        const along = alongOf(field, x, z), across = acrossOf(field, x, z);
        detail = rough * (62 * (ridged(ground ^ 0x3d, u, v, 2) - .4) + 48 * (fbm(ground ^ 0x5e, along / 1100, across / 1100, 3) - .5)
          + 14 * (valueNoise(ground ^ 0x9a, along / 260, across / 260) - .5));
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
      if (design.peaks) {
        // The walls the flight passes keep the finest mesh: 3 within
        // reach of the slot, 2 for the faces behind it.
        let best = Infinity;
        const pts = flightCourse.points;
        for (const p of pts) {
          const dx = Math.max(x0 - p.x, 0, p.x - x1), dz = Math.max(z0 - p.z, 0, p.z - z1);
          best = Math.min(best, Math.hypot(dx, dz));
        }
        return best < 1400 ? 3 : best < 3600 ? 2 : best < 7000 ? 1 : 0;
      }
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
  region.boundsM = [floorM - MAX_DETAIL_M - 12, floorM + reliefM * top + MAX_DETAIL_M];
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
  const spineRiver = region.flightCourse;
  if (spineRiver) {
    const course = [];
    for (const [i, p] of spineRiver.points.entries()) if (i % 3 === 0 || i === spineRiver.points.length - 1)
      course.push([r1(p.x + cx), r1(p.z + cz), r1(p.bed), Math.round(p.timeMs)]);
    const passes = region.design.passes.map(p => ({ x: r1(p.x + cx), z: r1(p.z + cz), timeMs: Math.round(p.timeMs) }));
    return { version: INLAND_REGION_VERSION, rivers, confluences, gorges: runs('gorge', .55, 'gorge'), broadReaches: runs('broad', .45, 'broad'), passes: [],
      spine: { durationMs: region.design.spine.durationMs, course, passes } };
  }
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
