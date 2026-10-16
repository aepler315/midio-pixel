import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';
import { resolveLandscapePresentation } from '../src/world/LandscapePresentation.js';

// Composite operations that clear the destination OUTSIDE the region being
// drawn. In a loop that blits many small cells onto one canvas, any of these
// makes each cell erase every cell before it -- the finished frame keeps only
// the last blit. That shipped once as heat distortion using 'copy': measured
// in Chromium, 63 grid blits left 0.2% of the canvas opaque, which reads as a
// blank stage with only the DOM chrome still visible.
const DESTRUCTIVE_OPS = new Set([
  'copy', 'source-in', 'source-out', 'destination-in', 'destination-atop',
]);

/** Records the composite op in force at each drawImage onto the main canvas. */
function makeCtx(record) {
  return {
    globalCompositeOperation: 'source-over',
    _stack: [],
    save() { this._stack.push(this.globalCompositeOperation); },
    restore() { this.globalCompositeOperation = this._stack.pop() ?? 'source-over'; },
    drawImage() { record.push(this.globalCompositeOperation); },
  };
}

function makeHeatCanvas() {
  const inner = { globalCompositeOperation: 'source-over', drawImage() {} };
  return { width: 0, height: 0, getContext: () => inner };
}

/** A drop at full strength, biome/fire quiet -- enough to run the pass. */
function makeSim() {
  return {
    perf: { heavyPostFx: true },
    timeMs: 1000,
    hype: { dropAtMs: 1000 }, // dropImpactStrength peaks at 1 exactly at the drop
    biomes: { currentFxAlpha: () => 0 },
    fire: null,
    midio: { groundY: 625 },
    reducedFlash: false,
    presentation: { performers: true },
  };
}

function runPass() {
  const blitOps = [];
  const ctx = makeCtx(blitOps);
  const canvas = { width: 1280, height: 720 };
  const self = { _heatCanvas: makeHeatCanvas() };
  Renderer.prototype._drawHeatDistortion.call(
    self, ctx, canvas, makeSim(), { midioDrawX: 300 }, { width: 1280, height: 720 },
  );
  return { blitOps, ctx };
}

test('heat distortion actually blits the frame back through its warp grid', () => {
  const { blitOps } = runPass();
  assert.ok(blitOps.length > 10, `expected a grid of blits, got ${blitOps.length}`);
});

for (const kind of ['city', 'foundry', 'strip']) {
  test(`WP12 ${kind} landscape drop heat has no invisible performer origin, ambient fire remains`, () => {
    const sim = { ...makeSim(), presentation: resolveLandscapePresentation({ kind }),
      biomes: { world: { kind }, currentFxAlpha: () => 0 } };
    const blits = [], ctx = makeCtx(blits), self = { _heatCanvas: makeHeatCanvas() };
    const canvas = { width: 1280, height: 720 };
    Renderer.prototype._drawHeatDistortion.call(self, ctx, canvas, sim, { midioDrawX: 300 }, canvas);
    assert.equal(blits.length, 0, 'retired actor does not own landscape heat');
    sim.fire = { active: true, intensity01: 1 };
    Renderer.prototype._drawHeatDistortion.call(self, ctx, canvas, sim, { midioDrawX: 300 }, canvas);
    assert.ok(blits.length > 10, 'physical ambient heat stays visible');
  });
}

test('heat distortion never blits cells under a destructive composite op', () => {
  const { blitOps } = runPass();
  for (const op of blitOps) {
    assert.ok(
      !DESTRUCTIVE_OPS.has(op),
      `a per-cell blit ran under '${op}', which discards the rest of the canvas -- `
      + 'every earlier cell is erased and the frame ends up blank',
    );
  }
});

test('heat distortion leaves the composite op as it found it', () => {
  const { ctx } = runPass();
  assert.equal(ctx.globalCompositeOperation, 'source-over');
});

test('heat distortion sheds entirely when the perf governor has cut heavy post-FX', () => {
  const blitOps = [];
  const ctx = makeCtx(blitOps);
  const sim = makeSim();
  sim.perf = { heavyPostFx: false };
  Renderer.prototype._drawHeatDistortion.call(
    { _heatCanvas: makeHeatCanvas() }, ctx, { width: 1280, height: 720 }, sim,
    { midioDrawX: 300 }, { width: 1280, height: 720 },
  );
  assert.equal(blitOps.length, 0);
});

