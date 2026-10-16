// Offline 2-D safe highway: directional A*, centripetal spline paths,
// minimum spanning tree plus greedy t-spanner, shared junctions and orbits.
import { clearanceAt, stationFlyability } from './tour-stations.mjs';
import { scoreEye } from './view-quality.mjs';

const DEG = Math.PI / 180, DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerpPoint = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const pathLength = points => points.reduce((sum, p, i) => sum + (i ? distance(points[i - 1], p) : 0), 0);

class Heap {
  items = [];
  push(item) {
    const a = this.items; let i = a.length; a.push(item);
    while (i) {
      const p = (i - 1) >> 1;
      if (a[p].priority < item.priority || a[p].priority === item.priority && a[p].key <= item.key) break;
      a[i] = a[p]; i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (!a.length) return first;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let c = i * 2 + 1;
      if (c + 1 < a.length && (a[c + 1].priority < a[c].priority || a[c + 1].priority === a[c].priority && a[c + 1].key < a[c].key)) c++;
      if (last.priority < a[c].priority || last.priority === a[c].priority && last.key <= a[c].key) break;
      a[i] = a[c]; i = c;
    }
    a[i] = last; return first;
  }
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points.map(p => p.slice(0, 2));
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), dx = points[b][0] - points[a][0], dz = points[b][1] - points[a][1], denominator = dx * dx + dz * dz;
    let maximum = tolerance, at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((points[i][0] - points[a][0]) * dx + (points[i][1] - points[a][1]) * dz) / Math.max(1e-12, denominator)));
      const d = distance(points[i], lerpPoint(points[a], points[b], t));
      if (d > maximum) { maximum = d; at = i; }
    }
    if (at >= 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]).map(p => p.slice(0, 2));
}

