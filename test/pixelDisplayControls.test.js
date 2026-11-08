// Execute the production control binding with a real presentation owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_DISPLAY_PREFS, resolvePresentation, writeDisplayPrefs, defaultGridFor } from '../src/render/DisplayProfile.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
// The shared applyDisplayPref (Display menu and keyboard detail) and the
// boot block that binds each control to it.
const start = main.indexOf('function applyDisplayPref(');
const binding = main.slice(start, main.indexOf('  syncDisplayControls();\n  if (stageFpsEl)', start)) + '}';
for (const paused of [true, false]) test(`grid controls preserve song time and ${paused ? 'redraw a paused completed frame' : 'invalidate until the next live frame'}`, () => {
  const ctx = { imageSmoothingEnabled: true }, canvas = { width: 320, height: 180, getContext: () => ctx };
  const prefs = { ...DEFAULT_DISPLAY_PREFS, look: 'pixel' };
  const renderer = createPresentingRenderer({ canvas, presentation: resolvePresentation(prefs), residency: new GraphicsResidency(),
    rendererFactory: () => ({ draw() {}, dispose() {} }) });
  const sim = { timeMs: 4500 };
  renderer.draw(sim, 1);
  let handler, recorded = 0;
  const control = { value: 'classic', addEventListener(name, fn) { handler = fn; } };
  const context = vm.createContext({ displayControls: { pixelGrid: control }, displayPrefs: prefs, presentation: resolvePresentation(prefs),
    writeDisplayPrefs, displayStorage: () => null, resolvePresentation, syncDisplayControls() {}, perfGovernor: null,
    paused, sim, renderer, bulkExportArmed: false, console, snapshotBusy: false,
    songRecorder: { recording: true, captureFrame() { assert.ok(renderer.getCaptureSource()); recorded++; } },
    playbackPreparing: false,
    fitCanvas() { renderer.setPresentation(context.presentation); canvas.width = context.presentation.grid.width; canvas.height = context.presentation.grid.height; },
  });
  vm.runInContext(binding, context);
  control.value = 'detailed'; handler();
  assert.equal(context.displayPrefs.buildPixelDetail, false, 'choosing a preset stops automatic growth');
  assert.equal(sim.timeMs, 4500);
  if (paused) { assert.equal(renderer.getCaptureSource()?.width, 640); assert.equal(recorded, 1); }
  else { assert.equal(renderer.getCaptureSource(), null); assert.equal(recorded, 0); renderer.draw(sim, 1); assert.equal(renderer.getCaptureSource().width, 640); }
  renderer.dispose();
});

test('choosing Cinematic takes its detail level, and leaving it returns to the next look\'s own', () => {
  const handlers = {};
  const control = key => ({ value: '', addEventListener(name, fn) { handlers[key] = fn; } });
  const controls = { look: control('look'), pixelGrid: control('pixelGrid') };
  const prefs = { ...DEFAULT_DISPLAY_PREFS, look: 'pixel' };
  const context = vm.createContext({ displayControls: controls, displayPrefs: prefs, presentation: resolvePresentation(prefs),
    writeDisplayPrefs() {}, displayStorage: () => null, resolvePresentation, defaultGridFor, syncDisplayControls() {}, perfGovernor: null,
    paused: true, sim: null, renderer: null, bulkExportArmed: false, console, songRecorder: null, playbackPreparing: false,
    fitCanvas() {}, snapshotBusy: false });
  vm.runInContext(binding, context);
  const set = (key, value) => { controls[key].value = value; handlers[key](); };
  set('look', 'cinematic');
  assert.equal(context.displayPrefs.pixelGrid, 'detailed');
  assert.equal(context.presentation.grid.id, 'detailed');
  set('look', 'pixel');
  assert.equal(context.displayPrefs.pixelGrid, 'classic', 'back to Pixel\'s own');
  set('look', 'cinematic'); set('pixelGrid', 'medium'); set('look', 'palette');
  assert.equal(context.displayPrefs.pixelGrid, 'medium', 'a level chosen meanwhile stays');
});

