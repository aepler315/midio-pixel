// A bankfull flow and two grain classes routed once through the generated
// watershed. Water and sediment move head to mouth. The longitudinal water
// profile is pinned at every confluence, including when a bedrock sill
// concentrates a reach's available fall into one lip and plunge pool.
import { clamp01, lerp } from '../../utils/math.js';

const G = 9.81, WATER_DENSITY = 1000, GRAIN_DENSITY = 2650;
const smooth = t => { const v = clamp01(t); return v * v * (3 - 2 * v); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const runoff = field => .033 + .045 * (field?.character?.activity ?? .5) + .025 * (field?.character?.relief ?? .5);

function halfWidth(point, q) {
  const confinement = clamp01(point.gorge ?? 0), floodplain = clamp01(point.broad ?? 0);
  const width = Math.hypot(10, (6 + 5.5 * Math.sqrt(q)) * (1 + .26 * floodplain - .34 * confinement));
  return width > 90 ? 90 + 55 * Math.log1p((width - 90) / 55) : width;
}

/** Bankfull half-width in metres before the final bend relaxation. */
export function riverHalfWidthM(point, field) {
  return halfWidth(point, Math.max(0, point.area) * runoff(field));
}

function stationAt(arc, s) {
  let lo = 0, hi = arc.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arc[mid] < s) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function junctionIndex(points, end) {
  let best = 0, d2 = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].x - end.x) ** 2 + (points[i].z - end.z) ** 2;
    if (!d) return i;
    if (d < d2) { best = i; d2 = d; }
  }
  return best;
}

// Use the same differential erodibility that cut the channel. Old or test
// courses can still infer exposure from their relief and valley confinement.
function resistance(p, field) {
  const rugged = field?.character?.ruggedness ?? .5;
  const lithology = Number.isFinite(p.erodibility) ? clamp01((1.21 - p.erodibility) / .69)
    : clamp01(.35 + .25 * (p.gorge ?? 0) + .3 * (p.relief ?? 0) / (260 + (p.relief ?? 0)));
  return clamp01(.14 + .54 * lithology + .24 * rugged + .19 * (p.gorge ?? 0));
}

function reachSlopes(points, arc) {
  return points.map((p, i) => {
    const span = Math.max(90, 2.2 * p.channelM);
    const a = stationAt(arc, arc[i] - span), b = stationAt(arc, arc[i] + span);
    return Math.max(0, (points[a].bed - points[b].bed) / Math.max(1, arc[b] - arc[a]));
  });
}

