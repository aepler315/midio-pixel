// A song's scenic identity, shared by playback and library descriptions.
// This module plans names/IDs only: no terrain download, decode or GPU work.
import { chooseSongBiomes } from './BiomeSet.js';
import { createScenePlanner } from './SceneCatalog.js';
import SCENE_CATALOG from './sceneCatalogData.js';

const planners = new WeakMap();

/** Catalog objects represent immutable revisions. A new version rebuilds its index. */
export function planSongScenes(profile, seed, { catalog = SCENE_CATALOG } = {}) {
  let cached = planners.get(catalog);
  if (!cached || cached.version !== catalog.catalogVersion) {
    cached = { version: catalog.catalogVersion, planner: createScenePlanner(catalog) };
    planners.set(catalog, cached);
  }
  const biomes = chooseSongBiomes(profile, seed);
  return { biomes, home: biomes[0] ?? null, sceneByBiome: cached.planner.assign(biomes, profile, seed),
    catalogVersion: cached.planner.catalogVersion, matchingVersion: cached.planner.matchingVersion };
}
