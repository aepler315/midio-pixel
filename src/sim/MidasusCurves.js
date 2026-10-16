// Midasus's rest-flight repertoire: the parametric figures she traces
// while resting between phrases (Midasus.js's orbitStyle/_orbitAnchor).
// She doesn't "know" she's drawing anything -- the particle trail she
// already emits while flying is what makes the figure visible, exactly as
// it always has. What's new here is the vocabulary: a registry of curve
// families (the same shape as Landmarks.js's LANDMARKS table -- "a table
// of things a character can draw"), each shaped by the music that just
// played rather than fixed constants, so a handful of formulas produces
// a large practical variety with no hand-authored art.
//
// Every point() returns an OFFSET from the orbit anchor, in the same units
// the pre-existing figures used (Midasus.js adds ax/ay itself).
import { clamp } from '../utils/math.js';

// How long (ms) a harmonograph figure takes to fully damp out. Rides the
// REST's own elapsed time, not the curve's cycle count -- a real
// harmonograph's pendulums lose amplitude over real time, not per lap.
export const HARMONOGRAPH_DECAY_MS = 3000;

// Small-integer ratio table so Lissajous/spirograph frequency ratios stay
// visually clean (a literal a:b relationship, legible the way real
// Lissajous figures are), keyed by melodic interval in semitones mod 12.
// Not the audio's actual pitch ratio (most intervals need irrational-
// adjacent numbers for that) -- a small-integer approximation that still
// tracks "how far apart were those two notes," unison/octave landing on
// the simplest 1:1 and a fifth (7 semitones) landing on an actual
// perfect-fifth ratio (3:2).
const INTERVAL_RATIOS = [
  [1, 1], [8, 7], [7, 6], [6, 5], [5, 4], [4, 3],
  [7, 5], [3, 2], [8, 5], [5, 3], [7, 4], [9, 5],
];

/** @param {number} semitones signed interval between two consecutive notes */
export function ratioForInterval(semitones) {
  const idx = ((Math.round(semitones) % 12) + 12) % 12;
  return INTERVAL_RATIOS[idx];
}

export const MIDASUS_CURVES = {
  lissajous: {
    params(env) {
      const [p, q] = ratioForInterval(env.lastIntervalSemitones);
      return { p, q };
    },
    point(t, phi, a, r, params) {
      return {
        x: 72 * a * Math.sin(params.p * 0.9 * r * t + phi),
        y: 41 * a * Math.sin(params.q * 0.9 * r * t),
      };
    },
  },
  figure8: {
    params() { return {}; },
    point(t, phi, a, r) {
      return {
        x: 82 * a * Math.sin(1.6 * r * t + phi),
        y: 48 * a * Math.sin(3.2 * r * t + 2 * phi),
      };
    },
  },
  loop: {
    params() { return {}; },
    point(t, phi, a, r) {
      return {
        x: 55 * a * Math.cos(2.6 * r * t + phi),
        y: 55 * a * Math.sin(2.6 * r * t + phi),
      };
    },
  },
  petal: {
    params(env) {
      // Petal count from the tonic-ish pitch class of the note that sent
      // her into this rest -- 3..9 petals, always odd so the rose never
      // degenerates into a symmetric figure that reads as a simpler shape.
      const pc = env.lastPitchClass % 6;
      return { petals: 3 + pc * 2 };
    },
    point(t, phi, a, r, params) {
      const th = 1.4 * r * t + phi;
      const rho = 67 * a * (0.55 + 0.45 * Math.cos(params.petals * th));
      return { x: rho * Math.cos(th), y: rho * Math.sin(th) * 0.7 };
    },
  },
  harmonograph: {
    params(env) {
      // Damping from how hard the note that sent her into this rest hit:
      // a soft note decays fast (the figure tightens to a point quickly);
      // a hard one rings longer (stays fuller across the whole rest).
      const damping = 0.15 + 0.55 * (1 - clamp(env.lastVel, 0, 1));
      const [p, q] = ratioForInterval(env.lastIntervalSemitones);
      return { damping, p, q };
    },
    point(t, phi, a, r, params, restU) {
      const decay = Math.exp(-params.damping * (restU ?? 0) * 4);
      return {
        x: 70 * a * decay * Math.sin(params.p * r * t + phi),
        y: 45 * a * decay * Math.sin(params.q * r * t + phi * 1.5),
      };
    },
  },
  spirograph: {
    params(env) {
      const [p, q] = ratioForInterval(env.lastIntervalSemitones);
      return { p, q };
    },
    // Hypotrochoid: a small circle of radius r2 rolling inside a big one of
    // radius R -- the p:q ratio sets how many lobes the trace makes before
    // it closes, the same legible relationship the Lissajous ratio gives.
    point(t, phi, a, r, params) {
      const R = 48 * a;
      const r2 = R * (params.q / (params.p + params.q + 1e-6));
      const d = r2 * 0.85;
      const th = 1.1 * r * t + phi;
      const k = r2 > 1e-6 ? (R - r2) / r2 : 0;
      return {
        x: (R - r2) * Math.cos(th) + d * Math.cos(k * th),
        y: (R - r2) * Math.sin(th) - d * Math.sin(k * th),
      };
    },
  },
};

export const MIDASUS_CURVE_NAMES = Object.keys(MIDASUS_CURVES);

/** Every point() call needs env fields defaulted -- callers only know
 *  what music actually happened, which can be nothing (song's first rest). */
export function normalizeCurveEnv(env) {
  return {
    lastIntervalSemitones: env?.lastIntervalSemitones ?? 0,
    lastPitchClass: ((env?.lastPitchClass ?? 0) % 12 + 12) % 12,
    lastVel: env?.lastVel ?? 0.5,
  };
}
