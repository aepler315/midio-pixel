// Ridge shading flicker: _drawRidgeVolume's catchlight/shade gradients used
// to anchor their top stop to `crestY`, a live global extremum over a ridge
// that dances and scrolls every frame (see _crestPoints -- "moves every
// frame"). The exact same failure mode was already diagnosed and fixed for
// the snow line by anchoring to `bakedCrestY` instead; the shading gradients
// never got the same fix, so the "shadow" on every ridge face wobbled up
// and down with the dance -- reported as flickering shadow artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfGovernor, MAX_LEVEL } from '../src/render/PerfGovernor.js';

globalThis.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
};

class RecordingCtx {
  constructor() {
    this.gradients = []; // [{x0,y0,x1,y1}]
    this._fillStyle = null;
    this._globalCompositeOperation = 'source-over';
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; }
  get globalCompositeOperation() { return this._globalCompositeOperation; }
  set globalCompositeOperation(v) { this._globalCompositeOperation = v; }
  set strokeStyle(v) {} set globalAlpha(v) {} set lineWidth(v) {} set lineJoin(v) {}
  set lineCap(v) {}
  createLinearGradient(x0, y0, x1, y1) {
    this.gradients.push({ x0, y0, x1, y1 });
    const stops = [];
    return { stops, addColorStop: (offset, color) => stops.push({ offset, color }) };
  }
  createRadialGradient() { return this.createLinearGradient(0, 0, 0, 0); }
  beginPath() {} moveTo() {} lineTo() {} closePath() {} fill() {} stroke() {}
  save() {} restore() {} clip() {} rect() {} arc() {} ellipse() {}
  quadraticCurveTo() {} bezierCurveTo() {} translate() {} rotate() {} scale() {}
  drawImage() {} fillRect() {} clearRect() {} strokeRect() {}
}

function makeStrip({ width = 2048, step = 4, height = 320, phase = 0 } = {}) {
  const n = Math.floor(width / step) + 1;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = Math.sin(i * 0.05 + phase) * 0.5 + Math.sin(i * 0.13 + 1.7 + phase) * 0.3;
  const blendCount = Math.max(1, Math.floor(n * 0.12));
  for (let i = 0; i < blendCount; i++) {
    const idx = n - blendCount + i;
    const t = i / blendCount;
    const tt = t * t * (3 - 2 * t);
    heights[idx] = heights[idx] * (1 - tt) + heights[0] * tt;
  }
  return { width, height, ridge: { heights, step, baseline: 0.70, amplitude: 0.34, height } };
}

async function makeManager() {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm._crestCache = new Map();
  bm._danceKickMs = -Infinity;
  bm._danceKickAmp = 0;
  bm.orogenyGrowth = 0;
  bm.pullback01 = 0;
  bm._danceGroove = 0.4;
  bm._danceSustain = 0.3;
  bm._eqSmoothed = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  bm._geoFeatures = [];
  bm._perf = null; // heavyPostFx / danceColumnWidth defaults
  bm.groundY = 400;
  bm.h = 540;
  bm._airColor = null; // skip the aerial-perspective fill, irrelevant here
  return bm;
}

const canvas = { width: 960, height: 540 };

test('far-ridge cache follows sibling relief even when bitmap heights match', async () => {
  const bm = await makeManager();
  bm.tSec = 0;
  const strip = makeStrip({ height: 140 });
  const low = makeStrip({ height: 320 });
  const high = makeStrip({ height: 320 });
  low.ridge.heights.fill(0);
  high.ridge.heights.fill(1);
  bm._heightStrips = { L3: low, L4: low, L5: low };
  const a = bm._crestPoints(canvas, strip, 0, 0, 'L2', 1, 1);
  bm._heightStrips = { L3: high, L4: high, L5: high };
  const b = bm._crestPoints(canvas, strip, 0, 0, 'L2', 1, 1);
  assert.ok(b.dh > a.dh, `new relief must lift the far ridge: ${a.dh} -> ${b.dh}`);
  assert.equal(b.dh, bm._rangeDh(canvas, strip, 'L2', 1, false));
  assert.strictEqual(bm._crestPoints(canvas, strip, 0, 0, 'L2', 1, 1), b);
});

