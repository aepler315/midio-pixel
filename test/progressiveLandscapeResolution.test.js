import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelPresentation } from '../src/render/PixelPresentation.js';
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
  canvas.getContext = type => type === 'webgl' ? null : ctx;
  canvas.ownerDocument = { createElement() { canvas.allocations++; return surface(0, 0); } };
  return canvas;
}
const presentation = { pixelated: true, grid: pixelGrid(), paletteId: 'none', scaling: 'fit', rangePipeline: 'single', buildPixelDetail: true };

test('rise resolution starts at Classic and never exceeds Detailed on large outputs', () => {
  for (const options of [{}, { width: 800, height: 480, scaling: 'cover' }, { width: 1537, height: 900 }, { width: 3840, height: 2160 }]) {
    const p = plan(options), start = policy.landscapeResolutionAt(p, 0), end = policy.landscapeResolutionAt(p, 1);
    assert.deepEqual([start.grid.width, start.grid.height], [320, 180]);
    assert.equal(end.rung, 24);
    assert.deepEqual([end.grid.width, end.grid.height], [640, 360]);
    assert.deepEqual(p.endpoint, { width: 640, height: 360 });
    for (const grid of p.grids) {
      assert.ok(grid.width <= 640 && grid.height <= 360 && grid.pixels <= 230400);
    }
  }
});

test('smaller outputs retain their fitted or covered endpoint with a Classic minimum', () => {
  for (const [options, endpoint] of [
    [{ width: 480, height: 360 }, [480, 270]],
    [{ width: 480, height: 360, scaling: 'cover' }, [640, 360]],
    [{ width: 400, height: 225, scaling: 'cover' }, [400, 225]],
    [{ width: 480, height: 240 }, [427, 240]],
    [{ width: 240, height: 120 }, [320, 180]],
    [{ width: NaN, height: 0 }, [320, 180]],
  ]) {
    const end = policy.landscapeResolutionAt(plan(options), 1);
    assert.deepEqual([end.grid.width, end.grid.height], endpoint);
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
  const sim = { biomes: manager, heardTimeMs: 0 };
  for (const timeMs of [0, 30000, 90000, 90000, 0]) {
    sim.heardTimeMs = timeMs;
    assert.equal(adapter.draw(sim, 0).presented, true);
  }
  assert.deepEqual([seen[0].grid.width, seen[2].grid.width, seen[3].grid.width, seen[4].grid.width], [320, 640, 640, 320]);
  assert.ok(seen[1].grid.width > 320 && seen[1].grid.width < 640);
  assert.ok(seen.every(s => s.lod === 360 && s.single));
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

test('quality output resizing preserves a refused native ceiling until the fitted endpoint changes', () => {
  const canvas = surface(), range = { enabled: true }, manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [] };
  let refuse = false;
  const inner = { rangePresentation: range, draw() { manager._awaitingTerrain = refuse && this.pixelPolicy.grid.width > 320; range.resolutionRefused = manager._awaitingTerrain; range.reason = manager._awaitingTerrain ? 'budget: scene target' : null; }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 0 };
  assert.equal(adapter.draw(sim, 0).presented, true);
  refuse = true; sim.heardTimeMs = 90000;
  assert.equal(adapter.draw(sim, 0).presented, false);
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.width, 320);
  assert.equal(adapter.diagnostics.progressiveDetail.reason, 'scene-memory');
  refuse = false; canvas.width = 960; canvas.height = 540;
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.deepEqual([adapter.output.grid.width, adapter.output.grid.height], [320, 180], 'the same endpoint keeps its memory refusal');
  assert.equal(adapter.diagnostics.progressiveDetail.reason, 'scene-memory');
  assert.equal(range.detailHeightPx, 360);
  canvas.width = 480; canvas.height = 270;
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.deepEqual([adapter.output.grid.width, adapter.output.grid.height], [480, 270]);
  assert.equal(range.detailHeightPx, 270);
  adapter.dispose();
});

test('changing settings restores a fixed raster and Cinematic can use the same progressive grid', () => {
  const canvas = surface(), range = { enabled: true }, manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [] };
  const inner = { rangePresentation: range, draw() {}, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation: { ...presentation, cinematicPixel: true, rangePipeline: 'hybrid' }, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 90000, perf: { level: 2 } };
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.ok(adapter.output.grid.width <= 560 && adapter.output.grid.height <= 315);
  assert.equal(adapter.diagnostics.progressiveDetail.active, true);
  assert.equal(adapter.diagnostics.progressiveDetail.reason, 'quality');
  adapter.setPresentation({ ...presentation, buildPixelDetail: false });
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.id, 'classic');
  assert.equal(range.detailHeightPx, null);
  adapter.dispose();
});

