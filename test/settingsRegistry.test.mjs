// The settings registry and store (src/config/settingsRegistry.js,
// src/config/appSettings.js): resolution, validation, precedence,
// persistence, migration, URL compatibility, share links and lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SETTINGS, SECTIONS, TIERS, LIFECYCLES, RETIRED_PARAMS, SETTINGS_STORAGE_KEY,
  resolveSettings, normalizeValue, parseUrlValue, settingDefinition, shareUrl, disabledReason, urlSettingValue,
} from '../src/config/settingsRegistry.js';
import { SettingsStore, settingValue, configureSettings, explainSetting } from '../src/config/appSettings.js';
import { renderReference, REFERENCE_PATH } from '../tools/settings-reference.mjs';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { writes: [], getItem: k => (map.has(k) ? map.get(k) : null), setItem(k, v) { this.writes.push(k); map.set(k, String(v)); },
    removeItem: k => map.delete(k), dump: () => Object.fromEntries(map) };
}
function memoryHistory(href) {
  let current = href;
  return { href: () => current, replace: h => { current = String(h); } };
}

test('every definition is well formed', () => {
  const ids = new Set(), urls = new Set(), controlIds = new Set();
  const sections = new Set(SECTIONS.map(s => s.id));
  for (const def of SETTINGS) {
    assert.ok(!ids.has(def.id), `duplicate id ${def.id}`); ids.add(def.id);
    if (def.url) { assert.ok(!urls.has(def.url), `duplicate URL ${def.url}`); urls.add(def.url); }
    if (def.controlId) { assert.ok(!controlIds.has(def.controlId), def.controlId); controlIds.add(def.controlId); }
    assert.ok(def.label && def.description, `${def.id} needs a label and description`);
    assert.ok(TIERS.includes(def.tier), `${def.id} tier`);
    assert.ok(LIFECYCLES[def.lifecycle], `${def.id} lifecycle`);
    assert.ok(['saved', 'url', 'none'].includes(def.persist), `${def.id} persist`);
    if (def.persist === 'saved') assert.ok(def.storage?.read && def.storage?.write, `${def.id} storage adapter`);
    if (def.ui !== false) assert.ok(sections.has(def.section), `${def.id} section`);
    assert.notEqual(normalizeValue(def, def.default), undefined, `${def.id} default must validate`);
    for (const req of def.requires) assert.ok(ids.has(req.id) || SETTINGS.some(d => d.id === req.id), `${def.id} requires ${req.id}`);
    assert.ok(!RETIRED_PARAMS[def.url], `${def.url} is both live and retired`);
  }
});

test('defaults resolve with no URL and no storage', () => {
  const { entries, unknown, retired } = resolveSettings();
  for (const def of SETTINGS) {
    assert.equal(entries[def.id].source, 'default');
    assert.deepEqual(entries[def.id].value, def.default);
  }
  assert.deepEqual(unknown, []);
  assert.deepEqual(retired, []);
});

test('enum, number and boolean constraints validate and normalize', () => {
  assert.equal(normalizeValue(settingDefinition('pixelGrid'), 'medium'), 'medium');
  assert.equal(normalizeValue(settingDefinition('pixelGrid'), 'depth'), undefined);
  assert.equal(normalizeValue(settingDefinition('landDance'), 1.7), 1, 'numbers clamp to their range');
  assert.equal(normalizeValue(settingDefinition('landDance'), '0.25'), 0.25);
  assert.equal(normalizeValue(settingDefinition('landDance'), 'loud'), undefined);
  assert.equal(normalizeValue(settingDefinition('btLatency'), '120.6'), 121, 'integer steps round');
  assert.equal(normalizeValue(settingDefinition('btLatency'), -900), -500);
  assert.equal(normalizeValue(settingDefinition('rangeRise'), null), null, 'nullable numbers accept automatic');
  assert.equal(normalizeValue(settingDefinition('fps'), 'yes'), undefined, 'booleans are booleans');
  assert.equal(normalizeValue(settingDefinition('rangePace'), '2'), 2);
  assert.equal(normalizeValue(settingDefinition('rangePace'), 7), undefined);
  assert.equal(normalizeValue(settingDefinition('rangeView'), 'teton-jackson-lake'), 'teton-jackson-lake');
  assert.equal(normalizeValue(settingDefinition('rangeView'), 'bad view!'), undefined);
});

