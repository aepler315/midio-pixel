// Forest wind on the score and the storm. The trees' sway (ForestGL
// windAt) keeps its heard-time phase; the score and the squall set how
// hard it blows (gain) and lean the crowns downwind (lean) along the fixed
// world wind the clouds drift on (RangeCloudField: [t * 10, t * 3]). Pure in
// the frame's frozen effects and storm, so seek, pause, display and capture
// agree. Silence and fair weather leave the established sway unchanged.

/** Idle sway amplitude, as a fraction of tree height (ForestGL windAt). */
export const WIND_SWAY = 0.012;
/** Peak of the sway's two sines (.6 + .25) and its xz shape (s, .4 s). */
export const WIND_SWAY_PEAK = (0.6 + 0.25) * Math.hypot(1, 0.4);
/** Strongest sway multiplier the score and storm can reach. */
export const WIND_MAX_GAIN = 1.8;
/** Crown lean at a full gust, as a fraction of tree height. */
export const GUST_LEAN = 0.08;
/** Crown lean away from Broshi as he passes, as a fraction of height. */
export const PARTING_LEAN = 0.2;
/** Downwind lean under the full squall, as a fraction of height. */
export const STORM_LEAN = 0.03;
/** The fixed world wind direction in xz (the clouds' drift, normalised). */
export const WIND_DIR = Object.freeze([10 / Math.hypot(10, 3), 3 / Math.hypot(10, 3)]);
/** The largest crown displacement any of them can add together, as a
 *  fraction of height: ForestDetail's footprint bound must cover it. */
export const FOREST_MAX_LEAN = WIND_SWAY * WIND_SWAY_PEAK * WIND_MAX_GAIN + GUST_LEAN + PARTING_LEAN + STORM_LEAN;

const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Writes [gain, lean] into `out` (any 2-slot array) and returns it:
 *  gain multiplies the idle sway, lean is the downwind crown lean. [1, 0]
 *  for absent or non-finite input. */
export function forestWindAt(effects, storm, out = [1, 0]) {
  const amount = unit(storm?.amount), clearing = unit(storm?.break01);
  out[0] = Math.min(WIND_MAX_GAIN, 1 + .35 * unit(effects?.energy) + .5 * unit(effects?.lift)
    + .15 * unit(effects?.bass) + .6 * amount);
  out[1] = STORM_LEAN * amount * (1 - clearing);
  return out;
}
