// Execute the production control binding with a real presentation owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_DISPLAY_PREFS, resolvePresentation, writeDisplayPrefs } from '../src/render/DisplayProfile.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('// Stored display preferences on boot.');
const binding = main.slice(start, main.indexOf('  syncDisplayControls();\n  if (stageResEl)', start)) + '}';
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
    paused, sim, renderer, bulkExportArmed: false, console,
    songRecorder: { recording: true, captureFrame() { assert.ok(renderer.getCaptureSource()); recorded++; } },
    fitCanvas() { renderer.setPresentation(context.presentation); canvas.width = context.presentation.grid.width; canvas.height = context.presentation.grid.height; },
  });
  vm.runInContext(binding, context);
  control.value = 'detailed'; handler();
  assert.equal(sim.timeMs, 4500);
  if (paused) { assert.equal(renderer.getCaptureSource()?.width, 640); assert.equal(recorded, 1); }
  else { assert.equal(renderer.getCaptureSource(), null); assert.equal(recorded, 0); renderer.draw(sim, 1); assert.equal(renderer.getCaptureSource().width, 640); }
  renderer.dispose();
});
