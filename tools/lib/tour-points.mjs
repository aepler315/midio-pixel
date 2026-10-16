// Offline terrain point extraction for Teton Song Highway.
// Equal-height cells sweep by index: plateau components merge at zero
// prominence, leaving one deterministic peak when the prominence filter runs.
import { validateDemGrid, waterMask, fillDepressions, flowAccumulation } from './terrain-bake.mjs';
import { sampleHeight } from './terrain-source.mjs';

const ISOLATION_LIMIT_M = 20000;
const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const CARDINAL = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const TAU = 2 * Math.PI;

function disc(grid, x, z, radius, visit) {
  const { width, height, originM, cellSizeM: cell, heightsM: h, valid } = grid;
  const ca = Math.max(0, Math.ceil((x - radius - originM[0]) / cell));
  const cb = Math.min(width - 1, Math.floor((x + radius - originM[0]) / cell));
  const ra = Math.max(0, Math.ceil((z - radius - originM[1]) / cell));
  const rb = Math.min(height - 1, Math.floor((z + radius - originM[1]) / cell));
  for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) {
    const i = r * width + c, dx = originM[0] + c * cell - x, dz = originM[1] + r * cell - z;
    if (valid[i] && dx * dx + dz * dz <= radius * radius) visit(i, h[i]);
  }
}

function slopeAt(grid, i) {
  const { width, height, cellSizeM: cell, heightsM: h, valid } = grid;
  const x = i % width, y = Math.floor(i / width);
  const left = x > 0 && valid[i - 1] ? i - 1 : i, right = x + 1 < width && valid[i + 1] ? i + 1 : i;
  const north = y > 0 && valid[i - width] ? i - width : i, south = y + 1 < height && valid[i + width] ? i + width : i;
  const dx = left === right ? 0 : (h[right] - h[left]) / ((right - left) * cell);
  const dz = north === south ? 0 : (h[south] - h[north]) / ((south - north) / width * cell);
  return Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
}

/** Main crest: highest source sample in each 1 km north/south band. */
function crestLine(grid) {
  const { width, height, heightsM: h, valid, cellSizeM: cell, originM } = grid, bands = new Map();
  for (let r = 0; r < height; r++) {
    const band = Math.floor(r * cell / 1000);
    for (let c = 0; c < width; c++) {
      const i = r * width + c, previous = bands.get(band);
      if (valid[i] && (previous === undefined || h[i] > h[previous])) bands.set(band, i);
    }
  }
  return [...bands.values()].map(i => [originM[0] + i % width * cell, originM[1] + Math.floor(i / width) * cell]);
}

function crestRelation(x, z, crest) {
  let distance = Infinity, crestX = x;
  for (let i = 0; i < crest.length; i++) {
    const a = crest[i], b = crest[Math.min(i + 1, crest.length - 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(1, dx * dx + dz * dz)));
    const cx = a[0] + t * dx, cz = a[1] + t * dz, d = Math.hypot(x - cx, z - cz);
    if (d < distance) { distance = d; crestX = cx; }
  }
  return { distanceToCrestM: Number.isFinite(distance) ? distance : 0,
    side: distance <= 600 ? 'crest' : x >= crestX ? 'east' : 'west' };
}

function horizonProperties(grid, x, y, z) {
  const radius = 15000, step = 60;
  // Polar 60 m test grid. At the outer ring the arc spacing is <=60 m,
  // so the visibility area never relies on a handful of wide-angle rays.
  const bearings = Math.ceil(TAU * radius / step);
  let horizonSum = 0, count = 0, area = 0, truncated = false;
  for (let k = 0; k < bearings; k++) {
    const theta = TAU * (k + .5) / bearings, dx = Math.sin(theta), dz = -Math.cos(theta);
    let horizon = -Infinity;
    for (let d = step; d <= radius; d += step) {
      const h = sampleHeight(grid, x + dx * d, z + dz * d);
      if (!Number.isFinite(h)) { truncated = true; break; }
      const angle = Math.atan2(h - y, d);
      if (angle >= horizon) {
        const outer = Math.min(radius, d + step / 2), inner = d === step ? 0 : d - step / 2;
        area += Math.PI * (outer * outer - inner * inner) / bearings;
      }
      horizon = Math.max(horizon, angle);
    }
    if (Number.isFinite(horizon)) { horizonSum += horizon; count++; }
  }
  return { skyOpenness: count ? horizonSum / count : 0, viewshedKm2: area / 1e6,
    propertiesTruncated: truncated };
}

