// Terrain relief (The Ground Catches It): surface facing against a light,
// for the ground ridge. Pure and stateless -- numbers in, a plain array
// out; the caller owns ctx. Same shape as ContactShadow.
//
// Facing is the *slope's* lean toward the light, not a full Lambertian
// term: a flat bar under an overhead sun is edge-on (0), so omitting the
// light *or* standing on level ground is byte-identical to today's flat
// fill. A rising face lights when the celestial is on the side it points
// toward and sinks when the light crosses its vertical.
//
// The per-bar API (`terrainFacing`) is the original PR #60 sampler: one
// tangent per 90px slice, taken between neighbouring bar centres. The
// draw path uses `sampleTerrainCurve` + `curveFacing` instead -- the same
// quadratic-midpoint ridge `_terrainTopPath` strokes, sampled every
// ~10px -- so a horizontal gradient can interpolate a continuous facing
// instead of painting one hard-edged column per slice.
import { clamp, clamp01 } from '../utils/math.js';

// Same neutrals `_drawShoulders` argues for (BiomeManager.js): an ARCTIC
// blue and a SOLAR orange both just want their lit face caught and their
// shaded face darker. Tinted relief would muddy whatever the sky already
// did, across seventeen palettes.
export const RELIEF_LIT = '#ece4d6';
export const RELIEF_SHADE = '#000000';
// Peak coefficients sit below the mountains' own crest-catch / foot-sink
// (0.17 / 0.32). The ground is nearer and larger, and the gradient fill
// now shades a continuous band rather than ten coarse columns, so equal
// numbers would read as *more*.
export const RELIEF_LIT_ALPHA = 0.12;
export const RELIEF_SHADE_ALPHA = 0.22;
// How far below the ridge the relief dies. Concentrates the shading on
// the surface (so it reads as a catch, not a wall of tint) and confines
// any residual discontinuity to a thin band.
export const RELIEF_FALLOFF_PX = 72;
// Sub-slice sample spacing. ~9 samples per 90px GroundField slice; dense
// enough that a linear gradient between them is visually continuous.
export const RELIEF_SAMPLE_PX = 10;
// Crest stroke: today's uniform 0.18, modulated by facing so the rim of
// each hump brightens on the sun's side and dims on the other.
export const CREST_BASE_ALPHA = 0.18;
export const CREST_FACING_K = 0.85;
// Footing AO (the contact seam _drawTerrainFooting strokes, separate from
// the crest above): same sign convention as the shade half of the relief
// body -- more occlusion turned away from the light -- but a softer swing,
// since this is a seam, not the rim itself.
export const FOOTING_FACING_K = 0.5;

/**
 * Per-bar surface facing against a light, for the ground ridge.
 * @param {{x:number,width:number,y:number}[]} bars  GroundField.visibleBars() output (screen space)
 * @param {{x:number,y:number,intensity?:number}|null} light
 * @returns {number[]} one value per bar in -1..1: +1 fully facing the light,
 *   -1 fully turned away, 0 edge-on. All zeros when `light` is null/degenerate,
 *   which is what makes every consumer's "no light" path the current look.
 */
export function terrainFacing(bars, light) {
  const n = bars ? bars.length : 0;
  const out = new Array(n).fill(0);
  if (!n) return out;
  const prepared = prepareLight(light);
  if (!prepared) return out;

  for (let i = 0; i < n; i++) {
    const prev = bars[Math.max(0, i - 1)];
    const next = bars[Math.min(n - 1, i + 1)];
    const tx = (next.x + next.width * 0.5) - (prev.x + prev.width * 0.5);
    const ty = next.y - prev.y;
    const bar = bars[i];
    out[i] = facingFromTangent(
      bar.x + bar.width * 0.5, bar.y, tx, ty, prepared.light, prepared.intensity,
    );
  }
  return out;
}

/**
 * Sample the same quadratic-midpoint ridge `_terrainTopPath` draws
 * (BiomeManager.js). Each segment's control point is the bar-top sample
 * itself and its endpoint is the midpoint to the next sample -- a
 * render-only smooth; GroundField.heightAt stays the discrete spring.
 *
 * @param {{x:number,width:number,y:number}[]} bars
 * @param {number} [stepPx]
 * @returns {{x:number,y:number,tx:number,ty:number}[]}
 */
