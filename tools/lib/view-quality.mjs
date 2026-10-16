// Offline local-metre port of skyline marching, rayProfile, frameScore and
// summitVisibility from ridgeview/src/core/viewpoints.js. No Ridgeview import
// is shipped to the app. Added elevation-aware terms from the tour plan.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { clamp, smoothstep } from '../../src/utils/math.js';

const DEG = Math.PI / 180, ASPECT = 16 / 9, VERSION = 'tour-view-quality-1';
const HFOVS = [40, 55, 70], TIERS = [0, 120, 300, 600, 1000];
const HEADINGS = Array.from({ length: 72 }, (_, i) => i * 5);
const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;
const bump = (n, center, width) => Math.exp(-.5 * ((n - center) / width) ** 2);
const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const sorted = Float64Array.from(arr).sort();
  return sorted[Math.floor(q * (sorted.length - 1))];
};
const median = arr => quantile(arr, .5);
const vfovFor = hfov => 2 * Math.atan(Math.tan(hfov * DEG / 2) / ASPECT) / DEG;
export const curvatureDrop = distanceM => distanceM * distanceM * (1 - .13) / (2 * 6378137);

// Avoid allocations in the inner ray loop. Bilinear source coverage is
// checked here, including the validity mask (no invented terrain at holes).
function heightAt(grid, x, z) {
  const c = (x - grid.originM[0]) / grid.cellSizeM, r = (z - grid.originM[1]) / grid.cellSizeM;
  if (!(c >= 0 && r >= 0 && c <= grid.width - 1 && r <= grid.height - 1)) return NaN;
  const c0 = Math.min(Math.floor(c), grid.width - 2), r0 = Math.min(Math.floor(r), grid.height - 2);
  const i = r0 * grid.width + c0, t = c - c0, u = r - r0, h = grid.heightsM;
  if (grid.valid && (!grid.valid[i] || !grid.valid[i + 1] || !grid.valid[i + grid.width] || !grid.valid[i + grid.width + 1])) return NaN;
  return (h[i] * (1 - t) + h[i + 1] * t) * (1 - u) + (h[i + grid.width] * (1 - t) + h[i + grid.width + 1] * t) * u;
}

function marchRay(grid, eye, az, maxDist, water, buf) {
  const dx = Math.sin(az * DEG), dz = -Math.cos(az * DEG), cell = grid.cellSizeM;
  let d = Math.max(30, cell / 2), count = 0, horizon = -Infinity;
  while (d <= maxDist && count < buf.angle.length) {
    const x = eye[0] + d * dx, z = eye[2] + d * dz, h = heightAt(grid, x, z);
    if (!Number.isFinite(h)) break;
    const angle = Math.atan2(h - curvatureDrop(d) - eye[1], d) / DEG;
    buf.angle[count] = angle; buf.distance[count] = d; buf.height[count] = h;
    buf.x[count] = x; buf.z[count] = z; buf.visible[count] = angle >= horizon ? 1 : 0;
    const c = Math.round((x - grid.originM[0]) / cell), r = Math.round((z - grid.originM[1]) / cell);
    buf.water[count] = water?.[r * grid.width + c] ? 1 : 0;
    horizon = Math.max(horizon, angle); count++;
    d += Math.max(cell * .7, d * .004);
  }
  return count;
}

function makeBuffer() {
  const length = 4096;
  return { angle: new Float64Array(length), distance: new Float64Array(length), height: new Float64Array(length),
    x: new Float64Array(length), z: new Float64Array(length), visible: new Uint8Array(length), water: new Uint8Array(length) };
}

function rayProfile(buf, count, crest) {
  let skyIndex = -1, skyAngle = -Infinity;
  for (let i = 0; i < count; i++) if (buf.angle[i] > skyAngle) { skyAngle = buf.angle[i]; skyIndex = i; }
  if (skyIndex < 0) return null;
  const skyDistance = buf.distance[skyIndex], skyHeight = buf.height[skyIndex];
  let base = skyAngle, minAll = skyAngle, waterSeen = 0, waterAngle = -90;
  let nearLow = 90, nearHigh = -90, layers = 0, lastLayerDistance = -Infinity;
  for (let i = 0; i < count; i++) {
    if (i < skyIndex && buf.distance[i] >= .35 * skyDistance) {
      minAll = Math.min(minAll, buf.angle[i]);
      if (buf.visible[i]) base = Math.min(base, buf.angle[i]);
    }
    if (buf.visible[i] && buf.distance[i] <= 2000) {
      nearLow = Math.min(nearLow, buf.angle[i]); nearHigh = Math.max(nearHigh, buf.angle[i]);
    }
    if (i < skyIndex && buf.visible[i] && buf.water[i] && buf.distance[i] > 150) {
      waterSeen = 1; waterAngle = Math.max(waterAngle, buf.angle[i]);
    }
    // Distinct visible ridge crests along this sight line, separated in
    // depth by >1.5 km. Height maxima avoid counting each rising slope cell.
    if (i > 0 && i + 1 < count && buf.visible[i] && buf.height[i] >= buf.height[i - 1]
      && buf.height[i] > buf.height[i + 1] && buf.distance[i] - lastLayerDistance > 1500) {
      layers++; lastLayerDistance = buf.distance[i];
    }
  }
  const onCrest = crest.some(p => {
    const radius = Math.max(1000, Math.min(3500, (p.reliefM || 1000) * 1.5));
    return Math.hypot(buf.x[skyIndex] - p.localM[0], buf.z[skyIndex] - p.localM[2]) <= radius
      && skyHeight >= p.localM[1] - Math.max(100, (p.reliefM || 1000) * .35);
  });
  return { skyAngle, skyDistance, skyHeight, base, face: skyAngle - base,
    open: (skyAngle - base) / Math.max(.001, skyAngle - minAll), onCrest,
    waterSeen, waterAngle, nearLow, nearHigh, layers };
}