/** Terrain measurements shared by peaks, saddles, lakes and canyon points. */
export function pointProperties(grid, point, { water = null, crest = null } = {}) {
  const [x, elevation, z] = point.localM;
  let minimum = elevation, slopeSum = 0, slopeCount = 0, waterCells = 0, cells = 0;
  disc(grid, x, z, 2000, (i, h) => { minimum = Math.min(minimum, h); waterCells += water?.[i] ? 1 : 0; cells++; });
  disc(grid, x, z, 300, i => { slopeSum += slopeAt(grid, i); slopeCount++; });
  let ringSum = 0, ringCount = 0, faceAspectDeg = 0, bestDrop = -Infinity;
  for (let k = 0; k < 72; k++) {
    const theta = TAU * k / 72, h = sampleHeight(grid, x + 150 * Math.sin(theta), z - 150 * Math.cos(theta));
    if (Number.isFinite(h)) { ringSum += h; ringCount++; }
  }
  for (let k = 0; k < 16; k++) {
    const theta = TAU * k / 16;
    let sum = 0, n = 0;
    for (let j = -2; j <= 2; j++) for (let d = 100; d <= 500; d += 100) {
      const a = theta + j * TAU / 16 / 5, h = sampleHeight(grid, x + d * Math.sin(a), z - d * Math.cos(a));
      if (Number.isFinite(h)) { sum += (elevation - h) / d; n++; }
    }
    const drop = n ? sum / n : -Infinity;
    if (drop > bestDrop + 1e-10) { bestDrop = drop; faceAspectDeg = k * 360 / 16; }
  }
  return { relief2kmM: elevation - minimum, sharpness: ringCount ? (elevation - ringSum / ringCount) / 150 : 0,
    meanSlope300Deg: slopeCount ? slopeSum / slopeCount : 0, faceAspectDeg,
    ...crestRelation(x, z, crest || crestLine(grid)), ...horizonProperties(grid, x, elevation + 30, z),
    waterWithin2km: cells ? waterCells / cells : 0 };
}

/** Exact squared Euclidean distance to the dry cells surrounding a lake. */
function interiorDistances(mask, width, height) {
  const dist = new Float64Array(mask.length), max = width * width + height * height + 1;
  for (let y = 0; y < height; y++) {
    let last = -width;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) last = x;
      dist[i] = mask[i] ? Math.min(max, (x - last) ** 2) : 0;
    }
    last = 2 * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!mask[i]) last = x;
      dist[i] = Math.min(dist[i], (last - x) ** 2);
    }
  }
  const v = new Int32Array(height), crossings = new Float64Array(height + 1), f = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = dist[y * width + x];
    let k = 0; v[0] = 0; crossings[0] = -Infinity; crossings[1] = Infinity;
    for (let q = 1; q < height; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      while (s <= crossings[k]) {
        k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      }
      v[++k] = q; crossings[k] = s; crossings[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < height; q++) {
      while (crossings[k + 1] < q) k++;
      dist[q * width + x] = (q - v[k]) ** 2 + f[v[k]];
    }
  }
  return dist;
}

