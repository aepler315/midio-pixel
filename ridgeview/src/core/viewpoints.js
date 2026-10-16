// Viewpoint calculator: finds camera positions that show a mountain crest
// well, by ray-casting the skyline over real elevation data.
//
// For each candidate eye it casts a fan of rays across the frame and, along
// each ray, tracks every terrain sample's elevation angle (with Earth
// curvature and refraction). From those profiles it measures what a
// photographer cares about:
//   own      share of the frame whose skyline is the crest itself (not a
//            nearer hill or a farther range)
//   face     how much of the mountain face is visible, from its visible
//            base up to the skyline, as a share of the frame height
//   open     how much of that face the foreground leaves unblocked
//   drama    how jagged the skyline is (peak prominences across the frame)
//   water    whether a lake or sea is visible in front of the range
//   summit   whether the range's high point is visible inside the frame
// and multiplies them into one score. A coarse polar search around the
// crest is followed by local hill-climbing on the best candidates, and the
// final picks are kept apart so a range offers genuinely different views.
// Pure computation over a DemGrid: runs in Node (offline) or a browser.
import { DEG, curvatureDrop, clamp, smoothstep, distance, bearing, destination } from './geo.js';

const RAY_STEP_FRAC = 0.004; // step grows with distance: angular error stays ~0.2 deg
const ASPECT = 16 / 9;
export const AGL_CHOICES = [2, 120, 400, 1000];
const AGL_PREF = { 2: 1.0, 120: 1.0, 400: 0.96, 1000: 0.86 };

const quantile = (arr, q) => {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  return s[clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1)];
};
const median = (arr) => quantile(arr, 0.5);
const vfovFor = (hfov) => 2 * Math.atan(Math.tan((hfov * DEG) / 2) / ASPECT) / DEG;

/** Describe the crest inside a range's bbox: high cells, their principal
 *  axis, the summit and the surrounding floor. */
export function analyzeCrest(grid, range) {
  const [w, s, e, n] = range.bbox;
  const [x0, y0] = grid.toPixel(w, n), [x1, y1] = grid.toPixel(e, s);
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(grid.width - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(grid.height - 1, Math.ceil(y1));
  const stride = Math.max(1, Math.round(Math.sqrt(((xb - xa) * (yb - ya)) / 60000)));
  const hs = [];
  let best = { h: -Infinity, x: 0, y: 0 };
  for (let y = ya; y <= yb; y += stride) {
    for (let x = xa; x <= xb; x += stride) {
      const h = grid.data[y * grid.width + x];
      hs.push(h);
      if (h > best.h) best = { h, x, y };
    }
  }
  const hq = quantile(hs, 0.9), h75 = quantile(hs, 0.75), floor = quantile(hs, 0.05);
  // Summit: the given one when its DEM height is near the box maximum, else the maximum.
  let summit;
  if (range.summit?.lonLat) {
    const [sx, sy] = grid.toPixel(...range.summit.lonLat);
    // Snap to the DEM maximum within ~600 m: listed coordinates are rounded.
    const r = Math.max(2, Math.round(600 / grid.mpp(range.summit.lonLat[1])));
    let sb = { h: -Infinity, x: sx, y: sy };
    for (let y = Math.round(sy) - r; y <= Math.round(sy) + r; y++) {
      for (let x = Math.round(sx) - r; x <= Math.round(sx) + r; x++) {
        if (!grid.inside(x, y)) continue;
        const h = grid.data[y * grid.width + x];
        if (h > sb.h) sb = { h, x, y };
      }
    }
    if (sb.h > hq) summit = sb;
  }
  summit ??= best;
  const [slon, slat] = grid.toLonLat(summit.x, summit.y);
  // Crest points (high cells), PCA in metres around their weighted centroid.
  const pts = [];
  for (let y = ya; y <= yb; y += stride) {
    for (let x = xa; x <= xb; x += stride) {
      const h = grid.data[y * grid.width + x];
      if (h >= hq) pts.push([x, y, h]);
    }
  }
  const mpp = grid.mpp((s + n) / 2);
  let sw = 0, cx = 0, cy = 0;
  for (const [x, y, h] of pts) { const wgt = h - hq + 1; sw += wgt; cx += x * wgt; cy += y * wgt; }
  cx /= sw; cy /= sw;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y, h] of pts) {
    const wgt = h - hq + 1, dx = (x - cx) * mpp, dy = (y - cy) * mpp;
    sxx += wgt * dx * dx; syy += wgt * dy * dy; sxy += wgt * dx * dy;
  }
  sxx /= sw; syy /= sw; sxy /= sw;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det)), l2 = tr - l1;
  // Major axis direction in pixel space (x east, y south) -> bearing.
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const axisBearing = ((90 + ang / DEG) % 180 + 180) % 180;
  const [clon, clat] = grid.toLonLat(cx, cy);
  // Sample crest points for framing (cap the count).
  const step = Math.max(1, Math.floor(pts.length / 300));
  const crestPoints = [];
  for (let i = 0; i < pts.length; i += step) {
    const [lon, lat] = grid.toLonLat(pts[i][0], pts[i][1]);
    crestPoints.push({ lon, lat, h: pts[i][2] });
  }
  return {
    centroid: { lon: clon, lat: clat, h: grid.heightAt(clon, clat) },
    summit: { lon: slon, lat: slat, h: summit.h, name: range.summit?.name ?? null },
    axisBearing, elongation: l2 > 0 ? Math.sqrt(l1 / l2) : 10, lengthM: 4 * Math.sqrt(l1),
    hq, h75, floor, relief: summit.h - floor, crestPoints,
  };
}

