// Range v2 material packs (schema midio.material v1): validation and
// verified loading. A pack names shared DATA textures (normal, roughness,
// height, coverage -- never colour), a palette of sRGB albedo values and
// placement rules. Validation runs before any byte is decoded or uploaded.
import { RangeAssetError, sha256Hex } from './RangeAssets.js';
import { regionElevationSpan } from '../terrain/InlandRegion.js';
import MASSIF_CATALOG from '../terrain/massifCatalogData.js';

export const MATERIAL_SCHEMA = 'midio.material';
export const MATERIAL_VERSION = 1;
export const MATERIAL_ROLES = Object.freeze(['rockDetail', 'rockNear', 'stage', 'stageWet', 'soil', 'canopy', 'snow', 'pebbles']);
export const PALETTE_KEYS = Object.freeze(['rockLit', 'rockShade', 'rockWarm', 'soil', 'meadow', 'forestNear', 'forestFar',
  'moss', 'snow', 'snowShade', 'water', 'waterDeep', 'wetRock', 'lichen']);
export const RULE_KEYS = Object.freeze(['snowlineM', 'snowFullM', 'snowMaxSlopeDeg', 'treelineM', 'forestMaxSlopeDeg',
  'forestDensity', 'moss', 'wetness', 'strata']);
// Optional rules: dry-country packs keep valley floors open below a lower
// forest limit (forestFloorM), grow smaller trees (treeScale) and see
// through clearer air (airScale multiplies the distance haze).
export const OPTIONAL_RULE_KEYS = Object.freeze(['forestFloorM', 'treeScale', 'airScale', 'waterSkyMix', 'waterGlintGain']);
export const RULE_DEFAULTS = Object.freeze({ forestFloorM: -100000, treeScale: 1, airScale: 1, waterSkyMix: 0.9, waterGlintGain: 3 });
const WATER_RULE_BOUNDS = Object.freeze({ waterSkyMix: 1, waterGlintGain: 3 });
const HEX = /^#[0-9a-f]{6}$/i;

const INLAND_WOODED_FRACTION = .16, INLAND_MIN_FOREST_DENSITY = .42, INLAND_SNOW_FRACTION = .5;

/** A family's surveyed elevation span: the lower quartile of its massif
 *  bases and the upper decile of their summits. Its pack's bands were set
 *  for terrain in that span. */
function familySpan(catalog, family) {
  const pieces = catalog?.pieces?.filter(p => p.family === family) ?? [];
  if (pieces.length < 3) return null;
  const bases = pieces.map(p => p.peakM - p.peakReliefM).sort((a, b) => a - b);
  const tops = pieces.map(p => p.peakM).sort((a, b) => a - b);
  const at = (list, q) => list[Math.floor(q * (list.length - 1))];
  const span = [at(bases, .25), at(tops, .9)];
  return span[1] - span[0] > 200 ? span : null;
}

/** A generated inland region has its own datum and relief. Carry each of the
 *  pack's elevation bands across proportionally, from the family's surveyed
 *  span to the region's valley floor and crests, so a wet conifer region
 *  keeps forested foothills under snowy crests and a tundra region stays
 *  bare, whatever the absolute heights. */
