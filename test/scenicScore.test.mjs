import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poseMetrics, composition, subjectScore, depthScore, flowAt, scorePath, linkScore, subjectSamples, HOLE_MAX } from '../tools/lib/scenic-score.mjs';
import { samplePath } from '../src/world/terrain/ShotPath.js';

// Closed-form synthetic world, independent of scenic-terrain.mjs: a ground
// plane, axis-aligned boxes (walls, ridges), vertical cones (subjects),
// square tiles with an optional missing set, a grid boundary beyond which
// ground rays become edge rays. Camera convention: f = target - eye,
// r = f x up, u = r x f, row 0 at the top, pixel centres at +0.5.
function basis(pose) {
  const e = pose.eyeM, d = pose.targetM.map((v, k) => v - e[k]), l = Math.hypot(...d), f = d.map((v) => v / l);
  const rl = Math.hypot(f[2], f[0]), r = [-f[2] / rl, 0, f[0] / rl];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { e, f, r, u, t: Math.tan(pose.fovYDeg * Math.PI / 360) };
}

function castRaster(pose, W, H, world = {}, { withHits = true } = {}) {
  const { groundY = 0, boxes = [], cones = [], tileM = 1000, missing = () => false, bounds = 1e6, water = () => false, farM = 60000 } = world;
  const c = basis(pose), a = W / H, n = W * H;
  const out = { width: W, height: H, depth: new Float32Array(n).fill(Infinity), tile: new Int32Array(n).fill(-1),
    present: new Uint8Array(n), water: new Uint8Array(n), edge: new Uint8Array(n) };
  if (withHits) Object.assign(out, { dist: new Float32Array(n), hitX: new Float32Array(n), hitY: new Float32Array(n), hitZ: new Float32Array(n) });
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / H) * 2;
    const d = [0, 1, 2].map((k) => c.f[k] + c.r[k] * nx * c.t * a + c.u[k] * ny * c.t);
    let best = Infinity, ground = false, edge = false;
    if (groundY != null && d[1] < 0) {
      const tau = (groundY - c.e[1]) / d[1], x = c.e[0] + d[0] * tau, z = c.e[2] + d[2] * tau;
      if (tau < farM) { if (Math.abs(x) <= bounds && Math.abs(z) <= bounds) { best = tau; ground = true; } else edge = true; }
    }
    for (const b of boxes) {
      let t0 = 0, t1 = Infinity;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) { if (c.e[k] < b.min[k] || c.e[k] > b.max[k]) t0 = Infinity; continue; }
        const ta = (b.min[k] - c.e[k]) / d[k], tb = (b.max[k] - c.e[k]) / d[k];
        t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
      }
      if (t0 <= t1 && t0 > 0 && t0 < best) { best = t0; ground = false; edge = false; }
    }
    for (const cone of cones) {
      const k2 = (cone.radiusM / cone.heightM) ** 2, o = [c.e[0] - cone.posM[0], c.e[1] - cone.posM[1], c.e[2] - cone.posM[2]];
      const A = d[0] ** 2 + d[2] ** 2 - k2 * d[1] ** 2, B = 2 * (o[0] * d[0] + o[2] * d[2] - k2 * o[1] * d[1]), C = o[0] ** 2 + o[2] ** 2 - k2 * o[1] ** 2;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      for (const tau of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)].sort((p, q) => p - q)) {
        const y = o[1] + d[1] * tau;
        if (tau > 0 && y <= 0 && y >= -cone.heightM && tau < best) { best = tau; ground = false; edge = false; break; }
      }
    }
    const i = py * W + px;
    if (edge && best === Infinity) { out.edge[i] = 1; continue; }
    if (!(best < farM)) continue;
    const h = [0, 1, 2].map((k) => c.e[k] + d[k] * best), ix = Math.floor(h[0] / tileM), iz = Math.floor(h[2] / tileM);
    out.depth[i] = best;
    out.tile[i] = (ix + 500) * 1000 + iz + 500;
    out.present[i] = missing(ix, iz) ? 0 : 1;
    out.water[i] = ground && water(h[0], h[2]) ? 1 : 0;
    if (withHits) { out.hitX[i] = h[0]; out.hitY[i] = h[1]; out.hitZ[i] = h[2]; out.dist[i] = best * Math.hypot(...d); }
  }
  return out;
}