// A finite resistant ledge takes part of a reach's existing elevation loss.
// Both outside elevations stay fixed; the graded section below the toe
// receives scour. Interpolating positions then gives an actual surface drop.
function bedrockSteps(r, arc, pins, field) {
  const pts = r.points, candidates = [], falls = [];
  const fall = new Float32Array(pts.length), pool = new Float32Array(pts.length);
  for (let k = 1; k < pins.length; k++) {
    const start = pins[k - 1], end = pins[k];
    for (let i = start + 1; i < end - 1; i++) {
      const p = pts[i], w = p.channelM, span = Math.max(110, 2.4 * w);
      const a = stationAt(arc, arc[i] - span), b = stationAt(arc, arc[i + 1] + span);
      if (a < start || b > end || a >= i || b <= i + 1) continue;
      const run = arc[b] - arc[a], drop = pts[a].bed - pts[b].bed;
      const grade = drop / Math.max(1, run), hard = resistance(p, field);
      const lipLength = arc[i + 1] - arc[i];
      if (hard < .57 || grade < .012 || drop < 4 || lipLength < 3 || lipLength > 90) continue;
      const score = grade * hard * (.75 + .6 * (p.gorge ?? 0));
      candidates.push({ i, a, b, score, drop, hard });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.i - b.i);
  for (const { i, a, b, drop, hard } of candidates) {
    const p = pts[i], foot = pts[i + 1];
    if (falls.some(f => Math.abs(f.stationM - arc[i]) < Math.max(1150, 18 * p.channelM)
      || !(arc[b] < f.startM || arc[a] > f.endM))) continue;
    const lipM = pts[a].bed - .17 * drop, footM = lipM - (.48 + .23 * hard) * drop;
    const lengthM = arc[i + 1] - arc[i], dropM = lipM - footM;
    if (dropM < 2.5 || dropM / lengthM < .075) continue;
    const lower = pts[b].bed, upper = pts[a].bed;
    for (let j = a + 1; j <= i; j++) pts[j].bed = lerp(upper, lipM, (arc[j] - arc[a]) / (arc[i] - arc[a]));
    for (let j = i + 1; j < b; j++) {
      const u = (arc[j] - arc[i + 1]) / (arc[b] - arc[i + 1]);
      pts[j].bed = lerp(footM, lower, u * u);
      pool[j] = Math.min(7, .27 * dropM) * (1 - smooth(u));
    }
    fall[i] = fall[i + 1] = clamp01(.55 + dropM / 20);
    falls.push({ x: p.x, z: p.z, footX: foot.x, footZ: foot.z, lipM, footM, dropM, lengthM,
      widthM: 2 * p.channelM, stationM: arc[i], startM: arc[a], endM: arc[b] });
  }
  r.falls = falls.sort((a, b) => a.stationM - b.stationM);
  return { fall, pool };
}

// Meyer-Peter–Müller-style excess Shields bedload for a grain fraction:
// the threshold is dimensionless, and the converted capacity is kg/s.
function capacity(shearPa, diameterM, widthM, share) {
  const shields = shearPa / ((GRAIN_DENSITY - WATER_DENSITY) * G * diameterM);
  return 8 * Math.max(0, shields - .047) ** 1.5 * Math.sqrt(1.65 * G * diameterM ** 3) * widthM * GRAIN_DENSITY * share;
}

// A reach approaches capacity over a finite transport length. Entrainment
// is limited by erodible substrate; deposition cannot exceed incoming load.
function exchange(load, cap, distance, adaptM, availableKgS) {
  const delta = (cap - load) * -Math.expm1(-distance / adaptM);
  return delta > 0 ? Math.min(delta, availableKgS) : delta;
}

function bendAt(points, arc, i) {
  const p = points[i], span = Math.max(110, 3 * p.channelM);
  const a = points[stationAt(arc, arc[i] - span)], b = points[stationAt(arc, arc[i] + span)];
  const ax = p.x - a.x, az = p.z - a.z, bx = b.x - p.x, bz = b.z - p.z;
  const area = ax * bz - az * bx;
  return clamp(2 * area / Math.max(1, Math.hypot(ax, az) * Math.hypot(bx, bz)), -1, 1);
}

// Make a stable mid-channel deposit only when enough bedload has actually
// settled over this run. The two free side channels retain through-flow.
function formIslands(r, arc, deposits, pins) {
  const pts = r.points, islands = [];
  const cumulative = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cumulative[i] = cumulative[i - 1] + deposits[i];
  let next = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], h = p.hydro, w = p.channelM;
    if (arc[i] < next || w < 36 || h.slope > .009 || h.rapid > .35 || h.bankRock > .65 || Math.abs(h.barSide) > .55) continue;
    const broad = p.broad ?? 0, reach = (2.4 + .7 * broad) * w;
    const a = stationAt(arc, arc[i] - reach), b = stationAt(arc, arc[i] + reach);
    if (a === i || b === i || arc[i] - arc[a] < reach * .7 || arc[b] - arc[i] < reach * .7
      || pins.some(j => Math.abs(arc[i] - arc[j]) < 2.5 * reach)) continue;
    const settledKgS = cumulative[b] - cumulative[a];
    // Morphological integration over accumulated bankfull time (180 days),
    // using a bulk alluvium density of 1650 kg/m³. Retain 45% on the bar.
    const volumeM3 = settledKgS * (180 * 86400) * .45 / 1650;
    const fill = volumeM3 / (volumeM3 + w * w * (.6 + .5 * h.depthM));
    const fine = 1 / (1 + h.grainMm / 8);
    const halfWidthM = w * (.13 + .25 * fill + .045 * broad);
    const lengthScale = w * (.56 + 1.55 * fill + .38 * broad + .45 * fine);
    // Gravel settles close to the head of the bar. Finer load travels
    // further into the sheltered downstream tail before it settles.
    const noseM = lengthScale * (.86 - .22 * fine), tailM = lengthScale * (1.14 + .35 * fine);
    const tailTaper = .18 + .39 * fine;
    const footprintM2 = .5 * Math.PI * halfWidthM * (noseM + tailM * (1 - tailTaper / 4));
    const heightM = Math.min(3, 2 * volumeM3 / footprintM2 - h.depthM);
    if (heightM < .45) continue;
    const dx = pts[b].x - pts[a].x, dz = pts[b].z - pts[a].z, length = Math.hypot(dx, dz);
    if (length < 1.65 * reach) continue;
    const tx = dx / length, tz = dz / length;
    const offsetM = w * (.12 + .30 * fill) * (.5 * h.barSide + .25 * (pts[a].hydro.barSide + pts[b].hydro.barSide));
    const x = p.x - tz * offsetM, z = p.z + tx * offsetM;
    const rock = clamp01(h.bankRock * .4);
    const sand = (1 - rock) * clamp(.84 - .017 * h.grainMm, .18, .86);
    const island = { x, z, tx, tz, halfLengthM: Math.max(noseM, tailM), halfWidthM, noseM, tailM, tailTaper,
      heightM, offsetM, grainMm: h.grainMm, rock, sand, stationM: arc[i], settledKgS };
    // Keep a wet side channel along both flanks even if the river bends
    // after the crest. The head and tail taper into the local water.
    let fits = true;
    const lastAtBar = stationAt(arc, arc[i] + tailM);
    for (let j = stationAt(arc, arc[i] - noseM); j <= lastAtBar; j++) {
      const s = pts[j], along = (s.x - x) * tx + (s.z - z) * tz;
      const u = along / (along < 0 ? noseM : tailM);
      if (Math.abs(u) >= 1) continue;
      const across = -(s.x - x) * tz + (s.z - z) * tx;
      const span = halfWidthM * Math.sqrt(1 - u * u) * (along > 0 ? 1 - tailTaper * u * u : 1);
      const room = Math.min(riverWetHalfWidthM(s, s, 0, 1), riverWetHalfWidthM(s, s, 0, -1));
      if (Math.abs(across) + span > .78 * room) { fits = false; break; }
    }
    if (!fits) continue;
    islands.push(island);
    next = arc[i] + Math.max(1400, 30 * w);
  }
  r.islands = islands;
}

