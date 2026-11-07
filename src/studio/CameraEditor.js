// Geographic camera authoring shared by the editor, CPU preview and saved projects.
// DEM values are north-up cell centres. Assessments are coarse geometric advice,
// not production collision approval (trees and animated terrain are not measured).
const DEG = Math.PI / 180;
const LAT_M = 110540;
const LON_M = 111320;
const CLEARANCE_M = 12;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const wrap = value => ((value % 360) + 360) % 360;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export const CAMERA_FIELDS = Object.freeze([
  { key: 'lon', label: 'Longitude', min: -180, max: 180, step: 0.0001, unit: '°', group: 'Position' },
  { key: 'lat', label: 'Latitude', min: -85, max: 85, step: 0.0001, unit: '°', group: 'Position' },
  { key: 'aboveGroundM', label: 'Above ground', min: 2, max: 6000, step: 5, unit: 'm', group: 'Position' },
  { key: 'headingDeg', label: 'Heading', min: 0, max: 359.99, step: 1, unit: '°', group: 'Framing' },
  { key: 'pitchDeg', label: 'Pitch', min: -60, max: 60, step: 0.5, unit: '°', group: 'Framing' },
  { key: 'hfovDeg', label: 'Horizontal field of view', min: 15, max: 105, step: 1, unit: '°', group: 'Framing' },
  { key: 'orbitDeg', label: 'Orbit sweep', min: -90, max: 90, step: 1, unit: '°', group: 'Motion' },
  { key: 'travelM', label: 'Forward travel', min: -12000, max: 12000, step: 25, unit: 'm', group: 'Motion' },
  { key: 'craneM', label: 'Crane rise', min: -2500, max: 2500, step: 10, unit: 'm', group: 'Motion' },
  { key: 'durationSec', label: 'Duration', min: 6, max: 240, step: 1, unit: 's', group: 'Motion' },
  { key: 'motionAmount', label: 'Motion amount', min: 0, max: 1, step: 0.05, unit: '', group: 'Motion' },
  { key: 'targetDistanceM', label: 'Orbit distance', min: 100, max: 80000, step: 100, unit: 'm', group: 'Target' },
  { key: 'targetHeightM', label: 'Target above ground', min: -1000, max: 10000, step: 10, unit: 'm', group: 'Target' },
  { key: 'targetLon', label: 'Target longitude', min: -180, max: 180, step: 0.0001, unit: '°', group: 'Target' },
  { key: 'targetLat', label: 'Target latitude', min: -85, max: 85, step: 0.0001, unit: '°', group: 'Target' },
].map(Object.freeze));

export const CAMERA_PRESETS = Object.freeze({
  wide: Object.freeze({ hfovDeg: 80, pitchDeg: 0, aboveGroundM: 300, orbitDeg: 12, travelM: 400, craneM: 60, durationSec: 42, motionAmount: 0.65 }),
  intimate: Object.freeze({ hfovDeg: 36, pitchDeg: 2, aboveGroundM: 120, orbitDeg: 6, travelM: 180, craneM: 20, durationSec: 48, motionAmount: 0.45 }),
  aerial: Object.freeze({ hfovDeg: 65, pitchDeg: -16, aboveGroundM: 1400, orbitDeg: 20, travelM: 1000, craneM: 160, durationSec: 55, motionAmount: 0.75 }),
  calm: Object.freeze({ hfovDeg: 58, pitchDeg: 0, aboveGroundM: 220, orbitDeg: 3, travelM: 80, craneM: 10, durationSec: 75, motionAmount: 0.25 }),
});