export function sampleTerrainCurve(bars, stepPx = RELIEF_SAMPLE_PX) {
  if (!bars || bars.length === 0) return [];
  const pts = bars.map((b) => ({ x: b.x + b.width * 0.5, y: b.y }));
  if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y, tx: 1, ty: 0 }];
  const segs = ridgeSegments(pts);
  const xStart = pts[0].x;
  const xEnd = pts[pts.length - 1].x;
  const span = xEnd - xStart;
  if (!(span > 0) || segs.length === 0) {
    return pts.map((p, i) => {
      const nxt = pts[Math.min(pts.length - 1, i + 1)];
      const prv = pts[Math.max(0, i - 1)];
      return { x: p.x, y: p.y, tx: nxt.x - prv.x, ty: nxt.y - prv.y };
    });
  }
  const step = stepPx > 0 ? stepPx : RELIEF_SAMPLE_PX;
  const nSteps = Math.max(1, Math.round(span / step));
  const out = new Array(nSteps + 1);
  for (let i = 0; i <= nSteps; i++) {
    const x = i === nSteps ? xEnd : xStart + (span * i) / nSteps;
    out[i] = evalRidge(segs, x);
  }
  return out;
}

/**
 * Facing along a sampled curve. Same contract as terrainFacing: all zeros
 * without a usable light, values in -1..1, scaled by intensity.
 * @param {{x:number,y:number,tx:number,ty:number}[]} samples
 * @param {{x:number,y:number,intensity?:number}|null} light
 * @returns {number[]}
 */
export function curveFacing(samples, light) {
  const n = samples ? samples.length : 0;
  const out = new Array(n).fill(0);
  if (!n) return out;
  const prepared = prepareLight(light);
  if (!prepared) return out;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    out[i] = facingFromTangent(s.x, s.y, s.tx, s.ty, prepared.light, prepared.intensity);
  }
  return out;
}

/**
 * Linear depth fade for the relief body. 1 on the ridge, 0 at and beyond
 * `falloffPx`. The draw uses this as the cover-repaint's complement so
 * the shading dies inside the falloff band rather than tinting the
 * ground to the bottom of the frame.
 */
export function reliefDepthFade(depthPx, falloffPx = RELIEF_FALLOFF_PX) {
  if (!(falloffPx > 0)) return 0;
  if (!(depthPx > 0)) return 1;
  return clamp01(1 - depthPx / falloffPx);
}

/**
 * Colour-stop list for a Canvas linear gradient along x in [x0, x1].
 * `crest` (the rim stroke's white-alpha modulation) is the only channel
 * this codebase actually draws with today -- the ground body's own fill
 * uses reliefLitStripRGBA/reliefShadeStripRGBA below instead, a per-pixel
 * strip rather than a gradient, for the same reason those exist (a many-
 * stop CanvasGradient can still grow a hard cut when neighbouring stops
 * collapse). `lit`/`shade` are kept as tested, working pure functions for
 * any future gradient-based consumer, but nothing currently calls them.
 *
 * `footing` is the AO seam _drawTerrainFooting strokes: `baseAlpha` is that
 * pass's own uniform alpha (there are several, at different widths), scaled
 * down where the surface faces the light and up where it turns away --
 * `baseAlpha` unmodulated (facing 0) reproduces today's flat stroke exactly.
 *
 * @param {{x:number}[]} samples
 * @param {number[]} facing
 * @param {number} x0
 * @param {number} x1
 * @param {'lit'|'shade'|'crest'|'footing'} channel
 * @param {number} [baseAlpha] footing only: the pass's own uniform alpha
 * @param {number} [facingK] footing only: swing amount, defaults to FOOTING_FACING_K
 * @returns {{offset:number, color:string}[]}
 */
export function facingColorStops(samples, facing, x0, x1, channel, baseAlpha = 0, facingK = FOOTING_FACING_K) {
  const span = x1 - x0;
  if (!(span > 0) || !samples || samples.length === 0) return [];
  const n = Math.min(samples.length, facing ? facing.length : 0);
  if (!n) return [];

  const colorAt = (i) => {
    const f = facing[clamp(i, 0, n - 1)] || 0;
    if (channel === 'lit') {
      return `rgba(236,228,214,${(RELIEF_LIT_ALPHA * Math.max(0, f)).toFixed(3)})`;
    }
    if (channel === 'shade') {
      return `rgba(0,0,0,${(RELIEF_SHADE_ALPHA * Math.max(0, -f)).toFixed(3)})`;
    }
    if (channel === 'footing') {
      const a = clamp01(baseAlpha * (1 - facingK * f));
      return `rgba(0,0,0,${a.toFixed(3)})`;
    }
    const a = CREST_BASE_ALPHA * (1 + CREST_FACING_K * f);
    return `rgba(255,255,255,${Math.max(0, a).toFixed(3)})`;
  };

  const stops = [];
  let last = -1;
  const push = (offset, color) => {
    let o = clamp(offset, 0, 1);
    if (o < last) return;
    if (o === last) o = Math.min(1, last + 1e-6);
    if (o < last) return;
    last = o;
    stops.push({ offset: o, color });
  };

  push(0, colorAt(0));
  for (let i = 0; i < n; i++) {
    push((samples[i].x - x0) / span, colorAt(i));
  }
  push(1, colorAt(n - 1));
  return stops;
}

