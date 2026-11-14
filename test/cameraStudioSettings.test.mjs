import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SETTINGS, settingDefinition, resolveSettings, normalizeValue, CAMERA_STUDIO_SETTING_IDS } from '../src/config/settingsRegistry.js';
import { SettingsStore, cameraStudioPreferences } from '../src/config/appSettings.js';
import { CAMERA_STUDIO_DEFAULTS, normalizeCameraStudioSettings } from '../src/world/alpine/CameraStudio.js';

const cameraId = key => `cameraStudio${key[0].toUpperCase()}${key.slice(1)}`;
const cameraIds = Object.keys(CAMERA_STUDIO_DEFAULTS).map(cameraId);
const mp4Ids = ['mp4Resolution', 'mp4Fps'];
const memoryStorage = initial => {
  const data = new Map(Object.entries(initial || {}));
  return { data, writes: [], getItem: key => data.get(key) ?? null,
    setItem(key, value) { this.writes.push(key); data.set(key, String(value)); }, removeItem: key => data.delete(key) };
};
const cameraValues = store => Object.fromEntries(Object.keys(CAMERA_STUDIO_DEFAULTS).map(key => [key, store.get(cameraId(key))]));

// Removing any field from the registry must break migration/reset/share coverage.
test('all Camera Studio and MP4 preferences have saved, live registry definitions', () => {
  for (const id of [...cameraIds, ...mp4Ids]) {
    const def = SETTINGS.find(item => item.id === id);
    assert.ok(def, `${id} is registered`);
    assert.equal(def.persist, 'saved'); assert.equal(def.lifecycle, 'live');
    assert.notEqual(def.ui, false); assert.notEqual(def.share, false);
    assert.ok(def.storage?.read && def.storage?.write && def.storage?.clear);
  }
  assert.equal(normalizeValue(settingDefinition('cameraStudioDistance'), 100), 1.8);
  assert.equal(normalizeValue(settingDefinition('cameraStudioDirection'), 'north'), undefined);
  assert.equal(normalizeValue(settingDefinition('mp4Resolution'), 'invalid'), undefined);
  assert.equal(normalizeValue(settingDefinition('mp4Fps'), 24), undefined);
});

test('legacy studio and MP4 records migrate with per-field validation and URL precedence', () => {
  const storage = memoryStorage({
    'midio.cameraStudio.v1': JSON.stringify({ enabled: true, preset: 'orbit', distance: 9, direction: 'ccw', focusY: .12, fovDeg: 'bad', surprise: 4 }),
    'midio.mp4Export.v1': JSON.stringify({ resolutionId: '4k', fps: '60', width: 2 }),
  });
  const store = new SettingsStore({ storage, search: '?cameraStudioDistance=0.6&mp4Fps=30' });
  assert.equal(store.get('cameraStudioEnabled'), true);
  assert.equal(store.get('cameraStudioPreset'), 'orbit');
  assert.equal(store.get('cameraStudioDistance'), .6);
  assert.equal(store.entry('cameraStudioDistance').source, 'url');
  assert.equal(store.get('cameraStudioFocusY'), .12);
  assert.equal(store.get('cameraStudioFovDeg'), 35);
  assert.equal(store.get('mp4Resolution'), '2160p');
  assert.equal(store.get('mp4Fps'), 30);
  assert.deepEqual(storage.writes, [], 'loading or visiting a share link never saves URL values');
});

test('reset all clears legacy preferences, resets live consumers, and stays reset on reload', () => {
  const storage = memoryStorage({
    'midio.cameraStudio.v1': JSON.stringify({ enabled: true, preset: 'orbit', distance: .6, holdSec: 4 }),
    'midio.mp4Export.v1': JSON.stringify({ resolutionId: '2160p', fps: 60 }),
  });
  const store = new SettingsStore({ storage });
  let liveCamera = cameraValues(store), liveMp4 = { resolution: store.get('mp4Resolution'), fps: store.get('mp4Fps') };
  store.subscribe(() => { liveCamera = cameraValues(store); liveMp4 = { resolution: store.get('mp4Resolution'), fps: store.get('mp4Fps') }; });
  store.resetAll();
  assert.deepEqual(liveCamera, CAMERA_STUDIO_DEFAULTS);
  assert.deepEqual(liveMp4, { resolution: '1080p', fps: 30 });
  const again = new SettingsStore({ storage });
  assert.deepEqual(cameraValues(again), CAMERA_STUDIO_DEFAULTS);
  for (const id of [...cameraIds, ...mp4Ids]) assert.equal(again.entry(id).source, 'default', id);
});

