// The Range's biomes: real ones, each standing on its own real ranges.
//
// Every range in the basket was sampled against the RESOLVE Ecoregions 2017
// map (tools/classify-range-biomes.mjs -> terrain/rangeBiomes.js), which puts
// each of its 846 ecoregions in one of 14 biomes. Nine of those biomes turn
// up under the basket's ranges. Three of them cover landscapes that do not
// look alike -- a temperate conifer forest is both the wet coast of British
// Columbia and the dry lodgepole of Wyoming -- so those are split along
// ecoregion lines into the places a viewer would tell apart. That rule, and
// not a target count, is where the eleven below come from:
//
//   RESOLVE biome                      ecoregion rule            biome here
//   Rock and Ice                       --                        ICEFIELD
//   Tundra                             --                        TUNDRA
//   Boreal Forests/Taiga               --                        TAIGA
//   Temperate Conifer Forests          coastal / North Cascades  RAINFOREST
//                                      Arizona Mountains forests PINE_OAK
//                                      the rest                  CONIFER
//   Tropical & Subtropical Coniferous  --                        PINE_OAK
//   Temperate Broadleaf & Mixed        --                        BROADLEAF
//   Mediterranean Forests & Scrub      --                        CHAPARRAL
//   Temperate Grasslands               --                        STEPPE
//   Deserts & Xeric Shrublands         shrub steppe              STEPPE
//                                      Colorado Plateau          CANYON
//                                      the rest                  DESERT
//
// Each biome's look is its real light and ground: the ice-blue of a glacier
// basin, the green-black of coastal rainforest, the red of the Colorado
// Plateau. Unlike the invented palettes (BiomeProfiles.js, kept for the
// other worlds), these are not hue-rotated to the song's key: a desert
// turned violet is not a desert any more.
import { RANGES } from './terrain/ranges/index.js';
import RANGE_BIOMES from './terrain/rangeBiomes.js';

/** Which of our biomes a RESOLVE classification lands in. */
export function biomeForEcoregion({ biome = '', ecoregion = '' } = {}) {
  switch (biome) {
    case 'N/A': return 'ICEFIELD'; // RESOLVE's "Rock and Ice"
    case 'Tundra': return 'TUNDRA';
    case 'Boreal Forests/Taiga': return 'TAIGA';
    case 'Temperate Conifer Forests':
      if (/coastal|North Cascades/i.test(ecoregion)) return 'RAINFOREST';
      if (/Arizona Mountains/i.test(ecoregion)) return 'PINE_OAK';
      return 'CONIFER';
    case 'Tropical & Subtropical Coniferous Forests': return 'PINE_OAK';
    case 'Temperate Broadleaf & Mixed Forests': return 'BROADLEAF';
    case 'Mediterranean Forests, Woodlands & Scrub': return 'CHAPARRAL';
    case 'Temperate Grasslands, Savannas & Shrublands': return 'STEPPE';
    case 'Deserts & Xeric Shrublands':
      if (/shrub steppe/i.test(ecoregion)) return 'STEPPE';
      if (/Colorado Plateau/i.test(ecoregion)) return 'CANYON';
      return 'DESERT';
    default: return null;
  }
}

/** A range's biome name, or null for a range the classifier has not seen. */
export function biomeOfRange(id) {
  const row = RANGE_BIOMES.ranges?.[id];
  return row ? biomeForEcoregion(row) : null;
}

/** The ecoregion a range stands in ("Northern Rockies conifer forests"). */
export function ecoregionOfRange(id) {
  return RANGE_BIOMES.ranges?.[id]?.ecoregion || null;
}

