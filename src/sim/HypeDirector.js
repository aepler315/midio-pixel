// The clip-factor system: detects the musical moments a spectator would
// clip and makes the whole frame answer them. Two EMAs of global energy --
// a fast one (attack) and a slow one (context) -- and when the fast one
// tears away from the slow one after a quieter stretch, that's a DROP:
// fire a full-screen shockwave from Midio, surge every phenomena system,
// and echo the frame. Between drops, a thin border frame breathes with
// the track and slams on every kick, so even a zoomed-out or distant view
// reads instantly as "this screen is running on the music."
import { clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const FAST_TAU = 0.15, SLOW_TAU = 2.5;
const DROP_DELTA = 0.26;      // fast must exceed slow by this much...
const DROP_QUIET_CEIL = 0.5;  // ...while the slow context is still this quiet
const DROP_COOLDOWN_MS = 6000;
const DROP_ARM_MS = 2500;     // EMAs must have heard the song; t=0 is not a drop
const DROP_HOLD_MS = 220;     // tear-away must persist — a kick spike is not a drop
const SURGE_DECAY_SEC = 2.2;
const SLAM_DECAY_SEC = 0.22;
const RING_MS = 900;
// Build-up: reads the same fast/slow EMAs the drop detector compares, but
// for the RAMP rather than the BREAK -- rectified (only a rising fast-over-
// slow counts) and smoothed so kick-to-kick flutter doesn't read as one,
// firing on every sustained crescendo instead of drop's ~once-per-section.
const BUILDUP_TAU = 0.6;
const BUILDUP_GAIN = 4.0;

export class HypeDirector {
  constructor() {
    this.fast = 0;
    this.slow = 0;
    this.surge = 0;        // 0..1, decaying after a drop
    this.slam = 0;         // kick-driven border pulse
    this.dropAtMs = -Infinity;
    this._cooldownUntilMs = 0;
    this.dropCount = 0;
    this.buildUp = 0;      // 0..1, smoothed rectified (fast-slow) rise -- fires on every crescendo
    this._buildUpRaw = 0;
    this._tearMs = 0;      // how long fast-slow has been above DROP_DELTA
  }

  onKick(vel = 0.8) {
    this.slam = Math.max(this.slam, 0.35 + 0.65 * vel);
  }

  /** Conductor-cued drop (ConductorTrack.js). The detector above infers a
   *  drop from the energy envelope tearing away from a quiet context; a cue
   *  asserts one outright, so it skips the quiet-ceiling and delta tests --
   *  but still sets the same fields (and arms the same cooldown) so nothing
   *  downstream can tell a cued drop from a detected one, and so a detected
   *  drop can't immediately re-fire on top of a cued one. */
  cueDrop(nowMs, strength = 1) {
    this.dropAtMs = nowMs;
    this._cooldownUntilMs = nowMs + DROP_COOLDOWN_MS;
    this.surge = Math.max(this.surge, clamp01(strength));
    this.dropCount++;
    this._tearMs = 0;
  }

  update(nowMs, dtSec, energyCurves) {
    // Song-relative: a drop is the fast EMA tearing away from a QUIET context,
    // and "quiet" has to be measured against this song's own floor -- on the
    // absolute signal a compressed master never sat below DROP_QUIET_CEIL, so
    // its drops could never fire at all.
    const e = energyCurves ? clamp01(energyCurves.globalEnergyNorm(nowMs, FLAT_WEIGHTS)) : 0.3;
    this.fast += (1 - Math.exp(-dtSec / FAST_TAU)) * (e - this.fast);
    this.slow += (1 - Math.exp(-dtSec / SLOW_TAU)) * (e - this.slow);

    const tearing = nowMs >= DROP_ARM_MS
      && nowMs >= this._cooldownUntilMs
      && this.slow < DROP_QUIET_CEIL
      && this.fast - this.slow > DROP_DELTA;
    if (tearing) {
      this._tearMs += dtSec * 1000;
      if (this._tearMs >= DROP_HOLD_MS) {
        this.dropAtMs = nowMs;
        this._cooldownUntilMs = nowMs + DROP_COOLDOWN_MS;
        this.surge = 1;
        this.dropCount++;
        this._tearMs = 0;
      }
    } else {
      this._tearMs = 0;
    }

    this.surge = Math.max(0, this.surge - dtSec / SURGE_DECAY_SEC);
    this.slam = Math.max(0, this.slam - dtSec / SLAM_DECAY_SEC);

    const rise = Math.max(0, this.fast - this.slow);
    this._buildUpRaw += (1 - Math.exp(-dtSec / BUILDUP_TAU)) * (rise - this._buildUpRaw);
    this.buildUp = clamp01(this._buildUpRaw * BUILDUP_GAIN);
  }

  /** Shockwave ring progress in [0,1), or null once the ring has passed. */
  ringU(nowMs) {
    const age = nowMs - this.dropAtMs;
    return age >= 0 && age < RING_MS ? age / RING_MS : null;
  }
}

/**
 * Border-frame draw params from hype state, gated by calm.
 * Calm sections nearly extinguish the idle rim and kick strobe (the "edge
 * flash noise"); drop surges still read, just softer. Pure for tests.
 *
 * @returns {{ alpha:number, lineWidth:number, echo:number, inset:number }}
 */
export function hypeFrameStyle(hype, calmLevel = 0) {
  const calm = clamp01(calmLevel);
  // idleGate → 0 as calm rises: no steady rim glow on quiet stretches
  // slamGate → small: kicks stop strobing the frame during calm
  // surgeGate stays higher so a real drop still answers the edge
  const idleGate = 1 - 0.94 * calm;
  const slamGate = 1 - 0.90 * calm;
  const surgeGate = 1 - 0.40 * calm;

  const fast = hype ? clamp01(hype.fast) : 0;
  const slam = (hype ? clamp01(hype.slam) : 0) * slamGate;
  const surge = (hype ? clamp01(hype.surge) : 0) * surgeGate;

  const alpha = Math.min(0.68,
    0.02 * idleGate
    + 0.11 * fast * idleGate
    + 0.40 * slam
    + 0.26 * surge);
  const lineWidth = 1.15 + 7.0 * slam + 4.5 * surge;
  const echo = Math.max(
    surge > 0.45 ? surge : 0,
    slam > 0.72 ? slam * 0.7 : 0,
  );
  return { alpha, lineWidth, echo, inset: 5 + 2.5 * slam };
}
