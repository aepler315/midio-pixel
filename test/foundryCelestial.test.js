import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawFoundryWorld } from '../src/world/foundry/drawFoundry.js';
import { celestialYFracFor, celestialXFracFor, horizonFade } from '../src/world/DayNight.js';

function celestial(dn) {
  const stop = new Error('stop after celestial pass');
  let body;
  const mgr = { tSec: 12, sections: [], _drawSky() {},
    _drawCelestial(_ctx, _canvas, _a, _b, _t, y, alpha, x) { body = { kind: 'sun', x, y, alpha }; throw stop; },
    _drawMoon(_ctx, _canvas, y, alpha, _rot, x) { body = { kind: 'moon', x, y, alpha }; throw stop; } };
  assert.throws(() => drawFoundryWorld(mgr, { ctx: {}, canvas: { width: 640, height: 360 }, A: {}, B: {}, t: 0, dn }), error => error === stop);
  return body;
}

test('WP12 Foundry sun position and visibility use solar state and ignore lunar-only changes', () => {
  const solar = { sunAlt: 0.22, sunAz01: 0.15 };
  const a = celestial({ ...solar, moonAlt: 0.8, moonAz01: 0.9 });
  const b = celestial({ ...solar, moonAlt: -0.6, moonAz01: 0.3 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { kind: 'sun', x: celestialXFracFor(solar.sunAz01), y: celestialYFracFor(solar.sunAlt), alpha: horizonFade(solar.sunAlt) * 0.5 });
});

test('WP12 Foundry sunrise preserves faint horizon visibility instead of lifting the sun to the moon floor', () => {
  const body = celestial({ sunAlt: 0.011, sunAz01: 0.2, moonAlt: 0.8, moonAz01: 0.9 });
  assert.equal(body.alpha, horizonFade(0.011) * 0.5);
  assert.equal(body.y, celestialYFracFor(0.011));
  assert.ok(Object.values(body).slice(1).every(Number.isFinite));
});

test('WP12 Foundry night uses lunar coordinates and retains its smoke-veiled moon floor', () => {
  for (const sunAlt of [-0.001, -0.5]) {
    const body = celestial({ sunAlt, sunAz01: 0.9, moonAlt: 0.5, moonAz01: 0.25 });
    assert.deepEqual(body, { kind: 'moon', x: celestialXFracFor(0.25), y: celestialYFracFor(0.5), alpha: horizonFade(0.5) * 0.5 });
  }
  assert.equal(celestial({ sunAlt: -0.2, moonAlt: -0.6 }).y, celestialYFracFor(0.3));
});