function centripetal(points) {
  const output = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p1 = points[i], p2 = points[i + 1];
    const p0 = i ? points[i - 1] : lerpPoint(p2, p1, 2);
    const p3 = i + 2 < points.length ? points[i + 2] : lerpPoint(p1, p2, 2);
    const t0 = 0, t1 = Math.sqrt(Math.max(.001, distance(p0, p1))), t2 = t1 + Math.sqrt(Math.max(.001, distance(p1, p2)));
    const t3 = t2 + Math.sqrt(Math.max(.001, distance(p2, p3))), count = Math.max(2, Math.ceil(distance(p1, p2) / 10));
    for (let k = 0; k < count; k++) {
      const t = t1 + (t2 - t1) * k / count;
      const a1 = lerpPoint(p0, p1, (t - t0) / (t1 - t0)), a2 = lerpPoint(p1, p2, (t - t1) / (t2 - t1)), a3 = lerpPoint(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerpPoint(a1, a2, (t - t0) / (t2 - t0)), b2 = lerpPoint(a2, a3, (t - t1) / (t3 - t1));
      output.push(lerpPoint(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  output.push(points[points.length - 1].slice(0, 2)); return output;
}

function resample(points, spacing = 25) {
  const out = [points[0].slice(0, 2)]; let cumulative = 0, next = spacing;
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    while (length > 0 && next <= cumulative + length) {
      out.push(lerpPoint(points[i - 1], points[i], (next - cumulative) / length)); next += spacing;
    }
    cumulative += length;
  }
  if (distance(out[out.length - 1], points[points.length - 1]) > .001) out.push(points[points.length - 1].slice(0, 2));
  return out;
}

export function minimumTurnRadius(samples) {
  let minimum = Infinity;
  for (let i = 1; i + 1 < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], c = samples[i + 1];
    const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (cross > 1e-7) minimum = Math.min(minimum, distance(a, b) * distance(b, c) * distance(a, c) / (2 * cross));
  }
  return minimum;
}

function roadSamples(points, clearance, marginM, turnRadiusM) {
  const xMin = clearance.originM[0] + marginM, zMin = clearance.originM[1] + marginM;
  const xMax = clearance.originM[0] + (clearance.width - 1) * clearance.cellM - marginM;
  const zMax = clearance.originM[1] + (clearance.height - 1) * clearance.cellM - marginM;
  const samples = [];
  for (const [x, z] of points) {
    if (x < xMin || x > xMax || z < zMin || z > zMax) return { reason: '1 km margin' };
    const band = clearanceAt(clearance, x, z);
    if (!Number.isFinite(band.floorY) || !Number.isFinite(band.ceilY) || band.ceilY - band.floorY < 150) return { reason: 'vertical band below 150 m' };
    samples.push([x, z, band.floorY, band.ceilY]);
  }
  const radius = minimumTurnRadius(samples);
  if (radius < turnRadiusM) return { reason: `turn radius ${radius.toFixed(1)} m` };
  return { samples, lengthM: pathLength(samples), minTurnRadiusM: Number.isFinite(radius) ? radius : null };
}

export function smoothRoad(points, { clearance, turnRadiusM = 400, marginM = 1000, log = () => {} } = {}) {
  const unique = points.filter((p, i) => !i || distance(points[i - 1], p) > .001);
  if (unique.length < 2) return null;
  let failure;
  for (const tension of [0, .25, .5, .75]) {
    let controls = simplify(unique, 30 / (1 - tension));
    if (tension) {
      for (let pass = 0; pass < 2; pass++) controls = controls.map((p, i) => i && i + 1 < controls.length
        ? lerpPoint(p, lerpPoint(controls[i - 1], controls[i + 1], .5), tension) : p);
    }
    const checked = roadSamples(resample(centripetal(controls)), clearance, marginM, turnRadiusM);
    if (checked.samples) return checked;
    failure = checked.reason;
  }
  log(`Dropped road: ${failure}`); return null;
}

class NavigationGrid {
  constructor(clearance, { navCellM = 100, marginM = 1000, turnCostM = 30 } = {}) {
    this.cell = navCellM; this.turnCost = turnCostM;
    this.origin = clearance.originM.map(n => n + marginM);
    this.width = Math.floor(((clearance.width - 1) * clearance.cellM - 2 * marginM) / navCellM) + 1;
    this.height = Math.floor(((clearance.height - 1) * clearance.cellM - 2 * marginM) / navCellM) + 1;
    if (this.width < 2 || this.height < 2) throw new Error('Highway needs a grid wider than its 1 km margin');
    this.floor = new Float32Array(this.width * this.height); this.valid = new Uint8Array(this.floor.length);
    this.gradient = new Float32Array(this.floor.length);
    for (let r = 0; r < this.height; r++) for (let c = 0; c < this.width; c++) {
      const b = clearanceAt(clearance, this.origin[0] + c * navCellM, this.origin[1] + r * navCellM), i = r * this.width + c;
      this.floor[i] = b.floorY; this.valid[i] = Number.isFinite(b.floorY) && b.ceilY - b.floorY >= 150 ? 1 : 0;
    }
    for (let r = 0; r < this.height; r++) for (let c = 0; c < this.width; c++) {
      const i = r * this.width + c, value = this.floor[i];
      const left = c ? this.floor[i - 1] : value, right = c + 1 < this.width ? this.floor[i + 1] : value;
      const up = r ? this.floor[i - this.width] : value, down = r + 1 < this.height ? this.floor[i + this.width] : value;
      this.gradient[i] = Math.hypot((right - left) / (2 * navCellM), (down - up) / (2 * navCellM));
    }
  }
  search(start, goal, paddingM = 2000) {
    const sc = Math.round((start[0] - this.origin[0]) / this.cell), sr = Math.round((start[1] - this.origin[1]) / this.cell);
    const gc = Math.round((goal[0] - this.origin[0]) / this.cell), gr = Math.round((goal[1] - this.origin[1]) / this.cell);
    if ([sc, gc].some(c => c < 0 || c >= this.width) || [sr, gr].some(r => r < 0 || r >= this.height)) return null;
    if (sc === gc && sr === gr) return [start, goal];
    const pad = Math.ceil(paddingM / this.cell), c0 = Math.max(0, Math.min(sc, gc) - pad), r0 = Math.max(0, Math.min(sr, gr) - pad);
    const c1 = Math.min(this.width - 1, Math.max(sc, gc) + pad), r1 = Math.min(this.height - 1, Math.max(sr, gr) + pad), width = c1 - c0 + 1;
    const states = width * (r1 - r0 + 1) * 8, costs = new Float64Array(states).fill(Infinity), parents = new Int32Array(states).fill(-1), heap = new Heap();
    const keyAt = (c, r, direction) => ((r - r0) * width + c - c0) * 8 + direction;
    for (let k = 0; k < 8; k++) {
      const key = keyAt(sc, sr, k); costs[key] = 0;
      heap.push({ key, cost: 0, priority: Math.hypot(sc - gc, sr - gr) * this.cell });
    }
    let end = -1;
    while (heap.items.length) {
      const entry = heap.pop(), local = entry.key >> 3, direction = entry.key & 7;
      if (entry.cost > costs[entry.key]) continue;
      const c = c0 + local % width, r = r0 + Math.floor(local / width), i = r * this.width + c;
      if (c === gc && r === gr) { end = entry.key; break; }
      for (let k = 0; k < 8; k++) {
        const [dc, dr] = DIRS[k], cc = c + dc, rr = r + dr;
        if (cc < c0 || cc > c1 || rr < r0 || rr > r1) continue;
        const j = rr * this.width + cc;
        if (!this.valid[j] || !this.valid[i]) continue;
        // A diagonal cannot cut through an inadmissible corner cell.
        if (dc && dr && (!this.valid[r * this.width + cc] || !this.valid[rr * this.width + c])) continue;
        const ds = Math.hypot(dc, dr) * this.cell, turn = Math.min(Math.abs(k - direction), 8 - Math.abs(k - direction)) * 45 * DEG;
        const gradient = (this.gradient[i] + this.gradient[j]) / 2;
        const step = ds * (1 + 2 * Math.max(0, gradient - .25)) + .5 * Math.max(0, this.floor[j] - this.floor[i]) + this.turnCost * turn * turn;
        const cost = entry.cost + step, key = keyAt(cc, rr, k);
        if (cost < costs[key]) {
          costs[key] = cost; parents[key] = entry.key;
          heap.push({ key, cost, priority: cost + Math.hypot(cc - gc, rr - gr) * this.cell });
        }
      }
    }
    if (end < 0) return null;
    const reversed = [];
    for (let key = end; key >= 0; key = parents[key]) {
      const local = key >> 3, c = c0 + local % width, r = r0 + Math.floor(local / width);
      reversed.push([this.origin[0] + c * this.cell, this.origin[1] + r * this.cell]);
    }
    reversed.reverse(); reversed[0] = start; reversed[reversed.length - 1] = goal;
    return reversed;
  }
}

function graphDistances(nodes, edges, start) {
  const adjacency = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) { adjacency.get(e.a)?.push([e.b, e.lengthM]); adjacency.get(e.b)?.push([e.a, e.lengthM]); }
  const distances = new Map(nodes.map(n => [n.id, Infinity])), heap = new Heap(); distances.set(start, 0);
  heap.push({ key: start, priority: 0 });
  while (heap.items.length) {
    const { key, priority } = heap.pop(); if (priority > distances.get(key)) continue;
    for (const [next, length] of adjacency.get(key) || []) if (priority + length < distances.get(next)) {
      distances.set(next, priority + length); heap.push({ key: next, priority: priority + length });
    }
  }
  return distances;
}

function unionFind(ids) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = id => { let root = id; while (parent.get(root) !== root) root = parent.get(root); while (id !== root) { const next = parent.get(id); parent.set(id, root); id = next; } return root; };
  return { find, join: (a, b) => { a = find(a); b = find(b); if (a === b) return false; parent.set(b, a); return true; } };
}

