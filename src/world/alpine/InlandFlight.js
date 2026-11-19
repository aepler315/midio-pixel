import { aimTurn, pathPoseAt, progressOf, samplePath, splineAt } from '../terrain/ShotPath.js';
import { projectPoint, scenePoseAt } from '../terrain/SceneTravel.js';
import { clamp, clamp01, lerp } from '../../utils/math.js';
import { DEFORM_PAD_M } from './RangeCamera.js';
import { seenFrom } from './LineOfSight.js';
import { terrainHeightAt } from './TerrainMesh.js';

const ASPECT = 16 / 9;
const CLEARANCE_M = DEFORM_PAD_M + 220;
const BOUNDS_MARGIN_M = 1200;
const BEARINGS = 12;
const RADII_M = [6500, 10500, 15400];
const KEEP_ROUTES = 8;
const PATH_SPACING_M = 90;
const GRADE = .16;
const distanceXZ = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const blend = (a, b, t) => a.map((value, i) => lerp(value, b[i], t));

function inside(bounds, x, z) {
  return x >= bounds.min[0] + BOUNDS_MARGIN_M && x <= bounds.max[0] - BOUNDS_MARGIN_M
    && z >= bounds.min[2] + BOUNDS_MARGIN_M && z <= bounds.max[2] - BOUNDS_MARGIN_M;
}

function crestsOf(data, pair) {
  const parts = data.manifest.source?.provenance?.composition?.pieces ?? [];
  const crests = [pair.principal, pair.companion].map(crest => ({ ...crest, id: crest.slotId, label: crest.name || crest.slotId }));
  for (const [i, { name, localM }] of (data.manifest.landmarks ?? []).entries()) {
    const slotId = parts[i]?.slotId;
    if (!slotId || !localM) continue;
    const known = crests.find(crest => crest.slotId === slotId);
    if (known) { known.label = name || slotId; continue; }
    const [x, z] = localM;
    const heightM = terrainHeightAt(data, x, z);
    if (Number.isFinite(heightM)) crests.push({ id: slotId, label: name || slotId, slotId, pointM: [x, heightM, z] });
  }
  return crests;
}

function passesOf(data, crests) {
  const passes = [];
  for (const [i, a] of crests.entries()) for (const b of crests.slice(i + 1)) {
    const d = distanceXZ(a.pointM, b.pointM);
    if (d < 4800 || d > 20000) continue;
    const [x, , z] = blend(a.pointM, b.pointM, .5);
    const groundM = terrainHeightAt(data, x, z);
    const reliefM = Math.min(a.pointM[1], b.pointM[1]) - groundM;
    if (!(reliefM >= 160)) continue;
    passes.push({ id: 'pass-' + a.id + '-' + b.id, label: 'Pass between ' + a.label + ' and ' + b.label,
      pointM: [x, groundM + 75, z], subjects: [a, b], value: Math.min(reliefM, 1500) / 1500 });
  }
  return passes.sort((a, b) => b.value - a.value).slice(0, 8);
}

function basinsOf(data, bounds, center) {
  const basins = [];
  for (let i = 0; i < BEARINGS; i++) {
    const theta = i * Math.PI * 2 / BEARINGS, dx = Math.cos(theta), dz = Math.sin(theta);
    const x = center[0] + dx * 19000, z = center[2] + dz * 19000;
    if (!inside(bounds, x, z)) continue;
    const heightM = terrainHeightAt(data, x, z);
    const a = terrainHeightAt(data, x - dz * 5200, z + dx * 5200);
    const b = terrainHeightAt(data, x + dz * 5200, z - dx * 5200);
    const reliefM = Math.max(a, b) - heightM;
    if (!(reliefM > 85)) continue;
    basins.push({ id: 'basin-' + i, label: 'Inland basin', pointM: [x, heightM + 75, z], value: Math.min(reliefM, 1200) / 1200 });
  }
  return basins.sort((a, b) => b.value - a.value).slice(0, 5);
}

function eyeStations(anchor, context) {
  const { data, bounds, home, crests, opening, finale } = context;
  const result = [];
  const targetM = anchor.pointM;
  const bearing = Math.atan2(home.eyeM[2] - targetM[2], home.eyeM[0] - targetM[0]);
  for (const radius of RADII_M) for (let i = 0; i < BEARINGS; i++) {
    const angle = bearing + i * Math.PI * 2 / BEARINGS;
    const x = targetM[0] + radius * Math.cos(angle), z = targetM[2] + radius * Math.sin(angle);
    if (!inside(bounds, x, z)) continue;
    const groundM = terrainHeightAt(data, x, z);
    if (!Number.isFinite(groundM)) continue;
    const eyeM = [x, groundM + (finale ? 1450 : opening ? 610 : 940), z];
    const pose = { eyeM, targetM, fovYDeg: home.fovYDeg };
    let picked = seenFrom(data, eyeM, [targetM[0], targetM[1] + 30, targetM[2]]) ? 1 : 0;
    // A pass has two distinct shoulders. Reward the wider view of both.
    for (const crest of anchor.subjects ?? crests) {
      if (crest === anchor) continue;
      const p = projectPoint(pose, ASPECT, crest.pointM);
      if (p && Math.abs(p.x) < .9 && Math.abs(p.y) < .85 && seenFrom(data, eyeM, crest.pointM))
        picked += .18 + .22 * Math.min(1, Math.abs(p.x) / .36);
    }
    // Opening favors a legible close shot from the measured region's side.
    if (opening) picked += .55 * Math.cos(angle - bearing) - radius / 36000;
    if (finale) picked += radius / 22000;
    result.push({ anchor, eyeM, targetM, score: picked + .28 * (anchor.value ?? 0) });
  }
  return result;
}

