// Camera state: screen shake, a damped impact roll (spec §2.2.1), a zoom
// that pulls back when a performer strays off-frame, and a small beat sway.
// The Renderer reads shake/roll/zoom from here and applies a fixed framing
// otherwise.
import { clamp01 } from '../utils/math.js';
import { kickEnv } from '../world/MountainChoreo.js';

// Shake was dialed up for a "ferocity" pass (gain 2×, long ring, hard roll).
// That reads as seasick on long songs -- pull it back so impacts still
// register without thrashing the frame. Reduced-motion halves it further.
const SHAKE_GAIN = 0.85;
const SHAKE_DECAY_TAU = 0.07; // seconds -- short ring, doesn't hang
const ROLL_COUPLING = 0.0007; // rotational kick per (gained) px of shake

// Off-frame pull-back: characters roam on their own drift/formation logic
// and can genuinely wander toward an edge. This is for the UNINTENDED
// case only -- a character deliberately sent off (Midasus's sky voyage,
// Broshi's burrow) is excluded by the caller before this ever sees their
// position, because chasing an authored exit with the camera fights the
// exit's own effect.
export const ZOOM_MARGIN_FRAC = 0.08; // how close to either edge is "still fine"
export const ZOOM_MIN = 0.66; // hardest pull-back -- keeps the world legible, never a wide shot
const ZOOM_TAU = 0.6; // seconds -- slow, deliberate ease, never a snap

/**
 * How zoomed out the camera should want to be (1 = normal framing, ZOOM_MIN
 * = maximally pulled back) given a set of on-frame character screen X
 * positions. Pure -- no state, no canvas -- CameraDirector eases `zoom`
 * toward whatever this returns each frame.
 * @param {number[]} screenXs already filtered by the caller to exclude any
 *   character on an authored excursion
 * @param {number} stageW
 */
export function zoomTargetForOffFrame(screenXs, stageW) {
  if (!screenXs || screenXs.length === 0 || !(stageW > 0)) return 1;
  const margin = stageW * ZOOM_MARGIN_FRAC;
  let worst = 0; // grows the further anyone strays past either margin
  for (const x of screenXs) {
    const overLeft = margin - x;
    const overRight = x - (stageW - margin);
    const overshoot = Math.max(0, overLeft, overRight);
    if (overshoot > worst) worst = overshoot;
  }
  // The ramp runs across the margin band itself: a character right at the
  // margin (x = margin) has zero overshoot (still "fine"), and by the time
  // they'd reach the true stage edge (x = 0) overshoot has already reached
  // a full margin-width, which is enough to ask for the hardest pull-back
  // the clamp allows -- the point being to pull back BEFORE anyone actually
  // exits the frame, not react after the fact. Going further negative (or
  // past stageW - margin, or stageW + margin on the right) just saturates.
  const t = Math.max(0, Math.min(1, worst / margin));
  return 1 - (1 - ZOOM_MIN) * t;
}

// Calm-section drift (see update()): a slow, subtle pan that keeps a
// relaxed frame from ever feeling frozen -- NOT a trembling one. The first
// wide-sweep attempt (26px, One Spectrum) read as the whole scene shaking:
// calmLevel swings 0<->1 at section boundaries, so the raw amplitude
// snapped the camera tens of pixels, and even at steady calm a 26px pan
// visibly shivered every ridge and character on screen. This is sized to
// read as gentle life (a couple of px), and the amplitude is first-order
// smoothed so section changes ease the pan in/out instead of jumping it.
export const CALM_DRIFT_AMP_PX = 8;
export const CALM_DRIFT_PERIOD_SEC = 15; // one full lazy sweep
const CALM_DRIFT_SMOOTH_TAU = 1.5; // seconds -- amplitude eases, never snaps

// Beat sway: a small, continuous camera nod retriggered on every beat-grid
// crossing (from BeatAnchor, which tracks the song's own live tempo from
// the very first beat regardless of whether the player has ever tapped) --
// the frame used to only move around impacts and (in calm sections) the
// slow free-running drift above, so a long steady stretch could read as
// dead-static. Reuses the same snap-then-settle kickEnv shape everything
// else in the game beats to, rather than a smooth sine, so it reads as
// "on the beat" instead of a generic wobble. A downward dip carries most of
// the motion (like a head nodding to the music); a smaller lateral nudge
// alternates side to side beat to beat for a touch more life.
export const BEAT_SWAY_BASE_PX = 3;    // dip present even in the quietest section
export const BEAT_SWAY_ENERGY_PX = 9;  // additional dip amplitude at full musical energy
export const BEAT_SWAY_LATERAL_PX = 4; // alternating left/right nudge at full energy

/** Pure: the beat sway's {x, y} offset given `tauMs` (ms since the most
 *  recent beat-grid crossing), the alternating sign for this beat, current
 *  musical energy (0..1), and the reduced-motion multiplier. */
