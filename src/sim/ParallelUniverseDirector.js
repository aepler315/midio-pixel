// Each section of the song reads like a step sideways into a neighboring
// timeline: the same biome, the same characters, but the constants
// underneath have drifted -- the haze sits a little thicker, the wind leans
// a different way, the palette has rotated a few degrees, the horizon holds
// its breath and settles into a very slightly different place. Never a new
// look, never a discontinuity you could point at -- just enough that a
// section change reads as "somewhere adjacent" rather than "the same room
// with the lights turned".
//
// Deliberately small and deliberately safe: every knob here is cosmetic
// (haze, wind, a hue nudge, a camera reframe) and NONE of it touches
// anything a jump's clearance depends on -- ObstacleSpawner's placement and
// JumpPlanner's arcs are keyed off real physics constants that stay fixed
// regardless of which universe the world has drifted into.
//
// Deterministic per section: the same song seed always drifts through the
// same sequence of universes on replay.
import { mulberry32, hashSeed, clamp01 } from '../utils/math.js';

const PULSE_SEC = 0.9; // how long the reframe/fade beat takes to settle

/** How far each cosmetic knob is allowed to drift, expressed as the
 *  half-width of its jitter band. Small on purpose -- "ever so slightly". */
const JITTER = {
  hueDeg: 10,      // palette rotation
  haze: 0.18,      // atmospheric haze multiplier, around 1
  wind: 0.22,      // wind/turbulence multiplier, around 1
  terrain: 0.12,   // mountain dance amplitude multiplier, around 1
};

export class ParallelUniverseDirector {
  constructor() {
    /** Current universe's cosmetic offsets. Neutral (no-op) until the first shift. */
    this.hueDeg = 0;
    this.hazeMul = 1;
    this.windMul = 1;
    this.terrainMul = 1;
    /** 0..1, rises then falls across PULSE_SEC around each shift -- drives
     *  the camera reframe and can be read by anything that wants to know
     *  "a universe shift is happening right now". */
    this.pulse = 0;
    this._pulseT = Infinity;
  }

  /** Roll a new universe. Call once per section change, with a seed that's
   *  stable across replays of the same song (e.g. `${songSeed}:${sectionIdx}`). */
  shift(seed) {
    const rand = mulberry32(hashSeed(seed));
    const j = (band) => (rand() * 2 - 1) * band;
    this.hueDeg = j(JITTER.hueDeg);
    this.hazeMul = 1 + j(JITTER.haze);
    this.windMul = 1 + j(JITTER.wind);
    this.terrainMul = 1 + j(JITTER.terrain);
    this._pulseT = 0;
  }

  update(dtSec) {
    if (this._pulseT > PULSE_SEC * 2) { this.pulse = 0; return; }
    this._pulseT += Math.max(0, dtSec);
    const u = this._pulseT / PULSE_SEC;
    // A smooth rise-and-settle, not a snap: 0 -> 1 over the first half,
    // eased back down over the second -- reads as "the frame catches its
    // breath and resettles", not a flash.
    this.pulse = u < 1 ? Math.sin(u * Math.PI * 0.5) : clamp01(2 - u) ** 2;
  }
}