test('historical URL rules are preserved', () => {
  const v = (id, search) => urlSettingValue(id, search);
  assert.equal(v('rangeMsaa', '?rangeMsaa=4'), '4');
  assert.equal(v('rangeMsaa', '?rangeMsaa='), '0', 'Number("") is 0: an empty value has always meant off');
  assert.equal(v('rangeMsaa', '?rangeMsaa=3'), 'auto');
  assert.equal(v('rangePace', '?rangePace=9'), 3, 'presence wins even when invalid');
  assert.equal(v('rangeTour', '?rangeTour=garbage'), 'shots');
  assert.equal(v('rangeTour', '?rangeTour=off'), 'off');
  assert.equal(v('canopySummary', '?canopySummary=x'), false, 'an unknown value opts out to the reference');
  assert.equal(v('materialFeatures', '?materialFeatures=x'), 'reference');
  assert.equal(v('deformGradient', '?deformGradient=off'), 'reference');
  assert.equal(v('landDance', '?landDance=off'), 0);
  assert.equal(v('landDance', '?landDance=4'), 1);
  assert.equal(v('landDance', '?landDance=wild'), 1);
  assert.equal(v('fps', '?fps'), true, 'the bare parameter shows the counter');
  assert.equal(v('fps', '?fps=0'), false);
  assert.equal(v('rangeTourIntended', '?rangeTourIntended=true'), false, 'only =1 opts in');
  assert.equal(v('songRange', '?songRange=1'), 'on');
  assert.equal(v('songRange', '?songRange=force'), 'force');
  assert.equal(v('perf', '?perf=LITE'), 'lite', 'case-insensitive as before');
  assert.equal(v('renderer', '?renderer=WebGL'), 'webgl');
  assert.equal(v('rangeRenderer', '?rangeRenderer=bogus'), 'v2');
  assert.equal(v('rangeRise', '?rangeRise=2'), null);
  assert.equal(v('rangeRelief', '?rangeRelief=1.5'), 1.5);
  assert.equal(v('compiledTerrainGroup', '?compiledTerrainGroup=4'), 4);
  assert.equal(v('exportW', '?exportW=1281'), 1281, 'export sizes pass through for evenExportSize to refuse');
});

test('invalid, retired and unknown parameters are reported, never thrown', () => {
  const { entries, unknown, retired } = resolveSettings({ search: '?pixelGrid=huge&style=classic&rangePipeline=single&foo=1&version=x' });
  assert.equal(entries.pixelGrid.value, 'detailed');
  assert.equal(entries.pixelGrid.source, 'default');
  assert.deepEqual(entries.pixelGrid.rejected.raw, 'huge');
  assert.deepEqual(retired.map(r => r.param).sort(), ['rangePipeline', 'style']);
  assert.deepEqual(unknown, [{ param: 'foo', raw: '1' }], 'version belongs to the history shell');
});

test('several URL overrides combine', () => {
  const { entries } = resolveSettings({ search: '?rangeRenderer=legacy&rangePace=1&fpsCap=30&maxQuality=low&shuffle=0' });
  assert.deepEqual(['rangeRenderer', 'rangePace', 'fpsCap', 'maxQuality', 'shuffle'].map(id => entries[id].value), ['legacy', 1, 30, 'low', false]);
  assert.ok(['rangeRenderer', 'rangePace', 'fpsCap', 'maxQuality', 'shuffle'].every(id => entries[id].source === 'url'));
});