export const REAL_BIOMES = [
  {
    name: 'ICEFIELD',
    title: 'Icefield',
    sky: ['#0b1f3a', '#3f6f9c', '#dbe9f5'],
    silhouette: '#56718c',
    celestial: { kind: 'sun', color: '#f6fbff', radius: 34, haloColor: '#ffffff', ring: true },
    particles: { kind: 'snow', color: '#ffffff', count: 64, speed: 48 },
    fx: 'crystalGlint',
    terrainEnergy: 1.3,
    density: { L4: 0, L5: 0 },
  },
  {
    name: 'TUNDRA',
    title: 'Tundra',
    sky: ['#0e1a33', '#3d5a80', '#c9d6c8'],
    silhouette: '#4d5a58',
    celestial: { kind: 'moon', color: '#eef4ff', radius: 36, haloColor: '#9fe6c8' },
    particles: { kind: 'wind', color: '#e8f0f0', count: 30, speed: 60 },
    fx: 'aurora',
    terrainEnergy: 1.1,
    density: { L4: 0.4, L5: 0.6 },
  },
  {
    name: 'TAIGA',
    title: 'Boreal Taiga',
    sky: ['#101c30', '#40587a', '#e8c9a0'],
    silhouette: '#23332f',
    celestial: { kind: 'sun', color: '#ffe2b8', radius: 40, haloColor: '#ffd49a' },
    particles: { kind: 'snow', color: '#f4f8ff', count: 34, speed: 26 },
    fx: 'aurora',
    terrainEnergy: 0.95,
    density: { L4: 2.2, L5: 1.6 },
  },
  {
    name: 'RAINFOREST',
    title: 'Temperate Rainforest',
    sky: ['#1a2a30', '#51707a', '#b9c8c4'],
    silhouette: '#1c3129',
    celestial: { kind: 'sun', color: '#f0f4e8', radius: 38, haloColor: '#d8e4d0', veiled: true, shafts: true },
    particles: { kind: 'rain', color: '#b8ccd4', count: 60, speed: 0 },
    fx: 'godRays',
    terrainEnergy: 0.85,
    density: { L4: 3, L5: 2.2 },
  },
  {
    name: 'CONIFER',
    title: 'Mountain Conifer Forest',
    sky: ['#12305a', '#4a82bf', '#e4eef2'],
    silhouette: '#2c3f3e',
    celestial: { kind: 'sun', color: '#fff6dc', radius: 42, haloColor: '#fff0c0' },
    particles: { kind: 'pollen', color: '#fff2c4', count: 26, speed: 10 },
    fx: 'lakeReflection',
    terrainEnergy: 1.05,
    density: { L4: 2.4, L5: 1.4 },
  },
  {
    name: 'PINE_OAK',
    title: 'Pine-Oak Highlands',
    sky: ['#1d3a66', '#6f9ccc', '#f2dcb4'],
    silhouette: '#3d4633',
    celestial: { kind: 'sun', color: '#fff0c8', radius: 46, haloColor: '#ffd89a' },
    particles: { kind: 'fireflies', color: '#fff4b0', count: 20, speed: 10 },
    fx: 'lightning',
    terrainEnergy: 1.0,
    density: { L4: 1.4, L5: 1.1 },
  },
  {
    name: 'BROADLEAF',
    title: 'Broadleaf Forest',
    sky: ['#26345c', '#8a7fa6', '#f4c89a'],
    silhouette: '#3a3a4e',
    celestial: { kind: 'sun', color: '#ffd9a0', radius: 48, haloColor: '#ffb87a', shafts: true },
    particles: { kind: 'petals', color: '#d9772f', count: 36, speed: 26 },
    fx: 'sunMotes',
    terrainEnergy: 0.7,
    density: { L4: 2.6, L5: 1.4 },
  },
  {
    name: 'CHAPARRAL',
    title: 'Chaparral',
    sky: ['#2a3e6a', '#c28a6a', '#ffd9a8'],
    silhouette: '#5a4a3a',
    celestial: { kind: 'sun', color: '#ffd28a', radius: 52, haloColor: '#ffb070', veiled: true },
    particles: { kind: 'sunshine', color: '#ffe0a0', count: 18, speed: 12 },
    fx: 'heatShimmer',
    terrainEnergy: 0.9,
    density: { L4: 1.8, L5: 1.2 },
  },
  {
    name: 'STEPPE',
    title: 'Sagebrush Steppe',
    sky: ['#1f3f72', '#7aa6d0', '#eadfc6'],
    silhouette: '#6a6a5a',
    celestial: { kind: 'sun', color: '#fff4d8', radius: 44, haloColor: '#ffe8b8' },
    particles: { kind: 'wind', color: '#e6dcc0', count: 34, speed: 70 },
    fx: 'sunMotes',
    terrainEnergy: 0.95,
    density: { L4: 1.6, L5: 1.2 },
  },
  {
    name: 'CANYON',
    title: 'Red Rock Canyon',
    sky: ['#1e2f5e', '#b0664a', '#ffc08a'],
    silhouette: '#7a3a24',
    celestial: { kind: 'sun', color: '#ffc27a', radius: 50, haloColor: '#ff9a5a' },
    particles: { kind: 'sand', color: '#e0a070', count: 30, speed: 40 },
    fx: 'starTwinkle',
    terrainEnergy: 1.2,
    density: { L4: 0.6, L5: 0.8 },
  },
  {
    name: 'DESERT',
    title: 'Hot Desert',
    sky: ['#2c2a5a', '#d4885a', '#ffe0a8'],
    silhouette: '#6e4a3a',
    celestial: { kind: 'sun', color: '#fff0b0', radius: 58, haloColor: '#ffc860', dominant: true },
    particles: { kind: 'sand', color: '#f0c890', count: 26, speed: 34 },
    fx: 'heatShimmer',
    terrainEnergy: 1.15,
    density: { L4: 0.8, L5: 0.9 },
  },
].map((b) => Object.freeze({ ...b, real: true, landmarkKey: b.name }));

