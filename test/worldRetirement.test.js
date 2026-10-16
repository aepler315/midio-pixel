import test from 'node:test';
import assert from 'node:assert/strict';
import * as worlds from '../src/world/Worlds.js';
import { resolveTitleWorldChoice } from '../src/ui/TitleWorldChoice.js';
import { Simulation } from '../src/sim/Simulation.js';
import { Conductor } from '../src/core/Conductor.js';
import { ParamBus } from '../src/core/ParamBus.js';

test('removed world choices normalize without affecting surviving worlds', () => {
  assert.equal(worlds.listWorlds().some(w => w.id === 'cathode'), false);
  assert.equal(worlds.resolveWorldId('cathode'), 'alpine');
  assert.equal(worlds.getWorld('cathode').id, 'alpine');
  assert.deepEqual(resolveTitleWorldChoice('cathode', worlds.listWorlds().map(w => w.id)), { mode: 'ask' });
  for (const w of worlds.listWorlds()) assert.equal(worlds.resolveWorldId(w.id), w.id);
});
test('active custom worlds require a registered kind', () => {
  try {
    worlds.setCustomWorld({ ...worlds.getWorld('nocturne'), id: 'custom' });
    assert.equal(worlds.resolveWorldId('custom'), 'custom');
    worlds.setCustomWorld({ id: 'custom', kind: 'cathode' });
    assert.equal(worlds.getWorld('custom').id, 'alpine');
    assert.equal(worlds.resolveWorldId('custom'), 'alpine');
  } finally { worlds.clearCustomWorld(); }
});
test('replay simulation reports the effective world while preserving its seed and clock', () => {
  const conductor = new Conductor();
  conductor.load({ timeline: [], durationMs: 10000, barGrid: [] });
  const sim = new Simulation(conductor, new ParamBus(), { worldId: 'cathode', songSeed: 42 });
  try {
    assert.equal(sim.worldId, 'alpine');
    assert.equal(sim.songSeed, 42);
    sim.biomes.pumpStripPrewarm = () => {};
    sim.startAt(1200);
    assert.equal(sim.timeMs, 1200);
  } finally { sim.dispose(); }
});

test('removed preview input constructs Range with the original seed', async () => {
  const { createPreviewWorld } = await import('../src/ui/WorldPreview.js');
  const original = globalThis.document;
  let seen;
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
  createPreviewWorld._BiomeManager = class {
    constructor(opts) { seen = opts; this.kind = worlds.getWorld(opts.worldId).kind; }
    dispose() {}
  };
  try {
    const preview = createPreviewWorld({ worldId: 'cathode', seed: 42, data: { durationMs: 10000 } });
    assert.equal(preview.kind, 'alpine');
    assert.equal(seen.songSeed, 42);
    preview.dispose();
  } finally { globalThis.document = original; delete createPreviewWorld._BiomeManager; }
});
