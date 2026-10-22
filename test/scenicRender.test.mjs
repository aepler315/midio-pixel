// Scenic shot tours, render stage: the metric math of the shot review page
// on synthetic frames, and one real headless render of a published view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as THREE from '../src/vendor/range/three-range.module.js';
import catalog from '../src/world/terrain/sceneCatalogData.js';
import { scenePoseAt } from '../src/world/terrain/SceneTravel.js';
import { SHOT_NEAR_M, SHOT_FAR_M, DEPTH_EDGES_M, poseFrame, projectPoint, floorMask, flipRows, alphaMask, decodeDepth,
  silhouetteMetrics, depthMetrics, luminanceMetrics, subjectSamples, subjectMetrics, shotMetrics, openShotReview, contactSheet } from '../tools/lib/scenic-render.mjs';

const close = (a, b, eps, label) => assert.ok(Math.abs(a - b) <= eps, `${label}: ${a} vs ${b}`);

test('projection matches the three.js camera the page draws with', () => {
  const poses = [{ eyeM: [10, 1600, -30], targetM: [-4000, 1700, 5800], fovYDeg: 16 }, { eyeM: [0, 900, 0], targetM: [3000, 200, -2500], fovYDeg: 35 }];
  for (const pose of poses) {
    const frame = poseFrame(pose, 480, 270);
    const camera = new THREE.PerspectiveCamera(pose.fovYDeg, 480 / 270, SHOT_NEAR_M, SHOT_FAR_M);
    camera.position.set(...pose.eyeM); camera.lookAt(...pose.targetM); camera.updateMatrixWorld();
    for (const p of [pose.targetM, [pose.targetM[0] + 900, pose.targetM[1] - 300, pose.targetM[2] + 400], [pose.eyeM[0] + 500, pose.eyeM[1], pose.eyeM[2] + 700]]) {
      const v = new THREE.Vector3(...p).applyMatrix4(camera.matrixWorldInverse), ndc = new THREE.Vector3(...p).project(camera), q = projectPoint(frame, p);
      close(q.z, -v.z, 1e-6 * Math.abs(v.z), 'view depth');
      if (q.z > 0) { close(q.x, (ndc.x + 1) * 240, 1e-6, 'x'); close(q.y, (1 - ndc.y) * 135, 1e-6, 'y'); }
    }
    const t = projectPoint(frame, pose.targetM);
    close(t.x, 240, 1e-9, 'target x'); close(t.y, 135, 1e-9, 'target y');
  }
});

test('depth readback decodes the exact view depth; rows flip to top-first', () => {
  const w = 3, h = 2, zs = [25, 140, 1234.5, 9000, 70000, Infinity];
  const packed = new Float32Array(w * h);
  // Window depth of view z under the standard perspective projection, written bottom row first.
  zs.forEach((z, k) => { const x = k % w, y = Math.floor(k / w); packed[(h - 1 - y) * w + x] = z === Infinity ? 1 : (SHOT_FAR_M / (SHOT_FAR_M - SHOT_NEAR_M)) * (1 - SHOT_NEAR_M / z); });
  const out = decodeDepth(new Uint8Array(packed.buffer), w, h);
  zs.forEach((z, k) => (z === Infinity ? assert.equal(out[k], Infinity) : close(out[k], z, z * 1e-4, `z ${z}`)));
  const rgba = Uint8Array.from({ length: w * h * 4 }, (_, i) => i);
  const top = flipRows(rgba, w, h);
  assert.deepEqual([...top.subarray(0, 12)], [...rgba.subarray(12, 24)]);
  assert.deepEqual([...alphaMask(Uint8Array.from([0, 0, 0, 255, 9, 9, 9, 0, 1, 1, 1, 128]))], [1, 0, 1]);
});

