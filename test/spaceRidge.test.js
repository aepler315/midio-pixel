import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpaceRidge, projectWireframe, ICO_VERTS, ICO_EDGES, N_NODES, nodeXFrac,
  tidalOffset, TIDAL_AMPLITUDE_FRAC, calmResponseParams,
  wireframeKickRadians, WIRE_KICK_RAD,
} from '../src/world/SpaceRidge.js';

test('node band assignment: 30 nodes (+3 joints each edge), treble-weighted, deterministic', () => {
  const a = new SpaceRidge(5);
  const b = new SpaceRidge(5);
  const c = new SpaceRidge(99);
  assert.equal(N_NODES, 30);
  assert.equal(a.nodes.length, 30);
  const trebleCount = a.nodes.filter((n) => n.band >= 4).length;
  assert.ok(trebleCount / a.nodes.length >= 0.55, `expected treble-heavy assignment, got ${trebleCount}/26`);
  assert.deepEqual(a.nodes.map((n) => n.band), b.nodes.map((n) => n.band), 'same seed -> same bands');
  assert.notDeepEqual(a.nodes.map((n) => n.band), c.nodes.map((n) => n.band));
  for (const n of a.nodes) assert.ok(n.band >= 0 && n.band <= 6);
});

test('nodeXFrac extends three joints past each screen edge', () => {
  assert.ok(nodeXFrac(0) < 0, 'leftmost joint sits past the left edge');
  assert.ok(nodeXFrac(N_NODES - 1) > 1, 'rightmost joint sits past the right edge');
  assert.ok(Math.abs(nodeXFrac(3)) < 0.08, 'first on-screen-ish joint near 0');
  assert.ok(Math.abs(nodeXFrac(N_NODES - 4) - 1) < 0.08, 'last on-screen-ish joint near 1');
});

test('levels stay in [0,1], finite, after many random-band updates', () => {
  const ridge = new SpaceRidge(3);
  let t = 0;
  for (let i = 0; i < 600; i++) {
    const bands = Array.from({ length: 7 }, () => Math.random());
    ridge.update(t, 0.016, bands);
    t += 16;
  }
  for (const n of ridge.nodes) {
    assert.ok(Number.isFinite(n.level));
    assert.ok(n.level >= 0 && n.level <= 1 + 1e-6);
  }
});

test('attack is faster than release (step response)', () => {
  const up = new SpaceRidge(1);
  const bandUp = [1, 1, 1, 1, 1, 1, 1];
  up.update(0, 0.02, bandUp);
  const levelAfterAttackStep = up.nodes[0].level;

  const down = new SpaceRidge(1);
  for (let i = 0; i < 50; i++) down.update(i * 16, 0.016, bandUp); // saturate to ~1
  const bandDown = [0, 0, 0, 0, 0, 0, 0];
  down.update(800, 0.02, bandDown);
  const levelAfterReleaseStep = down.nodes[0].level; // should still be near 1 (slow release)

  assert.ok(levelAfterAttackStep > 0.3, `attack should move quickly, got ${levelAfterAttackStep}`);
  assert.ok(levelAfterReleaseStep > 0.5, `release should move slowly, got ${levelAfterReleaseStep}`);
});

// --- calmResponseParams: calm stretches attack/release so the line rolls
// in slow, broad contours instead of ticking to every treble transient ---

test('calmResponseParams: identity at calm=0, stretches monotonically toward calm=1', () => {
  assert.equal(calmResponseParams(0).tauMul, 1);
  let prev = -Infinity;
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const { tauMul } = calmResponseParams(c);
    assert.ok(tauMul >= prev - 1e-9, 'tau must not shrink as calm rises');
    prev = tauMul;
  }
  assert.ok(calmResponseParams(1).tauMul > 1, 'full calm must genuinely stretch the envelope');
});

test('calmResponseParams clamps out-of-range input the same as clamp01', () => {
  assert.deepEqual(calmResponseParams(-1), calmResponseParams(0));
  assert.deepEqual(calmResponseParams(2), calmResponseParams(1));
});