test('precedence: URL, then saved, then default; invalid saved values are ignored', () => {
  const storage = memoryStorage({ 'range-pace': '1', 'smw:stageFps': '45', [SETTINGS_STORAGE_KEY]: JSON.stringify({ landDance: 0.5, perf: 'turbo' }) });
  const saved = resolveSettings({ storage }).entries;
  assert.equal(saved.rangePace.value, 1); assert.equal(saved.rangePace.source, 'saved');
  assert.equal(saved.landDance.value, 0.5);
  assert.equal(saved.fpsCap.source, 'default', 'an invalid stored frame rate falls back');
  assert.equal(saved.perf.source, 'default');
  const url = resolveSettings({ search: '?rangePace=4', storage }).entries;
  assert.equal(url.rangePace.value, 4); assert.equal(url.rangePace.source, 'url');
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  assert.equal(resolveSettings({ storage: blocked }).entries.rangePace.value, 3);
});

test('existing saved preferences migrate without loss', () => {
  // Pre-registry keys and their own legacy records, read through the adapters.
  const storage = memoryStorage({
    'smw:display:v1': JSON.stringify({ version: 1, look: 'pixel', quality: 'economy', scaling: 'integer', buildPixelDetail: false }),
    'smw:btLatencyTrim': '1', 'smw:noLyrics': '1', 'midio.playback.v1': JSON.stringify({ shuffle: false, continuous: true }),
    'range-tour': 'off',
  });
  const { entries } = resolveSettings({ storage });
  assert.equal(entries.scaling.value, 'integer');
  assert.equal(entries.buildPixelDetail.value, false);
  assert.equal(entries.maxQuality.value, 'low', 'the retired Economy display choice becomes Low');
  assert.equal(entries.btLatency.value, 30, 'the old boolean BT flag keeps its correction');
  assert.equal(entries.lyrics.value, false);
  assert.equal(entries.shuffle.value, false);
  assert.equal(entries.continuous.value, true);
  assert.equal(entries.rangeTour.value, 'off');
  assert.ok(['scaling', 'maxQuality', 'btLatency', 'lyrics', 'shuffle', 'rangeTour'].every(id => entries[id].source === 'saved'));
});

test('dependencies disable settings with a reason', () => {
  const values = resolveSettings({ search: '?rangeRenderer=legacy' }).entries;
  const flat = Object.fromEntries(Object.values(values).map(e => [e.id, e.value]));
  assert.match(disabledReason(settingDefinition('rangeMsaa'), flat), /3D landscape renderer/);
  assert.equal(disabledReason(settingDefinition('pixelGrid'), flat), null);
  assert.match(disabledReason(settingDefinition('buildPixelDetail'), { ...flat, directTerrain: true }), /terrain-only/);
  assert.match(disabledReason(settingDefinition('rangeView'), { ...flat, rangeRenderer: 'v2', rangeTour: 'tetons' }), /Teton/);
  assert.match(disabledReason(settingDefinition('performance'), { ...flat, rangeRenderer: 'v2', rangeView: 'x' }), /forced view/);
});

test('no two settings disable each other (a user could change neither)', () => {
  const byId = new Map(SETTINGS.map(d => [d.id, d]));
  for (const def of SETTINGS) for (const req of def.requires) {
    const other = byId.get(req.id);
    for (const back of other?.requires || []) {
      if (back.id !== def.id) continue;
      // def is disabled when other has value X; other is disabled when def
      // has value Y. A deadlock needs a reachable pair where both hold.
      const otherValues = other.options ? other.options.map(o => o.value) : other.type === 'boolean' ? [true, false] : [other.default, '__other__'];
      const defValues = def.options ? def.options.map(o => o.value) : def.type === 'boolean' ? [true, false] : [def.default, '__other__'];
      const blocks = (r, v) => ('is' in r ? v !== r.is : v === r.not);
      for (const ov of otherValues) for (const dv of defValues) {
        assert.ok(!(blocks(req, ov) && blocks(back, dv)), `${def.id}=${dv} and ${other.id}=${ov} disable each other`);
      }
    }
  }
});

