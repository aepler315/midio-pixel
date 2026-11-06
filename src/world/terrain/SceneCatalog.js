// Range v2: which curated scenic view a biome's sections play against.
//
// Normal song selection uses approved views and explicitly enabled regional
// experiments. Other candidates remain diagnostic-only. A rejected view is
// never chosen by this normal pool, and a biome with no available
// view gets `view: null` with an explicit fallback reason -- the legacy
// scanned-skyline renderer covers it -- never a view borrowed from another
// biome and never an invented ridge. This describes current selection behavior;
// it does not restrict experiments with the selection policy or renderer.
//
// Inside the pool: SCENIC_FAIR_SHARE of every draw is split equally, the
// rest leans toward views whose character (the same four axes songs and
// ranges share, RangeCharacter.AXES) is near the song's. Rank coordinates
// retain measured contrast, so nearly identical views keep nearly equal
// musical odds. In explicit variety draws, recently shown views, then
// recently shown regions, sit the draw out while an alternative exists; a
// pool where everything is recent is used as is. The seed is the ticket, so
// one song always draws the same view for a biome when history is omitted.
//
// This policy is deliberately separate from RangeMatcher.FAIR_SHARE (the
// musical skyline pool) and BiomeSet's HOME_BIOME_FAIR_SHARE: tuning the
// scenic draw never moves either of those distributions.
import { compositionErrors } from '../alpine/RangeComposition.js';
import { AXES, axisDistance } from './RangeCharacter.js';
import { seedTicket, songTerrainTarget } from './RangeMatcher.js';
import { cameraRailErrors } from './SceneTravel.js';
import { riverChannelErrors } from '../alpine/RiverChannel.js';
import { hashSeed } from '../../utils/math.js';

export const SCENIC_FAIR_SHARE = 0.15;
export const SCENE_MATCH_VERSION = 2;
const KERNEL_WIDTH = 0.4;
// A quarter of the fixed physical character scale gives full rank contrast.
// Smaller measured spans stay close to neutral instead of amplifying noise.
const FULL_AXIS_SPAN = 0.25;
const SALT_BASE = 3000;
const STATUSES = new Set(['candidate', 'approved', 'rejected']);

/** Selection eligibility is separate from recorded artistic approval. */
export function sceneViewEligible(view) {
  return view?.status === 'approved' || (view?.status === 'candidate' && view.experimental === true);
}

/** Structural problems with one catalog view (empty = usable). */
export function sceneViewErrors(view) {
  const errors = [];
  if (!view || typeof view !== 'object') return ['view missing'];
  if (typeof view.id !== 'string' || !view.id) errors.push('id');
  if (typeof view.regionId !== 'string' || !view.regionId) errors.push('regionId');
  if (typeof view.biome !== 'string' || !view.biome) errors.push('biome');
  if (!STATUSES.has(view.status)) errors.push(`status ${view.status}`);
  if (view.experimental !== undefined && typeof view.experimental !== 'boolean') errors.push('experimental selection');
  if (!Number.isInteger(view.catalogVersion)) errors.push('catalogVersion');
  if (typeof view.terrainManifestUrl !== 'string' || !view.terrainManifestUrl.endsWith('.json')) errors.push('terrainManifestUrl');
  if (typeof view.materialManifestUrl !== 'string' || !view.materialManifestUrl.endsWith('.json')) errors.push('materialManifestUrl');
  if (view.tourManifestUrl) {
    if (!view.tourManifestUrl.endsWith('.json') || !/^[a-f0-9]{64}$/.test(view.tourManifestSha256 || '')) errors.push('tour package identity');
  } else errors.push(...cameraRailErrors(view.camera));
  // Optional shot metadata is checked independently by shotTourIdentityErrors:
  // a candidate or broken tour must never remove its approved fallback rail.
  errors.push(...compositionErrors(view));
  if (!view.characterScores || !AXES.every((a) => Number.isFinite(view.characterScores[a]))) errors.push('characterScores');
  if (!view.evidence || typeof view.evidence.reviewPath !== 'string') errors.push('evidence');
  if (view.rivers != null) {
    if (!Array.isArray(view.rivers)) errors.push('rivers must be an array');
    else {
      const ids = new Set();
      for (const river of view.rivers) {
        errors.push(...riverChannelErrors(river));
        if (ids.has(river?.id)) errors.push('duplicate river id');
        ids.add(river?.id);
      }
    }
  }
  if (view.riverPolicy != null && (view.riverPolicy.condition !== 'representative-no-runoff'
    || view.riverPolicy.terrainWater !== 'mapped-only')) errors.push('riverPolicy');
  return errors;
}

/** The tour's identity gate, independent of the base scene's validity and
 * review status. Diagnostics may override status, never package identity. */