function subjectVisibility(grid, eye, point, buf, water) {
  const dx = point.localM[0] - eye[0], dz = point.localM[2] - eye[2], distance = Math.hypot(dx, dz);
  if (distance < 1) return true;
  const heading = Math.atan2(dx, -dz) / DEG;
  const n = marchRay(grid, eye, heading, distance + 200, water, buf);
  let horizon = -Infinity, best = -Infinity, bestHorizon = -Infinity;
  for (let i = 0; i < n; i++) {
    if (Math.abs(buf.distance[i] - distance) <= 600 && buf.height[i] >= point.localM[1] - 40 && buf.angle[i] > best) {
      best = buf.angle[i]; bestHorizon = horizon;
    }
    horizon = Math.max(horizon, buf.angle[i]);
  }
  return best > -Infinity && best >= bestHorizon - .05;
}

function frameScore(inFrame, hfov, eye, subject, heading) {
  const ownRays = inFrame.filter(r => r.p.onCrest), vfov = vfovFor(hfov);
  const empty = { own: 0, face: 0, fit: 0, open: 0, drama: 0, water: 0, summitVisible: 0,
    fovPref: 1, skylineLift: 0, layers: 0, subjectHeight: 0, foreground: 0 };
  if (inFrame.length < 6 || ownRays.length < 3) return { score: 0, pitchDeg: 0, hfovDeg: hfov, features: empty };
  const own = ownRays.length / inFrame.length, faceMedian = median(ownRays.map(r => r.p.face));
  const skyMax = Math.max(...ownRays.map(r => r.p.skyAngle)), baseMedian = median(ownRays.map(r => r.p.base));
  const faceFraction = faceMedian / vfov;
  const face = smoothstep(.05, .22, faceFraction) * (1 - .6 * smoothstep(.5, .8, faceFraction));
  const fit = clamp(.7 * vfov / Math.max(.001, skyMax - baseMedian), 0, 1);
  const open = clamp(median(ownRays.map(r => r.p.open)), 0, 1), profile = inFrame.map(r => r.p.skyAngle);
  let prominence = 0;
  for (let i = 1; i + 1 < profile.length; i++) {
    if (profile[i] >= profile[i - 1] && profile[i] > profile[i + 1]) {
      let left = profile[i], right = profile[i];
      for (let j = i - 1; j >= 0 && profile[j] <= profile[i]; j--) left = Math.min(left, profile[j]);
      for (let j = i + 1; j < profile.length && profile[j] <= profile[i]; j++) right = Math.min(right, profile[j]);
      const p = profile[i] - Math.max(left, right);
      if (p > .08 * Math.max(.5, faceMedian)) prominence += p;
    }
  }
  const drama = clamp(prominence / Math.max(.5, faceMedian) / 2.5, 0, 1);
  let pitch = Math.min(skyMax - .27 * vfov, baseMedian + .42 * vfov);
  const wet = inFrame.filter(r => r.p.waterSeen);
  if (wet.length >= .15 * inFrame.length) pitch = Math.max(skyMax - .45 * vfov, Math.min(pitch, median(wet.map(r => r.p.waterAngle)) + .35 * vfov));
  pitch = clamp(pitch, -25, 25);
  const water = wet.filter(r => r.p.waterAngle >= pitch - .47 * vfov).length / inFrame.length;
  const skylineAngle = median(ownRays.map(r => r.p.skyAngle));
  const skylineLift = skylineAngle <= 0 ? .15 : bump(skylineAngle, 7, 6);
  const central = inFrame.reduce((a, b) => Math.abs(angleDiff(a.az, heading)) <= Math.abs(angleDiff(b.az, heading)) ? a : b);
  const layers = Math.min(1, central.p.layers / 4);
  const subjectHeight = subject ? bump((eye[1] - subject.point.localM[1]) / Math.max(1, subject.point.reliefM || 1000), -.15, .35) : 0;
  const bottom = pitch - vfov / 2, lowerTop = pitch - vfov / 6;
  const foregroundFraction = inFrame.reduce((sum, r) => sum + Math.max(0, Math.min(lowerTop, r.p.nearHigh) - Math.max(bottom, r.p.nearLow)) / (vfov / 3), 0) / inFrame.length;
  const foreground = bump(foregroundFraction, .35, .25), summitVisible = subject?.visible ? 1 : 0;
  const fovPref = 1 - .12 * smoothstep(38, 28, hfov) - .28 * smoothstep(60, 82, hfov);
  const score = own ** 1.2 * face * fit * open ** .7 * (.65 + .35 * drama) * (1 + .3 * water)
    * (1 + .2 * summitVisible) * fovPref * (.5 + .5 * skylineLift) * (.75 + .25 * layers)
    * (.7 + .3 * subjectHeight) * (.85 + .15 * foreground);
  return { score, pitchDeg: pitch, hfovDeg: hfov,
    features: { own, face, fit, open, drama, water, summitVisible, fovPref, skylineLift, layers, subjectHeight, foreground } };
}

