import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTerrainTourPolicy, captureTourTerrainState, restoreTourTerrainState } from '../src/ui/TourTerrain.js';
import { createReelSaver } from '../src/ui/ReelExport.js';

test('tetons then ordinary render groups use the correct biome assignment and restore original references', () => {
  const ordinary = ['CONIFER', 'DESERT', 'GLACIER'];
  const terrain = { biomes: ordinary };
  const saved = captureTourTerrainState(terrain);
  applyTerrainTourPolicy(terrain, 'tetons', 'alpine');
  assert.deepEqual(terrain.biomes, ['CONIFER']);
  applyTerrainTourPolicy(terrain, 'off', 'alpine');
  assert.deepEqual(terrain.biomes, ordinary);
  assert.equal(Object.hasOwn(terrain, '_rangeTourOriginalBiomes'), false);
  applyTerrainTourPolicy(terrain, 'tetons', 'alpine');
  applyTerrainTourPolicy(terrain, 'shots', 'alpine');
  assert.deepEqual(terrain.biomes, ordinary);
  restoreTourTerrainState(saved);
  assert.equal(terrain.biomes, ordinary);
  assert.equal(Object.hasOwn(terrain, '_rangeTourOriginalBiomes'), false);
});

test('temporary policy restores own-property presence and values, including an already active Teton run', () => {
  for (const terrain of [
    {}, { biomes: undefined }, { biomes: ['DESERT'], _rangeTourOriginalBiomes: undefined },
    { biomes: ['CONIFER'], _rangeTourOriginalBiomes: ['DESERT', 'GLACIER'] },
  ]) {
    const keys = Object.keys(terrain), values = { ...terrain };
    const saved = captureTourTerrainState(terrain);
    applyTerrainTourPolicy(terrain, 'tetons', 'alpine');
    applyTerrainTourPolicy(terrain, 'off', 'alpine');
    restoreTourTerrainState(saved);
    assert.deepEqual(Object.keys(terrain).sort(), keys.sort());
    for (const key of keys) assert.equal(terrain[key], values[key]);
  }
});

test('temporary arm failure restores both nested fields through the same reel end path', async () => {
  const biomes = ['DESERT', 'GLACIER'];
  const terrain = { biomes, _rangeTourOriginalBiomes: undefined };
  const saved = captureTourTerrainState(terrain);
  const result = await createReelSaver().run({
    plan: { groups: [{ cameraTourMode: 'tetons', items: [{ index: 0, atMs: 0, approximate: [] }] }], unavailable: [] },
    begin: () => { applyTerrainTourPolicy(terrain, 'tetons', 'alpine'); throw Error('world build failed'); },
    end: () => restoreTourTerrainState(saved),
  });
  assert.equal(result.error, 'world build failed');
  assert.equal(terrain.biomes, biomes);
  assert.equal(Object.hasOwn(terrain, '_rangeTourOriginalBiomes'), true);
  assert.equal(terrain._rangeTourOriginalBiomes, undefined);
});

test('normal completion restores a previously forced Teton run after an ordinary group', async () => {
  const forced = ['CONIFER'], original = ['DESERT', 'GLACIER'];
  const terrain = { biomes: forced, _rangeTourOriginalBiomes: original };
  const saved = captureTourTerrainState(terrain);
  const result = await createReelSaver().run({
    plan: { groups: [{ cameraTourMode: 'off', items: [{ index: 0, atMs: 0, approximate: [] }] }], unavailable: [] },
    begin: () => applyTerrainTourPolicy(terrain, 'off', 'alpine'),
    draw: () => { assert.equal(terrain.biomes, original); },
    encode: () => ({ blob: {}, width: 3840, height: 2160 }), save: () => {},
    end: () => restoreTourTerrainState(saved),
  });
  assert.equal(result.status, 'done');
  assert.equal(terrain.biomes, forced);
  assert.equal(terrain._rangeTourOriginalBiomes, original);
});
