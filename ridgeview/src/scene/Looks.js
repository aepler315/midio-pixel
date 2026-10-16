// Visual modes and their transitions. Four independent axes:
//   light    where the sun (or moon) is: alpenglow, golden hour, midday,
//            raking light, backlit, blue hour, moonlight
//   weather  snowline, foliage, wetness, haze and cloud decks
//   style    natural or a stylized render (contours, engraving, atlas
//            tint, hologram, 8-bit)
//   overlay  slope-angle classes, aspect, elevation bands
// Light presets are aimed at the current viewpoint: golden hour lights the
// face you are looking at, backlight puts the sun behind the crest. Sun
// azimuths are kept to what the sun can actually do at that latitude.
// Changing light sweeps the sun across the sky; weather animates (snow
// creeps down the mountain, the cloud sea rises); style and overlay changes
// wipe the new picture over a snapshot of the old one.
import { DEG, clamp, enuBasis, EARTH_RADIUS } from '../core/geo.js';

export const LIGHTS = [
  { id: 'alpenglow', label: 'Alpenglow', key: '1' },
  { id: 'golden', label: 'Golden hour', key: '2' },
  { id: 'midday', label: 'Midday', key: '3' },
  { id: 'raking', label: 'Raking light', key: '4' },
  { id: 'backlit', label: 'Backlit', key: '5' },
  { id: 'bluehour', label: 'Blue hour', key: '6' },
  { id: 'moonlight', label: 'Moonlight', key: '7' },
];
export const WEATHERS = [
  { id: 'summer', label: 'Summer' },
  { id: 'autumn', label: 'Autumn' },
  { id: 'winter', label: 'Winter' },
  { id: 'storm', label: 'Storm' },
  { id: 'cloudsea', label: 'Cloud sea' },
];
export const STYLES = [
  { id: 'natural', label: 'Natural', code: 0 },
  { id: 'contours', label: 'Topo map', code: 1 },
  { id: 'ink', label: 'Engraving', code: 2 },
  { id: 'hypsometric', label: 'Atlas tint', code: 3 },
  { id: 'hologram', label: 'Hologram', code: 4 },
  { id: 'pixel', label: '8-bit', code: 5 },
];
export const OVERLAYS = [
  { id: 'none', label: 'None', code: 0 },
  { id: 'slope', label: 'Slope angle', code: 1 },
  { id: 'aspect', label: 'Aspect', code: 2 },
  { id: 'bands', label: 'Elevation bands', code: 3 },
];

// Colours are sRGB hex; the shader works in linear light.
export const BIOMES = {
  conifer: { forest: '#18301e', grass: '#4a5c30', dry: '#7a7556', rock: '#76736e', rock2: '#575551', soil: '#6d5b47', autumn: '#b88a2c', density: 0.85, dryness: 0.22, floor: -1000, playa: 0 },
  taiga: { forest: '#1b2e22', grass: '#56663a', dry: '#7f7a58', rock: '#77736d', rock2: '#56534f', soil: '#62553f', autumn: '#c49a2a', density: 0.8, dryness: 0.15, floor: -1000, playa: 0 },
  tundra: { forest: '#2b3a29', grass: '#757248', dry: '#8f7f5a', rock: '#716e6a', rock2: '#55524f', soil: '#5d5040', autumn: '#a0492c', density: 0.3, dryness: 0.35, floor: -1000, playa: 0 },
  ice: { forest: '#2a3a2a', grass: '#6e6f48', dry: '#857a5a', rock: '#6f6d6b', rock2: '#4f4e4d', soil: '#5a5045', autumn: '#9a5a2c', density: 0.25, dryness: 0.3, floor: -1000, playa: 0 },
  broadleaf: { forest: '#283f22', grass: '#526e38', dry: '#807d52', rock: '#7a756e', rock2: '#5e5a55', soil: '#66553f', autumn: '#c0521e', density: 0.95, dryness: 0.1, floor: -1000, playa: 0 },
  desert: { forest: '#3b4430', grass: '#9c8a62', dry: '#b9a27a', rock: '#93735b', rock2: '#a5876c', soil: '#b39572', autumn: '#a8843c', density: 0.35, dryness: 0.85, floor: 1950, playa: 1 },
  steppe: { forest: '#2f3e2a', grass: '#8b8758', dry: '#b0a274', rock: '#857a6c', rock2: '#6a6159', soil: '#9c8664', autumn: '#b08a36', density: 0.5, dryness: 0.65, floor: 1800, playa: 1 },
  chaparral: { forest: '#36472b', grass: '#8a8352', dry: '#b4a070', rock: '#8a8074', rock2: '#6c645c', soil: '#9b8364', autumn: '#a8843c', density: 0.65, dryness: 0.6, floor: -1000, playa: 0 },
  'pine-oak': { forest: '#29432a', grass: '#6c7a3e', dry: '#a39468', rock: '#7c756c', rock2: '#5c5650', soil: '#7a6248', autumn: '#a8843c', density: 0.8, dryness: 0.4, floor: 2300, playa: 0 },
};

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLin = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Sunrise azimuth limit at a latitude (deg from north, N hemisphere). */
function azimuthLimit(lat) {
  const s = Math.sin(23.44 * DEG) / Math.cos(Math.min(66, Math.abs(lat)) * DEG);
  return s >= 1 ? 0 : Math.acos(s) / DEG;
}
/** Keep a low-sun azimuth to what the sun can do at this latitude. */
export function feasibleAzimuth(az, lat) {
  az = ((az % 360) + 360) % 360;
  const lim = azimuthLimit(lat);
  if (lat >= 0) return clamp(az, lim, 360 - lim);
  // Southern hemisphere: the sun swings through the north.
  const rel = ((az - 180 + 360) % 360);
  return (clamp(rel, lim, 360 - lim) + 180) % 360;
}

