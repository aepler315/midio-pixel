// Listening owns the landscape from frame zero in every registered world.
// The inhabited-shore overlay is retired: its fixed foreground sea, boat
// and residents covered the landscape. Keep the scenery visible through
// the bottom of the frame, with standalone performer effects disabled too.
//
// Trio is the Range as it was before real terrain: the cast performs on it,
// Midasus's voyages draw in the deep sky, seeded planets hang behind the
// celestial bodies, the space ridge is its crystalline node line rather
// than Landscape's aurora, the dancing spectrum ridge rides the horizon
// (horizonEq), and the sky is the pre-terrain one rather than The Range's
// composed sky (rangeSky).
const landscape = Object.freeze({ performers: false, decorativeActors: false, artificialNearProps: false, inhabitants: false,
  skyEnsemble: false, crystalSpaceRidge: false, horizonEq: false, rangeSky: true });
const trio = Object.freeze({ performers: true, decorativeActors: false, artificialNearProps: false, inhabitants: false,
  skyEnsemble: true, crystalSpaceRidge: true, horizonEq: true, rangeSky: false });
export function resolveLandscapePresentation(world, experience = world?.experience) {
  return experience === 'trio' ? trio : landscape;
}