/** Hand-built raster from a per-pixel depth function (Infinity = sky). */
function imageRaster(W, H, depthAt, extra = {}) {
  const n = W * H, r = { width: W, height: H, depth: new Float32Array(n), tile: new Int32Array(n), present: new Uint8Array(n).fill(1),
    water: new Uint8Array(n), edge: new Uint8Array(n) };
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const i = py * W + px, d = depthAt(px, py);
    r.depth[i] = d; r.tile[i] = d < Infinity ? 1 + (px >> 3) : -1;
    if (extra.water?.(px, py)) r.water[i] = 1;
    if (extra.missing?.(px, py)) r.present[i] = 0;
    if (extra.edge?.(px, py)) { r.edge[i] = 1; r.depth[i] = Infinity; }
  }
  return r;
}

const level = { eyeM: [0, 50, 0], targetM: [0, 50, -1000], fovYDeg: 26 };
// Layered landscape: sky rows 0-9, ridges at 9 km, 3 km, and 700 m foreground.
const layered = (px, py) => (py < 10 ? Infinity : py < 16 ? 9000 : py < 22 ? 3000 : 700);

test('frame fractions, skyline and near/foreground of a level camera over a plane match the closed form', () => {
  const W = 160, H = 90, m = poseMetrics(castRaster(level, W, H), level);
  assert.equal(m.terrainFrac, 0.5);
  assert.equal(m.skyFrac, 0.5);
  assert.equal(m.holeFrac, 0);
  assert.equal(m.skyline.meanRow01, 0.5);
  assert.equal(m.skyline.drama, 0);
  assert.ok(Math.abs(m.skyline.lift) < 1e-12);
  const t = Math.tan(13 * Math.PI / 180);
  let nearRows = 0, fgRows = 0;
  for (let py = 0; py < H; py++) {
    const y = ((py + 0.5) / H) * 2 - 1;
    if (y <= 0) continue;
    if (50 / (y * t) < 600) nearRows++;
    if (50 / (y * t) < 2500 && py >= 60) fgRows++;
  }
  assert.ok(Math.abs(m.nearFrac - nearRows / H) < 1e-9, `${m.nearFrac} vs ${nearRows / H}`);
  assert.ok(Math.abs(m.foregroundFrac - fgRows / H) < 1e-9);
  assert.equal(m.layers, 1, 'grazing ground at the horizon is one layer');
  assert.equal(m.horizonTilt, 0);
});

test('layers, emptiness, water and foreground of a banded depth image', () => {
  const W = 40, H = 30, m = poseMetrics(imageRaster(W, H, layered, { water: (px, py) => py >= 22 && px < 10 }), level);
  assert.equal(m.layers, 3);
  assert.ok(Math.abs(m.emptiness - 10 / 30) < 1e-9, 'sky band is the largest uniform region');
  assert.ok(Math.abs(m.waterFrac - (8 * 10) / (W * H)) < 1e-9);
  assert.ok(Math.abs(m.foregroundFrac - 8 / 30) < 1e-9, 'lower-third rows within 2.5 km, as a frame fraction');
  assert.equal(m.nearFrac, 0);
  assert.ok(Math.abs(m.skyline.meanRow01 - 10 / 30) < 1e-9);
  assert.ok(Math.abs(m.skyline.lift - (0.45 - 1 / 3) / 0.45) < 1e-9);
  // A smooth gradient with no discontinuity is a single layer.
  assert.equal(poseMetrics(imageRaster(W, H, (px, py) => (py < 10 ? Infinity : 9000 / (1 + (py - 10) * 0.05))), level).layers, 1);
});

test('skyline drama is the standard deviation of the per-column skyline row', () => {
  const W = 40, H = 30, row = (px) => 5 + Math.floor(px / 4);
  const m = poseMetrics(imageRaster(W, H, (px, py) => (py < row(px) ? Infinity : 4000)), level);
  const rows = Array.from({ length: W }, (_, px) => row(px) / H), mean = rows.reduce((a, b) => a + b) / W;
  const std = Math.sqrt(rows.reduce((a, r) => a + (r - mean) ** 2, 0) / W);
  assert.ok(Math.abs(m.skyline.drama - std) < 1e-9);
  assert.equal(m.skyline.minRow01, 5 / H);
  assert.equal(m.skyline.maxRow01, 14 / H);
});

