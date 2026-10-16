// Offline clearance envelopes and best safe through-passes. Forest is the
// same derived habitat as ForestCover.js, conservatively including its
// stand-scale height/slope jitter. Tour rendering caps tree height at 35 m.
import { validateDemGrid, waterMask } from './terrain-bake.mjs';
import { sampleHeight } from './terrain-source.mjs';
import { scoreEye } from './view-quality.mjs';
import { assignRoles } from './tour-roles.mjs';

const DEG = Math.PI / 180;
const RULES = { treelineM: 3100, forestFloorM: -100000, forestMaxSlopeDeg: 36, forestDensity: .7 };
const headingDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function deriveForest(grid, water, rules) {
  const forest = new Uint8Array(grid.heightsM.length), { width, height, heightsM: h, cellSizeM: cell } = grid;
  if (!(rules.forestDensity > 0)) return forest;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const i = r * width + c;
    if (h[i] > rules.treelineM + 110 || h[i] < rules.forestFloorM - 100) continue;
    const left = r * width + Math.max(0, c - 1), right = r * width + Math.min(width - 1, c + 1);
    const north = Math.max(0, r - 1) * width + c, south = Math.min(height - 1, r + 1) * width + c;
    const slope = Math.atan(Math.hypot((h[right] - h[left]) / Math.max(cell, (right - left) * cell),
      (h[south] - h[north]) / Math.max(cell, (south - north) / width * cell))) / DEG;
    if (slope > rules.forestMaxSlopeDeg + 3) continue;
    if (water?.[i] || water?.[left] || water?.[right] || water?.[north] || water?.[south]) continue;
    forest[i] = 1;
  }
  return forest;
}

// O(width*height) horizontal maximum, with one monotonically decreasing deque
// per row. Circular filtering then combines the appropriate row spans, using
// O(width*height*radius/cell) work and O(width*height) memory, not 5 km DEM discs.
function horizontalMax(source, width, height, halfSpan, result) {
  const queue = new Int32Array(width);
  for (let r = 0; r < height; r++) {
    const offset = r * width;
    let head = 0, tail = 0, added = -1;
    for (let c = 0; c < width; c++) {
      const right = Math.min(width - 1, c + halfSpan);
      while (added < right) {
        added++;
        while (head < tail && source[offset + queue[tail - 1]] <= source[offset + added]) tail--;
        queue[tail++] = added;
      }
      while (head < tail && queue[head] < c - halfSpan) head++;
      result[offset + c] = source[offset + queue[head]];
    }
  }
}

function circularMax(source, width, height, radiusM, cellM) {
  const out = new Float32Array(source.length).fill(-Infinity), horizontal = new Float32Array(source.length);
  const rowRadius = Math.min(height - 1, Math.floor(radiusM / cellM));
  let previousHalf = -1;
  for (let dz = 0; dz <= rowRadius; dz++) {
    const half = Math.min(width - 1, Math.floor(Math.sqrt(Math.max(0, radiusM ** 2 - (dz * cellM) ** 2)) / cellM));
    if (half !== previousHalf) { horizontalMax(source, width, height, half, horizontal); previousHalf = half; }
    for (let r = 0; r < height; r++) {
      const target = r * width, north = r - dz, south = r + dz;
      for (let c = 0; c < width; c++) {
        let maximum = out[target + c];
        if (north >= 0) maximum = Math.max(maximum, horizontal[north * width + c]);
        if (dz && south < height) maximum = Math.max(maximum, horizontal[south * width + c]);
        out[target + c] = maximum;
      }
    }
  }
  return out;
}

/** Uint16 decimetre envelopes. Widened filter radii cover DEM interpolation,
 *  the 60 m cell footprint and nearest-cell reconstruction at every position.
 *  Floor rounds upward, ceiling downward; runtime reads max/min of corners. */
