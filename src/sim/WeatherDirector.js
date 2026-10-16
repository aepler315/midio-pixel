// Music-reactive weather: a global sky layer decoupled from biome (unlike
// each BiomeProfile's own particle signature, this reads the song's mood and
// intensity directly, so it shows up in ANY biome). Pure logic -- BiomeManager
// owns the actual ParticleFields and the wind coupling; this only decides
// which kind is falling and how hard.
import { clamp01 } from '../utils/math.js';

export const KINDS = Object.freeze(['rain', 'snow', 'petals', 'embers', 'sunshine', 'fog', 'wind']);

const KIND_REEVAL_MS = 8000;
const VALENCE_HYSTERESIS = 0.08; // must clear the boundary by this much to switch
const CROSSFADE_OUT_TAU_SEC = 0.8; // how fast the outgoing kind eases to 0 before the swap
const ATTACK_TAU_SEC = 3;
const RELEASE_TAU_SEC = 6;
const ENERGY_FLOOR = 0.25, ENERGY_SPAN = 0.5; // energySlow -> intensity target mapping
const CALM_SUPPRESS = 0.7; // how much calm dampens the intensity target
const SURGE_BOOST = 0.5;   // how much a drop's surge (0..1) adds to the target
const DORMANT_GATE = 0.08; // below this the layer is fully dormant (zero update/draw cost)
// Snow that actually falls for a while SETTLES: groundCover accumulates
// during a live snowfall and melts away under any other sky. Simulation
// turns it into slippery footing (see Traction.js) and BiomeManager draws
// the frost caps -- weather with consequences, not just a particle skin.
const COVER_ACCUM_SEC = 22;  // full cover after ~22s of full-intensity snowfall
const COVER_MELT_SEC = 16;   // and it melts a bit faster than it settles
const COVER_MIN_INTENSITY = 0.15;
const EPIC_EMBER_THRESHOLD = 0.75;
const VALENCE_RAIN_BOUNDARY = -0.2;  // sad <-> neutral
const VALENCE_PETALS_BOUNDARY = 0.3; // neutral <-> happy

// Dryness/rain accumulation: the same accum/melt shape as groundCover above,
// but tracking two OPPOSING slow reservoirs instead of one -- these are the
// substrate DisasterDirector reads to gate wildfire (needs sustained dryness)
// and rain-flood (needs sustained rainfall) on top of a single instant's
// weather kind. Kept here rather than in DisasterDirector because they are
// properties of the weather history, exactly like groundCover.
const DRY_ACCUM_SEC = 45;   // dries out over the better part of a minute of sun/embers/wind
const DRY_MELT_SEC = 20;    // and dampens back down faster under rain/snow/fog
const RAIN_ACCUM_SEC = 30;
const RAIN_DRAIN_SEC = 25;
const DRYING_KINDS = new Set(['sunshine', 'embers', 'wind']);
const DAMPENING_KINDS = new Set(['rain', 'snow', 'fog']);
// Severity: how HARD the active kind is hitting, separate from `intensity`
// (which only says a kind is present at all). A drizzle and a downpour are
// both "rain" at intensity~1; severity is what tells Lightning/Atmosphere/
// the precipitation streak angle which one it actually is. Follows the
// same energy target the base intensity chases, just with a harder curve
// so quiet-but-present weather doesn't read as severe.
const SEVERITY_TAU_SEC = 4;
// Three more dramatic kinds, each gated to its own corner of the
// valence/epic plane that the original four boundaries never touch (every
// existing rain/snow/petals/embers test runs at epic=0.3, comfortably
// outside CALM_EPIC_THRESHOLD and WIND_EPIC_MIN below) -- additive, not a
// re-tuning of the original mapping.
const CALM_EPIC_THRESHOLD = 0.15;   // becalmed enough for sunshine/fog to read, not just quiet
const SUNSHINE_VALENCE_MIN = 0.5;   // becalmed AND quite happy
const FOG_VALENCE_MAX = -0.5;       // becalmed AND quite sad -- a still, somber sky
const WIND_EPIC_MIN = 0.5;          // energetic but short of the embers threshold
const WIND_VALENCE_ABS_MAX = 0.15;  // and mood-neutral -- wind reads as weather, not a mood swing

/** Which kind a mood reading maps to, given the currently-active kind (for
 *  hysteresis at the valence boundaries -- epic's ember override has none,
 *  since it's a hard threshold on a different axis, not a boundary to dither
 *  across). Exported for direct testing of the mapping in isolation. */
export function kindForMood(valence, epic, currentKind) {
  if (epic >= EPIC_EMBER_THRESHOLD) return 'embers';
  if (epic < CALM_EPIC_THRESHOLD) {
    if (valence > SUNSHINE_VALENCE_MIN) return 'sunshine';
    if (valence < FOG_VALENCE_MAX) return 'fog';
  }
  if (epic >= WIND_EPIC_MIN && Math.abs(valence) < WIND_VALENCE_ABS_MAX) return 'wind';
  // Schmitt trigger: already being in a state raises the bar to LEAVE it
  // (the exit threshold sits past the plain boundary); not being in it
  // raises the bar to ENTER it (the entry threshold sits short of the plain
  // boundary). Either way the net effect is the same "widen outward" shape.
  const rainThresh = VALENCE_RAIN_BOUNDARY + (currentKind === 'rain' ? VALENCE_HYSTERESIS : -VALENCE_HYSTERESIS);
  const petalsThresh = VALENCE_PETALS_BOUNDARY + (currentKind === 'petals' ? -VALENCE_HYSTERESIS : VALENCE_HYSTERESIS);
  if (valence < rainThresh) return 'rain';
  if (valence > petalsThresh) return 'petals';
  return 'snow';
}

