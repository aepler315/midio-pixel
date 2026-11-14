// The settings registry: the one definition of every user-adjustable or
// URL-overridable behaviour of the app page (index.html). See
// docs/settings.md for the architecture and docs/url-parameters.md (generated
// from this file by tools/settings-reference.mjs) for the URL reference.
//
// A definition is the source of validation, defaults, persistence, UI
// metadata and URL handling. The settings panel (src/ui/SettingsPanel.js)
// renders every definition that has a section; the store
// (src/config/appSettings.js) resolves the effective value; subsystems read
// it through the store or a thin adapter that keeps their historical
// signature. Pure: no DOM, no GPU, no module-level storage access.
import { normalizeRailPace, RAIL_PACES, DEFAULT_RAIL_PACE } from '../world/terrain/SceneRailPlan.js';
import { readDisplayPrefs, writeDisplayPrefs, CINEMATIC_PIXEL_GRID } from '../render/DisplayProfile.js';
import { readRenderQuality, writeRenderQuality, RENDER_QUALITIES } from '../render/RenderQuality.js';
import { readPlaybackPrefs, writePlaybackPrefs, DEFAULT_PLAYBACK_PREFS } from '../ui/PlaybackPreferences.js';
import {
  getLyricsDisabled, setLyricsDisabled, getBtLatencyTrimMs, setBtLatencyTrimMs, MAX_BT_LATENCY_TRIM_MS,
} from '../ui/Accessibility.js';

/** Unified record for settings that had no storage of their own. */
export const SETTINGS_STORAGE_KEY = 'midio-pixel:settings:v1';

export const SECTIONS = Object.freeze([
  { id: 'appearance', label: 'Appearance', description: 'How the landscape is drawn on this screen.' },
  { id: 'camera', label: 'Camera', description: 'How the camera moves through each landscape.' },
  { id: 'landscape', label: 'Landscape', description: 'How the terrain is chosen, composed and moved by the music.' },
  { id: 'performance', label: 'Performance', description: 'Quality limits, frame rate and renderer choices.' },
  { id: 'playback', label: 'Audio & playback', description: 'Song order, lyrics and audio/visual sync.' },
  { id: 'experiments', label: 'Experiments', description: 'Work in progress and engineering comparisons. Results can differ from normal playback.' },
]);

/** Progressive disclosure: basic is always shown, advanced behind a toggle,
 *  experimental and developer only in the Experiments section. */
export const TIERS = Object.freeze(['basic', 'advanced', 'experimental', 'developer']);

/** When a changed value reaches the running app. */
export const LIFECYCLES = Object.freeze({
  live: { label: 'Immediately', short: 'Live' },
  'next-landscape': { label: 'From the next landscape or replay', short: 'Next landscape' },
  'next-song': { label: 'When the next song starts', short: 'Next song' },
  scene: { label: 'Rebuilds the scene in place; the song holds its place and resumes when the scene is ready', short: 'Scene rebuild' },
  renderer: { label: 'Restarts the 3D landscape renderer; the song holds its place and resumes when the new scene is ready', short: 'Renderer restart' },
  reload: { label: 'Needs a page reload, which stops playback', short: 'Reload' },
});

// ---- value helpers -------------------------------------------------------

const TRUE = new Set(['1', 'true', 'on', 'yes']);
const FALSE = new Set(['0', 'false', 'off', 'no']);
const ok = value => ({ ok: true, value });
const bad = (reason, value) => ({ ok: false, reason, ...(value !== undefined ? { value } : {}) });

/** Historical opt-in flags: only `=1` turns them on (`=0` is accepted as
 *  an explicit off); any other value is rejected and leaves them off. */
const strictFlag = raw => (raw === '1' ? ok(true) : raw === '0' ? ok(false) : bad(`only 1 turns this on, got "${raw}"`, false));

/** A boolean parameter with the usual spellings. */
function flagParse(raw) {
  const v = String(raw).toLowerCase();
  if (TRUE.has(v)) return ok(true);
  if (FALSE.has(v) || v === '') return ok(false);
  return bad(`expected 1 or 0, got "${raw}"`);
}

function enumParse(def, raw, { lower = false } = {}) {
  const v = lower ? String(raw).toLowerCase() : String(raw);
  const hit = def.options.find(o => String(o.value) === v);
  return hit ? ok(hit.value) : bad(`expected one of ${def.options.map(o => o.value).join(', ')}, got "${raw}"`);
}

function numberParse(def, raw) {
  if (raw === '' || raw == null) return bad('empty number');
  const n = Number(raw);
  if (!Number.isFinite(n)) return bad(`expected a number, got "${raw}"`);
  if (n < def.min || n > def.max) return bad(`expected ${def.min}..${def.max}, got ${n}`);
  return ok(def.step && def.step >= 1 ? Math.round(n) : n);
}

/** Validate and normalize a programmatic or UI value. Returns undefined for
 *  a value the definition does not accept. */
export function normalizeValue(def, value) {
  if (def.normalize) return def.normalize(value);
  switch (def.type) {
    case 'boolean': return typeof value === 'boolean' ? value : undefined;
    case 'enum': return def.options.some(o => o.value === value) ? value : undefined;
    case 'number': {
      if (def.nullable && (value === null || value === '')) return null;
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
      const clamped = Math.min(def.max, Math.max(def.min, n));
      return def.step && def.step >= 1 ? Math.round(clamped) : clamped;
    }
    case 'string': {
      if (def.nullable && (value === null || value === '')) return null;
      return typeof value === 'string' && (!def.pattern || def.pattern.test(value)) ? value : undefined;
    }
    default: return undefined;
  }
}

/** Parse one raw URL value. Definitions with historical quirks override
 *  `parseUrl`; the generic rules cover the rest. */