test('quality selects an existing planned rung within each native detail budget', () => {
  assert.equal(typeof policy.landscapeQualityRung, 'function');
  for (const options of [{}, { width: 480, height: 240 }, { width: 240, height: 120 }]) {
    const p = plan(options), caps = [[640, 360], [640, 360], [560, 315], [480, 270], [400, 225], [320, 180], [320, 180]];
    for (const [quality, [width, height]] of caps.entries()) {
      const rung = policy.landscapeQualityRung(p, quality), grid = p.grids[rung];
      assert.ok(grid.width <= width && grid.height <= height);
      assert.ok(grid.width <= p.endpoint.width && grid.height <= p.endpoint.height);
      assert.ok(rung === p.maxRung || p.grids[rung + 1].width > width || p.grids[rung + 1].height > height,
        'use the finest existing rung that fits');
    }
  }
});

function growingHarness({ width = 1920, height = 1080, residency, draw = () => {} } = {}) {
  const canvas = surface(width, height), range = { enabled: true }, manager = {
    world: { kind: 'alpine' }, durationMs: 90000, sections: [], energyCurves: { globalEnergyNorm: () => .4 },
  };
  const inner = { rangePresentation: range, draw() { draw(this, manager, range); }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, residency,
    presentation: { ...presentation, cinematicPixel: true, rangePipeline: 'hybrid' }, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 90000, perf: { level: 6,
    forgetRecoveryHistory() { assert.fail('rendering must not reset governor recovery'); } } };
  return { canvas, range, manager, adapter, sim };
}

test('late Cinematic growth sheds native pixels at q6 and recovers without changing the requested rise or geometry budget', () => {
  const { adapter, sim, range, canvas } = growingHarness();
  try {
    assert.equal(adapter.draw(sim, 0).presented, true);
    assert.deepEqual([adapter.output.grid.width, adapter.output.grid.height], [320, 180], 'the quality floor must shed late native terrain');
    const seen = [];
    for (const level of [0, 1, 2, 3, 4, 5, 6, 2, 0]) {
      sim.perf.level = level;
      assert.equal(adapter.draw(sim, 0).presented, true);
      const d = adapter.diagnostics.progressiveDetail;
      assert.equal(d.requestedRung, 24, 'the song still requests its complete rise');
      assert.equal(d.memoryRungLimit, 24, 'quality does not become a persistent memory refusal');
      assert.equal(d.reason, level >= 2 ? 'quality' : null);
      assert.equal(range.detailHeightPx, 360, 'tour geometry remains admitted for the full endpoint');
      seen.push(adapter.output.grid);
    }
    assert.deepEqual(seen.map(g => g.width), [640, 640, 554, 479, 392, 320, 320, 554, 640]);
    assert.equal(seen[2], seen[7], 'recovery reuses the same planned grid');
    assert.equal(seen[0], seen[8]);
    const allocations = canvas.allocations, grid = adapter.output.grid;
    for (let i = 0; i < 5; i++) assert.equal(adapter.draw(sim, 0).presented, true);
    assert.equal(adapter.output.grid, grid);
    assert.equal(canvas.allocations, allocations, 'paused redraws reuse the admitted raster');
  } finally { adapter.dispose(); }
});

