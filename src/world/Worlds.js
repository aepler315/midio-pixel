// Worlds: the two ways a song can be played.
//
// Landscape is The Range on real terrain: real biomes on real ranges,
// presented by Range v2 and its tours. Trio is the Range as it was before
// real terrain arrived: invented palettes on procedural, dancing ridges, a
// space ridge and a deep sky, with Midio, Midasus and Broshi performing on
// it. Both are the alpine kind, so BiomeManager draws both through its one
// alpine path; `experience` says which presentation a world gets.
//
// Choose-for-me is gone with the other worlds: with two choices the player
// picks. scoreWorlds still reads these entries for the private fit readout.
import { REAL_BIOMES, REAL_BIOME_TEMPERATURE } from './RealBiomes.js';
import { BIOMES } from './BiomeProfiles.js';
import { BIOME_TEMPERATURE, castBiomes } from './Dramaturgy.js';

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


export const WORLDS = [
  // Palette, geometry and response controls each kind actually consumes
  // are declared in WorldAdaptation.KIND_CAPABILITIES. Adaptation reads
  // `kind`, never a parallel per-id table.
  {
    id: 'alpine',
    name: 'Landscape',
    tagline: 'Real mountains that breathe with the mix.',
    experience: 'landscape',
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
    // Real biomes (RealBiomes.js), each on its own real ranges.
    palettes: REAL_BIOMES,
    temperature: REAL_BIOME_TEMPERATURE,
    realBiomes: true,
    cast: (energies, seed) => castBiomes(energies, seed, REAL_BIOME_TEMPERATURE),
  },
  {
    id: 'trio',
    name: 'Trio',
    tagline: 'Midio, Midasus and Broshi on the dancing range.',
    kind: 'alpine',
    experience: 'trio',
    comfort: { lo: 0.34, hi: 0.84 },
    channels: ALPINE_CHANNELS,
    prefer: {
      arc: [0.28, 0.90],
      onset: [0.10, 0.62],
      contrast: [0.22, 0.90],
      centroid: [0.28, 0.72],
    },
    affinity: { arc: 0.40, contrast: 0.25, tempoHeat: 0.35 },
    // The invented palettes (BiomeProfiles.js) on procedural ridges, as the
    // Range was before real terrain: no terrain profiles, no Range v2.
    palettes: BIOMES,
    temperature: BIOME_TEMPERATURE,
    cast: (energies, seed) => castBiomes(energies, seed, BIOME_TEMPERATURE),
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

/** The presentation a world is played with: 'trio' or 'landscape'. */
export function worldExperience(id) {
  return getWorld(id)?.experience === 'trio' ? 'trio' : 'landscape';
}

/** The registered world an experience plays in. */
export function worldForExperience(experience) {
  return experience === 'trio' ? 'trio' : DEFAULT_WORLD_ID;
}
