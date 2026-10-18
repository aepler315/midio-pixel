// Listening owns the landscape from frame zero in every registered world.
// The inhabited-shore overlay is retired: its fixed foreground sea, boat
// and residents covered the landscape. Keep the scenery visible through
// the bottom of the frame, with standalone performer effects disabled too.
const landscape = Object.freeze({ performers: false, decorativeActors: false, artificialNearProps: false, inhabitants: false });
const trio = Object.freeze({ performers: true, decorativeActors: false, artificialNearProps: false, inhabitants: false });
export function resolveLandscapePresentation(world, experience = 'landscape') { return experience === 'trio' ? trio : landscape; }
