// A song's scenic identity, shared by playback and library descriptions.
// This module plans names/IDs only: no terrain download, decode or GPU work.
import { songprintOutline } from './SongprintTerrain.js';
import { chooseSongBiomes } from './BiomeSet.js';
import { createScenePlanner } from './SceneCatalog.js';
import SCENE_CATALOG from './sceneCatalogData.js';

const planners = new WeakMap();

/** Catalog objects represent immutable revisions. A new version rebuilds its index. */
export function planSongScenes(profile, seed, { catalog = SCENE_CATALOG, songprint } = {}) {
  let cached = planners.get(catalog);
  if (!cached || cached.version !== catalog.catalogVersion) {
    cached = { version: catalog.catalogVersion, planner: createScenePlanner(catalog) };
    planners.set(catalog, cached);
  }
  const skyline = songprintOutline(songprint);
  if (skyline) {
    const sceneByBiome = cached.planner.nearestOutline(skyline);
    // Keep one geographic home when chapters change so a returning passage can revisit its summit.
    const biomes = [...sceneByBiome.keys()];
    if (biomes.length) return { biomes, home: biomes[0], sceneByBiome, songprintVersion: songprint.version,
      catalogVersion: cached.planner.catalogVersion, matchingVersion: cached.planner.matchingVersion };
  }
  const biomes = chooseSongBiomes(profile, seed);
  return { biomes, home: biomes[0] ?? null, sceneByBiome: cached.planner.assign(biomes, profile, seed),
    catalogVersion: cached.planner.catalogVersion, matchingVersion: cached.planner.matchingVersion };
}