export function inlandMaterialRules(view, rules, catalog = MASSIF_CATALOG) {
  const plan = view?.songRange?.plan;
  if (!plan?.inland || !Number.isFinite(plan.baseM)) return rules;
  const span = familySpan(catalog, plan.family);
  if (!span) return rules;
  const { floorM, topM } = regionElevationSpan(plan.inland, plan.baseM);
  const map = v => Number.isFinite(v) ? Math.round(floorM + (v - span[0]) / (span[1] - span[0]) * (topM - floorM)) : v;
  const out = { ...rules, treelineM: map(rules.treelineM), snowlineM: map(rules.snowlineM), snowFullM: map(rules.snowFullM) };
  if (Number.isFinite(rules.forestFloorM) && rules.forestFloorM > -1e4) out.forestFloorM = map(rules.forestFloorM);
  // Valleys this far below the crests keep woods even in open country:
  // spruce in tundra valley bottoms, galleries along desert rivers.
  out.treelineM = Math.max(out.treelineM, Math.round(floorM + INLAND_WOODED_FRACTION * (topM - floorM)));
  // Snow keeps to the upper crests: the region's foothills stay green.
  if (plan.family !== 'icefield') out.snowlineM = Math.round(floorM + INLAND_SNOW_FRACTION * (topM - floorM));
  out.snowlineM = Math.max(out.snowlineM, out.treelineM + 120);
  out.snowFullM = Math.max(out.snowFullM, out.snowlineM + 300);
  out.forestDensity = Math.max(rules.forestDensity ?? 0, INLAND_MIN_FOREST_DENSITY);
  out.forestMaxSlopeDeg = Math.max(rules.forestMaxSlopeDeg ?? 0, 34);
  // Valley woods are full-size trees, a little larger than life so stands
  // keep their mass on the native pixel grid, even where a pack keeps scrub.
  out.treeScale = Math.round(100 * Math.max(.8, rules.treeScale ?? RULE_DEFAULTS.treeScale) * 1.25) / 100;
  if (Number.isFinite(out.forestFloorM)) out.forestFloorM = Math.min(out.forestFloorM, Math.round(floorM + .12 * (topM - floorM)));
  return out;
}

/** Water receivers accept the same bounded controls in packs and view overrides. */
export function validateWaterRules(rules = {}) {
  const errors = [];
  for (const [key, max] of Object.entries(WATER_RULE_BOUNDS)) {
    if (!(key in rules)) continue;
    if (!Number.isFinite(rules[key]) || rules[key] < 0 || rules[key] > max) errors.push(`rule ${key} must be finite in 0..${max}`);
  }
  return { ok: !errors.length, errors };
}

export function validateMaterialManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest missing'] };
  if (m.schema !== MATERIAL_SCHEMA) errors.push(`schema ${m.schema}`);
  if (m.version !== MATERIAL_VERSION) errors.push(`unsupported version ${m.version}`);
  if (typeof m.id !== 'string' || !m.id) errors.push('id');
  if (!Array.isArray(m.biomes) || !m.biomes.length) errors.push('biomes');
  for (const role of MATERIAL_ROLES) {
    const t = m.textures?.[role];
    if (!t) { errors.push(`texture ${role} missing`); continue; }
    if (typeof t.url !== 'string' || !/\.(webp|png)$/.test(t.url)) errors.push(`texture ${role} url`);
    if (!/^[0-9a-f]{64}$/.test(t.sha256 || '')) errors.push(`texture ${role} sha256`);
    if (!(Number.isInteger(t.width) && Number.isInteger(t.height) && t.width > 0 && t.height > 0 && t.width <= 4096 && t.height <= 4096)) errors.push(`texture ${role} size`);
    if (t.colorSpace !== 'data') errors.push(`texture ${role} must be a data texture`);
    if (!(t.metersPerTile > 0)) errors.push(`texture ${role} metersPerTile`);
    if (!Array.isArray(t.channels) || t.channels.length !== 4) errors.push(`texture ${role} channels`);
    if (!t.source || (!t.source.license)) errors.push(`texture ${role} provenance`);
  }
  for (const k of PALETTE_KEYS) if (!HEX.test(m.palette?.[k] || '')) errors.push(`palette ${k}`);
  for (const k of RULE_KEYS) if (!Number.isFinite(m.rules?.[k])) errors.push(`rule ${k}`);
  for (const k of OPTIONAL_RULE_KEYS) if (!(k in WATER_RULE_BOUNDS) && m.rules && k in m.rules && !Number.isFinite(m.rules[k])) errors.push(`rule ${k}`);
  errors.push(...validateWaterRules(m.rules || {}).errors);
  for (const k of ['treeScale', 'airScale']) if (m.rules && k in m.rules && !(m.rules[k] > 0)) errors.push(`rule ${k}`);
  return { ok: !errors.length, errors };
}

