import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImpactFX } from '../src/sim/ImpactFX.js';

function fakeCtx2d() {
  const noop = () => {};
  const strokeAlphas = [];
  const compositeOps = [];
  const fillStyles = [];
  const gradientStops = [];
  let ellipseCalls = 0, arcCalls = 0, fillRectCalls = 0;
  return {
    strokeAlphas,
    compositeOps,
    fillStyles,
    gradientStops,
    get ellipseCalls() { return ellipseCalls; },
    get arcCalls() { return arcCalls; },
    get fillRectCalls() { return fillRectCalls; },
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    fillRect: () => { fillRectCalls++; }, ellipse: () => { ellipseCalls++; }, arc: () => { arcCalls++; },
    createRadialGradient() { return { addColorStop: (offset, color) => gradientStops.push(color) }; },
    set fillStyle(v) { fillStyles.push(v); },
    set lineWidth(v) {},
    set globalAlpha(v) {},
    set globalCompositeOperation(v) { compositeOps.push(v); },
    set strokeStyle(v) {
      const m = /rgba\([^,]+,[^,]+,[^,]+,([\d.]+)\)/.exec(v);
      if (m) strokeAlphas.push(parseFloat(m[1]));
    },
  };
}

test('trigger() never throws once the ring pool is exhausted', () => {
  const fx = new ImpactFX(1);
  // The ring pool caps at 16 (see ImpactFX.js constructor); each trigger()
  // spawns one ring, so the 17th call finds ObjectPool.spawn() returning
  // null and used to throw dereferencing ring.jitter.
  assert.doesNotThrow(() => {
    for (let i = 0; i < 40; i++) fx.trigger(i * 10, 500, 0.8, null);
  });
});

test('judgment() never throws once the ring pool is exhausted', () => {
  const fx = new ImpactFX(1);
  assert.doesNotThrow(() => {
    for (let i = 0; i < 40; i++) fx.judgment(i * 10, 500, 'perfect');
  });
});

test('judgment rings are never starved by a saturated landing-ring pool', () => {
  // Landing dust rings and judgment (verdict) rings used to share one
  // 16-slot pool, so a dense passage of landings could exhaust it and
  // silently drop the player's judgment ring feedback. They're now
  // separate pools -- saturating the landing pool must not stop a
  // judgment ring from spawning.
  const fx = new ImpactFX(1);
  for (let i = 0; i < 40; i++) fx.trigger(i * 10, 500, 0.8, null);
  assert.equal(fx.rings.active.length, 16, 'landing ring pool is saturated');

  fx.judgment(0, 500, 'perfect');
  assert.equal(fx.judgmentRings.active.length, 1, 'judgment ring still spawns despite the saturated landing pool');
});

test('landing rings are never starved by a saturated judgment-ring pool', () => {
  const fx = new ImpactFX(1);
  for (let i = 0; i < 40; i++) fx.judgment(i * 10, 500, 'perfect');
  assert.equal(fx.judgmentRings.active.length, 16, 'judgment ring pool is saturated');

  fx.trigger(0, 500, 0.8, null);
  assert.equal(fx.rings.active.length, 1, 'landing ring still spawns despite the saturated judgment pool');
});

test('draw() caps flash-heavy alpha (crater, dust ring, ignition) when reducedFlash is set', () => {
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 1, null);
  fx.ignite(0, 500);
  fx.step(0.01); // age the pools slightly off their alpha=peak initial frame

  const normalCtx = fakeCtx2d();
  fx.draw(normalCtx, 0, 0, false);
  const reducedCtx = fakeCtx2d();
  fx.draw(reducedCtx, 0, 0, true);

  assert.ok(normalCtx.strokeAlphas.length > 0, 'expected at least one stroked ring/ignition');
  const normalMax = Math.max(...normalCtx.strokeAlphas);
  const reducedMax = Math.max(...reducedCtx.strokeAlphas);
  assert.ok(reducedMax <= normalMax, 'reducedFlash must never exceed the normal alpha');
  assert.ok(reducedMax <= 0.4 + 1e-9, 'reducedFlash must cap alpha at the flash cap');
});

