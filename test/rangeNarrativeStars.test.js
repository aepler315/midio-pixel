import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { rangeSkyState } from '../src/world/alpine/RangeFrame.js';
import { hexLerp } from '../src/utils/color.js';
import { tourSkyDirection } from '../src/world/alpine/RangeSkyComposition.js';

const canvas = { width: 1280, height: 720 };
const palette = { fx: '', sky: ['#183044', '#38445a', '#706579'] };
const star = { xFrac: .25, yFrac: .8, layer: 2, bright: 1, phase: 0,
  mag: 1, altitude01: .2, ext: 1, hue: 0 };
function fixture() {
  const draws = [], gradients = [], stack = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '',
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.fillStyle]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.fillStyle] = stack.pop(); },
    createLinearGradient() { const stops = []; gradients.push(stops); return { addColorStop: (x, c) => stops.push([x, c]) }; },
    fillRect(x, y, w, h) { draws.push({ x, y, w, h, alpha: this.globalAlpha, style: this.fillStyle }); },
    beginPath() {}, rect() {}, fill() {},
    setTransform() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const mgr = { world: { kind: 'alpine' }, rangeNarrative: { skyDark: 1 },
    tSec: 0, openingGain: 1, calmLevel: 0, stars: [{ ...star }],
    _starBuckets: new Map(), _rangeSky: { starBrightnessAt: () => 1 },
    _rotated: c => c, lerpCache: { get: hexLerp },
    _drawStarfield: BiomeManager.prototype._drawStarfield };
  return { ctx, mgr, draws, gradients };
}

test('Alpine narrative draws the existing star pass once after its intact sky gradient', () => {
  const { ctx, mgr, draws, gradients } = fixture();
  let calls = 0;
  mgr._drawStarfield = function (...args) { calls++; return BiomeManager.prototype._drawStarfield.apply(this, args); };
  BiomeManager.prototype._drawSky.call(mgr, ctx, canvas, palette, palette, 0, 1);
  assert.equal(calls, 1, 'non-null Range narrative must not bypass or duplicate stars');
  const sky = rangeSkyState(mgr, palette, palette, 0, 1, mgr.rangeNarrative);
  assert.deepEqual(gradients, [[[0, sky.top], [.5, sky.mid], [1, sky.horizon]]], 'no ordinary sky gradient overpaint');
  assert.equal(draws.filter(d => d.w === canvas.width && d.h === canvas.height).length, 1);
  assert.ok(draws.slice(1).some(d => d.w < 10), 'existing catalogue emits visible points after background');
});

test('explicit astronomy suppression also applies to the narrative branch', () => {
  const { ctx, mgr, draws } = fixture();
  mgr._drawStarfield = () => assert.fail('astronomy was explicitly suppressed');
  BiomeManager.prototype._drawSky.call(mgr, ctx, canvas, palette, palette, 0, 1, { astronomical: false });
  assert.equal(draws.length, 1);
});

test('enclosed worlds cannot acquire stars through the shared painter', () => {
  for (const kind of ['abyssal', 'nave']) {
    const { ctx, mgr, draws } = fixture(); mgr.world.kind = kind;
    BiomeManager.prototype._drawStarfield.call(mgr, ctx, canvas, palette, palette, 0, 1);
    assert.equal(draws.length, 0, kind);
  }
});

test('Range daylight retains a dimmer catalogue after terrain preparation', () => {
  const { ctx, mgr, draws } = fixture();
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
  assert.ok(draws.some(d => d.alpha > .05));
  draws.length = 0;
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 0);
  assert.ok(draws.some(d => d.alpha > .05), 'daylight retains a visible star field');
});

test('Range points cover one native pixel through Classic and Detailed compositor transforms', () => {
  for (const scale of [.25, .5]) {
    const { ctx, mgr, draws } = fixture();
    mgr._rangeV2Active = true;
    mgr.rangePresentation = { pixelPolicy: { active: true } };
    ctx.getTransform = () => ({ a: scale, b: 0, c: 0, d: scale, e: .4, f: .6 });
    mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
    assert.equal(draws.length, 1);
    assert.equal(draws[0].w, 1, 'faintness uses alpha, not a fractional native footprint');
    assert.equal(draws[0].h, 1);
    assert.equal(draws[0].x, Math.floor(star.xFrac * canvas.width * scale + .4), 'native pixel edge is aligned');
    assert.equal(draws[0].y, Math.floor(star.yFrac * canvas.height * scale + .6));
  }
});

test('tour stars project persistent catalogue directions with the resolved lens, including upward shots', () => {
  const { ctx, mgr, draws } = fixture();
  const direction = tourSkyDirection(90, 18);
  const pose = { eyeM: [100, 200, 300], targetM: direction.map((v, i) => [100, 200, 300][i] + v * 1000), fovYDeg: 50, aspect: 16 / 9 };
  mgr._rangeV2Active = true;
  mgr.rangePresentation = { skyPan: { tourPose: pose } };
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
  assert.equal(draws.length, 1);
  const first = { ...draws[0] };
  assert.ok(Math.abs(draws[0].x - 639.5) <= 1 && Math.abs(draws[0].y - 359.5) <= 1, 'projected near the centre, below the inherited screen horizon');
  draws.length = 0;
  pose.targetM = direction.map((v, i) => pose.eyeM[i] - v * 1000);
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
  assert.equal(draws.length, 0, 'a direction behind the turned camera cannot stay screen-locked');
  pose.targetM = direction.map((v, i) => pose.eyeM[i] + v * 1000);
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
  assert.deepEqual(draws[0], first, 'returning to an orientation sees the same persistent star');
});

test('tour horizon points retain exposure and a native footprint through daylight', () => {
  const { ctx, mgr, draws } = fixture();
  const direction = tourSkyDirection(90, 18);
  mgr._rangeV2Active = true;
  mgr.rangePresentation = { skyPan: { tourPose: { eyeM: [0, 0, 0], targetM: direction, fovYDeg: 50, aspect: 16 / 9 } } };
  mgr.stars[0].bright = .2; mgr.stars[0].ext = .12;
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
  assert.ok(draws[0].alpha > .05 && draws[0].alpha < .2, 'a faint horizon point must survive the final display');
  assert.equal(draws[0].w, 1); assert.equal(draws[0].h, 1);
  draws.length = 0; mgr.stars[0].bright = 0;
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 1);
  assert.equal(draws.length, 0, 'exposure must not add a uniform bright floor');
  mgr.stars[0].bright = 1;
  mgr._drawStarfield(ctx, canvas, palette, palette, 0, 0);
  assert.ok(draws.some(d => d.alpha > .05));
});
