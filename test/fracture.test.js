import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FractureEngine,
  buildMonolithPolylines,
  buildStressThresholds,
  polylineFromPoints,
  shatterFadeAlpha,
  shatterMotionU,
  RIDGE_GEN_COUNT,
} from '../src/world/FractureEngine.js';
import { Conductor } from '../src/core/Conductor.js';
import { OCEAN_HORIZON_FRAC, OCEAN_NEAR_FRAC } from '../src/world/Ocean.js';
import { BASELINE_FRAC as SPACE_RIDGE_BASELINE_FRAC } from '../src/world/SpaceRidge.js';
import { makeNoteEvent, Role } from '../src/core/NoteEvent.js';
import { FLASH_CAP } from '../src/ui/Accessibility.js';

function buildConductorWithKicks(durationMs, kickPeriodMs = 500) {
  const timeline = [];
  for (let t = 0; t < durationMs; t += kickPeriodMs) {
    timeline.push(makeNoteEvent({ tMs: t, pitch: 36, vel: 0.8, role: Role.RHYTHM, kick: true, src: 'audio' }));
  }
  const barGrid = [];
  for (let t = 0; t < durationMs; t += kickPeriodMs * 4) barGrid.push({ tick: 0, ms: t, numerator: 4, denominator: 4 });
  const conductor = new Conductor();
  conductor.load({ timeline, barGrid, durationMs });
  return conductor;
}

test('polylineFromPoints accumulates segment lengths', () => {
  const p = polylineFromPoints([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 + 5 }]);
  assert.equal(p.nodes.length, 3);
  assert.equal(p.lengths.length, 2);
  assert.ok(Math.abs(p.lengths[0] - 5) < 1e-9);
  assert.ok(Math.abs(p.lengths[1] - 5) < 1e-9);
  assert.ok(Math.abs(p.total - 10) < 1e-9);
});

test('buildStressThresholds spreads evenly across the song progress axis', () => {
  const t = buildStressThresholds(16, 0.04, 0.92);
  assert.equal(t.length, 16);
  assert.ok(Math.abs(t[0] - 0.04) < 1e-9);
  assert.ok(Math.abs(t[t.length - 1] - 0.92) < 1e-9);
  // Even spacing: each step is the same within float noise.
  const step = t[1] - t[0];
  for (let i = 2; i < t.length; i++) {
    assert.ok(Math.abs((t[i] - t[i - 1]) - step) < 1e-9);
  }
  assert.equal(RIDGE_GEN_COUNT, 16);
});

test('buildMonolithPolylines: deterministic, counted, and on-canvas', () => {
  const w = 1280, h = 720;
  const a = buildMonolithPolylines(w, h, 42, RIDGE_GEN_COUNT);
  const b = buildMonolithPolylines(w, h, 42, RIDGE_GEN_COUNT);
  const c = buildMonolithPolylines(w, h, 99, RIDGE_GEN_COUNT);
  assert.equal(a.length, RIDGE_GEN_COUNT);
  assert.deepEqual(a, b, 'same seed reproduces the monolith plan');
  assert.notDeepEqual(a, c, 'different seeds diverge');

  for (const poly of a) {
    assert.ok(poly.nodes.length >= 2);
    assert.ok(poly.total > 8, 'each piece must have real length');
    for (const n of poly.nodes) {
      assert.ok(n.x > -w * 0.1 && n.x < w * 1.1);
      assert.ok(n.y > -h * 0.05 && n.y < h * 1.05);
    }
  }
});

test('the monolith spans the ocean plane to above the space ridge', () => {
  const w = 1280, h = 720;
  const plan = buildMonolithPolylines(w, h, 7, RIDGE_GEN_COUNT);
  const allY = plan.flatMap((p) => p.nodes.map((n) => n.y));
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);

  // Its foot stands on the ocean plane -- between the far horizon and the
  // plane's near edge, not on the ground and not floating in the sky.
  const oceanTop = h * OCEAN_HORIZON_FRAC;
  const oceanBottom = h * OCEAN_NEAR_FRAC;
  assert.ok(maxY > oceanTop && maxY < oceanBottom,
    `the base must sit in the water (${oceanTop}..${oceanBottom}), got ${maxY}`);

  // Its crown reaches past the altitude the space ridge hangs at.
  const ridgeY = h * SPACE_RIDGE_BASELINE_FRAC;
  assert.ok(minY < ridgeY, `the crown must pierce above the ridge (${ridgeY}), got ${minY}`);
});

