// Which real biomes a song travels through, and which real ranges stand in
// each one.
//
// Reserve up to three deterministic candidates, home first. ChapterPlanner
// activates one home by default and admits travel only on persistent macro
// evidence. Candidates do not imply visits, and fine section/motif labels
// remain independent of geographic identity.
//
// Fairness follows the range draw (RangeMatcher.drawOdds): the home biome
// -- the one the song opens in -- is drawn with HOME_BIOME_FAIR_SHARE of its odds
// equal for every biome and the rest leaning toward biomes whose ground is
// as calm or as violent as the song (REAL_BIOME_TEMPERATURE). The biomes it
// travels on to are drawn evenly, so a song's later sections are free to
// go anywhere; castSongBiomes then gives the loudest sections the most
// violent of them.
import { HOME_BIOME_FAIR_SHARE, matchRange, seedTicket, songTerrainTarget } from './RangeMatcher.js';
import { REAL_BIOME_NAMES, REAL_BIOME_TEMPERATURE, rangesByBiome } from '../RealBiomes.js';
import { RANGES } from './ranges/index.js';
import { WALL_SHARE } from './ranges/shapes.js';

export const SONG_BIOME_COUNT = 3;
const KERNEL_WIDTH = 0.3;
const kernelAt = (d) => Math.exp(-((d / KERNEL_WIDTH) ** 2));

let defaultGroups = null;
function groupsFor(ranges) {
  if (ranges === RANGES) {
    if (!defaultGroups) defaultGroups = rangesByBiome(RANGES);
    return defaultGroups;
  }
  return rangesByBiome(ranges);
}

function draw(names, weights, ticket) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  for (let i = 0; i < names.length; i++) {
    at += weights[i] / sum;
    if (ticket < at) return i;
  }
  return names.length - 1;
}

/**
 * The song's biomes, home first: an array of up to `count` distinct biome
 * names, only biomes that have ranges to stand on.
 */
export function chooseSongBiomes(profile, seed = 0, {
  ranges = RANGES, count = SONG_BIOME_COUNT, temperature = REAL_BIOME_TEMPERATURE,
} = {}) {
  const groups = groupsFor(ranges);
  const open = REAL_BIOME_NAMES.filter((n) => groups.get(n)?.length > 0);
  if (!open.length) return [];
  const energy = songTerrainTarget(profile).energy;
  const out = [];
  let left = open.slice();
  for (let k = 0; k < count && left.length; k++) {
    let weights;
    if (k === 0) {
      const kernel = left.map((n) => kernelAt(Math.abs((temperature[n] ?? 0.5) - energy)));
      const kSum = kernel.reduce((a, b) => a + b, 0) || 1;
      weights = kernel.map((v) => HOME_BIOME_FAIR_SHARE / left.length + (1 - HOME_BIOME_FAIR_SHARE) * (v / kSum));
    } else {
      weights = left.map(() => 1);
    }
    const i = draw(left, weights, seedTicket(seed, 101 + k));
    out.push(left[i]);
    left = left.filter((_, j) => j !== i);
  }
  return out;
}

/**
 * Up to three distinct ranges from one biome, as { far, mid, near } match
 * results: an open skyline in front, with the remaining two ordered by
 * relief. Tall, flat scans remain available in the distance.
 * A biome with fewer than three ranges leaves the
 * middle ridge, then the front, to the game's own hills.
 */
export function chooseBiomeRidges(biome, profile, seed = 0, { ranges = RANGES, recent = [] } = {}) {
  const basket = groupsFor(ranges).get(biome) || [];
  const picked = [];
  let left = basket.slice();
  // Choose foreground first, where flat high windows obscure the music.
  // Retain a lottery among every suitably open scan in this biome.
  const best = Math.min(...basket.map((r) => WALL_SHARE[r.id] ?? 0));
  const open = basket.filter((r) => (WALL_SHARE[r.id] ?? 0) <= Math.max(0.25, best));
  const near = basket.length > 1
    ? matchRange(open, profile, seed, { recent, salt: 210 + 7 * REAL_BIOME_NAMES.indexOf(biome) })
    : null;
  if (near) left = left.filter((r) => r !== near.range);
  for (let k = 0; k < (near ? 2 : 1) && left.length; k++) {
    const hit = matchRange(left, profile, seed, { recent, salt: 211 + k + 7 * REAL_BIOME_NAMES.indexOf(biome) });
    if (!hit) break;
    picked.push(hit);
    left = left.filter((r) => r !== hit.range);
  }
  picked.sort((a, b) => (b.range.reliefM || 0) - (a.range.reliefM || 0));
  return { far: picked[0] || null, mid: picked[1] || null, near };
}

/**
 * Sections' labels onto the song's biomes. `labelEnergies` are the mean
 * energies of the song's distinct labels, in first-appearance order; the
 * first label -- the one the song opens on -- always gets the home biome,
 * so the opening never repaints when the whole-song analysis replaces the
 * opening's section map. The other labels are matched by rank: the loudest
 * label gets the most violent of the remaining biomes, the quietest the
 * calmest. A song with more labels than biomes reuses them, never on two
 * labels in a row.
 */
export function castSongBiomes(labelEnergies, songBiomes, temperature = REAL_BIOME_TEMPERATURE) {
  const n = labelEnergies.length;
  if (!n || !songBiomes?.length) return [];
  const out = new Array(n);
  out[0] = songBiomes[0];
  const rest = songBiomes.slice(1).sort((a, b) => (temperature[a] ?? 0.5) - (temperature[b] ?? 0.5));
  if (!rest.length) return out.fill(songBiomes[0]);
  const others = [];
  for (let i = 1; i < n; i++) others.push(i);
  // Quietest label first: rank r of m spreads across the sorted biomes.
  const byEnergy = others.slice().sort((a, b) => labelEnergies[a] - labelEnergies[b] || a - b);
  byEnergy.forEach((labelIdx, r) => {
    const at = byEnergy.length > 1 ? Math.round((r / (byEnergy.length - 1)) * (rest.length - 1)) : rest.length - 1;
    out[labelIdx] = rest[at];
  });
  // More labels than biomes can land two in a row on the same one.
  for (let i = 1; i < n; i++) {
    if (out[i] !== out[i - 1]) continue;
    const alt = songBiomes.find((b) => b !== out[i - 1] && b !== out[i + 1]);
    if (alt) out[i] = alt;
  }
  return out;
}