test('holes zero the composition and are reported, small ones only cost', () => {
  const W = 40, H = 30, good = poseMetrics(imageRaster(W, H, layered), level);
  const holed = poseMetrics(imageRaster(W, H, layered, { missing: (px, py) => px < 3 && py >= 20 && py < 23 }), level);
  const edged = poseMetrics(imageRaster(W, H, layered, { edge: (px, py) => py === 29 && px < 4 }), level);
  assert.ok(composition(good) > 0.5, `good frame composes well: ${composition(good)}`);
  assert.ok(holed.holeFrac > HOLE_MAX && holed.missingTiles.length > 0);
  assert.equal(composition(holed), 0);
  assert.ok(Math.abs(edged.holeFrac - 4 / (W * H)) < 1e-9, 'edge rays are holes');
  assert.equal(composition(edged), 0);
  const tiny = poseMetrics(imageRaster(W, H, layered, { missing: (px, py) => px === 0 && py === 25 }), level);
  assert.ok(tiny.holeFrac > 0 && tiny.holeFrac <= HOLE_MAX && composition(tiny) > 0);
});

test('composition, subject and depth scores are bounded and prefer the documented bands', () => {
  const W = 40, H = 30, img = (f) => poseMetrics(imageRaster(W, H, f), level);
  const good = img(layered), allSky = img(() => Infinity), allLand = img(() => 900), flat = img((px, py) => (py < 15 ? Infinity : 20000));
  for (const m of [good, allSky, allLand, flat]) {
    for (const v of [composition(m), depthScore(m), subjectScore(m)]) assert.ok(v >= 0 && v <= 1, String(v));
  }
  assert.equal(composition(allSky), 0);
  assert.ok(composition(good) > composition(allLand) && composition(good) > composition(flat));
  assert.ok(depthScore(good) > depthScore(flat));
  // A tele lens does not need foreground; wide and normal do.
  assert.ok(composition(flat, { lens: 'tele' }) > composition(flat, { lens: 'wide' }));
  // A wall of near terrain is tolerated on valley moves only.
  const close = img((px, py) => (py < 10 ? Infinity : py < 18 ? 3000 : 400));
  assert.ok(composition(close, { move: 'valley' }) > composition(close, { move: 'orbit' }));
});

const peak = { id: 'peak', kind: 'peak', posM: [0, 900, -6000], radiusM: 700, heightM: 900 };
const coneWorld = (extra = {}) => ({ cones: [peak], ...extra });
const groundAt = (x, z) => Math.max(0, peak.posM[1] - Math.hypot(x - peak.posM[0], z - peak.posM[2]) * peak.heightM / peak.radiusM);

test('subject visibility, size and occlusion against a cone', () => {
  const pose = { eyeM: [0, 450, 0], targetM: [0, 450, -6000], fovYDeg: 16 };
  const open = poseMetrics(castRaster(pose, 128, 72, coneWorld()), pose, { subject: peak, groundAt }).subject;
  assert.equal(open.inFrame, true);
  assert.equal(open.visibleFrac, 1, 'the eye-facing arcs of an exposed cone are all visible');
  const approxH = 900 / (6000 * Math.tan(8 * Math.PI / 180)) / 2;
  assert.ok(open.screenH > approxH * 0.9 && open.screenH < approxH * 1.25, `${open.screenH} vs ${approxH}`);
  assert.ok(Math.abs(open.centerX) < 0.02 && open.centred < 0.6);
  const wall = { min: [-3000, 0, -2600], max: [3000, 1200, -2400] };
  const hidden = poseMetrics(castRaster(pose, 128, 72, coneWorld({ boxes: [wall] })), pose, { subject: peak, groundAt }).subject;
  assert.equal(hidden.inFrame, true);
  assert.equal(hidden.visibleFrac, 0);
  const low = { ...wall, max: [3000, 440, -2400] };
  const partial = poseMetrics(castRaster(pose, 128, 72, coneWorld({ boxes: [low] })), pose, { subject: peak, groundAt }).subject;
  assert.ok(partial.visibleFrac > 0.1 && partial.visibleFrac < 0.9, String(partial.visibleFrac));
  const m = (sub) => poseMetrics(castRaster(pose, 128, 72, coneWorld()), pose, { subject: sub, groundAt });
  assert.ok(subjectScore(m(peak)) > 0.5);
  const others = poseMetrics(castRaster(pose, 128, 72, coneWorld()), pose, { subject: peak, subjects: [peak, { id: 'b', posM: [1500, 800, -9000] }, { id: 'c', posM: [0, 400, 9000] }] });
  assert.equal(others.othersVisible, 1);
});

