// Which real mountain range a song plays against.
//
// The song and every range are placed on the same four axes
// (RangeCharacter.AXES) and the song gets a range near it. Works the same
// with one range in the basket or three hundred.
//
//   energy     song drive                    <-> ruggedness and peak density
//   rawness    percussive onsets and grit    <-> unweathered, irregular skyline
//   grandeur   dynamic range (the song's arc) <-> vertical relief
//   dominance  a standout climax (contrast)  <-> one commanding summit
//
// Key colours the emotional reading: a confident minor key leans toward the
// heavier archetypes, a major key toward the brighter ones.
//
// Spread. Matching raw scores sent every loud song to Denali: its relief
// scores 0.98 and nothing else comes close, so any big dynamic arc landed
// there. So the ranges are compared by RANK on each axis -- a range's score
// is where it stands in its basket, 0 lowest to 1 highest -- and the song is
// placed by PERCENTILE, against how real songs spread on each axis, so both
// sides fill the same space evenly.
//
// Then a lottery, not a nearest-wins. Every range keeps FAIR_SHARE of an
// equal share of every song's draw; the rest goes to the ranges nearest the
// song's character. So each range gets a roughly equal chance across many
// songs, a song still leans toward ranges like it, and one song always draws
// the same range (the seed is the ticket). Ranges this player saw recently
// sit the draw out while anything else is left.
//
// Three ridges, three ranges. The back ridge is a high range, the middle a
// mid one and the front a low one, by relief -- how far the skyline rises
// above its own floor. Each band runs its own draw (matchRidgeSet).
import { AXES, axisDistance } from './RangeCharacter.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The share of every draw split equally across the basket, before
// character has a say: no range ever has less than 65% of an equal chance
// at any song. Measured over 3000 songs drawn from the evaluation fixtures,
// with the play history on, every range in every band lands between about
// 0.7x and 1.35x an equal share, while the ranges drawn still sit nearer the
// song than a blind pick would (distance 0.66 against 0.79).
export const FAIR_SHARE = 0.65;
// The home-biome draw (BiomeSet.chooseSongBiomes) has used the same value;
// it is named separately so neither the range pool nor the Range v2 scenic
// pool (SceneCatalog.SCENIC_FAIR_SHARE) can move it by accident.
export const HOME_BIOME_FAIR_SHARE = 0.65;
// How quickly character preference falls off with distance on the rank
// axes. Nearest neighbours among ~25 ranges spread through four axes sit
// about 0.35 apart, so this favours a song's nearest handful.
const KERNEL_WIDTH = 0.4;
// How much a key-matched archetype is preferred, as distance taken off.
const MODE_PULL = 0.05;
const MINOR_ARCHETYPES = new Set(['brooding', 'sublime', 'wild', 'restless']);
const MAJOR_ARCHETYPES = new Set(['majestic', 'serene', 'defiant']);

// How the song-side watch values spread over real material, per axis, as
// knots: the 10/25/50/75/90th percentiles of the
// world-evaluation fixture set (test/fixtures/world-evaluation.json, 16
// tracks across genres), pinned at 0 and 1. Without this a song's drive
// sits between 0.2 and 0.7 however hard it goes, and only the ranges in
// the middle of the basket ever get the character share of the draw.
const SONG_KNOTS = {
  drive: [0.19, 0.27, 0.44, 0.60, 0.73],
  rawness: [0.24, 0.29, 0.33, 0.45, 0.58],
  arc: [0.28, 0.36, 0.43, 0.59, 0.75],
  contrast: [0.23, 0.30, 0.35, 0.54, 0.71],
};
const KNOT_PCT = [0.1, 0.25, 0.5, 0.75, 0.9];

/** Percentile (0..1) of `v` against one axis's knots, linear between them. */
export function songPercentile(v, knots) {
  const xs = [0, ...knots, 1];
  const ps = [0, ...KNOT_PCT, 1];
  const x = clamp01(v);
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      return span > 0 ? ps[i - 1] + ((x - xs[i - 1]) / span) * (ps[i] - ps[i - 1]) : ps[i];
    }
  }
  return 1;
}

/** Where a song sits on the range axes, from its SongProfile, as
 *  percentiles of real material (so 0.5 is a typical song). */
