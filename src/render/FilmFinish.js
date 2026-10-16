// Film finish (The Light Show, pass 6): a breathing vignette + a very-low-
// alpha color grade wash, the last cinematography layer before the HUD.
// Pure-numeric state class -- mirrors the CameraDirector/HypeDirector
// split of "director computes numbers, Renderer draws". Two 0..1 signals,
// each one-pole smoothed toward a continuously-varying target:
//   vignetteDepth  how much the frame edges darken -- deepens on calm,
//                  punched open by a hype surge/slam/fast spike
//   warmth         how amber-vs-teal the grade reads -- driven by calm
//                  and the song's staged intensity budget
import { clamp01 } from '../utils/math.js';

const VIGNETTE_TAU_SEC = 0.6; // slower than a kick, fast enough a real drop visibly opens the frame
const GRADE_TAU_SEC = 1.2;    // a slow film-stock shift tied to song section, not a reactive light
const HYPE_OPEN_WEIGHT = 0.85; // fraction of calm-driven depth a full surge can punch away (never to 0)
const GRADE_CALM_WEIGHT = 0.5;
const GRADE_BUDGET_WEIGHT = 0.5;
const HIT_VIGNETTE = 1;
const HIT_WARMTH = {
  drop: 0.05, apotheosis: 0.95, finale: 0,
  // Disaster cuts (DisasterDirector/QuakeDirector/tsunami arrival): a quake
  // grades neutral-cool (dust, not warmth), a tsunami grades cold (a wall
  // of water arriving is the coldest moment in the palette).
  quake: 0.2, tsunami: 0.05,
};

/** Vignette depth target: calmLevel builds it, a hype/drop surge punches a
 *  PROPORTION of the current depth away (never subtractively -- can't
 *  undershoot to negative, and a shallow vignette isn't punched through
 *  zero into something meaningless). */
export function vignetteTarget(calmLevel, hypeOpen) {
  const c = clamp01(calmLevel);
  const h = clamp01(hypeOpen);
  return clamp01(c * (1 - HYPE_OPEN_WEIGHT * h));
}

/** Grade target: 0 = coolest, 1 = warmest. Energetic sections and a high
 *  intensity budget both push it warm. */
export function gradeTarget(calmLevel, budget) {
  const energetic = 1 - clamp01(calmLevel);
  const b = clamp01(budget);
  return clamp01(GRADE_CALM_WEIGHT * energetic + GRADE_BUDGET_WEIGHT * b);
}

export class FilmFinish {
  constructor() {
    // Song intros open on a calm, intimate frame (matches CalmDirector's
    // own initial level=1) rather than snapping in from a cold start.
    this.vignetteDepth = 1;
    this.warmth = 0.3;
  }

  /** @param hype the sim's HypeDirector instance (reads .surge/.slam/.fast) */
  update(nowMs, dtSec, calmLevel, budget, hype) {
    // "Opening" signal: surge (the drop-decay field) dominates; slam/fast
    // are small reinforcing accents, so a single hard kick alone doesn't
    // fully blow the vignette open -- only an actual surge/drop does.
    const hypeOpen = hype ? clamp01(hype.surge + 0.35 * hype.slam + 0.20 * hype.fast) : 0;

    const depthTarget = vignetteTarget(calmLevel, hypeOpen);
    const warmTarget = gradeTarget(calmLevel, budget);

    const kd = 1 - Math.exp(-dtSec / VIGNETTE_TAU_SEC);
    const kw = 1 - Math.exp(-dtSec / GRADE_TAU_SEC);
    this.vignetteDepth += kd * (depthTarget - this.vignetteDepth);
    this.warmth += kw * (warmTarget - this.warmth);
  }

  /** An authored cut (drop / apotheosis / finale): snap straight to a hard
   *  extreme on this call, bypassing the lowpass entirely, then let the next
   *  update() ease back toward its normal target -- a hit followed by a
   *  natural relax, instead of just another point on the continuous swell. */
  hit(kind) {
    this.vignetteDepth = HIT_VIGNETTE;
    this.warmth = HIT_WARMTH[kind] ?? this.warmth;
  }
}