/** Elevation (deg) at which the Earth's shadow line sits at height h (m). */
const shadowLineElevation = (h) => -Math.sqrt((2 * Math.max(0, h)) / EARTH_RADIUS) / DEG;

/**
 * Sun/moon placement for a light preset.
 *   ctx { lat, heading (view direction), ground (eye ground m), summit (m) }
 */
export function lightPlacement(id, ctx) {
  const { lat, heading } = ctx;
  const front = heading + 180; // the sun behind the viewer lights the face we see
  const line = (ctx.ground ?? 1500) + 0.38 * Math.max(300, (ctx.summit ?? 3000) - (ctx.ground ?? 1500));
  switch (id) {
    // Just below the horizon: high summits clear the ranges between them and
    // the sun while those ranges (and the Earth's curve) shade the valleys.
    case 'alpenglow': return { sunAz: feasibleAzimuth(front + 25, lat), sunEl: Math.max(shadowLineElevation(line), -0.5), moonEl: -20, moonAz: 0, exposure: 1.0 };
    case 'golden': return { sunAz: feasibleAzimuth(front + 35, lat), sunEl: 5.5, moonEl: -20, moonAz: 0, exposure: 1.0 };
    case 'midday': return { sunAz: lat >= 0 ? 180 : 0, sunEl: clamp(90 - Math.abs(lat - 20), 25, 75), moonEl: -20, moonAz: 0, exposure: 1.35 };
    case 'raking': {
      const a = feasibleAzimuth(heading + 90, lat), b = feasibleAzimuth(heading - 90, lat);
      const off = (x) => Math.abs(((x - heading + 540) % 360) - 180);
      return { sunAz: Math.abs(off(a) - 90) <= Math.abs(off(b) - 90) ? a : b, sunEl: 14, moonEl: -20, moonAz: 0, exposure: 1.3 };
    }
    case 'backlit': return { sunAz: feasibleAzimuth(heading + 12, lat), sunEl: 3.5, moonEl: -20, moonAz: 0, exposure: 0.85 };
    case 'bluehour': return { sunAz: feasibleAzimuth(front + 20, lat), sunEl: -6.5, moonEl: 12, moonAz: heading - 35, exposure: 2.2, satMul: 0.9, tint: [0.88, 0.95, 1.12] };
    case 'moonlight': return { sunAz: feasibleAzimuth(front, lat), sunEl: -28, moonEl: 32, moonAz: front + 25, exposure: 1.4, satMul: 0.5, tint: [0.78, 0.9, 1.18] };
    default: return lightPlacement('golden', ctx);
  }
}

// High cloud cover by light: a little texture in the sky catches the colour
// of dawn and dusk; midday stays mostly clear.
const HIGH_CLOUDS = { alpenglow: 0.45, golden: 0.4, midday: 0.18, raking: 0.28, backlit: 0.5, bluehour: 0.35, moonlight: 0.25 };

function weatherParams(id, ctx) {
  const base = { snowShift: 0, autumn: 0, wetness: 0, mieMul: 1, rayMul: 1, cloudOn: 0, deckOn: 0, deckCoverage: 0.6, deckDark: 0, stormDark: 0, sunMul: 1, sat: 1.04, contrast: 1.02, exposureMul: 1 };
  const summit = ctx.summit ?? 3000, ground = ctx.ground ?? 1500;
  switch (id) {
    case 'autumn': return { ...base, snowShift: -300, autumn: 1, sat: 1.08 };
    case 'winter': return { ...base, snowShift: -3300, mieMul: 0.7, sat: 0.94, contrast: 1.05 };
    // Summits vanish into a dark deck; snow falls.
    case 'storm': return { ...base, highCloudMul: 0, snowShift: -1100, wetness: 0.8, mieMul: 9, rayMul: 1.3, deckOn: 1, deckCoverage: 0.9, deckDark: 0.75, stormDark: 0.45, sunMul: 0.1, sat: 0.55, contrast: 1.15, exposureMul: 1.5, deckH: ground + 0.62 * (summit - ground), precip: 1, tintMul: [0.88, 0.94, 1.04] };
    case 'cloudsea': {
      const top = clamp(ground + 0.33 * (summit - ground), ground + 150, summit - 500);
      return { ...base, cloudOn: 1, deckOn: 1, deckCoverage: 0.86, cloudTop: top, deckH: top, mieMul: 0.8, sat: 1.06 };
    }
    default: return base;
  }
}