test('silhouette metrics: coverage, skyline and interior holes', () => {
  // 6 columns x 5 rows. Column skyline rows: 1, 1, 2, none, 4, 2; column 2
  // has a gap at rows 3-4 below its top, column 5 at row 4.
  const w = 6, h = 5, mask = new Uint8Array(w * h);
  const tops = [1, 1, 2, 5, 4, 2];
  tops.forEach((top, x) => { for (let y = top; y < h; y++) mask[y * w + x] = 1; });
  mask[3 * w + 2] = 0; mask[4 * w + 2] = 0; mask[4 * w + 5] = 0;
  const m = silhouetteMetrics(mask, w, h);
  assert.equal(m.terrainFrac, (4 + 4 + 1 + 0 + 1 + 2) / 30);
  assert.equal(m.holes, 3 / 30);
  assert.deepEqual(m.skyline, [0.2, 0.2, 0.4, 1, 0.8, 0.4]);
  close(m.skylineTop, 0.2, 1e-6, 'top'); assert.equal(m.skylineBottom, 1);
  close(m.skylineTravel, 0 + 0.2 + 0.6 + 0.2 + 0.4, 1e-6, 'travel');
  close(m.flatWallRun, 2 / 6, 1e-9, 'wall');
  // Sky where the ground must have been met (floor mask) is a hole too.
  const floor = new Uint8Array(w * h); floor[4 * w + 3] = 1; floor[0] = 1;
  const withFloor = silhouetteMetrics(mask, w, h, { floor });
  assert.equal(withFloor.holes, 5 / 30);
  assert.equal(withFloor.interiorHoles, 3 / 30);
});

test('floor mask: rays that meet the grid floor inside the grid', () => {
  const frame = poseFrame({ eyeM: [0, 100, 0], targetM: [0, 100, -1000], fovYDeg: 30 }, 40, 20);
  const m = floorMask(frame, { floorY: 0, extent: [-50000, -50000, 50000, 50000] });
  for (let j = 0; j < 20; j++) assert.equal(m[j * 40 + 20], j >= 10 ? 1 : 0, `row ${j}`);
  // Just below the horizon the ray meets the floor beyond a 2 km grid edge.
  const small = floorMask(frame, { floorY: 0, extent: [-2000, -2000, 2000, 2000] });
  assert.equal(small[10 * 40 + 20], 0);
  assert.equal(small[19 * 40 + 20], 1);
});

test('depth histogram, quantiles and sky over ray distance', () => {
  const frame = poseFrame({ eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 1e-3 }, 4, 1);
  const m = depthMetrics(frame, Float32Array.from([30, 600, 600, Infinity])).depth;
  assert.deepEqual(m.edgesM, [...DEPTH_EDGES_M]);
  assert.equal(m.frac[0], 0.25); assert.equal(m.frac[4], 0.5); assert.equal(m.sky, 0.25);
  close(m.nearestM, 30, 1e-6, 'nearest'); close(m.p50M, 600, 1e-6, 'median');
  // Off-axis pixels convert view depth to distance along their ray.
  const wide = poseFrame({ eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 90 }, 2, 1);
  close(depthMetrics(wide, Float32Array.from([100, 100])).depth.nearestM, 100 * Math.SQRT2, 1e-6, 'ray');
});

test('luminance statistics over terrain pixels', () => {
  const w = 4, h = 4, flat = new Uint8Array(w * h * 4).fill(128), mask = new Uint8Array(w * h).fill(1);
  const a = luminanceMetrics(flat, mask, w, h);
  close(a.mean, 128 / 255, 1e-4, 'mean'); assert.equal(a.std, 0); assert.equal(a.localContrast, 0); assert.equal(a.edgeDensity, 0);
  const checker = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) checker.fill(((i % w) + Math.floor(i / w)) % 2 ? 255 : 0, i * 4, i * 4 + 4);
  const b = luminanceMetrics(checker, mask, w, h);
  close(b.mean, 0.5, 1e-4, 'mean'); close(b.std, 0.5, 1e-4, 'std'); close(b.localContrast, 1, 1e-4, 'contrast'); close(b.edgeDensity, 12 / 16, 1e-4, 'edges');
  // Sky pixels never count.
  const half = mask.map((_, i) => (i < 8 ? 0 : 1));
  assert.equal(luminanceMetrics(checker, half, w, h).mean, 0.5);
});