/**
 * March one ray from the eye along azimuth `az` (deg). Fills `buf` with
 * per-sample angle/distance/height/water/visible and returns the count.
 */
function marchRay(grid, eye, az, maxDist, buf, water) {
  const sa = Math.sin(az * DEG), ca = Math.cos(az * DEG);
  const mpp = eye.mpp;
  let d = Math.max(30, mpp * 0.5), n = 0, horizon = -Infinity;
  while (d < maxDist && n < buf.angle.length) {
    const px = eye.px + (d * sa) / mpp, py = eye.py - (d * ca) / mpp;
    if (!grid.inside(px, py)) break;
    const h = grid.sample(px, py);
    const a = Math.atan2(h - curvatureDrop(d) - eye.h, d) / DEG;
    buf.angle[n] = a; buf.dist[n] = d; buf.h[n] = h; buf.px[n] = px; buf.py[n] = py;
    buf.vis[n] = a >= horizon ? 1 : 0;
    buf.water[n] = water[(py + 0.5 | 0) * grid.width + (px + 0.5 | 0)];
    if (a > horizon) horizon = a;
    n++;
    d += Math.max(mpp * 0.7, d * RAY_STEP_FRAC);
  }
  return n;
}

function makeBuf(n = 4096) {
  return {
    angle: new Float32Array(n), dist: new Float32Array(n), h: new Float32Array(n),
    px: new Float32Array(n), py: new Float32Array(n), vis: new Uint8Array(n), water: new Uint8Array(n),
  };
}

/** Summarize one ray profile. */
function rayProfile(buf, n, crest, crestBox) {
  let iSky = -1, aSky = -Infinity;
  for (let i = 0; i < n; i++) if (buf.angle[i] > aSky) { aSky = buf.angle[i]; iSky = i; }
  if (iSky < 0) return null;
  const dSky = buf.dist[iSky], hSky = buf.h[iSky];
  let base = aSky, minAll = aSky, waterSeen = 0, waterAng = -90;
  for (let i = 0; i < iSky; i++) {
    const d = buf.dist[i];
    if (d >= 0.35 * dSky) {
      if (buf.angle[i] < minAll) minAll = buf.angle[i];
      if (buf.vis[i] && buf.angle[i] < base) base = buf.angle[i];
    }
    if (buf.vis[i] && buf.water[i] && d > 150) { waterSeen = 1; if (buf.angle[i] > waterAng) waterAng = buf.angle[i]; }
  }
  const px = buf.px[iSky], py = buf.py[iSky];
  const onCrest = hSky >= crest.h75 && px >= crestBox[0] && px <= crestBox[2] && py >= crestBox[1] && py <= crestBox[3];
  const face = aSky - base;
  return { aSky, dSky, hSky, base, face, open: face / Math.max(1e-3, aSky - minAll), onCrest, waterSeen, waterAng };
}

