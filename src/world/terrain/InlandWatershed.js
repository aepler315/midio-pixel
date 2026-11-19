import { clamp01, lerp } from '../../utils/math.js';
import { INLAND_MAX_DRY_FLOW, INLAND_RIVER_FLOW } from '../alpine/TerrainPackage.js';

const BUCKET_M = 1280;
const RIVER_MARGIN_M = 90;
const TRUNK_STEPS = 162;
const FEEDER_STEPS = 52;
const BANK_ASYMMETRY = .24;
const TWO_PI = 2 * Math.PI;
const ease = t => { const x = clamp01(t); return x * x * (3 - 2 * x); };

function unitHash(seed, key) {
  let bits = seed ^ Math.imul(key, 0x9e3779b1);
  bits = Math.imul(bits ^ bits >>> 16, 0x7feb352d);
  bits = Math.imul(bits ^ bits >>> 15, 0x846ca68b);
  return ((bits ^ bits >>> 16) >>> 0) / 4294967296;
}

function coordinates(field, bounds) {
  const { min, max } = bounds;
  const alongX = Math.abs(field.east) >= Math.abs(field.north);
  const flip = unitHash(field.seed, 19) > .5;
  return (along, cross) => {
    const u = flip ? 1 - along : along;
    return alongX ? [lerp(min[0], max[0], u), lerp(min[2], max[2], cross)]
      : [lerp(min[0], max[0], cross), lerp(min[2], max[2], u)];
  };
}

function songSample(field, u) {
  const index = clamp01(u) * (field.skyline.length - 1);
  const lo = Math.floor(index), hi = Math.min(lo + 1, field.skyline.length - 1);
  return lerp(field.skyline[lo], field.skyline[hi], ease(index - lo));
}