// A flat floor at y = 0 seen from 300 m, depth "rendered" by ray casting.
const planeFrame = (w = 160, h = 90) => {
  const frame = poseFrame({ eyeM: [0, 300, 0], targetM: [0, 0, -3000], fovYDeg: 30 }, w, h), depth = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sy = (1 - ((j + 0.5) / h) * 2) * frame.tanY, sx = (((i + 0.5) / w) * 2 - 1) * frame.tanX;
      const dy = frame.f[1] + sx * frame.r[1] + sy * frame.u[1];
      depth[j * w + i] = dy < 0 ? -300 / dy : Infinity;
    }
  }
  return { frame, depth };
};

test('subject visibility: visible, occluded and missing samples on a rendered plane', () => {
  const { frame, depth } = planeFrame();
  const subject = { posM: [0, 0, -3000], radiusM: 200, heightM: 0 };
  const samples = subjectSamples(subject, () => 0);
  assert.equal(samples.points.length, 1 + 5 + 11 + 16);
  const seen = subjectMetrics(frame, depth, { ...subject, ...samples });
  assert.equal(seen.inFrame, 1); assert.equal(seen.visible, 1); assert.equal(seen.occluded, 0);
  assert.deepEqual(seen.centre, [0.5, 0.5]);
  // A wall 1 km out hides the subject; removing the ground loses it.
  const wall = depth.map((z) => Math.min(z, 1000)), hole = depth.map(() => Infinity);
  assert.equal(subjectMetrics(frame, wall, { ...subject, ...samples }).occluded, 1);
  assert.equal(subjectMetrics(frame, hole, { ...subject, ...samples }).missing, 1);
  // Out of frame behind the camera: no visibility at all, not "hidden".
  const behind = subjectMetrics(frame, depth, { posM: [0, 0, 3000], radiusM: 200, heightM: 0, ...subjectSamples({ posM: [0, 0, 3000], radiusM: 200 }, () => 0) });
  assert.equal(behind.inFrame, 0); assert.equal(behind.centre, null);
  for (const k of ['visible', 'occluded', 'missing']) assert.equal(behind[k], null, k);
  // Samples off the package are counted apart; with none on it nothing is known.
  assert.equal(subjectSamples(subject, (x) => (x > 1 ? NaN : 0)).unmapped, 15);
  const off = subjectMetrics(frame, depth, { ...subject, ...subjectSamples(subject, () => NaN) });
  assert.deepEqual([off.samples, off.unmapped, off.inFrame, off.visible], [33, 1, 0, null]);
  const none = subjectMetrics(frame, depth, { ...subject, points: [], unmapped: 0 });
  assert.deepEqual([none.samples, none.inFrame, none.visible], [0, null, null]);
  const all = shotMetrics({ frame, mask: depth.map((z) => (z < Infinity ? 1 : 0)), depth, subject: { ...subject, ...samples } });
  assert.ok(all.depth && all.subject && !all.luminance && all.holes === 0);
});

