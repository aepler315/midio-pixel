// A sunrise/moonrise cycle: the sun climbs out of the sea, arcs overhead,
// and sets back into it; the moon takes over for the second half. Pure
// math -- BiomeManager consumes it to swap/position the celestial bodies,
// darken the sky, and brighten the stars at night.
import { clamp01, smoothstep } from '../utils/math.js';
import { OCEAN_HORIZON_FRAC } from './Ocean.js';

const MIN_CYCLE_MS = 100000;
const MAX_CYCLE_MS = 200000;
const TARGET_CYCLE_MS = 150000;

/** Full day+night cycle length for a song of `durationMs`. Aims for at
 *  least two full cycles (never just one static "arc") within the 60-120s
 *  band, but never returns something longer than the song itself -- a
 *  very short song (well under two minutes) gets one shorter cycle rather
 *  than sitting frozen at a single altitude for its whole runtime. */
export function cycleMs(durationMs) {
  const d = Math.max(1, durationMs || 1);
  const cycles = Math.max(2, Math.round(d / TARGET_CYCLE_MS));
  const raw = d / cycles;
  const clamped = Math.min(MAX_CYCLE_MS, Math.max(MIN_CYCLE_MS, raw));
  return Math.min(clamped, d);
}

// The empty sky between one body setting and the other rising, as a fraction
// of the cycle.
//
// The two arcs used to abut exactly at p=0.5: the sun touched the water and
// the moon was already coming out of it on the far side, in the same frame.
// Both altitudes were 0 at that instant, which satisfied "never both up" on a
// technicality while giving the eye no gap at all -- the sky simply handed
// itself over, and the swap read as a swap rather than as night falling.
//
// A real gap costs nothing and buys the thing the handoff was missing: a
// stretch with an empty sky, where the stars are the brightest thing up
// there. At the 60-120s cycle this runs on, 8% is roughly 5-10 seconds --
// long enough to register as darkness, short enough that the sky is never
// boring. There are two of them per cycle (after sunset, and after moonset
// before dawn), so the cycle is sun-arc / gap / moon-arc / gap.
export const CELESTIAL_GAP = 0.08;
/** Phase at which the sun sets; the moon rises a gap later, at 0.5. */
export const SUN_SET_PHASE = 0.5 - CELESTIAL_GAP;
/** Phase at which the moon sets; the sun rises a gap later, at the wrap. */
export const MOON_SET_PHASE = 1 - CELESTIAL_GAP;

/** Altitude (0..1) and night mix at `nowMs` for a cycle of length `cycle`.
 *  The sun crosses over [0, SUN_SET_PHASE), the moon over [0.5,
 *  MOON_SET_PHASE), and the two CELESTIAL_GAP stretches between them are
 *  empty sky -- both altitudes are exactly 0 there, for a real span of time
 *  rather than for one instant. `night` is 0 at the sun's zenith and 1 from
 *  sunset through the whole of the moon's reign, smoothstepped through both
 *  ends so the sky darkens/lightens gradually, not on a hard cut. */
export function dayNight(nowMs, cycle) {
  const p = cyclePhase01(nowMs, cycle); // 0..1 phase within the cycle
  const sunSpan = SUN_SET_PHASE;            // [0, sunSpan)
  const moonSpan = MOON_SET_PHASE - 0.5;    // [0.5, MOON_SET_PHASE)
  const sunAlt = p < sunSpan ? Math.sin(Math.PI * (p / sunSpan)) : 0;
  const moonAlt = (p >= 0.5 && p < MOON_SET_PHASE)
    ? Math.sin(Math.PI * ((p - 0.5) / moonSpan))
    : 0;

  // night: smoothstep 0->1 into the sunset, hold at 1 across the empty sky,
  // the moon's whole reign and its zenith, then smoothstep 1->0 through the
  // second gap so the sky is already paling when the sun comes back up.
  const BAND = 0.08;
  let night;
  if (p < sunSpan - BAND) night = 0;
  else if (p < sunSpan) night = smoothstep(sunSpan - BAND, sunSpan, p);
  else if (p < 1 - BAND) night = 1;
  else night = 1 - smoothstep(1 - BAND, 1.0, p);

  // Dawn/dusk washes bracket the sun's own rise and set.
  const dawnAlpha = clamp01(1 - Math.abs(p - 0.03) / 0.12) * 0.16;
  const duskAlpha = clamp01(1 - Math.abs(p - (sunSpan - 0.03)) / 0.12) * 0.18;

  // Azimuth: how far each body is along its OWN arc, 0 at its rise and 1 at
  // its set. This is the same progress term the altitude above is built from
  // (altitude is sin(pi * u), peaking mid-arc), so a body's height and its
  // horizontal travel are guaranteed to stay in step -- it climbs as it
  // crosses and descends as it finishes, which is what makes the path read
  // as one arc rather than a bob and a slide happening independently.
  //
  // Held at its terminal value while a body is down (sun: 1 through the
  // whole night; moon: 0 through the whole day) rather than left undefined,
  // so anything reading it across a handoff sees a body parked at the
  // horizon it just left/has yet to reach, never a jump back across the sky.
  const sunAz01 = p < sunSpan ? p / sunSpan : 1;
  const moonAz01 = p >= 0.5 ? clamp01((p - 0.5) / moonSpan) : 0;

  return {
    sunAlt: clamp01(sunAlt), moonAlt: clamp01(moonAlt), night: clamp01(night),
    dawnAlpha, duskAlpha, sunAz01, moonAz01,
  };
}

