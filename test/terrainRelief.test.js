import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  terrainFacing,
  sampleTerrainCurve,
  curveFacing,
  reliefDepthFade,
  facingColorStops,
  facingAtX,
  reliefLitStripRGBA,
  reliefShadeStripRGBA,
  RELIEF_FALLOFF_PX,
  RELIEF_SAMPLE_PX,
  RELIEF_LIT_ALPHA,
  RELIEF_SHADE_ALPHA,
  CREST_BASE_ALPHA,
  FOOTING_FACING_K,
} from '../src/world/TerrainRelief.js';

function bar(x, y, width = 40) {
  return { x, width, y };
}

test('terrainFacing(bars, null) returns all zeros — the no-light path is today', () => {
  const bars = [bar(0, 400), bar(40, 390), bar(80, 410)];
  assert.deepEqual(terrainFacing(bars, null), [0, 0, 0]);
  assert.deepEqual(terrainFacing(bars, undefined), [0, 0, 0]);
  assert.deepEqual(terrainFacing(bars, {}), [0, 0, 0]);
  assert.deepEqual(terrainFacing([], { x: 10, y: 10, intensity: 1 }), []);
  assert.deepEqual(terrainFacing(null, { x: 10, y: 10, intensity: 1 }), []);
});

test('facing flips sign when the light crosses a slope\'s vertical', () => {
  // Rising slope in canvas space: y falls as x grows (the ground climbs).
  // Its air-facing normal leans left, so a light on that open side reads
  // positive and the mirror reads negative.
  const bars = [bar(0, 420), bar(40, 400), bar(80, 380)];
  const mid = bars[1];
  const cx = mid.x + mid.width / 2;
  const left = terrainFacing(bars, { x: cx - 200, y: 200, intensity: 1 });
  const right = terrainFacing(bars, { x: cx + 200, y: 200, intensity: 1 });
  assert.ok(left[1] > 0, `light on the open side of a rising slope should read +, got ${left[1]}`);
  assert.ok(right[1] < 0, `mirrored light should flip the sign, got ${right[1]}`);
  assert.ok(Math.abs(left[1] + right[1]) < 1e-9, 'the flip is a true mirror');
});

test('facing is exactly 0 on flat terrain with the light directly overhead', () => {
  const bars = [bar(0, 400), bar(40, 400), bar(80, 400), bar(120, 400)];
  const facing = terrainFacing(bars, { x: 80, y: 0, intensity: 1 });
  for (const f of facing) assert.equal(f, 0, `flat + overhead must be edge-on, got ${f}`);
});

test('facing is bounded to [-1, 1] for every input, including the end-clamp path', () => {
  const samples = [
    [bar(0, 400)],
    [bar(0, 500), bar(40, 300)],
    [bar(0, 400), bar(40, 350), bar(80, 450), bar(120, 200)],
  ];
  for (const bars of samples) {
    for (const light of [
      { x: -1000, y: -1000, intensity: 1 },
      { x: 1000, y: 1000, intensity: 4 },
      { x: 20, y: 400, intensity: 1 },
      { x: 20, y: 0, intensity: 0.3 },
    ]) {
      for (const f of terrainFacing(bars, light)) {
        assert.ok(f >= -1 && f <= 1, `out of range ${f} for ${bars.length} bars`);
        assert.ok(Number.isFinite(f));
      }
    }
  }
});

test('facing scales to 0 as light.intensity does', () => {
  const bars = [bar(0, 420), bar(40, 400), bar(80, 380)];
  const light = { x: 0, y: 200 };
  const full = terrainFacing(bars, { ...light, intensity: 1 });
  const half = terrainFacing(bars, { ...light, intensity: 0.5 });
  const gone = terrainFacing(bars, { ...light, intensity: 0 });
  assert.deepEqual(gone, [0, 0, 0]);
  for (let i = 0; i < bars.length; i++) {
    assert.ok(Math.abs(half[i] - 0.5 * full[i]) < 1e-9, `intensity must scale facing linearly at bar ${i}`);
  }
});

// --- gradient / sub-slice sampler (vertical-ground-seams) ---

function wideHill() {
  // 90px slices, the real GroundField width. A hill then a drop so the
  // per-bar tangent (180px apart) disagrees with the local quadratic.
  return [
    bar(0, 420, 90),
    bar(90, 400, 90),
    bar(180, 360, 90),
    bar(270, 390, 90),
    bar(360, 410, 90),
  ];
}

