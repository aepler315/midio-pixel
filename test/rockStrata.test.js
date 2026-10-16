// Sedimentary beds in the mountain faces: thin multiply bands, L2/L3 only
// (L4 already carries GeoCrest + shoulders, L5 is rolling hills), gated on
// heavyPostFx.
//
// These bands were originally traced from the crest polyline and offset
// downward, which drew a contour map -- every band exactly parallel to the
// summit above it -- and made the ranges read as topographic wallpaper. They
// are now near-horizontal beds (RockStrata.js) that the range's own
// silhouette truncates via the clip _drawRidgeVolume already establishes.
// The draw-level tests below are unchanged by that (they count multiply
// fills, which is still the right question); the geometry tests at the bottom
// pin the properties the rewrite turns on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strataBeds, bedOffsetAt } from '../src/world/RockStrata.js';

globalThis.Path2D = class Path2D {
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {}
};

class RecordingCtx {
  constructor() {
    this.fillCalls = 0;
    this.multiplyFillCalls = 0;
    this._fillStyle = null;
    this._globalCompositeOperation = 'source-over';
  }
  get fillStyle() { return this._fillStyle; }
  set fillStyle(v) { this._fillStyle = v; }
  get globalCompositeOperation() { return this._globalCompositeOperation; }
  set globalCompositeOperation(v) { this._globalCompositeOperation = v; }
  set strokeStyle(v) {} set globalAlpha(v) {} set lineWidth(v) {} set lineJoin(v) {}
  set lineCap(v) {}
  createLinearGradient() {
    const stops = [];
    return { stops, addColorStop: (offset, color) => stops.push({ offset, color }) };
  }
  createRadialGradient() { return this.createLinearGradient(); }
  beginPath() {} moveTo() {} lineTo() {} closePath() {} stroke() {}
  fill() {
    this.fillCalls++;
    if (this._globalCompositeOperation === 'multiply') this.multiplyFillCalls++;
  }
  save() {} restore() {} clip() {} rect() {} arc() {} ellipse() {}
  quadraticCurveTo() {} bezierCurveTo() {} translate() {} rotate() {} scale() {}
  drawImage() {} fillRect() {} clearRect() {} strokeRect() {}
}

function makeStrip({ width = 2048, step = 4, height = 320 } = {}) {
  const n = Math.floor(width / step) + 1;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = Math.sin(i * 0.05) * 0.5 + Math.sin(i * 0.13 + 1.7) * 0.3;
  const blendCount = Math.max(1, Math.floor(n * 0.12));
  for (let i = 0; i < blendCount; i++) {
    const idx = n - blendCount + i;
    const t = i / blendCount;
    const tt = t * t * (3 - 2 * t);
    heights[idx] = heights[idx] * (1 - tt) + heights[0] * tt;
  }
  return { width, height, ridge: { heights, step, baseline: 0.70, amplitude: 0.34, height } };
}

async function makeManager({ perf = null } = {}) {
  const { BiomeManager } = await import('../src/world/BiomeManager.js');
  const bm = Object.create(BiomeManager.prototype);
  bm._crestCache = new Map();
  bm.tSec = 3;
  bm._danceKickMs = -Infinity;
  bm._danceKickAmp = 0;
  bm.orogenyGrowth = 0;
  bm.pullback01 = 0;
  bm._danceGroove = 0.4;
  bm._danceSustain = 0.3;
  bm._eqSmoothed = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  bm._geoFeatures = [];
  bm._perf = perf;
  bm.groundY = 400;
  bm.h = 540;
  bm._airColor = null;
  bm.world = { kind: 'city' }; // Legacy strata still belong to non-alpine worlds.
  return bm;
}

const canvas = { width: 960, height: 540 };

test('L2 gets extra multiply-blended fills for its strata bands', async () => {
  const bm = await makeManager();
  const ctxNoPerf = new RecordingCtx();
  const strip = makeStrip();
  bm._drawRidgeVolume(ctxNoPerf, canvas, strip, 0, 40, 'L2', 1, 1, 1, 1);
  // Existing lit/shade passes also use gradients but only the shade pass
  // multiplies -- strata adds MORE multiply fills on top of that one.
  assert.ok(ctxNoPerf.multiplyFillCalls > 1, `expected strata to add multiply fills, got ${ctxNoPerf.multiplyFillCalls}`);
});

test('L5 (rolling hills) never gets strata bands', async () => {
  const bm = await makeManager();
  const withL2 = new RecordingCtx();
  const withL5 = new RecordingCtx();
  const strip = makeStrip();
  bm._drawRidgeVolume(withL2, canvas, strip, 0, 40, 'L2', 1, 1, 1, 1);
  bm._drawRidgeVolume(withL5, canvas, strip, 0, 40, 'L5', 1, 1, 1, 1);
  assert.ok(withL2.multiplyFillCalls > withL5.multiplyFillCalls, 'L2 should carry strictly more multiply fills than L5');
});