export function parseUrlValue(def, raw) {
  if (def.parseUrl) return def.parseUrl(raw, def);
  switch (def.type) {
    case 'boolean': return flagParse(raw);
    case 'enum': return enumParse(def, raw, { lower: !!def.caseInsensitive });
    case 'number': return numberParse(def, raw);
    case 'string': {
      const v = normalizeValue(def, raw);
      return v === undefined ? bad(`"${raw}" is not a valid ${def.label.toLowerCase()}`) : ok(v);
    }
    default: return bad('unsupported type');
  }
}

/** The URL text for a value. */
export function formatUrlValue(def, value) {
  if (def.formatUrl) return def.formatUrl(value);
  if (def.type === 'boolean') return value ? '1' : '0';
  return value == null ? '' : String(value);
}

// ---- storage adapters ----------------------------------------------------

function readRecord(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Settings without a historical key share one JSON record. */
const unified = id => ({
  key: SETTINGS_STORAGE_KEY,
  read: storage => readRecord(storage)[id],
  write(storage, value) {
    const record = readRecord(storage);
    record[id] = value;
    storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(record));
  },
  clear(storage) {
    const record = readRecord(storage);
    if (!(id in record)) return;
    delete record[id];
    storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(record));
  },
});

/** One field of the display-preferences record (DisplayProfile.js), whose
 *  reader migrates every earlier record version. */
const DISPLAY_KEYS = ['midio-pixel:display:v1', 'smw:display:v2', 'smw:display:v1', 'smw:stageRes'];
const hasAny = (storage, keys) => keys.some(key => storage.getItem(key) != null);
const displayField = field => ({
  key: 'midio-pixel:display:v1',
  read: storage => (hasAny(storage, DISPLAY_KEYS) ? readDisplayPrefs(storage)[field] : undefined),
  write: (storage, value) => writeDisplayPrefs(storage, { ...readDisplayPrefs(storage), [field]: value }),
});

const playbackField = field => ({
  key: 'midio.playback.v1',
  read: storage => (hasAny(storage, ['midio.playback.v1']) ? readPlaybackPrefs(storage)[field] : undefined),
  write: (storage, value) => writePlaybackPrefs(storage, { ...readPlaybackPrefs(storage), [field]: value }),
});

/** A plain string key. `read` may return undefined for "nothing saved". */
const plainKey = (key, decode = v => v, encode = String) => ({
  key,
  read(storage) {
    const raw = storage?.getItem(key);
    return raw == null ? undefined : decode(raw);
  },
  write: (storage, value) => storage?.setItem(key, encode(value)),
  clear: storage => storage?.removeItem(key),
});

// ---- the definitions ------------------------------------------------------

const TERRAIN_DEBUG_OPTIONS = ['masks', 'slope', 'albedo', 'fill', 'key', 'roughness', 'specular', 'sun'];
const V2_ONLY = { id: 'rangeRenderer', is: 'v2', reason: 'Needs the 3D landscape renderer (Performance → Landscape renderer).' };

/**
 * Field reference (docs/settings.md has the full contract):
 *   id          stable identifier and, unless `url` says otherwise, the URL name
 *   url         URL parameter name, or null for no URL override
 *   label, description, section, group, tier, maturity
 *   type        boolean | enum | number | string; options / min / max / step
 *   default     value, or function(env) for device-aware defaults
 *   persist     'saved' (storage), 'url' (address bar only, for diagnostics), 'none'
 *   storage     adapter { key, read(storage), write(storage, v), clear? }
 *   lifecycle   key of LIFECYCLES
 *   requires    [{ id, is | not, reason }]: disabled with `reason` otherwise
 *   couples     value => { otherId: value }: settings changed together with it
 *   ui          false keeps a definition URL-only (automation contracts)
 *   control     a registered control kind (SettingsPanel.registerSettingControl)
 *   controlId   element id kept for tools and tests; statusId a live status span
 *   share       false keeps a value out of share links
 *   parseUrl    historical URL rules, stated for people in `urlNote`
 */
