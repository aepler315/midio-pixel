// A real spectral sea, layered under the existing ocean contour rows
// (Ocean.js's seaLineY et al, which stay exactly as they were -- this is
// an ADDITIVE depth pass, not a replacement). Pure math, no canvas: a sum
// of sinusoidal components sampled from a Pierson-Moskowitz-shaped energy
// spectrum, each obeying the deep-water dispersion relation (omega^2 = g*k,
// so longer waves genuinely travel faster and outrun shorter ones), combined
// with Gerstner horizontal displacement so crests sharpen and troughs
// flatten the way real swell does instead of a symmetric sine.
//
// The brief this answers: "give it a complex wave physics system... but
// isn't flashy... we don't want the ocean to say 'holy shit look at me'."
// So the amplitudes here are deliberately modest next to Ocean.js's own
// hand-tuned rows -- this is the layer that rewards someone who stops and
// stares (swell trains passing through each other, dispersion, crest
// sharpening under wind), not something that announces itself. Music never
// drives a wave directly; it only ever shifts the WEATHER (wind speed) that
// the spectrum is sampled from, eased over several seconds so a single loud
// beat can never visibly "make a wave."
import { clamp01, mulberry32 } from '../utils/math.js';

// A visual constant, not physical g -- tuned so the dispersion relation
// (omega = sqrt(G*k)) produces wave periods and phase speeds that read
// right at the pixel/second scale everything else on screen moves at.
export const G = 22;

// Real Pierson-Moskowitz constants (Pierson & Moskowitz 1964).
const PM_ALPHA = 8.1e-3;
const PM_BETA = 0.74;

/** Pierson-Moskowitz one-sided energy density S(omega) for a fully
 *  developed sea at wind speed U (same units as G/omega, so "px/s"-ish
 *  here). Peaks at omega_p = 0.855 * G / U -- higher wind pushes the peak
 *  to lower frequencies (longer waves), the real spectrum's own behavior. */
export function pmSpectralDensity(omega, windSpeed) {
  if (!(omega > 0) || !(windSpeed > 0)) return 0;
  const g = G;
  return (PM_ALPHA * g * g / Math.pow(omega, 5))
    * Math.exp(-PM_BETA * Math.pow(g / (windSpeed * omega), 4));
}

/** The spectrum's peak (angular) frequency for a given wind speed. */
export function peakOmega(windSpeed) {
  return windSpeed > 0 ? 0.855 * G / windSpeed : 0;
}

/** Deep-water dispersion: k -> omega and omega -> k are inverses of the
 *  same relation, omega^2 = G*k. Exported both ways since components are
 *  built from a frequency sweep but consumed (and tested) by wavenumber. */
export function omegaForK(k) { return Math.sqrt(Math.max(0, G * k)); }
export function kForOmega(omega) { return (omega * omega) / G; }

/** Phase speed c = omega/k = sqrt(G/k) -- strictly decreasing in k, i.e.
 *  longer waves (small k) genuinely outrun shorter ones. */
export function phaseSpeed(k) {
  return k > 1e-9 ? omegaForK(k) / k : 0;
}

/**
 * Build a deterministic set of wave components sampled from a PM spectrum
 * at the given wind speed. Each component carries everything
 * waveFieldSample needs: wavenumber, angular frequency (dispersion-linked
 * to k), amplitude (from the spectral energy in its frequency slice),
 * a random phase, and a propagation direction so components can cross and
 * interfere instead of every wave marching the same way (this repo's 1D
 * stand-in for real directional spreading, since the render samples a
 * single horizontal line per row rather than a 2D surface).
 *
 * Deterministic in (seed, windSpeed, count): same inputs, same field --
 * required for the "point at a moment in a replay" property every other
 * generator in this codebase already has.
 */
