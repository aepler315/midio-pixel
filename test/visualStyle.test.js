import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, rgbToHsl } from '../src/utils/color.js';

const STEP_8BIT = 1 / 255;
import {
  resolveVisualStyle, nextVisualStyle, styleDials, isRendered, styleLabel,
  shiftLightness, ensureMinLightness, STYLE_CLASSIC, STYLE_RENDERED,
} from '../src/render/VisualStyle.js';
import { bloomStrength } from '../src/render/Renderer.js';

test('resolveVisualStyle always returns the house look', () => {
  assert.equal(resolveVisualStyle('classic'), STYLE_RENDERED);
  assert.equal(resolveVisualStyle('neon'), STYLE_RENDERED);
  assert.equal(resolveVisualStyle('rendered'), STYLE_RENDERED);
  assert.equal(resolveVisualStyle(''), STYLE_RENDERED);
});

test('nextVisualStyle is a no-op', () => {
  assert.equal(nextVisualStyle(STYLE_RENDERED), STYLE_RENDERED);
  assert.equal(nextVisualStyle(STYLE_CLASSIC), STYLE_RENDERED);
});

test('house dials: CGI terrain + ocean contours', () => {
  const d = styleDials(STYLE_RENDERED);
  assert.equal(d.spaceWash, true);
  assert.equal(d.oceanDrawContours, true);
  assert.ok(d.oceanLineAlpha > 0);
  assert.equal(d.heatShimmerSlices, false);
  assert.ok(d.spaceRidgeAlpha > 0);
  assert.ok(d.bloomBaseMul > 0);
});

test('styleLabel is fixed house label', () => {
  assert.match(styleLabel(STYLE_RENDERED), /Midio/i);
  assert.match(styleLabel(STYLE_CLASSIC), /Midio/i);
});

test('shiftLightness darkens and lightens without leaving the hex space', () => {
  const base = '#2b2145';
  const dark = shiftLightness(base, -0.15);
  const lit = shiftLightness(base, 0.15);
  assert.match(dark, /^#[0-9a-f]{6}$/i);
  assert.match(lit, /^#[0-9a-f]{6}$/i);
  assert.notEqual(dark, lit);
});

test('bloomStrength is positive for house look', () => {
  // No style argument: bloomStrength stopped taking one when the classic/neon
  // split was removed. The stale extra arg was harmless while it was simply
  // ignored, but the fourth slot is now openingGain, and a string there makes
  // the whole result NaN.
  const b = bloomStrength(null, null, false);
  assert.ok(b > 0);
  assert.ok(isRendered(STYLE_RENDERED));
  assert.ok(isRendered(STYLE_CLASSIC));
});

test('the opening gain scales the resting bloom, not the reactive swell', () => {
  const rest = bloomStrength(null, null, false, 1);
  const held = bloomStrength(null, null, false, 0.35);
  assert.ok(held < rest, 'a song that has not started yet must not open fully bloomed');
  assert.ok(held > 0, 'but the frame is dimmed, never blacked out');
  // A drop still lands at full force even during the hold -- if the song is
  // slamming, it has plainly started, and the gain will be releasing anyway.
  const slam = bloomStrength({ slam: 1, surge: 1 }, { level: 1 }, false, 0.35);
  assert.ok(slam > rest, 'the reactive term is untouched by the hold');
});

test('salience lowers supporting bloom without weakening the active drop', () => {
  const ordinary = bloomStrength(null, null, false, 1, 1);
  const restrained = bloomStrength(null, null, false, 1, 0.4);
  assert.ok(restrained < ordinary, 'a landmark or performer focus leaves less bloom for the rest of the frame');

  const activeDrop = bloomStrength({ slam: 1, surge: 1 }, { level: 1 }, false, 1, 0.4);
  const unrestrainedDrop = bloomStrength({ slam: 1, surge: 1 }, { level: 1 }, false, 1, 1);
  assert.equal(activeDrop, unrestrainedDrop, 'the drop keeps the bloom it earned');
});

// --- ensureMinLightness: the ground must exist on every palette ----------

test('ensureMinLightness leaves anything already bright enough untouched', () => {
  assert.equal(ensureMinLightness('#4a3b71', 0.30), '#4a3b71');
  assert.equal(ensureMinLightness('#ffffff', 0.30), '#ffffff');
});

test('ensureMinLightness lifts a near-black to the floor, keeping its hue', () => {
  // CYBER's ground tone: the relative +0.14 lift still leaves it at 0.21,
  // which is what let the darkest biomes read as no ground at all.
  const lifted = ensureMinLightness('#0e365c', 0.30);
  const before = rgbToHsl(...Object.values(hexToRgb('#0e365c')));
  const after = rgbToHsl(...Object.values(hexToRgb(lifted)));
  // One 8-bit channel step (1/255) of slack: the floor is applied in HSL
  // and then quantized back into a hex triplet, so landing a shade under is
  // rounding, not a miss.
  assert.ok(after.l >= 0.30 - STEP_8BIT, `expected the floor, got ${after.l}`);
  // Same rounding story as the lightness: a sub-degree drift is the hex
  // quantization, not a hue shift.
  assert.ok(Math.abs(after.h - before.h) < 1, `hue must survive the lift, ${before.h} -> ${after.h}`);
});

test('ensureMinLightness is idempotent and monotonic in the floor', () => {
  const once = ensureMinLightness('#061428', 0.30);
  assert.equal(ensureMinLightness(once, 0.30), once);
  const higher = ensureMinLightness('#061428', 0.45);
  const l = (h) => rgbToHsl(...Object.values(hexToRgb(h))).l;
  assert.ok(l(higher) > l(once), 'a higher floor must lift further');
});

test('pure black gains lightness even with no hue to preserve', () => {
  const lifted = ensureMinLightness('#000000', 0.30);
  assert.ok(rgbToHsl(...Object.values(hexToRgb(lifted))).l >= 0.30 - STEP_8BIT);
});
