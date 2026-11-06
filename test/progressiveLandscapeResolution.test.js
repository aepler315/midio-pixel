import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelPresentation, fitPixelRect } from '../src/render/PixelPresentation.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { pixelGrid, pixelRenderPolicy, pixelUnit } from '../src/render/PixelRenderPolicy.js';
import { resolveDisplayPrefs, resolvePresentation } from '../src/render/DisplayProfile.js';
import { landscapeScoreFor } from '../src/world/alpine/LandscapeScore.js';
import { layoutPixelCaption } from '../src/ui/PixelCaption.js';
const policy = await import('../src/render/ProgressiveLandscapeResolution.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
function plan(options = {}) {
  assert.equal(typeof policy.landscapeResolutionPlan, 'function', 'a bounded resolution plan must exist');
  return policy.landscapeResolutionPlan({ width: 1920, height: 1080, ...options });
}
function surface(width = 1920, height = 1080) {
  const canvas = { width, height, allocations: 0 };
  const ctx = { canvas, setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {} };
  canvas.getContext = () => ctx;
  canvas.ownerDocument = { createElement() { canvas.allocations++; return surface(0, 0); } };
  return canvas;
}
const presentation = { pixelated: true, grid: pixelGrid(), paletteId: 'none', scaling: 'fit', rangePipeline: 'single', buildPixelDetail: true };

test('rise resolution starts at Classic and ends at a one-pixel fitted physical picture', () => {
  for (const options of [{}, { width: 800, height: 480, scaling: 'cover' }, { width: 1537, height: 900 }, { width: 3840, height: 2160 }]) {
    const p = plan(options), start = policy.landscapeResolutionAt(p, 0), end = policy.landscapeResolutionAt(p, 1);
    assert.deepEqual([start.grid.width, start.grid.height], [320, 180]);
    assert.equal(end.rung, 24);
    const fit = fitPixelRect(end.grid.width, end.grid.height, options.width || 1920, options.height || 1080, options.scaling || 'fit');
    assert.equal(fit.scale, 1);
    assert.ok(end.grid.width > 640);
  }
});

test('quiet construction is monotone, bounded and directly reproducible after seeking', () => {
  const p = plan(), manager = { durationMs: 90000, sections: [], energyCurves: { globalEnergyNorm: () => 0 } };
  const score = landscapeScoreFor(manager), seen = new Set();
  let previous = 0;
  for (let timeMs = 0; timeMs <= 90000; timeMs += 50) {
    const state = policy.landscapeResolutionAt(p, score.at(timeMs).rise01);
    assert.ok(state.grid.width >= previous); previous = state.grid.width;
    seen.add(state.grid);
  }
  assert.ok(seen.size > 15 && seen.size <= 25);
  const before = policy.landscapeResolutionAt(p, score.at(30000).rise01);
  policy.landscapeResolutionAt(p, 1);
  assert.equal(policy.landscapeResolutionAt(p, score.at(30000).rise01).grid, before.grid);
  for (const value of [NaN, Infinity, -Infinity, -1]) assert.equal(policy.landscapeResolutionAt(p, value).rung, 0);
  assert.equal(policy.landscapeResolutionAt(p, 2).rung, 24);
});

test('runtime grids keep caption scale continuous and cannot enter saved preferences', () => {
  const p = plan(), caption = { rows: [{ name: 'Mountain', label: 'Range' }], credit: 'USGS' };
  let previous = null;
  for (const grid of p.grids) {
    assert.equal(pixelRenderPolicy({ pixelated: true, grid }).grid, pixelGrid(), 'ordinary ingress remains canonical');
    assert.equal(pixelRenderPolicy({ pixelated: true, runtimeGrid: grid }).grid, grid);
    const layout = layoutPixelCaption(caption, { grid });
    assert.ok(Math.abs(pixelUnit(grid) / grid.width - 1 / 320) < 1e-12);
    const normalizedWidth = layout.bounds.width / grid.width;
    if (previous !== null) assert.ok(Math.abs(normalizedWidth - previous) < 1e-12);
    previous = normalizedWidth;
    assert.equal(resolveDisplayPrefs({ saved: { version: 2, look: 'pixel', pixelGrid: grid.id } }).pixelGrid, 'classic');
  }
  assert.equal(resolveDisplayPrefs().buildPixelDetail, true);
  assert.equal(resolvePresentation({ version: 2, look: 'pixel', buildPixelDetail: false }).buildPixelDetail, false);
});

test('an admitted rung reuses its canvas and denied growth retains the useful previous raster', () => {
  const p = plan(), canvas = surface(), residency = new GraphicsResidency({ budgetBytes: 2 * 320 * 180 * 4 });
  const output = new PixelPresentation({ canvas, presentation, residency });
  assert.equal(typeof output.setFrameGrid, 'function');
  output.setFrameGrid(p.grids[0]);
  const initial = output.beginFrame(); output.finishFrame();
  const capture = output.getCaptureSource(), before = residency.denials;
  for (let i = 0; i < 30; i++) {
    output.setFrameGrid(p.grids.at(-1));
    assert.equal(output.beginFrame(), initial);
    assert.equal(output.finishFrame().presented, true);
  }
  assert.ok(residency.denials - before <= 1, 'the same refused growth is not retried every frame');
  assert.equal(output.grid, p.grids[0]);
  assert.equal(output.diagnostics.frameGridReason, 'memory');
  assert.equal(canvas.allocations, 1);
  assert.notEqual(output.getCaptureSource(), capture);
  output.dispose(); assert.equal(residency.usedBytes, 0);
});

test('single-stage playback follows heard rise, shares transition detail and preserves fixed modes', () => {
  const canvas = surface(), range = { enabled: true }, manager = { world: { kind: 'alpine' }, durationMs: 90000,
    sections: [], tSec: 0, energyCurves: { globalEnergyNorm: () => .4 } };
  const seen = [];
  const inner = { rangePresentation: range, draw() { seen.push({ grid: this.pixelPolicy.grid, lod: range.detailHeightPx, single: range.singleStage }); }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 0, experience: 'landscape' };
  for (const timeMs of [0, 30000, 90000, 90000, 0]) {
    sim.heardTimeMs = timeMs;
    assert.equal(adapter.draw(sim, 0).presented, true);
  }
  assert.deepEqual(seen.map(s => s.grid.width), [320, seen[1].grid.width, 1920, 1920, 320]);
  assert.ok(seen[1].grid.width > 320 && seen[1].grid.width < 1920);
  assert.ok(seen.every(s => s.lod === 1080 && s.single));
  assert.equal(adapter.diagnostics.progressiveDetail.rise01, landscapeScoreFor(manager).at(0).rise01);
  assert.equal(adapter.diagnostics.progressiveDetail.requestedRung, 0);
  sim.heardTimeMs = 90000;
  for (const fixed of [{ ...presentation, buildPixelDetail: false }, { ...presentation, paletteId: 'rgb332' },
    { ...presentation, rangePipeline: 'native' }, { ...presentation, directTerrain: true, buildPixelDetail: false }]) {
    if (fixed.directTerrain) continue; // Its separate renderer has its own integration suite.
    adapter.setPresentation(fixed);
    adapter.draw(sim, 0);
    assert.equal(adapter.output.grid.width, 320);
    assert.equal(adapter.diagnostics.progressiveDetail.active, false);
  }
  adapter.setPresentation(presentation); sim.experience = 'trio'; adapter.draw(sim, 0);
  assert.equal(adapter.output.grid.width, 320);
  assert.equal(adapter.diagnostics.progressiveDetail.active, false);
  adapter.dispose();
});

test('a full budget can shrink and return to fixed detail without holding both rasters', () => {
  const p = plan(), grid = p.grids[12], canvas = surface(), residency = new GraphicsResidency({ budgetBytes: grid.pixels * 4 });
  const output = new PixelPresentation({ canvas, presentation, residency });
  output.setFrameGrid(grid); assert.ok(output.beginFrame()); output.finishFrame();
  assert.equal(output.setFrameGrid(p.grids[0]), true);
  assert.equal(output.beginFrame().width, 320); output.finishFrame();
  assert.equal(output.setFrameGrid(), true);
  assert.equal(output.grid, presentation.grid);
  assert.equal(output.beginFrame().width, 320);
  output.dispose(); assert.equal(residency.usedBytes, 0);
});

test('the growing plan survives quality resize and a refused scenic target returns to its last successful rung', () => {
  const canvas = surface(), range = { enabled: true }, manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [] };
  let refuse = false;
  const inner = { rangePresentation: range, draw() { manager._awaitingTerrain = refuse && this.pixelPolicy.grid.width > 320; range.resolutionRefused = manager._awaitingTerrain; range.reason = manager._awaitingTerrain ? 'budget: scene target' : null; }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 0, experience: 'landscape' };
  assert.equal(adapter.draw(sim, 0).presented, true);
  refuse = true; sim.heardTimeMs = 90000;
  assert.equal(adapter.draw(sim, 0).presented, false);
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.width, 320);
  assert.equal(adapter.diagnostics.progressiveDetail.reason, 'scene-memory');
  refuse = false; canvas.width = 960; canvas.height = 540;
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.deepEqual([adapter.output.grid.width, adapter.output.grid.height], [960, 540]);
  assert.equal(range.detailHeightPx, 540);
  adapter.dispose();
});

