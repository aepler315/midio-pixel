// The sun and the moon on the smooth, output-resolution Range sky.
//
// Per frame the sun costs three gradient fills over bounded rects and the
// moon one gradient (only at night) plus one drawImage. The moon's lit face
// is a small texture baked per quantum of phase, sun angle, horizon tint and
// night into the sky's accounted canvas buffers; nothing is read back.
import { MOON_MIN_ILLUMINATION } from './RangeSkyComposition.js';

const TAU = Math.PI * 2;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const hash = (x, y, seed) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
};
function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy;
  const a = u * u * (3 - 2 * u), b = v * v * (3 - 2 * v);
  const top = hash(ix, iy, seed) * (1 - a) + hash(ix + 1, iy, seed) * a;
  const bottom = hash(ix, iy + 1, seed) * (1 - a) + hash(ix + 1, iy + 1, seed) * a;
  return top * (1 - b) + bottom * b;
}
const fbm = (x, y, s) => noise(x, y, s) * .5 + noise(x * 2.1, y * 2.1, s + 1) * .27
  + noise(x * 4.3, y * 4.3, s + 2) * .15 + noise(x * 8.9, y * 8.9, s + 3) * .08;

/** True altitude in degrees: tour bodies carry a world direction; rail
 *  bodies fall back to the sun's arc span over altitude01. */
export function bodyAltitudeDeg(body, spanDeg = 32) {
  const d = body?.worldDirection;
  return d ? Math.asin(clamp(d[1], -1, 1)) * 180 / Math.PI : spanDeg * (body?.altitude01 ?? .5);
}
/** Artistic atmospheric extinction: 0 high in the sky, 1 on the horizon. */
const lowness = altDeg => 1 - smooth(0, 12, altDeg);
/** Refraction squashes a disc on the horizon. */
const flattening = altDeg => 1 - .17 * (1 - smooth(0, 3, altDeg));
/** The tour compresses the lunar arc to a few degrees only to keep it in a
 *  narrow lens; extinction reads altitude01 on an uncompressed arc so a
 *  moon framed low over the skyline does not stay orange all song. */
const moonShadeAltitudeDeg = moon => 60 * (moon?.altitude01 ?? .5);
/** The moon's horizon tint never reaches the sun's. */
const MOON_TINT_CAP = .6;
/** How much a storm deck of `amount` (frame.storm.amount, the slate wash
 *  drawStormSky lays over the bodies) hides a body's clear-sky look: from a
 *  hazy deck, gone by the half-dense one. */
export const bodyVeil = amount => smooth(.12, .55, clamp(amount));
/** How much of the veiled body the deck swallows, down to a patch of light. */
const deckThickness = amount => smooth(.5, .95, clamp(amount));
/** The sun disc's opacity over its horizon visibility: solid until the last
 *  of the waterline fade... */
export const sunDiscAlpha = vis => smooth(0, .2, vis);
/** ...and its brightness, dimming as it sinks through the band. */
export const sunDiscDim = vis => .55 + .45 * smooth(0, .6, vis);
const sunRadius = (sun, width, height) => Math.max(height * .006, (sun.radiusFrac || 0) * width);

// Quanta for the lit texture: illumination, sun angle (2 degrees), horizon
// tint and night. The key is one number, so a steady moon costs no rebake
// and no per-frame string.
const PHASE_STEPS = 160, ANGLE_STEPS = 180, TINT_STEPS = 20, NIGHT_STEPS = 8;

// Fixed near side (x right, y down, unit disc): the Moon everyone knows.
// [centre x, centre y, radius x, radius y, depth] per mare.
const MARIA = [
  [-.34, -.36, .36, .28, 1], [.17, -.38, .21, .19, 1], [.34, -.06, .27, .22, .95],
  [.64, -.24, .13, .11, 1], [.52, .20, .16, .14, .8], [.32, .33, .13, .10, .7],
  [-.66, .02, .30, .50, .9], [-.16, .30, .21, .16, .75], [-.46, .44, .14, .12, .8],
  [.02, -.10, .13, .10, .65], [-.06, -.68, .36, .09, .55],
];
// Young bright craters [x, y, radius, gain]: Tycho, Copernicus, Kepler.
const TYCHO = [-.12, .72];
const BRIGHT_CRATERS = [[TYCHO[0], TYCHO[1], .035, .35], [-.30, -.12, .03, .22], [-.52, -.10, .018, .2]];

