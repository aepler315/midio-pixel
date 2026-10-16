// Range v2: which curated scenic view a biome's sections play against.
//
// The pool is the catalog's APPROVED views only (plan §4.3). A candidate or
// rejected view is never chosen for a song, and a biome with no approved
// view gets `view: null` with an explicit fallback reason -- the legacy
// scanned-skyline renderer covers it -- never a view borrowed from another
// biome and never an invented ridge.
//
// Inside the pool: SCENIC_FAIR_SHARE of every draw is split equally, the
// rest leans toward views whose character (the same four axes songs and
// ranges share, RangeCharacter.AXES) is near the song's. Ranking within the
// pool keeps a two-view pool meaningful. Recently shown views, then
// recently shown regions, sit the draw out while an alternative exists; a
// pool where everything is recent is used as is. The seed is the ticket, so
// one song always draws the same view for a biome.
//
// This policy is deliberately separate from RangeMatcher.FAIR_SHARE (the
// musical skyline pool) and BiomeSet's HOME_BIOME_FAIR_SHARE: tuning the
// scenic draw never moves either of those distributions.
import { compositionErrors } from '../alpine/RangeComposition.js';
import { AXES, axisDistance } from './RangeCharacter.js';
import { seedTicket, songTerrainTarget } from './RangeMatcher.js';
import { cameraRailErrors } from './SceneTravel.js';

export const SCENIC_FAIR_SHARE = 0.15;
const KERNEL_WIDTH = 0.4;
const SALT_BASE = 3000;
const STATUSES = new Set(['candidate', 'approved', 'rejected']);

/** Structural problems with one catalog view (empty = usable). */
export function sceneViewErrors(view) {
  const errors = [];
  if (!view || typeof view !== 'object') return ['view missing'];
  if (typeof view.id !== 'string' || !view.id) errors.push('id');
  if (typeof view.regionId !== 'string' || !view.regionId) errors.push('regionId');
  if (typeof view.biome !== 'string' || !view.biome) errors.push('biome');
  if (!STATUSES.has(view.status)) errors.push(`status ${view.status}`);
  if (!Number.isInteger(view.catalogVersion)) errors.push('catalogVersion');
  if (typeof view.terrainManifestUrl !== 'string' || !view.terrainManifestUrl.endsWith('.json')) errors.push('terrainManifestUrl');
  if (typeof view.materialManifestUrl !== 'string' || !view.materialManifestUrl.endsWith('.json')) errors.push('materialManifestUrl');
  if (view.tourManifestUrl) {
    if (!view.tourManifestUrl.endsWith('.json') || !/^[a-f0-9]{64}$/.test(view.tourManifestSha256 || '')) errors.push('tour package identity');
  } else errors.push(...cameraRailErrors(view.camera));
  errors.push(...compositionErrors(view));
  if (!view.characterScores || !AXES.every((a) => Number.isFinite(view.characterScores[a]))) errors.push('characterScores');
  if (!view.evidence || typeof view.evidence.reviewPath !== 'string') errors.push('evidence');
  return errors;
}

/** Validate a whole runtime catalog. Returns { ok, errors, views }. */
export function validateSceneCatalog(catalog) {
  const errors = [];
  if (!catalog || !Number.isInteger(catalog.catalogVersion)) return { ok: false, errors: ['catalogVersion'], views: [] };
  const views = [];
  const seen = new Set();
  for (const v of catalog.views || []) {
    const e = sceneViewErrors(v);
    if (seen.has(v?.id)) e.push('duplicate id');
    if (v?.catalogVersion !== catalog.catalogVersion) e.push('catalogVersion mismatch');
    seen.add(v?.id);
    if (e.length) errors.push(`${v?.id ?? '?'}: ${e.join(', ')}`);
    else views.push(v);
  }
  return { ok: !errors.length, errors, views };
}

/** Rank of each view on each axis within `pool`, 0..1 (ties share). */
function poolRanks(pool) {
  const out = new Map(pool.map((v) => [v, {}]));
  for (const axis of AXES) {
    const sorted = [...pool].sort((a, b) => a.characterScores[axis] - b.characterScores[axis] || a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].characterScores[axis] === sorted[i].characterScores[axis]) j++;
      const rank = sorted.length > 1 ? ((i + j) / 2) / (sorted.length - 1) : 0.5;
      for (let k = i; k <= j; k++) out.get(sorted[k])[axis] = rank;
      i = j + 1;
    }
  }
  return out;
}

