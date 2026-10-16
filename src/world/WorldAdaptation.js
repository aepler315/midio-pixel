// Adapt a registered world to one song.
//
// Measurement lives in SongProfile. Ranking lives in WorldScore. This
// module is the construction path: keep the world's identity and renderer,
// generate only the palette / geometry / response controls that world
// actually consumes, and record a degraded capability when a step fails.
// Internal fit is a separate question — an adapted After Hours is still
// After Hours even if it would not have won Choose-for-me.
import { clamp, clamp01, hashSeed } from '../utils/math.js';
import { hexLerp } from '../utils/color.js';
import { buildSongProfile, PROFILE_VERSION } from '../audio/SongProfile.js';
import { buildSongDNA } from './dna/SongDNA.js';
import { synthesizeSectionPalettes } from './dna/PaletteSynth.js';
import {
  buildShapeGrammar, deriveTerrainParams, pickCharacterScheme, CHARACTER_SCHEMES,
  RIDGE_TERRAIN_KEYS, CITY_TERRAIN_KEYS, ROLLING_TERRAIN_KEYS,
} from './dna/ShapeGrammar.js';
import { castBiomes } from './Dramaturgy.js';
import { identityFor, stockPaletteMixFor, constrainPalette } from './WorldIdentity.js';

export const ADAPT_VERSION = 1;

/** Per-kind supported controls. Geometry tokens map onto the silhouette
 *  path BiomeManager already takes; a token that is not listed is not sent. */
export const KIND_CAPABILITIES = {
  alpine: {
    palette: 'painterly',
    geometry: ['ridge', 'rolling', 'characterScheme'],
    materialMix: 0.22,
    response: { smoothingMs: 1200, accentCooldownMs: 180, maxAccents: 4, macroMs: 8000 },
  },
  city: {
    palette: 'painterly',
    geometry: ['skyline'],
    materialMix: 0.36,
    response: { smoothingMs: 900, accentCooldownMs: 140, maxAccents: 6, macroMs: 6000 },
  },
  airless: {
    palette: 'painterly',
    geometry: ['ridge', 'rolling', 'characterScheme'],
    materialMix: 0.40,
    response: { smoothingMs: 1800, accentCooldownMs: 420, maxAccents: 2, macroMs: 10000 },
  },
  abyssal: {
    palette: 'painterly',
    geometry: ['ridge', 'rolling', 'columnar', 'ceiling', 'characterScheme'],
    materialMix: 0.38,
    response: { smoothingMs: 2000, accentCooldownMs: 360, maxAccents: 3, macroMs: 9000 },
  },
  strip: {
    palette: 'painterly',
    geometry: ['rolling'],
    materialMix: 0.30,
    response: { smoothingMs: 700, accentCooldownMs: 120, maxAccents: 5, macroMs: 5000 },
  },
  foundry: {
    palette: 'painterly',
    geometry: ['columnar', 'rolling'],
    materialMix: 0.32,
    response: { smoothingMs: 800, accentCooldownMs: 90, maxAccents: 5, macroMs: 5500 },
  },
  overgrowth: {
    palette: 'painterly',
    geometry: ['ridge', 'rolling', 'columnar', 'ceiling', 'characterScheme'],
    materialMix: 0.30,
    response: { smoothingMs: 1600, accentCooldownMs: 280, maxAccents: 3, macroMs: 8500 },
  },
  nave: {
    palette: 'painterly',
    geometry: ['columnar', 'rolling', 'ceiling'],
    materialMix: 0.34,
    response: { smoothingMs: 1400, accentCooldownMs: 260, maxAccents: 3, macroMs: 7500 },
  },
};

export function capabilitiesFor(kind) {
  return KIND_CAPABILITIES[kind] || KIND_CAPABILITIES.alpine;
}

function pickKeys(source, keys) {
  const out = {};
  for (const k of keys) {
    if (source[k] != null) out[k] = source[k];
  }
  return out;
}

export function filterTerrainMods(kind, full) {
  if (!full) return null;
  const geo = capabilitiesFor(kind).geometry;
  const out = {};
  if (geo.includes('ridge')) Object.assign(out, pickKeys(full, RIDGE_TERRAIN_KEYS));
  if (geo.includes('skyline')) Object.assign(out, pickKeys(full, CITY_TERRAIN_KEYS));
  if (geo.includes('rolling')) Object.assign(out, pickKeys(full, ROLLING_TERRAIN_KEYS));
  return Object.keys(out).length ? out : null;
}