export const SETTINGS = Object.freeze([
  // ---- Appearance
  {
    id: 'pixelGrid', url: 'pixelGrid', section: 'appearance', group: 'Resolution', tier: 'basic', maturity: 'stable',
    label: 'Pixel detail', type: 'enum', default: CINEMATIC_PIXEL_GRID,
    description: 'The terrain pixel grid. Larger grids cost more GPU work; Detailed is four times Classic.',
    options: [
      { value: 'classic', label: 'Classic — 320×180' }, { value: 'classicPlus', label: 'Classic+ — 400×225' },
      { value: 'medium', label: 'Medium — 480×270' }, { value: 'mediumPlus', label: 'Medium+ — 560×315' },
      { value: 'detailed', label: 'Detailed — 640×360' },
    ],
    persist: 'saved', storage: displayField('pixelGrid'), lifecycle: 'live', controlId: 'display-pixelGrid',
    // Choosing a fixed grid stops automatic growth.
    couples: () => ({ buildPixelDetail: false }),
  },
  {
    id: 'buildPixelDetail', url: 'buildDetail', section: 'appearance', group: 'Resolution', tier: 'basic', maturity: 'stable',
    label: 'Build pixel detail', type: 'boolean', default: true,
    description: 'Start at Classic pixels and sharpen to Detailed as the mountains rise. Choosing a fixed Pixel detail turns this off.',
    persist: 'saved', storage: displayField('buildPixelDetail'), lifecycle: 'live', controlId: 'display-buildPixelDetail',
    requires: [
      { id: 'directTerrain', is: false, reason: 'The terrain-only pixel experiment draws at a fixed grid.' },
      { id: 'voxelRange', is: false, reason: 'The voxel pilot draws at a fixed grid.' },
    ],
  },
  {
    id: 'scaling', url: 'scaling', section: 'appearance', group: 'Presentation', tier: 'basic', maturity: 'stable',
    label: 'Scaling', type: 'enum', default: 'fit',
    description: 'Fit fills the window and keeps the aspect. Integer uses evenly sized screen pixels, with borders when needed. Fullscreen always covers.',
    options: [{ value: 'fit', label: 'Fit' }, { value: 'integer', label: 'Integer' }],
    persist: 'saved', storage: displayField('scaling'), lifecycle: 'live', controlId: 'display-scaling',
  },
  {
    id: 'rangeMsaa', url: 'rangeMsaa', section: 'experiments', group: 'Diagnostics', tier: 'developer', maturity: 'diagnostic',
    urlNote: '`0`, `2` or `4` (an empty value means off); anything else is automatic.',
    label: 'Terrain antialiasing', type: 'enum', default: 'auto',
    description: 'Multisampling of 3D terrain edges for non-pixel presentations. It has no effect in the current Cinematic look, which always renders terrain without multisampling (RangeRenderPolicy reason "pixel-look"), so it is not offered in the panel; Diagnostics reports the samples actually used.',
    options: [{ value: 'auto', label: 'Automatic' }, { value: '0', label: 'Off' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }],
    // Historical rule: only 0, 2 and 4 are read; anything else means automatic.
    // (Number('') is 0, so an empty value has always meant off.)
    parseUrl: raw => ([0, 2, 4].includes(Number(raw)) ? ok(String(Number(raw))) : bad(`expected 0, 2 or 4, got "${raw}"`, 'auto')),
    persist: 'url', lifecycle: 'renderer', requires: [V2_ONLY], ui: false,
  },

  // ---- Camera
  {
    id: 'rangeTour', url: 'rangeTour', section: 'camera', group: 'Camera tours', tier: 'basic', maturity: 'stable',
    urlNote: '`off` and `tetons` are recognized; any other value means music-timed tours.',
    label: 'Camera tours', type: 'enum', default: 'shots', control: 'tour', statusId: 'range-tour-status',
    description: 'Music-timed tours play where they beat the authored rail for the song. Authored rails keep every hand-made camera path. The Teton highway tour forces one long drive through the Tetons.',
    options: [
      { value: 'shots', label: 'Music-timed tours' }, { value: 'off', label: 'Authored rails only' },
      { value: 'tetons', label: 'Teton highway tour' },
    ],
    // Historical rule: tetons and off are recognized; any other value
    // (including an empty one) means shot tours.
    parseUrl: raw => (raw === 'tetons' || raw === 'off' || raw === 'shots' ? ok(raw) : bad(`expected shots, off or tetons, got "${raw}"`, 'shots')),
    persist: 'saved', storage: plainKey('range-tour', v => (v === 'tetons' || v === 'off' ? v : 'shots')),
    // No renderer requirement: choosing a tour creates the 3D presentation
    // (the Teton tour forces it), so this stays usable on the painted renderer.
    lifecycle: 'scene', controlId: 'range-tour-toggle',
  },
  {
    id: 'rangePace', url: 'rangePace', section: 'camera', group: 'Camera tours', tier: 'basic', maturity: 'stable',
    urlNote: 'present wins even when invalid; an invalid value means the default pace.',
    label: 'Landscape pace', type: 'enum', default: DEFAULT_RAIL_PACE,
    description: 'How fast authored camera rails travel. Music-timed tours and Glacier keep their own timing; the pace is kept for ordinary landscapes and replays.',
    options: RAIL_PACES.map(p => ({ value: p, label: `${p}×` })),
    normalize: v => (RAIL_PACES.includes(Number(v)) ? Number(v) : undefined),
    // Historical rule: the parameter's presence wins even when invalid; an
    // invalid value normalizes to the default pace instead of reading storage.
    parseUrl: raw => {
      const n = Number(raw);
      return RAIL_PACES.includes(n) ? ok(n) : bad(`expected 1-4, got "${raw}"`, normalizeRailPace(raw));
    },
    invalidUrlWins: true,
    persist: 'saved', storage: plainKey('range-pace', v => normalizeRailPace(v)), lifecycle: 'next-landscape', controlId: 'range-pace', statusId: 'range-pace-status',
  },
  {
    id: 'rangeTourGate', url: 'rangeTourGate', section: 'camera', group: 'Shot selection', tier: 'advanced', maturity: 'stable',
    urlNote: 'only `off` disables the gate.',
    label: 'Tour quality gate', type: 'boolean', default: true,
    description: 'Play a planned tour only where it beats the authored rail for the song. Off plays every planned tour, including weak ones.',
    parseUrl: raw => (raw === 'off' ? ok(false) : raw === 'on' || raw === '1' ? ok(true) : bad(`only "off" is recognized, got "${raw}"`, true)),
    formatUrl: v => (v ? 'on' : 'off'),
    persist: 'saved', storage: unified('rangeTourGate'), lifecycle: 'renderer',
    requires: [V2_ONLY, { id: 'rangeTour', is: 'shots', reason: 'Only music-timed tours are gated.' }],
  },
  {
    id: 'rangeShots', url: 'rangeShots', section: 'experiments', group: 'Camera experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: 'only `all` enables candidate libraries.',
    label: 'Candidate shot libraries', type: 'boolean', default: false,
    description: 'Also play shot libraries that are still candidates, not only approved and enabled ones. For review.',
    parseUrl: raw => (raw === 'all' ? ok(true) : bad(`only "all" is recognized, got "${raw}"`, false)),
    formatUrl: v => (v ? 'all' : ''),
    persist: 'saved', storage: unified('rangeShots'), lifecycle: 'renderer',
    requires: [V2_ONLY, { id: 'rangeTour', is: 'shots', reason: 'Applies to music-timed tours.' }],
  },
  {
    id: 'rangeTourIntended', url: 'rangeTourIntended', section: 'experiments', group: 'Camera experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: 'only `1` enables it.',
    label: 'Try intended tour subjects', type: 'boolean', default: false,
    description: 'Let a tour shot framed by an alternative subject try its intended one. It replaces an accepted subject, so it is opt-in.',
    parseUrl: strictFlag,
    persist: 'saved', storage: unified('rangeTourIntended'), lifecycle: 'renderer',
    requires: [V2_ONLY, { id: 'rangeTour', not: 'off', reason: 'Applies to camera tours.' }],
  },

  // ---- Landscape
  {
    id: 'landDance', url: 'landDance', section: 'landscape', group: 'Music response', tier: 'advanced', maturity: 'stable',
    urlNote: '`on` or empty is 1, `off` is 0, numbers clamp to 0–1, other text is 1.',
    label: 'Land dance', type: 'number', min: 0, max: 1, step: 0.05, default: 1,
    description: 'How strongly the music moves ridges and drainages. 0 keeps the land still between growth steps.',
    // Historical rule: on/empty mean 1, off means 0, numbers clamp to 0..1,
    // anything else means 1.
    parseUrl: raw => {
      if (raw === '' || raw === 'on') return ok(1);
      if (raw === 'off') return ok(0);
      const n = Number(raw);
      return Number.isFinite(n) ? ok(Math.min(1, Math.max(0, n))) : bad(`expected 0..1, on or off, got "${raw}"`, 1);
    },
    persist: 'saved', storage: unified('landDance'), lifecycle: 'live', requires: [V2_ONLY],
  },
  {
    id: 'rangeView', url: 'rangeView', section: 'landscape', group: 'Geographic view', tier: 'advanced', maturity: 'diagnostic',
    label: 'Force a landscape view', type: 'string', nullable: true, default: null, pattern: /^[A-Za-z0-9._-]{1,80}$/,
    description: 'Play every landscape against one catalog view instead of the song\'s own matches. Diagnostic: songs no longer choose their scenery.',
    optionsSource: 'sceneCatalog',
    persist: 'url', lifecycle: 'renderer',
    requires: [V2_ONLY, { id: 'rangeTour', not: 'tetons', reason: 'The Teton highway tour forces its own view.' }],
  },
  {
    id: 'songRange', url: 'songRange', section: 'experiments', group: 'Terrain experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: '`1`/`on` enable, `force` forces, `0`/`off` disable.',
    label: 'Composed song ranges', type: 'enum', default: 'off',
    description: 'Compose a home range for the song from measured mountain pieces. Force plans one for every song, whatever its biome (diagnostic).',
    options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }, { value: 'force', label: 'Force (diagnostic)' }],
    parseUrl: raw => (raw === '1' || raw === 'on' ? ok('on') : raw === 'force' ? ok('force') : raw === '0' || raw === 'off' ? ok('off') : bad(`expected 1, on or force, got "${raw}"`, 'off')),
    formatUrl: v => (v === 'on' ? '1' : v),
    persist: 'saved', storage: unified('songRange'), lifecycle: 'next-song', requires: [V2_ONLY],
  },
  {
    id: 'performance', url: 'performance', section: 'experiments', group: 'Terrain experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: '`dual-summits` or `off`; anything else is automatic.',
    label: 'Dual Summits performance', type: 'enum', default: 'auto',
    description: 'Automatic selects the Dual Summits signature landscape only for the canonical recording. Always applies its direction to any song; Never suppresses it.',
    options: [{ value: 'auto', label: 'Automatic' }, { value: 'dual-summits', label: 'Always' }, { value: 'off', label: 'Never' }],
    parseUrl: raw => (raw === 'dual-summits' || raw === 'off' ? ok(raw) : bad(`expected dual-summits or off, got "${raw}"`, 'auto')),
    persist: 'saved', storage: unified('performance'), lifecycle: 'next-song',
    requires: [V2_ONLY, { id: 'rangeTour', not: 'tetons', reason: 'A forced tour or view replaces the performance.' },
      { id: 'rangeView', is: null, reason: 'A forced view replaces the performance.' }],
  },
  {
    id: 'rangeRise', url: 'rangeRise', section: 'experiments', group: 'Review aids', tier: 'developer', maturity: 'diagnostic',
    label: 'Hold land height', type: 'number', nullable: true, min: 0, max: 1, step: 0.05, default: null,
    description: 'Hold the land at one height (0–1) for review captures. Empty lets the music decide. Not production playback.',
    persist: 'url', lifecycle: 'next-song', requires: [V2_ONLY],
  },
  {
    id: 'rangeRelief', url: 'rangeRelief', section: 'experiments', group: 'Review aids', tier: 'developer', maturity: 'diagnostic',
    label: 'Fixed composed relief', type: 'number', nullable: true, min: 0.25, max: 6, step: 0.05, default: null,
    description: 'A fixed relief scale for composed stages (1 = measured) instead of the framing rule. Empty uses the rule.',
    persist: 'url', lifecycle: 'next-song', requires: [{ id: 'songRange', not: 'off', reason: 'Applies to composed song ranges.' }],
  },
  {
    id: 'songRangeLayout', url: 'songRangeLayout', section: 'experiments', group: 'Review aids', tier: 'developer', maturity: 'diagnostic',
    label: 'Composed pilot layout', type: 'string', nullable: true, default: null, pattern: /^[A-Za-z0-9._-]{1,80}$/,
    description: 'Run a catalog pilot layout (song-range-pilot-a/b/c) through the runtime, to compare with its offline stage.',
    persist: 'url', lifecycle: 'next-song', ui: false,
  },

  // ---- Performance
  {
    id: 'maxQuality', url: 'maxQuality', section: 'performance', group: 'Automatic quality', tier: 'basic', maturity: 'stable',
    label: 'General quality', type: 'enum', default: 'high',
    description: 'The most detail automatic quality may use. It still sheds detail below this to keep playback smooth.',
    options: RENDER_QUALITIES.map(q => ({ value: q, label: q[0].toUpperCase() + q.slice(1) })),
    persist: 'saved', storage: {
      key: 'midio-pixel:render-quality:v1',
      // readRenderQuality migrates the retired Economy display choice.
      read(storage) {
        if (storage.getItem('midio-pixel:render-quality:v1') != null) return readRenderQuality(storage);
        return readDisplayPrefs(storage).quality === 'economy' ? 'low' : undefined;
      },
      write: (storage, value) => writeRenderQuality(storage, value),
    },
    lifecycle: 'live', controlId: 'generalQuality', control: 'slider',
  },
  {
    id: 'fpsCap', url: 'fpsCap', section: 'performance', group: 'Frame rate', tier: 'basic', maturity: 'stable',
    urlNote: '`30` or `60`.',
    label: 'Frame rate', type: 'enum', default: 60,
    description: '60 draws every frame; 30 skips every other frame and halves GPU work.',
    options: [{ value: 60, label: '60 fps' }, { value: 30, label: '30 fps' }],
    normalize: v => ([30, 60].includes(Number(v)) ? Number(v) : undefined),
    parseUrl: raw => ([30, 60].includes(Number(raw)) ? ok(Number(raw)) : bad(`expected 30 or 60, got "${raw}"`)),
    persist: 'saved', storage: plainKey('smw:stageFps', v => ([30, 60].includes(Number(v)) ? Number(v) : undefined)),
    lifecycle: 'live', controlId: 'stageFps',
  },
  {
    id: 'perf', url: 'perf', section: 'performance', group: 'Automatic quality', tier: 'advanced', maturity: 'stable',
    label: 'Starting quality', type: 'enum', default: 'auto', caseInsensitive: true,
    description: 'Where automatic quality starts each song. Automatic starts phones and small screens one step down. Lite starts two steps down; Full starts at full detail.',
    options: [{ value: 'auto', label: 'Automatic' }, { value: 'lite', label: 'Lite' }, { value: 'high', label: 'Full' }],
    persist: 'saved', storage: unified('perf'), lifecycle: 'next-song',
  },
  {
    id: 'rangeRenderer', url: 'rangeRenderer', section: 'performance', group: 'Renderer', tier: 'advanced', maturity: 'stable',
    label: 'Landscape renderer', type: 'enum', default: 'v2', caseInsensitive: true,
    description: '3D terrain uses WebGL2 scenery and falls back to the painted ranges on its own when it cannot run. Painted always uses the lighter 2D ranges.',
    options: [{ value: 'v2', label: '3D terrain (WebGL2)' }, { value: 'legacy', label: 'Painted ranges' }],
    persist: 'saved', storage: unified('rangeRenderer'), lifecycle: 'renderer',
    requires: [{ id: 'rangeTour', not: 'tetons', reason: 'The Teton highway tour always uses 3D terrain.' }],
  },
  {
    id: 'fps', url: 'fps', section: 'performance', group: 'Diagnostics', tier: 'advanced', maturity: 'stable',
    urlNote: 'the bare parameter (any value except `0`/`off`) shows the counter.',
    label: 'Show frame rate', type: 'boolean', default: false,
    description: 'An on-screen frames-per-second counter. The P key toggles it too.',
    // Historical rule: the bare parameter (any value) shows the counter.
    parseUrl: raw => (FALSE.has(String(raw).toLowerCase()) ? ok(false) : ok(true)),
    formatUrl: v => (v ? '1' : '0'),
    persist: 'saved', storage: unified('fps'), lifecycle: 'live',
  },
  {
    id: 'renderer', url: 'renderer', section: 'experiments', group: 'Rendering experiments', tier: 'experimental', maturity: 'experimental',
    label: 'WebGL post-effects overlay', type: 'enum', default: 'canvas', caseInsensitive: true,
    description: 'Draw the optional WebGL post-effects overlay on top of Canvas 2D. Falls back to Canvas 2D when WebGL is unavailable.',
    options: [{ value: 'canvas', label: 'Canvas 2D' }, { value: 'webgl', label: 'WebGL overlay' }],
    persist: 'saved', storage: unified('renderer'), lifecycle: 'renderer',
  },

  // ---- Audio & playback
  {
    id: 'shuffle', url: 'shuffle', section: 'playback', group: 'Song order', tier: 'basic', maturity: 'stable',
    label: 'Shuffle', type: 'boolean', default: DEFAULT_PLAYBACK_PREFS.shuffle,
    description: 'Play library songs in a shuffled order.',
    persist: 'saved', storage: playbackField('shuffle'), lifecycle: 'live',
  },
  {
    id: 'continuous', url: 'continuous', section: 'playback', group: 'Song order', tier: 'basic', maturity: 'stable',
    label: 'Continuous play', type: 'boolean', default: DEFAULT_PLAYBACK_PREFS.continuous,
    description: 'Start the next library song automatically after a countdown.',
    persist: 'saved', storage: playbackField('continuous'), lifecycle: 'live',
  },
  {
    id: 'lyrics', url: 'lyrics', section: 'playback', group: 'Lyrics', tier: 'basic', maturity: 'stable',
    label: 'Timed lyric grounding', type: 'boolean', default: true,
    description: 'Look up time-stamped lyrics for the song and use them to place verses and choruses on the real clock.',
    persist: 'saved', storage: {
      key: 'smw:noLyrics',
      read: storage => (storage?.getItem('smw:noLyrics') == null ? undefined : !getLyricsDisabled(storage)),
      write: (storage, value) => setLyricsDisabled(!value, storage),
    },
    lifecycle: 'next-song', control: 'pressButton', controlId: 'lyricGroundingBtn',
  },
  {
    id: 'btLatency', url: 'btLatency', section: 'playback', group: 'Sync', tier: 'basic', maturity: 'stable',
    label: 'Bluetooth delay (ms)', type: 'number', min: -MAX_BT_LATENCY_TRIM_MS, max: MAX_BT_LATENCY_TRIM_MS, step: 1, default: 0,
    description: 'Delay the visuals to match Bluetooth audio, which most devices do not report. Negative delays the audio instead. 0 is off; leave it off on wired audio.',
    persist: 'saved', storage: {
      key: 'smw:btLatencyTrimMs',
      read: storage => (storage?.getItem('smw:btLatencyTrimMs') == null && storage?.getItem('smw:btLatencyTrim') == null
        ? undefined : getBtLatencyTrimMs(storage)),
      write: (storage, value) => setBtLatencyTrimMs(value, storage),
    },
    lifecycle: 'live',
  },

  // ---- Experiments: rendering
  {
    id: 'directTerrain', url: 'directTerrain', section: 'experiments', group: 'Rendering experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: 'only `1` enables it.',
    label: 'Terrain-only pixel pipeline', type: 'boolean', default: false,
    description: 'Compose sky, water and effects at output resolution and sample only the terrain onto the pixel grid. Colours can differ from normal playback.',
    parseUrl: strictFlag,
    persist: 'saved', storage: unified('directTerrain'), lifecycle: 'live', requires: [V2_ONLY],
  },
  {
    id: 'voxelRange', url: 'voxelRange', section: 'experiments', group: 'Rendering experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: 'only `1` enables it.',
    label: 'Voxel range pilot', type: 'boolean', default: false,
    description: 'Replace the landscape with the White Mountains voxel pilot (a 16 MB download, WebGL2).',
    parseUrl: strictFlag,
    persist: 'saved', storage: unified('voxelRange'), lifecycle: 'reload',
  },
  {
    id: 'terrainShading', url: 'terrainShading', section: 'experiments', group: 'Rendering experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: 'only `moran` enables the study.',
    label: 'Mount Moran snow study', type: 'enum', default: 'off',
    description: 'Curvature-aware snow edges on Mount Moran in the Jackson Lake view. Other views are unchanged.',
    options: [{ value: 'off', label: 'Off' }, { value: 'moran', label: 'Mount Moran' }],
    parseUrl: raw => (raw === 'moran' ? ok('moran') : raw === 'off' ? ok('off') : bad(`only "moran" is recognized, got "${raw}"`, 'off')),
    persist: 'saved', storage: unified('terrainShading'), lifecycle: 'renderer', requires: [V2_ONLY],
  },
  {
    id: 'compiledTerrain', url: 'compiledTerrain', section: 'experiments', group: 'Rendering experiments', tier: 'experimental', maturity: 'experimental',
    urlNote: '`columns` or `mesh`; `off`/`original`/empty or an unknown value draws the original (unknown values are reported).',
    label: 'Compiled terrain (Monument Valley pilot)', type: 'enum', default: 'original',
    description: 'Replace the terrain draw for the pilot view with precompiled meshes. Needs packs from npm run build:compiled-terrain; without them the original renderer draws.',
    options: [{ value: 'original', label: 'Original renderer' }, { value: 'columns', label: 'Height columns' }, { value: 'mesh', label: 'Triangle mesh' }],
    parseUrl: raw => (raw === '' || raw === 'off' || raw === 'original' ? ok('original')
      : raw === 'columns' || raw === 'mesh' ? ok(raw) : bad(`expected columns or mesh, got "${raw}"`, 'original')),
    availability: 'compiledTerrainPacks',
    persist: 'url', lifecycle: 'renderer', requires: [V2_ONLY],
  },
  {
    id: 'compiledTerrainCamera', url: 'compiledTerrainCamera', section: 'experiments', group: 'Rendering experiments', tier: 'developer', maturity: 'diagnostic',
    label: 'Compiled terrain test rail', type: 'string', nullable: true, default: null, pattern: /^[a-z0-9-]{1,32}$/,
    description: 'The compiled-terrain pilot\'s declared test rail (for example "reverse").', persist: 'url', lifecycle: 'renderer', ui: false,
  },
  {
    id: 'compiledTerrainGroup', url: 'compiledTerrainGroup', section: 'experiments', group: 'Rendering experiments', tier: 'developer', maturity: 'diagnostic',
    urlNote: '`1`, `2`, `4` or `8`; anything else is automatic.',
    label: 'Compiled terrain batching', type: 'enum', default: 'auto',
    description: 'Draw batching for compiled packs: tiles per side of a merged block. A measuring aid.',
    options: [{ value: 'auto', label: 'Automatic' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 4, label: '4' }, { value: 8, label: '8' }],
    parseUrl: raw => ([1, 2, 4, 8].includes(Number(raw)) ? ok(Number(raw)) : bad(`expected 1, 2, 4 or 8, got "${raw}"`, 'auto')),
    persist: 'url', lifecycle: 'renderer', ui: false,
  },
  {
    id: 'compiledTerrainProfile', url: 'compiledTerrainProfile', section: 'experiments', group: 'Rendering experiments', tier: 'developer', maturity: 'diagnostic',
    label: 'Compiled terrain profile', type: 'string', nullable: true, default: null, pattern: /^[a-z0-9-]{1,32}$/,
    description: 'Use packs built with --profile NAME.', persist: 'url', lifecycle: 'renderer', ui: false,
  },

  // ---- Experiments: engineering comparisons (reference implementations)
  {
    id: 'canopySummary', url: 'canopySummary', section: 'experiments', group: 'Reference implementations', tier: 'developer', maturity: 'stable',
    urlNote: 'absent, `1` or `on` keep it; any other value opts out.',
    label: 'Distant canopy summary', type: 'boolean', default: true,
    description: 'Distant tree crowns use the mean canopy once they are too small to resolve. Off draws every crown individually, for comparison.',
    // Historical rule: absent, 1 or on keeps it; any other value opts out.
    parseUrl: raw => (raw === '1' || raw === 'on' ? ok(true) : raw === '0' || raw === 'off' ? ok(false) : bad(`expected 1/on or 0/off, got "${raw}"`, false)),
    persist: 'saved', storage: unified('canopySummary'), lifecycle: 'renderer', requires: [V2_ONLY],
  },
  {
    id: 'materialFeatures', url: 'materialFeatures', section: 'experiments', group: 'Reference implementations', tier: 'developer', maturity: 'stable',
    urlNote: 'absent or `warp` keep the cache; any other value uses the reference.',
    label: 'Material feature cache', type: 'enum', default: 'warp',
    description: 'Cached rock and snow texture warp. Reference evaluates the noise per pixel, for comparison.',
    options: [{ value: 'warp', label: 'Cached (default)' }, { value: 'reference', label: 'Reference' }],
    // Historical rule: any value other than warp falls back to the reference.
    parseUrl: raw => (raw === 'warp' || raw === 'reference' ? ok(raw) : raw === 'off' || raw === '0' ? ok('reference') : bad(`expected warp or reference, got "${raw}"`, 'reference')),
    persist: 'saved', storage: unified('materialFeatures'), lifecycle: 'renderer', requires: [V2_ONLY],
  },
  {
    id: 'deformGradient', url: 'deformGradient', section: 'experiments', group: 'Reference implementations', tier: 'developer', maturity: 'stable',
    urlNote: 'absent or `factored` keep it; any other value uses the reference.',
    label: 'Factored deformation gradient', type: 'enum', default: 'factored',
    description: 'The factored terrain-tilt stencil. Reference uses the original six-call stencil, for comparison.',
    options: [{ value: 'factored', label: 'Factored (default)' }, { value: 'reference', label: 'Reference' }],
    parseUrl: raw => (raw === 'factored' || raw === 'reference' ? ok(raw) : raw === 'off' || raw === '0' ? ok('reference') : bad(`expected factored or reference, got "${raw}"`, 'reference')),
    persist: 'saved', storage: unified('deformGradient'), lifecycle: 'renderer', requires: [V2_ONLY],
  },

  // ---- Experiments: diagnostics
  {
    id: 'dev', url: 'dev', section: 'experiments', group: 'Diagnostics', tier: 'developer', maturity: 'diagnostic',
    urlNote: 'only `1` enables it.',
    label: 'Developer keys and overlay', type: 'boolean', default: false,
    description: 'Enable the ` / V / T debug overlay keys and stem diagnostics. Off by default so stray key presses cannot change the engine.',
    parseUrl: strictFlag,
    persist: 'saved', storage: unified('dev'), lifecycle: 'live',
  },
  {
    id: 'rangeDebug', url: 'rangeDebug', section: 'experiments', group: 'Diagnostics', tier: 'developer', maturity: 'diagnostic',
    label: 'Terrain debug view', type: 'enum', default: 'off',
    description: 'Replace terrain shading with one internal channel.',
    options: [{ value: 'off', label: 'Off' }, ...TERRAIN_DEBUG_OPTIONS.map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))],
    persist: 'url', lifecycle: 'renderer', requires: [V2_ONLY],
  },
  {
    id: 'forestDebug', url: 'forestDebug', section: 'experiments', group: 'Diagnostics', tier: 'developer', maturity: 'diagnostic',
    urlNote: 'only `1` enables it.',
    label: 'Forest representation colours', type: 'boolean', default: false,
    description: 'Colour trees by their level-of-detail representation.',
    parseUrl: strictFlag,
    persist: 'url', lifecycle: 'renderer', requires: [V2_ONLY],
  },
  {
    id: 'rangeDiag', url: 'rangeDiag', section: 'experiments', group: 'Diagnostics', tier: 'developer', maturity: 'diagnostic',
    urlNote: 'only `markers` enables it.',
    label: 'Landscape markers', type: 'boolean', default: false,
    description: 'Draw diagnostic markers over the 3D landscape.',
    parseUrl: raw => (raw === 'markers' ? ok(true) : bad(`only "markers" is recognized, got "${raw}"`, false)),
    formatUrl: v => (v ? 'markers' : ''),
    persist: 'url', lifecycle: 'renderer', requires: [V2_ONLY],
  },

  // ---- Automation contracts (URL only)
  {
    id: 'bulkExport', url: 'bulkExport', section: null, tier: 'developer', maturity: 'diagnostic',
    urlNote: 'only `1` arms export.',
    label: 'Bulk export', type: 'boolean', default: false,
    description: 'Arms frame export for tools/bulk-export.mjs and the visual evaluation tools; needs exportW and exportH.',
    parseUrl: raw => (raw === '1' ? ok(true) : bad(`expected 1, got "${raw}"`, false)),
    persist: 'none', lifecycle: 'next-song', ui: false, share: false,
  },
  {
    id: 'exportW', url: 'exportW', section: null, tier: 'developer', maturity: 'diagnostic',
    urlNote: 'passed through unvalidated; the export refuses an unusable size.',
    label: 'Export width', type: 'number', nullable: true, min: 2, max: 7680, step: 1, default: null,
    description: 'Exact export width in pixels (even). Passed through unvalidated: the export refuses an unusable size loudly.',
    parseUrl: raw => ok(Number(raw)), persist: 'none', lifecycle: 'next-song', ui: false, share: false,
  },
  {
    id: 'exportH', url: 'exportH', section: null, tier: 'developer', maturity: 'diagnostic',
    urlNote: 'passed through unvalidated; the export refuses an unusable size.',
    label: 'Export height', type: 'number', nullable: true, min: 2, max: 4320, step: 1, default: null,
    description: 'Exact export height in pixels (even). Passed through unvalidated, like exportW.',
    parseUrl: raw => ok(Number(raw)), persist: 'none', lifecycle: 'next-song', ui: false, share: false,
  },
].map(def => Object.freeze({ url: def.id, ui: true, share: true, requires: [], ...def })));

