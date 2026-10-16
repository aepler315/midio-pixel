// Range v2 Task 14: the scenic projection keeps terrain at the nominal
// stage's scale, and every frame the app can produce stays inside what the
// terrain bake made visible (core at normal framing, extended at the
// deepest pull-back), shake overscan included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenicProjection, viewportState } from '../src/world/alpine/RangeFrame.js';
import { ZOOM_MIN } from '../src/render/CameraDirector.js';
import { SHAKE_MARGIN_PX } from '../src/render/Renderer.js';
import { VISIBILITY } from '../tools/lib/terrain-bake.mjs';

const FOV = 35;
const tanHalf = (deg) => Math.tan((deg * Math.PI) / 360);

// The viewport Renderer hands the scene for a zoom and a nominal stage.
function stageViewport(nominalW, nominalH, zoom = 1, dpr = 1) {
  const w = (zoom < 1 ? nominalW / zoom : nominalW) + 2 * SHAKE_MARGIN_PX;
  const h = (zoom < 1 ? nominalH / zoom : nominalH) + 2 * SHAKE_MARGIN_PX;
  return viewportState({ logicalWidth: w, logicalHeight: h, backingWidth: Math.round(w * dpr), backingHeight: Math.round(h * dpr),
    overscanPx: SHAKE_MARGIN_PX, nominalWidth: nominalW, nominalHeight: nominalH, pixelRatio: dpr });
}

// Half-extents of the frustum, in units of the view's own tan(fov/2).
function extent(proj, fov = FOV) {
  const v = tanHalf(proj.fovYDeg) / tanHalf(fov);
  return { v, h: v * proj.aspect };
}
const fits = (e, vis) => e.v <= vis.fovScale + 1e-9 && e.h <= vis.fovScale * vis.aspect + 1e-9;

test('at the nominal stage the scenic camera uses the view fov exactly', () => {
  const p = scenicProjection(FOV, viewportState({ logicalWidth: 1280, logicalHeight: 720, nominalWidth: 1280, nominalHeight: 720 }));
  assert.ok(Math.abs(p.fovYDeg - FOV) < 1e-9);
  assert.ok(Math.abs(p.aspect - 16 / 9) < 1e-12);
  assert.equal(p.tanScale, 1);
});

test('a pull-back shows more landscape at the same pixels per radian', () => {
  const pxPerTan = (vp) => (vp.logicalHeight / 2) / tanHalf(scenicProjection(FOV, vp).fovYDeg);
  const base = pxPerTan(stageViewport(1280, 720, 1));
  for (const zoom of [0.9, 0.8, ZOOM_MIN]) {
    const vp = stageViewport(1280, 720, zoom);
    assert.ok(Math.abs(pxPerTan(vp) - base) < 1e-6, `zoom ${zoom} rescales terrain`);
    assert.ok(scenicProjection(FOV, vp).fovYDeg > FOV);
  }
});

test('backing size and device pixel ratio never change what is framed', () => {
  const one = scenicProjection(FOV, stageViewport(1280, 720, 0.8, 1));
  for (const dpr of [1.5, 2, 3]) assert.deepEqual(scenicProjection(FOV, stageViewport(1280, 720, 0.8, dpr)), one);
});

test('aspect is the logical stage aspect, overscan included', () => {
  const vp = stageViewport(1280, 720, 1);
  assert.equal(scenicProjection(FOV, vp).aspect, (1280 + 2 * SHAKE_MARGIN_PX) / (720 + 2 * SHAKE_MARGIN_PX));
});

test('normal framing with full shake overscan stays inside the core bake', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [1490, 720]]) { // 16:9 and the 2.07:1 reference
    const e = extent(scenicProjection(FOV, stageViewport(w, h, 1)));
    assert.ok(fits(e, VISIBILITY.core), `${w}x${h}: v ${e.v.toFixed(3)} h ${e.h.toFixed(3)}`);
  }
});

test('the deepest pull-back plus shake stays inside the extended bake', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [1490, 720], [720, 1280]]) { // portrait too, if ever unboxed
    const e = extent(scenicProjection(FOV, stageViewport(w, h, ZOOM_MIN)));
    assert.ok(fits(e, VISIBILITY.extended), `${w}x${h}: v ${e.v.toFixed(3)} h ${e.h.toFixed(3)}`);
  }
});

test('the fov does not depend on where the stage sits in a resize', () => {
  // Same nominal stage, different window sizes: the letterboxed stage only
  // changes backing pixels, so the projection is identical.
  const a = scenicProjection(FOV, stageViewport(1280, 720, 0.75, 1));
  const b = scenicProjection(FOV, stageViewport(1280, 720, 0.75, 0.62));
  assert.deepEqual(a, b);
});