function routeStations(groups, times, travelMs, context) {
  const totalM = clamp(travelMs * .255, 5300, 43000);
  let routes = [{ stations: [], score: 0 }];
  for (const [i, group] of groups.entries()) {
    const stations = group.flatMap(anchor => eyeStations(anchor,
      { ...context, opening: i === 0, finale: i === groups.length - 1 }));
    const wantedM = Math.max(1800, totalM * (times[i] - (times[i - 1] ?? 0)));
    const next = [];
    for (const route of routes) for (const station of stations) {
      const prev = route.stations.at(-1), before = route.stations.at(-2);
      if (prev?.anchor.id === station.anchor.id) continue;
      let score = route.score + station.score;
      if (prev) {
        const d = distanceXZ(prev.eyeM, station.eyeM);
        if (d < wantedM * .24 || d > wantedM * 2.25) continue;
        const turn = aimTurn(prev.eyeM, prev.targetM, station.eyeM, station.targetM);
        // Large direction changes can play over a full leg, but tight
        // musical intervals need a gentler handoff and avoid backtracking.
        const legSec = Math.max(1, travelMs * (times[i] - times[i - 1]) / 1000);
        if (turn > Math.min(2.1, .13 * legSec + .13)) continue;
        score -= Math.abs(d - wantedM) / wantedM + .55 * turn;
        if (before) {
          const a = distanceXZ(before.eyeM, prev.eyeM), b = distanceXZ(before.eyeM, station.eyeM);
          const cosine = (b * b - a * a - d * d) / (2 * a * d);
          if (cosine < -.60) continue;
          score += .38 * cosine;
        }
      }
      next.push({ score, stations: [...route.stations, station] });
    }
    routes = next.sort((a, b) => b.score - a.score).slice(0, KEEP_ROUTES);
  }
  return routes;
}

function sampleClearedPath(stations, data, bounds, fovYDeg) {
  const eyes = stations.map(station => station.eyeM), aims = stations.map(station => station.targetM);
  const path = samplePath({ eyes, aims, fovs: fovYDeg, spacingM: PATH_SPACING_M, minSamples: 64 });
  // Raise the whole approach to a peak. Two passes give a conservative
  // altitude envelope before smoothing, so the flight avoids single-sample
  // collision lifts without climbing all the way to the region's highest peak.
  const minimum = new Float64Array(path.s.length), envelope = new Float64Array(path.s.length);
  for (let i = 0; i < minimum.length; i++) {
    const x = path.eye[i * 3], z = path.eye[i * 3 + 2];
    if (!inside(bounds, x, z)) return null;
    const h = terrainHeightAt(data, x, z);
    if (!Number.isFinite(h)) return null;
    minimum[i] = h + CLEARANCE_M;
    envelope[i] = Math.max(minimum[i], path.eye[i * 3 + 1],
      i ? envelope[i - 1] - GRADE * (path.s[i] - path.s[i - 1]) : -Infinity);
  }
  for (let i = minimum.length - 2; i >= 0; i--)
    envelope[i] = Math.max(envelope[i], envelope[i + 1] - GRADE * (path.s[i + 1] - path.s[i]));
  for (let i = 0; i < minimum.length; i++) {
    const a = envelope[Math.max(0, i - 3)], b = envelope[Math.min(minimum.length - 1, i + 3)];
    path.eye[i * 3 + 1] = Math.max(minimum[i], .25 * a + .5 * envelope[i] + .25 * b) + 90;
  }
  // Exact cumulative path distance at each chosen transition station.
  // This uses the same underlying spline and sampling rate as samplePath.
  const intervals = eyes.length - 1, steps = Math.max(64, intervals * 48);
  const fineEyes = [], fineAims = [];
  for (let i = 0; i <= steps; i++) {
    fineEyes.push(splineAt(eyes, i / steps * intervals));
    fineAims.push(splineAt(aims, i / steps * intervals));
  }
  const progress = progressOf(fineEyes, fineAims);
  const marks = stations.map((_, i) => progress[Math.round(i / intervals * steps)]);
  return { path, marks };
}