test('camera composition and MP4 preferences survive a share-link round trip', () => {
  const store = new SettingsStore({ storage: memoryStorage() });
  const input = normalizeCameraStudioSettings({ enabled: true, preset: 'orbit', distance: .72, elevation: 12,
    azimuthDeg: -72, direction: 'ccw', orbitSeconds: 66, focusX: .1, focusY: -.04, focusZ: .16,
    fovDeg: 26, durationSec: 4.5, holdSec: 1.5, delaySec: 2.5, overshoot: .21 });
  for (const [key, value] of Object.entries(input)) assert.equal(store.set(cameraId(key), value).ok, true);
  store.set('mp4Resolution', '1440p'); store.set('mp4Fps', 60);
  const url = new URL(store.shareUrl('https://example.test/'));
  const again = resolveSettings({ search: url.search }).entries;
  for (const id of [...cameraIds, ...mp4Ids]) assert.equal(again[id].value, store.get(id), id);
});

test('malformed and denied preference storage fall back without blocking session changes', () => {
  for (const storage of [memoryStorage({ 'midio.cameraStudio.v1': '{bad', 'midio.mp4Export.v1': '[]' }),
    { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('denied'); } }]) {
    const store = new SettingsStore({ storage });
    assert.deepEqual(cameraValues(store), CAMERA_STUDIO_DEFAULTS);
    assert.equal(store.get('mp4Resolution'), '1080p');
    assert.equal(store.set('cameraStudioEnabled', true).ok, true);
    assert.equal(store.set('mp4Fps', 60).ok, true);
    assert.doesNotThrow(() => store.resetAll());
    assert.equal(store.get('cameraStudioEnabled'), false);
    assert.equal(store.get('mp4Fps'), 30);
  }
});

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
test('MP4 dialog reads URL/store values and reset live, without saving them on open', () => {
  const store = new SettingsStore({ search: '?mp4Resolution=1440p&mp4Fps=60', storage: memoryStorage() });
  const start = main.indexOf('function videoOutputSettings() {');
  const end = main.indexOf('\nfunction syncVideoExportState', start);
  const summary = {};
  const context = vm.createContext({ settings: store, videoResolution: {}, videoFps: {},
    resolveMp4ExportSettings: value => ({ ...value, width: 2560, height: 1440 }),
    lastAudioBuffer: null, lastTimelineData: null, videoStart: {}, videoExportSession: { busy: false },
    document: { getElementById: () => summary }, formatDuration: String, formatBytes: String, estimateMp4ExportBytes: () => 0,
  });
  vm.runInContext(main.slice(start, end), context);
  context.syncVideoOutputSettings();
  assert.equal(context.videoResolution.value, '1440p'); assert.equal(context.videoFps.value, '60');
  assert.equal(context.videoOutputSettings().fps, 60);
  assert.deepEqual(store.storage.writes, []);
  store.resetAll(); context.syncVideoOutputSettings();
  assert.equal(context.videoResolution.value, '1080p'); assert.equal(context.videoFps.value, '30');
});