function offset(lon, lat, eastM, northM) {
  return { lon: lon + eastM / (LON_M * Math.cos(lat * DEG)), lat: lat + northM / LAT_M };
}
function delta(from, to) {
  return { eastM: (to.lon - from.lon) * LON_M * Math.cos((from.lat + to.lat) * DEG / 2), northM: (to.lat - from.lat) * LAT_M };
}
function distance(from, to) {
  const d = delta(from, to);
  return Math.hypot(d.eastM, d.northM);
}
function bearing(from, to) {
  const d = delta(from, to);
  return wrap(Math.atan2(d.eastM, d.northM) / DEG);
}
function sourceDefaults(candidate) {
  const source = candidate?.camera || {};
  const eye = source.eye || {};
  const lon = clamp(finite(eye.lon, -110.8), -180, 180), lat = clamp(finite(eye.lat, 43.7), -85, 85);
  const headingDeg = wrap(finite(source.headingDeg, 0));
  const inferred = offset(lon, lat, Math.sin(headingDeg * DEG) * 10000, Math.cos(headingDeg * DEG) * 10000);
  const target = { lon: clamp(finite(source.target?.lon, inferred.lon), -180, 180),
    lat: clamp(finite(source.target?.lat, inferred.lat), -85, 85) };
  return { lon, lat, aboveGroundM: finite(eye.aboveGroundM, 250), headingDeg,
    pitchDeg: finite(source.pitchDeg, 0), hfovDeg: finite(source.hfovDeg, 58),
    orbitDeg: 10, travelM: 350, craneM: 40, durationSec: 45, motionAmount: 0.6,
    targetDistanceM: Math.max(100, distance({ lon, lat }, target)), targetHeightM: 0,
    targetLon: target.lon, targetLat: target.lat, aimMode: 'heading',
    ...(Number.isFinite(eye.heightM) ? { heightM: eye.heightM } : {}),
  };
}

/** Preserve authored absolute eye height until an above-ground edit replaces it. */
export function defaultCamera(candidate = null) {
  return normalizeCamera(sourceDefaults(candidate));
}

export function normalizeCamera(input = {}, candidate = null) {
  input = input && typeof input === 'object' ? input : {};
  const defaults = sourceDefaults(candidate), normalized = {};
  for (const field of CAMERA_FIELDS) {
    const value = finite(input[field.key], defaults[field.key]);
    normalized[field.key] = field.key === 'headingDeg' ? wrap(value) : clamp(value, field.min, field.max);
  }
  normalized.aimMode = input.aimMode === 'target' ? 'target' : 'heading';
  // Explicit AGL settings without heightM replace an inherited absolute camera.
  const heightM = own(input, 'heightM') ? input.heightM : own(input, 'aboveGroundM') ? null : defaults.heightM;
  if (Number.isFinite(heightM)) normalized.heightM = clamp(heightM, -1000, 20000);
  return normalized;
}

function validGrid(grid) {
  return !!grid && Number.isInteger(grid.width) && Number.isInteger(grid.height)
    && grid.width >= 2 && grid.height >= 2 && grid.width * grid.height <= 4_194_304
    && grid.heightsM?.length === grid.width * grid.height
    && [grid.west, grid.south, grid.east, grid.north].every(Number.isFinite)
    && grid.east > grid.west && grid.north > grid.south;
}

/** Missing weighted samples stay missing; never extrapolate beyond source bounds. */
export function sampleHeight(grid, lon, lat) {
  if (!validGrid(grid) || !(lon >= grid.west && lon <= grid.east && lat >= grid.south && lat <= grid.north)) return NaN;
  const x = clamp((lon - grid.west) / (grid.east - grid.west) * grid.width - 0.5, 0, grid.width - 1);
  const y = clamp((grid.north - lat) / (grid.north - grid.south) * grid.height - 0.5, 0, grid.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, grid.width - 1), y1 = Math.min(y0 + 1, grid.height - 1);
  const ax = x - x0, ay = y - y0;
  let sum = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const weight = (col ? ax : 1 - ax) * (row ? ay : 1 - ay);
      if (!weight) continue;
      const value = grid.heightsM[(row ? y1 : y0) * grid.width + (col ? x1 : x0)];
      if (!Number.isFinite(value)) return NaN;
      sum += weight * value;
    }
  }
  return sum;
}

