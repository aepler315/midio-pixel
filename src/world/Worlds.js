// Worlds: graphic styles the song can be played in.
//
// A biome is a palette that rotates inside a world. A world is the landform
// contract those palettes paint onto — alpine ranges vs a night city vs
// a road. The registry is the seam: add a world object, a silhouette
// profile, and a draw path, and the chooser plus private recommendation
// pick it up with no other wiring.
//
// Choose-for-me is not genre ("this is a city-pop song"). It is private
// post-adaptation fit: would this world's response to THIS song sit in a
// sweet spot — enough going on, not clipping into noise. The gallery
// never shows that number.
import { REAL_BIOMES, REAL_BIOME_TEMPERATURE } from './RealBiomes.js';
import { castBiomes } from './Dramaturgy.js';
import { CITY_PALETTES, CITY_TEMPERATURE } from './city/CityPalettes.js';
import { FARSIDE_PALETTES, FARSIDE_TEMPERATURE } from './farside/FarsidePalettes.js';
import { FATHOM_PALETTES, FATHOM_TEMPERATURE } from './fathom/FathomPalettes.js';
import { REDLINE_PALETTES, REDLINE_TEMPERATURE } from './redline/RedlinePalettes.js';
import { FOUNDRY_PALETTES, FOUNDRY_TEMPERATURE } from './foundry/FoundryPalettes.js';
import { UNDERSTORY_PALETTES, UNDERSTORY_TEMPERATURE } from './understory/UnderstoryPalettes.js';
import { NAVE_PALETTES, NAVE_TEMPERATURE } from './nave/NavePalettes.js';

/** Channel `reads` keys are fields on the watch-features vector.
 *  `consumer` is `file#exportOrFunction` of the renderer that actually
 *  uses that signal. A scored channel with no consumer is a lie. */
const ALPINE_CHANNELS = [
  { id: 'orogeny', reads: 'arc', weight: 1.20, consumer: 'src/world/OrogenyDirector.js#orogenyGrowthAt' },
  { id: 'ridges', reads: 'form', weight: 1.10, consumer: 'src/world/alpine/Ridge.js#ambientDance' },
  { id: 'biomes', reads: 'contrast', weight: 1.00, consumer: 'src/world/Dramaturgy.js#castBiomes' },
  { id: 'weather', reads: 'texture', weight: 0.70, consumer: 'src/world/BiomeManager.js#_drawHaze' },
  { id: 'celestial', reads: 'air', weight: 0.50, consumer: 'src/world/BiomeManager.js#_drawCelestial' },
  { id: 'particles', reads: 'onset', weight: 0.60, consumer: 'src/world/ParticleField.js' },
];

const CITY_CHANNELS = [
  { id: 'skyline', reads: 'form', weight: 1.10, consumer: 'src/world/city/CitySilhouette.js#cityHeightField' },
  { id: 'windows', reads: 'onset', weight: 1.20, consumer: 'src/world/city/CitySilhouette.js#windowOccupancy' },
  { id: 'neon', reads: 'air', weight: 0.85, consumer: 'src/world/city/CityGlow.js#cityGlow' },
  { id: 'rain', reads: 'texture', weight: 0.90, consumer: 'src/world/city/drawCity.js#_drawHaze' },
  { id: 'traffic', reads: 'groove', weight: 1.05, consumer: 'src/world/city/drawCity.js#drawTraffic' },
  { id: 'sodium', reads: 'warmth', weight: 0.70, consumer: 'src/world/city/CityGlow.js#windowGlowAlpha' },
];