test('curveFacing(samples, null) returns all zeros — same no-light contract', () => {
  const samples = sampleTerrainCurve(wideHill());
  assert.equal(curveFacing(samples, null).length, samples.length);
  assert.ok(curveFacing(samples, null).every((f) => f === 0));
  assert.ok(curveFacing(samples, {}).every((f) => f === 0));
  assert.deepEqual(curveFacing([], { x: 10, y: 10, intensity: 1 }), []);
  assert.deepEqual(curveFacing(null, { x: 10, y: 10, intensity: 1 }), []);
});

test('sampleTerrainCurve is empty / single-bar safe', () => {
  assert.deepEqual(sampleTerrainCurve(null), []);
  assert.deepEqual(sampleTerrainCurve([]), []);
  const one = sampleTerrainCurve([bar(10, 400, 90)]);
  assert.equal(one.length, 1);
  assert.equal(one[0].x, 10 + 45);
  assert.equal(one[0].y, 400);
});

test('sampleTerrainCurve walks the quadratic-midpoint ridge, not the raw bar tops', () => {
  const bars = wideHill();
  const samples = sampleTerrainCurve(bars, RELIEF_SAMPLE_PX);
  assert.ok(samples.length > bars.length, 'sub-slice: more samples than bars');
  // Interior bar centres are control points, not on-curve. At the peak
  // bar (x=180+45=225, y=360) the quadratic sits *below* the control
  // (larger y, since canvas grows down) -- a weighted average of the
  // neighbours. If we sampled raw bar tops this would be exactly 360.
  const peak = samples.reduce((best, s) => (
    Math.abs(s.x - 225) < Math.abs(best.x - 225) ? s : best
  ), samples[0]);
  assert.ok(peak.y > 360, `curve must sit inside the control polygon, got y=${peak.y}`);
  assert.ok(peak.y < 400, `curve must still peak near the high bar, got y=${peak.y}`);
});

test('curve facing is continuous across a 90px slice boundary — the property the per-bar sampler violates', () => {
  const bars = wideHill();
  const light = { x: 0, y: 80, intensity: 1 };

  const perBar = terrainFacing(bars, light);
  let maxBarJump = 0;
  for (let i = 0; i < perBar.length - 1; i++) {
    maxBarJump = Math.max(maxBarJump, Math.abs(perBar[i + 1] - perBar[i]));
  }
  assert.ok(maxBarJump > 0.02, `per-bar facing should step at slice edges, got ${maxBarJump}`);

  const samples = sampleTerrainCurve(bars, RELIEF_SAMPLE_PX);
  const smooth = curveFacing(samples, light);
  assert.equal(smooth.length, samples.length);
  let maxSmoothJump = 0;
  for (let i = 0; i < smooth.length - 1; i++) {
    maxSmoothJump = Math.max(maxSmoothJump, Math.abs(smooth[i + 1] - smooth[i]));
  }
  assert.ok(
    maxSmoothJump < 0.08,
    `smoothed facing jumped ${maxSmoothJump} between ${RELIEF_SAMPLE_PX}px samples (bar jump was ${maxBarJump})`,
  );
  assert.ok(maxSmoothJump < maxBarJump, 'sub-slice facing must be smoother than the per-bar step');
  for (const f of smooth) {
    assert.ok(f >= -1 && f <= 1);
    assert.ok(Number.isFinite(f));
  }
});

test('reliefDepthFade is 1 on the ridge and 0 at and past the falloff', () => {
  assert.equal(reliefDepthFade(0), 1);
  assert.equal(reliefDepthFade(-4), 1);
  assert.equal(reliefDepthFade(RELIEF_FALLOFF_PX), 0);
  assert.equal(reliefDepthFade(RELIEF_FALLOFF_PX + 80), 0);
  const mid = reliefDepthFade(RELIEF_FALLOFF_PX / 2);
  assert.ok(Math.abs(mid - 0.5) < 1e-9, `linear midpoint, got ${mid}`);
  assert.equal(reliefDepthFade(10, 0), 0);
});