test('thirds and centred placements both score; an edge placement does not', () => {
  const pose = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 26 }, W = 64, H = 36, t = Math.tan(13 * Math.PI / 180);
  const sky = imageRaster(W, H, () => Infinity);
  const pt = (nx, ny) => [nx * 5000 * t * (W / H), ny * 5000 * t, -5000];
  const placed = (nx, ny) => poseMetrics(sky, pose, { subject: { samplesM: [pt(nx, ny - 0.3), pt(nx, ny + 0.3)] } }).subject;
  const third = placed(1 / 3, 1 / 3), centre = placed(0, 0), edge = placed(0.95, -0.6);
  assert.ok(third.thirds < 1e-9 && Math.abs(third.centerX - 1 / 3) < 1e-9);
  assert.ok(centre.centred < 1e-9 && Math.abs(centre.thirds - 1) < 1e-9);
  assert.ok(Math.abs(third.screenH - 0.3) < 1e-9 && Math.abs(third.screenW) < 1e-9);
  const wide = poseMetrics(sky, pose, { subject: { samplesM: [pt(-0.2, 0), pt(0.2, 0)] } }).subject;
  assert.ok(Math.abs(wide.screenW - 0.2) < 1e-9 && Math.abs(wide.screenH) < 1e-9);
  const score = (sub) => subjectScore({ subject: sub });
  assert.ok(Math.abs(score(third) - score(centre)) < 1e-9 && score(third) > 0.9);
  assert.ok(score(edge) < score(third) * 0.6);
  // On a thirds line at mid height, or centred on the upper thirds line.
  for (const [nx, ny] of [[1 / 3, 0], [0, 1 / 3], [-1 / 3, 0]]) {
    const s = placed(nx, ny);
    assert.ok(s.placement < 1e-9 && Math.abs(score(s) - score(third)) < 1e-9, `${nx},${ny}: ${score(s)}`);
  }
});

const square = (cx, cz, h) => [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]];
const lakeAt = (D, half = 1000) => ({ id: 'lake', kind: 'lake', posM: [0, 0, -D], radiusM: half, heightM: 0, polygonM: square(0, -D, half), axisM: [[0, -D - half], [0, -D + half]] });
const flatGround = () => 0;

test('a lake on a plane is fully visible at grazing angles and sized by its width', () => {
  for (const [h, D] of [[150, 6000], [300, 10000], [600, 10000], [60, 8000]]) {
    const pose = { eyeM: [0, h, 0], targetM: [0, 0, -D], fovYDeg: 26 }, lake = lakeAt(D);
    const m = poseMetrics(castRaster(pose, 128, 72), pose, { subject: lake, groundAt: flatGround });
    assert.equal(m.subject.flat, true);
    assert.equal(m.subject.inFrame, true);
    assert.equal(m.subject.visibleFrac, 1, `eye ${h} m, lake ${D} m: ${m.subject.visibleFrac}`);
    // Widest at the near shore: half-width over (distance * tan(fov/2) * aspect).
    const w = 1000 / ((D - 1000) * Math.tan(13 * Math.PI / 180) * (128 / 72));
    assert.ok(Math.abs(m.subject.screenW - w) / w < 0.03 && m.subject.size === Math.max(m.subject.screenW, m.subject.screenH), `${m.subject.screenW} vs ${w}`);
    assert.ok(subjectScore(m) > 0.6, String(subjectScore(m)));
  }
  // Behind a wall whose top edge sits a few rows above the far shore, it is hidden.
  const pose = { eyeM: [0, 150, 0], targetM: [0, 0, -6000], fovYDeg: 26 }, wall = { min: [-20000, 0, -3100], max: [20000, 140, -3000] };
  const hidden = poseMetrics(castRaster(pose, 128, 72, { boxes: [wall] }), pose, { subject: lakeAt(6000), groundAt: flatGround }).subject;
  assert.equal(hidden.inFrame, true);
  assert.equal(hidden.visibleFrac, 0);
});