/** Each view's chance in this draw (sums to 1), in `pool` order. */
export function sceneOdds(pool, target, fairShare = SCENIC_FAIR_SHARE) {
  if (!pool.length) return [];
  const ranks = poolRanks(pool);
  const kernel = pool.map((v) => Math.exp(-((axisDistance(target, ranks.get(v)) / KERNEL_WIDTH) ** 2)));
  const sum = kernel.reduce((a, b) => a + b, 0);
  return pool.map((_, i) => fairShare / pool.length + (1 - fairShare) * (sum > 0 ? kernel[i] / sum : 1 / pool.length));
}

/**
 * The scenic view for one biome of one song.
 *   biome, profile (SongProfile), seed (song seed)
 *   { views, recentViewIds, recentRegionIds, catalogVersion, biomeIndex }
 * Returns SceneChoice { view, fallbackReason, odds, catalogVersion }.
 */
export function chooseSceneForBiome(biome, profile, seed, {
  views = [], recentViewIds = [], recentRegionIds = [], catalogVersion = null, biomeIndex = 0,
} = {}) {
  const none = (fallbackReason) => ({ view: null, fallbackReason, odds: 0, catalogVersion });
  const usable = views.filter((v) => !sceneViewErrors(v).length
    && (catalogVersion === null || v.catalogVersion === catalogVersion));
  const approved = usable.filter((v) => v.status === 'approved');
  const pool = approved.filter((v) => v.biome === biome).sort((a, b) => a.id.localeCompare(b.id));
  if (!pool.length) {
    return none(usable.some((v) => v.biome === biome) ? 'no-approved-view-for-biome' : 'no-view-for-biome');
  }
  // Avoid recent views, then recent regions, only while an alternative exists.
  const recentV = new Set(recentViewIds), recentR = new Set(recentRegionIds);
  let open = pool.filter((v) => !recentV.has(v.id) && !recentR.has(v.regionId));
  if (!open.length) open = pool.filter((v) => !recentV.has(v.id));
  if (!open.length) open = pool;
  const target = songTerrainTarget(profile);
  const odds = sceneOdds(open, target);
  const ticket = seedTicket(seed, SALT_BASE + 17 * biomeIndex);
  let at = 0;
  let pick = open.length - 1;
  for (let i = 0; i < open.length; i++) {
    at += odds[i];
    if (ticket < at) { pick = i; break; }
  }
  return { view: open[pick], fallbackReason: null, odds: odds[pick], catalogVersion };
}

/** One lightweight assignment per song biome: Map biome -> SceneChoice.
 *  Stored once per song generation; never re-drawn per frame or section. */
export function assignSongScenes(biomes, profile, seed, catalog, { recentViewIds = [], recentRegionIds = [] } = {}) {
  const { views } = validateSceneCatalog(catalog);
  const out = new Map();
  const shown = [...recentViewIds];
  const shownRegions = [...recentRegionIds];
  biomes.forEach((biome, i) => {
    const choice = chooseSceneForBiome(biome, profile, seed, {
      views, recentViewIds: shown, recentRegionIds: shownRegions, catalogVersion: catalog.catalogVersion, biomeIndex: i,
    });
    out.set(biome, choice);
    // A later biome of the same song avoids repeating this view/region too.
    if (choice.view) { shown.push(choice.view.id); shownRegions.push(choice.view.regionId); }
  });
  return out;
}

/** A diagnostic override (?rangeView=id): any catalog view, candidates
 *  included, flagged so evidence never mistakes it for a production pick. */
export function forcedSceneChoice(catalog, viewId) {
  const { views } = validateSceneCatalog(catalog);
  const view = views.find((v) => v.id === viewId) || null;
  return view
    ? { view, fallbackReason: null, odds: 1, catalogVersion: catalog.catalogVersion, forcedCandidate: view.status !== 'approved' }
    : { view: null, fallbackReason: `unknown-view:${viewId}`, odds: 0, catalogVersion: catalog.catalogVersion, forcedCandidate: false };
}