export function buildClearanceField(grid, { cellM = 60, forestMask = null, water = null, rules = RULES,
  treesM = 35, slackM = 10, marginM = 40, ceilingM = 4700 } = {}) {
  const check = validateDemGrid(grid);
  if (!check.ok || grid.valid.some(v => !v) || !grid.heightsM.every(Number.isFinite)) throw new Error('Tour clearance requires complete finite DEM coverage');
  if (!(cellM > 0) || !(treesM >= 0) || !(slackM >= 0) || !(marginM >= 0) || !(ceilingM > 0)) throw new Error('Invalid clearance tunables');
  if (forestMask && forestMask.length !== grid.heightsM.length) throw new Error('Forest mask dimensions mismatch');
  const wet = water ?? waterMask(grid), forest = forestMask ?? deriveForest(grid, wet, { ...RULES, ...rules });
  const width = Math.floor((grid.width - 1) * grid.cellSizeM / cellM) + 1;
  const height = Math.floor((grid.height - 1) * grid.cellSizeM / cellM) + 1;
  if (width < 2 || height < 2) throw new Error('Clearance grid must have at least two cells per axis');
  const ground = new Float32Array(width * height), tree = new Float32Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    ground[r * width + c] = sampleHeight(grid, grid.originM[0] + c * cellM, grid.originM[1] + r * cellM);
  }
  // Every source vertex contributes, even the short remainder at the far
  // boundary. Coarse cells therefore cannot lose a narrow summit or stand.
  for (let r = 0; r < grid.height; r++) for (let c = 0; c < grid.width; c++) {
    const cc = Math.min(width - 1, Math.round(c * grid.cellSizeM / cellM));
    const rr = Math.min(height - 1, Math.round(r * grid.cellSizeM / cellM)), j = rr * width + cc, i = r * grid.width + c;
    ground[j] = Math.max(ground[j], grid.heightsM[i]);
    if (forest[i]) tree[j] = 1;
  }
  const footprintM = Math.SQRT2 * (cellM + grid.cellSizeM);
  const floorGround = circularMax(ground, width, height, 120 + footprintM, cellM);
  const floorTrees = circularMax(tree, width, height, 120 + footprintM, cellM);
  const highGround = circularMax(ground, width, height, 5000 + footprintM, cellM);
  let minimum = Infinity;
  for (let i = 0; i < ground.length; i++) {
    floorGround[i] += floorTrees[i] * treesM + slackM + marginM;
    minimum = Math.min(minimum, floorGround[i]);
  }
  const offsetY = Math.floor(minimum / 100) * 100, floor = new Uint16Array(ground.length), ceil = new Uint16Array(ground.length);
  for (let i = 0; i < ground.length; i++) {
    const low = Math.ceil((floorGround[i] - offsetY) * 10);
    const high = Math.floor((Math.min(ceilingM, Math.max(highGround[i] + 400, floorGround[i] + 600)) - offsetY) * 10);
    if (low < 0 || high < 0 || low > 65535 || high > 65535) throw new Error('Clearance height exceeds Uint16 quantization range');
    floor[i] = low; ceil[i] = high;
  }
  return { cellM, width, height, originM: [...grid.originM], offsetY, floor, ceil,
    treeHeightBoundM: treesM, slackM, marginM, filterFootprintM: footprintM };
}

/** Conservative at arbitrary positions, including interpolation midpoints. */
export function clearanceAt(field, x, z) {
  const c = (x - field.originM[0]) / field.cellM, r = (z - field.originM[1]) / field.cellM;
  if (!(c >= 0 && r >= 0 && c <= field.width - 1 && r <= field.height - 1)) return { floorY: NaN, ceilY: NaN };
  const cc = Math.min(Math.floor(c), field.width - 2), rr = Math.min(Math.floor(r), field.height - 2), i = rr * field.width + cc;
  let low = -Infinity, high = Infinity;
  for (const offset of [0, 1, field.width, field.width + 1]) {
    low = Math.max(low, field.floor[i + offset] / 10 + field.offsetY);
    high = Math.min(high, field.ceil[i + offset] / 10 + field.offsetY);
  }
  return { floorY: low, ceilY: high };
}