function route(r, tributaries, field, meetings) {
  const pts = r.points, n = pts.length, last = n - 1;
  const arc = new Float64Array(n), receipts = new Map();
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  for (const child of tributaries) {
    const i = junctionIndex(pts, child.points.at(-1)), s = child.sediment;
    meetings.set(child, i);
    const receipt = receipts.get(i) ?? { area: 0, fine: 0, coarse: 0 };
    receipt.area += s.areaKm2; receipt.fine += s.fineOutKgS; receipt.coarse += s.coarseOutKgS;
    receipts.set(i, receipt);
  }
  // Routed area already includes tributaries. Reserve the incoming basin
  // before introducing local runoff so a smoothed confluence cannot add a
  // child twice. At a snapped junction a new tributary may exceed the old
  // lattice estimate; its actual routed water still reaches the mouth.
  const areaLimit = r.areaKm2 ?? pts[last].area;
  const available = new Float64Array(n);
  const headArea = Math.min(pts[0].area, areaLimit);
  let ceiling = Infinity;
  for (let i = last; i >= 0; i--) {
    available[i] = Math.max(headArea, Math.min(ceiling, pts[i].area, areaLimit));
    ceiling = available[i] - (receipts.get(i)?.area ?? 0);
  }
  let area = 0;
  const local = new Float64Array(n), discharge = new Float64Array(n);
  const specificQ = runoff(field), rugged = field?.character?.ruggedness ?? .5;
  for (let i = 0; i < n; i++) {
    const p = pts[i], oldWidth = p.channelM ?? riverHalfWidthM(p, field);
    area += receipts.get(i)?.area ?? 0;
    local[i] = Math.max(0, available[i] - area); area += local[i];
    discharge[i] = specificQ * area;
    p.channelM = halfWidth(p, discharge[i]);
    p.floorM = Math.max(p.channelM + 1, (p.floorM ?? oldWidth * 3) * p.channelM / oldWidth);
  }
  const pins = [...new Set([0, ...receipts.keys(), last])].sort((a, b) => a - b);
  const { fall, pool } = bedrockSteps(r, arc, pins, field), slopes = reachSlopes(pts, arc);
  const deposits = new Float64Array(n);
  let fine = 0, coarse = 0, suppliedKgS = 0, erodedKgS = 0, depositedKgS = 0, incomingKgS = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = discharge[i], w = 2 * p.channelM, slope = slopes[i], hard = resistance(p, field);
    const distance = i ? arc[i] - arc[i - 1] : 0;
    const substrate = clamp01(.17 + .48 * hard + .3 * (p.gorge ?? 0) + 4 * slope - .32 * (p.broad ?? 0));
    const grain = .006 + .071 * substrate ** 2, nManning = .027 + .019 * substrate;
    const hydraulicDepth = Math.max(.08, (q * nManning / (w * Math.sqrt(Math.max(.00012, slope)))) ** .6);
    const velocityMps = q / (w * hydraulicDepth), shear = WATER_DENSITY * G * hydraulicDepth * slope;
    const receive = receipts.get(i);
    if (receive) { fine += receive.fine; coarse += receive.coarse; incomingKgS += receive.fine + receive.coarse; }
    const mantle = Math.max(0, p.colluviumM ?? 0);
    const supply = local[i] * specificQ * (.12 + .32 * rugged) * (1 + .7 * mantle / (1 + mantle));
    const fineShare = 1 - .68 * substrate;
    fine += supply * fineShare; coarse += supply * (1 - fineShare); suppliedKgS += supply;
    const fineCap = capacity(shear, .00065, w, fineShare), coarseCap = capacity(shear, grain, w, 1 - fineShare);
    const erodible = q * distance / Math.max(1500, 32 * w) * (.035 + .32 * (1 - substrate));
    const df = exchange(fine, fineCap, distance, 7 * w, erodible * fineShare);
    const dc = exchange(coarse, coarseCap, distance, 3 * w, erodible * (1 - fineShare));
    fine += df; coarse += dc;
    const deposited = Math.max(0, -df) + Math.max(0, -dc);
    deposits[i] = deposited; depositedKgS += deposited;
    erodedKgS += Math.max(0, df) + Math.max(0, dc);
    const depositing = clamp01(deposited / Math.max(.000001, q * distance / Math.max(100, 6 * w) * .18));
    const bankRock = clamp01(substrate + .16 * smooth(shear / 100) - .38 * depositing);
    const sandShare = deposited > 1e-8 ? Math.max(0, -df) / deposited : .5 * fineShare;
    const grainMm = lerp(.65, grain * 1000, clamp01(.32 * substrate + .68 * (1 - sandShare)));
    const froude = velocityMps / Math.sqrt(G * hydraulicDepth);
    const rapid = smooth((froude - .22) / .85) * smooth((slope - .0015) / .018) * (.38 + .62 * bankRock);
    const barSide = bendAt(pts, arc, i);
    const barStrength = clamp01((.75 * depositing + .25 * (p.broad ?? 0)) * (1 - rapid) * (1 - .5 * bankRock));
    p.hydro = { dischargeM3s: q, velocityMps, depthM: hydraulicDepth + pool[i], slope, grainMm, bankRock,
      barSide, barStrength, rapid, fall: fall[i], loadKgS: fine + coarse, capacityKgS: fineCap + coarseCap,
      depositionKgS: deposited, erosionKgS: Math.max(0, df) + Math.max(0, dc) };
  }
  r.sediment = { areaKm2: area, incomingKgS, suppliedKgS, erodedKgS, depositedKgS, fineOutKgS: fine, coarseOutKgS: coarse };
  formIslands(r, arc, deposits, pins);
}

