// "Are the characters moving to the music, or just moving?"
//
// Everything the show does is hung off the beat grid: jumps are kick-
// quantized (JumpController.scheduledJumpD), Broshi's surges are bar-
// quantized, section cuts land on bar times. When the tempo estimate is
// wrong -- a half-time read, a downbeat landing on the offbeat, rubato the
// estimator flattened -- none of that fails loudly. It just produces motion
// that has no visible relationship to what you're hearing, which is exactly
// what a viewer describes as "moving randomly."
//
// The signal that catches it: take each detected kick and measure its phase
// error against the nearest beat-grid point. A correct grid puts every kick
// near zero error. A wrong grid scatters them uniformly. Circular variance
// over a rolling window separates the two cleanly, and (being circular) it
// doesn't care about a constant offset -- a grid that's right but shifted
// scores as locked, because it IS locked; the player's tap anchor is what
// fixes the phase.
//
// This used to end in a prompt: "the sync looks a little off -- want to tap
// it in?" That was the wrong instrument. If the engine can measure that the
// grid is wrong, it can measure HOW wrong and move the grid itself; asking
// the viewer to hand-tap a correction the machine already knows is work the
// machine should have done.
//
// So the monitor now separates two failures that the scatter number alone
// conflates:
//
//   (a) A COHERENT but SHIFTED grid. The kicks agree with each other and
//       all sit at the same non-zero phase -- a downbeat read onto the
//       offbeat, an encoder delay, a chart stamped against a different
//       zero. The resultant vector is long and points somewhere other than
//       0. This is exactly solvable: shift the grid by that mean phase and
//       every kick lands on it.
//
//   (b) GENUINE incoherence. The kicks do not agree with each other -- a
//       half-time tempo read, rubato the estimator flattened. The resultant
//       vector is short and points nowhere in particular. There is no single
//       offset that fixes this, which is why prompting for one never helped
//       either: a viewer tapping along cannot supply an offset that does not
//       exist. Nothing is applied; the monitor keeps watching.
//
// The old code only ever detected (b) -- the fixable case was invisible to
// it, because circular VARIANCE is deliberately blind to a constant offset
// ("a grid that's right but shifted scores as locked"). Measuring the mean
// as well as the spread is what makes the correction possible at all.
//
// Pure and DOM-free like BeatAnchor -- every timestamp is handed in.
import { clamp01 } from '../utils/math.js';

const WINDOW = 16;              // kicks per verdict
const MIN_KICKS = 10;           // don't judge on a handful
// Circular variance above this = the kicks aren't on the grid. 0 is perfect
// lock, 1 is uniform scatter. 0.55 sits well clear of "human-loose but
// locked" (a live drummer lands ~0.15-0.3) without needing pure chaos.
const SCATTER_THRESHOLD = 0.55;
// The anchor's own confidence is the other half: if the player has already
// tapped a good pass in, the grid is being steered and there is nothing to
// ask for, however scattered the CHART's kicks look.
const ANCHOR_CONFIDENCE_FLOOR = 0.5;

const QUIET_START_MS = 4000;    // let a few kicks land before judging anything
// A correction needs the kicks to AGREE with each other. Resultant length R
// (1 - circular variance) is that agreement; below this the phases point
// nowhere in particular and their mean is noise, so there is nothing honest
// to apply -- case (b) above.
const COHERENT_R = 0.55;
// Don't chase sub-perceptual offsets. Under ~12ms nobody sees the difference
// and correcting just adds jitter to a grid that is already right.
const CORRECTION_DEADBAND_MS = 12;
// Correct toward the measured offset rather than snapping onto it: a partial
// step per window converges in a couple of windows and cannot be yanked
// around by one unlucky measurement. Same reasoning as BeatAnchor's own
// PHASE_GAIN on taps.
const CORRECTION_GAIN = 0.6;
// How often a correction may land. Long enough that the window refills with
// kicks measured AGAINST THE NEW GRID before the next verdict -- correcting
// on stale phases would over-shoot every time.
const CORRECTION_GAP_MS = 6000;

/**
 * Circular variance of a set of phases (radians). 0 = perfectly concentrated,
 * 1 = uniformly scattered. Using the resultant-vector length rather than a
 * plain stddev is what makes this wrap correctly at ±π: a kick 1ms before the
 * beat and one 1ms after are adjacent, not maximally distant.
 */
export function circularVariance(phasesRad) {
  if (!phasesRad || phasesRad.length === 0) return 0;
  let sx = 0, sy = 0;
  for (const p of phasesRad) { sx += Math.cos(p); sy += Math.sin(p); }
  const R = Math.hypot(sx, sy) / phasesRad.length;
  return clamp01(1 - R);
}

/**
 * Mean direction of a set of phases, and how much they agree.
 *
 * The companion to circularVariance, and the half that makes a correction
 * possible: variance says the kicks are or aren't clustered, `mean` says
 * WHERE the cluster is. A grid that is right but shifted has R near 1 and a
 * mean far from 0 -- invisible to variance alone, and exactly the case that
 * can be fixed by moving the grid.
 *
 * @returns {{mean:number, R:number}} mean folded to (-π, π]; R in [0,1],
 *   1 = every phase identical, 0 = pointing nowhere.
 */