/** Best framing at an exact eye height; also all requested heading aims. */
export function scoreEye(grid, points, eyeM, { headings = HEADINGS, rayStepDeg = 2.5, maxDistanceM = 40000, water = null } = {}) {
  if (!eyeM?.every(Number.isFinite) || !(rayStepDeg > 0) || !(maxDistanceM > 0)) throw new Error('Invalid tour eye or ray spacing');
  const nearby = points.map((point, index) => ({ point, index })).filter(({ point }) =>
    point.localM?.every(Number.isFinite) && Math.hypot(point.localM[0] - eyeM[0], point.localM[2] - eyeM[2]) <= 25000);
  const crest = nearby.filter(p => p.point.grandeur >= .4).map(p => p.point), rays = [], buf = makeBuffer();
  if (Number.isFinite(heightAt(grid, eyeM[0], eyeM[2])) && crest.length) {
    for (let az = 0; az < 360; az += rayStepDeg) {
      const count = marchRay(grid, eyeM, az, maxDistanceM, water, buf), p = rayProfile(buf, count, crest);
      if (p) rays.push({ az, p });
    }
  }
  for (const entry of nearby) {
    const p = entry.point.localM;
    entry.heading = (Math.atan2(p[0] - eyeM[0], -(p[2] - eyeM[2])) / DEG + 360) % 360;
  }
  // Visibility only contributes for the subject selected by an aim. Keep
  // the same total ordering, but avoid marching rays to every incidental
  // point (1,866 real Teton points) for every candidate eye.
  nearby.sort((a, b) => b.point.grandeur - a.point.grandeur || a.index - b.index);
  const aims = headings.map(heading => {
    let best = null;
    for (const hfov of HFOVS) {
      const frame = rays.filter(r => Math.abs(angleDiff(r.az, heading)) <= hfov / 2)
        .sort((a, b) => angleDiff(a.az, heading) - angleDiff(b.az, heading));
      const subject = nearby.find(p => Math.abs(angleDiff(p.heading, heading)) <= hfov * .2);
      if (subject && subject.visible === undefined) subject.visible = subjectVisibility(grid, eyeM, subject.point, buf, water);
      const result = { ...frameScore(frame, hfov, eyeM, subject, heading), headingDeg: (heading + 360) % 360,
        subjectId: subject?.point.id ?? null, subjectIndex: subject?.index ?? 65535 };
      if (!best || result.score > best.score) best = result;
    }
    return best;
  });
  const best = aims.reduce((a, b) => !a || b.score > a.score ? b : a, null);
  return { ...(best || { score: 0, headingDeg: 0, pitchDeg: 0, hfovDeg: 55, subjectId: null, subjectIndex: 65535, features: {} }), aims };
}

export function viewQualityCacheKey({ grid, points, samples, water = null, aglTiersM = TIERS, rayStepDeg = 2.5, maxDistanceM = 40000 }) {
  const hash = createHash('sha256').update(JSON.stringify({ version: VERSION, grid: [grid.width, grid.height, grid.cellSizeM, grid.originM], points, samples, aglTiersM, rayStepDeg, maxDistanceM }));
  for (const data of [grid.heightsM, grid.valid, water]) if (data) hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return hash.digest('hex');
}

