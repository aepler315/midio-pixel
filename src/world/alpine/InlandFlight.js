// Music-timed flight through an inland region (InlandRegion.js). The route
// follows the region's own drainage: low runs along the trunk valley and
// its largest tributaries, where valley walls, stands and the river give
// close parallax; climbs over a pass or spur, where the camera rises far
// enough to show how the valleys connect; and a closing reveal facing the
// returning summits. The song's transitions fix the arrival at each stage
// boundary and its smoothed energy paces the travel between them. The lens
// stays fixed: the camera moves, it does not zoom.
import { pathPoseAt, samplePath } from '../terrain/ShotPath.js';
import { scenePoseAt } from '../terrain/SceneTravel.js';
import { clamp, clamp01, lerp } from '../../utils/math.js';
import { DEFORM_PAD_M } from './RangeCamera.js';
import { terrainHeightAt } from './TerrainMesh.js';

// Low runs: eye height above the river bed, and the least clearance over
// any ground the eye passes (tree crowns included).
const LOW_AGL_M = 95;
const LOW_CLEAR_M = 62;
const REVEAL_CLEAR_M = 330;
// Ground speeds (m/s at the song's average pace). Low runs stay slow enough
// for the near slopes to read; reveals cover more ground at altitude.
const LOW_SPEED = 82, CLIMB_SPEED = 140, REVEAL_SPEED = 170;
const LOOK_AHEAD_M = 900;
const BOUNDS_MARGIN_M = 2500;
const PATH_SPACING_M = 40;
const GRADE = .34;
const distanceXZ = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const blend = (a, b, t) => a.map((value, i) => lerp(value, b[i], t));

function inside(bounds, x, z) {
  return x >= bounds.min[0] + BOUNDS_MARGIN_M && x <= bounds.max[0] - BOUNDS_MARGIN_M
    && z >= bounds.min[2] + BOUNDS_MARGIN_M && z <= bounds.max[2] - BOUNDS_MARGIN_M;
}

/** Travel time and stage boundaries (progress01) from the score. Up to
 *  three transitions give four stages; short songs get fewer. */
function scoreStations(movement) {
  const travelMs = movement.travelMs ?? 140000;
  const separated = [];
  for (const guide of movement.guides ?? []) {
    if (guide.progress01 >= .12 && guide.progress01 <= .88 && guide.progress01 - (separated.at(-1)?.progress01 ?? 0) >= .12)
      separated.push(guide);
  }
  const limit = travelMs < 22000 ? 0 : travelMs < 54000 ? 1 : travelMs < 115000 ? 2 : 3;
  const chosen = separated.slice(0, limit);
  const defaults = limit === 0 ? [] : limit === 1 ? [{ progress01: .5 }] : limit === 2 ? [{ progress01: .38 }, { progress01: .7 }]
    : [{ progress01: .26 }, { progress01: .52 }, { progress01: .77 }];
  const guides = chosen.length ? chosen : defaults;
  const times = [0, ...guides.map(g => g.progress01), 1];
  // Share of the song's time in each stage: from the guides' heard times
  // where known, otherwise in proportion to progress.
  const known = guides.every(g => Number.isFinite(g.timeMs)) && guides.length >= 2;
  const span = known ? (guides.at(-1).timeMs - guides[0].timeMs) / Math.max(.05, guides.at(-1).progress01 - guides[0].progress01) : 0;
  const shares = times.slice(1).map((t, i) => {
    if (known && i > 0 && i < guides.length) return (guides[i].timeMs - guides[i - 1].timeMs) / travelMs;
    if (known && span > 0) return (t - times[i]) * span / travelMs;
    return t - times[i];
  });
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  // Energy of a stage: progress made per unit of heard time.
  const energy = times.slice(1).map((t, i) => (t - times[i]) / (shares[i] / total));
  return { travelMs, times, shares: shares.map(s => s / total), energy };
}