test('draw() renders judgment rings from their own pool alongside landing rings', () => {
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 0.3, null); // I <= 0.5 -- no star-polygon shockwave, isolating the two ring pools
  fx.judgment(0, 500, 'perfect');
  fx.step(0.01);

  const ctx = fakeCtx2d();
  fx.draw(ctx, 0, 0, false);
  // One stroke per ring (landing + judgment) -- strokeAlphas records one
  // entry per strokeStyle assignment, so both pools' rings show up here.
  assert.equal(ctx.strokeAlphas.length, 2, 'both the landing ring and the judgment ring are drawn');
});

test('draw() falls the ignition ring back to source-over compositing under reducedFlash', () => {
  // The ignition ring draws additively ('lighter'); on its own each capped
  // layer stays under FLASH_CAP, but overlapping additive layers (this ring
  // plus RippleFX's rings/pulses/puffs, all landing on the same ground
  // point) can still sum past it. Falling back to source-over is what
  // actually stops that stack, so assert the composite op itself changes.
  const fx = new ImpactFX(1);
  fx.ignite(0, 500);
  fx.step(0.01);

  const normalCtx = fakeCtx2d();
  fx.draw(normalCtx, 0, 0, false);
  assert.ok(normalCtx.compositeOps.includes('lighter'), 'normal draw uses additive compositing');

  const reducedCtx = fakeCtx2d();
  fx.draw(reducedCtx, 0, 0, true);
  assert.ok(!reducedCtx.compositeOps.includes('lighter'), 'reducedFlash must not use additive compositing');
  assert.ok(reducedCtx.compositeOps.includes('source-over'), 'reducedFlash falls back to source-over');
});

test('splat() thins its blob count under a lower particleMul', () => {
  // Previously splat() ignored particleMul entirely -- a shed device kept
  // full splat cost while trigger()/judgment() thinned by 40%.
  const full = new ImpactFX(3);
  full.splat(0, 500, 1);
  const shed = new ImpactFX(3);
  shed.splat(0, 500, 0.6);
  assert.ok(shed.splats.active[0].blobs.length < full.splats.active[0].blobs.length);
  assert.ok(shed.splats.active[0].blobs.length >= 2, 'never thins below a visible minimum');
});

test('trigger() tints the crater and landing dust with the given color', () => {
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 1, null, 1, '10,200,80');
  assert.equal(fx.craters.active[0].color, '10,200,80');
  for (const m of fx.motes.active) assert.equal(m.color, '10,200,80');
});

test('trigger() with no color falls back to the default warm-white, not a stale pooled color', () => {
  // ObjectPool reuses objects across spawns, so a crater/mote slot that
  // last served a colored landing must not leak that color into an
  // uncolored one -- color must be explicitly reset, not just omitted.
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 1, null, 1, '10,200,80');
  fx.step(1); // expire everything so the next trigger reuses the same pool slots
  fx.trigger(0, 500, 1, null, 1, null);
  assert.equal(fx.craters.active[0].color, null);
  for (const m of fx.motes.active) assert.equal(m.color, null);
});

test("judgment() and sputter() motes are never biome-tinted, even after a colored trigger()", () => {
  // The ring alone carries the verdict; a judgment/sputter mote reusing a
  // pool slot that last held a colored landing-dust mote must not inherit
  // that color.
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 1, null, 1, '10,200,80');
  fx.step(1);
  fx.judgment(0, 500, 'perfect');
  for (const m of fx.motes.active) assert.equal(m.color, null);
  fx.step(1);
  fx.sputter(0, 500, 1, 1);
  for (const m of fx.motes.active) assert.equal(m.color, null);
});