function lakePoints(grid, water) {
  const { width, height, cellSizeM: cell, originM, heightsM: h, valid } = grid;
  const seen = new Uint8Array(water.length), points = [];
  for (let seed = 0; seed < water.length; seed++) {
    if (!water[seed] || !valid[seed] || seen[seed]) continue;
    const component = [seed]; seen[seed] = 1;
    let sx = 0, sz = 0, shoreline = 0, minX = width, maxX = 0, minZ = height, maxZ = 0;
    for (let k = 0; k < component.length; k++) {
      const i = component[k], x = i % width, z = Math.floor(i / width);
      sx += x; sz += z; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      for (const [dx, dz] of CARDINAL) {
        const cx = x + dx, cz = z + dz, j = cz * width + cx;
        if (cx < 0 || cz < 0 || cx >= width || cz >= height || !water[j] || !valid[j]) { shoreline += cell; continue; }
        if (!seen[j]) { seen[j] = 1; component.push(j); }
      }
    }
    if (component.length * cell * cell < 20000) continue;
    const cx = sx / component.length, cz = sz / component.length;
    const centroid = Math.round(cz) * width + Math.round(cx), inside = component.includes(centroid);
    let index = centroid;
    if (!inside) {
      const bw = maxX - minX + 3, bh = maxZ - minZ + 3, mask = new Uint8Array(bw * bh);
      for (const i of component) mask[(Math.floor(i / width) - minZ + 1) * bw + i % width - minX + 1] = 1;
      const distances = interiorDistances(mask, bw, bh);
      let best = -1;
      for (const i of component) {
        const d = distances[(Math.floor(i / width) - minZ + 1) * bw + i % width - minX + 1];
        if (d > best || d === best && i < index) { best = d; index = i; }
      }
    }
    const x = originM[0] + (inside ? cx : index % width) * cell;
    const z = originM[1] + (inside ? cz : Math.floor(index / width)) * cell;
    const level = h[index];
    let surrounding = level, enclosed = 0;
    disc(grid, x, z, 3000, (i, hh) => { surrounding = Math.max(surrounding, hh); });
    for (let k = 0; k < 36; k++) {
      const angle = TAU * k / 36;
      let high = level;
      for (let d = 60; d <= 1500; d += 60) {
        const hh = sampleHeight(grid, x + d * Math.sin(angle), z - d * Math.cos(angle));
        if (Number.isFinite(hh)) high = Math.max(high, hh);
      }
      if (high - level >= 600) enclosed++;
    }
    points.push({ id: `lake-${seed}`, index, localM: [x, level, z], type: 'lake', elevationM: level,
      areaM2: component.length * cell * cell, shorelineM: shoreline, surroundingReliefM: surrounding - level,
      cirqueLake: enclosed >= 18, prominenceM: 0, prominenceTruncated: false,
      isolationM: 0, isolationCapped: false, parentId: null, keyColId: null });
  }
  return points;
}

function matchNames(points, names, elevationToleranceM) {
  const unmatchedNames = [];
  for (const name of names) {
    const peakName = ['PK', 'PKS', 'MT', 'MTS'].includes(name.featureCode);
    const types = peakName ? ['summit', 'subpeak', 'butte'] : ['LK', 'LKS'].includes(name.featureCode) ? ['lake']
      : ['GAP', 'PASS'].includes(name.featureCode) ? ['col'] : ['canyon'];
    let chosen = null, best = Infinity;
    if (name.localM?.length === 2 && name.localM.every(Number.isFinite)) for (const p of points) {
      if (!types.includes(p.type) || peakName && Number.isFinite(name.elevationM) && Math.abs(p.elevationM - name.elevationM) > elevationToleranceM) continue;
      const d = Math.hypot(p.localM[0] - name.localM[0], p.localM[2] - name.localM[1]);
      if (d <= 250 && d < best) { chosen = p; best = d; }
    }
    if (!chosen) { unmatchedNames.push(name); continue; }
    if (!chosen.name) Object.assign(chosen, { name: name.name, geonamesId: name.id, nameLonLat: name.lonLat || null,
      nameElevationM: name.elevationM ?? null,
      nameElevationDeltaM: Number.isFinite(name.elevationM) ? chosen.elevationM - name.elevationM : null });
    else (chosen.aliases ||= []).push({ name: name.name, geonamesId: name.id });
  }
  return unmatchedNames;
}