test('a Display change during a snapshot is ignored, never saved over the player\'s level', () => {
  let handler, writes = 0;
  const control = { value: 'classic', addEventListener(name, fn) { handler = fn; } };
  const prefs = { ...DEFAULT_DISPLAY_PREFS, look: 'pixel' };
  const context = vm.createContext({ displayControls: { pixelGrid: control }, displayPrefs: prefs, presentation: resolvePresentation(prefs),
    writeDisplayPrefs() { writes++; }, displayStorage: () => null, resolvePresentation, syncDisplayControls() {}, perfGovernor: null,
    paused: true, sim: null, renderer: null, bulkExportArmed: false, console, songRecorder: null, playbackPreparing: false,
    fitCanvas() {}, snapshotBusy: true });
  vm.runInContext(binding, context);
  control.value = 'detailed'; handler();
  assert.equal(writes, 0);
  assert.equal(context.displayPrefs.pixelGrid, prefs.pixelGrid);
});

test('the detail-build checkbox saves a boolean and preserves the manual preset', () => {
  let handler;
  const control = { checked: false, value: 'on', addEventListener(_name, fn) { handler = fn; } };
  const prefs = { ...DEFAULT_DISPLAY_PREFS, pixelGrid: 'medium', buildPixelDetail: false };
  const context = vm.createContext({ displayControls: { buildPixelDetail: control }, displayPrefs: prefs, presentation: resolvePresentation(prefs),
    writeDisplayPrefs() {}, displayStorage: () => null, resolvePresentation, syncDisplayControls() {}, perfGovernor: null,
    paused: true, sim: null, renderer: null, bulkExportArmed: false, console, songRecorder: null, playbackPreparing: false,
    fitCanvas() {}, snapshotBusy: false });
  vm.runInContext(binding, context);
  assert.equal(control.checked, false);
  control.checked = true; handler();
  assert.equal(context.displayPrefs.buildPixelDetail, true);
  assert.equal(context.displayPrefs.pixelGrid, 'medium');
  control.checked = false; handler();
  assert.equal(context.displayPrefs.buildPixelDetail, false);
});

test('Trio disables pixel-only controls and restores the saved Landscape choices', () => {
  const controls = Object.fromEntries(['look', 'quality', 'palette', 'dither', 'ditherMode', 'pixelGrid', 'scaling', 'buildPixelDetail'].map(key => [key, { value: '', querySelector: () => ({ textContent: 'Medium — 480 × 270' }) }]));
  const hint = {}, label = {}, snapshot = { setAttribute() {} };
  const context = vm.createContext({ displayControls: controls,
    displayPrefs: { ...DEFAULT_DISPLAY_PREFS, pixelGrid: 'medium', buildPixelDetail: false },
    presentation: resolvePresentation({ ...DEFAULT_DISPLAY_PREFS, pixelGrid: 'medium' }), experience: 'trio',
    document: { getElementById: id => id === 'pixelGridHint' ? hint : null },
    detailLevelEl: label, snapshotBtnEl: snapshot, snapshotBusy: false,
    navigator: { userAgent: 'Desktop' },
  });
  for (const name of ['syncDisplayControls', 'syncDetailControls']) {
    const begin = main.indexOf(`function ${name}()`);
    vm.runInContext(main.slice(begin, main.indexOf('\n}\n', begin) + 3), context);
  }
  context.syncDisplayControls();
  for (const [key, control] of Object.entries(controls)) assert.equal(control.disabled, key !== 'quality', key);
  assert.equal(label.textContent, 'Smooth');
  assert.match(hint.textContent, /[Ss]mooth/);
  assert.equal(controls.pixelGrid.value, 'medium');
  assert.equal(snapshot.title, 'Save the current frame as a PNG');
  context.experience = 'landscape';
  context.syncDisplayControls();
  assert.equal(controls.pixelGrid.disabled, false);
  assert.equal(controls.look.disabled, false);
  assert.equal(controls.pixelGrid.value, 'medium');
  assert.equal(label.textContent, 'Medium');
  assert.match(snapshot.title, /5 pixel detail levels/);
});