const FARSIDE_CHANNELS = [
  { id: 'limb', reads: 'form', weight: 0.90, consumer: 'src/world/farside/Vacuum.js#terminatorContrast' },
  { id: 'primary', reads: 'air', weight: 1.25, consumer: 'src/world/farside/Vacuum.js#illumination' },
  { id: 'stars', reads: 'spread', weight: 1.05, consumer: 'src/world/farside/drawFarside.js#drawDeepSky' },
  { id: 'terminator', reads: 'contrast', weight: 0.85, consumer: 'src/world/farside/Vacuum.js#terminatorContrast' },
  { id: 'regolith', reads: 'onset', weight: 0.40, consumer: 'src/world/farside/Vacuum.js#surfaceTrace' },
  { id: 'libration', reads: 'phrase', weight: 0.70, consumer: 'src/world/farside/Vacuum.js#illumination' },
];

const FATHOM_CHANNELS = [
  { id: 'caustics', reads: 'phrase', weight: 1.20, consumer: 'src/world/fathom/drawFathom.js#drawWaterLight' },
  { id: 'column', reads: 'warmth', weight: 1.10, consumer: 'src/world/WorldMusic.js#sampleWorldMusic' },
  { id: 'descent', reads: 'arc', weight: 0.80, consumer: 'src/world/fathom/drawFathom.js#drawWaterLight' },
  { id: 'drift', reads: 'texture', weight: 0.95, consumer: 'src/world/fathom/drawFathom.js#drawWaterLight' },
  { id: 'life', reads: 'form', weight: 0.70, consumer: 'src/world/fathom/drawFathom.js#drawLivingLight' },
  { id: 'vents', reads: 'onset', weight: 0.45, consumer: 'src/world/fathom/drawFathom.js#drawLivingLight' },
];

const REDLINE_CHANNELS = [
  { id: 'grid', reads: 'tempoHeat', weight: 1.40, consumer: 'src/world/redline/Cruise.js#cruiseRate' },
  { id: 'gantry', reads: 'groove', weight: 1.20, consumer: 'src/world/redline/Cruise.js#signageAlpha' },
  { id: 'signs', reads: 'onset', weight: 1.00, consumer: 'src/world/redline/Cruise.js#signageAlpha' },
  { id: 'horizon', reads: 'centroid', weight: 0.80, consumer: 'src/world/redline/Cruise.js#phrasePassage' },
  { id: 'sun', reads: 'energyMean', weight: 0.65, consumer: 'src/world/redline/drawRedline.js#_drawCelestial' },
  { id: 'tunnel', reads: 'contrast', weight: 0.75, consumer: 'src/world/redline/Cruise.js#phrasePassage' },
];

const FOUNDRY_CHANNELS = [
  { id: 'pour', reads: 'energyMean', weight: 1.30, consumer: 'src/world/foundry/Furnace.js#pourGlow' },
  { id: 'hammers', reads: 'onset', weight: 1.35, consumer: 'src/world/foundry/Furnace.js#machineStroke' },
  { id: 'stacks', reads: 'form', weight: 0.85, consumer: 'src/world/foundry/drawFoundry.js#_drawRidgeVolume' },
  { id: 'gantry', reads: 'bass', weight: 1.00, consumer: 'src/world/foundry/Furnace.js#millActivity' },
  { id: 'sparks', reads: 'dyn', weight: 0.95, consumer: 'src/world/foundry/drawFoundry.js' },
  { id: 'steam', reads: 'texture', weight: 0.60, consumer: 'src/world/foundry/drawFoundry.js' },
];

const UNDERSTORY_CHANNELS = [
  { id: 'growth', reads: 'arc', weight: 1.00, consumer: 'src/world/understory/Canopy.js#canopyGrowth' },
  { id: 'canopy', reads: 'texture', weight: 1.30, consumer: 'src/world/understory/Canopy.js#canopyGrowth' },
  { id: 'shafts', reads: 'air', weight: 0.90, consumer: 'src/world/understory/Canopy.js#shaftOpen' },
  { id: 'fabric', reads: 'spread', weight: 1.10, consumer: 'src/world/understory/drawUnderstory.js' },
  { id: 'colonies', reads: 'contrast', weight: 0.55, consumer: 'src/world/understory/Canopy.js#sporeBurst' },
  { id: 'motes', reads: 'onset', weight: 0.60, consumer: 'src/world/understory/Canopy.js#sporeBurst' },
];