export function mergeStations(points, clearance, grid, water) {
  const stationed = points.filter(p => p.station && p.tier !== 'scenery').sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!stationed.length) throw new Error('No highway stations');
  const uf = unionFind(stationed.map(p => p.id));
  for (let i = 0; i < stationed.length; i++) for (let j = i + 1; j < stationed.length; j++) if (distance(stationed[i].station.posM, stationed[j].station.posM) < 150) uf.join(stationed[i].id, stationed[j].id);
  const groups = new Map();
  for (const point of stationed) { const id = uf.find(point.id); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(point); }
  const nodes = [], mapped = new Map();
  const safeGroups = [];
  for (const group of groups.values()) {
    const pos = [0, 1].map(k => group.reduce((s, p) => s + p.station.posM[k], 0) / group.length);
    const band = clearanceAt(clearance, ...pos);
    const safe = group.every(p => {
      const ring = distance(pos, [p.localM[0], p.localM[2]]);
      return Number.isFinite(band.floorY) && p.station.yM >= band.floorY && p.station.yM <= band.ceilY
        && (!['drop', 'chorus'].includes(p.role) || ring >= 300 && ring <= 600)
        && stationFlyability(clearance, pos, p.station.yM).count >= 2;
    });
    // Merging is an optimization, never authority to relocate a locked hero.
    safeGroups.push(...(safe ? [group] : group.map(p => [p])));
  }
  for (const group of safeGroups) {
    const posM = [0, 1].map(k => group.reduce((s, p) => s + p.station.posM[k], 0) / group.length);
    const node = { id: `n${nodes.length}`, posM, pointId: group[0].id, pointIds: group.map(p => p.id) }; nodes.push(node);
    for (const point of group) {
      const band = clearanceAt(clearance, ...posM), yM = point.station.yM;
      if (!Number.isFinite(band.floorY) || yM < band.floorY || yM > band.ceilY) throw new Error(`${point.id}: merged station violates clearance`);
      const fly = stationFlyability(clearance, posM, yM);
      if (fly.count < 2) throw new Error(`${point.id}: merged station has no through pass`);
      const station = { ...point.station, nodeId: node.id, posM: [...posM], flyability: fly.count, passHeadingDeg: fly.headingDeg };
      if (distance(point.station.posM, posM) > .001) {
        station.ringM = Math.hypot(posM[0] - point.localM[0], posM[1] - point.localM[2]);
        if (['drop', 'chorus'].includes(point.role) && (station.ringM < 300 || station.ringM > 600)) throw new Error(`${point.id}: merged station leaves its summit ring`);
        if (grid) {
          const bestAim = scoreEye(grid, points, [posM[0], yM, posM[1]], { water }); delete bestAim.aims;
          if (!(bestAim.score > 0)) throw new Error(`${point.id}: merged station has no view`);
          station.bestAim = bestAim;
        }
      }
      mapped.set(point.id, { ...point, station });
    }
  }
  return { nodes, points: points.map(p => mapped.get(p.id) || { ...p }).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}