export function beatSwayOffset(tauMs, sign, energy01, motionMul = 1) {
  const env = kickEnv(tauMs);
  const e = clamp01(energy01);
  const dip = (BEAT_SWAY_BASE_PX + BEAT_SWAY_ENERGY_PX * e) * motionMul;
  const lateral = BEAT_SWAY_LATERAL_PX * e * motionMul;
  return { x: env * lateral * (sign < 0 ? -1 : 1), y: env * dip };
}

// Musical reframe: a small pull-back and tilt riding CameraLens's selected
// phrase accents. Anticipation, hold and recovery share the terrain lens's
// envelope; unrelated section boundaries no longer trigger this motion.
export const UNIVERSE_ZOOM_DIP = 0.05;   // fraction pulled back at full pulse
export const UNIVERSE_ROLL_MAX = 0.025;  // radians of extra tilt at full pulse

// Float tilt: while the camera is pulled back, the world reads as though
// the vantage point itself is rising past it, not just shrinking in place.
// This alone doesn't tilt anything -- it's the single knob (0 at zoom=1, max
// at ZOOM_MIN) that BiomeManager scales per-layer by depth (nearer ranges
// lean more than far ones), so "the angle of the different layers" genuinely
// differs layer to layer rather than being one flat frame-wide rotation
// (which is what `roll`, above, already is).
export const FLOAT_TILT_MAX = 0.05; // radians, at the single nearest range, at full pull-back

export class CameraDirector {
  constructor() {
    this.shakeX = 0;
    this.shakeY = 0;
    // The ambient part of shakeX/Y (calm drift + beat sway), kept apart so
    // a scene with its own 3D camera (Range) can drop it.
    this.ambientX = 0;
    this.ambientY = 0;
    this._shakeAmp = 0;
    this._shakeT = 0;
    this._shakeSeed = Math.random() * 1000;

    this.roll = 0; // radians, applied around screen center by the Renderer
    this._rollAmp = 0;
    this._rollT = 0;
    this._rollSign = 1;

    this.zoom = 1; // 1 = normal framing; the Renderer widens the logical stage view by 1/zoom
    this._zoomTarget = 1;
    this._zoomBase = 1; // the eased off-frame-pullback value, BEFORE the universe-pulse dip below
    this.floatTilt = 0; // radians, the per-layer-scaled base value -- see FLOAT_TILT_MAX

    this._lastBeatTauMs = null;
    this._beatSwaySign = 1;
    this._universeRollSign = 1;
  }

  /** Called once per frame before update(); sets what zoom() should ease
   *  toward. See zoomTargetForOffFrame's doc for what to pass in. */
  setZoomTarget(screenXs, stageW) {
    this._zoomTarget = zoomTargetForOffFrame(screenXs, stageW);
  }

  shake(amplitudePx) {
    const amp = amplitudePx * SHAKE_GAIN;
    this._shakeAmp = Math.max(this._shakeAmp, amp);
    this._shakeT = 0;
    // Impacts also kick a damped rotational oscillation -- a roll (now up to
    // a couple of degrees on the big hits) that alternates direction hit to hit.
    this._rollAmp = Math.max(this._rollAmp, amp * ROLL_COUPLING);
    this._rollT = 0;
    this._rollSign = -this._rollSign;
  }