// Visibility: the far range's crest, measured on the shipped packages.
const { viewExposure, travelExposure, pairExposure, MIN_FAR_EXPOSED } = await import('../tools/lib/range-exposure.mjs');
const { default: CATALOG } = await import('../src/world/terrain/sceneCatalogData.js');
const RUNTIME_DIR = new URL('../src/assets/range/v2/', import.meta.url).pathname;
const approved = CATALOG.views.filter((v) => v.status === 'approved');
const exposures = new Map();
for (const v of approved) exposures.set(v.id, await viewExposure(RUNTIME_DIR, v));

test('every approved view keeps its far crest >= 0.55 exposed at all 21 stations', () => {
  assert.ok(approved.length > 0);
  for (const v of approved) {
    const e = exposures.get(v.id);
    assert.equal(e.stations.length, 21);
    assert.ok(e.min >= MIN_FAR_EXPOSED, `${v.id}: ${e.stations.map((s) => s.fraction.toFixed(2)).join(' ')}`);
    assert.ok(e.stations.every((s) => s.crestColumns > 0.5), `${v.id}: a far range spans the frame`);
  }
});

test('every travel between approved views keeps the far crest exposed at every station and seam sample', () => {
  // Both sides render at the song's one progress value: station k of A is
  // blended with station k of B.
  for (const a of approved) for (const b of approved) {
    const { min, at, minCrest } = pairExposure(exposures.get(a.id), exposures.get(b.id));
    assert.ok(min >= MIN_FAR_EXPOSED, `${a.id} -> ${b.id}: ${min.toFixed(2)} at station ${at.station}, seam ${at.p}`);
    assert.ok(minCrest >= 0.5, `${a.id} -> ${b.id}: crest spans only ${minCrest.toFixed(2)} in travel`);
  }
});

// Synthetic station masks: a far crest on row 5 of every column, and which
// partition is nearest there (1 far = exposed, 2 mid / 3 near = covering).
function masks({ W = 100, crest = true, ownerAtCrest = 1 } = {}) {
  const H = 20, owner = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) owner[5 * W + x] = ownerAtCrest;
  const presence = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) presence[5 * W + x] = ownerAtCrest === 2 ? 2 : ownerAtCrest === 3 ? 4 : 0;
  return {
    W, H, groundRow: 18, owner, topFar: new Int16Array(W).fill(crest ? 5 : -1), presence,
    farBeatsMid: new Uint8Array(W).fill(ownerAtCrest === 2 ? 0 : 1), farBeatsNear: new Uint8Array(W).fill(ownerAtCrest === 3 ? 0 : 1),
  };
}

test('pair exposure checks matching stations, not rail ends', () => {
  const good = () => ({ masks: masks() });
  const bad = { masks: masks({ ownerAtCrest: 2 }) };
  // A is fine at every station; B is hidden only at station 1 -- a rail-end
  // check (A's last, B's first) would miss it.
  const A = { stations: [good(), good(), good()] };
  const B = { stations: [good(), bad, good()] };
  const r = pairExposure(A, B, { seamSamples: 5 });
  assert.equal(r.min, 0);
  assert.equal(r.at.station, 1);
});

test('travel exposure follows the seam: all A before, all B after', () => {
  const A = masks(), B = masks({ ownerAtCrest: 2 });
  assert.equal(travelExposure(A, B, 0).fraction, 1);
  assert.equal(travelExposure(A, B, 1).fraction, 0);
  const mid = travelExposure(A, B, 0.5).fraction;
  assert.ok(mid > 0 && mid < 1);
});

test("travel exposure composes every partition's own seam: B's near pass can cover A's far crest", () => {
  // B has no far crest at all but its near pass covers row 5. At 55% the
  // near seam (L5) has fully crossed while the far seam (L2) has not: the
  // columns whose far crest still comes from A are covered by B's near.
  const A = masks(), B = masks({ crest: false, ownerAtCrest: 3 });
  assert.equal(travelExposure(A, B, 0).fraction, 1);
  assert.equal(travelExposure(A, B, 0.55).fraction, 0, 'an L2-only check would score these A columns exposed');
});

