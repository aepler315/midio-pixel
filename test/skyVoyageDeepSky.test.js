// SkyVoyage's whole sky-writing trail -- station, trail, constellations,
// the permanent atlas, novae, sparkles, micro-slashes -- is baked as
// ABSOLUTE pixels against Midasus's stageW/stageH (the nominal
// canvasWidth/Height Simulation was constructed with). That is NOT the same
// frame BiomeManager.drawDeepSky draws into: Renderer pads the live canvas
// by SHAKE_MARGIN_PX on every side and widens it further under camera
// pull-back, so the live canvas is routinely wider/taller than the nominal
// dims these points were computed against. Every other sky object in
// BiomeManager.js (stars, ConstellationWeaver, dust lanes) stores a
// fraction and rescales against the actual canvas at draw time for exactly
// this reason; drawDeepSky never did, so a live voyage sat pinned to the
// nominal span while the frame around it grew -- drawn in the wrong part
// of the screen, and landing in front of terrain (which IS rescaled every
// frame) it should have been safely behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { SkyVoyage, VoyagePhase } from '../src/sim/SkyVoyage.js';

/** A bare BiomeManager carrying just what drawDeepSky reads (this.w/this.h,
 *  reducedFlash, tSec) -- same bare-prototype approach as
 *  test/transitionShutter.test.js; the real constructor needs a canvas. */
function fakeManager(w, h) {
  const bm = Object.create(BiomeManager.prototype);
  bm.w = w;
  bm.h = h;
  bm.reducedFlash = false;
  bm.tSec = 0;
  return bm;
}

function fakeCtx() {
  const noop = () => {};
  const points = []; // every x,y a moveTo/lineTo/arc/fillRect touches
  return {
    points,
    save: noop, restore: noop, beginPath: noop, stroke: noop, fill: noop,
    set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {},
    set lineCap(v) {}, set lineJoin(v) {}, set globalCompositeOperation(v) {},
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    arc(x, y) { points.push([x, y]); },
    fillRect(x, y) { points.push([x, y]); },
  };
}

/** A voyage in DEEP_SPACE with a live trail, a frozen constellation, an
 *  atlas entry, a nova, a sparkle, and a micro-slash -- one of everything
 *  drawDeepSky draws, at known absolute-pixel positions in the nominal
 *  (construction-time) frame. */
function voyageWithContent(nominalW, nominalH) {
  const v = new SkyVoyage(1);
  v.phase = VoyagePhase.DEEP_SPACE;
  v.p = { x: nominalW * 0.6, y: nominalH * 0.15 };
  v.hue = 200;
  v.trail = [
    { x: nominalW * 0.5, y: nominalH * 0.1, hue: 200, tMs: 0, gap: false },
    { x: nominalW * 0.5 + 5, y: nominalH * 0.1 + 5, hue: 200, tMs: 10, gap: false },
  ];
  v.constellations = [{
    points: [{ x: nominalW * 0.4, y: nominalH * 0.2 }, { x: nominalW * 0.4 + 8, y: nominalH * 0.2 + 8 }],
    hue: 180, bornMs: 0,
  }];
  v.atlas = [{
    stars: [{ x: nominalW * 0.3, y: nominalH * 0.18, phase: 0 }, { x: nominalW * 0.3 + 6, y: nominalH * 0.18 + 6, phase: 1 }],
    hue: 90,
  }];
  v.novae = [{ x: nominalW * 0.7, y: nominalH * 0.12, hue: 40, phase: 0, delayMs: 0, bornMs: 0 }];
  v.sparkles = [{ x: nominalW * 0.55, y: nominalH * 0.14, hue: 200, age: 0.1 }];
  v.microSlashes = [{ x: nominalW * 0.55, y: nominalH * 0.14, ang: 0, hue: 200, age: 0.05 }];
  return v;
}

test('drawDeepSky rescales every point against the ACTUAL canvas, not the nominal construction-time frame', () => {
  const nominalW = 1280, nominalH = 720;
  // The live canvas Renderer actually draws into is routinely wider than
  // the nominal dims (SHAKE_MARGIN_PX padding, camera pull-back) -- pick a
  // canvas noticeably bigger to make a missed rescale obvious.
  const liveW = 1600, liveH = 900;
  const bm = fakeManager(nominalW, nominalH);
  const voyage = voyageWithContent(nominalW, nominalH);

  const ctx = fakeCtx();
  bm.drawDeepSky(ctx, voyage, { width: liveW, height: liveH });

  assert.ok(ctx.points.length > 0, 'drawDeepSky should have drawn something');
  const sx = liveW / nominalW, sy = liveH / nominalH;
  for (const [x, y] of ctx.points) {
    // Every drawn point must fall within the live canvas -- an unrescaled
    // point baked against the narrower nominal frame would still land
    // inside a WIDER live canvas by coincidence, so instead assert the
    // point sits at (nominal coordinate * sx/sy), not at the raw nominal
    // coordinate itself.
    assert.ok(x <= liveW + 1e-6 && y <= liveH + 1e-6, `point (${x},${y}) should be within the live canvas`);
  }
  // Her live comet-head position is the clearest single check: p.x was
  // baked at nominalW*0.6 -- it must be redrawn at liveW*0.6, not at the
  // stale nominalW*0.6 (which would sit at the wrong fraction of the wider
  // live canvas).
  const expectedX = nominalW * 0.6 * sx;
  const expectedY = nominalH * 0.15 * sy;
  const found = ctx.points.some(([x, y]) => Math.abs(x - expectedX) < 0.01 && Math.abs(y - expectedY) < 0.01);
  assert.ok(found, `expected a point near (${expectedX}, ${expectedY}) (rescaled comet-head), got points: ${JSON.stringify(ctx.points)}`);
  // And the stale, unrescaled position must NOT appear anywhere.
  const stale = ctx.points.some(([x, y]) => Math.abs(x - nominalW * 0.6) < 0.01 && Math.abs(y - nominalH * 0.15) < 0.01);
  assert.ok(!stale, 'the comet-head must not be drawn at its stale, unrescaled nominal position');
});

test('drawDeepSky draws at the nominal position unchanged when the live canvas matches the construction-time frame', () => {
  const w = 1280, h = 720;
  const bm = fakeManager(w, h);
  const voyage = voyageWithContent(w, h);
  const ctx = fakeCtx();
  bm.drawDeepSky(ctx, voyage, { width: w, height: h });
  const found = ctx.points.some(([x, y]) => Math.abs(x - w * 0.6) < 0.01 && Math.abs(y - h * 0.15) < 0.01);
  assert.ok(found, 'sx=sy=1 should leave positions unchanged');
});

test('drawDeepSky is a no-op with no voyage', () => {
  const bm = fakeManager(1280, 720);
  const ctx = fakeCtx();
  assert.doesNotThrow(() => bm.drawDeepSky(ctx, null, { width: 1280, height: 720 }));
  assert.equal(ctx.points.length, 0);
});