function canyonPoints(grid, water, hydrology) {
  const { width, height, heightsM: h, valid, cellSizeM: cell, originM } = grid, n = width * height;
  // Accumulation includes the contributing cells, so a smaller grid cannot
  // reach 2^12. Supplied accumulation also supports independently measured
  // fields and synthetic drainage fixtures.
  if (!hydrology?.accumulation && n < 4096) return [];
  const filled = hydrology?.downstream ? null : fillDepressions(h, valid, width, height);
  const accumulation = hydrology?.accumulation || flowAccumulation(filled, valid, width, height);
  const downstream = hydrology?.downstream || new Int32Array(n).fill(-1);
  if (accumulation.length !== n || downstream.length !== n) throw new Error('tour points flow grid length mismatch');
  if (!hydrology?.downstream) for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    let best = -1, drop = 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const cx = x + dx, cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const j = cy * width + cx;
      if (!valid[j]) continue;
      const d = (filled[i] - filled[j]) / Math.hypot(dx, dy);
      if (d > drop) { drop = d; best = j; }
    }
    downstream[i] = best;
  }
  const upstream = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const j = downstream[i];
    if (j < 0 || j >= n || !valid[i] || !valid[j]) continue;
    if (upstream[j] < 0 || accumulation[i] > accumulation[upstream[j]]) upstream[j] = i;
  }
  const traceSlope = (seed, links) => {
    let i = seed, distance = 0, slope = 0;
    const visited = new Set([i]);
    while (distance < 300) {
      const j = links[i];
      if (j < 0 || j >= n || !valid[j] || visited.has(j)) return null;
      visited.add(j);
      const length = Math.hypot(i % width - j % width, Math.floor(i / width) - Math.floor(j / width)) * cell;
      const take = Math.min(length, 300 - distance);
      slope += Math.atan2(Math.abs(h[i] - h[j]), length) * 180 / Math.PI * take;
      distance += take; i = j;
    }
    return slope / distance;
  };
  const breaks = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!valid[i] || water[i] || accumulation[i] < 4096) continue;
    const up = traceSlope(i, upstream), down = traceSlope(i, downstream);
    if (up !== null && down !== null && up > 20 && down < 8) breaks[i] = 1;
  }
  const points = [];
  for (let seed = 0; seed < n; seed++) {
    if (!breaks[seed]) continue;
    const queue = [seed]; breaks[seed] = 0;
    let index = seed;
    for (let k = 0; k < queue.length; k++) {
      const i = queue[k], x = i % width, y = Math.floor(i / width);
      if (accumulation[i] > accumulation[index] || accumulation[i] === accumulation[index] && i < index) index = i;
      for (const [dx, dy] of NEIGHBOURS) {
        const cx = x + dx, cy = y + dy, j = cy * width + cx;
        if (cx < 0 || cy < 0 || cx >= width || cy >= height || !breaks[j]) continue;
        breaks[j] = 0; queue.push(j);
      }
    }
    const next = downstream[index], dx = next % width - index % width, dz = Math.floor(next / width) - Math.floor(index / width);
    points.push({ id: `canyon-${index}`, index, type: 'canyon', elevationM: h[index],
      localM: [originM[0] + index % width * cell, h[index], originM[1] + Math.floor(index / width) * cell],
      canyonAxisDeg: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360, flowCells: accumulation[index],
      prominenceM: 0, prominenceTruncated: false, isolationM: 0, isolationCapped: false, parentId: null, keyColId: null });
  }
  return points;
}

/** Ties receive the same percentile; order never changes a point's score. */
export function percentileRanks(points, property) {
  const sorted = [...points].sort((a, b) => (a[property] || 0) - (b[property] || 0)), ranks = new Map();
  for (let a = 0; a < sorted.length;) {
    let b = a + 1;
    while (b < sorted.length && (sorted[b][property] || 0) === (sorted[a][property] || 0)) b++;
    const rank = sorted.length > 1 ? (a + b - 1) / 2 / (sorted.length - 1) : .5;
    for (let i = a; i < b; i++) ranks.set(sorted[i].id, rank);
    a = b;
  }
  return ranks;
}

function isolation(grid, index) {
  const { width, height, cellSizeM: cell, heightsM: h, valid } = grid;
  const x = index % width, y = Math.floor(index / width), level = h[index];
  let best = Infinity;
  const cap = Math.ceil(ISOLATION_LIMIT_M / cell);
  const visit = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return;
    const j = cy * width + cx;
    if (!valid[j] || h[j] <= level) return;
    const distance = Math.hypot(cx - x, cy - y) * cell;
    if (distance <= ISOLATION_LIMIT_M) best = Math.min(best, distance);
  };
  // A square-ring corner can be farther away than the next ring's midpoint.
  // Stop only once the next ring's lower distance bound exceeds the best.
  for (let r = 1; r <= cap && r * cell <= best; r++) {
    for (let dx = -r; dx <= r; dx++) {
      visit(x + dx, y - r); visit(x + dx, y + r);
    }
    for (let dy = -r + 1; dy < r; dy++) {
      visit(x - r, y + dy); visit(x + r, y + dy);
    }
    if (x - r <= 0 && x + r >= width - 1 && y - r <= 0 && y + r >= height - 1) break;
  }
  return { isolationM: Number.isFinite(best) ? best : ISOLATION_LIMIT_M,
    isolationCapped: !Number.isFinite(best) };
}