/** Albedo of the near side, with no lighting baked in (shading is applied
 *  per phase): highland mottling, darker maria with ragged shores, fine
 *  grain, bright young craters and Tycho's faint rays. No crater rings and
 *  no fake limb darkening, which made the old face read as a marble. */
function albedoAt(nx, ny) {
  let m = 0;
  for (const [cx, cy, rx, ry, depth] of MARIA) {
    const qx = (nx - cx) / rx, qy = (ny - cy) / ry;
    m += depth * Math.exp(-(qx * qx + qy * qy) * 1.15);
  }
  m = smooth(.30, .85, m + (fbm(nx * 3.4 + 9, ny * 3.4 + 4, 41) - .5) * .6);
  let albedo = 1 + (fbm(nx * 5 + 2, ny * 5 + 7, 7) - .5) * .16;
  albedo *= 1 - .36 * m;
  albedo += (noise(nx * 16, ny * 16, 3) - .5) * .05 + (noise(nx * 34, ny * 34, 5) - .5) * .025;
  for (const [cx, cy, r, gain] of BRIGHT_CRATERS) {
    const dx = (nx - cx) / r, dy = (ny - cy) / r;
    albedo += gain * Math.exp(-(dx * dx + dy * dy));
  }
  const tx = nx - TYCHO[0], ty = ny - TYCHO[1], td = Math.hypot(tx, ty), ta = Math.atan2(ty, tx);
  const ray = Math.max(0, Math.cos(ta * 7 + 1.3) * Math.cos(ta * 11)) ** 6;
  return albedo + .10 * ray * Math.exp(-td * 1.6) * smooth(.04, .12, td);
}

/** Everything about the face that does not depend on the light, per texture
 *  size: albedo, the view-facing normal, terminator relief and limb alpha. */
function bakeFace(size) {
  const n = size * size, half = size / 2;
  const face = { size, albedo: new Float32Array(n), nz: new Float32Array(n), relief: new Float32Array(n),
    edge: new Uint8ClampedArray(n), image: null };
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
    const nx = (x + .5) / half - 1, ny = (y + .5) / half - 1, r2 = nx * nx + ny * ny;
    if (r2 >= 1.02) continue;
    face.albedo[i] = albedoAt(nx, ny);
    face.nz[i] = Math.sqrt(Math.max(0, 1 - r2));
    // A little relief roughens the terminator the way real topography does.
    face.relief[i] = (noise(nx * 22, ny * 22, 9) - .5) * .07;
    face.edge[i] = clamp((1 - Math.sqrt(r2)) * half + .5) * 255; // 1-texel anti-aliased limb
  }
  return face;
}

const WHITE_HOT = [255, 253, 246], WHITE = [255, 255, 252], EMBER = [232, 80, 34];
const GLARE = [255, 246, 228], BLOOM = [255, 252, 240], DAY_SUN = [255, 243, 223];
// Light through cloud: the sun a warm white that lights the deck broadly
// (what tells it from a hazy moon in a storm-dark sky), the moon a grey-blue.
const VEILED_SUN = [255, 247, 226], VEILED_MOON = [196, 204, 220];
const mixInto = (out, a, b, t) => {
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};
const rgba = (c, alpha) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;

export class CelestialPainter {
  /** `buffers` is the sky's CanvasBuffers: the lit moon is accounted there. */
  constructor({ buffers }) {
    this.buffers = buffers;
    this.faces = new Map();
    this.litKeys = new WeakMap();
    this.moonSize = 0;
    this.bakes = 0;
    // Per-frame scratch: no arrays or disc objects are allocated per draw.
    this.disc = { visible: false, x: 0, y: 0, r: 0, cover: 0, strength: 0, illumination: 0 };
    this._tintHex = null;
    this._tint = [...DAY_SUN];
    this._core = [0, 0, 0]; this._limb = [0, 0, 0]; this._centre = [0, 0, 0];
    this._glare = [0, 0, 0]; this._bloom = [0, 0, 0];
  }