function makeRivers(field, baseM, bounds) {
  const { seed, reliefM } = field;
  const at = coordinates(field, bounds);
  const phase = key => TWO_PI * unitHash(seed, key);
  const turnA = phase(1), turnB = phase(3), turnC = phase(5), turnD = phase(17);
  const meander = u => .49 + .115 * Math.sin(TWO_PI * u + turnA)
    + .048 * Math.sin(TWO_PI * 2.4 * u + turnB) + .021 * Math.sin(TWO_PI * 5.6 * u + turnC)
    + .010 * Math.sin(TWO_PI * 11.3 * u + turnD)
    + .054 * (songSample(field, u) - .5);
  const bankBias = (t, phaseA, phaseB) => .65 * Math.sin(TWO_PI * 2.8 * t + phaseA)
    + .35 * Math.sin(TWO_PI * 7.2 * t + phaseB);
  const trunkBankA = phase(21), trunkBankB = phase(22);
  const mouthHeight = baseM + 36;
  const trunkDropM = 350 + 82 * unitHash(seed, 14);
  const trunkHeight = u => mouthHeight + trunkDropM * (1 - u) * (1 - .20 * u);
  const trunk = Array.from({ length: TRUNK_STEPS + 1 }, (_, i) => {
    const u = i / TRUNK_STEPS, [x, z] = at(u, meander(u));
    return { x, z, heightM: trunkHeight(u), halfWidthM: 132 + 121 * u + 28 * songSample(field, u),
      bankBias: bankBias(u, trunkBankA, trunkBankB) };
  });
  const heightScale = Math.min(2240, reliefM);
  const rivers = [{ id: 'trunk', joins: null, points: trunk, radiusM: 2520, wallM: .55 * heightScale }];
  const anchors = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const key = 30 + i * 7 + (side === 1 ? 111 : 0);
      const station = (side === 1 ? .191 : .143) + .128 * i + (unitHash(seed, key) - .5) * .026;
      const nearest = Math.round(station * TRUNK_STEPS);
      const uMouth = nearest / TRUNK_STEPS;
      const mouth = trunk[nearest];
      const headU = Math.max(.015, uMouth - lerp(.064, .106, unitHash(seed, key + 1)));
      const headOffset = lerp(.23, .39, unitHash(seed, key + 2));
      const branchTurn = phase(key + 3);
      const bendTurn = phase(key + 212), branchBankA = phase(key + 221), branchBankB = phase(key + 222);
      const branchWidthM = 136 + 19 * unitHash(seed, key + 5);
      const branch = Array.from({ length: FEEDER_STEPS + 1 }, (_, n) => {
        const t = n / FEEDER_STEPS;
        const bias = bankBias(t, branchBankA, branchBankB);
        if (n === FEEDER_STEPS) return { ...mouth, halfWidthM: branchWidthM, bankBias: bias };
        const u = lerp(headU, uMouth, t);
        const lateral = headOffset * (1 - t) * (1 + .17 * t);
        const envelope = Math.sin(Math.PI * t);
        const wiggle = .033 * Math.sin(TWO_PI * 2.45 * t + branchTurn) * envelope
          + .013 * Math.sin(TWO_PI * 5.05 * t + bendTurn) * envelope * envelope;
        const v = Math.max(.011, Math.min(.989, meander(u) + side * lateral + wiggle));
        const [x, z] = at(u, v);
        return { x, z, heightM: 0, halfWidthM: lerp(87, branchWidthM, t), bankBias: bias };
      });
      const grade = lerp(.0031, .0065, unitHash(seed, key + 4));
      for (let n = branch.length - 2; n >= 0; n--) {
        const down = branch[n + 1], up = branch[n];
        up.heightM = down.heightM + grade * Math.hypot(down.x - up.x, down.z - up.z);
      }
      const id = `tributary-${side < 0 ? 'left' : 'right'}-${i + 1}`;
      rivers.push({ id, joins: 'trunk', points: branch, radiusM: lerp(1620, 2200, unitHash(seed, key + 6)),
        wallM: heightScale * lerp(.4, .54, unitHash(seed, key + 5)) });
      if (i > 0 && i < 5) anchors.push({ id, kind: 'confluence', x: mouth.x, z: mouth.z });
      if (i === 2 || i === 4) {
        const { x, z } = branch[Math.round(.45 * FEEDER_STEPS)];
        anchors.push({ id: `gorge-${id}`, kind: 'gorge', x, z });
      }
    }
  }
  for (const [i, u] of [.1, .34, .67, .89].entries()) {
    const { x, z } = trunk[Math.round(u * TRUNK_STEPS)];
    anchors.push({ id: `gorge-${i + 1}`, kind: 'gorge', x, z });
  }
  return { rivers, anchors, mouthHeight };
}

function bucketIndex(rivers, bounds) {
  const x0 = bounds.min[0], z0 = bounds.min[2];
  const columns = Math.max(1, Math.ceil((bounds.max[0] - x0) / BUCKET_M));
  const rows = Math.max(1, Math.ceil((bounds.max[2] - z0) / BUCKET_M));
  const buckets = Array.from({ length: columns * rows }, () => []);
  const column = x => Math.max(0, Math.min(columns - 1, Math.floor((x - x0) / BUCKET_M)));
  const row = z => Math.max(0, Math.min(rows - 1, Math.floor((z - z0) / BUCKET_M)));
  for (const river of rivers) for (let i = 1; i < river.points.length; i++) {
    const a = river.points[i - 1], b = river.points[i], dx = b.x - a.x, dz = b.z - a.z;
    const length2 = dx * dx + dz * dz;
    if (length2 <= 0) continue;
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    const near = Math.min(a.z, b.z), far = Math.max(a.z, b.z);
    const radius = river.radiusM, maxRadius = radius * (1 + BANK_ASYMMETRY);
    const width = Math.max(a.halfWidthM, b.halfWidthM) + RIVER_MARGIN_M;
    const segment = { a, b, dx, dz, inverseLength2: 1 / length2, inverseLength: 1 / Math.sqrt(length2),
      radius, maxRadius2: maxRadius * maxRadius, wallM: river.wallM,
      left: left - width, right: right + width, near: near - width, far: far + width };
    for (let iz = row(near - maxRadius); iz <= row(far + maxRadius); iz++) {
      for (let ix = column(left - maxRadius); ix <= column(right + maxRadius); ix++) buckets[iz * columns + ix].push(segment);
    }
  }
  return { buckets, columns, column, row };
}