test('ground-snapped arcs of a relief subject on a plane read visible from a low eye', () => {
  const butte = { id: 'b', kind: 'butte', posM: [0, 300, -7000], radiusM: 600, heightM: 300 };
  for (const h of [40, 80, 150]) {
    const pose = { eyeM: [0, h, 0], targetM: [0, 100, -7000], fovYDeg: 16 };
    const s = poseMetrics(castRaster(pose, 128, 72), pose, { subject: butte, groundAt: flatGround }).subject;
    assert.equal(s.visibleFrac, 1, `eye ${h} m: ${s.visibleFrac}`);
  }
});

test('a flat subject around the eye is judged on the part in view, never on points behind the camera', () => {
  const pose = { eyeM: [0, 80, 0], targetM: [0, 0, -6000], fovYDeg: 26 }, raster = castRaster(pose, 128, 72);
  const lake = { id: 'big', kind: 'lake', posM: [0, 0, -4000], radiusM: 8000, heightM: 0, polygonM: square(0, -4000, 8000), axisM: [[0, -12000], [0, 4000]] };
  const valley = { id: 'v', kind: 'valley', posM: [0, 0, -3000], radiusM: 6000, heightM: 400, axisM: [[0, 3000], [0, -9000]] };
  const disc = { id: 'd', kind: 'lake', posM: [0, 0, -1000], radiusM: 5000, heightM: 0 };
  for (const subject of [lake, valley, disc]) {
    const s = poseMetrics(raster, pose, { subject, groundAt: flatGround }).subject;
    assert.equal(s.visibleFrac, 1, `${subject.id}: ${s.visibleFrac}`);
    assert.ok(s.inFrame && s.screenW <= 1 && s.screenH <= 1 && s.size > 0.2, JSON.stringify(s));
    assert.ok(subjectScore({ subject: s }) > 0.5, `${subject.id}: ${subjectScore({ subject: s })}`);
  }
  // Looking away from a lake that lies behind the eye: nothing framed.
  const away = { eyeM: [0, 80, 0], targetM: [0, 0, 6000], fovYDeg: 26 };
  const behind = poseMetrics(castRaster(away, 128, 72), away, { subject: lakeAt(6000), groundAt: flatGround }).subject;
  assert.ok(behind.visibleFrac === 0 && !behind.inFrame && subjectScore({ subject: behind }) === 0);
  // A relief subject whose radius encloses the eye keeps its arcs in front of it.
  const big = { id: 'p', kind: 'peak', posM: [0, 900, -2000], radiusM: 3000, heightM: 900 };
  const eye = [0, 450, 0], pts = subjectSamples(big, eye);
  assert.ok(pts.every((p) => (p[0] - eye[0]) * (big.posM[0] - eye[0]) + (p[2] - eye[2]) * (big.posM[2] - eye[2]) > 0));
  const near = poseMetrics(castRaster({ eyeM: eye, targetM: big.posM, fovYDeg: 26 }, 64, 36, { groundY: null }), { eyeM: eye, targetM: big.posM, fovYDeg: 26 }, { subject: big }).subject;
  assert.ok(near.screenH <= 1 && near.screenW <= 1);
});

test('flowAt for a pure translation over a flat plane matches the analytic flow within 10%', () => {
  const W = 128, H = 72, ds = 6;
  const a = { eyeM: [0, 300, 0], targetM: [0, 200, -1000], fovYDeg: 26 };
  const b = { eyeM: [0, 300, -ds], targetM: [0, 200, -1000 - ds], fovYDeg: 26 };
  const raster = castRaster(a, W, H, { farM: 60000 });
  // Small-angle motion of a point at distance R, angle theta from the motion: ds sin(theta) / R.
  const analytic = [];
  for (let i = 0; i < W * H; i++) {
    if (!(raster.depth[i] < Infinity)) continue;
    const p = [raster.hitX[i], raster.hitY[i] - 300, raster.hitZ[i]], R = Math.hypot(...p);
    analytic.push(Math.sqrt(1 - (-p[2] / R) ** 2) / R);
  }
  analytic.sort((x, y) => x - y);
  const expected = analytic[Math.ceil(0.95 * analytic.length) - 1];
  const got = flowAt(raster, a, b, ds);
  assert.ok(Math.abs(got - expected) / expected < 0.1, `${got} vs ${expected}`);
  const noHits = flowAt(castRaster(a, W, H, { farM: 60000 }, { withHits: false }), a, b, ds);
  assert.ok(Math.abs(noHits - got) / got < 0.02, 'hits reconstructed from depth agree');
});