function pruneNetwork(nodes, candidates, stretch) {
  const sorted = [...candidates].sort((a, b) => a.lengthM - b.lengthM || a.id.localeCompare(b.id));
  const uf = unionFind(nodes.map(n => n.id)), selected = [], ids = new Set();
  for (const edge of sorted) if (uf.join(edge.a, edge.b)) { selected.push(edge); ids.add(edge.id); }
  if (new Set(nodes.map(n => uf.find(n.id))).size !== 1) throw new Error('Safe highway candidate graph is disconnected');
  for (const edge of candidates) if (edge.spine && !ids.has(edge.id)) { selected.push(edge); ids.add(edge.id); }
  for (const edge of sorted) if (!ids.has(edge.id) && graphDistances(nodes, selected, edge.a).get(edge.b) > stretch * edge.lengthM) {
    selected.push(edge); ids.add(edge.id);
  }
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

// Closest points of two line segments, with interior crossing handled exactly.
function closestSegments(a, b, c, d) {
  const ux = b[0] - a[0], uz = b[1] - a[1], vx = d[0] - c[0], vz = d[1] - c[1], cross = ux * vz - uz * vx;
  if (Math.abs(cross) > 1e-9) {
    const wx = c[0] - a[0], wz = c[1] - a[1], t = (wx * vz - wz * vx) / cross, u = (wx * uz - wz * ux) / cross;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { const p = lerpPoint(a, b, t); return { p, q: p, t, u, distance: 0 }; }
  }
  const project = (p, a, b) => Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / Math.max(1e-9, distance(a, b) ** 2)));
  const choices = [];
  for (const [p, t] of [[a, 0], [b, 1]]) { const u = project(p, c, d), q = lerpPoint(c, d, u); choices.push({ p, q, t, u, distance: distance(p, q) }); }
  for (const [q, u] of [[c, 0], [d, 1]]) { const t = project(q, a, b), p = lerpPoint(a, b, t); choices.push({ p, q, t, u, distance: distance(p, q) }); }
  return choices.sort((a, b) => a.distance - b.distance)[0];
}