export const REAL_BIOME_NAMES = REAL_BIOMES.map((b) => b.name);

/** The basket's ranges, grouped by biome: name -> [range index entry]. */
export function rangesByBiome(ranges = RANGES) {
  const out = new Map(REAL_BIOME_NAMES.map((n) => [n, []]));
  for (const r of ranges) {
    const b = biomeOfRange(r.id);
    if (b && out.has(b)) out.get(b).push(r);
  }
  return out;
}

/**
 * Where each biome sits on the song's energy axis, 0 (calmest) to 1: the
 * rank of its ranges' mean terrain energy (RangeCharacter's slope, peak
 * density and roughness). This is the one dimension a biome is matched to
 * the music on, and it is measured off the real ground, not assigned: a
 * quiet verse gets the gentlest land the basket has, a loud chorus the
 * most violent.
 */
export function realBiomeTemperature(ranges = RANGES) {
  const groups = rangesByBiome(ranges);
  const means = REAL_BIOME_NAMES.map((name) => {
    const list = groups.get(name);
    const m = list.length ? list.reduce((s, r) => s + (r.scores?.energy ?? 0.5), 0) / list.length : 0.5;
    return [name, m];
  }).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const n = means.length;
  return Object.fromEntries(means.map(([name], i) => [name, n > 1 ? i / (n - 1) : 0.5]));
}

export const REAL_BIOME_TEMPERATURE = realBiomeTemperature();

/** Physics dials (see BiomePersonality.js for what each one does). */
export const REAL_PERSONALITY = {
  ICEFIELD: { swarmBand: [0.05, 0.25], turbulence: 1.5, haze: 0.6, mandalaRate: 0.7 },
  TUNDRA: { swarmBand: [0.05, 0.25], turbulence: 1.3, haze: 0.7 },
  TAIGA: { swarmBand: [0.15, 0.45], turbulence: 0.8, haze: 1.0 },
  RAINFOREST: { swarmBand: [0.25, 0.60], turbulence: 0.6, haze: 1.6 },
  CONIFER: { swarmBand: [0.20, 0.50], turbulence: 0.9, haze: 0.9 },
  PINE_OAK: { swarmBand: [0.20, 0.55], turbulence: 1.1, haze: 1.1 },
  BROADLEAF: { swarmBand: [0.25, 0.60], turbulence: 0.7, haze: 1.3 },
  CHAPARRAL: { swarmBand: [0.25, 0.55], turbulence: 1.0, haze: 1.4 },
  STEPPE: { swarmBand: [0.20, 0.50], turbulence: 1.4, haze: 0.9 },
  CANYON: { swarmBand: [0.25, 0.55], turbulence: 0.9, haze: 1.0 },
  DESERT: { swarmBand: [0.30, 0.60], turbulence: 0.8, haze: 1.6 },
};

export function realBiomeByName(name) {
  return REAL_BIOMES.find((b) => b.name === name) || null;
}
