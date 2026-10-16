// The dancing ridge on the horizon, shaped like a real one.
//
// The horizon EQ (BiomeManager._drawHorizonEQ) is a luminous ridge whose
// height is the live 7-band spectrum. On its own that spectrum is a smooth
// hump with no geography in it. Here it gets a real crest to stand on: one
// of a short list of famous skylines in the lower 48 and southern British
// Columbia and Alberta (HORIZON_RANGES), taken from the same scanned
// profiles the parallax ridges draw.
//
// The crest is the ridge's resting shape; the music scales it. Height at
// any point is crest x (rest + (1 - rest) x band level), anchored at the
// foot, so a loud band lifts that stretch of the real ridge and a quiet one
// lowers it, and the outline -- the Grand Teton's spire, Rainier's dome --
// never stops reading as itself. Scaling a smooth crest by a smooth,
// time-smoothed band level keeps a steep face smooth as it drops: every
// point on the face moves in proportion, so the face shortens rather than
// breaking up.
//
// Across the song the view slides along the range, from one side of the
// summit to the other, so the summit is on screen for most of it. Pure
// math, no canvas: BiomeManager draws it, tests exercise it directly.
import { clamp01 } from '../../utils/math.js';
import { profileUnits } from './TerrainProfile.js';
import { seedTicket } from './RangeMatcher.js';
import { RANGES } from './ranges/index.js';

// Famous skylines only, and only south of about 52 degrees north: the
// lower 48, and British Columbia and Alberta's southern ranges. Ids from
// the range basket (ranges/index.js); each one's scanned far skyline is
// the crest. Chosen by eye as well as by name: a range whose scan is an
// even row of teeth (the Sawtooths, Glacier's Livingston Range, the
// Sangre de Cristos) reads as noise once it is stretched to the EQ's
// height, so those are left out.
export const HORIZON_RANGES = Object.freeze([
  'tetons', // Grand Teton
  'rainier', // Mount Rainier
  'sierra-whitney', // Mount Whitney
  'california-cascades', // Mount Shasta
  'oregon-cascades', // Mount Hood
  'skagit-range', // Mount Baker
  'north-cascades', // Glacier Peak
  'olympic-mountains', // the Olympics
  'front-range', // Pikes Peak
  'wasatch', // Lone Peak
  'white-mountains', // White Mountain Peak, the bristlecone range
  'san-jacinto-mountains', // San Jacinto Peak over Palm Springs
  'mission-mountains', // McDonald Peak
  'canadian-rockies', // Lake Louise
  'selkirk-mountains', // Rogers Pass
  'garibaldi-ranges', // Mount Garibaldi
  'waddington-range', // Mount Waddington
]);

// Constant source-specific framing choices from start/middle/end review.
// These shorter scans retain neighboring landmarks at twice reviewed speed.
export const HORIZON_SOURCE_SPEED = Object.freeze({
  tetons: 2, rainier: 2, 'oregon-cascades': 2, 'skagit-range': 2,
  'north-cascades': 2, 'front-range': 2, 'mission-mountains': 2,
  'canadian-rockies': 2, 'selkirk-mountains': 2, 'garibaldi-ranges': 2, 'waddington-range': 2,
});

// How much of the range is on screen at once, and how far the view slides
// along it over a whole song.
export const HORIZON_WINDOW_M = 28000;
export const HORIZON_TRAVEL_M = 8000;
// Crest sample spacing: coarser than the 30 m scan, box-averaged, so a
// distant ridge is not a saw of single-sample spikes.
export const HORIZON_STEP_M = 150;
// The lowest point in view never sits flat on the foot.
const CREST_FLOOR = 0.3;
// Share of the crest's height that stands at total silence.
export const HORIZON_REST = 0.4;

/** The song's horizon range: drawn evenly from HORIZON_RANGES, passing over
 *  `exclude` (ids already standing in the song's own ridges). Null when
 *  nothing is left. A different `salt` is a different draw -- the massif
 *  behind the horizon draws its own. */
export function chooseHorizonRange(seed, { exclude = [], ranges = RANGES, salt = 307 } = {}) {
  const skip = new Set(exclude);
  const open = ranges.filter((r) => HORIZON_RANGES.includes(r.id) && !skip.has(r.id));
  if (!open.length) return null;
  const i = Math.min(open.length - 1, Math.floor(seedTicket(seed, salt) * open.length));
  return open[i];
}

