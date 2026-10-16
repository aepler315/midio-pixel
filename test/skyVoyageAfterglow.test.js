// Midasus's sky-writing used to vanish the instant she left the sky, for two
// separate reasons:
//
//  1. On landing SkyVoyage did `this.trail = []`, so the figure she was still
//     writing was discarded in a single frame.
//  2. Frozen figures carry their own 15-second life (constellationLife01),
//     but drawDeepSky drew them below `if (voyage.depth <= 0.02) return;`,
//     so a figure only seconds old stopped drawing as soon as she re-entered.
//
// The landed trail now becomes an afterglow that fades over AFTERGLOW_SEC,
// and both it and the frozen figures draw whether or not she is away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import {
  AFTERGLOW_SEC, SkyVoyage, VoyagePhase, afterglowLife01,
} from '../src/sim/SkyVoyage.js';

const STEP_MS = 1000 / 120;

function advance(voyage, t, seconds, anchor = { x: 300, y: 200 }) {
  const steps = Math.round((seconds * 1000) / STEP_MS);
  for (let i = 0; i < steps; i++) {
    t += STEP_MS;
    voyage.update(t, STEP_MS / 1000, 0.5, anchor);
  }
  return t;
}

/** Fly one full voyage and return [voyage, t at landing]. */
function landedVoyage(seed = 2) {
  const v = new SkyVoyage(seed);
  let t = 1000;
  v.trigger(t, { x: 200, y: 400 }, 1280, 720);
  while (v.phase !== VoyagePhase.IDLE || t < 1500) t = advance(v, t, 0.05);
  return [v, t];
}

test('landing hands the unfinished trail to an afterglow instead of discarding it', () => {
  const [v] = landedVoyage();
  assert.equal(v.trail.length, 0, 'the live pen is still reset for the next voyage');
  assert.equal(v.afterglows.length, 1, 'but what she was writing is kept');
  assert.ok(v.afterglows[0].trail.length > 1, 'with the points she had drawn');
});

test('the afterglow fades out over AFTERGLOW_SEC and is then dropped', () => {
  const [v, landedAt] = landedVoyage();
  const bornMs = v.afterglows[0].bornMs;
  assert.equal(afterglowLife01(bornMs, bornMs), 1);
  const half = afterglowLife01(bornMs, bornMs + AFTERGLOW_SEC * 500);
  assert.ok(half > 0.3 && half < 0.7, `halfway it is half-faded, got ${half}`);
  assert.equal(afterglowLife01(bornMs, bornMs + AFTERGLOW_SEC * 1000), 0);

  let t = advance(v, landedAt, AFTERGLOW_SEC - 1);
  assert.equal(v.afterglows.length, 1, 'still there a second before the end');
  advance(v, t, 2);
  assert.equal(v.afterglows.length, 0, 'gone once fully faded');
});

function fakeManager() {
  const bm = Object.create(BiomeManager.prototype);
  bm.w = 1280; bm.h = 720; bm.reducedFlash = false; bm.tSec = 0;
  return bm;
}

function countingCtx() {
  const noop = () => {};
  const ctx = {
    strokes: 0, dots: 0,
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, fillRect: noop,
    stroke() { ctx.strokes++; }, fill() { ctx.dots++; }, arc: noop,
    set strokeStyle(_) {}, set fillStyle(_) {}, set lineWidth(_) {},
    set lineCap(_) {}, set lineJoin(_) {}, set globalCompositeOperation(_) {},
  };
  return ctx;
}

test('frozen figures and the afterglow still draw once she is home', () => {
  const v = new SkyVoyage(1);
  v.phase = VoyagePhase.IDLE;
  assert.equal(v.depth, 0, 'she is home, which used to stop all of this drawing');
  const pts = Array.from({ length: 12 }, (_, i) => ({ x: 400 + i * 4, y: 120 + i * 3 }));
  v.constellations = [{ points: pts, hue: 200, bornMs: 0 }];
  v.afterglows = [{ trail: pts.map((p) => ({ ...p, hue: 200, gap: false })), bornMs: 0 }];
  v.atlas = []; v.novae = [];

  const bm = fakeManager();
  bm.tSec = 3; // 3s into a 15s life: both should be clearly visible
  const ctx = countingCtx();
  bm.drawDeepSky(ctx, v, { width: 1280, height: 720 });
  assert.ok(ctx.dots >= pts.length, `the figure's stars draw (got ${ctx.dots})`);
  assert.ok(ctx.strokes >= 2 * (pts.length - 1), `its lines and the afterglow draw (got ${ctx.strokes})`);
});

test('nothing lingers past its life: a fully faded figure and afterglow draw nothing', () => {
  const v = new SkyVoyage(1);
  v.phase = VoyagePhase.IDLE;
  const pts = Array.from({ length: 6 }, (_, i) => ({ x: 400 + i * 4, y: 120 }));
  v.constellations = [{ points: pts, hue: 200, bornMs: 0 }];
  v.afterglows = [{ trail: pts.map((p) => ({ ...p, hue: 200, gap: false })), bornMs: 0 }];
  v.atlas = []; v.novae = [];
  const bm = fakeManager();
  bm.tSec = 60;
  const ctx = countingCtx();
  bm.drawDeepSky(ctx, v, { width: 1280, height: 720 });
  assert.equal(ctx.strokes + ctx.dots, 0);
});