test('facingColorStops: two channels, no muddy mid-grey, offsets monotonic in [0,1]', () => {
  const bars = wideHill();
  const samples = sampleTerrainCurve(bars);
  const facing = curveFacing(samples, { x: 0, y: 80, intensity: 1 });
  const x0 = 0, x1 = 450;
  for (const channel of ['lit', 'shade', 'crest']) {
    const stops = facingColorStops(samples, facing, x0, x1, channel);
    assert.ok(stops.length >= 2, `${channel} needs enough stops to interpolate`);
    assert.equal(stops[0].offset, 0);
    assert.equal(stops[stops.length - 1].offset, 1);
    for (let i = 0; i < stops.length; i++) {
      assert.ok(stops[i].offset >= 0 && stops[i].offset <= 1, `${channel} offset ${stops[i].offset}`);
      if (i > 0) assert.ok(stops[i].offset >= stops[i - 1].offset, `${channel} offsets must not go backwards`);
      assert.match(stops[i].color, /^rgba\(/);
    }
  }
  const lit = facingColorStops(samples, facing, x0, x1, 'lit');
  const shade = facingColorStops(samples, facing, x0, x1, 'shade');
  // Where lit is non-zero, shade must be zero, and vice versa -- the
  // two-pass construction that keeps the zero-crossing transparent.
  const alpha = (c) => Number(c.slice(c.lastIndexOf(',') + 1, -1));
  let sawLit = false, sawShade = false;
  for (let i = 0; i < Math.min(lit.length, shade.length); i++) {
    const la = alpha(lit[i].color);
    const sa = alpha(shade[i].color);
    assert.ok(la === 0 || sa === 0, `lit ${la} and shade ${sa} both live at stop ${i}`);
    if (la > 0) sawLit = true;
    if (sa > 0) sawShade = true;
    assert.ok(la <= RELIEF_LIT_ALPHA + 1e-9);
    assert.ok(sa <= RELIEF_SHADE_ALPHA + 1e-9);
  }
  assert.ok(sawLit && sawShade, 'a hill under a side light should produce both channels');
});

test('crest stops stay near the legacy 0.18 when facing is 0', () => {
  const samples = [{ x: 0 }, { x: 100 }];
  const stops = facingColorStops(samples, [0, 0], 0, 100, 'crest');
  const alpha = (c) => Number(c.slice(c.lastIndexOf(',') + 1, -1));
  for (const s of stops) {
    assert.ok(Math.abs(alpha(s.color) - CREST_BASE_ALPHA) < 1e-9, s.color);
  }
});

// --- footing AO: the one sibling pass that used to ignore the light -------

test('footing stops reproduce the flat pass alpha exactly when facing is 0', () => {
  const samples = [{ x: 0 }, { x: 100 }];
  const baseAlpha = 0.22;
  const stops = facingColorStops(samples, [0, 0], 0, 100, 'footing', baseAlpha);
  const alpha = (c) => Number(c.slice(c.lastIndexOf(',') + 1, -1));
  for (const s of stops) {
    assert.ok(Math.abs(alpha(s.color) - baseAlpha) < 1e-9, s.color);
  }
});

test('footing AO deepens turned away from the light and lifts facing it', () => {
  const samples = [{ x: 0 }, { x: 100 }];
  const baseAlpha = 0.2;
  const alpha = (c) => Number(c.slice(c.lastIndexOf(',') + 1, -1));

  const lit = facingColorStops(samples, [1, 1], 0, 100, 'footing', baseAlpha);
  const shaded = facingColorStops(samples, [-1, -1], 0, 100, 'footing', baseAlpha);

  assert.ok(alpha(lit[0].color) < baseAlpha, 'facing the light should lighten the seam');
  assert.ok(alpha(shaded[0].color) > baseAlpha, 'turned away should deepen the seam');
  const expectedLit = baseAlpha * (1 - FOOTING_FACING_K);
  const expectedShaded = baseAlpha * (1 + FOOTING_FACING_K);
  assert.ok(Math.abs(alpha(lit[0].color) - expectedLit) < 1e-9);
  assert.ok(Math.abs(alpha(shaded[0].color) - expectedShaded) < 1e-9);
});

test('footing alpha never goes negative or exceeds 1, even at extreme facing/base combinations', () => {
  const samples = [{ x: 0 }, { x: 100 }];
  const alpha = (c) => Number(c.slice(c.lastIndexOf(',') + 1, -1));
  for (const baseAlpha of [0, 0.3, 1]) {
    for (const f of [-1, -0.4, 0, 0.4, 1]) {
      const stops = facingColorStops(samples, [f, f], 0, 100, 'footing', baseAlpha, 5);
      for (const s of stops) {
        const a = alpha(s.color);
        assert.ok(a >= 0 && a <= 1, `alpha ${a} out of range for base=${baseAlpha} f=${f}`);
      }
    }
  }
});

test('facingAtX interpolates and clamps, 0 without a curve', () => {
  assert.equal(facingAtX([], [], 10), 0);
  assert.equal(facingAtX(null, null, 10), 0);
  const samples = [{ x: 0 }, { x: 100 }];
  const facing = [-0.4, 0.6];
  assert.equal(facingAtX(samples, facing, -10), -0.4);
  assert.equal(facingAtX(samples, facing, 200), 0.6);
  assert.ok(Math.abs(facingAtX(samples, facing, 50) - 0.1) < 1e-9);
});

test('reliefLitStripRGBA is continuous — no adjacent-pixel alpha jump above a small epsilon', () => {
  const bars = wideHill();
  const samples = sampleTerrainCurve(bars, RELIEF_SAMPLE_PX);
  const facing = curveFacing(samples, { x: 0, y: 80, intensity: 1 });
  const rgba = reliefLitStripRGBA(samples, facing, 450);
  assert.equal(rgba.length, 450 * 4);
  let maxJump = 0;
  for (let x = 1; x < 450; x++) {
    const a0 = rgba[(x - 1) * 4 + 3];
    const a1 = rgba[x * 4 + 3];
    maxJump = Math.max(maxJump, Math.abs(a1 - a0));
  }
  assert.ok(maxJump < 12, `lit strip alpha jumped ${maxJump} between adjacent pixels`);
  // A hill under a side light must actually paint something on its lit face.
  let painted = 0;
  for (let x = 0; x < 450; x++) painted += rgba[x * 4 + 3];
  assert.ok(painted > 0);
});

test('reliefShadeStripRGBA is genuine multiply occlusion: full alpha throughout, darkening carried entirely in the gray value', () => {
  const bars = wideHill();
  const samples = sampleTerrainCurve(bars, RELIEF_SAMPLE_PX);
  const facing = curveFacing(samples, { x: 0, y: 80, intensity: 1 });
  const rgba = reliefShadeStripRGBA(samples, facing, 450);
  assert.equal(rgba.length, 450 * 4);
  for (let x = 0; x < 450; x++) {
    const o = x * 4;
    assert.equal(rgba[o + 3], 255, `alpha must stay fully opaque at x=${x} for multiply's math to apply`);
    assert.equal(rgba[o], rgba[o + 1], 'gray channels must agree (r=g)');
    assert.equal(rgba[o + 1], rgba[o + 2], 'gray channels must agree (g=b)');
    assert.ok(rgba[o] <= 255 && rgba[o] >= 0);
  }
  // Continuity now lives in the gray channel, not alpha (which is constant).
  let maxJump = 0;
  for (let x = 1; x < 450; x++) {
    maxJump = Math.max(maxJump, Math.abs(rgba[x * 4] - rgba[(x - 1) * 4]));
  }
  assert.ok(maxJump < 12, `shade strip gray value jumped ${maxJump} between adjacent pixels`);
  // A hill under a side light must actually darken somewhere (gray < 255).
  assert.ok(Array.from({ length: 450 }, (_, x) => rgba[x * 4]).some((g) => g < 255));
});

test('reliefShadeStripRGBA never darkens where the lit strip is painting (no pixel is both lit and shaded)', () => {
  const bars = wideHill();
  const samples = sampleTerrainCurve(bars, RELIEF_SAMPLE_PX);
  const facing = curveFacing(samples, { x: 0, y: 80, intensity: 1 });
  const lit = reliefLitStripRGBA(samples, facing, 450);
  const shade = reliefShadeStripRGBA(samples, facing, 450);
  for (let x = 0; x < 450; x++) {
    const litAlpha = lit[x * 4 + 3];
    const shadeGray = shade[x * 4];
    assert.ok(litAlpha === 0 || shadeGray === 255, `x=${x}: lit alpha ${litAlpha} and shade gray ${shadeGray} both active`);
  }
});
