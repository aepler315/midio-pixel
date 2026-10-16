// _drawFogBanks used to pour a CIRCULAR gradient (radius 0.45*canvasWidth,
// centered mid-band) into a fillRect spanning the band -- but the band is
// far shorter than the gradient is tall, so both edges sliced the falloff
// at ~65% alpha and left a dead-flat horizontal line across the full canvas
// width, once per fog bank, stacked under 'lighter' compositing. That was
// the reported hard line at ~0.15h (the band's top) and its fainter twin at
// ~0.70h (the band's bottom).
//
// fogBandGradientGeometry/fogBandAlphaFractionAtY are the pure geometry the
// fix runs on, extracted so "does the gradient reach zero before the band
// edge" is a numeric assertion rather than something only checkable by
// eyeballing a screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fogBandGradientGeometry, fogBandAlphaFractionAtY, FOG_BAND_TOP_FRAC, FOG_BAND_HEIGHT_FRAC,
} from '../src/world/BiomeManager.js';

const SIZES = [
  [1280, 720],
  [1920, 1080],
  [854, 480],
  [3840, 2160],
];

test('the gradient reaches (essentially) zero at both band edges, at every canvas size', () => {
  for (const [w, h] of SIZES) {
    const geo = fogBandGradientGeometry(w, h);
    // Floating-point, not exact zero (e.g. |dy/yScale| lands 1e-16 short of
    // r) -- the point is "no visible cut", so a tight epsilon suffices.
    assert.ok(fogBandAlphaFractionAtY(geo, geo.bandTop) < 1e-9, `${w}x${h} top edge must be ~zero`);
    assert.ok(fogBandAlphaFractionAtY(geo, geo.bandBottom) < 1e-9, `${w}x${h} bottom edge must be ~zero`);
  }
});

test('nothing outside the band is ever painted either (monotonically zero beyond the edges)', () => {
  const geo = fogBandGradientGeometry(1280, 720);
  assert.equal(fogBandAlphaFractionAtY(geo, geo.bandTop - 50), 0);
  assert.equal(fogBandAlphaFractionAtY(geo, geo.bandBottom + 50), 0);
});

test('the fill is still strongest at the band\'s own center, so the fog itself is unchanged', () => {
  const geo = fogBandGradientGeometry(1280, 720);
  assert.equal(fogBandAlphaFractionAtY(geo, geo.cy), 1);
});

test('there is no hard step anywhere crossing either edge -- alpha eases to zero, not cuts to zero', () => {
  const geo = fogBandGradientGeometry(1280, 720);
  for (const edge of [geo.bandTop, geo.bandBottom]) {
    const justInside = fogBandAlphaFractionAtY(geo, edge + Math.sign(geo.cy - edge) * 2);
    // A couple of pixels in from the edge should already be very close to
    // zero (smooth falloff), not a jump from 0 straight to a large value --
    // that jump is exactly what a hard line looks like numerically.
    assert.ok(justInside < 0.05, `alpha 2px inside the edge should be near zero, got ${justInside}`);
  }
});

test('horizontal reach (the radius) is unchanged by the fix -- only the vertical falloff was squashed', () => {
  for (const [w, h] of SIZES) {
    const geo = fogBandGradientGeometry(w, h);
    assert.equal(geo.r, w * 0.45, `${w}x${h}: radius must still be 0.45 * canvasWidth`);
  }
});

test('the band footprint matches the documented fractions', () => {
  const geo = fogBandGradientGeometry(1280, 720);
  assert.equal(geo.bandTop, 720 * FOG_BAND_TOP_FRAC);
  assert.equal(geo.bandBottom, 720 * (FOG_BAND_TOP_FRAC + FOG_BAND_HEIGHT_FRAC));
});
