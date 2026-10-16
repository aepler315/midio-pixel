import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { drawFathomWorld } from '../src/world/fathom/drawFathom.js';
import { drawUnderstoryWorld } from '../src/world/understory/drawUnderstory.js';
import { drawFoundryWorld } from '../src/world/foundry/drawFoundry.js';
import { drawNaveWorld } from '../src/world/nave/drawNave.js';

const canvas = { width: 1280, height: 720 };
const palette = { sky: ['#102030', '#203040', '#304050'], fx: 'starTwinkle' };

function paintSky(draw, phenomenaFull, fx = 'starTwinkle', kind = undefined) {
  const colors = { ...palette, fx };
  const draws = [], stack = [];
  const gradient = kind => ({ kind, addColorStop() {} });
  const ctx = {
    globalAlpha: 1, fillStyle: '', globalCompositeOperation: 'source-over',
    save() { stack.push([this.globalAlpha, this.fillStyle, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.fillStyle, this.globalCompositeOperation] = stack.pop(); },
    createLinearGradient: () => gradient('linear'),
    createRadialGradient: () => gradient('radial'),
    fillRect(...rect) { draws.push({ rect, style: this.fillStyle }); },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    translate() {}, rotate() {}, scale() {}, stroke() {},
    fill() { draws.push({ style: this.fillStyle }); },
  };
  const mgr = Object.assign(Object.create(BiomeManager.prototype), {
    world: kind ? { id: 'custom', kind } : undefined,
    tSec: 5, openingGain: 1, calmLevel: 0,
    _perf: { phenomenaFull }, _rotated: x => x, lerpCache: { get: a => a },
    stars: [{ xFrac: 0.4, yFrac: 0.3, size: 1, layer: 0, bright: 0.8, phase: 0, hue: 0 }],
    _starBuckets: new Map(), dustLanes: [], deepSky: [], planets: [],
  });
  if (draw) {
    // Stop at the first foreground pass; keep the real world -> sky -> stars path.
    const complete = new Error('sky complete');
    mgr._drawCelestial = () => { throw complete; };
    assert.throws(() => draw(mgr, { ctx, canvas, A: colors, B: colors, t: 0,
      dn: { sunAlt: 0.6 }, phenomenaFull }), error => error === complete);
  } else {
    mgr._drawSky(ctx, canvas, colors, colors, 0, 1);
  }
  return draws;
}

for (const [name, draw] of [['Fathom', drawFathomWorld], ['Nave', drawNaveWorld]]) {
  test(`${name} retains its seven local light shafts`, () => {
    const draws = paintSky(draw, true, 'godRays');
    assert.equal(draws.filter(d => !d.rect).length, 7);
    assert.equal(draws.filter(d => d.rect).length, 2);
  });
  for (const fx of ['aurora', 'nebulaBloom']) {
    test(`${name} excludes inherited ${fx} astronomy`, () => {
      assert.equal(paintSky(draw, true, fx).length, 2);
    });
  }
  for (const full of [false, true]) {
    test(`${name} keeps its base gradient without stars or space dust at phenomenaFull=${full}`, () => {
      const draws = paintSky(draw, full);
      assert.deepEqual(draws[0].rect, [0, 0, 1280, 720]);
      assert.equal(draws[0].style.kind, 'linear');
      assert.equal(draws.length, full ? 2 : 1, 'only the base and optional atmospheric plate should paint');
    });
  }
}

test('the default open sky still paints astronomical layers', () => {
  assert.ok(paintSky(null, true).length > 4);
});

for (const [kind, draw] of [['overgrowth', drawUnderstoryWorld], ['foundry', drawFoundryWorld]]) {
  test(`${kind} actual world-to-sky path excludes astronomy even without caller flags`, () => {
    assert.equal(paintSky(draw, true, 'starTwinkle', kind).length, 2);
  });
}
for (const kind of ['overgrowth', 'foundry', 'nave', 'abyssal']) {
  test(`${kind} shared sky boundary rejects inherited space dust and stars`, () => {
    assert.equal(paintSky(null, true, 'starTwinkle', kind).length, 2);
  });
}
