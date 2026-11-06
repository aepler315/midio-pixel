// Compact musical identity for a library track's Landscape home. The source
// profile stays with the recording; catalog/matcher revisions can refresh its
// label through the same pure planner that playback uses.
import { PROFILE_VERSION } from '../audio/SongProfile.js';
import { planSongScenes } from '../world/terrain/SongScenePlan.js';
import { SCENE_MATCH_VERSION } from '../world/terrain/SceneCatalog.js';
import SCENE_CATALOG from '../world/terrain/sceneCatalogData.js';

const WATCH_KEYS = Object.freeze(['drive', 'onset', 'texture', 'arc', 'contrast']);
const pending = Object.freeze({ state: 'pending', label: 'World: play to discover',
  title: 'Play this song once to discover its Landscape world.', viewId: null, biome: null, experimental: false });
const descriptions = new WeakMap();

export function isSongWorldRecord(record) {
  return !!record && record.version === 1 && record.profileVersion === PROFILE_VERSION
    && Number.isInteger(record.seed) && record.seed >= 0 && record.seed <= 0xffffffff
    && !!record.watch && !Array.isArray(record.watch)
    && WATCH_KEYS.every(key => Number.isFinite(record.watch[key]) && record.watch[key] >= 0 && record.watch[key] <= 1);
}

/** A fresh, bounded, serializable copy; unknown or older records are absent. */
export function copySongWorldRecord(record) {
  if (!isSongWorldRecord(record)) return null;
  return { version: 1, seed: record.seed, profileVersion: PROFILE_VERSION,
    watch: Object.fromEntries(WATCH_KEYS.map(key => [key, record.watch[key]])) };
}

export function createSongWorldRecord(profile, seed) {
  if (profile?.version !== PROFILE_VERSION) return null;
  return copySongWorldRecord({ version: 1, seed, profileVersion: profile.version, watch: profile.watch });
}

/** Cached per record/catalog; safe for pooled rows in a large library. */
export function describeSongWorld(record, { catalog = SCENE_CATALOG } = {}) {
  if (!isSongWorldRecord(record)) return pending;
  const signature = `${record.seed}:${WATCH_KEYS.map(key => record.watch[key]).join(':')}`;
  const cached = descriptions.get(record);
  if (cached?.catalog === catalog && cached.catalogVersion === catalog.catalogVersion && cached.signature === signature) return cached.value;
  const plan = planSongScenes({ version: record.profileVersion, watch: record.watch }, record.seed, { catalog });
  const choice = plan.sceneByBiome.get(plan.home), view = choice?.view;
  const biomeName = plan.home ? plan.home.toLowerCase().replaceAll('_', ' ') : 'Landscape';
  const name = view?.title || biomeName;
  const experimental = !!view && view.status !== 'approved';
  const value = Object.freeze({ state: 'known', label: `World: ${name}`,
    title: [`Landscape home: ${name}`, view?.place, experimental ? 'Experimental view' : null,
      !view ? 'Scenic view unavailable; using biome terrain.' : null].filter(Boolean).join(' · '),
    viewId: view?.id ?? null, biome: plan.home, experimental,
    catalogVersion: plan.catalogVersion, matchingVersion: SCENE_MATCH_VERSION });
  descriptions.set(record, { catalog, catalogVersion: catalog.catalogVersion, signature, value });
  return value;
}
