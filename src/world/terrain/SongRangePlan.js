// A song's own mountain range: which massif stands in which slot of which
// stage (song range composition, Phase 2). Pure: no downloads, no decoding,
// no GPU. The layout comes from the song's identity (seed plus its five watch
// values, the same compact record SongWorld.js stores), so it is known before
// any terrain loads and stays the same on every play.
//
// - Family: the home biome's material family. Pieces never cross families.
// - Template: a seeded draw among the templates that family supports.
// - Principal: the massif in the template's principal slot, drawn with the
//   catalog-view odds (sceneOdds: tempered character ranks, a fair-share
//   floor) against the song's terrain target.
// - Other slots: seeded draws without replacement among the pieces that fit
//   the slot (footprint and the slot's relief range), preferring source
//   regions used least so far. Each slot also draws whether it is mirrored.
//
// SONG_RANGE_VERSION changes whenever these rules change; a song's layout
// may then change too.
import { chooseSongBiomes } from './BiomeSet.js';
import { seedTicket, songTerrainTarget } from './RangeMatcher.js';
import { sceneOdds, SCENIC_FAIR_SHARE } from './SceneCatalog.js';
import MASSIF_CATALOG from './massifCatalogData.js';

export const SONG_RANGE_VERSION = 1;

/** Biome to material family; mirrors DEFAULT_PACKS in tools/build-range-scene.mjs. */
export const BIOME_FAMILY = Object.freeze({
  RAINFOREST: 'wet-conifer', CONIFER: 'dry-conifer', TAIGA: 'taiga', ICEFIELD: 'icefield', TUNDRA: 'tundra',
  PINE_OAK: 'pine-oak', BROADLEAF: 'broadleaf', CHAPARRAL: 'chaparral', STEPPE: 'steppe', CANYON: 'canyon', DESERT: 'desert',
});

// Ticket salts, apart from the scene catalog's (SceneCatalog SALT_BASE).
const SALT_TEMPLATE = 0x5a1;
const SALT_PRINCIPAL = 0x5a2;
const SALT_SLOT = 0x5b0;
const SALT_MIRROR = 0x5c0;

/** `?songRange=1` (or `on`) turns on composed ranges. Default off.
 *  `?songRange=force` also turns them on, and is diagnostic: see songRangeForced. */
export function songRangeEnabled(search = globalThis.location?.search || '') {
  const v = new URLSearchParams(search || '').get('songRange');
  return v === '1' || v === 'on' || v === 'force';
}

/** Diagnostic `?songRange=force`: plan every song with the first family that
 *  has pieces, whatever its home biome, so review captures with any song
 *  reach a composed range. Never production evidence. */
export function songRangeForced(search = globalThis.location?.search || '') {
  return new URLSearchParams(search || '').get('songRange') === 'force';
}

const fits = (slot, piece) => piece.tiles[0] <= slot.tiles[2] && piece.tiles[1] <= slot.tiles[3]
  && piece.peakReliefM >= (slot.reliefM?.[0] ?? 0) && (slot.reliefM?.[1] == null || piece.peakReliefM <= slot.reliefM[1]);

function pick(candidates, ticket, odds = null) {
  if (!odds) return candidates[Math.min(candidates.length - 1, Math.floor(ticket * candidates.length))];
  let at = 0;
  for (let i = 0; i < candidates.length; i++) { at += odds[i]; if (ticket < at) return candidates[i]; }
  return candidates.at(-1);
}

const indexes = new WeakMap();
function indexOf(catalog) {
  let hit = indexes.get(catalog);
  if (hit) return hit;
  const byFamily = new Map();
  for (const p of [...(catalog.pieces || [])].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!byFamily.has(p.family)) byFamily.set(p.family, []);
    byFamily.get(p.family).push(p);
  }
  const templates = [...(catalog.templates || [])].sort((a, b) => a.id.localeCompare(b.id));
  hit = { byFamily, templates };
  indexes.set(catalog, hit);
  return hit;
}

/**
 * The layout for one song, or null when its family has no template or not
 * enough pieces to fill one (the song then keeps its catalog view).
 *   profile  SongProfile or a compact record's { watch }
 *   seed     the song seed
 *   forced   diagnostic: plan with the first family that has pieces
 * Returns { version, family, biome, forced?, templateId, baseM, principal: { slotId,
 * pieceId, name }, slots: [{ slotId, pieceId, mirrored }], label }.
 */