export function circularMean(phasesRad) {
  if (!phasesRad || phasesRad.length === 0) return { mean: 0, R: 0 };
  let sx = 0, sy = 0;
  for (const p of phasesRad) { sx += Math.cos(p); sy += Math.sin(p); }
  const n = phasesRad.length;
  return { mean: Math.atan2(sy / n, sx / n), R: clamp01(Math.hypot(sx, sy) / n) };
}

export class SyncMonitor {
  constructor() {
    this._phases = [];
    this.scatter = 0;
    /** True while the kicks genuinely disagree with each other -- the
     *  unfixable case (b). Kept for the debug overlay; nothing acts on it. */
    this.incoherent = false;
    /** Last measured systematic offset, ms (+ = kicks land late of the
     *  grid). Debug/readout only; the correction itself is latched below. */
    this.offsetMs = 0;
    this.coherence = 0;
    this._lastCorrectionMs = -Infinity;
    this.correctionCount = 0;
    /** Latched, same reasoning the old prompt latch had: set when a
     *  correction is warranted and it STAYS set until consumeCorrection()
     *  takes it, so it cannot be lost to frame ordering. Carries the ms to
     *  move the grid by. */
    this._pendingCorrectionMs = null;
  }

  /**
   * Feed one detected kick.
   * @param {number} tMs        the kick's own time
   * @param {number} beatPeriodMs current beat length (JumpController's live EMA)
   * @param {number} gridOriginMs a known grid point (the anchor's own origin,
   *   or 0 -- any point on the grid works, since only the phase matters)
   */
  onKick(tMs, beatPeriodMs, gridOriginMs = 0) {
    if (!(beatPeriodMs > 0) || !Number.isFinite(tMs)) return;
    const rel = ((tMs - gridOriginMs) % beatPeriodMs + beatPeriodMs) % beatPeriodMs;
    this._phases.push((rel / beatPeriodMs) * Math.PI * 2);
    if (this._phases.length > WINDOW) this._phases.shift();
  }

  /**
   * @param {number} nowMs
   * @param {object} opts
   * @param {number} opts.beatPeriodMs the grid spacing the phases were
   *   measured against -- needed to turn a phase back into milliseconds.
   * @param {number} opts.anchorConfidence BeatAnchor.confidence
   * @param {boolean} [opts.suppress] paused/ending -- hold state without
   *   acting.
   */
  update(nowMs, { beatPeriodMs = 0, anchorConfidence = 0, suppress = false } = {}) {
    if (this._phases.length < MIN_KICKS) return;
    const { mean, R } = circularMean(this._phases);
    this.scatter = clamp01(1 - R);
    this.coherence = R;
    this.incoherent = R < COHERENT_R;

    // Phase is measured from a grid point, so it runs 0..2π across one beat.
    // Fold to (-π, π] first: a kick at 0.95 of a beat is 5% EARLY for the
    // next beat, not 95% late for the last one. Getting this wrong would
    // drag the grid a whole beat backwards on every near-zero offset.
    const folded = mean > Math.PI ? mean - 2 * Math.PI : mean;
    this.offsetMs = beatPeriodMs > 0 ? (folded / (2 * Math.PI)) * beatPeriodMs : 0;

    if (suppress) return;
    if (nowMs < QUIET_START_MS) return;
    // The player has tapped a real pass in: the grid is being steered by
    // hand and must not be second-guessed.
    if (anchorConfidence >= ANCHOR_CONFIDENCE_FLOOR) return;
    // Case (b): the kicks do not agree, so their mean is noise. No single
    // offset fixes this and inventing one would make it worse.
    if (R < COHERENT_R) return;
    if (!(beatPeriodMs > 0)) return;
    if (Math.abs(this.offsetMs) < CORRECTION_DEADBAND_MS) return;
    if (nowMs - this._lastCorrectionMs < CORRECTION_GAP_MS) return;

    this._pendingCorrectionMs = this.offsetMs * CORRECTION_GAIN;
    this._lastCorrectionMs = nowMs;
    this.correctionCount++;
    // Drop the phases measured against the OLD grid: the next verdict has to
    // be earned on kicks seen through the corrected one, or the same offset
    // gets applied twice.
    this._phases.length = 0;
  }

  /** Take a pending grid correction in ms, or null. Returns a value exactly
   *  once per raised correction, whoever calls it and whenever. Positive
   *  means the kicks are landing LATE of the grid, so the grid should move
   *  later by this much to meet them. */
  consumeCorrection() {
    const v = this._pendingCorrectionMs;
    this._pendingCorrectionMs = null;
    return v;
  }

  /** The player tapped a real pass in: their grid wins, so stop measuring
   *  against the old one and drop any correction still in flight. */
  onCalibrated() {
    this._phases.length = 0;
    this._pendingCorrectionMs = null;
  }
}