function courseOf(river) {
  return river.course.map(([x, z, bed, area, gorge, broad]) => ({ x, z, bed, area, gorge, broad }));
}

/** Walk a course from index `i` in direction `dir` for `lengthM`. */
function walk(course, i, dir, lengthM) {
  const out = [course[i]];
  let k = i, done = 0;
  while (done < lengthM && k + dir >= 0 && k + dir < course.length) {
    done += Math.hypot(course[k + dir].x - course[k].x, course[k + dir].z - course[k].z);
    k += dir;
    out.push(course[k]);
  }
  return { points: out, end: k, lengthM: done };
}

function groundMax(data, x, z, radius) {
  let top = -Infinity;
  for (const [dx, dz] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
    const y = terrainHeightAt(data, x + dx, z + dz);
    if (Number.isFinite(y)) top = Math.max(top, y);
  }
  return top;
}

/** The direction along a course that runs longest over new ground. */
function bestDirection(points, index, want, keys) {
  const visited = keys.map(k => k.eyeM);
  const score = dir => {
    const run = walk(points, index, dir, want);
    return Math.min(1, run.lengthM / want) - 1.5 * overlap(run.points, visited);
  };
  return score(1) >= score(-1) ? 1 : -1;
}

/** Eye and aim keyframes for a low run along a course: a little to one side
 *  of the river, looking ahead down the valley to the water. */
function lowKeys(data, points, side) {
  const keys = [];
  for (let k = 0; k < points.length; k++) {
    const p = points[k], q = points[Math.min(points.length - 1, k + 1)], r = points[Math.max(0, k - 1)];
    let dx = q.x - r.x, dz = q.z - r.z;
    const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    const offset = side * 45;
    const x = p.x - dz * offset, z = p.z + dx * offset;
    // Find the aim LOOK_AHEAD_M further along the course.
    let ahead = k, run = 0;
    while (ahead < points.length - 1 && run < LOOK_AHEAD_M) {
      run += Math.hypot(points[ahead + 1].x - points[ahead].x, points[ahead + 1].z - points[ahead].z);
      ahead++;
    }
    const a = points[ahead];
    const extra = run < LOOK_AHEAD_M ? LOOK_AHEAD_M - run : 0;
    const tx = a.x + dx * extra, tz = a.z + dz * extra;
    const ty = (terrainHeightAt(data, tx, tz) || a.bed) + 30;
    keys.push({ eyeM: [x, p.bed + LOW_AGL_M, z], targetM: [tx, ty, tz], low: true });
  }
  return keys;
}

/** Share of a run's points within `radius` of where the flight has been. */
function overlap(points, visited, radius = 1400) {
  if (!visited.length) return 0;
  let near = 0;
  for (const p of points) if (visited.some(v => Math.hypot(v[0] - p.x, v[2] - p.z) < radius)) near++;
  return near / points.length;
}

function nearestIndex(course, x, z) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < course.length; i++) {
    const d = Math.hypot(course[i].x - x, course[i].z - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distanceM: bestD };
}

/**
 * Plan the stages: the opening runs low up the trunk; a pass or spur climb
 * reveals the network; a second low run follows another flown river (a
 * gorge where the region has one); the finale rises to face the returning
 * summits. Quiet stages take the reveals, energetic ones the low runs.
 */
