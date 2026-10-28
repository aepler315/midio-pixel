// The Unraveling (Movement V): the world's composed decomposition into the
// end of the music. `unravel` eases 0->1 over 14 seconds and holds at 1:
// the celestial light goes out (LightField), weather stands down, the
// terrain-EQ ground lies down to rest (GroundField.flatten), parallax
// layers delaminate and particle hues converge to the biome halo.
//
// The ramp is anchored to the song's cadence -- its last audible moment
// (EffectsMusic.lastAudibleMs, the same silence gate the light and sky
// hear) -- not to the file's end: it completes 1.5 s after the cadence, so
// a long silent tail is spent in the finished, dark world. It never
// completes later than 4 s before the file's end, so a song that plays to
// its last frame (or one without curves) keeps the file-clock arc
// [duration - 18 s, duration - 4 s]. A pure function of heard time:
// seeking and continuous play agree. `desaturation` remains for
// Renderer._drawDesaturationOverlay, which no draw path calls today.
import { smoothstep } from '../utils/math.js';
import { lastAudibleMs } from '../world/alpine/EffectsMusic.js';

const UNRAVEL_RAMP_MS = 14000;
const UNRAVEL_DONE_MS = 4000;   // before the file's end, at the latest
const CADENCE_SETTLE_MS = 1500; // after the cadence
export const DESATURATE_MAX = 0.35;
const RATIO_SPREAD_MAX = 0.25;

export class CodaDirector {
  /** @param energyCurves the song's analysis curves, or null when they do
   *    not reach the song's end (an opening analysis) or do not exist. */
  constructor(durationMs = 0, energyCurves = null) {
    this.durationMs = durationMs || 0;
    this.cadenceMs = this.durationMs > 0 ? lastAudibleMs(energyCurves, this.durationMs) : 0;
    this.unravel = 0;
    this.active = false;
  }

  update(timeMs) {
    if (this.durationMs <= 0) {
      // Free-time audio has no fixed end to unravel toward -- a clean no-op.
      this.unravel = 0;
      this.active = false;
      return;
    }
    const doneMs = Math.min(this.cadenceMs + CADENCE_SETTLE_MS, this.durationMs - UNRAVEL_DONE_MS);
    this.unravel = smoothstep(doneMs - UNRAVEL_RAMP_MS, doneMs, timeMs);
    this.active = this.unravel > 0.001;
  }

  /** The desaturation overlay's alpha right now, 0..DESATURATE_MAX. */
  get desaturation() { return this.unravel * DESATURATE_MAX; }

  /** A parallax layer's scroll ratio drifts apart from the rest as the
   *  world delaminates -- nearer layers (higher baseRatio) race ahead
   *  more than far ones, using the ratio itself as a free depth proxy
   *  (no separate per-layer table needed). Pure, so BiomeManager and
   *  tests can both call it directly. */
  static delaminateRatio(baseRatio, unravel) {
    return baseRatio * (1 + RATIO_SPREAD_MAX * unravel * baseRatio);
  }
}
