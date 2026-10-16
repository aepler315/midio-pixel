import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { TerrainStripCache } from '../src/world/terrain/TerrainStripCache.js';

function surface(width, height) {
  return { width, height, getContext() { return {}; } };
}

function withTerrain(strips, terrain) {
  Object.defineProperty(strips, '_terrain', { value: terrain });
  return strips;
}

test('preparePlaybackStrips bakes the biome on screen before any draw', () => {
  const mgr = Object.create(BiomeManager.prototype);
  mgr.strips = new TerrainStripCache({ maxBytes: 10_000 });
  mgr.tSec = 0;
  mgr.sections = [
    { startMs: 0, endMs: 10000, profile: 'home' },
    { startMs: 10000, endMs: 20000, profile: 'next' },
  ];
  mgr._blend = () => ({ from: 'home', to: 'home', t: 1 });
  const asked = [];
  mgr.stripsFor = (key) => {
    asked.push(key);
    const strips = withTerrain({ L2: surface(4, 4) }, null);
    mgr.strips.set(key, strips);
    return strips;
  };
  mgr.preparePlaybackStrips();
  assert.deepEqual(asked, ['home']);
  assert.equal(mgr.strips.has('home'), true);
  assert.equal(mgr.strips.has('next'), false);
});

test('prewarm finishes the next biome a layer at a time without evicting the visible set', () => {
  const mgr = Object.create(BiomeManager.prototype);
  mgr.strips = new TerrainStripCache({ maxBytes: 400 });
  mgr.tSec = 1;
  mgr.sections = [
    { startMs: 0, endMs: 10000, profile: 'home' },
    { startMs: 10000, endMs: 20000, profile: 'next' },
  ];
  mgr.currentBlend = { from: 'home', to: 'home' };
  mgr._terrainFor = () => null;
  mgr._profile = (name) => ({ name });
  const home = withTerrain({ L2: surface(10, 10) }, null);
  mgr.strips.set('home', home);
  let layers = 0;
  mgr._composeStripJob = (b) => ({
    key: b.name, terrain: null, profile: b, strips: {}, index: 0, done: false,
    layers: ['L2', 'L3', 'L4', 'L5'],
  });
  mgr._bakeOneLayer = (job) => {
    layers += 1;
    const key = job.layers[job.index];
    job.strips[key] = surface(10, 10);
    job.index += 1;
    if (job.index < job.layers.length) return false;
    withTerrain(job.strips, job.terrain);
    job.done = true;
    return true;
  };
  mgr.pumpStripPrewarm(0);
  assert.equal(layers, 1);
  assert.equal(mgr.strips.has('next'), false);
  assert.equal(mgr.strips.has('home'), true);
  mgr.pumpStripPrewarm(0);
  mgr.pumpStripPrewarm(0);
  mgr.pumpStripPrewarm(0);
  assert.equal(layers, 4);
  // Four 10x10 surfaces are 1600 bytes. The 400-byte budget cannot hold
  // them beside home, and home stays pinned.
  assert.equal(mgr.strips.has('next'), false);
  assert.equal(mgr.strips.get('home'), home);
  mgr.strips.maxBytes = 4000;
  mgr.pumpStripPrewarm(0);
  assert.equal(mgr.strips.has('next'), true);
  assert.equal(mgr.strips.get('home'), home);
});

test('a terrain change keeps the current strips until the replacement is published', () => {
  const mgr = Object.create(BiomeManager.prototype);
  mgr.strips = new TerrainStripCache({ maxBytes: 10_000 });
  mgr.currentBlend = { from: 'home', to: 'home' };
  mgr._lastStripKey = null;
  mgr.world = { kind: 'alpine' };
  const oldTerrain = { id: 'old' };
  const nextTerrain = { id: 'new' };
  const oldStrips = withTerrain({ L2: surface(4, 4) }, oldTerrain);
  mgr.strips.set('home', oldStrips);
  mgr._terrainFor = () => nextTerrain;
  mgr._profile = () => ({ name: 'home' });
  mgr._composeStripJob = () => ({
    key: 'home', terrain: nextTerrain, strips: {}, index: 0, done: false, layers: ['L2'],
  });
  mgr._bakeOneLayer = () => false;
  assert.equal(mgr.stripsFor('home'), oldStrips);
  assert.equal(mgr.strips.get('home'), oldStrips);
  mgr._bakeOneLayer = (job) => {
    job.strips.L2 = surface(4, 4);
    withTerrain(job.strips, nextTerrain);
    job.done = true;
    return true;
  };
  mgr.pumpStripPrewarm(0);
  const published = mgr.strips.get('home');
  assert.notEqual(published, oldStrips);
  assert.equal(published._terrain, nextTerrain);
});

test('a finished prewarm is installed when the frame asks, without baking again', () => {
  const mgr = Object.create(BiomeManager.prototype);
  mgr.strips = new TerrainStripCache({ maxBytes: 400 });
  mgr.currentBlend = { from: 'home', to: 'next' };
  mgr._lastStripKey = 'home';
  mgr._terrainFor = () => null;
  mgr._profile = (name) => ({ name });
  const home = withTerrain({ L2: surface(10, 10) }, null);
  mgr.strips.set('home', home);
  const ready = withTerrain({ L2: surface(10, 10), L3: surface(10, 10) }, null);
  mgr._bakeJob = { key: 'next', terrain: null, strips: ready, done: true, published: false };
  mgr._buildStripSet = () => { throw new Error('should reuse the finished prewarm'); };
  const got = mgr.stripsFor('next');
  assert.equal(got, ready);
  assert.equal(mgr.strips.get('home'), home);
  assert.equal(mgr._bakeJob, null);
});

test('changing the upcoming biome cancels an unfinished bake', () => {
  const mgr = Object.create(BiomeManager.prototype);
  mgr.strips = new TerrainStripCache({ maxBytes: 10_000 });
  mgr.tSec = 1;
  mgr.currentBlend = { from: 'home', to: 'home' };
  mgr._terrainFor = () => null;
  mgr._profile = (name) => ({ name });
  mgr.sections = [
    { startMs: 0, endMs: 10000, profile: 'home' },
    { startMs: 10000, endMs: 20000, profile: 'next' },
  ];
  const released = [];
  mgr._releaseStripSurfaces = (strips) => { released.push(strips); };
  mgr._composeStripJob = (b) => ({
    key: b.name, terrain: null, strips: { L2: surface(2, 2) }, index: 0, done: false, layers: ['L2', 'L3'],
  });
  mgr._bakeOneLayer = () => false;
  mgr.pumpStripPrewarm(0);
  assert.equal(mgr._bakeJob.key, 'next');
  mgr.sections = [
    { startMs: 0, endMs: 10000, profile: 'home' },
    { startMs: 10000, endMs: 20000, profile: 'other' },
  ];
  mgr.pumpStripPrewarm(0);
  assert.equal(released.length, 1);
  assert.equal(mgr._bakeJob.key, 'other');
});
