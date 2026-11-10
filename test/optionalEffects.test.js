import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

function spyMgr(kind, perf) {
  const calls = [];
  const mgr = Object.create(BiomeManager.prototype);
  mgr.world = { kind };
  mgr._perf = perf;
  mgr.tSec = 1;
  mgr._progress = 0.2;
  mgr._beatMs = 500;
  mgr.budget = 1;
  mgr.fever = 0;
  mgr._danceKickMs = 0;
  mgr._eqSmoothed = new Float32Array(7);
  mgr.calmLevel = 0;
  const touch = (name) => ({
    update() { calls.push(name); },
  });
  mgr.mandala = touch('mandala');
  mgr.cymatics = touch('cymatics');
  mgr.swarm = touch('swarm');
  mgr.ribbon = touch('ribbon');
  mgr.rd = touch('rd');
  mgr.lightning = touch('lightning');
  mgr.lightRig = touch('lightRig');
  mgr.meteors = touch('meteors');
  mgr.weaver = touch('weaver');
  mgr.spaceRidge = touch('spaceRidge');
  return { mgr, calls };
}

const FULL = { phenomenaFull: true, constellationsEnabled: true };

test('an unregistered kind keeps ground diffusion and the shared sky effects, and skips alpine spectacle', () => {
  const { mgr, calls } = spyMgr('unregistered-kind', FULL);
  mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  assert.ok(calls.includes('rd'));
  assert.ok(calls.includes('weaver'));
  assert.ok(calls.includes('meteors'));
  for (const name of ['mandala', 'cymatics', 'swarm', 'ribbon', 'spaceRidge', 'lightRig', 'lightning']) {
    assert.equal(calls.includes(name), false, name);
  }
});


test('a low-quality range keeps the light rig and drops phenomena, including diffusion', () => {
  const { mgr, calls } = spyMgr('alpine', { phenomenaFull: false, constellationsEnabled: true });
  mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  assert.ok(calls.includes('lightRig'));
  assert.ok(calls.includes('spaceRidge'));
  assert.ok(calls.includes('lightning'));
  assert.ok(calls.includes('weaver'));
  for (const name of ['mandala', 'cymatics', 'swarm', 'ribbon', 'rd', 'meteors']) {
    assert.equal(calls.includes(name), false, name);
  }
});

test('no perf policy means full quality for a world that paints the effect', () => {
  const { mgr, calls } = spyMgr('alpine', null);
  mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  assert.ok(calls.includes('mandala'));
  assert.ok(calls.includes('rd'));
});

test('reaction diffusion is built on its first step, so the Range sky never pays its warm-up', async () => {
  const { ReactionDiffusion } = await import('../src/world/ReactionDiffusion.js');
  const range = spyMgr('alpine', FULL).mgr;
  Object.assign(range, { rd: null, _rdSeed: 7, _rdIntensity: .6, _rdBias: .2, _rangeSky: { showWeaver: false } });
  for (let i = 0; i < 3; i++) range.stepOptionalEffects(1000 + i * 16, 0.016, null, 0, { x: 0, y: 0 });
  assert.equal(range.rd, null, 'Landscape never constructs it');
  const painted = spyMgr('alpine', FULL).mgr;
  Object.assign(painted, { rd: null, _rdSeed: 7, _rdIntensity: .6, _rdBias: .2 });
  painted.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  assert.ok(painted.rd instanceof ReactionDiffusion, 'the painted sky builds it when it first steps');
  assert.deepEqual([painted.rd.intensity, painted.rd.bias], [.6, .2], 'with the gains already set');
});

test('under the Range sky, Landscape stops stepping the abstract phenomena it never draws', () => {
  const { mgr, calls } = spyMgr('alpine', FULL);
  mgr._rangeSky = { showWeaver: false };
  mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  for (const name of ['mandala', 'cymatics', 'swarm', 'ribbon', 'rd', 'lightRig']) assert.ok(!calls.includes(name), name);
  assert.ok(calls.includes('lightning'), 'weather lightning still steps');
  const legacy = spyMgr('alpine', FULL);
  legacy.mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  for (const name of ['mandala', 'cymatics', 'swarm', 'ribbon', 'rd', 'lightRig']) assert.ok(legacy.calls.includes(name), `painted sky keeps ${name}`);
});