test('store: a change persists by policy, drops the URL override it supersedes and notifies', () => {
  const storage = memoryStorage();
  const history = memoryHistory('https://example.test/?rangePace=2&rangeTour=off');
  const store = new SettingsStore({ search: '?rangePace=2&rangeTour=off', storage, history });
  const seen = [];
  store.subscribe(({ changes }) => seen.push(...changes.map(c => c.id)));
  assert.equal(store.get('rangePace'), 2);
  assert.equal(store.entry('rangePace').source, 'url');
  assert.deepEqual(storage.writes, [], 'URL overrides are never saved implicitly');
  assert.equal(store.set('rangePace', 4).ok, true);
  assert.equal(storage.getItem('range-pace'), '4');
  assert.equal(new URL(history.href()).searchParams.has('rangePace'), false);
  assert.equal(new URL(history.href()).searchParams.get('rangeTour'), 'off', 'other overrides are kept');
  assert.deepEqual(seen, ['rangePace']);
  assert.equal(store.set('rangePace', 'fast').ok, false);
  assert.equal(store.get('rangePace'), 4);
});

test('store: URL-policy settings live in the address bar, not storage', () => {
  const storage = memoryStorage();
  const history = memoryHistory('https://example.test/');
  const store = new SettingsStore({ storage, history });
  store.set('rangeDebug', 'slope');
  assert.equal(new URL(history.href()).searchParams.get('rangeDebug'), 'slope');
  assert.deepEqual(storage.writes, []);
  store.set('rangeDebug', 'off');
  assert.equal(new URL(history.href()).searchParams.has('rangeDebug'), false);
});

test('store: coupled settings change together in one notification', () => {
  const storage = memoryStorage();
  const store = new SettingsStore({ storage });
  const batches = [];
  store.subscribe(({ changes }) => batches.push(changes.map(c => c.id)));
  store.set('pixelGrid', 'classic');
  assert.deepEqual(batches, [['pixelGrid', 'buildPixelDetail']]);
  assert.equal(JSON.parse(storage.getItem('midio-pixel:display:v1')).buildPixelDetail, false);
});

test('store: save URL overrides, reset one, reset all', () => {
  const storage = memoryStorage();
  const history = memoryHistory('https://example.test/?fpsCap=30&rangeDebug=sun');
  const store = new SettingsStore({ search: '?fpsCap=30&rangeDebug=sun', storage, history });
  assert.deepEqual(store.saveUrlOverrides(), ['fpsCap'], 'temporary diagnostics are not saved');
  assert.equal(storage.getItem('smw:stageFps'), '30');
  assert.equal(new URL(history.href()).search, '?rangeDebug=sun');
  store.set('landDance', 0.4);
  store.reset('landDance');
  assert.equal(store.get('landDance'), 1);
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).landDance, undefined);
  store.resetAll();
  assert.equal(store.get('fpsCap'), 60);
  assert.equal(store.get('rangeDebug'), 'off');
  assert.equal(new URL(history.href()).search, '');
});

test('store: guards refuse a change without saving it', () => {
  const storage = memoryStorage();
  const store = new SettingsStore({ storage });
  store.addGuard(id => (id === 'pixelGrid' ? 'busy' : null));
  assert.deepEqual(store.set('pixelGrid', 'classic'), { ok: false, changed: false, reason: 'busy' });
  assert.deepEqual(storage.writes, []);
});

test('lifecycle: changes that cannot apply now are pending until applied', () => {
  let playing = true;
  const store = new SettingsStore({ storage: memoryStorage() });
  store.setContext({ playing: () => playing });
  store.set('fpsCap', 30);
  store.set('rangeMsaa', '2');
  store.set('songRange', 'on');
  store.set('voxelRange', true);
  assert.deepEqual([...store.pending.keys()].sort(), ['rangeMsaa', 'songRange', 'voxelRange']);
  store.markApplied(['renderer']);
  assert.deepEqual([...store.pending.keys()].sort(), ['songRange', 'voxelRange']);
  store.set('voxelRange', false);
  assert.ok(!store.pending.has('voxelRange'), 'back to the loaded value: no reload needed');
  playing = false;
  store.set('terrainShading', 'moran');
  assert.ok(!store.pending.has('terrainShading'), 'on the title screen it simply applies next');
  assert.match(explainSetting('songRange', store).pending, /Next song/);
});