export function stationFlyability(clearance, posM, yM) {
  const directions = [], step = Math.min(30, clearance.cellM / 2);
  for (let heading = 0; heading < 360; heading += 15) {
    let open = true, minimumSlack = Infinity;
    for (let k = 0; k <= Math.ceil(800 / step); k++) {
      const distance = Math.min(800, k * step);
      const b = clearanceAt(clearance, posM[0] + distance * Math.sin(heading * DEG), posM[1] - distance * Math.cos(heading * DEG));
      if (!Number.isFinite(b.floorY) || b.floorY > yM || b.ceilY < yM) { open = false; break; }
      minimumSlack = Math.min(minimumSlack, yM - b.floorY, b.ceilY - yM);
    }
    if (open) directions.push({ headingDeg: heading, slackM: minimumSlack });
  }
  const through = directions.filter(a => directions.some(b => headingDistance(a.headingDeg, b.headingDeg) >= 150));
  through.sort((a, b) => b.slackM - a.slackM || a.headingDeg - b.headingDeg);
  return { count: through.length, headingDeg: through[0]?.headingDeg ?? 0, directions: through.map(d => d.headingDeg) };
}

function stationCandidates(point) {
  const [x, height, z] = point.localM, result = [];
  const add = (px, pz, yM, ringM, offsetM, bearingDeg) => result.push({ posM: [px, pz], yM, ringM, offsetM, bearingDeg });
  if (['summit', 'subpeak', 'butte'].includes(point.type)) {
    for (const ring of [150, 300, 600, 1000, 1600]) for (let bearing = 0; bearing < 360; bearing += 15) for (const offset of [-250, -120, 0, 80, 200]) {
      add(x + ring * Math.sin(bearing * DEG), z - ring * Math.cos(bearing * DEG), height + offset, ring, offset, bearing);
    }
  } else if (point.type === 'col') for (const offset of [80, 150, 250]) add(x, z, height + offset, 0, offset, 0);
  else if (point.type === 'lake') {
    const radius = Math.sqrt((point.areaM2 || 20000) / Math.PI) * .6;
    for (const offset of [60, 150, 400]) {
      add(x, z, height + offset, 0, offset, 0);
      for (let bearing = 0; bearing < 360; bearing += 90) add(x + radius * Math.sin(bearing * DEG), z - radius * Math.cos(bearing * DEG), height + offset, radius, offset, bearing);
    }
  } else if (point.type === 'canyon') {
    const axis = point.canyonAxisDeg || 0;
    for (const distance of [-300, 0, 300]) for (const offset of [120, 250]) {
      add(x + distance * Math.sin(axis * DEG), z - distance * Math.cos(axis * DEG), null, Math.abs(distance), offset, axis);
    }
  }
  return result;
}

function rolePreference(point, candidate) {
  const { role } = point, { ringM: ring, offsetM: offset, bearingDeg: bearing } = candidate;
  if (role === 'drop' || role === 'chorus') return ring >= 300 && ring <= 600 && offset >= -120 && offset <= 80 ? 1 : 0;
  if (role === 'solo') return ring >= 150 && ring <= 300 ? 1 : .25;
  if (role === 'intro' || role === 'outro') return (point.type === 'lake' && offset >= 150) || (ring >= 1000 && offset >= 200) ? 1 : .15;
  if (role === 'breakdown') return offset <= -120 || offset <= 120 && !['summit', 'subpeak', 'butte'].includes(point.type) ? 1 : .3;
  if (role === 'bridge') return .3 + .7 * (1 + Math.cos(headingDistance(bearing, point.faceAspectDeg || 0) * DEG)) / 2;
  return 1;
}