/** Evaluate an eye position looking toward the crest. Returns framing and score. */
export function evaluateEye(grid, crest, eyeLonLat, agl, opts = {}) {
  const buf = opts.buf ?? makeBuf();
  const [ex, ey] = grid.toPixel(eyeLonLat[0], eyeLonLat[1]);
  if (!grid.inside(ex, ey)) return null;
  const ground = grid.sample(ex, ey);
  const eye = { px: ex, py: ey, h: ground + agl, mpp: grid.mpp(eyeLonLat[1]) };
  // Too high: looking down onto the crest kills the skyline.
  if (eye.h > crest.hq - 150) return null;
  const water = grid.waterMask();
  const crestBox = opts.crestBox;
  const toC = bearing(eyeLonLat[0], eyeLonLat[1], crest.centroid.lon, crest.centroid.lat);
  const dC = distance(eyeLonLat[0], eyeLonLat[1], crest.centroid.lon, crest.centroid.lat);
  const maxDist = dC + crest.lengthM / 2 + 20000;
  // A wide fan of rays around the crest direction; every frame is cut from it.
  const fan = opts.fanStep ?? 1.5, half = 60;
  const rays = [];
  for (let a = -half; a <= half + 1e-9; a += fan) {
    const az = toC + a;
    const n = marchRay(grid, eye, az, maxDist, buf, water);
    rays.push({ off: a, az, p: n ? rayProfile(buf, n, crest, crestBox) : null });
  }
  if (rays.filter((r) => r.p?.onCrest).length < 4) return { score: 0, reason: 'crest not on skyline' };
  const summit = summitVisibility(grid, eye, eyeLonLat, crest, buf, water);
  const sOff = ((summit.az - toC + 540) % 360) - 180;
  // Try lens widths and aims; keep the best photograph from this spot.
  let best = null;
  for (const hfov of FRAME_HFOVS) {
    for (let c = -half + hfov / 2; c <= half - hfov / 2 + 1e-9; c += 3) {
      const f = frameScore(rays.filter((r) => r.p && Math.abs(r.off - c) <= hfov / 2), hfov, summit.visible && Math.abs(sOff - c) < hfov * 0.4);
      if (f && (!best || f.score > best.score)) best = { ...f, center: c };
    }
  }
  if (!best) return { score: 0, reason: 'no frame' };
  const pref = AGL_PREF[agl] ?? 0.9;
  return {
    score: best.score * pref,
    heading: (toC + best.center + 360) % 360, pitch: best.pitch, hfov: best.hfov, vfov: best.vfov,
    eye: { lon: eyeLonLat[0], lat: eyeLonLat[1], h: eye.h, agl, ground },
    features: { ...best.features, distanceM: dC },
  };
}

const FRAME_HFOVS = [30, 38, 46, 56, 68, 80];
// Normal-to-short-telephoto lenses read mountains best; very wide shrinks them.
const fovPref = (hfov) => 1 - 0.12 * smoothstep(38, 28, hfov) - 0.28 * smoothstep(60, 82, hfov);

/** Score one frame (the rays inside it). */
function frameScore(inFrame, hfov, summitIn) {
  if (inFrame.length < 6) return null;
  const ownF = inFrame.filter((r) => r.p.onCrest);
  if (ownF.length < 3) return null;
  const vfov = vfovFor(hfov);
  const own = ownF.length / inFrame.length;
  const faceMed = median(ownF.map((r) => r.p.face));
  const skyMax = Math.max(...ownF.map((r) => r.p.aSky));
  const baseMed = median(ownF.map((r) => r.p.base));
  const faceFrac = faceMed / vfov;
  const faceScore = smoothstep(0.05, 0.22, faceFrac) * (1 - 0.6 * smoothstep(0.5, 0.8, faceFrac));
  // The face (skyline to visible base) should fit in ~70% of the frame height.
  const fit = clamp((0.7 * vfov) / Math.max(1e-3, skyMax - baseMed), 0, 1);
  const open = clamp(median(ownF.map((r) => r.p.open)), 0, 1);
  // Skyline drama: summed prominence of local maxima of the skyline angle.
  const prof = inFrame.map((r) => r.p.aSky);
  let prom = 0, peaks = 0;
  for (let i = 1; i < prof.length - 1; i++) {
    if (prof[i] >= prof[i - 1] && prof[i] > prof[i + 1]) {
      let l = prof[i], r = prof[i];
      for (let j = i - 1; j >= 0 && prof[j] <= prof[i]; j--) l = Math.min(l, prof[j]);
      for (let j = i + 1; j < prof.length && prof[j] <= prof[i]; j++) r = Math.min(r, prof[j]);
      const p = prof[i] - Math.max(l, r);
      if (p > 0.08 * Math.max(0.5, faceMed)) { prom += p; peaks++; }
    }
  }
  const drama = clamp(prom / Math.max(0.5, faceMed) / 2.5, 0, 1);
  // Pitch: skyline about a quarter down from the top; keep the face base in
  // frame; tilt down to take in a lake in front (its far shore ~15% above
  // the bottom) as long as the skyline stays inside the top edge.
  let pitch = Math.min(skyMax - 0.27 * vfov, baseMed + 0.42 * vfov);
  const wet = inFrame.filter((r) => r.p.waterSeen);
  if (wet.length >= inFrame.length * 0.15) {
    const shore = median(wet.map((r) => r.p.waterAng));
    pitch = Math.max(skyMax - 0.45 * vfov, Math.min(pitch, shore + 0.35 * vfov));
  }
  pitch = clamp(pitch, -25, 25);
  const water = wet.filter((r) => r.p.waterAng >= pitch - 0.47 * vfov).length / inFrame.length;
  const score = own ** 1.5 * faceScore * fit * open ** 0.7 * (0.65 + 0.35 * drama)
    * (1 + 0.35 * water) * (1 + 0.25 * (summitIn ? 1 : 0)) * fovPref(hfov);
  return {
    score, hfov, vfov, pitch,
    features: { own, faceDeg: faceMed, faceFrac, fit, open, drama, peaks, water, summitVisible: summitIn ? 1 : 0 },
  };
}

