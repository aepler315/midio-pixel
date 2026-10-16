import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateHueHex, rgbToHsl, hexToRgb } from '../src/utils/color.js';

test('rotateHueHex by 0 is a pure no-op', () => {
  assert.equal(rotateHueHex('#3a7fd0', 0), '#3a7fd0');
});

test('rotateHueHex by 360 returns (approximately) the original color', () => {
  const out = rotateHueHex('#3a7fd0', 360);
  const a = hexToRgb('#3a7fd0'), b = hexToRgb(out);
  assert.ok(Math.abs(a.r - b.r) <= 1 && Math.abs(a.g - b.g) <= 1 && Math.abs(a.b - b.b) <= 1);
});

test('rotateHueHex shifts hue by exactly the requested amount, preserving saturation/lightness', () => {
  const hex = '#ff0000'; // pure red, h=0
  const before = rgbToHsl(255, 0, 0);
  const out = rotateHueHex(hex, 40);
  const { r, g, b } = hexToRgb(out);
  const after = rgbToHsl(r, g, b);
  assert.ok(Math.abs(after.h - 40) < 1.5, `expected hue ~40, got ${after.h}`);
  assert.ok(Math.abs(after.s - before.s) < 0.02);
  assert.ok(Math.abs(after.l - before.l) < 0.02);
});

test('rotateHueHex wraps negative degrees correctly (circular, never negative internally)', () => {
  const out = rotateHueHex('#00ff00', -400); // -400 mod 360 == -40 == 320
  const { r, g, b } = hexToRgb(out);
  const hsl = rgbToHsl(r, g, b);
  const direct = rotateHueHex('#00ff00', -40);
  const { r: r2, g: g2, b: b2 } = hexToRgb(direct);
  const hsl2 = rgbToHsl(r2, g2, b2);
  assert.ok(Math.abs(hsl.h - hsl2.h) < 1e-6);
});

test('rotateHueHex leaves grayscale colors visually unchanged (no hue to rotate)', () => {
  const out = rotateHueHex('#808080', 90);
  assert.equal(out, '#808080');
});
