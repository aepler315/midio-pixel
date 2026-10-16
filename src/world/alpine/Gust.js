// Gust fronts: each kick (spaced at least GUST_FRONT_SPACING_MS from the
// last that started one) sends a front across the Range forest. Shared by
// the music history (which kicks start fronts), the frame (their ages and
// directions) and the forest shader (how many it carries).

/** Fronts carried at once: enough that the oldest has all but settled
 *  everywhere on screen before it is let go. */
export const GUST_FRONTS = 6;
/** Closer kicks ride an earlier front instead of starting their own, so
 *  at most one gust sets off per spacing and the forest is never crossed by
 *  a crowd of them at once. */
export const GUST_FRONT_SPACING_MS = 2400;
/** Seconds for a front to cross the frame: a gust rolling through a real
 *  forest, not a flick. */
export const GUST_SWEEP_SEC = 6.0;
/** A gust age long past any envelope: an empty slot. */
export const GUST_IDLE_SEC = 1000;