test('changing settings restores a fixed raster and Cinematic can use the same progressive grid', () => {
  const canvas = surface(), range = { enabled: true }, manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [] };
  const inner = { rangePresentation: range, draw() {}, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation: { ...presentation, cinematicPixel: true, rangePipeline: 'hybrid' }, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 90000, experience: 'landscape', perf: { level: 2 } };
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.width, 1920);
  assert.equal(adapter.diagnostics.progressiveDetail.active, true);
  adapter.setPresentation({ ...presentation, buildPixelDetail: false });
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.id, 'classic');
  assert.equal(range.detailHeightPx, null);
  adapter.dispose();
});

test('a cold seek with insufficient hybrid canvas memory falls back to Classic in the same draw', () => {
  const canvas = surface(), residency = new GraphicsResidency({ budgetBytes: 320 * 180 * 4 });
  const manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [], drawHighResolutionSky() {} };
  const inner = { rangePresentation: { enabled: true }, draw() {}, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, residency, presentation: { ...presentation, rangePipeline: 'hybrid' }, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 90000, experience: 'landscape' };
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.width, 320);
  assert.equal(adapter.diagnostics.progressiveDetail.reason, 'memory');
  const denials = residency.denials;
  for (let i = 0; i < 10; i++) assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(residency.denials, denials);
  adapter.dispose(); assert.equal(residency.usedBytes, 0);
});

test('a heavier incoming scene can fall below the outgoing scene\'s last useful size', () => {
  const canvas = surface(), range = { enabled: true }, manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [] };
  let heavier = false;
  const inner = { rangePresentation: range, draw() {
    range.resolutionRefused = heavier && this.pixelPolicy.grid.width > 320;
    manager._awaitingTerrain = range.resolutionRefused;
  }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 45000, experience: 'landscape' };
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.ok(adapter.output.grid.width > 320);
  heavier = true;
  assert.equal(adapter.draw(sim, 0).presented, false);
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.width, 320);
  adapter.dispose();
});
