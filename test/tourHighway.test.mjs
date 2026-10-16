import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClearanceField, clearanceAt } from '../tools/lib/tour-stations.mjs';
import { buildHighway, mergeStations, smoothRoad, minimumTurnRadius, splitRoadCrossings, highwayFieldSamples } from '../tools/lib/tour-highway.mjs';

function threeValleys() {
  const width = 301, height = 401, cellSizeM = 100, originM = [-15000, -20000];
  const heightsM = Float32Array.from({ length: width * height }, (_, i) => {
    const x = originM[0] + i % width * cellSizeM;
    return 1600 + 300 * Math.exp(-(((x - 3000) / 1200) ** 2)) + 300 * Math.exp(-(((x + 3000) / 1200) ** 2));
  });
  const grid = { width, height, cellSizeM, originM, heightsM, valid: new Uint8Array(width * height).fill(1) };
  const clearance = buildClearanceField(grid, { forestMask: new Uint8Array(width * height) });
  const positions = [[0, 15000, 'intro'], [0, 12000, 'drop'], [0, 4000, 'chorus'], [0, -4000, 'drop'],
    [0, -12000, 'chorus'], [0, -15000, 'outro'], [-6000, 8000, 'bridge'], [-6000, -8000, 'breakdown'],
    [6000, 8000, 'verse'], [6000, -8000, 'solo']];
  const points = positions.map(([x, z, role], i) => ({ id: `p${i}`, role, tier: 'primary', type: 'summit',
    localM: [x, 2250, z - 300], grandeur: .8, station: { posM: [x, z], yM: 2300, passHeadingDeg: 0, ringM: 300, offsetM: 50,
      bestAim: { score: .8, headingDeg: 270, pitchDeg: 5, hfovDeg: 55 } } }));
  return { grid, clearance, points };
}

// Independent tiny shortest-path oracle: pruning must preserve the metric of
// the unpruned safe candidate network, not Euclidean distances across ridges.
function distances(nodes, edges, start) {
  const result = new Map(nodes.map(n => [n.id, Infinity])); result.set(start, 0);
  const todo = new Set(result.keys());
  while (todo.size) {
    const at = [...todo].sort((a, b) => result.get(a) - result.get(b))[0]; todo.delete(at);
    for (const e of edges) {
      const next = e.a === at ? e.b : e.b === at ? e.a : null;
      if (next !== null) result.set(next, Math.min(result.get(next), result.get(at) + e.lengthM));
    }
  }
  return result;
}

test('the three-valley highway is connected, has a south-to-north spine and safe smooth samples', () => {
  const { clearance, points } = threeValleys(), saved = structuredClone(points);
  const result = buildHighway(points, { clearance, log: () => {} });
  assert.deepEqual(points, saved);
  const reach = distances(result.nodes, result.edges, result.nodes[0].id);
  assert.ok([...reach.values()].every(Number.isFinite));
  const nodes = new Map(result.nodes.map(n => [n.id, n]));
  for (const edge of result.edges) {
    if (edge.spine) assert.ok(nodes.get(edge.b).posM[1] <= nodes.get(edge.a).posM[1] + .01);
    assert.ok(minimumTurnRadius(edge.samples) >= 400 - .2, `${edge.id} turn radius ${minimumTurnRadius(edge.samples)}`);
    assert.ok(edge.lengthM > 0 && Number.isFinite(edge.lengthM));
    for (let i = 0; i < edge.samples.length; i++) {
      const [x, z, floor, ceil] = edge.samples[i], band = clearanceAt(clearance, x, z);
      assert.ok(floor >= band.floorY - .01 && ceil <= band.ceilY + .01);
      assert.ok(ceil - floor >= 150);
      if (edge.kind === 'orbit') assert.ok(edge.orbitY >= floor && edge.orbitY <= ceil);
      if (i) assert.ok(Math.hypot(x - edge.samples[i - 1][0], z - edge.samples[i - 1][1]) <= 25.05);
    }
  }
  assert.equal(result.stats.components, 1);
  assert.ok(result.stats.minBandHeightM >= 150);
});

test('the pruned highway preserves 1.35 stretch for all original station pairs', () => {
  const { clearance, points } = threeValleys();
  // A midpoint station supplies a real redundant route. The basic sparse
  // fixture can need every candidate to satisfy the stretch bound.
  points.push({ ...structuredClone(points[6]), id: 'mid-branch', role: 'interlude',
    localM: [-3000, 2250, 5700], station: { ...points[6].station, posM: [-3000, 6000] } });
  const result = buildHighway(points, { clearance, log: () => {} });
  const original = result.nodes.filter(n => n.pointId !== null);
  for (const node of original) {
    const before = distances(original, result.candidateEdges, node.id), after = distances(result.nodes, result.edges, node.id);
    for (const target of original) if (target.id !== node.id) {
      assert.ok(after.get(target.id) <= 1.35 * before.get(target.id) + 1, `${node.id} to ${target.id}`);
    }
  }
  const keptRoads = new Set(result.edges.filter(e => e.kind === 'road').map(e => e.parentId || e.id));
  assert.ok(keptRoads.size < result.candidateEdges.length);
});