test('draw() renders the crater gradient and dust motes in the tinted color', () => {
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 1, null, 1, '10,200,80');
  fx.step(0.01);

  const ctx = fakeCtx2d();
  fx.draw(ctx, 0, 0, false);

  assert.ok(ctx.gradientStops.some((s) => s.startsWith('rgba(10,200,80,')), 'crater gradient uses the tinted color');
  assert.ok(ctx.fillStyles.some((s) => s === 'rgba(10,200,80,0.9)'), 'landing dust motes use the tinted color');
});

test('draw() falls back to the default warm-white when trigger() was given no color', () => {
  const fx = new ImpactFX(1);
  fx.trigger(0, 500, 1, null, 1, null);
  fx.step(0.01);

  const ctx = fakeCtx2d();
  fx.draw(ctx, 0, 0, false);

  assert.ok(ctx.gradientStops.some((s) => s.startsWith('rgba(255,240,200,')), 'crater gradient falls back to warm-white');
  assert.ok(ctx.fillStyles.some((s) => s === 'rgba(230,220,200,0.9)'), 'motes fall back to warm-white');
});

test('draw() culls craters, rings, motes, and splats/scars that have scrolled off-screen', () => {
  // During a fast passage a large share of these pools (400 motes, 60
  // scars, 20 splats...) can be well outside the visible frame; drawing
  // them every frame regardless is wasted cost.
  const canvasWidth = 800;

  const near = new ImpactFX(1);
  near.trigger(400, 500, 0.3, null); // I <= 0.5 -- no star-polygon shockwave
  near.splat(400, 500);
  near.step(0.01);

  const far = new ImpactFX(1);
  far.trigger(50000, 500, 0.3, null);
  far.splat(50000, 500);
  far.step(0.01);

  const nearCtx = fakeCtx2d();
  near.draw(nearCtx, 0, 0, false, canvasWidth);
  const farCtx = fakeCtx2d();
  far.draw(farCtx, 0, 0, false, canvasWidth);

  assert.ok(nearCtx.ellipseCalls > 0, 'on-screen crater should draw');
  assert.equal(farCtx.ellipseCalls, 0, 'off-screen crater should be culled');
  assert.ok(nearCtx.arcCalls > 0, 'on-screen motes should draw');
  assert.equal(farCtx.arcCalls, 0, 'off-screen motes should be culled');
  assert.ok(nearCtx.fillRectCalls > 0, 'on-screen scar/splat should draw');
  assert.equal(farCtx.fillRectCalls, 0, 'off-screen scar/splat should be culled');
  assert.ok(nearCtx.strokeAlphas.length > 0, 'on-screen ring should draw');
  assert.equal(farCtx.strokeAlphas.length, 0, 'off-screen ring should be culled');
});

test('draw() with no canvasWidth given draws everything regardless of scroll distance', () => {
  const fx = new ImpactFX(1);
  fx.trigger(50000, 500, 0.3, null);
  fx.step(0.01);
  const ctx = fakeCtx2d();
  fx.draw(ctx, 0, 0, false); // canvasWidth omitted -- defaults to Infinity
  assert.ok(ctx.ellipseCalls > 0);
  assert.ok(ctx.arcCalls > 0);
});

test('sputter() accumulates motes slower under a lower particleMul', () => {
  // Previously the telegraph sputter ran at a fixed rate regardless of perf
  // level -- the ambient effect keeping full spawn rate while the landing
  // burst it surrounds thinned out is exactly backwards.
  const full = new ImpactFX(4);
  full.sputter(0, 500, 1, 1); // 1 sim-second at full rate
  const fullCount = full.motes.active.length;

  const shed = new ImpactFX(4);
  shed.sputter(0, 500, 1, 0.6);
  const shedCount = shed.motes.active.length;

  assert.ok(shedCount < fullCount, `shed sputter (${shedCount}) should spawn fewer motes than full (${fullCount})`);
});