export function planSongRange(profile, seed, { catalog = MASSIF_CATALOG, forced = false } = {}) {
  const biome = chooseSongBiomes(profile, seed)[0] ?? null;
  const { byFamily, templates } = indexOf(catalog);
  const family = forced ? ([...byFamily.keys()].sort()[0] ?? null) : BIOME_FAMILY[biome] ?? null;
  if (!family) return null;
  const pieces = byFamily.get(family) || [];
  const usable = templates.filter((t) => t.families.includes(family));
  if (!usable.length || !pieces.length) return null;
  const template = pick(usable, seedTicket(seed, SALT_TEMPLATE));
  const principalSlot = template.slots.find((s) => s.id === template.principalSlot);
  // Principal: character odds over every piece that fits the principal slot.
  const pool = pieces.filter((p) => fits(principalSlot, p));
  if (!pool.length) return null;
  const odds = sceneOdds(pool, songTerrainTarget(profile), SCENIC_FAIR_SHARE);
  const principal = pick(pool, seedTicket(seed, SALT_PRINCIPAL), odds);
  const used = new Set([principal.id]);
  const regionUse = new Map([[principal.sourceView, 1]]);
  const chosen = new Map([[principalSlot.id, principal]]);
  template.slots.forEach((slot, n) => {
    if (slot.id === principalSlot.id) return;
    const open = pieces.filter((p) => !used.has(p.id) && fits(slot, p));
    if (!open.length) return;
    const least = Math.min(...open.map((p) => regionUse.get(p.sourceView) || 0));
    const fresh = open.filter((p) => (regionUse.get(p.sourceView) || 0) === least);
    const p = pick(fresh, seedTicket(seed, SALT_SLOT + n));
    used.add(p.id);
    regionUse.set(p.sourceView, (regionUse.get(p.sourceView) || 0) + 1);
    chosen.set(slot.id, p);
  });
  if (chosen.size !== template.slots.length) return null;
  const slots = template.slots.map((slot, n) => ({ slotId: slot.id, pieceId: chosen.get(slot.id).id,
    mirrored: seedTicket(seed, SALT_MIRROR + n) < 0.5 }));
  return Object.freeze({
    version: SONG_RANGE_VERSION, family, biome, ...(forced ? { forced: true } : {}), templateId: template.id, baseM: template.lakeLevelM,
    principal: Object.freeze({ slotId: principalSlot.id, pieceId: principal.id, name: principal.name }),
    slots: Object.freeze(slots.map(Object.freeze)),
    label: `World: ${principal.name} range`,
  });
}

/** Diagnostic `?songRangeLayout=<pilot id>`: a Phase 1 layout run through
 *  the runtime path, to compare with its offline stage. Null when absent. */
export function songRangeLayoutParam(search = globalThis.location?.search || '') {
  return new URLSearchParams(search || '').get('songRangeLayout') || null;
}

/** The plan for a catalog pilot layout, standing in for `biome`. */
export function pilotPlan(id, biome, { catalog = MASSIF_CATALOG } = {}) {
  const pilot = (catalog.pilots || []).find((p) => p.id === id);
  if (!pilot) return null;
  const template = catalog.templates.find((t) => t.id === pilot.templateId);
  const principalSlot = template?.principalSlot;
  const principalId = pilot.slots.find((s) => s.slotId === principalSlot)?.pieceId;
  const principal = catalog.pieces.find((p) => p.id === principalId);
  if (!template || !principal) return null;
  return Object.freeze({ version: SONG_RANGE_VERSION, family: principal.family, biome, forced: true, pilot: id,
    templateId: template.id, baseM: template.lakeLevelM,
    principal: Object.freeze({ slotId: principalSlot, pieceId: principal.id, name: principal.name }),
    slots: Object.freeze(pilot.slots.map((s) => Object.freeze({ ...s }))), label: `World: ${principal.name} range` });
}

/** A layout's identity: two songs with equal keys stand in the same range. */
export function songRangeKey(plan) {
  return plan ? `${plan.templateId}|${plan.slots.map((s) => `${s.slotId}=${s.pieceId}${s.mirrored ? '~' : ''}`).join('|')}` : null;
}