export function buildWaveComponents(seed, windSpeed, count = 24) {
  const rand = mulberry32((seed ^ 0x5eaf1e1d) >>> 0 || 1);
  const wind = Math.max(0.4, windSpeed);
  const omegaP = peakOmega(wind);
  // Sweep a decade below to a couple octaves above the peak -- wide enough
  // to carry both long swell and short wind-chop, narrow enough that every
  // sampled slice still has real spectral energy in it.
  const omegaLo = omegaP * 0.35;
  const omegaHi = omegaP * 3.2;
  const logLo = Math.log(omegaLo), logHi = Math.log(omegaHi);
  const out = [];
  for (let i = 0; i < count; i++) {
    // Log-spaced sampling (matches how spectral energy is actually spread
    // across frequency) with a small per-slice jitter so components don't
    // land on a perfectly regular grid -- that would show up as an
    // artificial beat pattern.
    const u = (i + 0.15 + 0.7 * rand()) / count;
    const omega = Math.exp(logLo + u * (logHi - logLo));
    const domega = (logHi - logLo) / count * omega; // slice width at this log-position
    const energy = pmSpectralDensity(omega, wind) * domega;
    const amp = Math.sqrt(Math.max(0, 2 * energy));
    out.push({
      k: kForOmega(omega),
      omega,
      amp,
      phase: rand() * Math.PI * 2,
      dir: rand() < 0.5 ? 1 : -1,
    });
  }
  return out;
}

/** Total variance (sum of amp^2/2) the built field actually carries --
 *  what a caller checking "does the spectrum integrate to the commanded
 *  energy" compares against pmSpectralDensity's own integral. */
export function fieldVariance(components) {
  let v = 0;
  for (const c of components) v += (c.amp * c.amp) / 2;
  return v;
}

// Global Gerstner steepness cap. Real Gerstner waves self-intersect (loop
// over at the crest) once Q*k*amp exceeds 1 per component; summing many
// components makes that limit tighter in practice, so this stays well
// under it -- crests sharpen and troughs flatten without ever folding.
const STEEPNESS = 0.22;

/**
 * Gerstner-superposed displacement at spatial position x (same px units as
 * the caller's screen/world coordinate) and time tSec. Returns {dx, dy}:
 * dy is the familiar height field (what a plain sine sum would already
 * give you); dx is the horizontal parcel displacement that -- summed across
 * components of different k -- sharpens crests and flattens troughs the
 * way real swell does, instead of a symmetric sine repeating forever.
 * Pure; no canvas, no state.
 */
export function waveFieldSample(components, x, tSec) {
  let dx = 0, dy = 0;
  for (const c of components) {
    if (c.amp <= 1e-6) continue;
    const theta = c.k * x * c.dir - c.omega * tSec + c.phase;
    const q = Math.min(STEEPNESS, STEEPNESS / (c.k * c.amp * components.length + 1e-6));
    dx += -q * c.amp * c.dir * Math.sin(theta);
    dy += c.amp * Math.cos(theta);
  }
  return { dx, dy };
}

/** Sea state (0 calm .. 1 storm) -> wind speed fed to buildWaveComponents. */
export function windSpeedForSeaState(seaState01) {
  return 2 + 10 * clamp01(seaState01);
}

/**
 * Ease actual sea state toward a target over ~tauSec seconds -- the
 * "weather," never the waves themselves, is what music is allowed to move,
 * and even that only gradually: a drop raises the sea state, it does not
 * make a wave. Pure exponential ease, same discipline as CameraDirector's
 * damped follows elsewhere in this codebase.
 */
export function easeSeaState(current, target, dtSec, tauSec = 10) {
  const alpha = 1 - Math.exp(-Math.max(0, dtSec) / Math.max(0.1, tauSec));
  return current + (clamp01(target) - current) * alpha;
}

/** How far the eased sea state must travel from the value the live spectrum
 *  was sampled at before it is worth re-sampling. Small enough that the sea
 *  keeps up with the weather, large enough to bound the rebuild rate. */
export const SPECTRUM_REBUILD_STEP = 0.01;

/**
 * Whether the wave spectrum should be rebuilt, given the sea state now and
 * the sea state the LIVE spectrum was built at.
 *
 * The second argument is the whole point. easeSeaState has a ~10s time
 * constant, so one frame at 60fps moves the sea state by at most dt/tau --
 * about 0.0017, which can never clear a 0.01 step. Compared against the
 * PREVIOUS FRAME's sea state this test therefore never passes, at any
 * tempo, for any song: the spectrum stays frozen at whatever state it was
 * constructed with. Compared against the built-at state the small per-frame
 * deltas accumulate and the spectrum re-samples as the weather moves.
 */
export function shouldRebuildSpectrum(seaState, spectrumSeaState, step = SPECTRUM_REBUILD_STEP) {
  return Math.abs(seaState - spectrumSeaState) > step;
}
