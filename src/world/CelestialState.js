// One immutable scenic anchor and radiance snapshot, before any painting.
import { dayNight, celestialXFracFor, celestialYFracFor, horizonFade } from './DayNight.js';
import { celestialApproach } from './CelestialApproach.js';
import { OCEAN_HORIZON_FRAC } from './Ocean.js';
import { clamp01, smoothstep } from '../utils/math.js';

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** The sun sinks into red: its colour toward SUN_HORIZON_COLOR below
 *  altitude 0.35. */
function warmSun(color, alt) {
  const k = 1 - smoothstep(0, 0.35, alt);
  if (k <= 0 || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const a = hex(color), b = hex(SUN_HORIZON_COLOR);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * k * 0.85).toString(16).padStart(2, '0')).join('');
}

/** How much of the night fill a moonless night takes away. */
export const MOONLESS_AMBIENT_CUT = 0.8;
/** The sun's colour at the horizon (it warms as it sinks). */
export const SUN_HORIZON_COLOR = '#ff5a1e';

export function resolveCelestialState({ timeMs, cycleMs, viewport, approach = {}, moonOffset = {},
  nightFill = .35, reducedMotion = false, sunColor = '#fff3df', moonColor = '#c8d8ff',
  sunRadiusPx = 26, moonRadiusPx = 26, radiusCapPx = Infinity }) {
  const dn = dayNight(timeMs, cycleMs), { width, height } = viewport;
  const body = (alt, az, name) => {
    const app = celestialApproach({ orbitX: width * celestialXFracFor(az),
      orbitY: height * celestialYFracFor(alt), horizonY: height * OCEAN_HORIZON_FRAC,
      progress01: approach.progress01 || 0, observerDy: approach.observerDy || 0 });
    const visibility = horizonFade(alt);
    let dx = name === 'moon' && !reducedMotion && visibility > 0 ? moonOffset.dxPx || 0 : 0;
    let dy = name === 'moon' && !reducedMotion && visibility > 0 ? moonOffset.dyPx || 0 : 0;
    const bound = Math.min(1, 6 * height / 720 / (Math.hypot(dx, dy) || 1));
    dx *= bound; dy *= bound;
    return Object.freeze({ xFrac: (app.x + dx) / width, yFrac: (app.y + dy) / height,
      radiusFrac: Math.min(radiusCapPx, (name === 'sun' ? sunRadiusPx : moonRadiusPx) * app.scale) / width,
      scale: app.scale, altitude01: alt, visibility, directGain: (name === 'sun' ? 1.6 : .25) * visibility,
      colorHex: name === 'sun' ? warmSun(sunColor, alt) : moonColor });
  };
  const sun = body(dn.sunAlt,dn.sunAz01,'sun'), moon = body(dn.moonAlt,dn.moonAz01,'moon');
  const darkness = clamp01(dn.night * (1 - moon.visibility));
  return Object.freeze({ sun, moon, activeBody: sun.visibility > 0 ? 'sun' : moon.visibility > 0 ? 'moon' : null,
    night01: dn.night, dawn01: dn.dawnAlpha, dusk01: dn.duskAlpha,
    // Night with no moon up (before dawn, after sunset): the land goes
    // nearly black and the sky toward space.
    darkness01: darkness,
    ambientMultiplier: (1 + (clamp01(nightFill) - 1) * dn.night) * (1 - MOONLESS_AMBIENT_CUT * darkness) });
}