/** Screen-x fraction for a body `az01` along its arc (0 = rise, 1 = set).
 *
 *  Bodies rise ahead of Midio (screen right, the direction he runs) and set
 *  behind him, so the sky's travel agrees with the world's. Both ends sit
 *  inset from the true screen edge: a body is already fading out over its
 *  last stretch of altitude (horizonFade), and letting the arc run all the
 *  way to 0/1 would push that fade off-frame, so the rise and set would
 *  happen out of sight rather than at a visible horizon. */
export const CELESTIAL_RISE_XFRAC = 0.92;
export const CELESTIAL_SET_XFRAC = 0.08;
export function celestialXFracFor(az01) {
  const u = clamp01(az01);
  return CELESTIAL_RISE_XFRAC + (CELESTIAL_SET_XFRAC - CELESTIAL_RISE_XFRAC) * u;
}

/**
 * Where the SUN is at cycle phase `p`, continued below the horizon through
 * the whole night rather than stopping at the handoff.
 *
 * Nothing draws a below-horizon sun, but the moon is lit by it, so the moon
 * needs to know which way it is even while it's down -- that direction is
 * what decides which way the moon's bright limb faces. Getting this wrong is
 * visible: a moon high at midnight is lit from almost directly below, and a
 * moon lit from the side (or, worse, from a sun frozen at the horizon where
 * it happened to set) reads as lit by nothing in particular.
 *
 * Signed altitude runs the full circle -- sin(2*pi*p): 0 rising, +1 at the
 * sun's zenith, 0 setting, -1 at its nadir under the moon's zenith. Azimuth
 * runs out to the setting edge and back again, so the sun retraces its own
 * path underneath instead of teleporting across to rise from where it set.
 *
 * @returns {{xFrac:number, yFrac:number, altSigned:number}} screen fractions;
 *   yFrac is BELOW OCEAN_HORIZON_FRAC (larger) whenever the sun is down.
 */
export function sunScreenFrac(p01) {
  const p = ((p01 % 1) + 1) % 1;
  // Split at SUN_SET_PHASE rather than at the half, so this agrees with
  // dayNight's sun about when it actually touches the water. The night half
  // is correspondingly longer than the day half -- which is the point of the
  // gaps -- so the two halves are parameterized separately instead of by one
  // sin(2*pi*p) that assumed they were equal.
  const day = SUN_SET_PHASE;
  const altSigned = p < day
    ? Math.sin(Math.PI * (p / day))
    : -Math.sin(Math.PI * ((p - day) / (1 - day)));
  // Out to the set edge over the day, then back the same way underneath.
  const az01 = p < day ? p / day : 1 - (p - day) / (1 - day);
  const span = OCEAN_HORIZON_FRAC - 0.12; // horizon -> zenith, same as celestialYFracFor
  return {
    xFrac: celestialXFracFor(az01),
    // Symmetric about the horizon: as far below at the nadir as above at noon.
    yFrac: OCEAN_HORIZON_FRAC - altSigned * span,
    altSigned,
  };
}

/** Cycle phase 0..1 for `nowMs`, the same term dayNight() works in --
 *  exported so callers can feed sunScreenFrac without re-deriving it. */
export function cyclePhase01(nowMs, cycle) {
  if (typeof cycle?.phaseAt === 'function') return cycle.phaseAt(nowMs);
  const c = Math.max(1, cycle);
  return ((nowMs % c) + c) % c / c;
}

// One day per song (Ashton, 2026-10-01): a song opens in near-total
// darkness just before dawn, the sun rises dramatically, crosses the sky
// for the body of the song, and sets as it ends, leaving the last seconds
// in afterglow. A song clock stands in for the repeating cycle anywhere a
// `cycle` is taken (dayNight, cyclePhase01, resolveCelestialState).
/** Dark to sunrise: this fraction of the song, within [min, max]. The
 *  first `holdFrac` of it stays fully dark; after that the night lifts at
 *  an even pace (not in one rush), so with the sun's slow climb past the
 *  horizon a long song's sunrise takes about half a minute. A short song
 *  gets at least 12 s, still about a fifth of the night per two seconds
 *  at most. */
