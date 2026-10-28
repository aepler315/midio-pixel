import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contactShadow, SHADOW_FADE_HEIGHT_PX, SHADOW_WIDTH_FRAC, SHADOW_ASPECT,
  SHADOW_RX_MIN, SHADOW_RX_MAX, SHADOW_ALPHA_MAX, SHADOW_CAST_PER_PX,
  SHADOW_HORIZON_STRETCH, SHADOW_ZENITH_YFRAC, SHADOW_HORIZON_YFRAC,
  SHADOW_STRENGTH_FLOOR, shadowStrength,
} from '../src/world/ContactShadow.js';

test('grounded (heightAbove=0, and slightly negative) is the alpha/size ceiling', () => {
  for (const h of [0, -5, -0.01]) {
    const s = contactShadow(100, 480, h, 60);
    assert.equal(s.alpha, SHADOW_ALPHA_MAX);
    const expectedRx = Math.min(SHADOW_RX_MAX, Math.max(SHADOW_RX_MIN, 60 * SHADOW_WIDTH_FRAC));
    assert.ok(Math.abs(s.rx - expectedRx) < 1e-9, `h=${h}: rx ${s.rx} != ${expectedRx}`);
  }
});

test('fully faded at and beyond SHADOW_FADE_HEIGHT_PX', () => {
  for (const h of [SHADOW_FADE_HEIGHT_PX, SHADOW_FADE_HEIGHT_PX + 500]) {
    const s = contactShadow(100, 480, h, 60);
    assert.deepEqual(s, { cx: 100, cy: 480, rx: 0, ry: 0, alpha: 0 });
  }
});

test('alpha and rx are monotonically non-increasing as height rises, no discontinuity', () => {
  let prevAlpha = Infinity, prevRx = Infinity;
  for (let h = 0; h <= SHADOW_FADE_HEIGHT_PX + 20; h += 2) {
    const s = contactShadow(0, 0, h, 60);
    assert.ok(s.alpha <= prevAlpha + 1e-9, `alpha rose at h=${h}`);
    assert.ok(s.rx <= prevRx + 1e-9, `rx rose at h=${h}`);
    prevAlpha = s.alpha; prevRx = s.rx;
  }
});

test('ry/rx ratio is always exactly SHADOW_ASPECT regardless of height', () => {
  for (const h of [0, 20, 60, 100]) {
    const s = contactShadow(0, 0, h, 60);
    if (s.rx > 0) assert.ok(Math.abs(s.ry / s.rx - SHADOW_ASPECT) < 1e-9);
  }
});

test('width clamps both directions when grounded', () => {
  const tiny = contactShadow(0, 0, 0, 5);
  assert.equal(tiny.rx, SHADOW_RX_MIN);
  const huge = contactShadow(0, 0, 0, 500);
  assert.equal(huge.rx, SHADOW_RX_MAX);
});

test('cx/cy always equal the anchor exactly, independent of height/width', () => {
  for (const h of [0, 40, 130, 300]) {
    const s = contactShadow(321, 654, h, 80);
    assert.equal(s.cx, 321);
    assert.equal(s.cy, 654);
  }
});

test('non-finite inputs are treated as safe defaults, never throw or NaN', () => {
  const s1 = contactShadow(10, 20, NaN, 60);
  assert.ok(Number.isFinite(s1.alpha) && Number.isFinite(s1.rx));
  const s2 = contactShadow(10, 20, 0, undefined);
  assert.ok(Number.isFinite(s2.rx) && s2.rx === SHADOW_RX_MIN);
});

// --- optional light: omit it and today's output is byte-identical ------

test('omitting the light argument (or passing null) is byte-identical to today', () => {
  for (const h of [0, 20, 60, 100, SHADOW_FADE_HEIGHT_PX, 400]) {
    const a = contactShadow(200, 480, h, 70);
    const b = contactShadow(200, 480, h, 70, null);
    const c = contactShadow(200, 480, h, 70, undefined);
    assert.deepEqual(b, a, `null light drifted at h=${h}`);
    assert.deepEqual(c, a, `omitted light drifted at h=${h}`);
  }
});