test('store camera changes and reset update the running simulation and mounted controls', () => {
  const start = main.indexOf('let landscapeRendererDirty = false;');
  assert.ok(start >= 0, 'a store applier owns the live composition');
  const applierStart = main.indexOf('function applySettingChange(', start);
  const end = main.indexOf('\n}\n', applierStart) + 3;
  const store = new SettingsStore({ storage: memoryStorage() });
  let panelSettings, redraws = 0;
  const context = vm.createContext({ settings: store, cameraStudioPreferences, normalizeCameraStudioSettings, CAMERA_STUDIO_SETTING_IDS, console,
    cameraStudioSettings: CAMERA_STUDIO_DEFAULTS, sim: {},
    cameraStudioPanel: { setSettings(value) { panelSettings = value; } },
    syncCameraStudio() {}, paused: true, renderer: {}, redrawPausedCameraStudio() { redraws++; },
  });
  vm.runInContext(main.slice(start, end), context);
  store.subscribe(context.applySettingChange);
  store.set('cameraStudioEnabled', true); store.set('cameraStudioDistance', .65);
  assert.equal(context.sim.cameraStudioSettings.enabled, true);
  assert.strictEqual(normalizeCameraStudioSettings(context.sim.cameraStudioSettings), context.sim.cameraStudioSettings, 'live snapshots are normalized once before frame-loop sampling');
  assert.equal(panelSettings.distance, .65);
  store.resetAll();
  assert.deepEqual(context.sim.cameraStudioSettings, CAMERA_STUDIO_DEFAULTS);
  assert.deepEqual(panelSettings, CAMERA_STUDIO_DEFAULTS);
  assert.ok(redraws >= 3, 'paused camera preview redraws on store changes and reset');
});

test('capture guards refuse individual and full resets without erasing prefs, URLs or sources', () => {
  const storage = memoryStorage({
    'midio.cameraStudio.v1': JSON.stringify({ enabled: true, preset: 'orbit', distance: .6 }),
    'midio.mp4Export.v1': JSON.stringify({ resolutionId: '2160p', fps: 60 }),
  });
  let href = 'https://example.test/?cameraStudioDistance=0.7&mp4Fps=60';
  const store = new SettingsStore({ storage, search: new URL(href).search,
    history: { href: () => href, replace: value => { href = value; } } });
  const before = { records: Object.fromEntries(storage.data), href, description: store.describe() };
  let locked = true, notifications = 0;
  store.subscribe(() => { notifications++; });
  store.addGuard(id => locked && (id === 'cameraStudioDistance' || id === 'mp4Fps') ? 'capture is active' : null);
  const one = store.reset('cameraStudioDistance');
  assert.equal(one.ok, false); assert.equal(one.reason, 'capture is active');
  assert.deepEqual({ records: Object.fromEntries(storage.data), href, description: store.describe() }, before);
  const all = store.resetAll();
  assert.equal(all.ok, false); assert.equal(all.reason, 'capture is active');
  assert.deepEqual({ records: Object.fromEntries(storage.data), href, description: store.describe() }, before);
  assert.equal(notifications, 0, 'a rejected reset never partially applies');
  locked = false;
  assert.equal(store.resetAll().ok, true);
  assert.deepEqual(cameraValues(store), CAMERA_STUDIO_DEFAULTS);
  assert.equal(store.get('mp4Fps'), 30);
  assert.equal(new URL(href).search, '');
  const again = new SettingsStore({ storage });
  assert.deepEqual(cameraValues(again), CAMERA_STUDIO_DEFAULTS);
  assert.equal(again.get('mp4Resolution'), '1080p');
});

test('saving camera and MP4 URL overrides respects capture guards, then saves after unlock', () => {
  const storage = memoryStorage({
    'midio.cameraStudio.v1': JSON.stringify({ enabled: false }),
    'midio.mp4Export.v1': JSON.stringify({ fps: 30 }),
  });
  let href = 'https://example.test/?cameraStudioEnabled=1&mp4Fps=60';
  const store = new SettingsStore({ storage, search: new URL(href).search,
    history: { href: () => href, replace: value => { href = value; } } });
  const before = { records: Object.fromEntries(storage.data), href, description: store.describe() };
  let locked = true;
  store.addGuard(() => locked ? 'capture is active' : null);
  assert.deepEqual(store.saveUrlOverrides(), []);
  assert.deepEqual({ records: Object.fromEntries(storage.data), href, description: store.describe() }, before);
  locked = false;
  assert.deepEqual(store.saveUrlOverrides(), ['cameraStudioEnabled', 'mp4Fps']);
  assert.equal(new URL(href).search, '');
  assert.equal(store.entry('cameraStudioEnabled').source, 'saved');
  const again = new SettingsStore({ storage });
  assert.equal(again.get('cameraStudioEnabled'), true);
  assert.equal(again.get('mp4Fps'), 60);
});