export class WeatherDirector {
  constructor() {
    this.kind = 'snow'; // stable default until the first evaluation lands
    this.intensity = 0;      // 0..1, the ACTIVE kind's own level
    this.severity = 0;       // 0..1, how hard the active kind is hitting (see SEVERITY_TAU_SEC)
    this.groundCover = 0;    // 0..1 settled snow -- accumulates during snowfall, melts otherwise
    this.dryness01 = 0.3;    // slow reservoir: rises under sun/embers/wind, gates wildfire
    this.rainAccum01 = 0;    // slow reservoir: rises under sustained rain, gates rain-flood
    this._nextEvalMs = 0;
    this._pendingKind = null; // queued kind, held while the current one fades to 0
  }

  /** Only one kind is ever live at a time -- {kind, intensity}. */
  get state() {
    return {
      kind: this.kind, intensity: this.intensity, severity: this.severity, groundCover: this.groundCover,
      dryness01: this.dryness01, rainAccum01: this.rainAccum01,
    };
  }

  /** Conductor-cued weather (ConductorTrack.js). Queues the kind through the
   *  same _pendingKind crossfade the mood evaluator uses -- one front passes
   *  before the next arrives, so BiomeManager still never has two live
   *  fields. Also pushes the next mood re-evaluation out past the crossfade,
   *  or the evaluator would immediately queue the mood's own kind back on
   *  top of the cue and the authored weather would never actually land. */
  cueKind(nowMs, kind) {
    if (!KINDS.includes(kind) || kind === this.kind) return false;
    this._pendingKind = kind;
    this._nextEvalMs = nowMs + KIND_REEVAL_MS;
    return true;
  }

  _stepCover(dtSec) {
    if (this.kind === 'snow' && this.intensity > COVER_MIN_INTENSITY && !this._pendingKind) {
      this.groundCover = clamp01(this.groundCover + (dtSec * this.intensity) / COVER_ACCUM_SEC);
    } else {
      this.groundCover = clamp01(this.groundCover - dtSec / COVER_MELT_SEC);
    }
  }

  /** Dryness/rain accumulation read the ACTIVE kind directly (not the
   *  pending crossfade) -- a kind mid-crossfade-out is still the kind
   *  that's actually been falling, so it should keep charging its
   *  reservoir right up until the swap lands. */
  _stepReservoirs(dtSec) {
    if (DRYING_KINDS.has(this.kind) && this.intensity > 0.1) {
      this.dryness01 = clamp01(this.dryness01 + (dtSec * this.intensity) / DRY_ACCUM_SEC);
    } else if (DAMPENING_KINDS.has(this.kind) && this.intensity > 0.1) {
      this.dryness01 = clamp01(this.dryness01 - (dtSec * this.intensity) / DRY_MELT_SEC);
    }
    if (this.kind === 'rain' && this.intensity > COVER_MIN_INTENSITY) {
      this.rainAccum01 = clamp01(this.rainAccum01 + (dtSec * this.intensity) / RAIN_ACCUM_SEC);
    } else {
      this.rainAccum01 = clamp01(this.rainAccum01 - dtSec / RAIN_DRAIN_SEC);
    }
  }

  update(nowMs, dtSec, { valence = 0, epic = 0, calm = 0, energySlow = 0, surge = 0, unravel = 0 } = {}) {
    if (nowMs >= this._nextEvalMs) {
      this._nextEvalMs = nowMs + KIND_REEVAL_MS;
      const next = kindForMood(valence, epic, this.kind);
      if (next !== this.kind && !this._pendingKind) this._pendingKind = next;
    }

    if (this._pendingKind) {
      // Ease the outgoing kind fully to 0 first -- one front passes, THEN
      // the next arrives, so only one weather field is ever live to update
      // or draw (BiomeManager never has to blend two).
      this.intensity -= (1 - Math.exp(-dtSec / CROSSFADE_OUT_TAU_SEC)) * this.intensity;
      this.severity += (1 - Math.exp(-dtSec / SEVERITY_TAU_SEC)) * (0 - this.severity);
      if (this.intensity < 0.01) {
        this.intensity = 0;
        this.kind = this._pendingKind;
        this._pendingKind = null;
      }
      this._stepCover(dtSec);
      this._stepReservoirs(dtSec);
      return;
    }

    const target = clamp01(
      clamp01((energySlow - ENERGY_FLOOR) / ENERGY_SPAN) * (1 - CALM_SUPPRESS * calm) + SURGE_BOOST * surge,
    ) * (1 - clamp01(unravel));
    const tau = target > this.intensity ? ATTACK_TAU_SEC : RELEASE_TAU_SEC;
    this.intensity += (1 - Math.exp(-dtSec / tau)) * (target - this.intensity);
    this.intensity = clamp01(this.intensity);
    // Gate on the TARGET, not the current value -- zeroing a transiently-low
    // value mid-attack would trap it at 0 forever (each step's increment
    // from a zeroed base is itself tiny). A low target genuinely means
    // "nothing to reach for," so snapping off there is safe and saves the
    // draw cost of an imperceptible sprinkle.
    if (target < DORMANT_GATE && this.intensity < DORMANT_GATE) this.intensity = 0;
    // Severity chases the surge-heavy part of the same target harder than
    // intensity does -- a drop's surge should read as a squall, not just
    // "still raining." energySlow alone barely moves it.
    const severityTarget = clamp01(0.4 * target + 0.9 * surge);
    this.severity += (1 - Math.exp(-dtSec / SEVERITY_TAU_SEC)) * (severityTarget - this.severity);
    this.severity = clamp01(this.severity);
    this._stepCover(dtSec);
    this._stepReservoirs(dtSec);
  }
}
