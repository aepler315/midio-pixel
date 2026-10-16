// OKLCH color math — Björn Ottosson's OKLab, wrapped in cylindrical LCH form.
//
// Why this exists instead of the HSL helpers in utils/color.js: HSL lightness
// is not perceptually uniform across hue. hsl(60,80%,50%) (yellow) reads far
// brighter than hsl(240,80%,50%) (blue) at the same L. Palette rules like
// "ground sits at L=0.38" only hold for every hue in OKLCH.
import { clamp01 } from '../../utils/math.js';

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * (Math.max(0, c) ** (1 / 2.4)) - 0.055;
  return clamp01(v);
}

function linearToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function inGamut(rgbLinear) {
  return rgbLinear.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
}

/** OKLCH (L 0..1, C 0..~0.37, H degrees) -> #rrggbb, clamped into sRGB gamut
 *  by reducing chroma (holding L and H) rather than clipping components —
 *  a wrong-hue clip is far more visible than a slightly less vivid color. */
export function oklchToHex(L, C, H) {
  const hRad = (H * Math.PI) / 180;
  L = clamp01(L);
  C = Math.max(0, C);
  let lo = 0, hi = C, rgbLin = oklabToLinear(L, C * Math.cos(hRad), C * Math.sin(hRad));
  if (!inGamut(rgbLin)) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const cand = oklabToLinear(L, mid * Math.cos(hRad), mid * Math.sin(hRad));
      if (inGamut(cand)) { lo = mid; rgbLin = cand; } else { hi = mid; }
    }
    rgbLin = oklabToLinear(L, lo * Math.cos(hRad), lo * Math.sin(hRad));
  }
  const to255 = (c) => Math.round(linearToSrgb(c) * 255).toString(16).padStart(2, '0');
  return `#${to255(rgbLin[0])}${to255(rgbLin[1])}${to255(rgbLin[2])}`;
}

export function hexToOklab(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0.5, 0, 0];
  const n = parseInt(m[1], 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  return linearToOklab(r, g, b);
}

export function hslToOklab(h, s, l) {
  // s,l in 0..1
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  const hh = ((h % 360) + 360) % 360;
  if (hh < 60) { r = c; g = x; } else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; } else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; } else { r = c; b = x; }
  return linearToOklab(srgbToLinear(r + m), srgbToLinear(g + m), srgbToLinear(b + m));
}

/** Perceptual distance between two OKLab triples (Euclidean — this is what
 *  "ΔE" means in OKLab; no further weighting needed, unlike CIELAB). */
export function oklabDelta(a, b) {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function oklabOf(L, C, H) {
  const hRad = (H * Math.PI) / 180;
  return [L, C * Math.cos(hRad), C * Math.sin(hRad)];
}