test('subject samples: anchored on the ground, raised kinds trimmed below, flat kinds whole', () => {
  // A rail target is an aim point 115 m above flat ground with a small relief.
  const air = subjectSamples({ kind: 'rail-target', posM: [0, 615, 0], radiusM: 300, heightM: 13.4 }, () => 500);
  assert.equal(air.points.length, 33);
  assert.deepEqual(air.anchorM, [0, 500, 0]);
  // Ground far below a peak's top is surroundings, not subject.
  const cone = (x, z) => 500 - Math.hypot(x, z);
  assert.equal(subjectSamples({ kind: 'peak', posM: [0, 500, 0], radiusM: 300, heightM: 150 }, cone).points.length, 1 + 5);
  assert.equal(subjectSamples({ posM: [0, 500, 0], radiusM: 300, heightM: 150 }, cone).points.length, 1 + 5);
  // A lake's or valley's heightM is the walls' relief above its floor: keep everything.
  for (const kind of ['lake', 'valley', 'shore']) assert.equal(subjectSamples({ kind, posM: [0, 500, 0], radiusM: 300, heightM: 150 }, cone).points.length, 33, kind);
  // Off the package the anchor stays at posM.
  assert.deepEqual(subjectSamples({ posM: [1, 615, 2], radiusM: 300, heightM: 10 }, () => NaN).anchorM, [1, 615, 2]);
});

test('subject screen height is the projected spread of the anchor and its samples', () => {
  const { frame, depth } = planeFrame(), h = frame.height;
  // A lake on the floor: never measured below the water, whatever its relief.
  const lake = { kind: 'lake', posM: [0, 0, -3000], radiusM: 200, heightM: 400 }, s = subjectSamples(lake, () => 0);
  const ys = [s.anchorM, ...s.points].map((p) => projectPoint(frame, p).y);
  const m = subjectMetrics(frame, depth, { ...lake, ...s });
  close(m.screenHeight, (Math.max(...ys) - Math.min(...ys)) / h, 1e-4, 'lake spread');
  assert.ok(m.screenHeight < (projectPoint(frame, [0, -400, -3000]).y - projectPoint(frame, [0, 0, -3000]).y) / h);
  // A cone 400 m tall: its summit anchor over flank samples, out-of-frame ones included.
  const cone = (x, z) => Math.max(0, 400 - 2 * Math.hypot(x, z + 3000));
  const peak = { kind: 'peak', posM: [0, 400, -3000], radiusM: 200, heightM: 400 }, ps = subjectSamples(peak, cone);
  const py = [ps.anchorM, ...ps.points].map((p) => projectPoint(frame, p).y);
  close(subjectMetrics(frame, depth, { ...peak, ...ps }).screenHeight, (Math.max(...py) - Math.min(...py)) / h, 1e-4, 'peak spread');
});

test('subject visibility: ground just behind a ridge is occluded, grazing ground is visible', () => {
  // Columns up to 80 show a ridge face 2 km out; beyond it ground at 20 km (or sky).
  const w = 160, h = 90, frame = poseFrame({ eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 20 }, w, h);
  const pointAt = (i, j, z) => {
    const sx = (((i + 0.5) / w) * 2 - 1) * frame.tanX, sy = (1 - ((j + 0.5) / h) * 2) * frame.tanY;
    return [0, 1, 2].map((k) => z * (frame.f[k] + sx * frame.r[k] + sy * frame.u[k]));
  };
  for (const far of [20000, Infinity]) {
    const depth = Float32Array.from({ length: w * h }, (_, k) => (k % w <= 80 ? 2000 : far));
    // A sample 15 km out projecting one pixel inside the ridge's edge.
    const hidden = subjectMetrics(frame, depth, { posM: pointAt(80, 45, 15000), points: [pointAt(80, 45, 15000)], unmapped: 0 });
    assert.deepEqual([hidden.visible, hidden.occluded, hidden.missing], [0, 1, 0], `far ${far}`);
    // The ridge's own crest pixel next to the edge is visible; a sample beyond the edge with no ground drawn at its depth is missing.
    const crest = subjectMetrics(frame, depth, { posM: pointAt(81, 45, 2030), points: [pointAt(81, 45, 2030)], unmapped: 0 });
    assert.equal(crest.visible, 1);
    const lost = subjectMetrics(frame, depth, { posM: pointAt(83, 45, 9000), points: [pointAt(83, 45, 9000)], unmapped: 0 });
    assert.equal(lost.missing, 1);
  }
  // Grazing ground: each pixel row spans ~900 m of depth, more than the
  // tolerance, so the sample's own pixel is matched with its local step.
  const graze = Float32Array.from({ length: w * h }, (_, k) => 6000 + 900 * (Math.floor(k / w) - 45));
  const mid = subjectMetrics(frame, graze, { posM: pointAt(40, 45, 6000), points: [pointAt(40, 45.45, 6400)], unmapped: 0 });
  assert.equal(mid.visible, 1);
});