test('the monolith is planned bottom-up, so births make it RISE across the song', () => {
  const w = 1280, h = 720;
  const plan = buildMonolithPolylines(w, h, 3, RIDGE_GEN_COUNT);
  // Highest point (smallest y) reached by each piece, in birth order.
  const tops = plan.map((p) => Math.min(...p.nodes.map((n) => n.y)));

  // The ship is the lowest thing in the plan and is born first; the crown is
  // the highest and is born last. Assert the trend rather than strict
  // monotonicity -- pieces alternate left/right edge within a course.
  const firstThird = tops.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
  const lastThird = tops.slice(-5).reduce((s, v) => s + v, 0) / 5;
  assert.ok(lastThird < firstThird - h * 0.15,
    `late pieces must sit far higher than early ones, got ${firstThird} -> ${lastThird}`);

  // The very first piece is the ship's hull, on the water; the very last is
  // the tie into the ridge.
  assert.ok(tops[0] > h * 0.30, `the first birth is the hull on the water, got ${tops[0]}`);
});

test('the last birth ties the monolith into the space ridge altitude', () => {
  const w = 1280, h = 720;
  const plan = buildMonolithPolylines(w, h, 11, RIDGE_GEN_COUNT);
  const tie = plan[plan.length - 1];
  const ridgeY = h * SPACE_RIDGE_BASELINE_FRAC;

  // It sits at the ridge's own altitude...
  for (const n of tie.nodes) {
    assert.ok(Math.abs(n.y - ridgeY) < h * 0.03,
      `tie node should hug the ridge altitude ${ridgeY}, got ${n.y}`);
  }
  // ...and reaches out sideways far enough to read as joining it, rather
  // than being one more piece of the shaft.
  const xs = tie.nodes.map((n) => n.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > w * 0.5,
    'the tie line must reach out along the ridge, not just span the shaft');
});

test('shatterFadeAlpha / shatterMotionU are smooth hold-then-ease envelopes', () => {
  assert.equal(shatterFadeAlpha(0), 1);
  assert.equal(shatterFadeAlpha(400), 1);
  assert.ok(shatterFadeAlpha(900) < 1 && shatterFadeAlpha(900) > 0);
  assert.ok(shatterFadeAlpha(2000) <= 1e-9);

  assert.equal(shatterMotionU(0), 0);
  assert.equal(shatterMotionU(50), 0); // still in freeze hold
  assert.ok(shatterMotionU(200) > 0 && shatterMotionU(200) < 1);
  assert.ok(shatterMotionU(800) >= 0.99);
});

test('FractureEngine births cracks as the stress accumulator crosses thresholds over a song', () => {
  const durationMs = 60000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 42, durationMs });

  const dtMs = 1000 / 120;
  const fakeEnergy = { globalEnergy: () => 0.6 };
  for (let t = 0; t < durationMs - 1000; t += dtMs) {
    conductor.dispatchUpTo(t);
    fx.update(t, dtMs / 1000, fakeEnergy, null);
  }

  assert.ok(fx.cracks.length > 0, 'expected at least one crack to have been born');
  assert.ok(fx.stress > 0.15);
  // The monolith plan is precomputed and cracks walk it gradually.
  assert.equal(fx._monolithPlan.length, RIDGE_GEN_COUNT);
  // By late song (stress ~0.9 from linear tNorm) most pieces should exist.
  assert.ok(fx.cracks.length >= 10, `expected gradual full-track births, got ${fx.cracks.length}`);
  for (const crack of fx.cracks) {
    assert.ok(crack.nodes.length >= 2);
    assert.ok(crack.total > 0);
  }
});

test('ridge births are paced by song progress, not piled into the final third', () => {
  const durationMs = 60000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 11, durationMs });
  const dtMs = 1000 / 120;
  const fakeEnergy = { globalEnergy: () => 0.4 };
  let at25 = 0, at50 = 0, at75 = 0;
  for (let t = 0; t < durationMs - 500; t += dtMs) {
    conductor.dispatchUpTo(t);
    fx.update(t, dtMs / 1000, fakeEnergy, null);
    if (t >= durationMs * 0.25 && at25 === 0) at25 = fx.cracks.length;
    if (t >= durationMs * 0.50 && at50 === 0) at50 = fx.cracks.length;
    if (t >= durationMs * 0.75 && at75 === 0) at75 = fx.cracks.length;
  }
  assert.ok(at25 >= 2, `some ridges should appear by 25% of the song, got ${at25}`);
  assert.ok(at50 > at25, `ridge count should grow mid-song (${at25} -> ${at50})`);
  assert.ok(at75 > at50, `ridge count should keep growing late (${at50} -> ${at75})`);
  assert.ok(fx.cracks.length > at75, 'final stretch should still add ridges');
});

