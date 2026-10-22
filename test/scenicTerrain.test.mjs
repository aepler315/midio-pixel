import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lonLatToLocal, localToLonLat, heightAt, slopeDegAt, normalAt, treeHeightAt, buildClearance, depthRaster,
  loadViewContext, maxPyramid, deformationMarginM, CURVATURE_RADIUS_M,
} from '../tools/lib/scenic-terrain.mjs';
import { terrainHeightAt } from '../src/world/alpine/TerrainMesh.js';
import { cameraPoseAt } from '../src/world/terrain/SceneTravel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.terrain-cache', 'views');
// Views whose normalized grids are cached and stable (others are being rebuilt).
const STABLE_VIEWS = ['monument-valley-163', 'teton-jackson-lake', 'black-mountains-catawba', 'san-gabriel-baldy', 'white-mountains-owens',
  'la-sal-castle-valley', 'panamint-dantes-view', 'chugach-matanuska', 'nc-ross-lake-north'];
const NAD83 = (lat0, lon0) => `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs`;

/** Synthetic DemGrid: n x n samples, `cell` m, centred on the origin. */
function grid(n, cell, fn) {
  const heightsM = new Float32Array(n * n), valid = new Uint8Array(n * n).fill(1), o = -((n - 1) * cell) / 2;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heightsM[r * n + c] = fn(o + c * cell, o + r * cell, c, r);
  return { width: n, height: n, cellSizeM: cell, originM: [o, o], heightsM, valid, horizontalCrs: NAD83(37, -110), sourceToLocal: [1, 0, 0, 0, -1, 0] };
}
const look = (eyeM, targetM, fovYDeg = 30) => ({ eyeM, targetM, fovYDeg });

test('tmerc: GRS80 meridian arc, false origin at lat_0, and exact round trips through a general affine', () => {
  // Meridian arc equator -> 45 deg on GRS80 is 4 984 944.378 m.
  assert.ok(Math.abs(lonLatToLocal({ horizontalCrs: NAD83(0, 10) }, [10, 45])[1] + 4984944.378) < 0.01);
  assert.ok(Math.abs(lonLatToLocal({ horizontalCrs: NAD83(45, 10) }, [10, 0])[1] - 4984944.378) < 0.01);
  assert.deepEqual(lonLatToLocal({ horizontalCrs: NAD83(37.04, -110.04) }, [-110.04, 37.04]).map((v) => Math.round(v * 1e6) / 1e6), [0, 0]);
  const g = { horizontalCrs: NAD83(61.68, -147.72).replace('NAD83', 'WGS84'), sourceToLocal: [0.8, 0.6, 120, 0.6, -0.8, -75] };
  for (const [dx, dz] of [[0, 0], [24000, -24000], [-24000, 24000], [13000, 7000], [-5, 21000]]) {
    const ll = localToLonLat(g, [dx, dz]), back = lonLatToLocal(g, ll);
    assert.ok(Math.hypot(back[0] - dx, back[1] - dz) < 1e-4, `round trip ${dx},${dz}`);
  }
});

