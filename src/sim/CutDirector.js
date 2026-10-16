// Authored moments (spec: "author three moments by hand"). Everywhere else
// in this game, drama is a continuous swell -- hype rises and falls on an
// eased curve, apotheosis fades in and out. This class exists to make
// exactly two moments land as a CUT instead: camera, color, and sound all
// snapping together on the single frame the drop lands and the single frame
// Midio first unfolds into his apotheosis form. (The finale already gets an
// equivalent cut for free from FractureEngine's freeze/shatter/silence --
// Simulation.js calls filmFinish.hit('finale') directly off its existing
// justEnteredFinale flag, no separate director needed here.)
//
// Each moment fires exactly ONCE per song (the drop, not every drop; the
// FIRST apotheosis, not all eight) -- "pick the drop," not narrate every
// drop. Single-latch timestamps, same shape as Simulation's _atlasDetonated.
import { smoothstep, clamp01 } from '../utils/math.js';

const STILL_HOLD_MS = 90;    // fully stilled
const STILL_RECOVER_MS = 140; // eases back open after the hold
const DROP_SHAKE = 4;
const APOTHEOSIS_SHAKE = 3.5;

export class CutDirector {
  constructor() {
    this.dropCutAtMs = -Infinity;
    this.apotheosisCutAtMs = -Infinity;
    this.dropJustCut = false;
    this.apotheosisJustCut = false;
  }

  update(sim, dtSec, nowMs) {
    this.dropJustCut = false;
    this.apotheosisJustCut = false;

    if (this.dropCutAtMs === -Infinity && sim.hype && sim.hype.dropCount >= 1) {
      this.dropCutAtMs = nowMs;
      this.dropJustCut = true;
      if (sim.camera) sim.camera.shake(DROP_SHAKE);
      if (sim.filmFinish) sim.filmFinish.hit('drop');
    }

    if (this.apotheosisCutAtMs === -Infinity && sim.apotheosis && sim.apotheosis.justTriggered) {
      this.apotheosisCutAtMs = nowMs;
      this.apotheosisJustCut = true;
      if (sim.camera) sim.camera.shake(APOTHEOSIS_SHAKE);
      if (sim.filmFinish) sim.filmFinish.hit('apotheosis');
    }
  }

  /** 0 = fully stilled, 1 = normal -- a brief held-breath dip right after
   *  either cut, easing back open. Pure function of the two timestamps. */
  stillnessMul(nowMs) {
    return Math.min(
      stillnessFromAge(nowMs - this.dropCutAtMs),
      stillnessFromAge(nowMs - this.apotheosisCutAtMs),
    );
  }
}

function stillnessFromAge(ageMs) {
  if (!(ageMs >= 0)) return 1; // NaN (age vs -Infinity) or negative -> not yet cut
  if (ageMs < STILL_HOLD_MS) return 0;
  return clamp01(smoothstep(STILL_HOLD_MS, STILL_HOLD_MS + STILL_RECOVER_MS, ageMs));
}