export const SONG_PREDAWN = Object.freeze({ frac: 0.25, minMs: 12000, maxMs: 24000, holdFrac: 0.1 });
/** After sunset, to the end. */
export const SONG_AFTERGLOW = Object.freeze({ frac: 0.06, minMs: 8000, maxMs: 18000 });
/** The sun lingers low: its arc runs at (1 - k cos 2*pi*u) of its mean
 *  pace, so rise and set take longer than the climb past noon. */
export const SONG_SUN_LINGER = 0.6;
/** Songs shorter than this keep the repeating cycle. */
export const SONG_DAY_MIN_MS = 30000;

/**
 * The song's sky clock: { durationMs, sunriseMs, sunsetMs, phaseAt(ms) }
 * in dayNight's phase (MOON_SET_PHASE..1 before dawn, 0..SUN_SET_PHASE
 * for the sun, then the empty sky before moonrise). Null for a song too
 * short (or of unknown length) to hold a day.
 */
export function songSkyClock(durationMs) {
  const d = Number(durationMs);
  if (!(d >= SONG_DAY_MIN_MS)) return null;
  const span = (r) => Math.min(r.maxMs, Math.max(r.minMs, d * r.frac));
  const sunriseMs = span(SONG_PREDAWN), sunsetMs = d - span(SONG_AFTERGLOW);
  const day = sunsetMs - sunriseMs;
  const END_PHASE = 0.5 - CELESTIAL_GAP * 0.15; // dark, the moon not yet up
  return Object.freeze({
    durationMs: d, sunriseMs, sunsetMs,
    phaseAt(ms) {
      const t = Math.min(d, Math.max(0, Number.isFinite(ms) ? ms : 0));
      if (t < sunriseMs) {
        // dayNight's night is a smoothstep across this stretch of phase;
        // walking it by the inverse smoothstep makes the night lift evenly.
        const s = Math.min(1, Math.max(0, (t / sunriseMs - SONG_PREDAWN.holdFrac) / (1 - SONG_PREDAWN.holdFrac)));
        const even = 0.5 - Math.sin(Math.asin(1 - 2 * s) / 3);
        return MOON_SET_PHASE + (1 - MOON_SET_PHASE) * even;
      }
      if (t < sunsetMs) {
        const u = (t - sunriseMs) / day;
        return SUN_SET_PHASE * (u - SONG_SUN_LINGER * Math.sin(2 * Math.PI * u) / (2 * Math.PI));
      }
      return SUN_SET_PHASE + (END_PHASE - SUN_SET_PHASE) * ((t - sunsetMs) / (d - sunsetMs));
    },
  });
}

/** Screen-height fraction for a body at altitude `alt` (0 at the horizon,
 *  1 at zenith) -- rises from and sets into the sea horizon rather than an
 *  arbitrary sky band. */
export function celestialYFracFor(alt) {
  const zenithFrac = 0.12;
  return OCEAN_HORIZON_FRAC - clamp01(alt) * (OCEAN_HORIZON_FRAC - zenithFrac);
}

/** Fade multiplier (0..1) for a body near the horizon -- eases it in/out
 *  over its last FADE_BAND of altitude instead of popping at alt=0. */
const FADE_BAND = 0.08;
export function horizonFade(alt) {
  return clamp01(alt / FADE_BAND);
}

// Twilight colour: how strongly the sky burns around the sun as it nears
// the horizon, and in what colours. Dawn runs gold and rose; dusk runs
// red-orange and magenta.
export const TWILIGHT = Object.freeze({
  dawn: Object.freeze({ horizon: '#ff7a3a', mid: '#d4627c', top: '#34386e', glow: '#ffb24a' }),
  dusk: Object.freeze({ horizon: '#ff4a1c', mid: '#b83e78', top: '#271f5c', glow: '#ff7a2a' }),
});

/**
 * Twilight for a cycle phase: { amount01, rising, xFrac, colors }. The
 * amount builds while the sun is still below the horizon, peaks as it
 * crosses, and fades as it climbs (sunScreenFrac's signed altitude).
 */
export function twilightAt(p01) {
  const p = ((p01 % 1) + 1) % 1;
  const { altSigned: a, xFrac } = sunScreenFrac(p);
  const amount01 = smoothstep(-0.24, -0.02, a) * (1 - smoothstep(0.1, 0.42, a));
  // Rising: the sun's morning half and the dark before it.
  const rising = p < SUN_SET_PHASE / 2 || p >= 0.5 + (MOON_SET_PHASE - 0.5) / 2;
  return { amount01, rising, xFrac, colors: rising ? TWILIGHT.dawn : TWILIGHT.dusk };
}
