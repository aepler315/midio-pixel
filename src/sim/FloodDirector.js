// The temporary flood: a translucent water level that rises over the near
// ground plane, holds, and recedes. Previously this state machine lived
// inside BiomeManager (a 4,700-line render class) even though Simulation
// reads floodLevel01 every frame for wet-footing traction (Traction.js) --
// gameplay-affecting state belongs here, in sim/, not in world/. BiomeManager
// keeps only the draw call (_drawFlood) and, for the tsunami source, the
// event-detection call site (it already owns tsunami scheduling).
//
// Two independent sources feed one floodLevel01/floodActive pair, so
// BiomeManager only ever draws a single water line, never two overlapping
// ones:
//   - tsunami: a wall spilling over the mountains. Fast rise, brief hold,
//     moderate recede -- the original envelope, unchanged in shape.
//   - rain: the ground itself waterlogging under sustained rain
//     (WeatherDirector.rainAccum01, landed in PR #86 but previously
//     unconsumed). Slow, shallow, and long -- deliberately the opposite
//     shape of the tsunami's surge, so the two read as different events
//     even sharing one draw path.
import { clamp01 } from '../utils/math.js';
import { FLOOD_DURATION_MS as TSUNAMI_FLOOD_DURATION_MS } from '../world/OceanLife.js';

export { TSUNAMI_FLOOD_DURATION_MS };
const TSUNAMI_RISE_MS = 700;
const TSUNAMI_RECEDE_MS = 1200;

// Hysteresis on the rain trigger -- arms above the threshold, only
// disarms once meaningfully below it, so a rainAccum01 hovering right at
// the line doesn't flicker the flood on and off.
export const RAIN_FLOOD_ARM = 0.75;
export const RAIN_FLOOD_RELEASE = 0.55;
const RAIN_FLOOD_LEVEL_CAP = 0.55; // shallower than a tsunami's full overtop
const RAIN_ATTACK_TAU_SEC = 3;
const RAIN_RELEASE_TAU_SEC = 4;

export class FloodDirector {
  constructor() {
    this._tsunamiArmedForKey = null;
    this._tsunamiStartMs = -Infinity;
    this._tsunamiUntilMs = -Infinity;
    this._rainArmed = false;
    this._rainLevel01 = 0; // eased 0..RAIN_FLOOD_LEVEL_CAP
    this.level01 = 0;      // the combined, drawn level -- max of both sources
    this.active = false;   // read by Simulation for wet-footing traction
    this.source = null;    // 'tsunami' | 'rain' | null -- which source is currently dominant
  }

  /** Called by BiomeManager the first time an active tsunami wall's height
   *  envelope crosses the overtop threshold. `key` identifies the tsunami
   *  event (its tMs) so a wall sitting above the threshold across several
   *  frames only arms once, not every frame. */
  armFromTsunami(nowMs, key) {
    if (this._tsunamiArmedForKey === key) return;
    this._tsunamiArmedForKey = key;
    this._tsunamiStartMs = nowMs;
    this._tsunamiUntilMs = nowMs + TSUNAMI_FLOOD_DURATION_MS;
  }

  update(nowMs, dtSec, { rainAccum01 = 0 } = {}) {
    const tsunamiLive = nowMs < this._tsunamiUntilMs;
    let tsunamiLevel01 = 0;
    if (tsunamiLive) {
      const age = nowMs - this._tsunamiStartMs;
      const holdEnd = TSUNAMI_FLOOD_DURATION_MS - TSUNAMI_RECEDE_MS;
      if (age < TSUNAMI_RISE_MS) tsunamiLevel01 = clamp01(age / TSUNAMI_RISE_MS);
      else if (age < holdEnd) tsunamiLevel01 = 1;
      else tsunamiLevel01 = clamp01(1 - (age - holdEnd) / TSUNAMI_RECEDE_MS);
    }

    if (!this._rainArmed && rainAccum01 >= RAIN_FLOOD_ARM) this._rainArmed = true;
    else if (this._rainArmed && rainAccum01 < RAIN_FLOOD_RELEASE) this._rainArmed = false;
    const rainTarget = this._rainArmed ? RAIN_FLOOD_LEVEL_CAP : 0;
    const rainTau = rainTarget > this._rainLevel01 ? RAIN_ATTACK_TAU_SEC : RAIN_RELEASE_TAU_SEC;
    this._rainLevel01 += (1 - Math.exp(-dtSec / rainTau)) * (rainTarget - this._rainLevel01);
    this._rainLevel01 = clamp01(this._rainLevel01);

    if (tsunamiLevel01 >= this._rainLevel01) {
      this.level01 = tsunamiLevel01;
      this.source = tsunamiLevel01 > 0.02 ? 'tsunami' : null;
    } else {
      this.level01 = this._rainLevel01;
      this.source = this._rainLevel01 > 0.02 ? 'rain' : null;
    }
    this.active = this.level01 > 0.02;
  }
}