export function songTerrainTarget(profile) {
  const w = profile?.watch || {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  // A missing reading is a typical song: the median knot.
  const raw = {
    drive: num(w.drive, SONG_KNOTS.drive[2]),
    rawness: 0.55 * num(w.onset, 0.25) + 0.45 * num(w.texture, 0.42),
    arc: num(w.arc, SONG_KNOTS.arc[2]),
    contrast: num(w.contrast, SONG_KNOTS.contrast[2]),
  };
  return {
    energy: songPercentile(raw.drive, SONG_KNOTS.drive),
    rawness: songPercentile(raw.rawness, SONG_KNOTS.rawness),
    grandeur: songPercentile(raw.arc, SONG_KNOTS.arc),
    dominance: songPercentile(raw.contrast, SONG_KNOTS.contrast),
  };
}

function keyPull(range, tonal) {
  if (!tonal?.mode || !(tonal.confidence >= 0.3)) return 0;
  const favoured = tonal.mode === 'minor' ? MINOR_ARCHETYPES : MAJOR_ARCHETYPES;
  return favoured.has(range.archetype) ? MODE_PULL : 0;
}

const valid = (r) => r && r.scores && AXES.every((a) => Number.isFinite(r.scores[a]));
const rankCache = new WeakMap();
/** Each usable range's rank on each axis within `basket`, 0..1 (ties share
 *  the mean rank). One range alone sits at 0.5. Cached per basket array. */
export function rankScores(basket) {
  const hit = rankCache.get(basket);
  if (hit) return hit;
  const ranges = basket.filter(valid);
  const out = new Map(ranges.map((r) => [r, {}]));
  for (const axis of AXES) {
    const sorted = [...ranges].sort((a, b) => a.scores[axis] - b.scores[axis]);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].scores[axis] === sorted[i].scores[axis]) j++;
      const rank = sorted.length > 1 ? ((i + j) / 2) / (sorted.length - 1) : 0.5;
      for (let k = i; k <= j; k++) out.get(sorted[k])[axis] = rank;
      i = j + 1;
    }
  }
  rankCache.set(basket, out);
  return out;
}

// Reference songs for catchment: a Halton sequence through the four
// percentile axes, i.e. songs spread evenly over everywhere a song can land.
const REFERENCE_SONGS = (() => {
  const halton = (i, b) => { let f = 1; let r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  return Array.from({ length: 512 }, (_, i) => ({
    energy: halton(i + 1, 2), rawness: halton(i + 1, 3), grandeur: halton(i + 1, 5), dominance: halton(i + 1, 7),
  }));
})();

const kernelAt = (d) => Math.exp(-((Math.max(0, d) / KERNEL_WIDTH) ** 2));

const catchCache = new WeakMap();
/** How much of the song space leans toward each range, relative to the
 *  basket's average (1 = average). A range in a crowded middle shares its
 *  songs with many neighbours; one on an edge or a corner has the songs out
 *  there to itself. Dividing a range's character share by this evens out
 *  how often each is drawn across many songs. Cached per basket. */
export function catchment(basket) {
  const hit = catchCache.get(basket);
  if (hit) return hit;
  const ranks = rankScores(basket);
  const ranges = [...ranks.keys()];
  const mass = new Map(ranges.map((r) => [r, 0]));
  for (const song of REFERENCE_SONGS) {
    const k = ranges.map((r) => kernelAt(axisDistance(song, ranks.get(r))));
    const sum = k.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) continue;
    ranges.forEach((r, i) => mass.set(r, mass.get(r) + k[i] / sum));
  }
  const mean = REFERENCE_SONGS.length / (ranges.length || 1);
  const out = new Map(ranges.map((r) => [r, mean > 0 ? Math.max(0.05, mass.get(r) / mean) : 1]));
  catchCache.set(basket, out);
  return out;
}

/** Every range, nearest first, compared by rank. */
export function rankRanges(ranges, target, tonal = null) {
  const ranks = rankScores(ranges);
  return [...ranks.keys()]
    .map((range) => ({ range, distance: axisDistance(target, ranks.get(range)) - keyPull(range, tonal) }))
    .sort((a, b) => a.distance - b.distance || a.range.id.localeCompare(b.range.id));
}

