// Execute the production display appliers with a real settings store and a
// real presentation owner: a change made in the settings panel (or by the
// detail keys) goes store.set -> applySettingChange -> applyDisplayPref.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_DISPLAY_PREFS, resolvePresentation } from '../src/render/DisplayProfile.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { SettingsStore } from '../src/config/appSettings.js';
import { CAMERA_STUDIO_SETTING_IDS } from '../src/config/settingsRegistry.js';
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

const slice = (from, to = '\n}\n') => {
  const start = main.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  return main.slice(start, main.indexOf(to, start) + to.length);
};
// applyDisplayPref, the settings appliers and the blocked-reason guard.
const binding = [
  slice('function applyDisplayPref('),
  slice('let landscapeRendererDirty = false;', '\nfunction applySettingChange('),
  slice('function applySettingChange('),
  slice('function settingBlockedReason('),
].join('\n').replace('\nfunction applySettingChange(\n', '\n');

function memoryStorage() {
  const map = new Map();
  return { writes: 0, getItem: k => (map.has(k) ? map.get(k) : null), setItem(k, v) { this.writes++; map.set(k, String(v)); }, removeItem: k => map.delete(k) };
}

function wire(context, storage) {
  context.CAMERA_STUDIO_SETTING_IDS = CAMERA_STUDIO_SETTING_IDS;
  vm.runInContext(binding, context);
  const store = new SettingsStore({ storage });
  store.addGuard(id => context.settingBlockedReason(id));
  store.subscribe(context.applySettingChange);
  context.settings = store;
  return store;
}

for (const paused of [true, false]) test(`grid changes preserve song time and ${paused ? 'redraw a paused completed frame' : 'invalidate until the next live frame'}`, () => {
  const ctx = { imageSmoothingEnabled: true }, canvas = { width: 320, height: 180, getContext: () => ctx };
  const prefs = { ...DEFAULT_DISPLAY_PREFS, pixelGrid: 'classic' };
  const renderer = createPresentingRenderer({ canvas, presentation: resolvePresentation(prefs), residency: new GraphicsResidency(),
    rendererFactory: () => ({ draw() {}, dispose() {} }) });
  const sim = { timeMs: 4500 };
  renderer.draw(sim, 1);
  let recorded = 0;
  const storage = memoryStorage();
  storage.setItem('midio-pixel:display:v1', JSON.stringify(prefs));
  const context = vm.createContext({ displayPrefs: prefs, presentation: resolvePresentation(prefs),
    resolvePresentation, syncDisplayControls() {}, perfGovernor: null, running: true,
    paused, sim, renderer, bulkExportArmed: false, console, snapshotBusy: false, reelSaver: { busy: false },
    songRecorder: { recording: true, captureFrame() { assert.ok(renderer.getCaptureSource()); recorded++; } },
    playbackPreparing: false,
    fitCanvas() { renderer.setPresentation(context.presentation); canvas.width = context.presentation.grid.width; canvas.height = context.presentation.grid.height; },
  });
  const store = wire(context, storage);
  assert.equal(renderer.getCaptureSource()?.width, 320);
  assert.equal(store.set('pixelGrid', 'detailed').ok, true);
  assert.equal(context.displayPrefs.buildPixelDetail, false, 'choosing a preset stops automatic growth');
  assert.equal(store.get('buildPixelDetail'), false, 'the coupled setting is saved with it');
  assert.equal(JSON.parse(storage.getItem('midio-pixel:display:v1')).pixelGrid, 'detailed');
  assert.equal(context.presentation.grid.id, 'detailed');
  assert.equal(sim.timeMs, 4500);
  if (paused) { assert.equal(renderer.getCaptureSource()?.width, 640); assert.equal(recorded, 1); }
  else { assert.equal(renderer.getCaptureSource(), null); assert.equal(recorded, 0); renderer.draw(sim, 1); assert.equal(renderer.getCaptureSource().width, 640); }
  renderer.dispose();
});

test('a display change during a snapshot is refused, never saved over the player\'s level', () => {
  const prefs = { ...DEFAULT_DISPLAY_PREFS, pixelGrid: 'classic' };
  const storage = memoryStorage();
  const context = vm.createContext({ displayPrefs: prefs, presentation: resolvePresentation(prefs),
    resolvePresentation, syncDisplayControls() {}, perfGovernor: null, running: true,
    paused: true, sim: null, renderer: null, bulkExportArmed: false, console, songRecorder: null, playbackPreparing: false,
    fitCanvas() {}, snapshotBusy: true, reelSaver: { busy: false } });
  const store = wire(context, storage);
  const result = store.set('pixelGrid', 'detailed');
  assert.equal(result.ok, false);
  assert.match(result.reason, /snapshot/i);
  assert.equal(storage.writes, 0);
  assert.equal(context.displayPrefs.pixelGrid, prefs.pixelGrid);
});

test('the detail-build checkbox saves a boolean and preserves the manual preset', () => {
  const prefs = { ...DEFAULT_DISPLAY_PREFS, pixelGrid: 'medium', buildPixelDetail: false };
  const storage = memoryStorage();
  storage.setItem('midio-pixel:display:v1', JSON.stringify(prefs));
  const context = vm.createContext({ displayPrefs: prefs, presentation: resolvePresentation(prefs),
    resolvePresentation, syncDisplayControls() {}, perfGovernor: null, running: true,
    paused: true, sim: null, renderer: null, bulkExportArmed: false, console, songRecorder: null, playbackPreparing: false,
    fitCanvas() {}, snapshotBusy: false, reelSaver: { busy: false } });
  const store = wire(context, storage);
  assert.equal(store.get('buildPixelDetail'), false);
  store.set('buildPixelDetail', true);
  assert.equal(context.displayPrefs.buildPixelDetail, true);
  assert.equal(context.displayPrefs.pixelGrid, 'medium');
  assert.equal(JSON.parse(storage.getItem('midio-pixel:display:v1')).buildPixelDetail, true);
  store.set('buildPixelDetail', false);
  assert.equal(context.displayPrefs.buildPixelDetail, false);
});