test('every degree-one station has a safe 600–1200 m orbit and authoring is deterministic', () => {
  const { clearance, points } = threeValleys(), one = buildHighway(points, { clearance, log: () => {} });
  const two = buildHighway(points.slice().reverse(), { clearance, log: () => {} });
  assert.deepEqual(one, two);
  let leaves = 0;
  for (const node of one.nodes) {
    const degree = one.edges.filter(e => e.kind === 'road' && (e.a === node.id || e.b === node.id)).length;
    if (node.pointId !== null && degree === 1) {
      leaves++;
      const orbit = one.edges.find(e => e.kind === 'orbit' && e.a === node.id && e.b === node.id);
      assert.ok(orbit, `orbit at ${node.id}`);
      assert.ok(orbit.radiusM >= 600 && orbit.radiusM <= 1200);
    }
  }
  assert.ok(leaves >= 2);
});

test('nearby stations share one node and their stored positions match that node', () => {
  const { clearance, points } = threeValleys();
  points[0].station.posM = [0, 9000]; points[1].station.posM = [80, 9050];
  points[0].localM = [0, 2250, 8500]; points[1].localM = [80, 2250, 8550];
  points[0].station.ringM = 500; points[1].station.ringM = 500;
  const result = buildHighway(points, { clearance, log: () => {} });
  const a = result.points.find(p => p.id === 'p0'), b = result.points.find(p => p.id === 'p1');
  assert.equal(a.station.nodeId, b.station.nodeId);
  const node = result.nodes.find(n => n.id === a.station.nodeId);
  assert.deepEqual(a.station.posM, node.posM); assert.deepEqual(b.station.posM, node.posM);
});

test('a nearby station merge cannot move a chorus viewpoint outside its summit ring', () => {
  const { clearance, points } = threeValleys();
  const a = structuredClone(points[2]), b = structuredClone(points[0]);
  a.station.posM = [0, 0]; a.localM = [0, 2250, -600];
  b.station.posM = [0, 100]; b.localM = [0, 2250, -400];
  const result = mergeStations([a, b], clearance);
  assert.equal(result.nodes.length, 2);
  assert.deepEqual(result.points.find(p => p.id === a.id).station.posM, [0, 0]);
});

test('crossing roads split at a shared junction without losing endpoints', () => {
  const { clearance } = threeValleys();
  const nodes = [[-4000, -4000], [4000, 4000], [-4000, 4000], [4000, -4000]]
    .map((posM, i) => ({ id: `n${i}`, posM, pointId: `p${i}` }));
  const line = (a, b) => smoothRoad([nodes[a].posM, nodes[b].posM], { clearance });
  const edges = [[0, 1], [2, 3]].map(([a, b], i) => ({ id: `e${i}`, a: nodes[a].id, b: nodes[b].id,
    kind: 'road', spine: false, ...line(a, b) }));
  const result = splitRoadCrossings(nodes, edges, { clearance });
  const junctions = result.nodes.filter(n => n.pointId === null);
  assert.equal(junctions.length, 1);
  assert.ok(Math.hypot(...junctions[0].posM) < 1);
  assert.equal(result.edges.length, 4);
  assert.equal(result.edges.filter(e => e.a === junctions[0].id || e.b === junctions[0].id).length, 4);
  assert.ok([...distances(result.nodes, result.edges, nodes[0].id).values()].every(Number.isFinite));
});

test('smoothing rejects insufficient vertical bands and the 1 km boundary margin', () => {
  const { clearance } = threeValleys();
  const logs = [];
  assert.equal(smoothRoad([[-15000, -15000], [-14000, -10000]], { clearance, log: s => logs.push(s) }), null);
  const narrow = { ...clearance, ceil: Uint16Array.from(clearance.floor, n => n + 1000) };
  assert.equal(smoothRoad([[0, 0], [0, 6000]], { clearance: narrow, log: s => logs.push(s) }), null);
  assert.ok(logs.some(s => /margin/.test(s)) && logs.some(s => /band/.test(s)));
});

test('the view field samples roads every 100 m and includes every station', () => {
  const { clearance, points } = threeValleys(), highway = buildHighway(points, { clearance, log: () => {} });
  const field = highwayFieldSamples(highway, { clearance });
  assert.equal(field.stations.length, points.length);
  for (const map of field.edges) {
    assert.equal(map.sampleIds.length, map.distancesM.length);
    assert.equal(map.distancesM[0], 0);
    for (let i = 1; i + 1 < map.distancesM.length; i++) assert.ok(Math.abs(map.distancesM[i] - map.distancesM[i - 1] - 100) < .001);
    const edge = highway.edges.find(e => e.id === map.edgeId);
    assert.ok(Math.abs(map.distancesM[map.distancesM.length - 1] - edge.lengthM) < .001);
  }
  for (const map of field.stations) {
    const p = highway.points.find(p => p.id === map.pointId);
    assert.deepEqual(field.samples[map.sampleId].posM, p.station.posM);
  }
});

test('a turnaround orbit joins arrival and departure without a turn over 120 degrees', () => {
  const { clearance, points } = threeValleys(), highway = buildHighway(points, { clearance, log: () => {} });
  const vector = (a, b) => [b[0] - a[0], b[1] - a[1]];
  const turn = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b))))) * 180 / Math.PI;
  for (const orbit of highway.edges.filter(e => e.kind === 'orbit')) {
    const road = highway.edges.find(e => e.kind === 'road' && (e.a === orbit.a || e.b === orbit.a));
    const s = road.samples, incoming = road.a === orbit.a ? vector(s[1], s[0]) : vector(s[s.length - 2], s[s.length - 1]);
    const outgoing = incoming.map(n => -n), loop = orbit.samples;
    assert.ok(turn(incoming, vector(loop[0], loop[1])) <= 120, `arrival at ${orbit.a}`);
    assert.ok(turn(vector(loop[loop.length - 2], loop[loop.length - 1]), outgoing) <= 120, `departure at ${orbit.a}`);
  }
});
