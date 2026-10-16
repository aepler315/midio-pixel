// Listening owns the landscape from frame zero in every registered world.
// Inhabitants: the Range's inhabited shore (Midio's ship, Broshi on the
// beach, Midasus in the sky) -- the only place the three characters are
// drawn. Performers stays off: its effects (drop impact, fever aura, motion
// blur) anchor to the retired standalone Midio, which is no longer drawn, so
// they would radiate from an empty spot. Decorative actors and artificial
// near props stay off: their owners (sky ensemble, far vignettes) were
// removed and those code paths dereference null.
const landscape = Object.freeze({ performers: false, decorativeActors: false, artificialNearProps: false, inhabitants: true });
export function resolveLandscapePresentation() { return landscape; }