export function shotTourIdentityErrors(view) {
  if (!view || typeof view.shotsManifestUrl !== 'string' || !view.shotsManifestUrl.endsWith('.json') || view.tourManifestUrl) return ['shot library identity'];
  const tour = view.shotTour;
  if (!STATUSES.has(tour?.status)) return ['shot tour status'];
  const errors = [];
  for (const key of ['shotsManifestSha256', 'terrainManifestSha256', 'baseViewSha256']) {
    if (!/^[a-f0-9]{64}$/.test(view[key] || '') || tour.identity?.[key] !== view[key]
      || (tour.approval != null && tour.approval[key] !== view[key])) errors.push(`shot ${key}`);
  }
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

/** Rank coordinates tempered by the measured axis span; ties share. */
function poolRanks(pool) {
  const out = new Map(pool.map((v) => [v, {}]));
  for (const axis of AXES) {
    const sorted = [...pool].sort((a, b) => a.characterScores[axis] - b.characterScores[axis] || a.id.localeCompare(b.id));
    const contrast = sorted.length > 1 ? Math.min(1, (sorted.at(-1).characterScores[axis] - sorted[0].characterScores[axis]) / FULL_AXIS_SPAN) : 0;
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].characterScores[axis] === sorted[i].characterScores[axis]) j++;
      const rank = sorted.length > 1 ? ((i + j) / 2) / (sorted.length - 1) : 0.5;
      for (let k = i; k <= j; k++) out.get(sorted[k])[axis] = .5 + (rank - .5) * contrast;
      i = j + 1;
    }
  }
  return out;
}

/** Each view's chance in this draw (sums to 1), in `pool` order. */
export function sceneOdds(pool, target, fairShare = SCENIC_FAIR_SHARE, referencePool = pool) {
  if (!pool.length) return [];
  const ranks = poolRanks(referencePool);
  const kernel = pool.map((v) => Math.exp(-((axisDistance(target, ranks.get(v)) / KERNEL_WIDTH) ** 2)));
  const sum = kernel.reduce((a, b) => a + b, 0);
  return pool.map((_, i) => fairShare / pool.length + (1 - fairShare) * (sum > 0 ? kernel[i] / sum : 1 / pool.length));
}

/**
 * The scenic view for one biome of one song.
 *   biome, profile (SongProfile), seed (song seed)
 *   { views, recentViewIds, recentRegionIds, catalogVersion }
 * Returns SceneChoice { view, fallbackReason, odds, catalogVersion }.
 */
export function chooseSceneForBiome(biome, profile, seed, {
  views = [], recentViewIds = [], recentRegionIds = [], catalogVersion = null,
} = {}) {
  const usable = views.filter(v => !sceneViewErrors(v).length
    && (catalogVersion === null || v.catalogVersion === catalogVersion));
  return chooseValidatedScene(biome, profile, seed, { views: usable, recentViewIds, recentRegionIds, catalogVersion });
}

function chooseValidatedScene(biome, profile, seed, {
  views, pool = views.filter(v => sceneViewEligible(v) && v.biome === biome).sort((a, b) => a.id.localeCompare(b.id)),
  recentViewIds = [], recentRegionIds = [], catalogVersion,
}) {
  const none = fallbackReason => ({ view: null, fallbackReason, odds: 0, catalogVersion, matchingVersion: SCENE_MATCH_VERSION });
  if (!pool.length) return none(views.some(v => v.biome === biome) ? 'no-approved-view-for-biome' : 'no-view-for-biome');
  // Recency is optional for deliberate variety draws. Coordinates always
  // come from the full eligible biome pool, including excluded recent views.
  const recentV = new Set(recentViewIds), recentR = new Set(recentRegionIds);
  let open = pool.filter(v => !recentV.has(v.id) && !recentR.has(v.regionId));
  if (!open.length) open = pool.filter(v => !recentV.has(v.id));
  if (!open.length) open = pool;
  const target = songTerrainTarget(profile);
  const odds = sceneOdds(open, target, SCENIC_FAIR_SHARE, pool);
  const ticket = seedTicket(seed, SALT_BASE + hashSeed(biome));
  let at = 0, pick = open.length - 1;
  for (let i = 0; i < open.length; i++) {
    at += odds[i];
    if (ticket < at) { pick = i; break; }
  }
  return { view: open[pick], fallbackReason: null, odds: odds[pick], catalogVersion, matchingVersion: SCENE_MATCH_VERSION };
}

/** Validate/index one immutable catalog revision, without asset loading.
 * Default assignments are independent per biome. Explicit history options
 * also avoid already chosen regions within that deliberate variety draw. */
export function createScenePlanner(catalog) {
  const { views } = validateSceneCatalog(catalog);
  const byBiome = new Map();
  for (const v of views) {
    if (!sceneViewEligible(v)) continue;
    if (!byBiome.has(v.biome)) byBiome.set(v.biome, []);
    byBiome.get(v.biome).push(v);
  }
  for (const pool of byBiome.values()) pool.sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    catalogVersion: catalog.catalogVersion,
    matchingVersion: SCENE_MATCH_VERSION,
    assign(biomes, profile, seed, options = {}) {
      const { recentViewIds = [], recentRegionIds = [] } = options;
      const variety = Object.hasOwn(options, 'recentViewIds') || Object.hasOwn(options, 'recentRegionIds');
      const out = new Map(), shown = [...recentViewIds], shownRegions = [...recentRegionIds];
      for (const biome of new Set(biomes)) {
        const choice = chooseValidatedScene(biome, profile, seed, { views, pool: byBiome.get(biome) || [],
          recentViewIds: shown, recentRegionIds: shownRegions, catalogVersion: catalog.catalogVersion });
        out.set(biome, choice);
        if (variety && choice.view) { shown.push(choice.view.id); shownRegions.push(choice.view.regionId); }
      }
      return out;
    },
  });
}

/** One lightweight assignment per song biome; an explicit history is optional. */
export function assignSongScenes(biomes, profile, seed, catalog, options = {}) {
  return createScenePlanner(catalog).assign(biomes, profile, seed, options);
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