test('strata sheds on the heavyPostFx-off perf rung', async () => {
  const bmOn = await makeManager({ perf: { heavyPostFx: true } });
  const bmOff = await makeManager({ perf: { heavyPostFx: false } });
  const ctxOn = new RecordingCtx();
  const ctxOff = new RecordingCtx();
  const strip = makeStrip();
  bmOn._drawRidgeVolume(ctxOn, canvas, strip, 0, 40, 'L2', 1, 1, 1, 1);
  bmOff._drawRidgeVolume(ctxOff, canvas, strip, 0, 40, 'L2', 1, 1, 1, 1);
  assert.ok(ctxOn.multiplyFillCalls > ctxOff.multiplyFillCalls, 'strata (and shoulders) should shed when heavyPostFx is off');
});

test('never throws on a very short range (not enough span for any band)', async () => {
  const bm = await makeManager();
  const ctx = new RecordingCtx();
  const strip = makeStrip({ height: 20 });
  assert.doesNotThrow(() => bm._drawRidgeVolume(ctx, canvas, strip, 0, 40, 'L2', 1, 1, 1, 1));
});

// --- Bed geometry (RockStrata.js) ----------------------------------------

const bedsAt = (o = {}) => strataBeds({
  width: 960, crestY: 120, bottomY: 480, scrollX: 0, spacingPx: 34, ...o,
});

test('beds do not parallel the crest -- that was the contour-map bug', () => {
  // The whole defect: bands traced from the skyline are concentric copies of
  // it, which reads as a topographic map printed on the rock. A bed's shape
  // must therefore be independent of whatever the summit above it is doing.
  const flat = bedsAt();
  // Same range, same everything, asked twice: the bed is a function of x and
  // the range's foot only, so nothing about the crest can appear in it.
  const jagged = strataBeds({ width: 960, crestY: 40, bottomY: 480, spacingPx: 34 });
  const shared = Math.min(flat.length, jagged.length);
  assert.ok(shared >= 3, 'need a few beds to compare');
  for (let b = 0; b < shared; b++) {
    for (let i = 0; i < flat[b].pts.length; i++) {
      assert.equal(flat[b].pts[i].y, jagged[b].pts[i].y,
        `bed ${b} moved when only the crest changed -- it is tracking the skyline`);
    }
  }
});

test('rock does not breathe with the kick drum', () => {
  // Beds anchor upward from the range's FOOT, which is the stable edge. The
  // crest is deformed every frame by the dance; if beds anchored there, the
  // whole rock face would pump on every beat.
  const still = bedsAt({ crestY: 120 });
  const danced = bedsAt({ crestY: 96 }); // summit sharpened by a transient
  assert.equal(still.length, danced.length);
  for (let b = 0; b < still.length; b++) {
    assert.equal(still[b].y0, danced[b].y0);
  }
});

test('beds are near-horizontal, never a slanted stripe', () => {
  const beds = bedsAt();
  for (const bed of beds) {
    const ys = bed.pts.map((p) => p.y);
    const drop = Math.max(...ys) - Math.min(...ys);
    // Across a 960px width: dip plus fold. Much past this and it reads as a
    // diagonal band rather than as bedding.
    assert.ok(drop < 960 * 0.09, `bed at y0=${bed.y0} spanned ${drop.toFixed(1)}px vertically`);
    assert.ok(drop > 1, 'but not a perfectly straight ruler line either');
  }
});

test('dip reverses with dipSign, so neighbouring ranges are not one structure', () => {
  const down = bedsAt({ dipSign: 1 })[0].pts;
  const up = bedsAt({ dipSign: -1 })[0].pts;
  const slope = (p) => p[p.length - 1].y - p[0].y;
  assert.ok(Math.sign(slope(down)) !== Math.sign(slope(up)),
    'L2 and L3 should not dip the same way');
});

test('beds are planted in the world, not smeared across the screen', () => {
  // Same discipline as ConnectorHills.rollAt and DistantWave.swellAt: the
  // fold has to travel with the range's parallax, or the rock texture slides
  // over the mountain as the camera pans.
  const a = bedOffsetAt(0, 0, 0, 960);
  const b = bedOffsetAt(500, 0, 0, 960);
  assert.notEqual(a, b, 'the fold must depend on world x');
  // With no dip, offset is purely the fold, so it is periodic in world x
  // and independent of where on screen the sample happens to fall.
  assert.equal(bedOffsetAt(123, 0, 0, 960), bedOffsetAt(123, 400, 0, 960));
});

test('alternating competence: beds are not a uniform comb', () => {
  const tones = bedsAt().map((b) => b.tone);
  assert.ok(new Set(tones.map((t) => t.toFixed(3))).size > 1,
    'every bed the same darkness is the other way to read as wallpaper');
  for (const t of tones) assert.ok(t >= 0 && t <= 1, `tone ${t} out of range`);
});

test('a range too short for a single bed yields none, and never throws', () => {
  assert.deepEqual(strataBeds({ width: 960, crestY: 400, bottomY: 420, spacingPx: 34 }), []);
  assert.deepEqual(strataBeds({ width: 0, crestY: 0, bottomY: 500, spacingPx: 34 }), []);
  assert.deepEqual(strataBeds({ width: 960, crestY: 480, bottomY: 480, spacingPx: 34 }), []);
});

test('a very deep range is capped rather than turning into a comb', () => {
  const deep = strataBeds({ width: 960, crestY: -4000, bottomY: 480, spacingPx: 34, maxBeds: 8 });
  assert.equal(deep.length, 8);
});