test('flowAt over sky is the pure rotation term', () => {
  const W = 64, H = 36, yaw = 2 * Math.PI / 180, ds = 10;
  const a = { eyeM: [0, 0, 0], targetM: [0, 0, -1000], fovYDeg: 26 };
  const b = { eyeM: [0, 0, 0], targetM: [1000 * Math.sin(yaw), 0, -1000 * Math.cos(yaw)], fovYDeg: 26 };
  const got = flowAt(imageRaster(W, H, () => Infinity), a, b, ds);
  assert.ok(Math.abs(got - yaw / ds) / (yaw / ds) < 0.05, `${got} vs ${yaw / ds}`);
});

const path = (eyes, aims, fov = 16) => samplePath({ eyes, aims, fovs: fov, spacingM: 25 });
const opts = (world, extra = {}) => ({ subject: peak, groundAt, width: 96, height: 54, raster: (pose, o) => castRaster(pose, o.width, o.height, world), ...extra });
const wall = { min: [-3000, 0, -2600], max: [3000, 500, -2400] };

test('a subject hidden early and framed at the payoff scores a higher reveal than one framed from the start', () => {
  const world = coneWorld({ boxes: [wall] });
  const rise = path([[0, 150, 0], [0, 700, 0], [0, 1300, 0]], [[0, 500, -6000], [0, 500, -6000], [0, 500, -6000]]);
  const slide = path([[-600, 1300, 0], [0, 1300, 0], [600, 1300, 0]], [[0, 500, -6000], [0, 500, -6000], [0, 500, -6000]]);
  const end = (p) => p.s[p.s.length - 1];
  const a = scorePath({}, rise, opts(world, { payoffS: end(rise), holdS: [0.8 * end(rise), end(rise)] }));
  const b = scorePath({}, slide, opts(world, { payoffS: end(slide), holdS: [0.8 * end(slide), end(slide)] }));
  assert.equal(a.samples[0].metrics.subject.visibleFrac, 0, 'the wall hides the subject at the start of the rise');
  assert.ok(a.samples.at(-1).metrics.subject.visibleFrac >= 0.6);
  assert.ok(a.aggregate.reveal > 0.5 && b.aggregate.reveal < 0.2, `${a.aggregate.reveal} vs ${b.aggregate.reveal}`);
  assert.ok(a.aggregate.payoff > 0 && a.aggregate.hold > 0);
  for (const r of [a, b]) {
    assert.equal(r.flow.length, (r === a ? rise : slide).s.length);
    assert.ok(r.flow.every((v) => v > 0 && Number.isFinite(v)));
    assert.ok(r.aggregate.total > 0 && r.aggregate.total <= 1, JSON.stringify(r.aggregate));
    assert.ok(Math.abs(r.signature.headingHistogram.reduce((x, y) => x + y) - 1) < 1e-9);
    assert.ok(r.signature.headingHistogram[0] > 0.99, 'looking north');
  }
  assert.ok(Math.abs(b.signature.meanAglM - 1300) < 1e-6);
  assert.ok(b.signature.meanDistanceM > 5900 && b.signature.meanDistanceM < 6100);
});

test('holes in every frame zero the composition and the total', () => {
  const world = coneWorld({ missing: (ix, iz) => iz <= -3 && iz >= -5 && ix >= -1 && ix <= 0 });
  const p = path([[-600, 1300, 0], [600, 1300, 0]], [[0, 500, -6000], [0, 500, -6000]]);
  const r = scorePath({}, p, opts(world, { payoffS: p.s.at(-1) / 2 }));
  assert.ok(r.aggregate.holes > HOLE_MAX && r.aggregate.missingTiles.length > 0);
  assert.ok(r.samples.every((q) => q.composition === 0));
  assert.equal(r.aggregate.total, 0);
  assert.equal(linkScore({}, p, opts(world)).aggregate.total, 0);
});