/** Mutate completed routed courses once, upstream first. Returns watershed
 * fluxes (kg/s), excluding transfers internal to the network. */
export function simulateRiverbeds(rivers, field) {
  const children = new Map(rivers.map(r => [r.id, []]));
  const meetings = new Map();
  for (const r of rivers) if (children.has(r.joins)) children.get(r.joins).push(r);
  const totals = { suppliedKgS: 0, erodedKgS: 0, depositedKgS: 0, outletKgS: 0, outletDischargeM3s: 0 };
  function visit(r) {
    const donors = children.get(r.id);
    for (const child of donors) visit(child);
    route(r, donors, field, meetings);
    for (const key of ['suppliedKgS', 'erodedKgS', 'depositedKgS']) totals[key] += r.sediment[key];
  }
  // The river surface meets exactly at the routed confluence. Cut the
  // tributary's submerged thread into the receiving bed over its final
  // few widths, including nested joins near a mouth.
  function connectBeds(parent) {
    for (const child of children.get(parent.id)) {
      const mouth = child.points.at(-1), receiving = parent.points[meetings.get(child)];
      const delta = receiving.hydro.depthM - mouth.hydro.depthM, span = 3 * mouth.channelM;
      let distance = 0;
      for (let i = child.points.length - 1; i >= 0 && distance < span; i--) {
        const p = child.points[i];
        p.hydro.depthM = Math.max(.05, p.hydro.depthM + delta * (1 - smooth(distance / span)));
        if (i) distance += Math.hypot(p.x - child.points[i - 1].x, p.z - child.points[i - 1].z);
      }
      connectBeds(child);
    }
  }
  for (const r of rivers) if (!children.has(r.joins)) {
    visit(r);
    connectBeds(r);
    totals.outletKgS += r.sediment.fineOutKgS + r.sediment.coarseOutKgS;
    totals.outletDischargeM3s += r.points.at(-1).hydro.dischargeM3s;
  }
  return totals;
}