/** Deterministic connected watershed. Samples share continuous coordinates
 * and the exact confluence grades, regardless of scene tile stride. */
export function makeInlandWatershed(field, baseM, bounds) {
  const { rivers, anchors, mouthHeight } = makeRivers(field, baseM, bounds);
  const { buckets, columns, column, row } = bucketIndex(rivers, bounds);
  return {
    rivers, anchors, minHeightM: mouthHeight,
    /** Conservative narrow-band test for terrain LOD. */
    tileHasRiver(x0, z0, x1, z1) {
      for (let iz = row(z0); iz <= row(z1); iz++) {
        for (let ix = column(x0); ix <= column(x1); ix++) {
          if (buckets[iz * columns + ix].some(s => s.left <= x1 && s.right >= x0 && s.near <= z1 && s.far >= z0)) return true;
        }
      }
      return false;
    },
    sample(x, z, heightM, out = {}) {
      let carvedM = heightM, bankFloorM = -Infinity, wetHeightM = Infinity;
      let nearestM = Infinity, nearestWidthM = 0, damp = 0, nearLevel = null;
      let nearestBankM = 540;
      for (const { a, b, dx, dz, inverseLength2, inverseLength, radius, maxRadius2, wallM } of buckets[row(z) * columns + column(x)]) {
        const t = clamp01(((x - a.x) * dx + (z - a.z) * dz) * inverseLength2);
        const lat = x - (a.x + t * dx), lon = z - (a.z + t * dz);
        const distance2 = lat * lat + lon * lon;
        if (distance2 >= maxRadius2) continue;
        const distance = Math.sqrt(distance2);
        const widthM = lerp(a.halfWidthM, b.halfWidthM, t);
        const waterM = lerp(a.heightM, b.heightM, t);
        if (distance < nearestM) { nearestM = distance; nearestWidthM = widthM; nearLevel = waterM; }
        if (distance <= widthM) { wetHeightM = Math.min(wetHeightM, waterM); continue; }
        const bias = (dx * lon - dz * lat) * inverseLength / distance * lerp(a.bankBias, b.bankBias, t);
        const sideRadius = radius * (1 + BANK_ASYMMETRY * bias);
        if (distance >= sideRadius) continue;
        const wallHeight = wallM * (1 - .16 * bias);
        const bankDistance = distance - widthM;
        const bank = bankDistance / (sideRadius - widthM);
        // Bends stagger the low bench, inner escarpment and high bench between banks.
        const section = .10 * ease(bank / .13) + .66 * ease((bank - .23 - .07 * bias) / .32)
          + .24 * ease((bank - .64) / .36);
        const soil = Math.min(Math.max(heightM, waterM), waterM + wallHeight * section);
        const resultM = lerp(heightM, soil, 1 - ease((bank - .57) / .43));
        carvedM = Math.min(carvedM, resultM);
        if (bankDistance < nearestBankM) {
          nearestBankM = bankDistance;
          const firstBench = waterM + .10 * wallHeight * ease(bankDistance / 240);
          bankFloorM = heightM < firstBench ? lerp(heightM, firstBench, 1 - ease((bankDistance - 240) / 300)) : -Infinity;
        }
        damp = Math.max(damp, 1 - ease(bankDistance / 930));
      }
      const wet = wetHeightM !== Infinity;
      out.heightM = wet ? wetHeightM : Math.max(carvedM, bankFloorM);
      out.flowByte = wet ? INLAND_RIVER_FLOW : Math.round(INLAND_MAX_DRY_FLOW * damp);
      out.distanceM = nearestM;
      out.waterLevelM = wet ? wetHeightM : nearLevel;
      out.halfWidthM = nearestWidthM;
      return out;
    },
  };
}
