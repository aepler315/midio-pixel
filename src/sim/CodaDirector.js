// The Unraveling (Movement V): the supernova (-4s) and terminal freeze
// (-0.3s) used to erupt out of a fully intact world. The last 18 seconds
// are now a composed decomposition instead: `unravel` eases 0->1 across
// [durationMs-18000, durationMs-4000] -- handing off exactly where the
// atlas detonation already fires, which hands off to FractureEngine's
// freeze, which hands off to the shatter. Parallax delaminates, the frame
// desaturates, particle hues converge to the biome halo, and the
// terrain-EQ ground lies down to rest -- then her myths detonate in an
// already-dying sky, and the freeze completes it.
import { smoothstep } from '../utils/math.js';

const UNRAVEL_START_MS = 18000; // before the end
const UNRAVEL_DONE_MS = 4000;   // before the end -- matches the atlas detonation trigger (Simulation.js)
export const DESATURATE_MAX = 0.35;
const RATIO_SPREAD_MAX = 0.25;

export class CodaDirector {
  constructor(durationMs = 0) {
    this.durationMs = durationMs || 0;
    this.unravel = 0;
    this.active = false;
  }

  update(nowMs) {
    if (this.durationMs <= 0) {
      // Free-time audio has no fixed end to unravel toward -- a clean no-op.
      this.unravel = 0;
      this.active = false;
      return;
    }
    const startMs = this.durationMs - UNRAVEL_START_MS;
    const doneMs = this.durationMs - UNRAVEL_DONE_MS;
    this.unravel = smoothstep(startMs, doneMs, nowMs);
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