  /** The moon disc this frame (shared with the star cut-out), in the sky's
   *  logical coordinates. `cover` is how opaque the body is (its fade);
   *  `strength` is how bright its light reads against the sky. */
  prepareMoon(moon, width, height, night, phase01 = .5) {
    const disc = this.disc;
    disc.visible = false;
    if (!moon || moon.visible === false || !(moon.altitude01 > .001)) return disc;
    // An authored Landscape moon carries discAlpha: zero while the sun is up.
    const cover = clamp(moon.discAlpha ?? moon.visibility ?? 1), r = (moon.radiusFrac || 0) * width;
    if (cover < .01 || !(r > 0)) return disc;
    const f = Math.max(MOON_MIN_ILLUMINATION, moon.illumination ?? .5 - .5 * Math.cos(TAU * clamp(phase01)));
    disc.visible = true; disc.x = moon.xFrac * width; disc.y = moon.yFrac * height; disc.r = r;
    disc.cover = cover; disc.illumination = f;
    // Daylight lowers a real moon's contrast, and a thin day crescent is faint.
    disc.strength = cover * (night + (1 - night) * .6 * (.35 + .65 * smooth(.1, .5, f)));
    return disc;
  }

  _sunTint(hex) {
    if (hex !== this._tintHex) {
      this._tintHex = hex;
      const ok = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex);
      for (let i = 0; i < 3; i++) this._tint[i] = ok ? parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) : DAY_SUN[i];
    }
    return this._tint;
  }

  /** A white-hot, limb-darkened disc in a glare that brightens the sky
   *  toward white (screen, never grey), warming and flattening toward the
   *  horizon. The glare fades over the horizon band; the disc stays solid
   *  down to the waterline, since the land in front is what hides a setting
   *  sun (a see-through disc behind a ridge read as a pale moon). A storm
   *  deck (`storm`, its amount) takes the hard disc and the clear-sky glare
   *  away as it thickens: drawVeiledSun paints the sun over the deck. */
  drawSun(ctx, sun, width, height, storm = 0) {
    if (!sun || sun.visible === false || !(sun.altitude01 > 0)) return;
    const vis = clamp(sun.visibility ?? 1), clear = 1 - bodyVeil(storm);
    if (vis < .01 || clear < .01) return;
    const x = sun.xFrac * width, y = sun.yFrac * height, radius = sunRadius(sun, width, height);
    const alt = bodyAltitudeDeg(sun), low = lowness(alt);
    // colorHex is the biome's sun, already reddened toward the horizon.
    const tint = this._sunTint(sun.colorHex);
    const core = mixInto(this._core, WHITE_HOT, tint, low ** 1.3);
    // A high sun's limb only leans to its colour (at full strength it ringed
    // the white disc); low down it is the colour, reddening to ember.
    const limb = mixInto(this._limb, mixInto(this._limb, WHITE_HOT, tint, .5 + .5 * low), EMBER, .45 * low);
    const centre = mixInto(this._centre, WHITE, core, low ** .7);
    const glare = mixInto(this._glare, GLARE, tint, .25 + .75 * low);
    const bloom = mixInto(this._bloom, BLOOM, core, low);
    // Sinking through its horizon band the disc dims as a setting sun does,
    // staying solid (sunDiscAlpha); a see-through disc read as a ghost.
    const dim = sunDiscDim(vis);
    for (const c of [core, limb, centre]) { c[0] *= dim; c[1] *= dim; c[2] *= dim; }
    const k = vis * clear;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const G = height * (.26 + .14 * low);
    let g = ctx.createRadialGradient(x, y, 0, x, y, G);
    g.addColorStop(0, rgba(glare, .55 * k)); g.addColorStop(.06, rgba(glare, .30 * k));
    g.addColorStop(.25, rgba(glare, .09 * k)); g.addColorStop(1, rgba(glare, 0));
    ctx.fillStyle = g; ctx.fillRect(x - G, y - G, 2 * G, 2 * G); // bounded, never the whole frame
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = sunDiscAlpha(vis) * clear;
    ctx.save();
    ctx.translate(x, y); ctx.scale(1, flattening(alt));
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius); // limb darkening, warmer at the edge
    g.addColorStop(0, rgba(centre, 1)); g.addColorStop(.7 - .1 * low, rgba(core, 1)); g.addColorStop(1, rgba(limb, 1));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.fill();
    ctx.restore();
    // A tight bloom AFTER the disc softens its limb the way glare does. It
    // falls from the centre outward with no step at the limb (one starting
    // at the limb ringed the disc), in the core's hue low down.
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'screen';
    const B = radius * 3.2, b = k * (1 - .55 * low);
    g = ctx.createRadialGradient(x, y, 0, x, y, B);
    g.addColorStop(0, rgba(bloom, .42 * b)); g.addColorStop(.31, rgba(bloom, .26 * b));
    g.addColorStop(.5, rgba(bloom, .09 * b)); g.addColorStop(1, rgba(bloom, 0));
    ctx.fillStyle = g; ctx.fillRect(x - B, y - B, 2 * B, 2 * B);
    ctx.restore();
  }

  /** The sun through the storm deck, painted over it (screen): through a
   *  thin deck a pale, soft-edged disc, as through altostratus, in a broad
   *  patch of brighter cloud; under the full deck only the patch, faint.
   *  Never a hard disc, which under the deck's slate read as a grey moon. */
  drawVeiledSun(ctx, sun, width, height, storm = 0) {
    const veil = bodyVeil(storm);
    if (veil < .01 || !sun || sun.visible === false || !(sun.altitude01 > 0)) return;
    const vis = clamp(sun.visibility ?? 1);
    if (vis < .01) return;
    const x = sun.xFrac * width, y = sun.yFrac * height, radius = sunRadius(sun, width, height);
    const alt = bodyAltitudeDeg(sun), low = lowness(alt);
    const c = mixInto(this._glare, VEILED_SUN, this._sunTint(sun.colorHex), .55 * low);
    const thick = deckThickness(storm);
    const patch = veil * vis * (.7 - .45 * thick), disc = veil * vis * (1 - thick);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const G = height * (.36 + .1 * thick);
    let g = ctx.createRadialGradient(x, y, 0, x, y, G);
    g.addColorStop(0, rgba(c, .5 * patch)); g.addColorStop(.15, rgba(c, .24 * patch));
    g.addColorStop(.5, rgba(c, .06 * patch)); g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g; ctx.fillRect(x - G, y - G, 2 * G, 2 * G);
    if (disc > .01) {
      // The disc's edge blurs out to 1.9 radii: diffused, not cut.
      const S = radius * 1.9;
      ctx.translate(x, y); ctx.scale(1, flattening(alt));
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, S);
      g.addColorStop(0, rgba(c, .82 * disc)); g.addColorStop(.4, rgba(c, .74 * disc));
      g.addColorStop(.56, rgba(c, .34 * disc)); g.addColorStop(.75, rgba(c, .08 * disc)); g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g; ctx.fillRect(-S, -S, 2 * S, 2 * S);
    }
    ctx.restore();
  }

  /** The moon through the storm deck, over it: a soft glow where a thin
   *  deck lets its light through, and nothing under the full deck. */
  drawVeiledMoon(ctx, moon, width, height, night, phase01 = .5, storm = 0) {
    const veil = bodyVeil(storm);
    if (veil < .01) return;
    const disc = this.prepareMoon(moon, width, height, night, phase01);
    if (!disc.visible) return;
    const { x, y, r, illumination: f, strength } = disc;
    const k = veil * (1 - deckThickness(storm)) * strength * (.25 + .75 * f);
    if (k < .01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const S = r * 2.6;
    const g = ctx.createRadialGradient(x, y, 0, x, y, S);
    g.addColorStop(0, rgba(VEILED_MOON, .5 * k)); g.addColorStop(.3, rgba(VEILED_MOON, .38 * k));
    g.addColorStop(.45, rgba(VEILED_MOON, .12 * k)); g.addColorStop(1, rgba(VEILED_MOON, 0));
    ctx.fillStyle = g; ctx.fillRect(x - S, y - S, 2 * S, 2 * S);
    ctx.restore();
  }

  /** The moon: its lit face screened onto the sky with no backing disc, so
   *  the dark side is sky (earthshine only at night) and a daytime moon is
   *  pale and low in contrast; a soft aureole at night. A storm deck takes
   *  the face away as it thickens (drawVeiledMoon paints over the deck). */
  drawMoon(ctx, moon, sun, width, height, night, phase01 = .5, outputScale = 1, storm = 0) {
    const disc = this.prepareMoon(moon, width, height, night, phase01);
    const clear = 1 - bodyVeil(storm);
    if (!disc.visible || clear < .01) return;
    const { x, y, r, illumination: f } = disc, strength = disc.strength * clear;
    const alt = moonShadeAltitudeDeg(moon), low = Math.min(MOON_TINT_CAP, lowness(alt));
    const light = moon.illuminant || sun;
    const angle = light ? Math.atan2((light.yFrac - moon.yFrac) * height, (light.xFrac - moon.xFrac) * width) : Math.atan2(height, width);
    // Sticky power-of-two size: the water mirror draws the same sky smaller
    // in the same frame and reuses this texture instead of rebaking.
    const cap = outputScale > 2.4 ? 256 : 128;
    const want = Math.min(cap, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, 2 * r * outputScale)))));
    this.moonSize = Math.max(this.moonSize, want);
    const texture = this._litMoon(this.moonSize, f, angle, low, night);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    if (night > .05) {
      const A = r * 3.4, k = .17 * night * disc.cover * clear * f ** 1.5;
      const g = ctx.createRadialGradient(x, y, r * .95, x, y, A);
      g.addColorStop(0, `rgba(200,214,236,${k})`); g.addColorStop(.3, `rgba(190,206,232,${k * .3})`); g.addColorStop(1, 'rgba(190,206,232,0)');
      ctx.fillStyle = g; ctx.fillRect(x - A, y - A, 2 * A, 2 * A);
    }
    ctx.globalAlpha = strength;
    ctx.translate(x, y); ctx.scale(1, flattening(alt));
    if (texture) ctx.drawImage(texture, -r, -r, r * 2, r * 2);
    else {
      // Storage refused: a plain lit disc, still screened (no dark hole).
      ctx.globalAlpha = strength * f;
      ctx.fillStyle = 'rgb(238,236,226)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  _face(size) {
    let face = this.faces.get(size);
    if (!face) { face = bakeFace(size); this.faces.set(size, face); }
    return face;
  }

  /** The lit face for one quantum. Lommel-Seeliger shading: a flat full
   *  moon and a soft natural terminator, with earthshine (strongest at thin
   *  crescents) only at night. Rebakes only when the quantum changes. */
  _litMoon(size, f, angle, low, night) {
    const canvas = this.buffers.ensure('moon-lit', size, size);
    if (!canvas) return null;
    const fq = Math.round(f * PHASE_STEPS), tq = Math.round(low * TINT_STEPS), nq = Math.round(clamp(night) * NIGHT_STEPS);
    const aq = ((Math.round(angle * ANGLE_STEPS / TAU) % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
    const key = ((fq * ANGLE_STEPS + aq) * (TINT_STEPS + 1) + tq) * (NIGHT_STEPS + 1) + nq;
    if (this.litKeys.get(canvas) === key) return canvas;
    const face = this._face(size), ctx = canvas.getContext('2d');
    face.image ||= ctx.createImageData(size, size);
    const px = face.image.data, half = size / 2;
    const phase = fq / PHASE_STEPS, a = aq * TAU / ANGLE_STEPS, tint = tq / TINT_STEPS;
    const phaseAngle = Math.acos(clamp(2 * phase - 1, -1, 1)); // 0 full, pi new
    const sx = Math.sin(phaseAngle) * Math.cos(a), sy = Math.sin(phaseAngle) * Math.sin(a), sz = Math.cos(phaseAngle);
    const earthshine = .085 * (1 - phase) ** 2 * (nq / NIGHT_STEPS);
    const dim = 1 - .35 * tint, lit = .86 + .14 * phase;
    const tr = (238 + 17 * tint) * dim, tg = (236 - 58 * tint) * dim, tb = (226 - 108 * tint) * dim;
    const { albedo, nz, relief, edge } = face;
    for (let y = 0, i = 0; y < size; y++) {
      const ny = (y + .5) / half - 1;
      for (let x = 0; x < size; x++, i++) {
        const o = i * 4, alpha = edge[i];
        if (!alpha) { px[o + 3] = 0; continue; }
        const nx = (x + .5) / half - 1, mu = nz[i];
        const mu0 = nx * sx + ny * sy + mu * sz + relief[i];
        const ls = mu0 > 0 ? Math.min(1, (2 * mu0 / (mu0 + mu + 1e-4)) ** .7) : 0;
        const L = albedo[i] * (ls * lit + earthshine);
        px[o] = tr * L; px[o + 1] = tg * L; px[o + 2] = tb * L; px[o + 3] = alpha;
      }
    }
    ctx.putImageData(face.image, 0, 0);
    this.litKeys.set(canvas, key);
    this.bakes++;
    return canvas;
  }

  /** A new song or disposal: storage is released by the owner's buffers. */
  reset() {
    this.litKeys = new WeakMap();
    this.moonSize = 0;
  }

  dispose() {
    this.reset();
    this.faces.clear();
  }
}