test('tmerc agrees with the normalizer\'s cached points (< 1 m both ways)', (t) => {
  const isStable = (f) => STABLE_VIEWS.some((v) => f.startsWith(`${v}-`) && /^-[0-9a-f]{16}\.json$/.test(f.slice(v.length)));
  const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter(isStable) : [];
  const metas = [];
  for (const f of files) {
    // A grid being rewritten may be half on disk: skip it rather than fail.
    try { metas.push(JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'))); } catch { t.diagnostic(`unreadable ${f}`); }
  }
  const usable = metas.filter((m) => m.schema === 'midio.demgrid' && Object.keys(m.points || {}).length);
  if (!usable.length) { t.skip('no cached DEM grids'); return; }
  let n = 0;
  for (const m of usable) for (const [name, p] of Object.entries(m.points)) {
    const local = lonLatToLocal(m, p.lonLat);
    assert.ok(Math.hypot(local[0] - p.localM[0], local[1] - p.localM[1]) < 1, `${name}: ${local} vs ${p.localM}`);
    const ll = localToLonLat(m, p.localM), k = Math.cos((p.lonLat[1] * Math.PI) / 180);
    assert.ok(Math.hypot((ll[0] - p.lonLat[0]) * 111320 * k, (ll[1] - p.lonLat[1]) * 111000) < 1, `${name} inverse`);
    n++;
  }
  t.diagnostic(`${n} points on ${usable.length} grids`);
});

test('height, slope and normal on a plane; NaN outside the grid and over no-data', () => {
  const g = grid(51, 20, (x) => 100 + 0.5 * x);
  assert.ok(Math.abs(heightAt(g, 13, 7) - 106.5) < 1e-6);
  assert.ok(Math.abs(slopeDegAt(g, 0, 0) - (Math.atan(0.5) * 180) / Math.PI) < 1e-6);
  const n = normalAt(g, 0, 0);
  assert.ok(Math.abs(n[0] + 0.5 / Math.hypot(0.5, 1)) < 1e-9 && Math.abs(n[1] - 1 / Math.hypot(0.5, 1)) < 1e-9 && Math.abs(n[2]) < 1e-9);
  assert.ok(Number.isNaN(heightAt(g, 600, 0)));
  g.valid[25 * 51 + 25] = 0;
  assert.ok(Number.isNaN(heightAt(g, 5, 5)));
});

/** Brute-force reference: first point along the ray below the bilinear
 *  surface (lowered by curvature), at 0.1 m steps until it leaves the grid. */
function bruteHit(g, eye, dir, { maxM = 20000, curvature = true } = {}) {
  const hl = Math.hypot(dir[0], dir[2]), lo = g.originM[0], hi = lo + (g.width - 1) * g.cellSizeM;
  for (let d = 1; d <= maxM; d += 0.1) {
    const x = eye[0] + dir[0] * d, z = eye[2] + dir[2] * d, th = d * hl;
    if (x < lo || z < lo || x > hi || z > hi) break;
    const y = eye[1] + dir[1] * d + (curvature ? (th * th) / (2 * CURVATURE_RADIUS_M) : 0);
    const h = heightAt(g, x, z);
    if (Number.isFinite(h) && y <= h) return d;
  }
  return Infinity;
}

test('depth raster: a wall at the right depth with sky above it; a cone matches a brute-force march', () => {
  // Floor at 0, a 500 m wall north of z = -2000.
  const wall = grid(401, 20, (x, z) => (z <= -2000 ? 500 : 0));
  const r = depthRaster({ grid: wall }, look([0, 100, 0], [0, 100, -1000]), { width: 32, height: 18 });
  const centre = 9 * 32 + 16;
  assert.ok(Math.abs(r.depth[centre] - 2000) < 25, `wall depth ${r.depth[centre]}`);
  assert.ok(r.depth.subarray(0, 32).every((v) => v === Infinity) && r.tile.subarray(0, 32).every((v) => v === -1), 'top row is sky');
  assert.ok(r.depth.subarray(17 * 32).every(Number.isFinite), 'bottom row hits');
  assert.ok(r.hitY[centre] > 0 && r.hitY[centre] < 500, 'on the wall face');
  // A 600 m cone: every pixel within 0.5 m of the reference march.
  const cone = grid(301, 20, (x, z) => Math.max(0, 600 - 0.6 * Math.hypot(x, z + 1000)));
  for (const curvature of [false, true]) {
    const pose = look([300, 400, 2000], [0, 250, -1000], 25);
    const d = depthRaster({ grid: cone }, pose, { width: 24, height: 14, curvature });
    const f = [0 - 300, 250 - 400, -1000 - 2000], fl = Math.hypot(...f);
    const forward = f.map((v) => v / fl), right = [-forward[2], 0, forward[0]].map((v) => v / Math.hypot(forward[0], forward[2]));
    const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
    const ty = Math.tan((25 * Math.PI) / 360), tx = ty * (24 / 14);
    for (let py = 0; py < 14; py++) for (let px = 0; px < 24; px++) {
      const vx = (((px + 0.5) / 24) * 2 - 1) * tx, vy = (1 - ((py + 0.5) / 14) * 2) * ty;
      const dir = [0, 1, 2].map((k) => forward[k] + right[k] * vx + up[k] * vy), l = Math.hypot(...dir);
      const ref = bruteHit(cone, pose.eyeM, dir.map((v) => v / l), { curvature });
      const got = d.dist[py * 24 + px];
      if (ref === Infinity) assert.equal(got, Infinity, `pixel ${px},${py} sky`);
      else assert.ok(Math.abs(got - ref) < 0.3,`pixel ${px},${py}: ${got} vs ${ref}`);
    }
  }
});

test('depth raster hits a single-sample spike at range and keeps sky just above it', () => {
  const n = 801, cell = 20;
  const spike = grid(n, cell, (x, z, c, r) => (c === 400 && r === 150 ? 400 : 0));
  const sx = 0, sz = spike.originM[1] + 150 * cell; // 5 km north of the eye
  const eye = [0, 50, 0];
  const below = depthRaster({ grid: spike }, look(eye, [sx, 395, sz], 20), { width: 1, height: 1 });
  assert.ok(Math.abs(below.dist[0] - Math.hypot(sz, 345)) < 1, `spike hit at ${below.dist[0]}`);
  assert.ok(Math.abs(below.hitX[0] - sx) < 0.5 && Math.abs(below.hitZ[0] - sz) < 0.5);
  const above = depthRaster({ grid: spike }, look(eye, [sx, 402, sz], 20), { width: 1, height: 1, curvature: false });
  assert.equal(above.depth[0], Infinity);
  // Up-looking frames are all sky.
  const sky = depthRaster({ grid: spike }, look(eye, [0, 2000, -1000], 20), { width: 16, height: 9 });
  assert.ok(sky.tile.every((v) => v === -1) && sky.edge.every((v) => v === 0));
});

test('depth raster reports tiles, package presence (drawn tiles only), water and the grid edge', () => {
  const g = grid(257, 20, () => 0); // 64-cell tiles: 4 x 4
  const water = new Uint8Array(257 * 257);
  for (let r = 0; r < 257; r++) for (let c = 0; c < 128; c++) water[r * 257 + c] = 1; // west half
  // t2_1 ships hidden: not drawn, so not present.
  const tiles = new Map([['t1_1', { ix: 1, iz: 1 }], ['t2_1', { ix: 2, iz: 1, visible: false }], ['t1_2', { ix: 1, iz: 2, visible: true }]]);
  const ctx = { grid: g, water, terrain: { manifest: { tileCells: 64, tilesX: 4, tilesZ: 4 }, data: { tiles, byIndex: new Map() } } };
  const r = depthRaster(ctx, look([0, 300, 1500], [0, 0, -400], 40), { width: 40, height: 24 });
  let seen = 0;
  for (let i = 0; i < r.tile.length; i++) {
    if (r.tile[i] < 0) continue;
    seen++;
    const fx = (r.hitX[i] - g.originM[0]) / 20, fz = (r.hitZ[i] - g.originM[1]) / 20;
    const ix = Math.min(3, Math.floor(fx / 64)), iz = Math.min(3, Math.floor(fz / 64));
    assert.equal(r.tile[i], iz * 4 + ix);
    assert.equal(r.present[i], (ix === 1 && (iz === 1 || iz === 2)) ? 1 : 0);
    assert.equal(r.water[i], Math.round(fx) < 128 ? 1 : 0);
    assert.ok(Math.abs(r.hitY[i]) < 1e-6);
  }
  assert.ok(seen > 0 && r.present.some((v) => v) && r.present.some((v, i) => !v && r.tile[i] >= 0));
  assert.ok(r.tile.some((v, i) => v === 1 * 4 + 2 && !r.present[i]), 'the hidden tile is in frame and not present');
  // Looking gently down across a small grid: the frame runs off its edge.
  const off = depthRaster({ grid: g }, look([0, 1000, 0], [0, 900, -4000], 20), { width: 8, height: 6 });
  assert.ok(off.edge.some((v) => v) && off.edge.every((v, i) => !v || off.depth[i] === Infinity));
});

test('canopy follows the material rules, widened to the forest jitter', () => {
  const g = grid(41, 20, (x) => 1000 + x * 0.05);
  const rules = { treelineM: 1000, forestFloorM: 900, forestMaxSlopeDeg: 30, forestDensity: 0.5, treeScale: 0.5 };
  const ctx = { grid: g, materialRules: rules, water: new Uint8Array(41 * 41) };
  assert.equal(treeHeightAt(ctx, 0, 0), 17.5); // 35 m * treeScale, at the treeline
  assert.equal(treeHeightAt({ ...ctx, materialRules: { ...rules, treelineM: 880 } }, 0, 0), 0);
  assert.equal(treeHeightAt({ ...ctx, materialRules: { ...rules, forestFloorM: 1150 } }, 0, 0), 0);
  assert.equal(treeHeightAt({ ...ctx, materialRules: { ...rules, forestDensity: 0 } }, 0, 0), 0);
  assert.equal(treeHeightAt({ ...ctx, materialRules: { ...rules, treeScale: 1, treeHeightM: 20 } }, 0, 0), 20);
  assert.equal(treeHeightAt({ ...ctx, water: new Uint8Array(41 * 41).fill(1) }, 0, 0), 0);
});

test('clearance floor is conservative over a spike, finite inside, Infinity outside', () => {
  const n = 121, cell = 20;
  const g = grid(n, cell, (x, z, c, r) => (c === 61 && r === 58 ? 1500 : 1000 + 0.02 * x));
  g.valid[10 * n + 10] = 0; g.heightsM[10 * n + 10] = NaN;
  for (let r = 0; r < 12; r++) for (let c = 100; c < 121; c++) { g.valid[r * n + c] = 0; g.heightsM[r * n + c] = NaN; }
  // Trees (35 m) everywhere below the jittered treeline (1300 + 110 m),
  // steep or not; none on the 1500 m spike.
  const rules = { treelineM: 1300, forestMaxSlopeDeg: 35, forestDensity: 0.4, treeScale: 1 };
  const ctx = { grid: g, materialRules: rules, heightRangeM: [990, 1500], deformCapM: 0.065 * 510, water: new Uint8Array(n * n) };
  // Deformation bound for any re-bake: min(180, 0.065 (y - lowest valid sample, 976 m)).
  const deform = (y) => Math.min(180, 0.065 * Math.max(0, y - 976));
  const opts = { cellM: 60, minAglM: 70, treeHeightM: 35, footprintM: 120 };
  const cl = buildClearance(ctx, opts);
  const top = (i) => {
    const y = g.heightsM[i];
    return y + (y > 1410 ? 0 : 35) + deform(y);
  };
  const span = (n - 1) * cell, o = g.originM[0];
  let checked = 0;
  for (let k = 0; k < 4000; k++) {
    const x = o + ((k * 7919) % 1000) / 1000 * span, z = o + ((k * 104729) % 997) / 997 * span;
    const f = cl.floorAt(x, z);
    assert.ok(Number.isFinite(f), `finite floor at ${x},${z}`);
    // Every valid sample within the footprint (+ one cell) is cleared by minAglM.
    for (let r = Math.max(0, Math.floor((z - 60 - o) / cell)); r <= Math.min(n - 1, Math.ceil((z + 60 - o) / cell)); r++) {
      for (let c = Math.max(0, Math.floor((x - 60 - o) / cell)); c <= Math.min(n - 1, Math.ceil((x + 60 - o) / cell)); c++) {
        const i = r * n + c;
        if (!g.valid[i]) continue;
        assert.ok(f >= top(i) + 70 - 1e-3, `floor ${f} at ${x},${z} under sample ${c},${r} (${top(i)})`);
        checked++;
      }
    }
  }
  assert.ok(checked > 1000);
  const sx = o + 61 * cell, sz = o + 58 * cell;
  assert.ok(cl.floorAt(sx + 50, sz - 50) >= 1500 + deform(1500) + 70 - 1e-3);
  const low = cl.floorAt(-1000, -1000);
  assert.ok(low >= 980 + 35 + 70 && low < 1100, `far from the spike: ground + canopy + clearance (${low})`);
  assert.equal(cl.floorAt(o - 1, 0), Infinity);
  assert.equal(cl.floorAt(0, o + span + 1), Infinity);
  assert.ok(cl.floor.every(Number.isFinite));
  assert.ok(Math.abs(cl.groundAt(0, 0) - 1000) < 1e-3);
});

test('deformation margin bounds the renderer\'s displacement for any package range a re-bake can produce', () => {
  const g = grid(21, 20, (x) => 1000 + x); // 800 .. 1200 m
  const ctx = { grid: g };
  // RangeFrame.sceneDeformation: cap * h^2, cap = min(180, 0.065 (hi - lo)).
  const actual = (y, lo, hi) => Math.min(180, 0.065 * (hi - lo)) * Math.min(1, Math.max(0, (y - lo) / Math.max(1, hi - lo))) ** 2;
  for (const [lo, hi] of [[800, 1200], [950, 1100], [1100, 1150], [800, 4800], [1000, 9000]]) {
    for (let y = 700; y <= 5000; y += 37) assert.ok(deformationMarginM(ctx, y) >= actual(y, lo, hi) - 1e-9, `y ${y} in [${lo}, ${hi}]`);
  }
  assert.equal(deformationMarginM(ctx, 800), 0);
  assert.equal(deformationMarginM(ctx, 9000), 180);
});

test('real data: monument-valley-163 context matches its baked package; depth raster at the rail', async (t) => {
  let ctx;
  try { ctx = await loadViewContext('monument-valley-163'); } catch (e) {
    if (/DEM grid cache file .* is missing/.test(e.message)) { t.skip('no cached monument-valley-163 grid'); return; }
    throw e;
  }
  assert.equal(ctx.despikedSamples, ctx.build.despikedSamples);
  assert.deepEqual(ctx.heightRangeM, [ctx.terrain.manifest.boundsM.min[1], ctx.terrain.manifest.boundsM.max[1]]);
  assert.ok(ctx.deformCapM > 0 && ctx.deformCapM <= 180);
  assert.equal(ctx.water.length, ctx.grid.width * ctx.grid.height);
  // Grid heights equal the package at stored lattice points (quantization).
  const { data, manifest } = ctx.terrain, g = ctx.grid;
  let n = 0;
  for (const tile of [...data.tiles.values()].filter((_, k) => k % 9 === 0)) {
    for (let v = 0; v < tile.samples; v += 3) for (let u = 0; u < tile.samples; u += 3) {
      const gx = tile.ix * data.cells + u * tile.stride, gz = tile.iz * data.cells + v * tile.stride;
      if (gx >= g.width || gz >= g.height) continue;
      const x = g.originM[0] + gx * g.cellSizeM, z = g.originM[1] + gz * g.cellSizeM;
      const a = g.heightsM[gz * g.width + gx], b = terrainHeightAt(data, x, z);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      assert.ok(Math.abs(a - b) <= manifest.quantization.stepM, `${x},${z}: grid ${a} package ${b}`);
      n++;
    }
  }
  assert.ok(n > 500);
  let t0 = performance.now();
  maxPyramid(g);
  const pyramidMs = performance.now() - t0;
  const pose = cameraPoseAt({ camera: ctx.camera }, 0.5);
  depthRaster(ctx, pose); // warm-up
  t0 = performance.now();
  const r = depthRaster(ctx, pose);
  const ms = performance.now() - t0;
  t.diagnostic(`pyramid ${pyramidMs.toFixed(0)} ms, 160x90 depth raster ${ms.toFixed(1)} ms`);
  const hits = r.tile.filter((v) => v >= 0).length;
  assert.ok(hits > 0.3 * r.tile.length && hits < r.tile.length, 'terrain below, sky above');
  assert.ok(r.present.filter((v, i) => r.tile[i] >= 0 && !v).length <= 0.02 * hits, 'the rail sees its own package');
  const cl = buildClearance(ctx);
  for (const p of [pose.eyeM, pose.targetM]) assert.ok(cl.floorAt(p[0], p[2]) >= cl.groundAt(p[0], p[2]) + 70);
  // The package spans less height than the grid; a re-bake reaching the low
  // northern valleys widens it, and the margin still bounds the motion.
  let gridLo = Infinity, gridHi = -Infinity;
  for (let i = 0; i < g.heightsM.length; i++) if (g.valid[i]) { gridLo = Math.min(gridLo, g.heightsM[i]); gridHi = Math.max(gridHi, g.heightsM[i]); }
  assert.ok(gridLo < ctx.heightRangeM[0] - 100);
  for (const [lo, hi] of [ctx.heightRangeM, [gridLo, gridHi], [gridLo, ctx.heightRangeM[1]]]) {
    const cap = Math.min(180, 0.065 * (hi - lo));
    for (let y = lo; y <= hi; y += 25) assert.ok(deformationMarginM(ctx, y) >= cap * ((y - lo) / (hi - lo)) ** 2 - 1e-6, `y ${y} in [${lo}, ${hi}]`);
  }
});