test('quality caps compose with seeks and small output endpoints without increasing requested detail', () => {
  const { adapter, sim, canvas } = growingHarness({ width: 480, height: 240 });
  try {
    sim.perf.level = 2; adapter.draw(sim, 0);
    assert.deepEqual([adapter.output.grid.width, adapter.output.grid.height], [427, 240]);
    assert.equal(adapter.diagnostics.progressiveDetail.reason, null, 'the endpoint already fits this quality');
    sim.heardTimeMs = 30000; sim.perf.level = 0; adapter.draw(sim, 0);
    const requested = adapter.output.grid, requestedRung = adapter.diagnostics.progressiveDetail.requestedRung;
    sim.perf.level = 6; adapter.draw(sim, 0); assert.equal(adapter.output.grid.width, 320);
    assert.equal(adapter.diagnostics.progressiveDetail.requestedRung, requestedRung);
    sim.perf.level = 0; adapter.draw(sim, 0); assert.equal(adapter.output.grid, requested);
    sim.heardTimeMs = 0; sim.perf.level = 6; adapter.draw(sim, 0);
    assert.equal(adapter.output.grid.width, 320); assert.equal(adapter.diagnostics.progressiveDetail.reason, null);
    canvas.width = 240; canvas.height = 120; sim.heardTimeMs = 90000; sim.perf.level = 0; adapter.draw(sim, 0);
    assert.equal(adapter.output.grid.width, 320);
    assert.deepEqual(adapter.diagnostics.progressiveDetail.endpoint, { width: 320, height: 180 });
  } finally { adapter.dispose(); }
});

test('quality recovery preserves a refused scene ceiling instead of retrying the costly raster', () => {
  let refusals = 0;
  const { adapter, sim, range } = growingHarness({ draw(inner, manager, view) {
    manager._awaitingTerrain = inner.pixelPolicy.grid.width > 320;
    view.resolutionRefused = manager._awaitingTerrain;
    if (manager._awaitingTerrain) refusals++;
  } });
  try {
    assert.equal(adapter.draw(sim, 0).presented, true);
    sim.perf.level = 0;
    assert.equal(adapter.draw(sim, 0).presented, false);
    assert.equal(adapter.draw(sim, 0).presented, true);
    assert.equal(adapter.diagnostics.progressiveDetail.reason, 'scene-memory');
    const ceiling = adapter.diagnostics.progressiveDetail.memoryRungLimit;
    for (const level of [6, 2, 0, 6, 0]) {
      sim.perf.level = level;
      assert.equal(adapter.draw(sim, 0).presented, true);
      assert.equal(adapter.output.grid.width, 320);
      assert.equal(adapter.diagnostics.progressiveDetail.memoryRungLimit, ceiling);
      assert.equal(range.detailHeightPx, 360);
    }
    assert.equal(refusals, 1);
  } finally { adapter.dispose(); }
});

test('quality changes do not repeat denied native canvas allocations', () => {
  const residency = new GraphicsResidency({ budgetBytes: 2 * 320 * 180 * 4 });
  const { adapter, sim, canvas } = growingHarness({ residency });
  try {
    adapter.setPresentation({ ...presentation, rangePipeline: 'hybrid' });
    adapter.draw(sim, 0); sim.perf.level = 0; adapter.draw(sim, 0);
    const denials = residency.denials, allocations = canvas.allocations;
    for (let i = 0; i < 10; i++) for (const level of [6, 0]) {
      sim.perf.level = level;
      assert.equal(adapter.draw(sim, 0).presented, true);
      assert.equal(adapter.output.grid.width, 320);
    }
    assert.equal(residency.denials, denials);
    assert.equal(canvas.allocations, allocations);
  } finally { adapter.dispose(); }
  assert.equal(residency.usedBytes, 0);
});

