// Computes a single "calm level" signal from global track energy (follow-up
// item 3): C=1 is fully relaxed, C=0 is fully energetic. Every consumer
// (Midio's idle behavior, Midasus's orbit, Broshi's lope, the world's
// ambient dressing) reads this same value and applies its own calm-vs-
// energetic vocabulary -- this class only ever produces the signal.
import { smoothstep } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const G_EMA_TAU = 0.4;
const CALM_LOW = 0.25, CALM_HIGH = 0.55;

// A conductor-cued calm passage holds for this long, then releases back to
// the energy reading over the same span -- long enough to read as a section
// of the show rather than a blip, short enough that a mis-placed cue doesn't
// flatten the rest of the song.
const CUE_HOLD_MS = 6000;
const CUE_RELEASE_MS = 4000;

export class CalmDirector {
  constructor() {
    this.G = 0;
    this.level = 1;
    this._cueAtMs = -Infinity;
    this._cueStrength = 0;
  }

  /** Conductor-cued calm (ConductorTrack.js). `level` is recomputed from the
   *  energy envelope every frame, so a cue can't simply write it -- the next
   *  update would erase it. Instead the cue raises a floor that holds, then
   *  eases back out, and update() blends it over whatever the music says. */
  cueCalm(nowMs, strength = 1) {
    this._cueAtMs = nowMs;
    this._cueStrength = Math.max(0, Math.min(1, strength));
  }

  update(nowMs, dtSec, energyCurves) {
    // Song-relative (EnergyCurves.globalEnergyNorm): CALM_LOW/CALM_HIGH now
    // mean "the quiet tenth / the loud tenth OF THIS SONG", so a quiet record
    // still reaches its own energetic sections and a loud one still relaxes.
    const gInstant = energyCurves ? energyCurves.globalEnergyNorm(nowMs, FLAT_WEIGHTS) : 0;
    const alpha = 1 - Math.exp(-dtSec / G_EMA_TAU);
    this.G += alpha * (gInstant - this.G);
    const fromEnergy = 1 - smoothstep(CALM_LOW, CALM_HIGH, this.G);
    // The cue only ever raises calm above what the music earned; it never
    // holds the world energetic against a genuinely quiet passage.
    this.level = Math.max(fromEnergy, this._cueFloor(nowMs));
  }

  _cueFloor(nowMs) {
    if (this._cueStrength <= 0) return 0;
    const age = nowMs - this._cueAtMs;
    if (age < 0 || age > CUE_HOLD_MS + CUE_RELEASE_MS) return 0;
    if (age <= CUE_HOLD_MS) return this._cueStrength;
    return this._cueStrength * (1 - (age - CUE_HOLD_MS) / CUE_RELEASE_MS);
  }
}