  /** @param beatTauMs ms since the most recent beat-grid crossing (from
   *    BeatAnchor), or null if no beat clock is available yet (e.g. the
   *    very first frame). @param beatEnergy 0..1 how much the current
   *    section musically justifies extra motion (vibe.epic/hype.surge).
   *  @param universePulse 0..1, CameraLens.zoomPulse -- a selected musical
   *    accent with anticipation, hold and eased recovery. */
  update(dtSec, calmLevel = 0, reducedMotion = false, beatTauMs = null, beatEnergy = 0, universePulse = 0) {
    // Reduced-motion keeps the harder shake comfortable: half amplitude on
    // both the translational shake and the rotational roll.
    const motionMul = reducedMotion ? 0.5 : 1;
    let shakeX = 0, shakeY = 0;
    if (this._shakeAmp > 0.01) {
      this._shakeT += dtSec;
      const decay = Math.exp(-this._shakeT / SHAKE_DECAY_TAU);
      const amp = this._shakeAmp * decay;
      // 2-octave value-noise direction, not pure sine (spec §2.2.1) — cheap approximation via
      // summed incommensurate sines seeded per-shake so it never reads as jello.
      const t = this._shakeT * 1000;
      shakeX = amp * (Math.sin(t * 0.031 + this._shakeSeed) * 0.6 + Math.sin(t * 0.077 + this._shakeSeed * 1.7) * 0.4);
      shakeY = amp * (Math.sin(t * 0.043 + this._shakeSeed * 2.3) * 0.6 + Math.sin(t * 0.091 + this._shakeSeed * 0.5) * 0.4);
      this._shakeAmp = amp < 0.05 ? 0 : this._shakeAmp;
    }

    // Damped 6.5 Hz roll ring-down from the last impact. The decay is short
    // so the roll actually settles between landings -- with a long ring and
    // beat-synced landings the 6.5 Hz oscillation never died, and the whole
    // frame shivered continuously instead of kicking per impact.
    if (this._rollAmp > 1e-4) {
      this._rollT += dtSec;
      const env = Math.exp(-this._rollT / 0.12);
      this.roll = motionMul * this._rollSign * this._rollAmp * env * Math.sin(2 * Math.PI * 6.5 * this._rollT);
      if (env < 0.02) this._rollAmp = 0;
    } else {
      this.roll = 0;
    }

    // Calm sections: a slow, subtle sweeping pan layered on top of impact
    // shake (additive, so a landing during a calm stretch still reads
    // correctly). The amplitude is first-order smoothed -- calmLevel jumps
    // at section boundaries, and a raw multiply would snap the camera tens
    // of pixels (the trembling everyone could see); easing it keeps the
    // pan alive without the jolt. Horizontal leads (fuller amplitude,
    // matching how a side-scroller camera actually pans); vertical trails
    // at a slower, smaller sub-sweep so the path traces a lazy ellipse
    // rather than a tight circle.
    this._driftT = (this._driftT || 0) + dtSec;
    const driftOmega = 2 * Math.PI / CALM_DRIFT_PERIOD_SEC;
    const driftTarget = CALM_DRIFT_AMP_PX * calmLevel;
    this._driftAmp = (this._driftAmp || 0)
      + (1 - Math.exp(-dtSec / CALM_DRIFT_SMOOTH_TAU)) * (driftTarget - (this._driftAmp || 0));
    const driftX = this._driftAmp * Math.sin(driftOmega * this._driftT);
    const driftY = this._driftAmp * 0.55 * Math.sin(driftOmega * this._driftT * 0.7 + 1.3);

    // Beat sway: retriggers every time the beat clock wraps back to 0 (a
    // fresh beat), alternating its lateral nudge left/right beat to beat.
    // Calm sections keep only a whisper of it -- the slow drift above is
    // already doing that section's work, and a beat-locked nod on top of it
    // would fight the "held breath" read calm is going for.
    let swayX = 0, swayY = 0;
    if (beatTauMs != null) {
      if (this._lastBeatTauMs != null && beatTauMs < this._lastBeatTauMs) this._beatSwaySign = -this._beatSwaySign;
      this._lastBeatTauMs = beatTauMs;
      const calmMul = 1 - 0.5 * calmLevel;
      const sway = beatSwayOffset(beatTauMs, this._beatSwaySign, beatEnergy * calmMul, motionMul);
      swayX = sway.x;
      swayY = sway.y;
    }

    this.ambientX = driftX + swayX;
    this.ambientY = driftY + swayY;
    this.shakeX = shakeX * motionMul + this.ambientX;
    this.shakeY = shakeY * motionMul + this.ambientY;

    // Zoom: critically-damped-ish exponential ease toward _zoomTarget, same
    // discipline as the shake/roll ring-downs above -- it must never snap
    // or oscillate, since a sudden framing change reads as a cut, not a
    // camera move. Reduced-motion shrinks the travel rather than disabling
    // it outright (the target still communicates "someone strayed off
    // frame", just less dramatically).
    const zoomTravelMul = reducedMotion ? 0.4 : 1;
    const zoomTarget = 1 + (this._zoomTarget - 1) * zoomTravelMul;
    const zoomAlpha = 1 - Math.exp(-dtSec / ZOOM_TAU);
    this._zoomBase += zoomAlpha * (zoomTarget - this._zoomBase);

    // Universe-shift reframe: a brief pull-back + tilt on top of whatever
    // zoom/roll the frame already has, riding the director's own pulse
    // envelope. New sign each time a fresh pulse starts, same alternating-
    // side discipline as the beat sway above.
    //
    // The dip is computed fresh from _zoomBase every frame (never
    // accumulated into this.zoom/_zoomBase itself) -- pulse stays elevated
    // for many frames as it rises and settles, so subtracting into a value
    // that persists frame to frame would compound across the whole pulse
    // instead of tracking it, and briefly send the zoom wildly negative.
    const pulse = clamp01(universePulse);
    if (pulse > 0 && (this._lastUniversePulse ?? 0) <= 0) this._universeRollSign = -this._universeRollSign;
    this._lastUniversePulse = pulse;
    this.zoom = this._zoomBase - UNIVERSE_ZOOM_DIP * pulse * zoomTravelMul;
    if (pulse > 0) {
      this.roll += UNIVERSE_ROLL_MAX * pulse * this._universeRollSign * motionMul;
    }

    // Float tilt: 0 at zoom=1 (normal framing), ramping to FLOAT_TILT_MAX as
    // the camera pulls all the way back to ZOOM_MIN. Deliberately reads off
    // the FINAL this.zoom (post universe-dip), not _zoomBase -- a universe
    // reframe pulse is itself a small, brief pull-back, and it should tilt
    // the layers exactly as an off-frame pull-back would, not be ignored.
    const tiltTravelMul = reducedMotion ? 0.4 : 1;
    const tiltT = clamp01((1 - this.zoom) / (1 - ZOOM_MIN));
    this.floatTilt = FLOAT_TILT_MAX * tiltT * tiltTravelMul;
  }
}
