import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawCityWorld } from '../src/world/city/drawCity.js';
import { drawFarsideWorld } from '../src/world/farside/drawFarside.js';
import { drawRedlineWorld } from '../src/world/redline/drawRedline.js';
import { ConstellationWeaver } from '../src/world/ConstellationWeaver.js';
import { PerfGovernor } from '../src/render/PerfGovernor.js';
import { BiomeManager } from '../src/world/BiomeManager.js';

const stop = new Error('fixture stops after the sky pass');
for (const [kind, draw] of [['city', drawCityWorld], ['airless', drawFarsideWorld], ['strip', drawRedlineWorld]]) {
  for (const level of [4, 5, 6]) {
    test(`WP11 ${kind} actual constellation strokes match update permission at rung ${level}`, () => {
      const perf = Object.assign(Object.create(PerfGovernor.prototype), { level });
      let strokes = 0, draws = 0;
      const ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
        stroke() { strokes++; } };
      const weaver = new ConstellationWeaver(315, 640, 360);
      weaver.stars = [{ hue: 120, dots: [{ x: 100, y: 50 }, { x: 200, y: 80 }] }];
      const realDraw = weaver.draw.bind(weaver);
      weaver.draw = (...args) => { draws++; realDraw(...args); };
      const mgr = { world: { kind }, _perf: perf, tSec: 18, sections: [], _lastSectionIdx: 0, weaver,
        _drawSky() {}, drawDeepSky() {}, meteors: { draw() { assert.ok(perf.phenomenaFull, 'unrelated phenomena must stay shed'); } },
        _drawMoon() { throw stop; }, _drawCelestial() { throw stop; }, _drawPrimary() { throw stop; } };
      const policy = BiomeManager.prototype.optionalEffectsActive.call(mgr);
      try {
        draw(mgr, { ctx, canvas: { width: 640, height: 360 },
          dn: { get sunAlt() { throw stop; }, get moonAlt() { throw stop; } },
          A: {}, B: {}, t: 0, worldX: 0, phenomenaFull: perf.phenomenaFull, particleMul: 0 });
      } catch (error) { assert.equal(error, stop); }
      assert.equal(policy.weaver, level < 6);
      assert.equal(draws, policy.weaver ? 1 : 0);
      assert.equal(strokes > 0, policy.weaver, 'fixture contains visible retained strokes');
    });
  }
}

test('WP11 enclosed worlds and narrative Range never step the generic weaver', () => {
  for (const kind of ['abyssal', 'overgrowth', 'nave', 'foundry']) {
    assert.equal(BiomeManager.prototype.optionalEffectsActive.call({ world: { kind } }).weaver, false, kind);
  }
  assert.equal(BiomeManager.prototype.optionalEffectsActive.call({ world: { kind: 'alpine' }, rangeNarrative: {} }).weaver, false);
  assert.equal(BiomeManager.prototype.optionalEffectsActive.call({ world: { kind: 'alpine' } }).weaver, true, 'legacy Range remains eligible');
});