test('a failed preference write retains the URL override and its source for recovery', () => {
  let href = 'https://example.test/?cameraStudioEnabled=1&mp4Fps=60';
  const storage = { getItem() { return null; }, setItem() { throw Error('quota'); } };
  const store = new SettingsStore({ storage, search: new URL(href).search,
    history: { href: () => href, replace: value => { href = value; } } });
  const before = href;
  assert.deepEqual(store.saveUrlOverrides(), []);
  assert.equal(href, before);
  assert.equal(store.entry('cameraStudioEnabled').source, 'url');
  assert.equal(store.entry('mp4Fps').source, 'url');
});

test('full reset clears rejected/default and valid camera/MP4 URL metadata', () => {
  for (const search of ['?mp4Fps=24&cameraStudioDistance=bad', '?mp4Fps=60&cameraStudioDistance=0.6']) {
    let href = `https://example.test/${search}`;
    const store = new SettingsStore({ search, history: { href: () => href, replace: value => { href = value; } } });
    assert.ok(store.entry('mp4Fps').requested);
    assert.equal(store.resetAll().ok, true);
    assert.equal(new URL(href).search, '');
    for (const id of ['mp4Fps', 'cameraStudioDistance']) {
      assert.equal(store.entry(id).source, 'default');
      assert.equal(store.entry(id).rejected, null);
      assert.equal(store.entry(id).requested, undefined);
    }
  }
});


test('Camera Studio navigation preserves enabled shared overrides and never mutates unavailable state', () => {
  const hooksStart = main.indexOf('function settingsPanelHooks() {');
  const hooksEnd = main.indexOf('\n}\n', hooksStart) + 3;
  const reasonStart = main.indexOf('function customControlUnavailableReason(target) {');
  const reasonEnd = reasonStart < 0 ? 0 : main.indexOf('\n}\n', reasonStart) + 3;
  for (const unavailable of ['none', 'title', 'preparing', 'painted', 'other-world', 'disabled']) {
    const storage = memoryStorage();
    let href = 'https://example.test/?cameraStudioEnabled=1&cameraStudioDistance=0.6';
    const store = new SettingsStore({ storage, search: new URL(href).search,
      history: { href: () => href, replace: value => { href = value; } } });
    if (unavailable === 'disabled') store.set('cameraStudioEnabled', false);
    const before = { writes: [...storage.writes], href, description: store.describe() };
    let closed = 0;
    const panel = { collapsed: true, setSettings() {}, element: { hidden: false, scrollIntoView() {} } };
    const context = vm.createContext({ settings: store, cameraStudioPanel: panel, cameraStudioSettings: cameraStudioPreferences(store),
      running: unavailable !== 'title', playbackPreparing: unavailable === 'preparing',
      rangePresentation: unavailable === 'painted' ? null : {}, sim: { biomes: { world: { kind: unavailable === 'other-world' ? 'ocean' : 'alpine' } } },
      settingBlockedReason: () => null, displayDialog: { open: true, close() { closed++; } },
    });
    vm.runInContext(((reasonStart < 0 ? '' : main.slice(reasonStart, reasonEnd)) + main.slice(hooksStart, hooksEnd))
      .replaceAll('import.meta.url', JSON.stringify(new URL('../src/main.js', import.meta.url).href)), context);
    const actions = context.settingsPanelHooks().actions;
    actions.openControl('cameraStudio');
    assert.deepEqual({ writes: [...storage.writes], href, description: store.describe() }, before, unavailable);
    if (unavailable === 'none') { assert.equal(closed, 1); assert.equal(panel.collapsed, false); }
    else { assert.equal(closed, 0, unavailable); assert.equal(panel.collapsed, true, unavailable); }
  }
});