test('the flow lane is never zero, even for a pure translation through empty sky', () => {
  const p = path([[0, 1000, 0], [0, 1000, -2000]], [[0, 1000, -9000], [0, 1000, -11000]], 26);
  const r = linkScore({}, p, { width: 32, height: 18, raster: (pose, o) => castRaster(pose, o.width, o.height, { groundY: null }) });
  assert.ok(r.flow.every((v) => v > 0));
  assert.equal(r.aggregate.subject, null);
  assert.equal(r.aggregate.reveal, null);
  assert.equal(r.aggregate.payoff, null);
});

test('NaN hit lanes (no-data cells) never leak into flow', () => {
  const a = { eyeM: [0, 300, 0], targetM: [0, 200, -1000], fovYDeg: 26 }, b = { eyeM: [0, 300, -6], targetM: [0, 200, -1006], fovYDeg: 26 };
  const r = castRaster(a, 64, 36);
  for (let i = 0; i < r.depth.length; i += 7) if (r.depth[i] < Infinity) r.hitY[i] = NaN;
  assert.ok(Number.isFinite(flowAt(r, a, b, 6)) && flowAt(r, a, b, 6) > 0);
  const p = path([[0, 300, 0], [0, 300, -2000]], [[0, 200, -3000], [0, 200, -5000]], 26);
  const res = linkScore({}, p, { width: 32, height: 18, raster: (pose, o) => {
    const q = castRaster(pose, o.width, o.height);
    q.hitY.fill(NaN);
    return q;
  } });
  assert.ok(res.flow.every((v) => Number.isFinite(v) && v > 0));
  assert.ok(Object.values(res.aggregate).every((v) => v === null || Array.isArray(v) || Number.isFinite(v)));
});

test('parallax rewards near-far motion from translation, not pans', () => {
  const lo = { width: 48, height: 27, raster: (pose, o) => castRaster(pose, o.width, o.height) };
  const pan = linkScore({}, path([[0, 150, 0], [0, 150, 0]], [[-1500, 50, -3000], [1500, 50, -3000]], 26), lo);
  const truck = linkScore({}, path([[-400, 150, 0], [400, 150, 0]], [[-400, 50, -3000], [400, 50, -3000]], 26), lo);
  assert.ok(pan.aggregate.parallax < 0.05, String(pan.aggregate.parallax));
  assert.ok(truck.aggregate.parallax > 0.3, String(truck.aggregate.parallax));
});

test('a link that loses the view mid-way has a weaker stretch than a steady one', () => {
  const world = coneWorld();
  const steady = path([[-800, 600, 0], [0, 600, 0], [800, 600, 0]], [[0, 450, -6000], [0, 450, -6000], [0, 450, -6000]]);
  const skyward = path([[-800, 600, 0], [0, 600, 0], [800, 600, 0]], [[0, 450, -6000], [0, 4500, -6000], [0, 450, -6000]]);
  const a = linkScore({}, steady, opts(world)), b = linkScore({}, skyward, opts(world));
  assert.ok(b.aggregate.weakest < a.aggregate.weakest, `${b.aggregate.weakest} vs ${a.aggregate.weakest}`);
  assert.ok(b.aggregate.total < a.aggregate.total);
});

test('scoring is deterministic', () => {
  const p = path([[0, 150, 0], [0, 1300, 0]], [[0, 500, -6000], [0, 500, -6000]]);
  const run = () => scorePath({}, p, opts(coneWorld({ boxes: [wall] }), { payoffS: p.s.at(-1) }));
  assert.deepStrictEqual(run(), run());
});

test('an aerial looking down is judged on structure, not on a missing skyline', async () => {
  const { composition } = await import('../tools/lib/scenic-score.mjs');
  const base = { holeFrac: 0, terrainFrac: 1, skyFrac: 0, waterFrac: 0, nearFrac: 0.05, foregroundFrac: 0.12, fovYDeg: 26,
    skyline: { meanRow01: 0, minRow01: 0, maxRow01: 0, drama: 0, lift: 1 }, layers: 2, emptiness: 0.3 };
  const structured = composition(base, { lens: 'normal', move: 'pullback' });
  assert.ok(structured > 0.6, `structured aerial ${structured}`);
  assert.ok(composition({ ...base, emptiness: 0.9, layers: 1 }, { lens: 'normal' }) < 0.35 * structured, 'a featureless aerial stays poor');
  assert.equal(composition({ ...base, holeFrac: 0.01 }), 0, 'holes still veto');
});
