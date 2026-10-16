import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { drawFarsideWorld } from '../src/world/farside/drawFarside.js';
import { WORLD_CONTRACT_MEMBERS } from '../src/world/WorldRegistry.js';

const canvas = { width: 1280, height: 720 };
const palette = { fx: 'starTwinkle', sky: ['#000000', '#000000', '#000000'] };
const star = {
  xFrac: 0.4, yFrac: 0.6, size: 1.5, layer: 2,
  bright: 0.7, mag: 4, altitude01: 0.1, phase: 0.8,
  ext: 0.35, redden: 0.65, hue: 210, varAmp: 0,
};

function recorder() {
  const draws = [], stack = [];
  let path = [];
  const ctx = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', globalCompositeOperation: 'source-over',
    save() { stack.push([this.globalAlpha, this.fillStyle, this.strokeStyle, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.fillStyle, this.strokeStyle, this.globalCompositeOperation] = stack.pop(); },
    createLinearGradient() { return { stops: [], addColorStop(at, color) { this.stops.push([at, color]); } }; },
    createRadialGradient() { return this.createLinearGradient(); },
    translate() {}, rotate() {}, scale() {},
    beginPath() { path = []; },
    arc(...args) { path.push(['arc', ...args]); },
    rect(...args) { path.push(['rect', ...args]); },
    moveTo() {}, lineTo() {}, stroke() {},
    fill() { draws.push({ path: [...path], alpha: this.globalAlpha, style: this.fillStyle }); },
    fillRect(...args) { draws.push({ path: [['rect', ...args]], alpha: this.globalAlpha, style: this.fillStyle }); },
  };
  return { ctx, draws };
}

function render(time, { airless = true, layer = 2, ext = 0.35, redden = 0.65, planets = [] } = {}) {
  const { ctx, draws } = recorder();
  const mgr = {
    tSec: time, openingGain: 1, calmLevel: 0,
    stars: [{ ...star, layer, ext, redden }], _starBuckets: new Map(),
    dustLanes: [], deepSky: [], planets,
    _perf: { phenomenaFull: false },
    _rotated: x => x, lerpCache: { get: a => a },
    _drawSky: BiomeManager.prototype._drawSky,
    _drawStarfield: BiomeManager.prototype._drawStarfield,
  };
  if (airless) {
    // Exercise the actual Far Side -> sky -> shared starfield route, then
    // stop before unrelated foreground/celestial drawing needs its fixtures.
    const skyComplete = new Error('sky complete');
    mgr.drawDeepSky = () => { throw skyComplete; };
    assert.throws(() => drawFarsideWorld(mgr, { ctx, canvas, A: palette, B: palette, t: 0 }),
      error => error === skyComplete);
  } else {
    mgr._drawSky(ctx, canvas, palette, palette, 0, 1);
  }
  // Compare emitted alphas/colors, allowing the shared parallax drift.
  return draws.filter(d => d.path.some(p => p[0] === 'arc' || p[3] < 10))
    .map(({ alpha, style }) => ({ alpha, style: style.stops ?? style }));
}

for (const layer of [0, 1, 2]) {
  test(`Far Side catalogue layer ${layer} has stable drawn alpha as time advances`, () => {
    const first = render(0, { layer });
    assert.ok(first.length > 0, 'must actually draw stars');
    for (const time of [0.5, 1, 3, 10, 60, 180]) {
      assert.deepEqual(render(time, { layer }), first);
    }
  });
}

test('Far Side ignores cached atmospheric extinction and reddening', () => {
  for (const layer of [0, 1, 2]) {
    assert.deepEqual(render(0, { layer }), render(0, { layer, ext: 1, redden: 0 }));
  }
});

test('atmospheric worlds retain twinkle, extinction and reddening', () => {
  assert.notDeepEqual(render(0, { airless: false }), render(3, { airless: false }));
  assert.notDeepEqual(render(0, { airless: false }), render(0, { airless: false, ext: 1, redden: 0 }));
});

test('airless planets do not lose brightness toward the horizon', () => {
  const planet = { xFrac: 0.7, yFrac: 0.3, bright: 0.5, size: 1, hue: 30, sat: 40 };
  assert.deepEqual(render(0, { planets: [{ ...planet, altitude01: 0 }] }),
    render(0, { planets: [{ ...planet, altitude01: 1 }] }));
});

test('world contract does not advertise an unused star catalogue interface', () => {
  assert.equal(WORLD_CONTRACT_MEMBERS.has('starCatalogue'), false);
});