/**
 * The stretch of a skyline profile the song will see, as 0..1 heights every
 * `stepM`: `window` metres on screen at once plus `travel` metres slid over
 * the song, centred on the profile's summit and normalised to its own low
 * and high points. Throws on a profile TerrainProfile will not accept.
 */
export function horizonCrest(profile, {
  windowM = HORIZON_WINDOW_M, travelM = HORIZON_TRAVEL_M, stepM = HORIZON_STEP_M,
  speedMul = 9, zoom = 1.2,
} = {}) {
  const units = profileUnits(profile);
  const n = units.length;
  const spacing = profile.spacingM;
  const lengthM = spacing * (n - 1);
  const oldWindow = Math.min(windowM, lengthM * 0.6);
  const oldTravel = Math.max(0, Math.min(travelM, lengthM - oldWindow));
  // Fit the full journey into finite scans while preserving screen speed.
  const shift = speedMul * oldTravel / oldWindow;
  const window = Math.min(oldWindow / zoom, lengthM / (1 + shift));
  const travel = window * shift;
  const stretch = window + travel;
  let summit = 0;
  for (let i = 1; i < n; i++) if (units[i] > units[summit]) summit = i;
  const start = Math.max(0, Math.min(lengthM - stretch, summit * spacing - stretch / 2));
  const count = Math.max(2, Math.round(stretch / stepM) + 1);
  const step = stretch / (count - 1);
  const half = Math.max(0, Math.round(step / spacing / 2));
  const heights = new Float32Array(count);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < count; k++) {
    const c = Math.round((start + k * step) / spacing);
    let sum = 0, m = 0;
    for (let j = Math.max(0, c - half); j <= Math.min(n - 1, c + half); j++) { sum += units[j]; m++; }
    const h = m ? sum / m : 0;
    heights[k] = h;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const span = hi - lo;
  for (let k = 0; k < count; k++) {
    heights[k] = CREST_FLOOR + (1 - CREST_FLOOR) * (span > 1e-9 ? (heights[k] - lo) / span : 0.5);
  }
  return { heights, stepM: step, windowM: window, travelM: travel, sourceStartM: start, sourceLengthM: lengthM, relativeSpeedMul: speedMul / 3, travelWindowRatio: shift };
}

/** Crest height (0..1) at `u` (0 left edge .. 1 right edge of the screen)
 *  when the song is `songP` (0..1) of the way through. */
export function crestHeightAt(crest, songP, u) {
  const { heights, stepM, windowM, travelM } = crest;
  const at = (clamp01(songP) * travelM + clamp01(u) * windowM) / stepM;
  const last = heights.length - 1;
  const i = Math.min(last - 1, Math.max(0, Math.floor(at)));
  const f = Math.min(1, Math.max(0, at - i));
  return heights[i] + (heights[i + 1] - heights[i]) * f;
}

/** The dancing height (0..1): the crest scaled by the band level `v`. */
export function horizonRidgeLift01(crest01, v) {
  return crest01 * (HORIZON_REST + (1 - HORIZON_REST) * clamp01(v));
}

// --- The massif --------------------------------------------------------
//
// The spectrum massif (BiomeManager._drawSpectrumMassif) is one impossibly
// large mountain far behind everything, crawling on a multi-second EQ. It
// stands on a real summit too: MASSIF_WINDOW_M of another famous skyline,
// centred on its highest point, held still (it has no travel -- the
// massif's own slow parallax is its motion). Its flanks taper to the foot
// over MASSIF_TAPER of its width, so a window that ends high on a ridge
// still lands as one mountain instead of a cut-off block.
export const MASSIF_SALT = 419;
export const MASSIF_WINDOW_M = 12000;
const MASSIF_TAPER = 0.14;

/** The massif's crest: horizonCrest over a short window with no travel. */
export function massifCrest(profile) {
  return horizonCrest(profile, { windowM: MASSIF_WINDOW_M, travelM: 0, speedMul: 1, zoom: 1 });
}

/** 0 at either edge of the massif, 1 over its middle, smoothstepped. */
export function massifTaper01(u) {
  const e = Math.min(clamp01(u), 1 - clamp01(u)) / MASSIF_TAPER;
  const t = Math.min(1, e);
  return t * t * (3 - 2 * t);
}

/** The massif's height (0..1) at `u` across it, for band level `v` there. */
export function massifRidgeLift01(crest, u, v) {
  return horizonRidgeLift01(crestHeightAt(crest, 0, u), v) * massifTaper01(u);
}
