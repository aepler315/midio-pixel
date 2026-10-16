// The sun and moon are not just crossing the sky. They are coming.
//
// The old behaviour was an arc: a body tracks across the frame at a fixed
// size, which reads as scenery. Correct, and completely inert -- nothing
// about it ever asks you to reconsider what you are looking at.
//
// This layers an APPROACH on top of that arc, and the whole effect rests on
// two halves moving at very different rates:
//
//   POSITION changes slowly. The body still rises out of the sea on one side
//   and sets into it on the other; what closing does is make the arc it
//   takes between them TALLER, the way an approaching object passes nearer
//   your zenith instead of skimming the horizon.
//
//   SIZE grows as 1/distance, which is what apparent size actually does. A
//   linear closing rate therefore produces a convex size curve: almost
//   nothing for most of the song, then a lot, quickly.
//
// That gap is the whole trick. Something that has barely moved cannot be
// close, so the eye files it as far away and stops tracking it -- and then it
// is much too big for the size it was a moment ago, and the only way to
// reconcile those two facts is that it is enormous and it has been enormous
// the entire time. That is the vertigo of misjudged scale, and it comes from
// the RATIO of the two rates, not from either one being dramatic.
//
// WHAT THIS DELIBERATELY NO LONGER DOES: converge on a point.
//
// The previous version pulled the body toward a fixed screen position set
// just up and left of Midio. Applied to both bodies, that made the sun set
// at left-centre and the moon rise a moment later almost on top of where it
// had gone -- a sky in which two bodies in opposition arrive at the same
// place, which is not a sky at all. It also overrode the orbit's own rise
// and set points, so nothing came out of the sea any more.
//
// The frame is at most a 180-degree view, and both bodies rise and set
// inside it. That is the anchor: whatever an approach does, it must leave a
// body climbing out of the water on one side and going back into it on the
// other. So the approach touches ALTITUDE and SIZE and never touches the
// horizontal arc, and the altitude term is scaled by height above the
// horizon -- which is exactly zero at the waterline. A body cannot be lifted
// out of its own rise.
//
// Pure geometry, no canvas: BiomeManager applies these to the body's screen
// position and radius, tests exercise them directly.
import { clamp01 } from '../utils/math.js';

// Distance in arbitrary units -- only the ratio matters, since apparent size
// is D_FAR/d. Starting far and ending at roughly a quarter of that gives a
// ~4x growth across a full song, which is large enough to be unmistakable
// once noticed and small enough that no single minute of the song contains
// an obvious change.
export const D_FAR = 1;
export const D_NEAR = 0.26;
// Hard ceiling on apparent growth. Without it a long song would put the body
// through the top of the frame, and "it got bigger" stops being unsettling
// once it becomes the only thing on screen.
export const MAX_SCALE = 3.4;

// How much taller the arc gets, per unit of closeness.
//
// Applied to the body's height ABOVE THE HORIZON, so it is zero at the
// waterline and largest at the zenith: the rise and the set stay exactly
// where the orbit put them, and only the middle of the arc climbs.
//
// Note the "per unit of closeness". The body never fully arrives -- distance
// closes from D_FAR to D_NEAR, so closeness tops out at 1 - D_NEAR/D_FAR and
// the LARGEST lift the arc ever sees is APPROACH_LIFT times that, currently
// about 0.148. A zenith three hundred pixels above the sea ends around three
// hundred and forty-four, which is what "it passes over you" looks like on
// this frame.
export const APPROACH_LIFT = 0.20;
/** The most the arc can ever climb, since the body never arrives. */
export const MAX_LIFT = APPROACH_LIFT * (1 - D_NEAR / D_FAR);

// How much of the observer's own vertical motion the body's apparent position
// picks up, at closest approach. Parallax is real -- a nearer object shifts
// more against the background as you move -- but for something this far away
// it is almost nothing, and it GROWS as the body closes rather than being
// constant. 2% of a jump is a couple of pixels: present in the model, and
// nothing you could point at.
//
// The first version of this had no such term and simply used Midio's live
// render Y as the anchor, which is a 1:1 hard anchor: he jumped three feet
// and the sun jumped three feet with him, welding a body at astronomical
// distance to a character's pose. The fix is not a smaller number on that
// coupling -- it is anchoring to the GROUND, which does not move, and then
// adding back the small amount of parallax that should have been there.
export const OBSERVER_PARALLAX = 0.02;

/** Distance at song progress t01, closing linearly. Linear IS the point:
 *  it is what makes the positional drift constant-rate and unremarkable
 *  while the size curve it feeds is convex. */
export function approachDistance(t01) {
  const t = clamp01(t01);
  return D_FAR + (D_NEAR - D_FAR) * t;
}

/**
 * Apparent-size multiplier at song progress t01.
 *
 * 1 at the start, rising as 1/d -- slowly at first, then steeply. Capped at
 * MAX_SCALE.
 */
export function approachScale(t01) {
  const d = approachDistance(t01);
  return Math.min(MAX_SCALE, D_FAR / Math.max(1e-6, d));
}


/**
 * The body's drawn altitude, given where its orbit put it.
 *
 * Expressed as a multiplier on height above the horizon rather than an
 * offset, which is what keeps the rise and the set untouched: at the
 * waterline the height is zero and so is the lift, however close the body
 * has come. Only the middle of the arc moves.
 *
 * @param {number} orbitY  screen y the orbit put the body at
 * @param {number} horizonY  the sea line -- where it rises from and sets into
 * @param {number} [observerDy] how far above the ground the observer is
 *   (positive = airborne), for the parallax term
 * @param {number} [t01] song progress
 */
export function approachedY(orbitY, horizonY, observerDy = 0, t01 = 0) {
  const closeness = clamp01(1 - approachDistance(t01) / D_FAR);
  // Positive when the body is above the waterline; negative below it, where
  // the same multiplier correctly sinks it a little further out of sight.
  const above = horizonY - orbitY;
  const lifted = horizonY - above * (1 + APPROACH_LIFT * closeness);
  return lifted + observerDy * OBSERVER_PARALLAX * closeness;
}

/**
 * Everything a caller needs for one frame.
 *
 * `x` comes straight back out: the horizontal arc belongs to the orbit and
 * the approach has no business touching it. Both bodies rise and set at the
 * edges of the visible span and stay in opposition, which they cannot do if
 * something is pulling them toward a shared point.
 *
 * @param {object} p
 * @param {number} p.orbitX current orbital screen x -- returned unchanged
 * @param {number} p.orbitY current orbital screen y
 * @param {number} p.horizonY the sea line the body rises from and sets into
 * @param {number} [p.observerDy] his height above the ground, for parallax
 * @param {number} p.progress01 song progress
 * @returns {{x:number, y:number, scale:number, distance:number}}
 */
export function celestialApproach({
  orbitX, orbitY, horizonY, observerDy = 0, progress01,
}) {
  return {
    x: orbitX,
    y: approachedY(orbitY, horizonY, observerDy, progress01),
    scale: approachScale(progress01),
    distance: approachDistance(progress01),
  };
}
