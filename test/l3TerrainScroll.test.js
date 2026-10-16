import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { ridgeDepth, terrainScrollPx } from '../src/world/terrain/ProfileTravel.js';
import { CodaDirector } from '../src/sim/CodaDirector.js';

const STRIP = 8192;
const VIEW = 1280;
const WORLD_X = 220 * 240;

function profile() {
  return {
    name: 'Home',
    silhouette: '#334455',
    sky: ['#223344', '#334455', '#445566'],
    celestial: { haloColor: '#ffe0a0', color: '#ffe0a0', radius: 40 },
  };
}

function manager(overrides = {}) {
  const mgr = Object.create(BiomeManager.prototype);
  const home = profile();
  Object.assign(mgr, {
    world: { kind: 'alpine', realBiomes: true },
    tSec: 240,
    durationMs: 300000,
    energyCurves: { globalEnergyNorm: () => 0.45 },
    unravel: 0,
    reducedFlash: false,
    w: 100,
    h: 720,
    _dayNightCycleMs: 180000,
    _lightBudget: 1,
    visualStyle: 'rendered',
    sections: [{ profile: 'Home', startMs: 0, endMs: 300000 }],
    currentBlend: { from: 'Home', to: 'Home', t: 1 },
    terrainProfiles: { L2: { id: 'far' }, L3: { id: 'mid' }, L4: { id: 'near' } },
    songTerrain: null,
    strips: { get: () => ({ L2: { width: STRIP }, L3: { width: STRIP }, L4: { width: STRIP } }) },
    lerpCache: { get: (a) => a },
    _profile: () => home,
    openingGain: 1,
    _activeWeatherIntensity: 0,
    fields: new Map([['Home', { draw() {} }]]),
    _perf: { phenomenaFull: false, constellationsEnabled: false, hazeLayers: 1, rimLightEnabled: false },
  }, overrides);
  // This test isolates scroll selection: its cached strips carry widths but
  // no canvas surfaces, so bypass the unrelated bake/pin lifecycle.
  mgr.stripsFor = (key) => mgr.strips.get(key);
  const noop = () => {};
  for (const name of [
    '_drawSky', 'drawDeepSky', '_drawCelestial', '_drawMoon', '_drawFarShore', '_drawFataMorgana',
    '_drawOcean', '_drawOceanLife', '_drawHorizonEQ', '_drawSpectrumMassif', '_drawDistantWave',
    '_drawHaze', '_drawCastShadow', '_drawFogBanks', '_drawConnectorHills', '_drawGround',
    '_drawTerrainFooting', '_drawFlood', '_drawForegroundSwell', '_drawTransitionOverlays',
  ]) mgr[name] = noop;
  mgr._moonPhase01 = () => 0.5;
  mgr.spaceRidge = Object.assign(new SpaceRidge(1), { draw: noop, drawAurora: noop,
    corridor: () => () => ({ top: -Infinity, bottom: -Infinity }) });
  mgr.lightning = { draw: noop };
  mgr.lightRig = { draw: noop };
  return mgr;
}

function ctx() {
  return {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    scale() {}, arc() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill() {},
    ellipse() {}, bezierCurveTo() {},
    globalAlpha: 1,
    fillStyle: '#000',
    save() {}, restore() {}, fillRect() {}, beginPath() {}, translate() {}, rotate() {},
  };
}

function scrollsOf(mgr) {
  const scrolls = [];
  mgr._drawLayer = (_c, _canvas, layerKey, scrollX) => { scrolls.push({ layerKey, scrollX }); };
  mgr.draw(ctx(), { width: VIEW, height: 720 }, WORLD_X, 0, null, 1, mgr._perf, null);
  return scrolls;
}

test('the draw path fits L3 to the scanned strip for a long song', () => {
  const mgr = manager();
  const scrolls = scrollsOf(mgr);
  const l3 = scrolls.find((s) => s.layerKey === 'L3');
  const fitted = terrainScrollPx({
    tSec: 240,
    curves: mgr.energyCurves,
    durationMs: mgr.durationMs,
    stripWidth: STRIP,
    depth: ridgeDepth(0.18, 0.10, 0),
    fit: { viewWidth: VIEW, maxDepth: ridgeDepth(0.30, 0.10, 0) },
  });
  const unfitted = WORLD_X * 0.18;
  assert.equal(l3.scrollX, fitted);
  assert.ok(fitted <= STRIP - VIEW, `fitted ${fitted} still has room`);
  assert.ok(unfitted > STRIP - VIEW, `unfitted ${unfitted} would clamp`);
  assert.notEqual(l3.scrollX, unfitted);
});

test('the draw path uses the canvas width, not the construction width', () => {
  const mgr = manager();
  const l3 = scrollsOf(mgr).find((s) => s.layerKey === 'L3').scrollX;
  const narrow = mgr._terrainScroll('L3', WORLD_X, mgr.w);
  assert.notEqual(l3, narrow);
  assert.equal(l3, mgr._terrainScroll('L3', WORLD_X, VIEW));
});

test('a missing L3 profile stays on parallax while the scanned neighbours stay fitted', () => {
  const mgr = manager({ terrainProfiles: { L2: { id: 'far' }, L4: { id: 'near' } } });
  const scrolls = scrollsOf(mgr);
  const byKey = Object.fromEntries(scrolls.map((s) => [s.layerKey, s.scrollX]));
  assert.equal(byKey.L3, WORLD_X * CodaDirector.delaminateRatio(0.18, 0));
  assert.notEqual(byKey.L2, WORLD_X * 0.10);
  assert.notEqual(byKey.L4, WORLD_X * 0.30);
});

test('a biome whose own ranges supply L3 is fitted even when the home set has no L3', () => {
  const profiles = { L3: { id: 'mid' } };
  const mgr = manager({
    terrainProfiles: null,
    songTerrain: { byBiome: new Map([['Home', { profiles }]]) },
  });
  const l3 = scrollsOf(mgr).find((s) => s.layerKey === 'L3').scrollX;
  assert.equal(l3, mgr._terrainScroll('L3', WORLD_X, VIEW));
  assert.notEqual(l3, WORLD_X * 0.18);
});