test('FractureEngine transitions to about-to-freeze on the musical last-impact finale', () => {
  const durationMs = 5000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 1, durationMs });
  const armAt = fx._freezeArmMs;
  assert.ok(Number.isFinite(armAt) && armAt > 0, 'finale arm time is set from last impact notes');
  assert.ok(fx.finale.lastImpactMs > 0, 'last impact note detected');

  const dtMs = 1000 / 120;
  let flippedAt = null;
  for (let t = 0; t < durationMs + 500; t += dtMs) {
    conductor.dispatchUpTo(t);
    fx.update(t, dtMs / 1000, null, null);
    if (fx.isAboutToFreeze && flippedAt === null) flippedAt = t;
  }
  assert.ok(flippedAt !== null, 'expected shatterState to reach about-to-freeze');
  assert.ok(Math.abs(flippedAt - armAt) < 50, `freeze armed at ${flippedAt}, expected ~${armAt}`);
  assert.ok(fx.justEnteredFinale === false || flippedAt !== null); // flag is one-frame; state persists
});

test('FractureEngine triangulates accumulated crack nodes into fragments with stagger', () => {
  const durationMs = 30000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 800, canvasHeight: 600, songSeed: 7, durationMs });

  fx._birthCrack(0, 0, null);
  fx._birthCrack(3, 1000, null);
  fx._triangulate();

  assert.ok(fx.fragments.count > 0, 'expected triangulation to produce fragments');
  for (const f of fx.fragments.active) {
    assert.equal(f.tri.length, 3);
    assert.ok(Number.isFinite(f.vx0) && Number.isFinite(f.vy0));
    assert.ok(f.startDelayMs >= 0);
  }
});

test('shatter update eases fragments then settles to done without a hard pop', () => {
  const durationMs = 10000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 640, canvasHeight: 360, songSeed: 3, durationMs });
  fx._birthCrack(0, 0, null);
  fx.freezeMs = 0;
  fx.shatterState = 'frozen';
  fx._triangulate();
  fx._lastNowMs = 0;

  // During freeze hold, shards stay put.
  fx.update(40, 0.04, null, null);
  const sample = fx.fragments.active[0];
  const x0 = sample.x, y0 = sample.y;

  fx.update(80, 0.04, null, null);
  assert.ok(Math.abs(sample.x - x0) < 2 && Math.abs(sample.y - y0) < 2, 'hold should keep shards nearly still');

  // Later they drift and eventually complete.
  for (let t = 100; t < 1700; t += 16) {
    fx._lastNowMs = t;
    fx.update(t, 0.016, null, null);
  }
  assert.equal(fx.shatterState, 'done');
  assert.equal(fx.fragments.count, 0);
});

// --- Surface cracks: Broshi's burrow punching through the pane -----------

test('spawnSurfaceCrack adds a transient burst without touching the permanent ridge cracks', () => {
  const durationMs = 30000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 5, durationMs });
  fx._lastNowMs = 1000;

  fx.spawnSurfaceCrack(300, 500, null);

  assert.equal(fx.surfaceCracks.length, 1);
  assert.equal(fx.cracks.length, 0, 'surface cracks must never join the permanent ridge crack list');
  const sc = fx.surfaceCracks[0];
  assert.ok(sc.trees.length >= 3, 'a small radial burst, not a single stroke');
  for (const leg of sc.trees) {
    assert.ok(leg.total > 0);
    assert.ok(Number.isFinite(leg.nodes[0].x) && Number.isFinite(leg.nodes[0].y));
  }
});

test('surface cracks grow in, then fade out and prune themselves via update()', () => {
  const durationMs = 30000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 5, durationMs });
  fx._lastNowMs = 0;
  fx.spawnSurfaceCrack(300, 500, null);
  const born = fx.surfaceCracks[0].bornMs;

  fx.update(born + 100, 0.1, null, null);
  assert.equal(fx.surfaceCracks.length, 1, 'still alive shortly after spawning');

  fx.update(born + 5000, 0.1, null, null);
  assert.equal(fx.surfaceCracks.length, 0, 'a burst this old must have pruned itself');
});