function phaseAt(time01) {
  const t = clamp(finite(time01, 0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth compass-space move; target aiming is resolved every frame, never interpolated angles. */
export function cameraAt(settings, time01 = 0, grid = null) {
  const s = normalizeCamera(settings), phase = phaseAt(time01) * s.motionAmount;
  const angle = s.orbitDeg * phase * DEG;
  const target = s.aimMode === 'target' ? { lon: s.targetLon, lat: s.targetLat }
    : offset(s.lon, s.lat, Math.sin(s.headingDeg * DEG) * s.targetDistanceM, Math.cos(s.headingDeg * DEG) * s.targetDistanceM);
  const relative = delta(target, s), c = Math.cos(angle), sn = Math.sin(angle);
  const rotated = offset(target.lon, target.lat, relative.eastM * c + relative.northM * sn, -relative.eastM * sn + relative.northM * c);
  // Use the unrotated exact position at phase zero, avoiding geographic conversion drift.
  const base = phase === 0 || s.orbitDeg === 0 ? s : rotated;
  const forward = (s.headingDeg + s.orbitDeg * phase) * DEG;
  const pos = offset(base.lon, base.lat, Math.sin(forward) * s.travelM * phase, Math.cos(forward) * s.travelM * phase);
  const aboveGroundM = Math.max(CLEARANCE_M, s.aboveGroundM + s.craneM * phase);
  const eye = { lon: clamp(pos.lon, -180, 180), lat: clamp(pos.lat, -85, 85), aboveGroundM };
  const ground = sampleHeight(grid, eye.lon, eye.lat);
  if (Number.isFinite(s.heightM)) eye.heightM = s.heightM + s.craneM * phase;
  if (Number.isFinite(ground)) {
    eye.heightM = Math.max(ground + CLEARANCE_M, Number.isFinite(eye.heightM) ? eye.heightM : ground + aboveGroundM);
    eye.aboveGroundM = eye.heightM - ground;
  }
  let headingDeg = wrap(s.headingDeg + s.orbitDeg * phase), pitchDeg = s.pitchDeg;
  if (s.aimMode === 'target') {
    const targetGround = sampleHeight(grid, s.targetLon, s.targetLat);
    const inferredGround = Number.isFinite(s.heightM) ? s.heightM - s.aboveGroundM : 0;
    const targetHeight = finite(targetGround, finite(ground, inferredGround)) + s.targetHeightM;
    const eyeHeight = finite(eye.heightM, finite(ground, 0) + eye.aboveGroundM);
    headingDeg = bearing(eye, target);
    pitchDeg = clamp(Math.atan2(targetHeight - eyeHeight, Math.max(1, distance(eye, target))) / DEG, -60, 60);
  }
  return { eye, headingDeg, pitchDeg, hfovDeg: s.hfovDeg };
}

function gridDistance(grid) {
  return distance({ lon: grid.west, lat: grid.south }, { lon: grid.east, lat: grid.north });
}

function skyline(pose, grid, maxDistanceM) {
  const sky = [], angles = [], coverage = [];
  const halfVertical = Math.atan(Math.tan(pose.hfovDeg * DEG / 2) * 9 / 16);
  const firstM = Math.max(30, Math.min(finite(grid.cellM, 250), maxDistanceM / 32) * 0.7);
  for (let column = 0; column < 9; column++) {
    const ray = (pose.headingDeg + (column / 8 - 0.5) * pose.hfovDeg) * DEG;
    let topAngle = -Math.PI / 2, lastDistance = 0;
    for (let step = 0; step < 32; step++) {
      const d = firstM * Math.pow(maxDistanceM / firstM, step / 31);
      const pos = offset(pose.eye.lon, pose.eye.lat, Math.sin(ray) * d, Math.cos(ray) * d);
      const ground = sampleHeight(grid, pos.lon, pos.lat);
      if (!Number.isFinite(ground)) break;
      lastDistance = d;
      const curvature = d * d / (2 * 6371000 * 7 / 6);
      topAngle = Math.max(topAngle, Math.atan2(ground - pose.eye.heightM - curvature, d));
    }
    coverage.push(lastDistance / maxDistanceM);
    angles.push(topAngle / DEG);
    const relativeAngle = topAngle - pose.pitchDeg * DEG;
    const fraction = lastDistance === 0 || relativeAngle <= -halfVertical ? 1
      : relativeAngle >= halfVertical ? 0 : 0.5 - Math.tan(relativeAngle) / (2 * Math.tan(halfVertical));
    sky.push(clamp(fraction, 0, 1));
  }
  const visibleAngles = angles.filter(angle => angle > -89);
  return { skyFraction: sky.reduce((a, b) => a + b, 0) / sky.length,
    terrainCoverage: coverage.reduce((a, b) => a + b, 0) / coverage.length,
    skylineReliefDeg: visibleAngles.length ? Math.max(...visibleAngles) - Math.min(...visibleAngles) : 0 };
}

function targetVisible(s, pose, grid) {
  if (s.aimMode !== 'target') return null;
  const target = { lon: s.targetLon, lat: s.targetLat }, targetGround = sampleHeight(grid, target.lon, target.lat);
  if (!Number.isFinite(targetGround)) return false;
  const height = targetGround + s.targetHeightM;
  for (let n = 1; n < 24; n++) {
    const t = n / 24, lon = pose.eye.lon + (target.lon - pose.eye.lon) * t, lat = pose.eye.lat + (target.lat - pose.eye.lat) * t;
    const ground = sampleHeight(grid, lon, lat);
    if (!Number.isFinite(ground) || ground > pose.eye.heightM + (height - pose.eye.heightM) * t + 10) return false;
  }
  return true;
}

/** Bounded coarse checks of nine actual path positions and three view cones. */
export function analyzeCamera(settings, grid = null) {
  const s = normalizeCamera(settings), warnings = [];
  const measured = validGrid(grid);
  let minClearanceM = Infinity, covered = 0, pathLengthM = 0, previous;
  const poses = [];
  for (let n = 0; n <= 8; n++) {
    const pose = cameraAt(s, n / 8, measured ? grid : null), phase = phaseAt(n / 8) * s.motionAmount;
    poses.push(pose);
    const ground = measured ? sampleHeight(grid, pose.eye.lon, pose.eye.lat) : NaN;
    if (Number.isFinite(ground)) covered++;
    const clearance = Number.isFinite(s.heightM) && Number.isFinite(ground) ? s.heightM + s.craneM * phase - ground
      : s.aboveGroundM + s.craneM * phase;
    minClearanceM = Math.min(minClearanceM, clearance);
    if (previous) pathLengthM += distance(previous.eye, pose.eye);
    previous = pose;
  }
  const metrics = { measured, pathCoverage: measured ? covered / 9 : null, minClearanceM,
    pathLengthM, speedMps: pathLengthM / s.durationSec, terrainCoverage: null, skyFraction: null,
    skylineReliefDeg: null, targetVisible: null, targetDistanceM: distance(poses[0].eye, { lon: s.targetLon, lat: s.targetLat }) };
  let score = 70;
  if (!measured) warnings.push('Terrain is unmeasured. Load a terrain preview to assess source coverage, skyline and target visibility.');
  if (minClearanceM < 30) warnings.push(`Requested camera clearance falls to ${Math.round(minClearanceM)} m; the coarse preview raises intersecting frames to ${CLEARANCE_M} m.`);
  if (metrics.speedMps > 120) warnings.push('The move is fast for a terrain study. Increase duration or reduce travel.');
  if (measured) {
    if (covered < 9) warnings.push('The motion path crosses missing terrain or the source boundary.');
    const maxDistance = Math.min(60000, Math.max(1000, gridDistance(grid) * 0.55));
    const views = [0, 4, 8].filter(index => Number.isFinite(poses[index].eye.heightM))
      .map(index => skyline(poses[index], grid, maxDistance));
    metrics.skyFraction = views.length ? views.reduce((sum, view) => sum + view.skyFraction, 0) / views.length : 1;
    metrics.terrainCoverage = views.length ? views.reduce((sum, view) => sum + view.terrainCoverage, 0) / views.length : 0;
    metrics.skylineReliefDeg = views.length ? views.reduce((sum, view) => sum + view.skylineReliefDeg, 0) / views.length : 0;
    metrics.targetVisible = targetVisible(s, poses[4], grid);
    if (metrics.skyFraction > 0.85) warnings.push('Most of the frame is sky; lower the aim to keep terrain and a useful horizon visible.');
    if (metrics.skyFraction < 0.1) warnings.push('The frame has little sky; raise the aim for a clearer horizon.');
    if (metrics.terrainCoverage < 0.25) warnings.push('Available terrain covers only a short part of the view cone.');
    if (metrics.targetVisible === false) warnings.push('The target is hidden by foreground terrain or lies outside measured coverage.');
    const composition = clamp(1 - Math.abs(metrics.skyFraction - 0.42) / 0.58, 0, 1);
    score = metrics.pathCoverage * 28 + clamp(minClearanceM / 80, 0, 1) * 15 + composition * 22
      + metrics.terrainCoverage * 12 + clamp(metrics.skylineReliefDeg / 8, 0, 1) * 12
      + (metrics.targetVisible === false ? 0 : 11);
  } else {
    score -= minClearanceM < 30 ? 25 : 0;
    score -= Math.max(0, Math.abs(s.pitchDeg) - 15) * 0.6;
  }
  score = Math.round(clamp(score - Math.max(0, metrics.speedMps - 120) * 0.1, 0, 100));
  const summary = !measured ? 'Camera controls checked; terrain assessment awaits a preview.'
    : warnings.length ? `${score}/100 coarse composition estimate. ${warnings[0]}`
      : `${score}/100 coarse composition estimate; sampled route is covered with a readable terrain skyline.`;
  return { score, warnings, summary, metrics };
}

function changesBetween(before, after) {
  const changes = [];
  for (const field of CAMERA_FIELDS) {
    if (Math.abs(after[field.key] - before[field.key]) > 1e-7) changes.push(`${field.label}: ${Number(before[field.key].toFixed(4))} → ${Number(after[field.key].toFixed(4))}${field.unit ? ` ${field.unit}` : ''}`);
  }
  if (before.aimMode !== after.aimMode) changes.push(`Aim: ${after.aimMode === 'target' ? 'track geographic terrain subject' : 'compass heading'}`);
  if (Number.isFinite(before.heightM) && !Number.isFinite(after.heightM)) changes.push('Converted authored absolute height to terrain-following clearance.');
  return changes;
}
function restoreLocks(settings, original, locks) {
  for (const key of locks) {
    if (own(original, key)) settings[key] = original[key];
    else delete settings[key];
  }
  return settings;
}
function routeCovered(s, grid) {
  for (let n = 0; n <= 16; n++) {
    const pose = cameraAt(s, n / 16, grid);
    if (!Number.isFinite(sampleHeight(grid, pose.eye.lon, pose.eye.lat))) return false;
  }
  return true;
}

function safeSettings(settings, grid, original, locks) {
  const out = { ...settings }, locked = new Set(locks);
  const set = (key, value) => { if (!locked.has(key)) out[key] = value; };
  const ground = sampleHeight(grid, out.lon, out.lat);
  if (!locked.has('heightM') && Number.isFinite(out.heightM)) {
    set('aboveGroundM', Math.max(80, Number.isFinite(ground) ? out.heightM - ground : out.aboveGroundM));
    delete out.heightM;
  }
  set('aboveGroundM', Math.max(60, out.aboveGroundM));
  set('craneM', Math.max(out.craneM, (40 - out.aboveGroundM) / Math.max(0.01, out.motionAmount)));
  if (validGrid(grid)) {
    // Move an uncovered start to the nearest valid cell; never invent ground.
    if (!Number.isFinite(sampleHeight(grid, out.lon, out.lat))) {
      let nearest = null, best = Infinity;
      const stride = Math.max(1, Math.ceil(Math.max(grid.width, grid.height) / 32));
      for (let row = 0; row < grid.height; row += stride) for (let col = 0; col < grid.width; col += stride) {
        if (!Number.isFinite(grid.heightsM[row * grid.width + col])) continue;
        const pos = { lon: grid.west + (col + 0.5) / grid.width * (grid.east - grid.west), lat: grid.north - (row + 0.5) / grid.height * (grid.north - grid.south) };
        const d = distance(out, pos);
        if (d < best) { nearest = pos; best = d; }
      }
      if (nearest) { set('lon', nearest.lon); set('lat', nearest.lat); }
    }
    for (let attempt = 0; attempt < 8 && !routeCovered(out, grid); attempt++) {
      set('travelM', out.travelM * 0.45);
      set('orbitDeg', out.orbitDeg * 0.45);
    }
    if (!routeCovered(out, grid)) { set('travelM', 0); set('orbitDeg', 0); }
  }
  return restoreLocks(normalizeCamera(out), original, locks);
}

function chooseSubject(s, grid) {
  const ground = finite(sampleHeight(grid, s.lon, s.lat), 0);
  const candidates = [];
  const stride = Math.max(1, Math.ceil(Math.max(grid.width, grid.height) / 32));
  for (let row = 0; row < grid.height; row += stride) for (let col = 0; col < grid.width; col += stride) {
    const heightM = grid.heightsM[row * grid.width + col];
    if (!Number.isFinite(heightM)) continue;
    const point = { lon: grid.west + (col + 0.5) / grid.width * (grid.east - grid.west), lat: grid.north - (row + 0.5) / grid.height * (grid.north - grid.south) };
    const d = distance(s, point);
    if (d < Math.max(300, finite(grid.cellM, 250) * 1.25) || d > 80000) continue;
    // Prefer prominent elevated terrain, with a small cost for very distant peaks.
    const value = heightM - ground - d * 0.015;
    candidates.push({ ...point, heightM, distanceM: d, score: value });
  }
  candidates.sort((a, b) => b.score - a.score);
  const pose = cameraAt(s, 0, grid);
  // A tall summit behind a closer ridge is a poor subject. Bound visibility
  // work to the strongest 24 geographic candidates, retaining a useful fallback.
  return candidates.slice(0, 24).find(point => targetVisible({ ...s, aimMode: 'target',
    targetLon: point.lon, targetLat: point.lat, targetHeightM: 0 }, pose, grid)) || candidates[0] || null;
}

function improvedSettings(s, grid, locks) {
  let out = safeSettings(s, grid, s, locks);
  const locked = new Set(locks), set = (key, value) => { if (!locked.has(key)) out[key] = value; };
  set('pitchDeg', clamp(out.pitchDeg, -10, 12));
  set('hfovDeg', clamp(out.hfovDeg, 36, 82));
  if (validGrid(grid)) {
    const subject = chooseSubject(out, grid);
    if (subject) {
      set('targetLon', subject.lon); set('targetLat', subject.lat); set('targetHeightM', 0);
      set('targetDistanceM', distance(out, { lon: out.targetLon, lat: out.targetLat }));
      // A locked heading or pitch also locks that framing intent: keep compass aim.
      if (!locked.has('headingDeg') && !locked.has('pitchDeg')) set('aimMode', 'target');
      const pose = cameraAt({ ...out, aimMode: 'target', orbitDeg: 0, travelM: 0, craneM: 0 }, 0, grid);
      set('headingDeg', pose.headingDeg); set('pitchDeg', pose.pitchDeg);
    }
  }
  set('durationSec', Math.max(out.durationSec, Math.min(240, Math.abs(out.travelM) * out.motionAmount / 50)));
  out = safeSettings(out, grid, s, locks);
  return out;
}

export function improveCamera(settings, { candidate = null, grid = null, locks = [] } = {}) {
  const original = normalizeCamera(settings, candidate);
  locks = Array.isArray(locks) ? locks : [];
  let out = improvedSettings(original, grid, locks), report = analyzeCamera(out, grid);
  const before = analyzeCamera(original, grid);
  // Advice must not silently replace an already stronger camera with a weaker one.
  if (report.score < before.score && before.metrics.minClearanceM >= 30 && before.metrics.pathCoverage !== 0) { out = original; report = before; }
  return { settings: out, report: { ...report, changes: changesBetween(original, out),
    summary: changesBetween(original, out).length ? `Adjusted terrain clearance, subject and framing. ${report.summary}` : `Current camera retained. ${report.summary}` } };
}

function seededRandom(seed) {
  const input = String(seed);
  let value = 2166136261;
  for (let i = 0; i < input.length; i++) value = Math.imul(value ^ input.charCodeAt(i), 16777619);
  return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Evaluate at most 24 seeded alternatives; every lock survives terrain repairs. */
export function randomizeCamera(settings, { seed = 1, strength = 0.5, locks = [], candidate = null, grid = null } = {}) {
  const original = normalizeCamera(settings, candidate), amount = clamp(finite(strength, 0.5), 0, 1);
  locks = Array.isArray(locks) ? locks : [];
  if (amount === 0) return { settings: original, report: { ...analyzeCamera(original, grid), changes: [] } };
  const random = seededRandom(seed), locked = new Set(locks);
  let best = null, bestRank = -Infinity, bestReport;
  const spatialM = validGrid(grid) ? Math.min(3500, gridDistance(grid) * 0.07) : 1500;
  const scales = { aboveGroundM: Math.max(160, original.aboveGroundM * 0.9), headingDeg: 100, pitchDeg: 16,
    hfovDeg: 30, orbitDeg: 42, travelM: 2200, craneM: 420, durationSec: 55, motionAmount: 0.6,
    targetDistanceM: Math.max(2500, original.targetDistanceM * 0.6), targetHeightM: 180 };
  for (let attempt = 0; attempt < 24; attempt++) {
    const proposal = { ...original };
    const shift = offset(original.lon, original.lat, (random() * 2 - 1) * spatialM * amount, (random() * 2 - 1) * spatialM * amount);
    if (!locked.has('lon')) proposal.lon = shift.lon;
    if (!locked.has('lat')) proposal.lat = shift.lat;
    for (const [key, scale] of Object.entries(scales)) if (!locked.has(key)) proposal[key] += (random() * 2 - 1) * scale * amount;
    if (!locked.has('heightM') && !locked.has('aboveGroundM')) delete proposal.heightM;
    // Keep geographic targets on actual terrain; otherwise vary the compass move.
    if (!validGrid(grid)) {
      const target = offset(proposal.lon, proposal.lat, Math.sin(proposal.headingDeg * DEG) * proposal.targetDistanceM, Math.cos(proposal.headingDeg * DEG) * proposal.targetDistanceM);
      if (!locked.has('targetLon')) proposal.targetLon = target.lon;
      if (!locked.has('targetLat')) proposal.targetLat = target.lat;
    }
    const normalized = restoreLocks(normalizeCamera(proposal), original, locks);
    const out = safeSettings(normalized, grid, original, locks), report = analyzeCamera(out, grid);
    // Slight seeded preference among similarly composed options keeps variation.
    const rank = report.score + random() * 5;
    if (rank > bestRank) { bestRank = rank; best = out; bestReport = report; }
  }
  return { settings: best, report: { ...bestReport, changes: changesBetween(original, best),
    summary: `Selected a seeded variation from 24 terrain-aware alternatives. ${bestReport.summary}` } };
}
