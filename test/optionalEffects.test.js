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
  mgr.reducedFlash = false;
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
  mgr.murmuration = touch('murmuration');
  return { mgr, calls };
}

const FULL = { phenomenaFull: true, constellationsEnabled: true };

test('airless keeps ground diffusion and sky effects it draws, and skips alpine spectacle', () => {
  const { mgr, calls } = spyMgr('airless', FULL);
  mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  assert.ok(calls.includes('rd'));
  assert.ok(calls.includes('weaver'));
  assert.ok(calls.includes('meteors'));
  for (const name of ['mandala', 'cymatics', 'swarm', 'ribbon', 'spaceRidge', 'lightRig', 'murmuration', 'lightning']) {
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
  for (const name of ['mandala', 'cymatics', 'swarm', 'ribbon', 'rd', 'murmuration', 'meteors']) {
    assert.equal(calls.includes(name), false, name);
  }
});

test('no perf policy means full quality for a world that paints the effect', () => {
  const { mgr, calls } = spyMgr('alpine', null);
  mgr.stepOptionalEffects(1000, 0.016, null, 0, { x: 0, y: 0 });
  assert.ok(calls.includes('mandala'));
  assert.ok(calls.includes('rd'));
  assert.ok(!calls.includes('murmuration'), 'incidental flock never resumes at full quality');
});