function planStages(data, region, pair, stations, bounds) {
  const { times, travelMs, shares, energy } = stations;
  const legs = times.length - 1;
  const rivers = region.rivers.map(r => ({ ...r, points: courseOf(r) }))
    .filter(r => r.points.length >= 3);
  const trunk = rivers.find(r => r.trunk);
  if (!trunk) return null;
  const flown = rivers.filter(r => r.flown && r !== trunk).sort((a, b) => b.areaKm2 - a.areaKm2);
  const legSec = shares.map(s => s * travelMs / 1000);
  const mean = energy.reduce((a, b) => a + b, 0) / legs;
  const pace = energy.map(e => clamp(e / mean, .6, 1.6));
  const summit = pair.principal.pointM, companion = pair.companion.pointM;
  const summitsMid = blend(summit, companion, .5);
  // Stage kinds: the opening runs low and the close reveals the summits.
  // Middle stages alternate between valley runs and pass climbs; the music
  // decides the order, sending the quieter stage up for the wide view.
  const kinds = Array.from({ length: legs }, (_, i) => legs === 1 || i === 0 ? 'low' : i === legs - 1 ? 'finale' : null);
  const middle = kinds.map((k, i) => k ? -1 : i).filter(i => i >= 0);
  if (middle.length) {
    const quietFirst = middle.length === 1 || pace[middle[0]] <= pace[middle[1]];
    middle.forEach((leg, j) => { kinds[leg] = (j % 2 === 0) === quietFirst ? 'climb' : 'low'; });
  }
  const keys = [], boundaries = [0];
  // Opening: a stretch of the trunk inside the travelled area, flown
  // upstream so the valley and the ranges open ahead.
  const want0 = LOW_SPEED * legSec[0] * pace[0];
  const tPts = trunk.points;
  let start = -1, best = -Infinity;
  for (let i = 0; i < tPts.length; i++) {
    const p = tPts[i];
    if (!inside(bounds, p.x, p.z)) continue;
    const run = walk(tPts, i, -1, want0);
    const endP = run.points.at(-1);
    if (!inside(bounds, endP.x, endP.z)) continue;
    const toSummit = Math.hypot(summitsMid[0] - endP.x, summitsMid[2] - endP.z);
    const broad = run.points.reduce((s, q) => s + q.broad, 0) / run.points.length;
    const score = Math.min(run.lengthM, want0) / want0 * 3 + broad - toSummit / 30000;
    if (score > best) { best = score; start = i; }
  }
  if (start < 0) return null;
  let at = { river: trunk, index: start, dir: -1, next: null };
  const used = new Set([trunk.id]);
  for (let leg = 0; leg < legs; leg++) {
    const kind = kinds[leg];
    const speed = kind === 'low' ? LOW_SPEED : kind === 'climb' ? CLIMB_SPEED : REVEAL_SPEED;
    const want = Math.max(1500, speed * legSec[leg] * pace[leg]);
    const last = keys.at(-1);
    if (kind === 'low') {
      let { river, index, dir } = at;
      if (leg > 0 && at.entered) {
        ({ river, index, dir } = at);
        used.add(river.id);
      } else if (leg > 0 && at.next) {
        // Descend from the pass into the valley it looks over.
        river = at.next.river; index = at.next.index; used.add(river.id);
        dir = bestDirection(river.points, index, want, keys);
      } else if (leg > 0) {
        // Join a nearby flown river, favouring a gorge.
        const from = last ? last.eyeM : [tPts[start].x, 0, tPts[start].z];
        const options = [];
        for (const g of region.gorges ?? []) {
          const r = rivers.find(x => x.id === g.river);
          if (r && (!used.has(r.id) || r === trunk)) options.push({ r, index: nearestIndex(r.points, g.from[0], g.from[1]).index, bonus: 5000, dir: 1 });
        }
        for (const r of [...flown, trunk]) {
          if (used.has(r.id) && r !== trunk) continue;
          options.push({ r, index: nearestIndex(r.points, from[0], from[2]).index, bonus: r === trunk ? -2000 : 0, dir: 0 });
        }
        let pick = null, pickScore = Infinity;
        for (const o of options) {
          const q = o.r.points[o.index];
          const score = Math.hypot(q.x - from[0], q.z - from[2]) - o.bonus;
          if (inside(bounds, q.x, q.z) && score < pickScore) { pickScore = score; pick = o; }
        }
        if (!pick) pick = { r: trunk, index: at.index, dir: at.dir };
        river = pick.r; used.add(river.id); index = pick.index;
        dir = pick.dir || bestDirection(river.points, index, want, keys);
      }
      const run = walk(river.points, index, dir, want);
      const side = leg % 2 ? -1 : 1;
      const runKeys = lowKeys(data, run.points, side);
      // Skip keys behind the previous end when joining from a climb.
      keys.push(...runKeys);
      at = { river, index: run.end, dir, next: null };
    } else if (kind === 'climb') {
      // Rise over a pass ahead and look over the next valley: a pass with a
      // flown river close beneath its far side, so the descent stays short.
      const from = last.eyeM;
      const passes = (region.passes ?? []).filter(p => inside(bounds, p.x, p.z));
      let pass = null, next = null, score = Infinity;
      for (const p of passes) {
        const d = Math.hypot(p.x - from[0], p.z - from[2]);
        if (d > want * 1.4 || d < want * .3) continue;
        let below = null;
        for (const r of rivers) {
          if (!r.flown) continue;
          const near = nearestIndex(r.points, p.x, p.z);
          const q = r.points[near.index];
          if (near.distanceM > 4200 || !inside(bounds, q.x, q.z)) continue;
          // A new valley, not the stretch just flown.
          const fresh = 1 - Math.min(overlap(walk(r.points, near.index, 1, want * .7).points, keys.map(k => k.eyeM)),
            overlap(walk(r.points, near.index, -1, want * .7).points, keys.map(k => k.eyeM)));
          if (fresh < .5) continue;
          if (!below || near.distanceM < below.distanceM) below = { river: r, index: near.index, distanceM: near.distanceM };
        }
        const s = Math.abs(d - want * .8) + (below ? below.distanceM * .6 : 6000)
          + .1 * Math.hypot(p.x - summitsMid[0], p.z - summitsMid[2]);
        if (s < score) { score = s; pass = p; next = below; }
      }
      // Without a pass in reach, climb the nearest spur towards the summits.
      const toward = Math.min(1, want * .8 / Math.max(1, distanceXZ(from, summitsMid)));
      const target = pass ? [pass.x, pass.heightM, pass.z]
        : [lerp(from[0], summitsMid[0], toward), 0, lerp(from[2], summitsMid[2], toward)];
      const crest = groundMax(data, target[0], target[2], 400);
      const climb = [target[0], (Number.isFinite(crest) ? crest : target[1]) + REVEAL_CLEAR_M, target[2]];
      const midway = blend(from, climb, .45);
      midway[1] = Math.max(from[1] + 120, groundMax(data, midway[0], midway[2], 300) + REVEAL_CLEAR_M * .6);
      // Look past the crest: to the summits, or down the far valley.
      const lookTo = blend(climb, summitsMid, .55);
      lookTo[1] = lerp(climb[1] - 250, summitsMid[1], .5);
      keys.push({ eyeM: midway, targetM: blend(last.targetM, lookTo, .5) });
      keys.push({ eyeM: climb, targetM: lookTo });
      // Over the top and down into the valley beyond, so the next stage
      // opens low with the new river ahead.
      if (next && kinds[leg + 1] === 'low') {
        const q = next.river.points[next.index];
        const dir = bestDirection(next.river.points, next.index, LOW_SPEED * legSec[leg + 1] * pace[leg + 1], keys);
        const run = walk(next.river.points, next.index, dir, 1200);
        const entry = lowKeys(data, run.points, 1);
        const down = blend(climb, entry[0].eyeM, .55);
        down[1] = Math.max(lerp(climb[1], entry[0].eyeM[1], .7), groundMax(data, down[0], down[2], 300) + REVEAL_CLEAR_M * .5);
        keys.push({ eyeM: down, targetM: blend(lookTo, entry[0].targetM, .6) });
        keys.push(entry[0]);
        at = { river: next.river, index: next.index, dir, next: null, entered: true };
        void q;
      } else at = { ...at, next };
    } else {
      // Finale: rise to face the returning summits across the region.
      const from = last.eyeM;
      let bestEye = null, bestScore = -Infinity;
      for (let k = 0; k < 16; k++) {
        const angle = k * Math.PI / 8;
        for (const radius of [9000, 12500, 16000]) {
          const x = summitsMid[0] + radius * Math.cos(angle), z = summitsMid[2] + radius * Math.sin(angle);
          if (!inside(bounds, x, z)) continue;
          const d = Math.hypot(x - from[0], z - from[2]);
          const s = -Math.abs(d - want) / want - .4 * Math.abs(radius - 12500) / 12500;
          if (s > bestScore) { bestScore = s; bestEye = [x, z]; }
        }
      }
      if (!bestEye) bestEye = [lerp(from[0], summitsMid[0], .3), lerp(from[2], summitsMid[2], .3)];
      const ground = groundMax(data, bestEye[0], bestEye[1], 600);
      const eyeM = [bestEye[0], Math.max(ground + REVEAL_CLEAR_M + 250, lerp(ground, summitsMid[1], .55)), bestEye[1]];
      const midway = blend(from, eyeM, .5);
      midway[1] = Math.max(lerp(from[1], eyeM[1], .6), groundMax(data, midway[0], midway[2], 400) + REVEAL_CLEAR_M);
      keys.push({ eyeM: midway, targetM: blend(last.targetM, summitsMid, .6) });
      keys.push({ eyeM, targetM: summitsMid, summits: true });
    }
    boundaries.push(keys.length - 1);
  }
  return { keys, boundaries, kinds };
}