/** Highest-first 8-connected component sweep; no raster-sized JS objects. */
function prominencePeaks(grid) {
  const { width, height, heightsM: h, valid } = grid, count = width * height;
  const parent = new Int32Array(count).fill(-1), touchesEdge = new Uint8Array(count);
  let minimum = Infinity, n = 0;
  for (let i = 0; i < count; i++) if (valid[i]) { minimum = Math.min(minimum, h[i]); n++; }
  const sorted = new Uint32Array(n);
  for (let i = 0, k = 0; i < count; i++) if (valid[i]) sorted[k++] = i;
  sorted.sort((a, b) => h[b] - h[a] || a - b);
  const peaks = new Map();
  const rootOf = i => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (i !== root) { const next = parent[i]; parent[i] = root; i = next; }
    return root;
  };
  for (const i of sorted) {
    const x = i % width, y = Math.floor(i / width), roots = [];
    let edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    for (const [dx, dy] of NEIGHBOURS) {
      const cx = x + dx, cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const j = cy * width + cx;
      if (!valid[j]) edge = true;
      if (parent[j] < 0) continue;
      const root = rootOf(j);
      if (!roots.includes(root)) roots.push(root);
    }
    if (!roots.length) {
      parent[i] = i; touchesEdge[i] = +edge;
      peaks.set(i, { index: i, elevationM: h[i], prominenceM: null,
        prominenceTruncated: false, keyColIndex: null, parentPeakIndex: null });
      continue;
    }
    const winner = roots.reduce((a, b) => h[b] > h[a] || h[b] === h[a] && b < a ? b : a);
    parent[i] = winner;
    for (const root of roots) if (root !== winner) {
      const peak = peaks.get(root), plateauAlias = h[root] === h[i];
      const truncated = !plateauAlias && !!(touchesEdge[root] || edge);
      peak.plateauAlias = plateauAlias;
      peak.prominenceM = plateauAlias ? 0 : h[root] - (truncated ? minimum : h[i]);
      peak.prominenceTruncated = truncated;
      peak.keyColIndex = truncated || plateauAlias ? null : i;
      peak.parentPeakIndex = winner;
      parent[root] = winner;
      touchesEdge[winner] |= touchesEdge[root];
    }
    touchesEdge[winner] |= +edge;
  }
  for (const peak of peaks.values()) if (peak.prominenceM === null) {
    peak.prominenceM = peak.elevationM - minimum;
    peak.prominenceTruncated = true;
  }
  return { peaks, minimum };
}