/** Positive inside a deposited bar. The head and tail have independent
 * runout; older symmetric island shapes use the same radius on both sides.
 * Dividing by the local gradient gives metres at the edge. */
export function riverIslandDistance(island, x, z) {
  const dx = x - island.x, dz = z - island.z;
  const along = dx * island.tx + dz * island.tz, across = dz * island.tx - dx * island.tz;
  const axis = (along < 0 ? island.noseM : island.tailM) ?? island.halfLengthM;
  const u = along / axis;
  const taper = along > 0 ? island.tailTaper ?? 0 : 0;
  const shape = 1 - taper * Math.min(1, u * u), v = across / (island.halfWidthM * shape);
  const radius = Math.hypot(u, v);
  if (radius < 1e-9) return island.halfWidthM;
  const du = u * (1 + (u < 1 ? 2 * taper * v * v / shape : 0)) / axis;
  const gradient = Math.hypot(du, v / (island.halfWidthM * shape)) / radius;
  return (1 - radius) / gradient;
}

/** Height above the water datum, fading to zero at the island's shoreline. */
export function riverIslandHeightM(island, x, z) {
  return island.heightM * smooth(riverIslandDistance(island, x, z) / island.halfWidthM);
}

function pointBar(a, b, t, side) {
  return Math.max(0, side * lerp(a.barSide, b.barSide, t)) * lerp(a.barStrength, b.barStrength, t);
}

export function riverWetHalfWidthM(a, b, t, side) {
  return lerp(a.channelM, b.channelM, t) * (1 - .38 * pointBar(a.hydro, b.hydro, t, side));
}

/** Actual cross section; positive lateral distance is left looking down the
 * channel. Signed edge distance includes the inside-bend point bar. Island
 * footprints are removed after nearby water footprints have been united. */
export function sampleRiverbed(a, b, t, lateralM, out = {}) {
  const A = a.hydro, B = b.hydro;
  const width = lerp(a.channelM, b.channelM, t), water = lerp(a.bed, b.bed, t);
  const barSide = lerp(A.barSide, B.barSide, t), bar = pointBar(A, B, t, Math.sign(lateralM));
  const radius = width * (1 - .38 * bar), d = Math.abs(lateralM), edge = radius - d;
  const bankRock = clamp01(lerp(A.bankRock, B.bankRock, t) - .44 * bar);
  const depth = lerp(A.depthM, B.depthM, t) * Math.max(0, 1 - (d / radius) ** 2) * (1 - .28 * barSide * clamp(lateralM / width, -1, 1));
  const barHeight = Math.min(Math.max(0, -edge), Math.max(0, width - radius)) * (.055 + .025 * bankRock);
  const bankHeight = Math.max(0, d - width) * (.08 + .32 * bankRock) + barHeight;
  const grainMm = lerp(A.grainMm, B.grainMm, t) * (1 - .68 * bar);
  const rock = clamp01(bankRock * (.5 + .5 * smooth(grainMm / 30)));
  const sand = (1 - rock) * clamp01(.72 - .025 * grainMm + .64 * bar);
  const rapid = lerp(A.rapid, B.rapid, t), fall = lerp(A.fall, B.fall, t);
  out.signedWetDistanceM = edge; out.waterM = water; out.bedM = water - depth + bankHeight;
  out.depthM = depth; out.barHeightM = barHeight; out.grainMm = grainMm; out.bankRock = bankRock;
  out.sand = sand; out.gravel = 1 - rock - sand; out.rock = rock; out.rapid = rapid; out.fall = fall;
  out.foam = clamp01(.8 * rapid + fall) * smooth(Math.max(0, edge) / Math.max(2, .28 * radius));
  return out;
}