/** Is the summit itself visible from the eye (not hidden by nearer ground)? */
function summitVisibility(grid, eye, eyeLonLat, crest, buf, water) {
  const az = bearing(eyeLonLat[0], eyeLonLat[1], crest.summit.lon, crest.summit.lat);
  const n = marchRay(grid, eye, az, distance(eyeLonLat[0], eyeLonLat[1], crest.summit.lon, crest.summit.lat) + 200, buf, water);
  let hz = -Infinity, best = -Infinity, bestHz = -Infinity;
  for (let i = 0; i < n; i++) {
    if (buf.h[i] >= crest.summit.h - 40 && buf.angle[i] > best) { best = buf.angle[i]; bestHz = hz; }
    hz = Math.max(hz, buf.angle[i]);
  }
  return { az, visible: best > -Infinity && best >= bestHz - 0.05 };
}

/** Pixel box around the crest (bbox grown by 3 km) used for ownership tests. */
export function crestBoxPixels(grid, range) {
  const [w, s, e, n] = range.bbox;
  const pad = 3000 / grid.mpp((s + n) / 2);
  const [x0, y0] = grid.toPixel(w, n), [x1, y1] = grid.toPixel(e, s);
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/**
 * Search a range for its best viewpoints.
 *   options { count = 3, azStep = 10, minSeparationDeg = 40, log }
 * Returns { crest, views: [...best first], evaluated }.
 */
export function findViewpoints(grid, range, { count = 3, azStep = 10, minSeparationDeg = 40, log = () => {} } = {}) {
  const crest = analyzeCrest(grid, range);
  const crestBox = crestBoxPixels(grid, range);
  const buf = makeBuf();
  const relief = Math.max(400, crest.summit.h - crest.floor);
  const dists = [2.5, 3.6, 5, 7, 10, 14].map((k) => clamp(relief * k, 3000, 42000));
  const cands = [];
  let evaluated = 0;
  for (let az = 0; az < 360; az += azStep) {
    for (const d of [...new Set(dists.map((v) => Math.round(v)))]) {
      const eyeLL = destination(crest.centroid.lon, crest.centroid.lat, az, d);
      for (const agl of AGL_CHOICES) {
        const r = evaluateEye(grid, crest, eyeLL, agl, { buf, crestBox });
        evaluated++;
        if (r?.score > 0) cands.push({ ...r, az, d });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  log(`  coarse: ${evaluated} eyes, ${cands.length} usable, best ${cands[0]?.score.toFixed(3) ?? '-'}`);
  // Hill-climb the best few distinct candidates.
  const seeds = pickDistinct(cands, crest, 8, 25);
  const refined = [];
  for (const seed of seeds) {
    let cur = seed, stepM = seed.d * 0.12;
    for (let iter = 0; iter < 10 && stepM > 150; iter++) {
      let improved = false;
      for (const brg of [0, 60, 120, 180, 240, 300]) {
        const ll = destination(cur.eye.lon, cur.eye.lat, brg, stepM);
        for (const agl of AGL_CHOICES) {
          const r = evaluateEye(grid, crest, ll, agl, { buf, crestBox });
          evaluated++;
          if (r?.score > cur.score) { cur = { ...r, az: bearing(crest.centroid.lon, crest.centroid.lat, ll[0], ll[1]), d: r.features.distanceM }; improved = true; }
        }
      }
      if (!improved) stepM *= 0.5;
    }
    refined.push(cur);
  }
  refined.sort((a, b) => b.score - a.score);
  const views = pickDistinct(refined, crest, count, minSeparationDeg);
  log(`  refined: ${views.map((v) => v.score.toFixed(3)).join(', ')}`);
  return { crest, views, evaluated };
}

/** Keep candidates that look at the crest from clearly different places. */
function pickDistinct(list, crest, count, minSep) {
  const out = [];
  for (const c of list) {
    const az = bearing(crest.centroid.lon, crest.centroid.lat, c.eye.lon, c.eye.lat);
    const clash = out.some((o) => {
      const oaz = bearing(crest.centroid.lon, crest.centroid.lat, o.eye.lon, o.eye.lat);
      const dAz = Math.abs(((az - oaz + 540) % 360) - 180);
      const ratio = Math.max(c.d, o.d) / Math.max(1, Math.min(c.d, o.d));
      return dAz < minSep && ratio < 1.8;
    });
    if (!clash) out.push(c);
    if (out.length >= count) break;
  }
  return out;
}