function prepareLight(light) {
  if (!light || !Number.isFinite(light.x) || !Number.isFinite(light.y)) return null;
  const intensity = clamp01(light.intensity ?? 1);
  if (!(intensity > 0)) return null;
  return { light, intensity };
}

function facingFromTangent(cx, cy, tx, ty, light, intensity) {
  // Degenerate (single bar, or a run of identical points): no tangent,
  // so no lean -- edge-on, same as flat.
  if (tx === 0 && ty === 0) return 0;

  // Rotate the tangent to the outward (air-facing) normal. Canvas y
  // grows downward and the solid is *below* the curve, so the outward
  // normal is the one with the negative y component: (ty, -tx).
  let nx = ty;
  let ny = -tx;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const nLen = Math.hypot(nx, ny) || 1;
  nx /= nLen;

  const lx = light.x - cx;
  const ly = light.y - cy;
  const lLen = Math.hypot(lx, ly) || 1;
  // Horizontal component only: a flat ridge (nx == 0) stays 0 even
  // with the sun directly overhead, which is the regression the first
  // test pins down. Intensity fades the whole field with the light
  // (the coda's unravel already drives intensity to 0).
  const facing = clamp(nx * (lx / lLen), -1, 1) * intensity;
  return facing || 0; // collapse -0 so "exactly 0" assertions stay honest
}

/**
 * Piecewise description of `_terrainTopPath`'s open ridge:
 *   moveTo(pts[0])
 *   for i in 0..n-2: quadraticCurveTo(pts[i], midpoint(pts[i], pts[i+1]))
 *   lineTo(pts[n-1])
 * which is a straight run from pts[0] to mid(0,1), a quadratic through
 * each interior sample, and a straight run from mid(n-2,n-1) to pts[n-1].
 */
function ridgeSegments(pts) {
  const segs = [];
  const n = pts.length;
  if (n < 2) return segs;
  const mid = (a, b) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
  segs.push({
    x0: pts[0].x, y0: pts[0].y,
    x1: mid(pts[0], pts[1]).x, y1: mid(pts[0], pts[1]).y,
    quad: false,
  });
  for (let i = 1; i < n - 1; i++) {
    const p0 = mid(pts[i - 1], pts[i]);
    const p1 = pts[i];
    const p2 = mid(pts[i], pts[i + 1]);
    segs.push({
      x0: p0.x, y0: p0.y,
      cx: p1.x, cy: p1.y,
      x1: p2.x, y1: p2.y,
      quad: true,
    });
  }
  segs.push({
    x0: mid(pts[n - 2], pts[n - 1]).x, y0: mid(pts[n - 2], pts[n - 1]).y,
    x1: pts[n - 1].x, y1: pts[n - 1].y,
    quad: false,
  });
  return segs;
}

function evalRidge(segs, x) {
  let seg = segs[0];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (x <= s.x1 || i === segs.length - 1) { seg = s; break; }
  }
  if (!seg.quad) {
    const dx = seg.x1 - seg.x0;
    const t = Math.abs(dx) < 1e-9 ? 0 : clamp((x - seg.x0) / dx, 0, 1);
    return {
      x,
      y: seg.y0 + (seg.y1 - seg.y0) * t,
      tx: dx,
      ty: seg.y1 - seg.y0,
    };
  }
  const t = quadTForX(seg, x);
  const mt = 1 - t;
  const y = mt * mt * seg.y0 + 2 * mt * t * seg.cy + t * t * seg.y1;
  // B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1)
  const tx = 2 * mt * (seg.cx - seg.x0) + 2 * t * (seg.x1 - seg.cx);
  const ty = 2 * mt * (seg.cy - seg.y0) + 2 * t * (seg.y1 - seg.cy);
  return { x, y, tx, ty };
}