test('the ridge-volume shading gradient anchors to a stable summit, not the live dancing crest', async () => {
  const strip = makeStrip({ phase: 0 });
  const bm1 = await makeManager();
  bm1.tSec = 3; // one moment in the dance
  const ctx1 = new RecordingCtx();
  bm1._drawRidgeVolume(ctx1, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1);

  const bm2 = await makeManager();
  bm2.tSec = 11.7; // a very different moment -- the live crest column shifts
  const ctx2 = new RecordingCtx();
  bm2._drawRidgeVolume(ctx2, canvas, strip, 640, 0, 'L2', 1, 1, 1, 1); // also scrolled

  assert.ok(ctx1.gradients.length >= 2, 'expected the catchlight + shade gradients');
  assert.ok(ctx2.gradients.length >= 2);

  const top1 = ctx1.gradients[0].y0;
  const top2 = ctx2.gradients[0].y0;
  assert.ok(
    Math.abs(top1 - top2) < 0.01,
    `shading gradient's top anchor moved between two dance/scroll states (${top1.toFixed(2)} vs ${top2.toFixed(2)}) -- this is the flicker`,
  );
  // And it must equal the strip's own baked (dance-free) summit, not just
  // coincidentally agree between two live samples.
  const geom = bm1._crestPoints(canvas, strip, 0, 0, 'L2', 1, 1);
  assert.ok(Math.abs(top1 - geom.bakedCrestY) < 0.01, 'the anchor should be bakedCrestY, not a live extremum');
});

test('the shading gradient still bottoms out at the range foot (bottomY), unaffected by the fix', async () => {
  const strip = makeStrip({ phase: 0 });
  const bm = await makeManager();
  bm.tSec = 3;
  const ctx = new RecordingCtx();
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1);
  const geom = bm._crestPoints(canvas, strip, 0, 0, 'L2', 1, 1);
  for (const g of ctx.gradients.slice(0, 2)) {
    assert.ok(Math.abs(g.y1 - geom.bottomY) < 0.01);
  }
});

// PerfGovernor.ridgeShadingFull: _drawRidgeVolume never had a shed lever of
// its own -- danceColumnWidth already thins _crestPoints' geometry, but the
// gradient fills themselves (up to 3 per layer, every frame) ran in full
// regardless of governor level. A device still over budget at MAX_LEVEL had
// nothing left to give here. These pin the new gate: catchlight (the fix
// for the original "flat, hard to read" silhouette) is never removed; only
// the shade and aerial-perspective passes -- real cost, but genuinely
// extra on top of catchlight -- drop out when the gate is off.
//
// Real PerfGovernor instances, not hand-rolled partial mocks: _drawShoulders
// a little below reads its OWN pre-existing gate (heavyPostFx, which also
// happens to flip at MAX_LEVEL) -- a partial mock naming only the fields a
// test cares about silently reads every other gate as off, which is not
// what "no perf at all" or "one specific rung" actually mean in production.
// Both instances below are built at the SAME level for that reason (so
// colW, heavyPostFx, phenomenaFull etc. all match) and differ ONLY in
// ridgeShadingFull, via a plain property override -- shadowing the getter
// is enough since assert.equal reads the instance, not the prototype.
test('ridgeShadingFull off drops exactly the shade and aerial passes, keeping catchlight', async () => {
  const strip = makeStrip({ phase: 0 });

  const bmOff = await makeManager();
  bmOff.world = { kind: 'unregistered-kind' };
  bmOff.tSec = 3;
  bmOff._airColor = '#88aacc'; // a real air color, so the aerial pass would be live
  bmOff._perf = new PerfGovernor({ startLevel: MAX_LEVEL });
  const ctxOff = new RecordingCtx();
  bmOff._drawRidgeVolume(ctxOff, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1);

  const bmOn = await makeManager();
  bmOn.world = { kind: 'unregistered-kind' };
  bmOn.tSec = 3;
  bmOn._airColor = '#88aacc';
  bmOn._perf = new PerfGovernor({ startLevel: MAX_LEVEL });
  // ridgeShadingFull is a getter with no setter; a plain assignment would
  // throw in strict mode (a module always is). Shadow it with an own
  // property instead -- the one thing this test varies.
  Object.defineProperty(bmOn._perf, 'ridgeShadingFull', { value: true });
  const ctxOn = new RecordingCtx();
  bmOn._drawRidgeVolume(ctxOn, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1); // L2: AERIAL_PULL 0.46

  assert.equal(bmOff._perf.ridgeShadingFull, false, 'test setup: MAX_LEVEL should already read false');
  assert.equal(
    ctxOn.gradients.length - ctxOff.gradients.length, 2,
    'exactly two extra gradients (shade + aerial) when the gate is on',
  );
  assert.equal(ctxOff.gradients.length, 1, 'catchlight alone when the gate is off (shoulders also shed at MAX_LEVEL)');
});