test('share links carry only non-default settings and no automation contracts', () => {
  const href = shareUrl('https://example.test/app/?foo=1#x', { pixelGrid: 'classic', rangePace: 3, fps: true, landDance: 0.5, bulkExport: true, exportW: 640, rangeView: null });
  const url = new URL(href);
  assert.equal(url.pathname, '/app/');
  assert.deepEqual([...url.searchParams], [['pixelGrid', 'classic'], ['landDance', '0.5'], ['fps', '1']]);
  const store = new SettingsStore({ search: '?rangeTour=off&rangeTourGate=off&songRange=1' });
  assert.equal(new URL(store.shareUrl('https://example.test/')).search, '?rangeTour=off&rangeTourGate=off&songRange=1');
  // A share link round-trips to the same values.
  const again = resolveSettings({ search: new URL(store.shareUrl('https://example.test/')).search }).entries;
  for (const id of ['rangeTour', 'rangeTourGate', 'songRange']) assert.equal(again[id].value, store.get(id));
});

test('describe() explains requested and effective values without private data', () => {
  const store = new SettingsStore({ search: '?rangeMsaa=9&style=classic&rangeRenderer=legacy&rangeView=teton-jackson-lake' });
  const d = store.describe();
  const msaa = d.settings.find(s => s.id === 'rangeMsaa');
  assert.equal(msaa.requested, '9');
  assert.match(msaa.rejected.reason, /0, 2 or 4/);
  assert.match(d.settings.find(s => s.id === 'rangeView').disabled, /3D landscape renderer/);
  assert.equal(d.retiredParams[0].param, 'style');
  assert.doesNotMatch(JSON.stringify(d), /token|password|plex|soulseek/i);
});

test('settingValue: an explicit search alone decides; otherwise the page store', () => {
  configureSettings({ search: '?landDance=0.3', storage: memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ perf: 'lite' }) }) });
  try {
    assert.equal(settingValue('landDance'), 0.3);
    assert.equal(settingValue('perf'), 'lite');
    assert.equal(settingValue('perf', ''), 'auto', 'explicit input ignores storage, as the old parsers did');
  } finally { configureSettings({}); }
});

test('parseUrlValue reports a reason for every rejection', () => {
  for (const def of SETTINGS) {
    const r = parseUrlValue(def, '\u0000nonsense');
    if (!r.ok) assert.ok(r.reason, def.id);
  }
});

test('terrain debug options match the renderer\'s modes', () => {
  const scene = fs.readFileSync(new URL('../src/world/alpine/RangeScene.js', import.meta.url), 'utf8');
  const modes = Object.keys(Function(`return ${scene.match(/TERRAIN_DEBUG_MODES = Object\.freeze\((\{[^}]+\})\)/)[1]}`)());
  assert.deepEqual(settingDefinition('rangeDebug').options.map(o => o.value).filter(v => v !== 'off'), modes);
});

test('docs/url-parameters.md is generated from the registry and current', () => {
  assert.equal(fs.readFileSync(REFERENCE_PATH, 'utf8'), renderReference(), 'run: node tools/settings-reference.mjs');
});

test('runtime modules read settings through the registry, not the query string', () => {
  // A new setting belongs in the registry (AGENTS.md); application code
  // under src/ (outside dev review pages and the history shell) no longer
  // parses location.search itself.
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!['dev', 'vendor'].includes(entry.name)) walk(path); continue; }
      if (!/\.m?js$/.test(entry.name) || path.endsWith('HistoryPicker.js') || path.endsWith('appSettings.js')) continue;
      const text = fs.readFileSync(path, 'utf8');
      if (/location\??\.search/.test(text)) offenders.push(path);
    }
  };
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  assert.deepEqual(offenders, []);
});