const NAVE_CHANNELS = [
  { id: 'bays', reads: 'phrase', weight: 1.15, consumer: 'src/world/nave/Resonance.js#bayLit' },
  { id: 'vault', reads: 'form', weight: 1.25, consumer: 'src/world/nave/drawNave.js#_drawRidgeVolume' },
  { id: 'glass', reads: 'contrast', weight: 1.30, consumer: 'src/world/nave/Resonance.js#bayLit' },
  { id: 'organ', reads: 'bass', weight: 0.85, consumer: 'src/world/nave/Resonance.js' },
  { id: 'shafts', reads: 'air', weight: 0.70, consumer: 'src/world/nave/drawNave.js' },
  { id: 'censer', reads: 'onset', weight: 0.50, consumer: 'src/world/nave/drawNave.js' },
];


export const WORLDS = [
  // Palette, geometry and response controls each kind actually consumes
  // are declared in WorldAdaptation.KIND_CAPABILITIES. Adaptation reads
  // `kind`, never a parallel per-id table.
  {
    id: 'alpine',
    name: 'The Range',
    tagline: 'Mountains that breathe with the mix.',
    kind: 'alpine',
    comfort: { lo: 0.34, hi: 0.84 },
    channels: ALPINE_CHANNELS,
    prefer: {
      arc: [0.28, 0.90],
      onset: [0.10, 0.62],
      contrast: [0.22, 0.90],
      centroid: [0.28, 0.72],
    },
    affinity: { arc: 0.40, contrast: 0.25, tempoHeat: 0.35 },
    // Real biomes (RealBiomes.js), each on its own real ranges. The
    // invented palettes (BiomeProfiles.js) stay in the source for the
    // other worlds' code and tests.
    palettes: REAL_BIOMES,
    temperature: REAL_BIOME_TEMPERATURE,
    realBiomes: true,
    cast: (energies, seed) => castBiomes(energies, seed, REAL_BIOME_TEMPERATURE),
  },
  {
    id: 'nocturne',
    name: 'After Hours',
    tagline: 'A city that glows with the groove.',
    kind: 'city',
    comfort: { lo: 0.20, hi: 0.64 },
    channels: CITY_CHANNELS,
    prefer: {
      arc: [0.10, 0.55],
      onset: [0.12, 0.48],
      groove: [0.35, 0.85],
      warmth: [0.40, 0.90],
      centroid: [0.16, 0.52],
    },
    affinity: { groove: 0.42, warmth: 0.38, centroidInv: 0.20 },
    palettes: CITY_PALETTES,
    temperature: CITY_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, CITY_TEMPERATURE),
  },
  {
    id: 'farside',
    name: 'Far Side',
    tagline: 'No air. Nothing softens.',
    kind: 'airless',
    aerial: false,
    comfort: { lo: 0.02, hi: 0.30 },
    channels: FARSIDE_CHANNELS,
    prefer: {
      air: [0.22, 0.95],
      centroid: [0.45, 0.98],
      warmth: [0.02, 0.45],
      onset: [0.00, 0.26],
      spread: [0.35, 0.95],
    },
    affinity: { air: 0.32, centroid: 0.24, spread: 0.22, warmthInv: 0.22 },
    palettes: FARSIDE_PALETTES,
    temperature: FARSIDE_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, FARSIDE_TEMPERATURE),
  },
  {
    id: 'fathom',
    name: 'The Fathom',
    tagline: 'Everything down here is slow on purpose.',
    kind: 'abyssal',
    comfort: { lo: 0.04, hi: 0.38 },
    channels: FATHOM_CHANNELS,
    prefer: {
      onset: [0.02, 0.30],
      warmth: [0.45, 0.95],
      centroid: [0.08, 0.42],
      phrase: [0.30, 0.95],
      arc: [0.08, 0.55],
    },
    affinity: { warmth: 0.34, phrase: 0.26, onsetInv: 0.24, bass: 0.16 },
    palettes: FATHOM_PALETTES,
    temperature: FATHOM_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, FATHOM_TEMPERATURE),
  },
  {
    id: 'redline',
    name: 'Redline',
    tagline: 'A road that only exists at speed.',
    kind: 'strip',
    comfort: { lo: 0.48, hi: 0.90 },
    channels: REDLINE_CHANNELS,
    prefer: {
      tempoHeat: [0.45, 1.00],
      groove: [0.30, 0.95],
      centroid: [0.40, 0.92],
      onset: [0.28, 0.85],
      arc: [0.10, 0.65],
    },
    affinity: { tempoHeat: 0.40, groove: 0.28, centroid: 0.20, onset: 0.12 },
    palettes: REDLINE_PALETTES,
    temperature: REDLINE_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, REDLINE_TEMPERATURE),
  },
  {
    id: 'foundry',
    name: 'The Foundry',
    tagline: 'It only stops when the song does.',
    kind: 'foundry',
    comfort: { lo: 0.62, hi: 0.99 },
    channels: FOUNDRY_CHANNELS,
    prefer: {
      onset: [0.45, 1.00],
      energyMean: [0.50, 1.00],
      dyn: [0.30, 0.95],
      tempoHeat: [0.35, 1.00],
      warmth: [0.30, 0.90],
    },
    affinity: { onset: 0.32, energyMean: 0.30, dyn: 0.20, tempoHeat: 0.18 },
    palettes: FOUNDRY_PALETTES,
    temperature: FOUNDRY_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, FOUNDRY_TEMPERATURE),
  },
  {
    id: 'understory',
    name: 'Understory',
    tagline: 'Nothing is built. Everything grows.',
    kind: 'overgrowth',
    comfort: { lo: 0.14, hi: 0.52 },
    channels: UNDERSTORY_CHANNELS,
    prefer: {
      texture: [0.40, 0.98],
      spread: [0.42, 0.95],
      contrast: [0.02, 0.48],
      onset: [0.05, 0.45],
      centroid: [0.30, 0.78],
    },
    affinity: { texture: 0.36, spread: 0.26, air: 0.20, contrastInv: 0.18 },
    palettes: UNDERSTORY_PALETTES,
    temperature: UNDERSTORY_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, UNDERSTORY_TEMPERATURE),
  },
  {
    id: 'nave',
    name: 'The Nave',
    tagline: 'Architecture that rebuilds itself every chorus.',
    kind: 'nave',
    comfort: { lo: 0.30, hi: 0.72 },
    channels: NAVE_CHANNELS,
    prefer: {
      contrast: [0.45, 0.98],
      form: [0.35, 0.95],
      phrase: [0.40, 0.98],
      arc: [0.25, 0.80],
      centroid: [0.25, 0.75],
    },
    affinity: { contrast: 0.34, form: 0.28, phrase: 0.24, arc: 0.14 },
    palettes: NAVE_PALETTES,
    temperature: NAVE_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, NAVE_TEMPERATURE),
  },
];

const BY_ID = new Map(WORLDS.map((w) => [w.id, w]));

let _custom = null;

export function resolveWorldId(id) {
  if (BY_ID.has(id)) return id;
  if (_custom?.id === id && WORLDS.some(w => w.kind === _custom.kind)) return id;
  return DEFAULT_WORLD_ID;
}

export function getWorld(id) {
  const effective = resolveWorldId(id);
  if (BY_ID.has(effective)) return BY_ID.get(effective);
  return _custom;
}

export function listWorlds() {
  return WORLDS;
}

export function getCustomWorld() {
  return _custom;
}

export function setCustomWorld(world) {
  _custom = world;
}

export function clearCustomWorld() {
  _custom = null;
}

export const DEFAULT_WORLD_ID = WORLDS[0].id;