test('output backing changes reuse a matching native plan and its admitted canvas', () => {
  const { adapter, sim, canvas } = growingHarness();
  try {
    sim.perf.level = 4; adapter.draw(sim, 0);
    const grid = adapter.output.grid, growthPlan = adapter._growthPlan, allocations = canvas.allocations;
    for (const [width, height] of [[1632, 918], [1440, 810], [1200, 675], [1920, 1080]]) {
      canvas.width = width; canvas.height = height;
      assert.equal(adapter.draw(sim, 0).presented, true);
      assert.equal(adapter.output.grid, grid, 'unchanged endpoint preserves grid identity');
      assert.equal(adapter._growthPlan, growthPlan);
      assert.equal(canvas.allocations, allocations, 'the working raster is not released for an equivalent grid');
    }
  } finally { adapter.dispose(); }
});

test('a denied quality-floor raster never falls back above the current native cap or retries that denied rung', () => {
  const residency = new GraphicsResidency({ budgetBytes: 4 * 640 * 360 * 4 });
  const { adapter, sim } = growingHarness({ residency });
  try {
    adapter.setPresentation({ ...presentation, rangePipeline: 'hybrid' });
    sim.perf.level = 0; assert.equal(adapter.draw(sim, 0).presented, true);
    assert.equal(adapter._lastGrowthRung, 24);
    residency.release(adapter.output.key);
    residency.budgetBytes = 1;
    const requests = [], reserve = residency.reserve.bind(residency);
    residency.reserve = request => { if (request.owner === 'pixel-presentation') requests.push(request.bytes); return reserve(request); };
    sim.perf.level = 6;
    assert.equal(adapter.draw(sim, 0).presented, false);
    assert.deepEqual(requests, [320 * 180 * 4], 'one Classic denial cannot trigger a Detailed retry from old high-quality history');
    assert.equal(adapter.output.grid.width, 320);
    assert.equal(adapter.diagnostics.progressiveDetail.admittedGrid.width, 320);
  } finally { adapter.dispose(); }
});

test('native quality caps leave fixed presets, native pipeline and exports unchanged', () => {
  const { adapter, sim } = growingHarness();
  try {
    for (const fixed of [{ ...presentation, grid: pixelGrid('detailed'), buildPixelDetail: false },
      { ...presentation, grid: pixelGrid('detailed'), rangePipeline: 'native' }]) {
      adapter.setPresentation(fixed); adapter.draw(sim, 0);
      assert.equal(adapter.output.grid.width, 640);
      assert.equal(adapter.diagnostics.progressiveDetail.active, false);
    }
    adapter.setPresentation({ ...presentation, rangePipeline: 'hybrid' }); sim.exportMode = true;
    adapter.draw(sim, 0); assert.equal(adapter.output.grid.width, 640, 'offline exports keep their requested quality');
  } finally { adapter.dispose(); }
});

test('a cold seek with insufficient hybrid canvas memory falls back to Classic in the same draw', () => {
  const canvas = surface(), residency = new GraphicsResidency({ budgetBytes: 320 * 180 * 4 });
  const manager = { world: { kind: 'alpine' }, durationMs: 90000, sections: [], drawHighResolutionSky() {} };
  const inner = { rangePresentation: { enabled: true }, draw() {}, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, residency, presentation: { ...presentation, rangePipeline: 'hybrid' }, rendererFactory: () => inner });
  const sim = { biomes: manager, heardTimeMs: 90000 };
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
  const sim = { biomes: manager, heardTimeMs: 45000 };
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.ok(adapter.output.grid.width > 320);
  heavier = true;
  assert.equal(adapter.draw(sim, 0).presented, false);
  assert.equal(adapter.draw(sim, 0).presented, true);
  assert.equal(adapter.output.grid.width, 320);
  adapter.dispose();
});