test("a side's own nearer band hides its crest only where that side still draws it", () => {
  // A's near ridge stands in front of its far crest; B has no near terrain.
  // Once the near seam has crossed (near from B) while far is still A's,
  // A's depth pre-pass no longer holds its near ridge there, so A's far
  // crest shows -- it is no longer cut out by a ridge the frame has dropped.
  const A = masks({ ownerAtCrest: 3 }), B = masks({ crest: false });
  assert.equal(travelExposure(A, B, 0).fraction, 0, 'steady A: its own ridge hides the crest');
  assert.ok(travelExposure(A, B, 0.55).fraction > 0.9);
});

test('crest coverage is reported, so a sliver of crest cannot pass as exposed', async () => {
  const { maskExposure, MIN_FAR_CREST_COLUMNS } = await import('../tools/lib/range-exposure.mjs');
  const m = masks();
  m.topFar.fill(-1);
  m.topFar[3] = 5; // one exposed column
  const e = maskExposure(m);
  assert.equal(e.fraction, 1);
  assert.ok(e.crestColumns < MIN_FAR_CREST_COLUMNS);
});

test('far-crest exposure catches a near wall and the ground line', async () => {
  const { farCrestExposure } = await import('../tools/lib/terrain-bake.mjs');
  const W = 201, cell = 100;
  const make = (wallM) => {
    const heightsM = new Float32Array(W * W);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const z = -10000 + j * cell; // camera at z = 0 looks toward -z
      heightsM[j * W + i] = z < -8000 ? 1400 + 200 * Math.sin(i / 6) : (z > -3000 && z < -2000 ? wallM : 0);
    }
    return { width: W, height: W, cellSizeM: cell, originM: [-10000, -10000], heightsM, valid: new Uint8Array(W * W).fill(1) };
  };
  const pose = { eyeM: [0, 300, 0], targetM: [0, 300, -10000], fovYDeg: 35 };
  const open = farCrestExposure(make(0), pose, 7000);
  assert.ok(open.fraction > 0.9, `open ${open.fraction}`);
  const walled = farCrestExposure(make(2500), pose, 7000);
  assert.ok(walled.fraction < MIN_FAR_EXPOSED, `walled ${walled.fraction}`);
  const low = farCrestExposure(make(0), { ...pose, targetM: [0, 4500, -10000] }, 7000);
  assert.ok(low.crestColumns > 0.5 && low.fraction < MIN_FAR_EXPOSED, `a far crest pushed under the ground line is not exposed (${low.fraction})`);
});

test('travel reports crest coverage: complementary crests leave a sliver mid-seam', () => {
  // A has its far crest only on the right half, B only on the left half:
  // as the seam passes, the composite can hold almost no crest at all.
  const A = masks(), B = masks();
  for (let x = 0; x < 50; x++) A.topFar[x] = -1;
  for (let x = 50; x < 100; x++) B.topFar[x] = -1;
  const low = Math.min(...[0.2, 0.3, 0.4, 0.5, 0.6].map((p) => travelExposure(A, B, p).crestColumns));
  assert.ok(low < 0.5, `crest coverage ${low}`);
  assert.ok(pairExposure({ stations: [{ masks: A }] }, { stations: [{ masks: B }] }, { seamSamples: 11 }).minCrest < 0.5);
});

test('trees in the depth pre-pass can hide the far crest', async () => {
  const { stationMasks, maskExposure } = await import('../tools/lib/range-exposure.mjs');
  const W = 201, cell = 100;
  const heightsM = new Float32Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) heightsM[j * W + i] = -10000 + j * cell < -8000 ? 900 : 0;
  const mk = (keep) => ({ width: W, height: W, cellSizeM: cell, originM: [-10000, -10000], heightsM: keep ? heightsM : new Float32Array(W * W), valid: new Uint8Array(W * W).fill(keep ? 1 : 0) });
  const far = mk(true);
  // Near-band (2) trees in a row 400 m ahead, tall enough to reach the crest
  // (about 6 degrees up from the eye).
  const rows = [];
  for (let x = -600; x <= 600; x += 6) rows.push(x, 0, -400, 150, 8, 0, 0.5, 2);
  const pose = { eyeM: [0, 20, 0], targetM: [0, 20, -10000], fovYDeg: 35 };
  const open = maskExposure(stationMasks({ far, mid: mk(false), near: mk(false) }, pose));
  const wooded = maskExposure(stationMasks({ far, mid: mk(false), near: mk(false) }, pose, { trees: { data: new Float32Array(rows), stride: 8 } }));
  assert.ok(open.fraction > 0.9, `open ${open.fraction}`);
  assert.ok(wooded.fraction < open.fraction - 0.5, `wooded ${wooded.fraction}`);
});