const pngOf = (w, h, rgba) => {
  // RGBA PNG with Sub/Up/Average/Paeth/None rows, to exercise the decoder.
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = y % 5, at = y * (w * 4 + 1);
    raw[at] = [1, 2, 3, 4, 0][f];
    for (let i = 0; i < w * 4; i++) {
      const v = rgba[y * w * 4 + i], a = i >= 4 ? rgba[y * w * 4 + i - 4] : 0, b = y ? rgba[(y - 1) * w * 4 + i] : 0, c = y && i >= 4 ? rgba[(y - 1) * w * 4 + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      raw[at + 1 + i] = (v - [a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c, 0][f] + 256) & 255;
    }
  }
  const chunk = (k, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(k, 4, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0); return Buffer.concat([head, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const readSheet = (png) => {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let at = 8; const idat = [];
  while (at < png.length) { const len = png.readUInt32BE(at); if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len)); at += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { w, h, px: (x, y) => [...raw.subarray(y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3)] };
};

test('contact sheet tiles decoded frames under their labels', async () => {
  const frame = (r, g, b) => { const a = new Uint8Array(40 * 20 * 4); for (let i = 0; i < 800; i++) a.set([r, (g + i) & 255, b, 255], i * 4); return a; };
  const a = frame(200, 10, 30), b = frame(20, 99, 240);
  const sheet = readSheet(await contactSheet([pngOf(40, 20, a), pngOf(40, 20, b).toString('base64'), pngOf(40, 20, a)], { columns: 2, labels: ['A1', 'b'] }));
  assert.deepEqual([sheet.w, sheet.h], [80, 2 * (20 + 14)]);
  assert.deepEqual(sheet.px(3, 14 + 5), [...a.subarray((5 * 40 + 3) * 4, (5 * 40 + 3) * 4 + 3)]);
  assert.deepEqual(sheet.px(40 + 7, 14 + 19), [...b.subarray((19 * 40 + 7) * 4, (19 * 40 + 7) * 4 + 3)]);
  assert.deepEqual(sheet.px(0, 34 + 14), [200, 10, 30]);
  // 'A' starts with its top-centre pixel; the empty third cell is background.
  assert.deepEqual(sheet.px(6, 2), [230, 230, 230]);
  assert.deepEqual(sheet.px(4, 2), [24, 26, 30]);
  assert.deepEqual(sheet.px(60, 50), [24, 26, 30]);
  const half = readSheet(await contactSheet([pngOf(40, 20, a)], { tileWidth: 20 }));
  assert.deepEqual([half.w, half.h], [20, 10 + 14]);
});

test('real render: Monument Valley rail pose is whole, the reverse view finds dropped tiles', async (t) => {
  const { chromium } = await import('playwright');
  try {
    const probe = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
    await probe.close();
  } catch (error) {
    t.skip(`Playwright chromium cannot launch: ${error.message.split('\n')[0]}`);
    return;
  }
  const entry = catalog.views.find((v) => v.id === 'monument-valley-163');
  const rail = scenePoseAt({ camera: entry.camera }, { progress01: 0.5 });
  const d = rail.targetM.map((v, k) => v - rail.eyeM[k]);
  const back = { ...rail, targetM: [rail.eyeM[0] - d[0], rail.eyeM[1] + d[1], rail.eyeM[2] - d[2]] };
  const session = await openShotReview('monument-valley-163', { width: 480, height: 270 });
  try {
    t.diagnostic(`renderer: ${session.renderer}; ${session.stats.triangles} triangles; trees ${JSON.stringify(session.trees)}`);
    // The rail target as scenic-features discovers it: an aim point 115 m
    // above the ground with 13 m of relief beneath.
    const c = entry.camera, subject = { kind: 'rail-target', posM: [0, 1, 2].map((k) => (c.targetStartM[k] + c.targetEndM[k]) / 2), radiusM: 340, heightM: 13.4 };
    const [warm, , reverse] = await session.renderPoses([rail, rail, back], { mode: 'material', subject });
    for (const r of [warm, reverse]) assert.match(r.png, /^iVBOR/);
    const m = warm.metrics, b = reverse.metrics;
    assert.ok(m.terrainFrac > 0.2 && m.terrainFrac < 0.95, `rail terrain ${m.terrainFrac}`);
    assert.ok(m.holes < 0.005, `rail holes ${m.holes}`);
    assert.ok(b.holes > 0.02, `reverse holes ${b.holes}`);
    t.diagnostic(`holes (interior only): rail ${m.holes} (${m.interiorHoles}), reverse ${b.holes.toFixed(4)} (${b.interiorHoles.toFixed(4)})`);
    assert.equal(m.skyline.length, 480);
    assert.ok(m.luminance.std > 0 && m.depth.p50M > 100);
    // Its ground is sampled; a ridge 4.8 km out hides most of it from the rail.
    t.diagnostic(`rail target: ${JSON.stringify(m.subject)}`);
    assert.ok(m.subject.samples >= 30 && m.subject.inFrame > 0.9 && m.subject.visible > 0.1 && m.subject.occluded > 0.3, 'rail target');
    close(m.subject.visible + m.subject.occluded + m.subject.missing, 1, 1e-3, 'subject classes');
    assert.equal(b.subject.inFrame, 0); assert.equal(b.subject.visible, null);
    // The Mittens and Merrick Butte, aimed at from the rail: its near face shows.
    const butte = { kind: 'butte', posM: [-2560, 1891.1, 5700], radiusM: 150, heightM: 348.8 };
    const [aimed] = await session.renderPoses([{ ...rail, targetM: butte.posM, subject: butte }], { mode: 'depth' });
    t.diagnostic(`butte: ${JSON.stringify(aimed.metrics.subject)}`);
    assert.ok(aimed.metrics.subject.visible > 0.5 && aimed.metrics.subject.screenHeight > 0.05, 'butte');
    // Coverage, skyline and holes come from the terrain-only pass in every mode.
    const [sil, dep] = [(await session.renderPoses([rail], { mode: 'silhouette' }))[0], (await session.renderPoses([rail], { mode: 'depth' }))[0]];
    assert.equal(sil.png, null);
    assert.ok(!sil.metrics.depth && dep.metrics.depth);
    for (const r of [warm, dep]) for (const k of ['terrainFrac', 'holes', 'interiorHoles', 'skyline', 'flatWallRun']) assert.deepEqual(r.metrics[k], sil.metrics[k], k);
    // Timing after warm-up: in-page (draw, readback, metrics) and round trip.
    const poses = [0.1, 0.3, 0.5, 0.7, 0.9].map((u) => scenePoseAt({ camera: entry.camera }, { progress01: u }));
    for (const mode of ['material', 'silhouette', 'depth']) {
      const t0 = performance.now(), rs = await session.renderPoses(poses, { mode });
      t.diagnostic(`${mode} 480x270: ${(rs.reduce((s, r) => s + r.ms, 0) / rs.length).toFixed(1)} ms in page, ${((performance.now() - t0) / rs.length).toFixed(1)} ms per pose round trip`);
    }
    const counts = await session.setPaths([[rail.eyeM, back.targetM]]);
    assert.ok(Number.isInteger(counts.billboard));
    assert.deepEqual(session.pageErrors, []);
  } finally {
    await session.close();
  }
});