test('no perf object at all reads every rung, including ridgeShadingFull, as full quality', async () => {
  // The title-screen backdrop and any caller that predates PerfGovernor
  // draw with no `_perf` at all -- that must behave like a fresh, level-0
  // governor, not silently lose the shade/aerial passes just because perf
  // is absent.
  const strip = makeStrip({ phase: 0 });

  const bmFreshGovernor = await makeManager();
  bmFreshGovernor.world = { kind: 'unregistered-kind' };
  bmFreshGovernor.tSec = 3;
  bmFreshGovernor._airColor = '#88aacc';
  bmFreshGovernor._perf = new PerfGovernor(); // level 0
  const ctxFreshGovernor = new RecordingCtx();
  bmFreshGovernor._drawRidgeVolume(ctxFreshGovernor, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1);

  const bmNoPerf = await makeManager();
  bmNoPerf.world = { kind: 'unregistered-kind' };
  bmNoPerf.tSec = 3;
  bmNoPerf._airColor = '#88aacc';
  const ctxNoPerf = new RecordingCtx();
  bmNoPerf._drawRidgeVolume(ctxNoPerf, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1);

  assert.equal(ctxNoPerf.gradients.length, ctxFreshGovernor.gradients.length, 'no perf at all reads as full quality');
  assert.ok(ctxNoPerf.gradients.length >= 3, 'sanity: catchlight + shade + aerial actually fired here');
});

test('ridgeShadingFull off still leaves the catchlight gradient anchored correctly', async () => {
  // The bakedCrestY-anchoring fix above must survive the new gate: shedding
  // the shade/aerial passes must not also perturb the one pass that stays.
  const strip = makeStrip({ phase: 0 });
  const bm = await makeManager();
  bm.tSec = 3;
  bm._perf = new PerfGovernor({ startLevel: MAX_LEVEL });
  const ctx = new RecordingCtx();
  bm._drawRidgeVolume(ctx, canvas, strip, 0, 0, 'L2', 1, 1, 1, 1);
  const geom = bm._crestPoints(canvas, strip, 0, 0, 'L2', 1, 1);
  assert.equal(ctx.gradients.length, 1, 'no air color set here, so only catchlight was ever going to fire');
  assert.ok(Math.abs(ctx.gradients[0].y0 - geom.bakedCrestY) < 0.01);
  assert.ok(Math.abs(ctx.gradients[0].y1 - geom.bottomY) < 0.01);
});

test('scanned foreground remains below a fixed screen envelope as mountains grow', async () => {
  const bm = await makeManager();
  bm.world = { kind: 'alpine' };
  const strip = makeStrip({ height: 1000 });
  strip.ridge.source = 'terrain';
  for (const growth of [0, 0.5, 1]) {
    bm.orogenyGrowth = growth;
    assert.ok(bm._rangeDh(canvas, strip, 'L3', 1, false) <= canvas.height * 0.42);
    assert.ok(bm._rangeDh(canvas, strip, 'L4', 1, false) <= canvas.height * 0.30);
  }
  assert.ok(bm._rangeDh(canvas, strip, 'L4', 1, true) > canvas.height * 0.30, 'terrain preview retains scale');
});

test('far anchor uses the capped foreground heights', async () => {
  const bm = await makeManager();
  bm.world = { kind: 'alpine' };
  const far = makeStrip({ height: 140 });
  const front = makeStrip({ height: 1000 });
  front.ridge.source = 'terrain';
  bm._heightStrips = { L2: far, L3: front, L4: front };
  const before = bm._rangeDh(canvas, far, 'L2', 1, false);
  const taller = makeStrip({ height: 2000 });
  taller.ridge.source = 'terrain';
  bm._heightStrips = { L2: far, L3: taller, L4: taller };
  assert.equal(bm._rangeDh(canvas, far, 'L2', 1, false), before,
    'invisible height beyond the foreground cap must not inflate the back ridge');
});