/** Animated look state. */
export class Looks {
  constructor() {
    this.light = 'golden';
    this.weather = 'summer';
    this.style = 'natural';
    this.overlay = 'none';
    this.biome = 'conifer';
    this.ctx = { lat: 44, lon: -110, heading: 240, ground: 2000, summit: 4000 };
    this.cur = this._target();
    this.tweens = [];
    this.onStyleChange = null;
  }

  _target() {
    const L = lightPlacement(this.light, this.ctx);
    const W = weatherParams(this.weather, this.ctx);
    const B = BIOMES[this.biome] ?? BIOMES.conifer;
    return {
      sunAz: L.sunAz, sunEl: L.sunEl, moonAz: L.moonAz, moonEl: L.moonEl, exposure: L.exposure * W.exposureMul,
      ...W, sat: W.sat * (L.satMul ?? 1), precip: W.precip ?? 0,
      tint: (L.tint ?? [1, 1, 1]).map((v, i) => v * (W.tintMul?.[i] ?? 1)), cloudTop: W.cloudTop ?? this.cur?.cloudTop ?? 2000, deckH: W.deckH ?? this.cur?.deckH ?? 3000,
      forest: hexLin(B.forest), grass: hexLin(B.grass), dry: hexLin(B.dry), rock: hexLin(B.rock), rock2: hexLin(B.rock2),
      soil: hexLin(B.soil), autumnCol: hexLin(B.autumn), density: B.density, dryness: B.dryness, floor: B.floor, playa: B.playa,
      overlayMix: this.overlay === 'none' ? 0 : 1,
      highClouds: (HIGH_CLOUDS[this.light] ?? 0.3) * (W.highCloudMul ?? 1),
    };
  }

  /** Animate every parameter toward the current choices. */
  retarget(duration = 2.4, { sunPath = true } = {}) {
    const from = structuredClone(this.cur), to = this._target();
    // The sun takes the short way round.
    if (sunPath) {
      const d = ((to.sunAz - from.sunAz + 540) % 360) - 180;
      to.sunAz = from.sunAz + d;
    }
    this.tweens = [{ from, to, t: 0, duration }];
  }

  setContext(ctx, duration = 0) {
    this.ctx = { ...this.ctx, ...ctx };
    if (duration) this.retarget(duration); else { this.cur = this._target(); this.tweens = []; }
  }

  setLight(id) { if (id === this.light) return false; this.light = id; this.retarget(2.6); return true; }
  setWeather(id) { if (id === this.weather) return false; this.weather = id; this.retarget(3.0); return true; }
  setBiome(id, duration = 0) { if (id === this.biome) return; this.biome = id; if (duration) this.retarget(duration); else this.cur = this._target(); }
  setStyle(id) { if (id === this.style) return false; this.style = id; return true; }
  setOverlay(id) { if (id === this.overlay) return false; this.overlay = id; this.retarget(0.8); return true; }

  get styleCode() { return STYLES.find((s) => s.id === this.style)?.code ?? 0; }
  get overlayCode() { return OVERLAYS.find((s) => s.id === this.overlay)?.code ?? 0; }
  get animating() { return this.tweens.length > 0; }

  update(dt) {
    const tw = this.tweens[0];
    if (!tw) return;
    tw.t = Math.min(tw.duration, tw.t + dt);
    const k = easeInOut(tw.t / tw.duration);
    const out = {};
    for (const key of Object.keys(tw.to)) {
      const a = tw.from[key], b = tw.to[key];
      if (Array.isArray(b)) out[key] = b.map((v, i) => (a?.[i] ?? v) + (v - (a?.[i] ?? v)) * k);
      else if (typeof b === 'number') out[key] = (a ?? b) + (b - (a ?? b)) * k;
      else out[key] = b;
    }
    // Snow creeps down slowly at first, then sweeps: ease-in for the snowline.
    if (typeof tw.to.snowShift === 'number') {
      const ks = (tw.t / tw.duration) ** 1.6;
      out.snowShift = tw.from.snowShift + (tw.to.snowShift - tw.from.snowShift) * ks;
    }
    this.cur = out;
    if (tw.t >= tw.duration) this.tweens.shift();
  }

  /** Sun and moon directions (ECEF unit vectors) at the anchor location. */
  directions() {
    const { east, north, up } = enuBasis(this.ctx.lon, this.ctx.lat);
    const dir = (az, el) => {
      const ce = Math.cos(el * DEG);
      return [0, 1, 2].map((i) => east[i] * ce * Math.sin(az * DEG) + north[i] * ce * Math.cos(az * DEG) + up[i] * Math.sin(el * DEG));
    };
    return { sun: dir(this.cur.sunAz, this.cur.sunEl), moon: dir(this.cur.moonAz, this.cur.moonEl) };
  }
}