/** Per-sample clearance and a smooth altitude envelope. Low stretches keep
 *  close to their planned height; anything under the clearance lifts. */
function clearPath(path, data, bounds, heightRange) {
  const n = path.s.length;
  const minimum = new Float64Array(n), envelope = new Float64Array(n);
  const [h0, h1] = heightRange;
  const pad = g => DEFORM_PAD_M * (h1 > h0 ? clamp01((g - h0) / (h1 - h0)) ** 2 : 1);
  for (let i = 0; i < n; i++) {
    const x = path.eye[i * 3], z = path.eye[i * 3 + 2];
    if (!inside({ min: [bounds.min[0] - BOUNDS_MARGIN_M * .6, 0, bounds.min[2] - BOUNDS_MARGIN_M * .6],
      max: [bounds.max[0] + BOUNDS_MARGIN_M * .6, 0, bounds.max[2] + BOUNDS_MARGIN_M * .6] }, x, z)) return false;
    const g = groundMax(data, x, z, 55);
    if (!Number.isFinite(g)) return false;
    minimum[i] = g + LOW_CLEAR_M + pad(g);
    envelope[i] = Math.max(minimum[i], path.eye[i * 3 + 1]);
  }
  // Limit climb and descent rates in both directions, then smooth.
  for (let i = 1; i < n; i++) envelope[i] = Math.max(envelope[i], envelope[i - 1] - GRADE * (path.s[i] - path.s[i - 1]));
  for (let i = n - 2; i >= 0; i--) envelope[i] = Math.max(envelope[i], envelope[i + 1] - GRADE * (path.s[i + 1] - path.s[i]));
  const smoothed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, weight = 0;
    for (let k = -6; k <= 6; k++) {
      const j = clamp(i + k, 0, n - 1), w = 7 - Math.abs(k);
      sum += envelope[j] * w; weight += w;
    }
    smoothed[i] = Math.max(minimum[i], sum / weight);
  }
  for (let i = 0; i < n; i++) path.eye[i * 3 + 1] = smoothed[i];
  return true;
}

