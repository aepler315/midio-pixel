// Midio's tether to the furthest range. He used to leave the ground on
// essentially every chart note, which at any normal tempo is two takeoffs a
// second -- relentless, and with nothing in the frame agreeing with it.
//
// So the far skyline gets a vote. This holds a gate driven by the swell of
// the L2 range at Midio's own column (MountainChoreo.ridgeSwell01): while
// that stretch of horizon is heaved up near the top of its swing the gate is
// open and takeoffs happen as charted; while it has sunk away the gate is
// shut and the same notes are performed on the ground instead. The takeoff
// TIMES never move -- they are still the chart's, still on the beat -- the
// swell only decides which stretches of the song he spends airborne. What
// comes out is phrasing: roughly four seconds of leaping, then five on foot,
// on the ~9s period the far range is already visibly moving at, so the two
// read as one gesture rather than as a character and a backdrop.
//
// Deliberately NOT gated here: scoring. Simulation judges the tap before it
// consults this, so a suppressed jump is still a perfect note -- the combo,
// the fever meter and the score are untouched, only the leap is withheld.
//
// Pure and canvas-free: swell in, gate + bob out.
import { clamp01 } from '../utils/math.js';

/** Swell at which the gate opens, and the (lower) swell at which it shuts.
 *  The gap is hysteresis: without it the gate would chatter open and closed
 *  every frame the swell hovered on the line, and Midio would flicker
 *  between running and jumping on consecutive notes. Wide enough that each
 *  open stretch is a phrase, not a stutter -- with these two the gate is
 *  open for ~42% of the swell's cycle. */
export const OPEN_AT = 0.75;
export const CLOSE_AT = 0.50;

/** Render-only bob: how far he rides up with the skyline at the top of its
 *  swing. Small -- 3px reads as breathing with the horizon, more starts to
 *  read as hovering off a ground line that is not itself moving. */
export const BOB_PX = 3;
/** Bob smoothing. The gate wants the raw swell (it has its own hysteresis);
 *  the bob wants it eased, so the kick term doesn't jitter him. */
export const BOB_TAU_SEC = 0.18;

export class RidgeAnchor {
  constructor() {
    /** True while takeoffs are allowed. */
    this.open = false;
    /** Latest raw swell reading, 0..1. */
    this.swell01 = 0;
    /** Render-only vertical offset, px, negative = lifted. */
    this.bobPx = 0;
    this._eased = 0;
  }

  /**
   * @param {number} swell01 0..1 from MountainChoreo.ridgeSwell01
   * @param {number} dtSec
   */
  update(swell01, dtSec) {
    const s = clamp01(swell01);
    this.swell01 = s;
    if (this.open) {
      if (s < CLOSE_AT) this.open = false;
    } else if (s >= OPEN_AT) {
      this.open = true;
    }
    this._eased += (1 - Math.exp(-Math.max(0, dtSec) / BOB_TAU_SEC)) * (s - this._eased);
    // 0 at the bottom of the swing (he sits on the ground line, where he
    // belongs) rising to -BOB_PX at the crest. Never positive: sinking him
    // into the ground would be a bug, not a bob.
    this.bobPx = -BOB_PX * clamp01(this._eased);
  }
}
