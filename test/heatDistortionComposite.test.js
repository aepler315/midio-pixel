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

for (const kind of ['alpine', 'unregistered-kind']) {
  test(`WP12 ${kind} landscape drop heat has no invisible performer origin`, () => {
    const sim = { ...makeSim(), presentation: resolveLandscapePresentation({ kind }),
      biomes: { world: { kind }, currentFxAlpha: () => 0 } };
    const blits = [], ctx = makeCtx(blits), self = { _heatCanvas: makeHeatCanvas() };
    const canvas = { width: 1280, height: 720 };
    Renderer.prototype._drawHeatDistortion.call(self, ctx, canvas, sim, { midioDrawX: 300 }, canvas);
    assert.equal(blits.length, 0, 'retired actor does not own landscape heat');
  });
}

// The wildfire is painted only by BiomeManager.drawForeground, which returns
// early for alpine worlds: Landscape and Trio never show the fire, so its heat
// haze would bend light over nothing.
test('wildfire heat warps only worlds that draw the fire', () => {
  const canvas = { width: 1280, height: 720 };
  const run = kind => {
    const sim = { ...makeSim(), hype: null, presentation: resolveLandscapePresentation({ kind }),
      biomes: { world: { kind }, currentFxAlpha: () => 0 }, fire: { active: true, intensity01: 1 } };
    const blits = [];
    Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, makeCtx(blits), canvas, sim,
      { midioDrawX: 300 }, canvas);
    return blits.length;
  };
  assert.equal(run('alpine'), 0, 'an alpine wildfire is never drawn, so it casts no heat');
  assert.ok(run('unregistered-kind') > 10, 'a visible wildfire keeps its heat haze');
});

test('EMBER haze still warps an alpine world with its own visible owner', () => {
  const blits = [];
  const sim = { ...makeSim(), hype: null, presentation: { performers: false },
    biomes: { world: { kind: 'alpine' }, currentFxAlpha: () => 1 } };
  Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, makeCtx(blits),
    { width: 1280, height: 720 }, sim, { midioDrawX: 300 }, { width: 1280, height: 720 });
  assert.ok(blits.length > 10);
});

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

test('a Trio drop warps the alpine frame from Midio; Landscape, with no performer, stays unwarped', () => {
  const lens = presentation => {
    const blits = [];
    const ctx = makeCtx([]);
    ctx.drawImage = (_src, sx, sy, sw, sh, dx, dy) => blits.push({ cx: sx + sw / 2, cy: sy + sh / 2, ox: dx - sx, oy: dy - sy });
    const sim = { ...makeSim(), presentation, biomes: { world: { kind: 'alpine' }, currentFxAlpha: () => 0 },
      // Trio: Midio wandered off the origin; the lens sits on the ground under him.
      trio: { midio: { groundY: 600, y: 120 } } };
    Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, ctx,
      { width: 1280, height: 720 }, sim, { midioDrawX: 700 }, { width: 1280, height: 720 });
    return blits;
  };
  const trio = lens(resolveLandscapePresentation({ kind: 'alpine', experience: 'trio' }));
  assert.ok(trio.length > 10, 'the drop lens runs in Trio');
  // Radial: every offset points along the line from (midioDrawX, Midio's ground).
  for (const b of trio) {
    const dx = b.cx - 700, dy = b.cy - 600, cross = dx * b.oy - dy * b.ox;
    assert.ok(Math.abs(cross) < 1e-6 * Math.max(1, Math.hypot(dx, dy) * Math.hypot(b.ox, b.oy)),
      `cell (${b.cx},${b.cy}) is pushed radially from Midio's ground`);
  }
  assert.equal(lens(resolveLandscapePresentation({ kind: 'alpine' })).length, 0, 'Landscape has no performer');
});

// An active wildfire keeps the animated whole-frame warp running at any
// time, not only on a drop.
test('heat warp shimmers under an active wildfire at any time', () => {
  const sweep = (timeMs) => {
    const blits = [];
    const sim = { ...makeSim(), hype: null, fire: { active: true, intensity01: 1 }, timeMs };
    Renderer.prototype._drawHeatDistortion.call({ _heatCanvas: makeHeatCanvas() }, makeCtx(blits),
      { width: 1280, height: 720 }, sim, { midioDrawX: 300 }, { width: 1280, height: 720 });
    return blits.length;
  };
  for (const t of [1000, 1730]) {
    assert.ok(sweep(t) > 10, `t=${t}: the shimmer runs`);
  }
});