/** Identify peaks and their key cols in the normalized local metric grid. */
export function findPoints(grid, { pMin = 15, isoMin = 120, names = [], hydrology = null, nameElevationToleranceM = 60 } = {}) {
  if (!(Number.isFinite(nameElevationToleranceM) && nameElevationToleranceM >= 0)) throw new Error('Invalid name elevation tolerance');
  const check = validateDemGrid(grid);
  if (!check.ok) throw new Error(`tour points DEM rejected: ${check.errors.join('; ')}`);
  if (!(pMin >= 0 && Number.isFinite(pMin) && isoMin >= 0 && isoMin <= ISOLATION_LIMIT_M)) throw new Error('bad peak thresholds');
  const { peaks: raw, minimum } = prominencePeaks(grid), kept = new Map();
  const position = index => [grid.originM[0] + index % grid.width * grid.cellSizeM, grid.heightsM[index],
    grid.originM[1] + Math.floor(index / grid.width) * grid.cellSizeM];
  for (const peak of raw.values()) {
    if (peak.plateauAlias || peak.prominenceM < pMin) continue;
    const iso = isolation(grid, peak.index);
    if (iso.isolationM < isoMin) continue;
    kept.set(peak.index, { id: `peak-${peak.index}`, index: peak.index, localM: position(peak.index),
      type: peak.prominenceM >= 150 ? 'summit' : 'subpeak', elevationM: peak.elevationM,
      prominenceM: peak.prominenceM, prominenceTruncated: peak.prominenceTruncated, ...iso,
      parentId: null, keyColId: null });
  }
  const cols = new Map();
  for (const [index, point] of kept) {
    const peak = raw.get(index);
    let parentIndex = peak.parentPeakIndex;
    while (parentIndex !== null && !kept.has(parentIndex)) parentIndex = raw.get(parentIndex).parentPeakIndex;
    if (parentIndex !== null) point.parentId = kept.get(parentIndex).id;
    if (peak.keyColIndex !== null && point.prominenceM >= 60) {
      const ci = peak.keyColIndex;
      point.keyColId = `col-${ci}`;
      if (!cols.has(ci)) cols.set(ci, { id: point.keyColId, index: ci, localM: position(ci), type: 'col',
        elevationM: grid.heightsM[ci], prominenceM: 0, prominenceTruncated: false,
        isolationM: 0, isolationCapped: false, parentId: point.parentId, keyColId: null });
    }
  }
  const water = hydrology?.water || waterMask(grid.heightsM, grid.valid, grid.width, grid.height);
  if (water.length !== grid.width * grid.height) throw new Error('tour points water mask length mismatch');
  const points = [...kept.values(), ...cols.values(), ...lakePoints(grid, water), ...canyonPoints(grid, water, hydrology)]
    .sort((a, b) => b.elevationM - a.elevationM || a.index - b.index);
  const crest = crestLine(grid);
  for (const p of points) {
    Object.assign(p, pointProperties(grid, p, { water, crest }));
    if (['summit', 'subpeak'].includes(p.type) && p.elevationM < 2500 && p.distanceToCrestM > 3000) p.type = 'butte';
  }
  const unmatchedNames = matchNames(points, names, nameElevationToleranceM);
  const nameHeightDiscrepancies = points.filter(p => Number.isFinite(p.nameElevationDeltaM) && Math.abs(p.nameElevationDeltaM) > 60)
    .map(p => ({ pointId: p.id, geonamesId: p.geonamesId, name: p.name,
      sourceElevationM: p.nameElevationM, demElevationM: p.elevationM, deltaM: p.nameElevationDeltaM }));
  const unmatchedProminentPeaks = unmatchedNames.filter(name => {
    if (!['PK', 'PKS', 'MT', 'MTS'].includes(name.featureCode) || !name.localM?.every(Number.isFinite)) return false;
    for (const peak of raw.values()) {
      if (peak.plateauAlias || peak.prominenceM < 30) continue;
      const local = position(peak.index);
      if (Math.hypot(local[0] - name.localM[0], local[2] - name.localM[1]) <= 250) return true;
    }
    return false;
  });
  for (const p of points) p.fame = p.name ? p.prominenceM >= 300 ? 1.5 : 1 : 0;
  const ranks = ['elevationM', 'prominenceM', 'relief2kmM', 'sharpness'].map(key => percentileRanks(points, key));
  let maximumG = 0;
  for (const p of points) {
    p.grandeur = (.35 * ranks[0].get(p.id) + .30 * ranks[1].get(p.id) + .20 * ranks[2].get(p.id) + .15 * ranks[3].get(p.id)) * (1 + .15 * p.fame);
    maximumG = Math.max(maximumG, p.grandeur);
  }
  for (const p of points) p.grandeur = maximumG ? p.grandeur / maximumG : 0;
  return { points, stats: { rawPeaks: [...raw.values()].filter(p => !p.plateauAlias).length, peaks: kept.size, cols: cols.size,
    lakes: points.filter(p => p.type === 'lake').length, canyons: points.filter(p => p.type === 'canyon').length,
    unmatchedNames, unmatchedProminentPeaks, nameElevationToleranceM, nameHeightDiscrepancies,
    truncatedPeaks: [...kept.values()].filter(p => p.prominenceTruncated).length,
    isolationCappedPeaks: [...kept.values()].filter(p => p.isolationCapped).length,
    windowMinM: minimum, inputNames: names.length } };
}