function quadTForX(seg, x) {
  // x(t) = (1-t)² x0 + 2(1-t)t cx + t² x1
  //      = x0 + 2(cx-x0)t + (x0 - 2cx + x1)t²
  const a = seg.x0 - 2 * seg.cx + seg.x1;
  const b = 2 * (seg.cx - seg.x0);
  const c = seg.x0 - x;
  if (Math.abs(a) < 1e-9) {
    const dx = seg.x1 - seg.x0;
    return Math.abs(dx) < 1e-9 ? 0 : clamp((x - seg.x0) / dx, 0, 1);
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return clamp((x - seg.x0) / (seg.x1 - seg.x0 || 1), 0, 1);
  const sqrt = Math.sqrt(disc);
  const t1 = (-b + sqrt) / (2 * a);
  const t2 = (-b - sqrt) / (2 * a);
  const inRange = (t) => t >= -1e-6 && t <= 1 + 1e-6;
  if (inRange(t1) && !inRange(t2)) return clamp(t1, 0, 1);
  if (inRange(t2) && !inRange(t1)) return clamp(t2, 0, 1);
  if (inRange(t1) && inRange(t2)) {
    const mid = 0.5;
    return Math.abs(t1 - mid) < Math.abs(t2 - mid) ? clamp(t1, 0, 1) : clamp(t2, 0, 1);
  }
  return clamp((x - seg.x0) / (seg.x1 - seg.x0 || 1), 0, 1);
}

/**
 * Facing at a screen x, linearly interpolated between curve samples.
 * Edge-clamped. 0 when there is no curve.
 */
export function facingAtX(samples, facing, x) {
  const n = samples && facing ? Math.min(samples.length, facing.length) : 0;
  if (!n) return 0;
  if (x <= samples[0].x) return facing[0] || 0;
  if (x >= samples[n - 1].x) return facing[n - 1] || 0;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].x <= x) lo = mid; else hi = mid;
  }
  const x0 = samples[lo].x, x1 = samples[hi].x;
  const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  const f0 = facing[lo] || 0, f1 = facing[hi] || 0;
  return f0 + (f1 - f0) * t;
}

/**
 * 1×N RGBA strip of the relief body's LIT half only (shade pixels are
 * fully transparent here — see reliefShadeStripRGBA for the other half).
 * Split in two because they draw under different composite operations:
 * this one is a warm-white catch-light, meant to ADD brightness, so it
 * belongs under the default/'lighter' compositing the caller already
 * uses for glow. Painting a strip and stretching it (rather than a
 * CanvasGradient with a stop per sample) is what keeps the fill
 * continuous — a many-stop gradient was still capable of a hard vertical
 * cut when neighbouring stops collapsed.
 */
export function reliefLitStripRGBA(samples, facing, width) {
  const n = Math.max(0, width | 0);
  const out = new Uint8ClampedArray(n * 4);
  if (!n) return out;
  for (let x = 0; x < n; x++) {
    const f = facingAtX(samples, facing, x);
    const o = x * 4;
    out[o] = 236;
    out[o + 1] = 228;
    out[o + 2] = 214;
    out[o + 3] = f > 0 ? Math.round(RELIEF_LIT_ALPHA * f * 255) : 0;
  }
  return out;
}

/**
 * 1×N RGBA strip of the relief body's SHADE half — genuine multiply
 * occlusion instead of an alpha-blended black wash. A translucent-black
 * pixel composited under the default source-over is indistinguishable
 * from the same pixel under 'multiply': both reduce to
 * `result = destination*(1-alpha)`, since multiplying by black (0) is 0
 * regardless of alpha. That's why the old combined strip could only ever
 * wash the ground toward black, never darken it while keeping its own
 * hue -- which is what made it read flat.
 *
 * The fix carries the darkening amount in the PIXEL'S OWN GRAY VALUE
 * instead of its alpha, with alpha pinned to 255 everywhere: under
 * 'multiply', `result = destination * (gray/255)`, a genuine proportional
 * darken that preserves whatever hue the surface already had. Alpha
 * stays fully opaque throughout (255 even where there's no shade at all,
 * gray=255 there too, so multiplying by white is a no-op) specifically
 * so the strip is continuous in the channel that actually carries the
 * signal now (gray) — varying alpha instead would just re-import the
 * same discontinuity risk in a different channel.
 */
export function reliefShadeStripRGBA(samples, facing, width) {
  const n = Math.max(0, width | 0);
  const out = new Uint8ClampedArray(n * 4);
  if (!n) return out;
  for (let x = 0; x < n; x++) {
    const f = facingAtX(samples, facing, x);
    const o = x * 4;
    const shadeStrength = RELIEF_SHADE_ALPHA * Math.max(0, -f);
    const g = Math.max(0, Math.min(255, Math.round(255 * (1 - shadeStrength))));
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
  return out;
}