export function splitRoadCrossings(originalNodes, originalEdges, { clearance, turnRadiusM = 400, marginM = 1000 } = {}) {
  const nodes = originalNodes.map(n => ({ ...n, posM: [...n.posM] })), segments = [], buckets = new Map(), events = [];
  const lengths = new Map();
  for (const edge of originalEdges) {
    let along = 0;
    for (let i = 1; i < edge.samples.length; i++) {
      const a = edge.samples[i - 1], b = edge.samples[i], length = distance(a, b), index = segments.length;
      const segment = { edge, a, b, along, length }; segments.push(segment); along += length;
      const keys = [];
      for (let x = Math.floor((Math.min(a[0], b[0]) - 100) / 100); x <= Math.floor((Math.max(a[0], b[0]) + 100) / 100); x++) {
        for (let z = Math.floor((Math.min(a[1], b[1]) - 100) / 100); z <= Math.floor((Math.max(a[1], b[1]) + 100) / 100); z++) keys.push(`${x},${z}`);
      }
      const seen = new Set();
      for (const key of keys) for (const j of buckets.get(key) || []) {
        if (seen.has(j)) continue; seen.add(j);
        const other = segments[j]; if (other.edge.id === edge.id) continue;
        const sine = Math.abs((b[0] - a[0]) * (other.b[1] - other.a[1]) - (b[1] - a[1]) * (other.b[0] - other.a[0])) / Math.max(1e-9, length * other.length);
        if (sine < .5) continue; // Parallel shared corridors are not crossings.
        const closest = closestSegments(a, b, other.a, other.b);
        if (closest.distance <= 100) events.push({ first: segment, second: other, ...closest });
      }
      for (const key of keys) { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(index); }
    }
    lengths.set(edge.id, along);
  }
  events.sort((a, b) => a.distance - b.distance || a.first.edge.id.localeCompare(b.first.edge.id) || a.first.along - b.first.along);
  const cuts = new Map(originalEdges.map(e => [e.id, []]));
  for (const event of events) {
    const pos = lerpPoint(event.p, event.q, .5);
    let node = nodes.find(n => distance(n.posM, pos) < 150);
    if (!node) { node = { id: `j${nodes.filter(n => n.pointId === null).length}`, posM: pos, pointId: null }; nodes.push(node); }
    for (const [segment, t] of [[event.first, event.t], [event.second, event.u]]) {
      const list = cuts.get(segment.edge.id), s = segment.along + t * segment.length;
      if (node.id === segment.edge.a || node.id === segment.edge.b || s < 150 || lengths.get(segment.edge.id) - s < 150) continue;
      if (!list.some(c => c.node.id === node.id || Math.abs(c.s - s) < 150)) list.push({ s, node });
    }
  }
  const edges = [];
  for (const edge of originalEdges) {
    const list = cuts.get(edge.id).sort((a, b) => a.s - b.s);
    if (!list.length) { edges.push(edge); continue; }
    const originalAlong = [0];
    for (let i = 1; i < edge.samples.length; i++) originalAlong.push(originalAlong[i - 1] + distance(edge.samples[i - 1], edge.samples[i]));
    const stops = [{ s: 0, node: nodes.find(n => n.id === edge.a) }, ...list, { s: lengths.get(edge.id), node: nodes.find(n => n.id === edge.b) }];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i]; if (a.node.id === b.node.id) continue;
      const points = [a.node.posM, ...edge.samples.filter((_, j) => originalAlong[j] > a.s && originalAlong[j] < b.s), b.node.posM];
      const smooth = smoothRoad(points, { clearance, turnRadiusM, marginM });
      if (!smooth) throw new Error(`Junction split of ${edge.id} violates road geometry`);
      edges.push({ ...edge, ...smooth, id: `${edge.id}.${i - 1}`, a: a.node.id, b: b.node.id, parentId: edge.id });
    }
  }
  const used = new Set(edges.flatMap(e => [e.a, e.b]));
  return { nodes: nodes.filter(n => n.pointId !== null || used.has(n.id)), edges };
}