/** Unquantized chunk, shared by inline and worker execution. */
export function evaluateFieldSamples({ grid, points, samples, water, aglTiersM = TIERS, rayStepDeg = 2.5, maxDistanceM = 40000 }) {
  return samples.map(sample => {
    if (!sample.posM?.every(Number.isFinite) || !Number.isFinite(sample.floorY) || !Number.isFinite(sample.ceilY) || sample.ceilY < sample.floorY) throw new Error('Invalid tour field sample');
    const heights = [...new Set(aglTiersM.map(agl => Math.min(sample.ceilY, sample.floorY + agl)))];
    return { ...sample, tiers: heights.map(yM => {
      const result = scoreEye(grid, points, [sample.posM[0], yM, sample.posM[1]], { water, rayStepDeg, maxDistanceM });
      return { yM, score: Float32Array.from(result.aims, a => a.score), pitch: Int8Array.from(result.aims.filter((_, i) => i % 2 === 0), a => Math.round(a.pitchDeg)),
        fovIdx: Uint8Array.from(result.aims, a => HFOVS.indexOf(a.hfovDeg)), subjectId: Uint16Array.from(result.aims, a => a.subjectIndex) };
    }) };
  });
}

function sharedCopy(array) {
  if (!array) return null;
  if (array.buffer instanceof SharedArrayBuffer) return array;
  const result = new array.constructor(new SharedArrayBuffer(array.byteLength)); result.set(array); return result;
}

async function effectiveCores() {
  let cores = availableParallelism();
  try {
    const [quota, period] = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/);
    if (quota !== 'max' && Number(period) > 0) cores = Math.min(cores, Math.max(1, Math.ceil(Number(quota) / Number(period))));
  } catch { /* Non-cgroup hosts use the OS affinity count. */ }
  return cores;
}

/** Normalize once across the entire field, then pack the shipped lane types.
 *  Workers share read-only source arrays; chunk order never changes output. */
export async function buildViewQualityField({ grid, points, samples, water = null, aglTiersM = TIERS, workerCount = null,
  cacheDir = '.cache/teton-tour', cache = true, log = console.log, rayStepDeg = 2.5, maxDistanceM = 40000 }) {
  if (points.length >= 65535) throw new Error('Too many tour subjects for Uint16');
  const args = { grid, points, samples, water, aglTiersM, rayStepDeg, maxDistanceM }, key = viewQualityCacheKey(args);
  const cacheFile = path.join(cacheDir, `${key}.view-field`);
  if (cache) {
    try { const cached = deserialize(await fs.readFile(cacheFile)); if (cached.cacheKey === key) return cached; } catch { /* Missing or interrupted cache is rebuilt. */ }
  }
  const started = performance.now(), count = Math.min(samples.length, Math.max(1, Math.floor(workerCount ?? await effectiveCores())));
  let raw;
  if (count <= 1) raw = evaluateFieldSamples(args);
  else {
    const sharedArgs = { ...args, grid: { ...grid, heightsM: sharedCopy(grid.heightsM), valid: sharedCopy(grid.valid), water: undefined }, water: sharedCopy(water) };
    const workers = [];
    const jobs = Array.from({ length: count }, (_, index) => {
      const from = Math.floor(index * samples.length / count), to = Math.floor((index + 1) * samples.length / count);
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./view-quality-worker.mjs', import.meta.url), { workerData: { ...sharedArgs, samples: samples.slice(from, to) } });
        workers.push(worker);
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', code => { if (code) reject(new Error(`View quality worker exited ${code}`)); });
      });
    });
    try { raw = (await Promise.all(jobs)).flat(); } catch (error) {
      await Promise.all(workers.map(worker => worker.terminate()));
      throw error;
    }
  }
  const scores = [];
  for (const sample of raw) for (const tier of sample.tiers) for (const score of tier.score) scores.push(score);
  const normalization = quantile(scores, .99) || 1;
  for (const sample of raw) for (const tier of sample.tiers) {
    tier.score = Uint8Array.from(tier.score, s => Math.round(clamp(s / normalization, 0, 1) * 255));
    const packed = new Uint8Array(18);
    for (let i = 0; i < 72; i++) packed[i >> 2] |= tier.fovIdx[i] << (2 * (i & 3));
    tier.fovIdx = packed;
  }
  const result = { cacheKey: key, headingStepDeg: 5, spacingM: 100, aglTiersM: [...aglTiersM], normalization, samples: raw };
  if (cache) {
    await fs.mkdir(cacheDir, { recursive: true });
    const temporary = `${cacheFile}.${process.pid}.part`;
    await fs.writeFile(temporary, serialize(result)); await fs.rename(temporary, cacheFile);
  }
  log(`view field: ${samples.length} samples, ${raw.reduce((n, s) => n + s.tiers.length, 0)} tiers, ${count} workers, ${(performance.now() - started).toFixed(0)} ms`);
  return result;
}