test('shadow is thrown away from the light: left light -> cx > screenX, and the mirror', () => {
  const screenX = 200, groundY = 480, h = 80, w = 60;
  const fromLeft = contactShadow(screenX, groundY, h, w, { x: 0, y: 100 });
  const fromRight = contactShadow(screenX, groundY, h, w, { x: 400, y: 100 });
  const overhead = contactShadow(screenX, groundY, h, w, { x: screenX, y: 0 });
  assert.ok(fromLeft.cx > screenX, `light on the left should throw the shadow right, got cx=${fromLeft.cx}`);
  assert.ok(fromRight.cx < screenX, `light on the right should throw the shadow left, got cx=${fromRight.cx}`);
  assert.equal(overhead.cx, screenX, 'a light directly overhead must not slide the shadow sideways');
});

test('offset scales with heightAbove and is zero when grounded', () => {
  const light = { x: 0, y: 100 };
  const grounded = contactShadow(200, 480, 0, 60, light);
  assert.equal(grounded.cx, 200, 'a character on the ground keeps the shadow at their feet');
  const mid = contactShadow(200, 480, 40, 60, light);
  const high = contactShadow(200, 480, 80, 60, light);
  assert.ok(mid.cx > grounded.cx, 'leaving the ground starts to throw the shadow');
  assert.ok(high.cx > mid.cx, 'a higher jump throws the shadow further');
  assert.ok(Math.abs((high.cx - 200) - 2 * (mid.cx - 200)) < 1e-9, 'offset is linear in heightAbove');
  assert.ok(SHADOW_CAST_PER_PX > 0);
});

test('a low celestial stretches rx; a zenith one does not', () => {
  const highSun = contactShadow(200, 480, 0, 60, { x: 400, y: 80, celestialYFrac: SHADOW_ZENITH_YFRAC });
  const lowSun = contactShadow(200, 480, 0, 60, { x: 400, y: 200, celestialYFrac: SHADOW_HORIZON_YFRAC });
  const noLight = contactShadow(200, 480, 0, 60);
  assert.ok(Math.abs(highSun.rx - noLight.rx) < 1e-9, 'zenith stretch is a no-op on rx');
  assert.ok(lowSun.rx > highSun.rx, 'a low sun lengthens the footprint');
  assert.ok(Math.abs(lowSun.rx / highSun.rx - (1 + SHADOW_HORIZON_STRETCH)) < 1e-9);
  assert.ok(Math.abs(lowSun.ry / lowSun.rx - SHADOW_ASPECT) < 1e-9, 'stretch keeps the aspect ratio');
});

test('light strength scales the shadow alpha and nothing else', () => {
  const light = { x: 0, y: 0, celestialYFrac: 0.2 };
  for (const h of [0, 40]) {
    const full = contactShadow(300, 480, h, 60, light);
    const dim = contactShadow(300, 480, h, 60, light, 0.6);
    assert.ok(Math.abs(dim.alpha - full.alpha * 0.6) < 1e-12, `h=${h}`);
    assert.deepEqual({ ...dim, alpha: 0 }, { ...full, alpha: 0 }, 'position and size unchanged');
  }
});

test('the default strength is today\'s alpha exactly', () => {
  for (const h of [0, 20, 80]) {
    const s = contactShadow(100, 480, h, 60);
    assert.equal(contactShadow(100, 480, h, 60, null, 1).alpha, s.alpha);
    assert.equal(contactShadow(100, 480, h, 60, null, undefined).alpha, s.alpha);
    assert.equal(contactShadow(100, 480, h, 60, null, NaN).alpha, s.alpha, 'a non-finite strength is full strength');
  }
  assert.equal(contactShadow(100, 480, 0, 60).alpha, SHADOW_ALPHA_MAX);
});

test('strength clamps to 1 and is floored, so a dim or night light still grounds the cast', () => {
  assert.equal(contactShadow(100, 480, 0, 60, null, 3).alpha, SHADOW_ALPHA_MAX, 'never darker than today');
  for (const dim of [0.45, 0.2, 0, -1]) {
    const alpha = contactShadow(100, 480, 0, 60, null, dim).alpha;
    assert.ok(Math.abs(alpha - SHADOW_ALPHA_MAX * SHADOW_STRENGTH_FLOOR) < 1e-12, `strength ${dim}`);
  }
  assert.equal(shadowStrength(0.7), 0.7);
  assert.equal(shadowStrength(0), SHADOW_STRENGTH_FLOOR);
  assert.equal(shadowStrength(2), 1);
  assert.equal(SHADOW_STRENGTH_FLOOR, 0.45);
});
