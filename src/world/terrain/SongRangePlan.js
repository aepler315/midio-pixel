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
import { settingValue } from '../../config/appSettings.js';

export const SONG_RANGE_VERSION = 3;

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
export function songRangeEnabled(search) {
  return settingValue('songRange', search) !== 'off';
}

/** Diagnostic `?songRange=force`: plan every song, with its own family or else the first family that
 *  has pieces, whatever its home biome, so review captures with any song
 *  reach a composed range. Never production evidence. */
export function songRangeForced(search) {
  return settingValue('songRange', search) === 'force';
}

const fits = (slot, piece) => piece.tiles[0] <= slot.tiles[2] && piece.tiles[1] <= slot.tiles[3]
  && piece.peakReliefM >= (slot.reliefM?.[0] ?? 0) && (slot.reliefM?.[1] == null || piece.peakReliefM <= slot.reliefM[1]);

/** Can distinct `pieces` fill every one of `slots`? (bipartite matching) */
function canFill(slots, pieces) {
  const owner = new Map();
  const assign = (slot, seen) => {
    for (const p of pieces) {
      if (seen.has(p) || !fits(slot, p)) continue;
      seen.add(p);
      if (!owner.has(p) || assign(owner.get(p), seen)) { owner.set(p, slot); return true; }
    }
    return false;
  };
  return slots.every((slot) => assign(slot, new Set()));
}

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
  // The song's own family; the forced diagnostic falls back to the first
  // family with pieces when the song's has none.
  const own = BIOME_FAMILY[biome] ?? null;
  const family = byFamily.has(own) ? own : forced ? ([...byFamily.keys()].sort()[0] ?? null) : own;
  if (!family) return null;
  const pieces = byFamily.get(family) || [];
  const usable = templates.filter((t) => t.families.includes(family));
  if (!usable.length || !pieces.length) return null;
  const template = pick(usable, seedTicket(seed, SALT_TEMPLATE));
  const principalSlot = template.slots.find((s) => s.id === template.principalSlot);
  // Principal: character odds over every piece that fits the principal slot
  // and leaves the other slots fillable.
  const rest = template.slots.filter((s) => s !== principalSlot);
  const pool = pieces.filter((p) => fits(principalSlot, p) && canFill(rest, pieces.filter((q) => q !== p)));
  if (!pool.length) return null;
  const odds = sceneOdds(pool, songTerrainTarget(profile), SCENIC_FAIR_SHARE);
  const principal = pick(pool, seedTicket(seed, SALT_PRINCIPAL), odds);
  // Other slots in template order; if that order strands a slot (an earlier
  // slot took the last piece that fits it), once more with the most
  // constrained slots first. Each slot keeps its own ticket either way, so a
  // layout the first order completes is unchanged.
  const fill = (order) => {
    const used = new Set([principal.id]);
    const regionUse = new Map([[principal.sourceView, 1]]);
    const chosen = new Map([[principalSlot.id, principal]]);
    for (const { slot, n } of order) {
      const open = pieces.filter((p) => !used.has(p.id) && fits(slot, p));
      if (!open.length) return null;
      const least = Math.min(...open.map((p) => regionUse.get(p.sourceView) || 0));
      const fresh = open.filter((p) => (regionUse.get(p.sourceView) || 0) === least);
      const p = pick(fresh, seedTicket(seed, SALT_SLOT + n));
      used.add(p.id);
      regionUse.set(p.sourceView, (regionUse.get(p.sourceView) || 0) + 1);
      chosen.set(slot.id, p);
    }
    return chosen;
  };
  const others = template.slots.map((slot, n) => ({ slot, n })).filter(({ slot }) => slot.id !== principalSlot.id);
  const room = ({ slot }) => pieces.filter((p) => p.id !== principal.id && fits(slot, p)).length;
  const chosen = fill(others) || fill([...others].sort((a, b) => room(a) - room(b) || a.n - b.n));
  if (!chosen) return null;
  const slots = template.slots.map((slot, n) => ({ slotId: slot.id, pieceId: chosen.get(slot.id).id,
    mirrored: seedTicket(seed, SALT_MIRROR + n) < 0.5 }));
  return Object.freeze({
    version: SONG_RANGE_VERSION, family, biome, ...(forced ? { forced: true } : {}), templateId: template.id, baseM: template.lakeLevelM,
    // Identity, not composition: two songs can draw the same template, pieces
    // and mirrors. The seed makes their ranges distinct anyway (songRangeKey),
    // and drives a small relief variation (songReliefJitter) so no two songs
    // stand in byte-for-byte identical terrain.
    ...(Number.isInteger(seed) ? { songSeed: seed >>> 0 } : {}),
    principal: Object.freeze({ slotId: principalSlot.id, pieceId: principal.id, name: principal.name }),
    slots: Object.freeze(slots.map(Object.freeze)),
    label: `World: ${principal.name} range`,
  });
}

/** Diagnostic `?songRangeLayout=<pilot id>`: a Phase 1 layout run through
 *  the runtime path, to compare with its offline stage. Null when absent. */
export function songRangeLayoutParam(search) {
  return settingValue('songRangeLayout', search);
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

/** A small, seed-derived relief multiplier, applied after framing so a song's
 *  range is never the exact terrain another song stands in. Bounded around 1
 *  so the measured relief and the template framing stay recognisable. */
export function songReliefJitter(seed) {
  if (!Number.isInteger(seed)) return 1;
  // Avalanche the seed so even neighbouring seeds land far apart in the
  // range: two colliding layouts never share a near-identical relief.
  let h = seed >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return 0.9 + h / 0xffffffff * 0.2;
}

/** A layout's identity: two songs with equal keys stand in the same range.
 *  A planned song carries its seed, so distinct songs never share a key even
 *  when their template, pieces and mirrors happen to coincide. Pilots and
 *  diagnostic layouts carry no seed and keep their published identity. */
export function songRangeKey(plan) {
  if (!plan) return null;
  const layout = `${plan.templateId}|${plan.slots.map((s) => `${s.slotId}=${s.pieceId}${s.mirrored ? '~' : ''}`).join('|')}`;
  const seed = Number.isInteger(plan.songSeed) ? `|seed:${plan.songSeed}` : '';
  const stage = plan.camera || plan.slotOffsets ? `|stage:${JSON.stringify({ camera: plan.camera,
    offsets: Object.entries(plan.slotOffsets || {}).sort(([a], [b]) => a.localeCompare(b)) })}` : '';
  return `${layout}${seed}${stage}`;
}