export function densityBand(onset) {
  const v = clamp01(onset);
  if (v < 0.22) return 'sparse';
  if (v > 0.58) return 'dense';
  return 'mid';
}

/**
 * World-specific response ranges, then sparse/dense shaping.
 * Quiet input never gets a lifted ambient floor — silence stays still.
 */
export function responseConfigFor(kind, profile) {
  const caps = capabilitiesFor(kind);
  const watch = profile?.watch || {};
  const onset = clamp01(watch.onset ?? 0);
  const energyMean = clamp01(watch.energyMean ?? 0);
  const dyn = clamp01(watch.dyn ?? 0);
  const band = densityBand(onset);
  const quiet = energyMean < 0.14 && dyn < 0.22;
  const base = { ...caps.response };

  let accentGain = 0.75;
  let accentDecayMs = 150;
  let accentWindowMs = 800;
  let cityLightFloor = 0.14;
  let waterLightFloor = 0.10;
  let ambientScale = 1;
  let smoothingMs = base.smoothingMs;
  let macroMs = base.macroMs;
  let maxAccents = base.maxAccents;
  let accentCooldownMs = base.accentCooldownMs;

  if (band === 'sparse') {
    smoothingMs = Math.round(base.smoothingMs * 0.9);
    accentGain = 1;
    accentDecayMs = 240;
    accentWindowMs = 900;
    maxAccents = Math.max(1, Math.round(base.maxAccents * 0.6));
    cityLightFloor = 0.06;
    waterLightFloor = 0.04;
    ambientScale = 0.7;
  } else if (band === 'dense') {
    smoothingMs = Math.round(base.smoothingMs * 1.35);
    macroMs = Math.round(base.macroMs * 1.35);
    accentGain = 0.42;
    accentDecayMs = 110;
    accentWindowMs = 420;
    accentCooldownMs = Math.round(base.accentCooldownMs * 1.4);
    cityLightFloor = 0.12;
    waterLightFloor = 0.08;
    ambientScale = 0.85;
  }

  if (quiet) {
    cityLightFloor = 0;
    waterLightFloor = 0;
    ambientScale = Math.min(ambientScale, 0.35);
    accentGain = Math.min(accentGain, onset);
  }

  return Object.freeze({
    smoothingMs: clamp(smoothingMs, 60, 4000),
    accentCooldownMs: clamp(accentCooldownMs, 40, 1200),
    maxAccents: clamp(maxAccents, 1, 8),
    macroMs: clamp(macroMs, 2000, 16000),
    accentGain: clamp01(accentGain),
    accentDecayMs: clamp(accentDecayMs, 60, 400),
    accentWindowMs: clamp(accentWindowMs, 200, 1200),
    cityLightFloor: clamp01(cityLightFloor),
    waterLightFloor: clamp01(waterLightFloor),
    ambientScale: clamp01(ambientScale),
    band,
    quiet,
  });
}

function asProfile(songProfile, data) {
  if (songProfile?.version === PROFILE_VERSION && songProfile.watch) return songProfile;
  if (data?.profile?.version === PROFILE_VERSION) return data.profile;
  if (data?.songProfile?.version === PROFILE_VERSION) return data.songProfile;
  const built = buildSongProfile(data || {});
  if (songProfile && typeof songProfile.drive === 'number') {
    return { ...built, watch: { ...built.watch, ...songProfile } };
  }
  return built;
}

export function instanceIdFor(baseId, profile) {
  const w = profile?.watch || {};
  const key = [
    baseId,
    profile?.version ?? 0,
    profile?.durationMs ?? 0,
    w.drive, w.onset, w.bpm, w.energyMean, w.contrast,
  ].join('|');
  return `${baseId}:${hashSeed(key).toString(16)}`;
}

function materializePalette(generated, stock, mix) {
  if (!generated || !stock || !(mix > 0)) return generated;
  const out = { ...generated };
  // Palette synthesis owns song colors, but does not define the material
  // light used by Nave's glass, Foundry's furnaces and Redline's signage.
  // Preserve that renderer input from the corresponding stock palette.
  if (stock.edgeLight && !out.edgeLight) out.edgeLight = stock.edgeLight;
  if (generated.silhouette && stock.silhouette) {
    out.silhouette = hexLerp(generated.silhouette, stock.silhouette, mix);
  }
  if (Array.isArray(generated.sky) && Array.isArray(stock.sky) && stock.sky.length) {
    out.sky = generated.sky.map((c, i) => {
      const s = stock.sky[Math.min(i, stock.sky.length - 1)];
      return c && s ? hexLerp(c, s, mix * 0.7) : c;
    });
  }
  if (Array.isArray(generated.skyStops) && Array.isArray(stock.sky) && stock.sky.length) {
    out.skyStops = generated.skyStops.map((c, i) => {
      const s = stock.sky[Math.min(i, stock.sky.length - 1)];
      return c && s ? hexLerp(c, s, mix * 0.55) : c;
    });
  }
  if (generated.particles?.color && stock.particles?.color) {
    out.particles = {
      ...generated.particles,
      color: hexLerp(generated.particles.color, stock.particles.color, mix * 0.4),
    };
  }
  return out;
}

