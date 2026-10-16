// Gamma-correct color interpolation (spec §4.1.4). Naive sRGB channel lerp
// muddies through gray; interpolating in linear light keeps transitions vivid.
import { clamp01, lerpHue } from './math.js';

const GAMMA = 2.2;

function toLinear(c) {
  return Math.pow(c / 255, GAMMA);
}

function toSrgb(c) {
  return Math.round(255 * Math.pow(Math.max(c, 0), 1 / GAMMA));
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const n = (Math.round(clamp01(r / 255) * 255) << 16) | (Math.round(clamp01(g / 255) * 255) << 8) | Math.round(clamp01(b / 255) * 255);
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
}

/** Linear-light hex→hex interpolation. Memoize on quantized t for hot paths. */
export function hexLerp(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const ch = (ca, cb) => toSrgb(toLinear(ca) * (1 - t) + toLinear(cb) * t);
  return rgbToHex(ch(A.r, B.r), ch(A.g, B.g), ch(A.b, B.b));
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = 60 * (((g - b) / d) % 6); break;
      case g: h = 60 * ((b - r) / d + 2); break;
      case b: h = 60 * ((r - g) / d + 4); break;
    }
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Hue takes the shortest arc; saturation/lightness lerp linearly. Keeps sunsets vivid mid-transition. */
export function hexLerpHsl(a, b, t) {
  const A = rgbToHsl(hexToRgb(a).r, hexToRgb(a).g, hexToRgb(a).b);
  const B = rgbToHsl(hexToRgb(b).r, hexToRgb(b).g, hexToRgb(b).b);
  const h = lerpHue(A.h, B.h, t);
  const s = A.s + (B.s - A.s) * t;
  const l = A.l + (B.l - A.l) * t;
  const rgb = hslToRgb(h, s, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/** Rotate a hex color's hue by `deg` (mod 360), preserving saturation/lightness. */
export function rotateHueHex(hex, deg) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const rgb = hslToRgb(((hsl.h + deg) % 360 + 360) % 360, hsl.s, hsl.l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/** Small memoization cache for per-frame full-profile blends (128 quantized steps). */
export class LerpCache {
  constructor(steps = 128, fn = hexLerp) {
    this.steps = steps;
    this.fn = fn;
    this.cache = new Map();
  }
  get(a, b, t) {
    const q = Math.round(clamp01(t) * this.steps);
    const key = a + '|' + b + '|' + q;
    let v = this.cache.get(key);
    if (v === undefined) {
      v = this.fn(a, b, q / this.steps);
      this.cache.set(key, v);
    }
    return v;
  }
}