test('a calm section reacts to the same step input more slowly than a hot one (attack)', () => {
  const hot = new SpaceRidge(1), calm = new SpaceRidge(1);
  const bandUp = [1, 1, 1, 1, 1, 1, 1];
  hot.update(0, 0.02, bandUp, 0);
  calm.update(0, 0.02, bandUp, 1);
  assert.ok(calm.nodes[0].level < hot.nodes[0].level,
    `expected the calm line to ease in more slowly, got hot=${hot.nodes[0].level} calm=${calm.nodes[0].level}`);
});

test('flashes fire on a big jump and drain within their life window', () => {
  const ridge = new SpaceRidge(2);
  ridge.update(0, 0.016, [0, 0, 0, 0, 0, 0, 0]);
  ridge.update(100, 0.1, [1, 1, 1, 1, 1, 1, 1]); // big jump (large dt) for every node
  assert.ok(ridge._flashes.length > 0, 'a big jump should register a flash');
  ridge.update(500, 0.016, [1, 1, 1, 1, 1, 1, 1]); // 400ms later, past FLASH_LIFE_MS=300
  assert.equal(ridge._flashes.length, 0, 'flashes should have drained');
});

test('a real 120Hz onset flashes once and rearms only after the band releases', () => {
  const ridge = new SpaceRidge(2);
  const quiet = new Array(7).fill(0);
  const loud = new Array(7).fill(1);
  const dt = 1 / 120;
  let time = 0;
  const step = (bands) => { ridge.update(time, dt, bands, 0); time += 1000 / 120; };
  for (let i = 0; i < 30; i++) step(quiet);
  let first = 0;
  for (let i = 0; i < 60; i++) { step(loud); first += ridge._flashes.length > 0 ? 1 : 0; }
  assert.ok(first > 0, 'a live-cadence attack must produce an accent');
  assert.ok(first < 40, 'sustained energy must not continuously retrigger');
  for (let i = 0; i < 80; i++) step(quiet);
  let second = 0;
  for (let i = 0; i < 60; i++) { step(loud); second += ridge._flashes.length > 0 ? 1 : 0; }
  assert.ok(second > 0, 'a later onset must rearm');
});

test('the Range sky form has a large musical throw even with reduced flash', () => {
  const ridge = new SpaceRidge(315);
  const stage = { width: 1280, height: 720 };
  const quiet = ridge._samples(stage).pts;
  const quietMean = quiet.reduce((sum, p) => sum + p.y, 0) / quiet.length;
  for (let i = 0; i < 240; i++) ridge.update(i * 1000 / 120, 1 / 120, new Array(7).fill(1), 0);
  const loud = ridge._samples(stage).pts;
  const loudMean = loud.reduce((sum, p) => sum + p.y, 0) / loud.length;
  assert.ok(quietMean - loudMean >= 60 && quietMean - loudMean <= 120,
    `musical form should move 60-120px at 720p, got ${quietMean - loudMean}`);
});

test('the resting cosmic ridge already has a broad sculptural profile', () => {
  const ridge = new SpaceRidge(315);
  const ys = ridge._samples({ width: 1280, height: 720 }).pts.slice(3, -3).map(p => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) >= 45,
    'quiet sky must retain large-scale relief rather than become a horizontal string');
});

test('the live ridge exposes a deterministic exclusion corridor to other sky paint', () => {
  const ridge = new SpaceRidge(315);
  const canvas = { width: 1280, height: 720 };
  const corridor = ridge.corridor(canvas);
  const middle = corridor(canvas.width / 2);
  const sample = ridge._samples(canvas).pts.filter(p => Math.abs(p.x - canvas.width / 2) < 80)[0];
  assert.ok(sample && middle.top < sample.y && middle.bottom > sample.y);
  assert.deepEqual(corridor(canvas.width / 2), middle);
  assert.ok(middle.bottom < canvas.height * 0.3781, 'space ridge stays distinct from the sea horizon');
});