/** Build the flight before any movement. Returns null when the region or
 *  the score cannot carry one (the bounded orbit then takes over). */
export function compileInlandFlight(data, view, movement) {
  const bounds = data?.manifest?.boundsM, pair = view.songprintComposition;
  const region = data?.manifest?.hydrology?.region;
  if (!view.songRange?.plan?.inland || !bounds || !pair || !movement || !region?.rivers?.length) return null;
  const stations = scoreStations(movement);
  const home = scenePoseAt(view, { progress01: .5 });
  const plan = planStages(data, region, pair, stations, bounds);
  if (!plan || plan.keys.length < 2) return null;
  // Drop keyframes that fall on top of each other.
  const eyes = [], aims = [], keyAt = [];
  for (const [i, key] of plan.keys.entries()) {
    if (eyes.length && distanceXZ(eyes.at(-1), key.eyeM) < 60 && !plan.boundaries.includes(i)) { keyAt[i] = eyes.length - 1; continue; }
    eyes.push(key.eyeM); aims.push(key.targetM); keyAt[i] = eyes.length - 1;
  }
  if (eyes.length < 2) return null;
  const path = samplePath({ eyes, aims, fovs: home.fovYDeg, spacingM: PATH_SPACING_M, minSamples: 64 });
  const heightRange = [bounds.min[1], bounds.max[1]];
  if (!clearPath(path, data, bounds, heightRange)) return null;
  // Path distance at each stage boundary: the nearest sample to its eye.
  const marks = plan.boundaries.map(b => {
    const target = eyes[keyAt[b]];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < path.s.length; i++) {
      const d = Math.hypot(path.eye[i * 3] - target[0], path.eye[i * 3 + 2] - target[2]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return path.s[best];
  });
  marks[0] = 0; marks[marks.length - 1] = path.s[path.s.length - 1];
  for (let i = 1; i < marks.length; i++) marks[i] = Math.max(marks[i], marks[i - 1] + 1);
  const { times } = stations;
  const slopes = marks.slice(1).map((mark, i) => (mark - marks[i]) / (times[i + 1] - times[i]));
  const speeds = times.map((_, i) => i === 0 ? slopes[0] : i === times.length - 1 ? slopes.at(-1)
    : 2 / (1 / slopes[i - 1] + 1 / slopes[i]));
  const labels = { low: 'Valley run', climb: 'Pass reveal', finale: 'Returning summits' };
  const landmarks = times.map((progress01, i) => ({ id: i === 0 ? 'start' : `${plan.kinds[i - 1]}-${i}`,
    label: i === 0 ? 'Valley' : labels[plan.kinds[i - 1]], progress01 }));
  return { path, marks, kind: 'inland', times, speeds, kinds: plan.kinds, landmarks, heightRange,
    anchors: landmarks.map(l => ({ ...l, kind: 'route' })),
    pivotM: blend(pair.principal.pointM, pair.companion.pointM, .5),
    principalSlot: pair.principal.slotId, companionSlot: pair.companion.slotId };
}

function distanceAt(route, i, u) {
  const span = route.times[i + 1] - route.times[i], t = u * u, v = t * u;
  return (2 * v - 3 * t + 1) * route.marks[i] + (v - 2 * t + u) * span * route.speeds[i]
    + (3 * t - 2 * v) * route.marks[i + 1] + (v - t) * span * route.speeds[i + 1];
}

/** Apply the planned route with the normal late-admission contract and a
 *  sampled clearance check for the handoff from the rail. */
export function inlandFlightPose(pose, route, movement, { heightAt }) {
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
  const [h0, h1] = route.heightRange;
  const pad = DEFORM_PAD_M * (h1 > h0 ? clamp01((groundM - h0) / (h1 - h0)) ** 2 : 1);
  eyeM[1] = Math.max(eyeM[1], groundM + LOW_CLEAR_M * .8 + pad);
  const kind = route.kinds[i];
  return { ...pose, eyeM, targetM: blend(pose.targetM, flight.targetM, gain), songprintOrbit: {
    progress01: p, gain, routeStyle: route.kind, pivotM: route.pivotM, travelM, mode: kind,
    aglM: Math.round(eyeM[1] - groundM),
    principalSlot: route.principalSlot, companionSlot: route.companionSlot,
    landmarks: route.landmarks, from: route.landmarks[i].id, to: route.landmarks[i + 1].id,
  } };
}