export function chooseStations(grid, points, { clearance = null, forestMask = null, water = null, rules = RULES,
  scoreEyeFn = scoreEye, log = console.log, stationCache = null, boundaryMarginM = 0 } = {}) {
  clearance ??= buildClearanceField(grid, { forestMask, water, rules });
  const stats = { candidates: 0, belowFloor: 0, noThroughPass: 0, noView: 0 }, stations = [];
  const output = points.map(point => {
    if (point.tier === 'scenery') { const copy = { ...point }; delete copy.station; return copy; }
    const cacheKey = `${point.role}:${point.id}`;
    if (stationCache?.has(cacheKey)) {
      const cached = structuredClone(stationCache.get(cacheKey));
      stations.push({ pointId: point.id, ...cached });
      return { ...point, station: cached };
    }
    let best = null;
    for (const candidate of stationCandidates(point)) {
      const pref = rolePreference(point, candidate);
      if (!pref) continue;
      stats.candidates++;
      if (candidate.posM[0] < clearance.originM[0] + boundaryMarginM
        || candidate.posM[1] < clearance.originM[1] + boundaryMarginM
        || candidate.posM[0] > clearance.originM[0] + (clearance.width - 1) * clearance.cellM - boundaryMarginM
        || candidate.posM[1] > clearance.originM[1] + (clearance.height - 1) * clearance.cellM - boundaryMarginM) continue;
      const band = clearanceAt(clearance, ...candidate.posM);
      if (point.type === 'canyon') candidate.yM = band.floorY + candidate.offsetM;
      if (!Number.isFinite(band.floorY) || candidate.yM < band.floorY || candidate.yM > band.ceilY) { stats.belowFloor++; continue; }
      const fly = stationFlyability(clearance, candidate.posM, candidate.yM);
      if (fly.count < 2) { stats.noThroughPass++; continue; }
      if (point.type === 'lake' && water) {
        const c = Math.round((candidate.posM[0] - grid.originM[0]) / grid.cellSizeM), r = Math.round((candidate.posM[1] - grid.originM[1]) / grid.cellSizeM);
        if (!water[r * grid.width + c]) continue;
      }
      const view = scoreEyeFn(grid, points, [candidate.posM[0], candidate.yM, candidate.posM[1]], { water });
      if (!(view.score > 0)) { stats.noView++; continue; }
      const score = view.score * Math.min(1, fly.count / 8) * pref;
      if (!best || score > best.score) {
        const bestAim = { ...view }; delete bestAim.aims;
        best = { posM: candidate.posM, yM: candidate.yM, passHeadingDeg: fly.headingDeg,
          ringM: candidate.ringM, offsetM: candidate.offsetM, flyability: fly.count, bestAim, score };
      }
    }
    if (!best) throw Object.assign(new Error(`${point.name || point.id}: no safe station with a through pass and positive view score`),
      { code: 'TOUR_STATION_UNAVAILABLE', pointId: point.id, role: point.role });
    stationCache?.set(cacheKey, structuredClone(best));
    stations.push({ pointId: point.id, ...best });
    return { ...point, station: best };
  });
  log(`stations: ${stations.length}, ${stats.candidates} candidates; rejected ${stats.belowFloor} by clearance, ${stats.noThroughPass} by flyability, ${stats.noView} by view`);
  return { points: output, stations, clearance, stats };
}

/** Terrain-only roles precede station feasibility. Reject unusable pairs and
 * re-run the same spacing/spread-constrained assignment; never lower floors
 * or publish a pool with fewer than four primaries. Successful station scores
 * are memoized only inside this build, where terrain and scoring inputs stay
 * fixed. Incidental role/tier changes do not affect scoreEye. */
export function assignFlyableStations(grid, source, options = {}) {
  const clearance = options.clearance ?? buildClearanceField(grid, options);
  const excludedStationPairs = new Set(), rejections = [], stationCache = new Map();
  for (const p of source) for (const role of p.stationRejectedRoles || []) excludedStationPairs.add(`${role}:${p.id}`);
  for (;;) {
    const assigned = assignRoles(source, { grid, tunables: options.tunables, excludedStationPairs });
    try {
      const stations = chooseStations(grid, assigned.points, { ...options, clearance, stationCache });
      return { ...stations, roles: assigned.roles, roleStats: assigned.stats, rejections,
        points: stations.points.map(p => ({ ...p, stationRejectedRoles: [...excludedStationPairs]
          .filter(pair => pair.endsWith(`:${p.id}`)).map(pair => pair.slice(0, pair.indexOf(':'))) })) };
    } catch (error) {
      if (error.code !== 'TOUR_STATION_UNAVAILABLE') throw error;
      const pair = `${error.role}:${error.pointId}`;
      if (excludedStationPairs.has(pair)) throw error;
      // Grand Teton is binding for the drop pool; an unsafe Grand Teton must
      // reject the build, rather than disappear from the acceptance check.
      if (error.role === 'drop' && source.find(p => p.id === error.pointId)?.name === 'Grand Teton') throw error;
      excludedStationPairs.add(pair);
      rejections.push({ pointId: error.pointId, role: error.role, reason: error.message });
      options.log?.(`reassigning unsafe ${pair}`);
    }
  }
}