/** Parameters the page no longer reads. A URL that still carries one is
 *  accepted and reported as ignored, never an error. */
export const RETIRED_PARAMS = Object.freeze({
  style: 'The Classic/Rendered style switch was retired; one look remains.',
  rangePipeline: 'The single-stage pipeline was removed with the Pixel and Palette looks; Cinematic always uses the hybrid composite.',
  experience: 'Every song plays in Landscape.',
  rangeExperience: 'Every song plays in Landscape.',
  pixelScale: 'Pixel scaling is Uniform; the option was removed.',
  seed: 'Seeds are not read from the URL; tools pin them through the page.',
  fpsHud: 'Use fps=1.',
});

/** Parameters owned by other pages or internals, listed so diagnostics do
 *  not call them unknown. */
export const FOREIGN_PARAMS = Object.freeze({
  version: 'Read by the version-history shell (src/ui/HistoryPicker.js), not the app.',
});

export const SETTINGS_BY_ID = new Map(SETTINGS.map(def => [def.id, def]));
export const SETTINGS_BY_URL = new Map(SETTINGS.filter(d => d.url).map(def => [def.url, def]));

export function settingDefinition(id) {
  const def = SETTINGS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown setting "${id}"`);
  return def;
}

export function defaultValue(def, env = {}) {
  return typeof def.default === 'function' ? def.default(env) : def.default;
}

/** Read a definition's saved value, validated; undefined when absent or
 *  invalid (an invalid stored value is ignored, never thrown). */
export function readSaved(def, storage) {
  if (def.persist !== 'saved' || !def.storage || !storage) return undefined;
  try {
    const raw = def.storage.read(storage);
    return raw === undefined ? undefined : normalizeValue(def, raw);
  } catch { return undefined; }
}

export function writeSaved(def, storage, value) {
  if (def.persist !== 'saved' || !def.storage || !storage) return false;
  try { def.storage.write(storage, value); return true; } catch { return false; }
}

function toParams(search) {
  if (search instanceof URLSearchParams) return search;
  return new URLSearchParams(String(search || '').replace(/^\?/, ''));
}

/**
 * Resolve every definition. Precedence: an explicit URL override, then a
 * saved preference, then the (device-aware) default. Each entry records why
 * its value was chosen. An invalid URL value is rejected and reported; it
 * falls through to the next source unless the definition's historical rule
 * gives it a value of its own (`value` on the parse result).
 */
export function resolveSettings({ search = '', storage = null, env = {}, ids = null } = {}) {
  const params = toParams(search);
  const entries = {};
  const defs = ids ? ids.map(settingDefinition) : SETTINGS;
  for (const def of defs) {
    const fallback = defaultValue(def, env);
    const entry = { id: def.id, value: fallback, source: 'default', default: fallback, requested: null, rejected: null };
    if (def.url && params.has(def.url)) {
      const raw = params.get(def.url);
      entry.requested = raw;
      const parsed = parseUrlValue(def, raw);
      if (parsed.ok) { entry.value = parsed.value; entry.source = 'url'; }
      else {
        entry.rejected = { raw, reason: parsed.reason };
        if (parsed.value !== undefined) { entry.value = parsed.value; entry.source = 'url'; }
      }
    }
    if (entry.source === 'default') {
      const saved = readSaved(def, storage);
      if (saved !== undefined) { entry.value = saved; entry.source = 'saved'; }
    }
    entries[def.id] = entry;
  }
  const unknown = [], retired = [];
  for (const key of new Set(params.keys())) {
    if (SETTINGS_BY_URL.has(key) || FOREIGN_PARAMS[key]) continue;
    if (RETIRED_PARAMS[key]) retired.push({ param: key, raw: params.get(key), reason: RETIRED_PARAMS[key] });
    else unknown.push({ param: key, raw: params.get(key) });
  }
  return { entries, unknown, retired };
}

/** The value of one definition for an explicit search string, ignoring
 *  storage: the contract the historical per-module parsers had. */
export function urlSettingValue(id, search) {
  return resolveSettings({ search, ids: [id] }).entries[id].value;
}

/** Why a definition is disabled under `values`, or null. */
export function disabledReason(def, values) {
  for (const req of def.requires || []) {
    const v = values[req.id];
    if ('is' in req && v !== req.is) return req.reason;
    if ('not' in req && v === req.not) return req.reason;
  }
  return null;
}

/**
 * A share link: the page URL with only the overrides needed to reproduce
 * `values`, i.e. those that differ from the default. Unrelated parameters of
 * `href` are dropped; automation contracts are never included.
 */
export function shareUrl(href, values, { env = {} } = {}) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  for (const def of SETTINGS) {
    if (!def.url || def.share === false || !(def.id in values)) continue;
    const value = values[def.id];
    if (Object.is(value, defaultValue(def, env)) || value == null) continue;
    url.searchParams.set(def.url, formatUrlValue(def, value));
  }
  return url.href;
}

/** A URL search with one parameter set (or removed when `value` is
 *  undefined), all others preserved. */
export function withParam(href, param, value) {
  const url = new URL(href);
  if (value === undefined) url.searchParams.delete(param);
  else url.searchParams.set(param, value);
  return url.href;
}