test('opposite adjacent band depths never fold the immense contour back on itself', () => {
  const ridge = new SpaceRidge(315);
  ridge.nodes.forEach((node, i) => { node.z = i % 2; node.level = i % 2; });
  const xs = ridge._samples({ width: 1280, height: 720 }).pts.map(p => p.x);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), 'skyline x must stay ordered as depth changes');
});

test('projectWireframe: finite coordinates, edge count preserved, full rotation is near-identity', () => {
  const p0 = projectWireframe(ICO_VERTS, ICO_EDGES, 0, 0, 10);
  assert.equal(p0.edges.length, ICO_EDGES.length);
  for (const pt of p0.points) assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));

  const pFull = projectWireframe(ICO_VERTS, ICO_EDGES, Math.PI * 2, Math.PI * 2, 10);
  for (let i = 0; i < p0.points.length; i++) {
    assert.ok(Math.abs(p0.points[i].x - pFull.points[i].x) < 1e-6);
    assert.ok(Math.abs(p0.points[i].y - pFull.points[i].y) < 1e-6);
  }
  assert.ok(ICO_EDGES.length >= 12, 'icosahedron should have a reasonable edge count');
});

test('the sky wireframe cocks forward on a kick and settles back into the tumble', () => {
  assert.equal(wireframeKickRadians(-1), 0);
  const peak = wireframeKickRadians(40);
  assert.ok(peak > 0.3 && peak <= WIRE_KICK_RAD + 1e-9, `peak hitch ${peak}`);
  assert.ok(wireframeKickRadians(2000) < 0.02, 'the hitch must be gone within a beat or two');
  const bands = new Array(7).fill(0);
  const idle = new SpaceRidge(3);
  idle.update(10_000, 0.016, bands, 0, -1);
  const hit = new SpaceRidge(3);
  hit.update(10_000, 0.016, bands, 0, 40);
  assert.ok(hit._rotX > idle._rotX + 0.3, 'same song time, the kick pose leads the idle tumble');
  // Seek back to the same instant with no kick in progress: same pose.
  hit.update(10_000, 0.016, bands, 0, -1);
  assert.ok(Math.abs(hit._rotX - idle._rotX) < 1e-9);
});

test('draw() no longer takes a worldX -- the structure never scrolls with the world', () => {
  // Regression for "ends 6-7 joints short after a few minutes": the old
  // draw(ctx, canvas, worldX, ...) translated every sample by worldX*PARALLAX.
  // The signature itself is now the guarantee -- draw() has no worldX
  // parameter at all, so nothing can reintroduce that drift.
  assert.equal(SpaceRidge.prototype.draw.length, 4, 'draw(ctx, canvas, color, tSec, reducedFlash=false) -- no worldX');
});

test('tidalOffset stays within its amplitude bound across a long time sweep', () => {
  const canvasHeight = 720;
  const bound = TIDAL_AMPLITUDE_FRAC * canvasHeight;
  for (let tSec = 0; tSec < 6000; tSec += 7.3) {
    const off = tidalOffset(tSec, canvasHeight);
    assert.ok(Number.isFinite(off));
    assert.ok(Math.abs(off) <= bound + 1e-9, `tidal offset ${off} exceeded bound ${bound} at t=${tSec}`);
  }
});

test('a node under sustained band energy eases its depth (z) toward 1; a quiet node stays near 0', () => {
  const ridge = new SpaceRidge(11);
  const loudBand = ridge.nodes[0].band;
  const bands = new Array(7).fill(0);
  bands[loudBand] = 1;
  let t = 0;
  for (let i = 0; i < 300; i++) { ridge.update(t, 0.016, bands); t += 16; }
  assert.ok(ridge.nodes[0].z > 0.7, `expected node under sustained energy to push toward z=1, got ${ridge.nodes[0].z}`);

  const quiet = new SpaceRidge(11);
  let t2 = 0;
  for (let i = 0; i < 300; i++) { quiet.update(t2, 0.016, new Array(7).fill(0)); t2 += 16; }
  assert.ok(quiet.nodes[0].z < 0.05, `expected a silent node to stay near z=0, got ${quiet.nodes[0].z}`);
});
