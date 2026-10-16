// One rate limiter for every "big" character move -- disc spins, pirouettes,
// barrel rolls. Before this existed each move invented its own gating, and
// three of them invented none at all: Broshi's and Midasus's disc spins fired
// on the bare `justClean` flag with no threshold, no probability and no
// cooldown. Since the show is autoplay (Simulation: "nothing here can ever be
// uncleared") EVERY landing is clean, so a 420ms two-and-a-bit-turn spin
// restarted every ~500ms and neither character ever stopped rotating.
//
// The rule this class encodes: a flourish is punctuation. It should land on
// something -- a section change, a drop, a milestone -- and it should get
// rarer when the music is calm, not merely when the player is sloppy. The one
// move in the old codebase that already read correctly (EnsembleDirector's
// transition tumble: transition-only, 9-18s cooldown) is the model.
//
// Pure and testable in the same discipline as BeatAnchor: no wall clock, no
// DOM, no RNG of its own -- every timestamp and the random source are handed
// in by the caller, so a seeded sim stays deterministic.
import { clamp01 } from '../utils/math.js';

export class FlourishGate {
  /**
   * @param {object}   opts
   * @param {number}   opts.minGapMs  hard floor between two fires. Never
   *   bypassed -- not by intensity, not by a transition. This is what
   *   guarantees a move always gets to finish before it can restart.
   * @param {number}   opts.chance    probability of firing at zero intensity.
   * @param {number}   [opts.intensityChance] probability at full intensity;
   *   defaults to `chance`, i.e. intensity affects only the gap.
   * @param {number}   [opts.intensityScale] how much of the gap ABOVE the
   *   floor full intensity removes, 0..1.
   * @param {function} [opts.rand]    () => [0,1). Defaults to Math.random;
   *   pass the owner's seeded stream to stay deterministic.
   */
  constructor({ minGapMs, chance = 1, intensityChance = null, intensityScale = 0.5, rand = Math.random } = {}) {
    this.minGapMs = Math.max(0, minGapMs || 0);
    this.chance = clamp01(chance);
    this.intensityChance = intensityChance == null ? this.chance : clamp01(intensityChance);
    this.intensityScale = clamp01(intensityScale);
    this.rand = rand;
    this.lastFireMs = -Infinity;
    /** Why the last tryFire() answered the way it did -- read by the debug
     *  overlay's move log, which shows DENIED attempts too (that's the only
     *  way over-firing is visible before it reaches the screen). */
    this.lastReason = null;
  }

  /**
   * @param {number} nowMs
   * @param {object} [ctx]
   * @param {number} [ctx.intensity]   0..1 song-relative energy/epicness.
   * @param {boolean} [ctx.transition] this moment is a section change, a drop
   *   or a milestone -- the flourish has something to punctuate, so it skips
   *   the probability roll. The minGapMs floor still applies.
   * @returns {boolean}
   */
  tryFire(nowMs, { intensity = 0, transition = false } = {}) {
    const i = clamp01(intensity);

    // The floor is absolute. Everything else is negotiable.
    if (nowMs - this.lastFireMs < this.minGapMs) {
      this.lastReason = 'floor';
      return false;
    }

    // Above the floor, a busier song earns a shorter leash.
    const gap = this.minGapMs * (1 + (1 - this.intensityScale * i));
    if (!transition && nowMs - this.lastFireMs < gap) {
      this.lastReason = 'cooldown';
      return false;
    }

    if (!transition) {
      const p = this.chance + (this.intensityChance - this.chance) * i;
      if (this.rand() >= p) {
        this.lastReason = 'chance';
        return false;
      }
    }

    this.lastFireMs = nowMs;
    this.lastReason = transition ? 'transition' : 'rolled';
    return true;
  }

  /** Seeking / song swap: forget the last fire so the gate doesn't hold a
   *  move back because of a timestamp on a timeline that no longer exists. */
  reset() {
    this.lastFireMs = -Infinity;
    this.lastReason = null;
  }
}
