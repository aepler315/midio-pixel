import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { FloodDirector } from '../src/sim/FloodDirector.js';
import { getWorld } from '../src/world/Worlds.js';

// Age where the crest envelope is at its peak and the approach window is live.
const OVERTURN_MS = 2240;

function harness(worldId) {
  const flood = new FloodDirector();
  const camera = { shakes: 0, shake(n) { this.shakes += n; } };
  const film = { hits: [], hit(name) { this.hits.push(name); } };
  const mgr = Object.create(BiomeManager.prototype);
  mgr.world = getWorld(worldId);
  mgr.flood = flood;
  mgr.w = 1280;
  mgr.tSec = OVERTURN_MS / 1000;
  mgr._tsunamis = [];
  mgr._wasTsunamiActive = false;
  mgr.tsunamiJustArrived = false;
  return { mgr, flood, camera, film };
}

test('an airless world ignores a scheduled tsunami in flood, footing and camera state', () => {
  const { mgr, flood, camera, film } = harness('farside');
  mgr.armTsunami(0, 1);
  assert.equal(mgr._tsunamis.length, 0);
  mgr._tsunamis.push({ tMs: 0, dir: 1 });
  mgr.stepOceanHazards(OVERTURN_MS);
  flood.update(OVERTURN_MS, 0.016, { rainAccum01: 0 });
  assert.equal(flood.active, false);
  assert.equal(flood.level01, 0);
  assert.equal(flood.source, null);
  assert.equal(mgr.tsunamiJustArrived, false);
  assert.equal(mgr.floodFooting01(), 0);
  if (mgr.tsunamiJustArrived && mgr.acceptsOceanHazard()) {
    film.hit('tsunami');
    camera.shake(4);
  }
  assert.deepEqual(film.hits, []);
  assert.equal(camera.shakes, 0);
});

test('the range still arms a flood and an arrival accent from the same wave', () => {
  const { mgr, flood, camera, film } = harness('alpine');
  mgr.armTsunami(0, 1);
  assert.equal(mgr._tsunamis.length, 1);
  mgr.stepOceanHazards(OVERTURN_MS);
  flood.update(OVERTURN_MS + 700, 0.016, { rainAccum01: 0 });
  assert.equal(flood.source, 'tsunami');
  assert.equal(flood.active, true);
  assert.ok(flood.level01 > 0.5, `level ${flood.level01}`);
  assert.ok(mgr.tsunamiJustArrived);
  assert.ok(mgr.floodFooting01() > 0.5);
  if (mgr.tsunamiJustArrived && mgr.acceptsOceanHazard()) {
    film.hit('tsunami');
    camera.shake(4);
  }
  assert.deepEqual(film.hits, ['tsunami']);
  assert.equal(camera.shakes, 4);
});

test('rain can still wet footing where a tsunami must not', () => {
  const { mgr, flood } = harness('farside');
  flood._rainLevel01 = 0.4;
  flood.level01 = 0.4;
  flood.active = true;
  flood.source = 'rain';
  assert.equal(mgr.floodFooting01(), 0.4);
  flood.source = 'tsunami';
  flood.level01 = 1;
  assert.equal(mgr.floodFooting01(), 0);
});