/** A ticket in [0, 1) from the song's seed and a salt: the same song draws
 *  the same ticket, and each ridge draws its own. */
export function seedTicket(seed, salt = 0) {
  let h = (Math.abs(Math.trunc(Number(seed) || 0)) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Each ranked range's chance in this song's draw, in ranked order: an equal
 *  FAIR_SHARE plus a character share that falls off with distance (divided
 *  by the range's catchment, when given). Ranges
 *  in `recent` get none while any other range is left. Sums to 1. */
export function drawOdds(ranked, { recent = [], fairShare = FAIR_SHARE, catchments = null } = {}) {
  const seen = new Set(recent);
  let open = ranked.map((r) => !seen.has(r.range.id));
  if (!open.some(Boolean)) open = ranked.map(() => true);
  const count = open.filter(Boolean).length;
  const kernel = ranked.map((r, i) => (open[i] ? kernelAt(r.distance) / (catchments?.get(r.range) || 1) : 0));
  const kSum = kernel.reduce((a, b) => a + b, 0);
  return ranked.map((r, i) => {
    if (!open[i]) return 0;
    const byCharacter = kSum > 0 ? kernel[i] / kSum : 1 / count;
    return fairShare / count + (1 - fairShare) * byCharacter;
  });
}

/**
 * The range for this song, or null if the basket is empty. `seed` is the
 * song's ticket in the draw (drawOdds); `recent` lists range ids this player
 * saw lately, which sit the draw out while anything else is left. `salt`
 * gives each ridge of one song its own ticket.
 */
export function matchRange(ranges, profile, seed = 0, { recent = [], salt = 0 } = {}) {
  const target = songTerrainTarget(profile);
  const ranked = rankRanges(ranges, target, profile?.tonal);
  if (!ranked.length) return null;
  const odds = drawOdds(ranked, { recent, catchments: catchment(ranges) });
  const ticket = seedTicket(seed, salt);
  let at = 0;
  let pick = ranked.length - 1;
  for (let i = 0; i < ranked.length; i++) {
    at += odds[i];
    if (ticket < at) { pick = i; break; }
  }
  while (!(odds[pick] > 0) && pick > 0) pick--;
  return { range: ranked[pick].range, distance: ranked[pick].distance, odds: odds[pick], target, ranked };
}

// The three ridges, back to front, and the relief band each draws from.
// The band edges are the discovery tool's (tools/lib/rangeDiscovery.mjs
// RELIEF_BANDS), which keeps the basket split roughly evenly between them.
export const RIDGE_BANDS = Object.freeze([
  Object.freeze({ ridge: 'far', layer: 'L2', band: 'high', minM: 2000, maxM: Infinity }),
  Object.freeze({ ridge: 'mid', layer: 'L3', band: 'mid', minM: 1200, maxM: 2000 }),
  Object.freeze({ ridge: 'near', layer: 'L4', band: 'low', minM: 0, maxM: 1200 }),
]);

/** 'high' | 'mid' | 'low' by the range's relief, or null when unknown. */
export function reliefBand(range) {
  const m = Number(range?.reliefM);
  if (!Number.isFinite(m)) return null;
  const hit = RIDGE_BANDS.find((b) => m >= b.minM && m < b.maxM);
  return hit ? hit.band : null;
}

const bandCache = new WeakMap();
/** The basket split by band. Cached per basket, so each band's ranks are
 *  computed once. */
export function bandBaskets(basket) {
  const hit = bandCache.get(basket);
  if (hit) return hit;
  const out = { high: [], mid: [], low: [] };
  for (const r of basket) {
    const band = reliefBand(r);
    if (band) out[band].push(r);
  }
  bandCache.set(basket, out);
  return out;
}

/**
 * One range per ridge: { far, mid, near }, each a matchRange result or null
 * when its band is empty. Ranges are compared by rank within their own
 * band, and each ridge draws its own ticket from the one song seed.
 */
export function matchRidgeSet(ranges, profile, seed = 0, { recent = [] } = {}) {
  const bands = bandBaskets(ranges);
  const out = {};
  RIDGE_BANDS.forEach((b, i) => {
    out[b.ridge] = matchRange(bands[b.band], profile, seed, { recent, salt: i });
  });
  return out;
}