function scoreStations(movement) {
  const travelMs = movement.travelMs ?? 140000;
  const separated = [];
  for (const { progress01 } of movement.guides ?? []) {
    if (progress01 >= .14 && progress01 <= .86 && progress01 - (separated.at(-1) ?? 0) >= .14)
      separated.push(progress01);
  }
  const limit = travelMs < 22000 ? 0 : travelMs < 54000 ? 1 : travelMs < 115000 ? 2 : 3;
  const defaults = limit === 0 ? [] : limit === 1 ? [.53] : [.34, .68];
  return { travelMs, times: [0, ...(separated.length ? separated.slice(0, limit) : defaults), 1] };
}

/** Build a small deterministic search over connected eye positions around
 * several terrain features before starting any movement. */
export function compileInlandFlight(data, view, movement) {
  const bounds = data?.manifest?.boundsM, pair = view.songprintComposition;
  if (!view.songRange?.plan?.inland || !bounds || !pair || !movement) return null;
  const { times, travelMs } = scoreStations(movement);
  const home = scenePoseAt(view, { progress01: .5 });
  const crests = crestsOf(data, pair);
  const pivotM = blend(pair.principal.pointM, pair.companion.pointM, .5);
  const passes = passesOf(data, crests), basins = basinsOf(data, bounds, pivotM);
  const subjectGroups = [passes.length ? passes : crests.slice(1), crests.slice(1), basins.length ? basins : crests.slice(1)];
  const middle = times.slice(1, -1).map((_, i) => subjectGroups[i]);
  const groups = [[crests[0]], ...middle, [...crests.slice(1), ...basins]];
  for (const route of routeStations(groups, times, travelMs, { data, bounds, home, crests })) {
    const sampled = sampleClearedPath(route.stations, data, bounds, home.fovYDeg);
    if (!sampled) continue;
    const anchors = route.stations.map(station => station.anchor);
    // Harmonic mean slopes keep progress monotone and share velocity at
    // the adjacent legs. Music owns the clock between these exact arrivals.
    const slopes = sampled.marks.slice(1).map((mark, i) => (mark - sampled.marks[i]) / (times[i + 1] - times[i]));
    const speeds = times.map((_, i) => i === 0 ? slopes[0] : i === times.length - 1 ? slopes.at(-1)
      : 2 / (1 / slopes[i - 1] + 1 / slopes[i]));
    const landmarks = anchors.map(({ id, label }, i) => ({ id, label, progress01: times[i] }));
    return { ...sampled, kind: 'inland', times, speeds, anchors, landmarks, pivotM,
      principalSlot: pair.principal.slotId, companionSlot: pair.companion.slotId };
  }
  return null;
}

function distanceAt(route, i, u) {
  const span = route.times[i + 1] - route.times[i], t = u * u, v = t * u;
  return (2 * v - 3 * t + 1) * route.marks[i] + (v - 2 * t + u) * span * route.speeds[i]
    + (3 * t - 2 * v) * route.marks[i + 1] + (v - t) * span * route.speeds[i + 1];
}

/** Apply the planned route and keep the normal late-admission and zoom
 * contract, including a sampled clearance check for the handoff. */
export function inlandFlightPose(pose, route, movement, { baseM, rise01, slotRise01, heightAt }) {
  const gain = clamp01(movement.gain);
  if (!gain) return pose;
  const p = clamp01(movement.progress01);
  let i = 0;
  while (i < route.times.length - 2 && p >= route.times[i + 1]) i++;
  const u = clamp01((p - route.times[i]) / (route.times[i + 1] - route.times[i]));
  const travelM = distanceAt(route, i, u);
  const flight = pathPoseAt(route.path, travelM);
  const eyeM = blend(pose.eyeM, flight.eyeM, gain);
  const groundM = heightAt(eyeM[0], eyeM[2]);
  if (!Number.isFinite(groundM)) return pose;
  const oldGroundM = gain < 1 ? heightAt(pose.eyeM[0], pose.eyeM[2]) : groundM;
  const oldClearance = Number.isFinite(oldGroundM) ? clamp(pose.eyeM[1] - oldGroundM, 0, CLEARANCE_M) : 0;
  eyeM[1] = Math.max(eyeM[1], groundM + lerp(oldClearance, CLEARANCE_M, gain));
  const drop = anchor => (anchor.pointM[1] - baseM) * (1 - (slotRise01?.[anchor.slotId] ?? rise01 ?? 1));
  const gaze = u * u * (3 - 2 * u);
  flight.targetM[1] -= lerp(drop(route.anchors[i]), drop(route.anchors[i + 1]), gaze);
  return { ...pose, eyeM, targetM: blend(pose.targetM, flight.targetM, gain), songprintOrbit: {
    progress01: p, gain, routeStyle: route.kind, pivotM: route.pivotM, travelM,
    principalSlot: route.principalSlot, companionSlot: route.companionSlot,
    landmarks: route.landmarks, from: route.landmarks[i].id, to: route.landmarks[i + 1].id,
  } };
}