function orbitAt(node, point, clearance, { marginM, turnRadiusM, incomingHeadingDeg }) {
  for (const radiusM of [600, 900, 1200]) for (let k = 0; k < 24; k++) {
    // A loop tangent roughly perpendicular to the road can accept both
    // arrival and the reverse departure through <=120-degree fillets.
    const bearing = (incomingHeadingDeg + k * 15) * DEG;
    const center = [node.posM[0] + radiusM * Math.sin(bearing), node.posM[1] - radiusM * Math.cos(bearing)];
    const count = Math.ceil(2 * Math.PI * radiusM / 25), positions = [];
    for (let i = 0; i <= count; i++) {
      const angle = bearing + Math.PI + i / count * 2 * Math.PI;
      positions.push([center[0] + radiusM * Math.sin(angle), center[1] - radiusM * Math.cos(angle)]);
    }
    positions[0] = positions[positions.length - 1] = node.posM;
    const heading = (a, b) => Math.atan2(b[0] - a[0], -(b[1] - a[1])) / DEG;
    const turn = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
    const arrival = turn(heading(positions[0], positions[1]), incomingHeadingDeg);
    const departure = turn(heading(positions[count - 1], positions[count]), incomingHeadingDeg + 180);
    const joinTurnMaxDeg = Math.max(arrival, departure);
    if (joinTurnMaxDeg > 120) continue;
    const road = roadSamples(positions, clearance, marginM, turnRadiusM);
    if (!road.samples) continue;
    const low = Math.max(point.station.yM - 150, ...road.samples.map(s => s[2] + 5));
    const high = Math.min(point.station.yM + 150, ...road.samples.map(s => s[3]));
    if (low <= high) return { id: `orbit-${node.id}`, a: node.id, b: node.id, kind: 'orbit', spine: false,
      ...road, radiusM, joinTurnMaxDeg, orbitY: Math.max(low, Math.min(high, point.station.yM)) };
  }
  throw new Error(`${node.id}: no safe turnaround orbit within station height ±150 m`);
}

/** Build/review data. Call with the real DEM to refresh views after a merge. */
export function buildHighway(points, { clearance, grid = null, water = null, turnRadiusM = 400, spannerStretch = 1.35,
  marginM = 1000, southAnchorM = null, northAnchorM = null, log = console.log } = {}) {
  const merged = mergeStations(points, clearance, grid, water), originalNodes = merged.nodes;
  const navigation = new NavigationGrid(clearance, { marginM }), candidates = new Map(), rejected = [];
  const append = (a, b, spine) => {
    if (a.id === b.id) return;
    const key = [a.id, b.id].sort().join('|'); if (candidates.has(key)) { if (spine) candidates.get(key).spine = true; return; }
    const path = navigation.search(a.posM, b.posM) || navigation.search(a.posM, b.posM, 5000);
    const road = path && smoothRoad(path, { clearance, marginM, turnRadiusM, log: reason => rejected.push(`${a.id}→${b.id}: ${reason}`) });
    if (!road) { rejected.push(`${a.id}→${b.id}: no safe smooth path`); return; }
    if (!spine && road.lengthM > 1.6 * distance(a.posM, b.posM)) { rejected.push(`${a.id}→${b.id}: branch detour >1.6`); return; }
    candidates.set(key, { id: `road-${String(candidates.size).padStart(4, '0')}`, a: a.id, b: b.id, kind: 'road', spine, ...road });
  };
  const bySouth = [...originalNodes].sort((a, b) => b.posM[1] - a.posM[1] || a.id.localeCompare(b.id));
  const nearest = pos => [...originalNodes].sort((a, b) => distance(a.posM, pos) - distance(b.posM, pos) || a.id.localeCompare(b.id))[0];
  const south = southAnchorM ? nearest(southAnchorM) : bySouth[0], north = northAnchorM ? nearest(northAnchorM) : bySouth[bySouth.length - 1];
  const core = new Set(merged.points.filter(p => ['drop', 'chorus'].includes(p.role) && p.station).map(p => p.station.nodeId));
  const spine = [south, ...bySouth.filter(n => core.has(n.id) && n.id !== south.id && n.id !== north.id), north];
  const spineIds = new Set(spine.map(n => n.id));
  for (let i = 1; i < spine.length; i++) append(spine[i - 1], spine[i], true);
  for (const node of originalNodes) if (!spineIds.has(node.id)) {
    const neighbours = originalNodes.filter(n => n.id !== node.id && distance(n.posM, node.posM) <= 9000)
      .sort((a, b) => distance(a.posM, node.posM) - distance(b.posM, node.posM) || a.id.localeCompare(b.id)).slice(0, 6);
    for (const next of neighbours) append(node, next, false);
  }
  const all = [...candidates.values()], selected = pruneNetwork(originalNodes, all, spannerStretch);
  const split = splitRoadCrossings(originalNodes, selected, { clearance, marginM, turnRadiusM });
  const nodes = split.nodes, edges = split.edges;
  for (const node of nodes) if (node.pointId !== null && edges.filter(e => e.kind === 'road' && (e.a === node.id || e.b === node.id)).length === 1) {
    const road = edges.find(e => e.kind === 'road' && (e.a === node.id || e.b === node.id)), samples = road.samples;
    const a = road.a === node.id ? samples[1] : samples[samples.length - 2];
    const b = road.a === node.id ? samples[0] : samples[samples.length - 1];
    const incomingHeadingDeg = Math.atan2(b[0] - a[0], -(b[1] - a[1])) / DEG;
    edges.push(orbitAt(node, merged.points.find(p => p.id === node.pointId), clearance, { marginM, turnRadiusM, incomingHeadingDeg }));
  }
  let maxStretch = 1;
  for (const node of originalNodes) {
    const before = graphDistances(originalNodes, all, node.id), after = graphDistances(nodes, edges, node.id);
    if ([...after.values()].some(n => !Number.isFinite(n))) throw new Error('Final highway is disconnected');
    for (const target of originalNodes) if (target.id !== node.id) maxStretch = Math.max(maxStretch, after.get(target.id) / before.get(target.id));
  }
  if (maxStretch > spannerStretch + .001) throw new Error(`Junctions exceed spanner stretch (${maxStretch.toFixed(3)})`);
  const degreeHistogram = {}, radii = edges.map(e => minimumTurnRadius(e.samples)).filter(Number.isFinite);
  for (const node of nodes) { const degree = edges.filter(e => e.kind === 'road' && (e.a === node.id || e.b === node.id)).length; degreeHistogram[degree] = (degreeHistogram[degree] || 0) + 1; }
  const stats = { nodes: nodes.length, edgeCount: edges.length, roadCount: edges.filter(e => e.kind === 'road').length,
    orbitCount: edges.filter(e => e.kind === 'orbit').length, candidateCount: all.length, totalLengthM: edges.reduce((n, e) => n + e.lengthM, 0),
    degreeHistogram, longestEdgeM: Math.max(...edges.map(e => e.lengthM)), minTurnRadiusM: radii.length ? Math.min(...radii) : null,
    minBandHeightM: edges.reduce((n, e) => e.samples.reduce((m, s) => Math.min(m, s[3] - s[2]), n), Infinity),
    mergedStations: points.filter(p => p.station && p.tier !== 'scenery').length - originalNodes.length, junctions: nodes.length - originalNodes.length,
    components: 1, maxStretch, rejectedEdges: rejected.length };
  log(`highway: ${stats.nodes} nodes, ${stats.roadCount} roads, ${stats.orbitCount} orbits, ${(stats.totalLengthM / 1000).toFixed(1)} km, stretch ${maxStretch.toFixed(3)}`);
  for (const reason of rejected) log(reason);
  return { points: merged.points, nodes, edges, candidateEdges: all.map(e => ({ id: e.id, a: e.a, b: e.b, lengthM: e.lengthM })), stats, rejected };
}