/** Bytes a pack's textures own once uploaded (RGBA8 with a full mip chain). */
export function materialGpuBytes(m) {
  const seen = new Set();
  let bytes = 0;
  for (const t of Object.values(m.textures || {})) {
    if (seen.has(t.sha256)) continue;
    seen.add(t.sha256);
    bytes += Math.round(t.width * t.height * 4 * 4 / 3);
  }
  return bytes;
}

/**
 * Fetch, verify and decode a pack's textures. Decoding uses
 * createImageBitmap with no premultiplication and no colour conversion:
 * these are data, and alpha carries height, not coverage.
 * Resolves { manifest, images: Map sha256 -> ImageBitmap, roles }.
 */
export async function loadMaterialPack(manifestUrl, { signal = null, fetchImpl = globalThis.fetch, decode = null, onManifest = null, expectSha256 = null } = {}) {
  const get = async (url) => {
    let res;
    try { res = await fetchImpl(url, { signal }); } catch (err) {
      throw new RangeAssetError(signal?.aborted ? 'aborted' : 'http', `fetch failed for ${url}: ${err?.message || err}`);
    }
    if (!res.ok) throw new RangeAssetError('http', `HTTP ${res.status} for ${url}`);
    try { return new Uint8Array(await res.arrayBuffer()); } catch (err) {
      throw new RangeAssetError(signal?.aborted ? 'aborted' : 'http', `body read failed for ${url}: ${err?.message || err}`);
    }
  };
  const manifestBytes = await get(manifestUrl);
  // The pack a view was approved with: any other bytes (a newer pack beside
  // a cached catalog) fail, so the view falls back instead of rendering an
  // unreviewed palette or rule set.
  if (expectSha256 && (await sha256Hex(manifestBytes)) !== expectSha256) {
    throw new RangeAssetError('hash', `material manifest ${manifestUrl} does not match the catalog`);
  }
  const text = new TextDecoder().decode(manifestBytes);
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new RangeAssetError('manifest', `material manifest is not JSON: ${manifestUrl}`); }
  const check = validateMaterialManifest(manifest);
  if (!check.ok) throw new RangeAssetError('manifest', `material manifest rejected: ${check.errors.slice(0, 3).join('; ')}`);
  const decodeImage = decode || ((bytes) => createImageBitmap(new Blob([bytes]), {
    premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none',
  }));
  // The caller reserves the pack's declared footprint here, before a single
  // image is decoded (a denial must not follow the very spike it prevents).
  if (onManifest) await onManifest(manifest);
  const images = new Map();
  try {
    for (const t of Object.values(manifest.textures)) {
      if (images.has(t.sha256)) continue;
      const url = new URL(t.url, new URL(manifestUrl, globalThis.location?.href || 'http://localhost/')).href;
      const bytes = await get(url);
      if (bytes.byteLength !== t.bytes) throw new RangeAssetError('hash', `${t.id} is ${bytes.byteLength} bytes, not ${t.bytes}`);
      if ((await sha256Hex(bytes)) !== t.sha256) throw new RangeAssetError('hash', `${t.id} hash mismatch`);
      if (signal?.aborted) throw new RangeAssetError('aborted', 'aborted');
      let image;
      try { image = await decodeImage(bytes); } catch (err) { throw new RangeAssetError('decode', `${t.id}: ${err?.message || err}`); }
      if (image.width !== t.width || image.height !== t.height) {
        image.close?.();
        throw new RangeAssetError('decode', `${t.id} decoded ${image.width}x${image.height}`);
      }
      images.set(t.sha256, image);
    }
  } catch (err) {
    // Decoded images live outside the ledger: never abandon them.
    for (const img of images.values()) img.close?.();
    throw err;
  }
  return { manifest, images };
}

/** sRGB hex -> linear [r, g, b]. */
export function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}