for (const [height, groundY] of [[720, 616], [1440, 308]]) {
  test(`ambient heat grows toward the ground in backing-store coordinates (${height}px)`, () => {
    // Both configurations put the ground at physical y=616. Measure maxima
    // over time to separate the spatial envelope from the oscillation phase.
    const canvas = { width: 112, height };
    const self = { _heatCanvas: makeHeatCanvas() };
    const maxima = new Map();
    const ctx = makeCtx([]);
    ctx.drawImage = (_src, sx, sy, sw, sh, dx) => {
      if (sx !== -6) return; // first grid column
      const cy = sy + sh / 2;
      maxima.set(cy, Math.max(maxima.get(cy) || 0, Math.abs(dx - sx)));
    };
    const sim = { ...makeSim(), hype: null, fire: { active: true, intensity01: 1 }, midio: { groundY } };
    for (let i = 0; i < 160; i++) {
      sim.timeMs = i * 25;
      Renderer.prototype._drawHeatDistortion.call(self, ctx, canvas, sim,
        { midioDrawX: 50 }, { width: 112, height: 720 });
    }
    const upper = maxima.get(28), middle = maxima.get(308), lower = maxima.get(644);
    assert.ok(lower > upper * 2, `ground ${lower} should be stronger than upper sky ${upper}`);
    assert.ok(Math.abs(middle - 0.945) < 0.005, `halfway to ground has 67.5% amplitude, got ${middle}`);
    assert.ok(Math.abs(lower - 1.4) < 0.005, `ground reaches full ambient amplitude, got ${lower}`);
    assert.ok(maxima.get(700) <= 1.4 + 1e-9, 'below-ground cells stay bounded');
  });
}

test('portrait output heat grid and shock origin use the fitted picture offsets', () => {
  const blits = [];
  const ctx = makeCtx([]);
  ctx.drawImage = (_src, sx, sy, sw, sh, dx, dy) => blits.push({ sx, sy, dx, dy });
  Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, ctx,
    { width: 560, height: 960 }, makeSim(), { midioDrawX: 300 }, { width: 1280, height: 720 },
    { x: 10, y: 328.125, width: 540, height: 303.75 });
  const first = blits[0];
  assert.equal(first.sx, 4, 'first source cell starts six pixels before the picture');
  assert.equal(first.sy, 322.125);
  assert.ok(blits.every(b => b.sy >= 322.125 && b.sy < 632), 'grid excludes the large portrait bars');
  // First cell centre (38,356.125); fitted shock centre (136.5625,591.796875).
  const dx = -98.5625, dy = -235.671875, dist = Math.hypot(dx, dy);
  const radial = Math.sin(dist * .05 - 9) * 5;
  assert.ok(Math.abs(first.dx - first.sx - radial * dx / dist) < 1e-9);
  assert.ok(Math.abs(first.dy - first.sy - radial * dy / dist) < 1e-9);
});

test('a drop leaves the Range unwarped: there is no performer to radiate from', () => {
  const blits = [];
  const sim = makeSim();
  sim.biomes = { ...sim.biomes, world: { kind: 'alpine' } };
  Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, makeCtx(blits),
    { width: 1280, height: 720 }, sim, { midioDrawX: 300 }, { width: 1280, height: 720 });
  assert.equal(blits.length, 0);
});

// A2: reduced motion removes the animated whole-frame warp at any time,
// under either flash setting; reduced flash alone keeps a halved shimmer.
test('heat warp honours reduced motion and reduced flash independently', () => {
  const sweep = (reducedFlash, reducedMotion, timeMs) => {
    const blits = [];
    const ctx = makeCtx([]);
    let maxShift = 0;
    ctx.drawImage = (_src, sx, sy, _sw, _sh, dx, dy) => { blits.push(1); maxShift = Math.max(maxShift, Math.hypot(dx - sx, dy - sy)); };
    const sim = { ...makeSim(), hype: null, fire: { active: true, intensity01: 1 }, reducedFlash, reducedMotion, timeMs };
    Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, ctx,
      { width: 1280, height: 720 }, sim, { midioDrawX: 300 }, { width: 1280, height: 720 });
    return { blits: blits.length, maxShift };
  };
  for (const t of [1000, 1730]) {
    const normal = sweep(false, false, t), flash = sweep(true, false, t);
    assert.ok(normal.blits > 10 && flash.blits > 10, `t=${t}: shimmer runs without reduced motion`);
    assert.ok(flash.maxShift < normal.maxShift, `t=${t}: reduced flash halves the shove`);
    for (const reducedFlash of [false, true]) {
      assert.equal(sweep(reducedFlash, true, t).blits, 0, `t=${t}, flash=${reducedFlash}: no animated resampling under reduced motion`);
    }
  }
});