/** Shared sample IDs at junctions; exact arc distances let runtime interpolate
 *  consecutive field samples independently of road orientation or spacing. */
export function highwayFieldSamples(highway, { clearance, spacingM = 100, longEdgeSpacingM = null } = {}) {
  const samples = [], ids = new Map(), edges = [], stations = [];
  const add = posM => {
    const key = posM.map(n => Math.round(n * 1000)).join(',');
    if (ids.has(key)) return ids.get(key);
    const band = clearanceAt(clearance, ...posM);
    if (!Number.isFinite(band.floorY) || band.ceilY - band.floorY < 150) throw new Error('Field sample has no safe vertical band');
    const id = samples.length; samples.push({ posM: posM.slice(0, 2), ...band }); ids.set(key, id); return id;
  };
  for (const edge of highway.edges) {
    const spacing = longEdgeSpacingM && edge.lengthM > 3000 ? longEdgeSpacingM : spacingM;
    const positions = resample(edge.samples, spacing), sampleIds = positions.map(add);
    const distancesM = positions.map((_, i) => i + 1 === positions.length ? edge.lengthM : i * spacing);
    edges.push({ edgeId: edge.id, sampleIds, distancesM });
  }
  for (const point of highway.points) if (point.station && point.tier !== 'scenery') {
    stations.push({ pointId: point.id, sampleId: add(point.station.posM) });
  }
  return { samples, edges, stations };
}