/**
 * @returns {{ world, proof, baseId, degraded }}
 * `world.id` is the playback overlay ('custom', or the registered ID for
 * manual-only fixtures). `world.registeredId` is always the stable gallery id.
 * `world.instanceId` is per-song so a previous adaptation cannot stick.
 */
export function adaptWorld(baseWorld, songProfile, data = null) {
  const base = baseWorld;
  if (!base?.id || !base.kind) {
    throw new Error('adaptWorld requires a registered world');
  }
  const profile = asProfile(songProfile, data);
  const caps = capabilitiesFor(base.kind);
  const identity = identityFor(base.kind);
  const instanceId = instanceIdFor(base.id, profile);
  const degraded = { dna: false, palette: false, geometry: false };
  const proof = { dna: null, adaptVersion: ADAPT_VERSION };

  const overlayId = base.manualOnly
    ? base.id
    : 'custom';

  let palettes = base.palettes;
  let temperature = base.temperature;
  let cast = base.cast;
  let terrainMods = null;
  let characterScheme = null;
  let dna = null;

  {
    try {
      dna = buildSongDNA({ ...(data || {}), profile, structure: data?.structure ?? null });
    } catch (err) {
      console.warn('[WorldAdaptation] buildSongDNA failed; stock identity only:', err);
      proof.dna = { error: String(err?.message || err) };
      degraded.dna = true;
    }

    // Real biomes are real places: their colours are not synthesized from
    // the song. The song's DNA still shapes the invented terrain below.
    if (dna && !base.realBiomes) {
      try {
        const synth = synthesizeSectionPalettes(dna, base.kind || 'world');
        if (synth.palettes.length) {
          const stock = Array.isArray(base.palettes) ? base.palettes[0] : null;
          palettes = synth.palettes.map((p, i) => {
            const toward = Array.isArray(base.palettes)
              ? base.palettes[i % base.palettes.length]
              : stock;
            return constrainPalette(identity, materializePalette(p, toward || stock, stockPaletteMixFor(identity, caps.materialMix)), toward || stock);
          });
          temperature = synth.temperature;
          cast = (energies, seed) => castBiomes(energies, seed, temperature);
          proof.dna = {
            seed: dna.seed, tonicPc: dna.tonicPc, isMajor: dna.isMajor,
            sections: synth.palettes.length,
          };
        }
      } catch (err) {
        console.warn('[WorldAdaptation] palette synthesis failed; stock palette:', err);
        proof.dna = { error: String(err?.message || err) };
        degraded.palette = true;
      }
    }

    if (dna) {
      try {
        const grammar = buildShapeGrammar(dna);
        const full = deriveTerrainParams(grammar);
        terrainMods = filterTerrainMods(base.kind, full);
        if (caps.geometry.includes('characterScheme')) {
          characterScheme = CHARACTER_SCHEMES[pickCharacterScheme(grammar)];
        }
      } catch (err) {
        console.warn('[WorldAdaptation] geometry derivation failed; stock terrain:', err);
        degraded.geometry = true;
      }
    }
  }

  const response = responseConfigFor(base.kind, profile);

  const world = {
    id: overlayId,
    registeredId: base.id,
    instanceId,
    name: base.name,
    tagline: base.tagline,
    kind: base.kind,
    aerial: base.aerial,
    renderer: base.renderer,
    manualOnly: !!base.manualOnly,
    realBiomes: !!base.realBiomes,
    custom: overlayId === 'custom',
    baseId: base.id,
    comfort: base.comfort,
    channels: base.channels,
    prefer: base.prefer,
    affinity: base.affinity,
    palettes,
    temperature,
    cast,
    terrainMods,
    characterScheme,
    response,
    capabilities: caps,
    identity,
    degraded,
  };

  return { world, proof, baseId: base.id, degraded };
}
