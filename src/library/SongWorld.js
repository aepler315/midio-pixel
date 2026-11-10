// Compact musical identity for a library track's Landscape home. The source
// profile stays with the recording; catalog/matcher revisions can refresh its
// label through the same pure planner that playback uses.
import { PROFILE_VERSION } from '../audio/SongProfile.js';
import { planSongScenes } from '../world/terrain/SongScenePlan.js';
import { SCENE_MATCH_VERSION } from '../world/terrain/SceneCatalog.js';
import SCENE_CATALOG from '../world/terrain/sceneCatalogData.js';
import { planSongRange, songRangeEnabled, songRangeKey, SONG_RANGE_VERSION } from '../world/terrain/SongRangePlan.js';
import MASSIF_CATALOG from '../world/terrain/massifCatalogData.js';

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

/** Cached per record/catalog; safe for pooled rows in a large library.
 *  With `songRange` (default: ?songRange=1) a song whose home family has a
 *  composed range is labelled by its principal massif; every other song,
 *  and every song with the flag off, keeps its catalog-view label. */
export function describeSongWorld(record, { catalog = SCENE_CATALOG, massifs = MASSIF_CATALOG, songRange = songRangeEnabled() } = {}) {
  if (!isSongWorldRecord(record)) return pending;
  const signature = `${record.seed}:${WATCH_KEYS.map(key => record.watch[key]).join(':')}`;
  const cached = descriptions.get(record);
  if (cached?.catalog === catalog && cached.catalogVersion === catalog.catalogVersion && cached.signature === signature
    && cached.songRange === songRange && cached.massifs === massifs) return cached.value;
  const plan = planSongScenes({ version: record.profileVersion, watch: record.watch }, record.seed, { catalog });
  const choice = plan.sceneByBiome.get(plan.home), view = choice?.view;
  const biomeName = plan.home ? plan.home.toLowerCase().replaceAll('_', ' ') : 'Landscape';
  const name = view?.title || biomeName;
  const experimental = !!view && view.status !== 'approved';
  const range = songRange ? planSongRange({ version: record.profileVersion, watch: record.watch }, record.seed, { catalog: massifs }) : null;
  if (range) {
    const names = range.slots.map((s) => massifs.pieces.find((p) => p.id === s.pieceId)?.name).filter(Boolean);
    const value = Object.freeze({ state: 'known', label: range.label,
      title: [`Song range: ${range.principal.name}`, `Massifs: ${names.join(', ')}`, 'Composed range (experimental)'].join(' · '),
      viewId: view?.id ?? null, biome: plan.home, experimental: true,
      songRange: Object.freeze({ key: songRangeKey(range), principal: range.principal.pieceId, version: SONG_RANGE_VERSION }),
      catalogVersion: plan.catalogVersion, matchingVersion: SCENE_MATCH_VERSION });
    descriptions.set(record, { catalog, catalogVersion: catalog.catalogVersion, signature, songRange, massifs, value });
    return value;
  }
  const value = Object.freeze({ state: 'known', label: `World: ${name}`,
    title: [`Landscape home: ${name}`, view?.place, experimental ? 'Experimental view' : null,
      !view ? 'Scenic view unavailable; using biome terrain.' : null].filter(Boolean).join(' · '),
    viewId: view?.id ?? null, biome: plan.home, experimental,
    catalogVersion: plan.catalogVersion, matchingVersion: SCENE_MATCH_VERSION });
  descriptions.set(record, { catalog, catalogVersion: catalog.catalogVersion, signature, songRange, massifs, value });
  return value;
}