test('spawnSurfaceCrack is deterministic per seed and does not spawn once the finale has taken over', () => {
  const durationMs = 30000;
  const conductor = buildConductorWithKicks(durationMs);
  const a = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 9, durationMs });
  const b = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 9, durationMs });
  a._lastNowMs = 500; b._lastNowMs = 500;
  a.spawnSurfaceCrack(200, 400, null);
  b.spawnSurfaceCrack(200, 400, null);
  assert.deepEqual(a.surfaceCracks, b.surfaceCracks, 'same seed reproduces the same burst geometry');

  a.shatterState = 'frozen';
  a.spawnSurfaceCrack(200, 400, null);
  assert.equal(a.surfaceCracks.length, 1, 'no new bursts once the shatter has taken over the screen');
});

test('draw() renders surface cracks at full alpha through their fade envelope without throwing', () => {
  const durationMs = 30000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 5, durationMs });
  fx._lastNowMs = 0;
  fx.spawnSurfaceCrack(300, 500, null);

  const { ctx, alphas } = alphaRecordingCtx();
  fx._lastNowMs = 50; // mid-growth
  fx.draw(ctx, { width: 1280, height: 720 });
  assert.ok(alphas.length > 0, 'mid-growth burst should draw something');

  const { ctx: ctx2, alphas: alphas2 } = alphaRecordingCtx();
  fx._lastNowMs = 10000; // long past its life
  fx.draw(ctx2, { width: 1280, height: 720 });
  assert.equal(alphas2.length, 0, 'a fully aged-out burst (pruned by update()) should draw nothing');
});

// --- Reduced-flash accessibility -----------------------------------------
//
// draw() and drawShatter() each fill the whole viewport at flashAlpha. This
// class was the one place in the codebase that never imported
// Accessibility.js -- every other flash in the game honours capFlashAlpha,
// but these two full-viewport fills went straight to the raw alpha.

function alphaRecordingCtx() {
  const alphas = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {},
    translate() {}, rotate() {}, scale() {}, clip() {}, drawImage() {}, fillRect() {},
    set globalAlpha(v) { alphas.push(v); }, get globalAlpha() { return alphas[alphas.length - 1]; },
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set lineJoin(v) {}, set lineCap(v) {},
  };
  return { ctx, alphas };
}

test('the progressive crack-birth flash respects reduced-flash', () => {
  const durationMs = 4000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 1, durationMs });
  fx.flashAlpha = 1; // force a hard flash regardless of the real birth schedule
  fx.reducedFlash = true;

  const { ctx, alphas } = alphaRecordingCtx();
  fx.draw(ctx, { width: 1280, height: 720 });

  assert.ok(alphas.length > 0, 'a nonzero flashAlpha should still draw something');
  for (const a of alphas) assert.ok(a <= FLASH_CAP + 1e-9, `alpha ${a} exceeds FLASH_CAP under reduced-flash`);
});

test('the terminal shatter flash respects reduced-flash, and is uncapped when the toggle is off', () => {
  const durationMs = 4000;
  const conductor = buildConductorWithKicks(durationMs);
  const fx = new FractureEngine(conductor, { canvasWidth: 1280, canvasHeight: 720, songSeed: 1, durationMs });
  fx.freezeFrame = {};
  fx.freezeMs = 0;
  fx._lastNowMs = 0;
  fx.flashAlpha = 1; // stronger than any real drawShatter flash ever reaches
  fx.reducedFlash = true;

  const capped = alphaRecordingCtx();
  fx.drawShatter(capped.ctx, { width: 1280, height: 720 });
  assert.ok(capped.alphas.length > 0, 'sanity: the flash fill should still have run');
  for (const a of capped.alphas) assert.ok(a <= FLASH_CAP + 1e-9, `alpha ${a} exceeds FLASH_CAP under reduced-flash`);

  fx.reducedFlash = false;
  const uncapped = alphaRecordingCtx();
  fx.drawShatter(uncapped.ctx, { width: 1280, height: 720 });
  assert.ok(uncapped.alphas.includes(1), 'with the toggle off, the raw alpha must pass through uncapped');
});
