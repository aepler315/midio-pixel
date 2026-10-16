import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitRidgeComposition, horizonEqPoints, compositionMetrics, projectStripCrest, massifShapeScale,
} from '../src/world/alpine/RidgeComposition.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { mountainStripDrawHeight } from '../src/world/MountainChoreo.js';

const stage = { width: 1408, height: 848, viewLeft: 64, viewWidth: 1280, viewTop: 64,
  viewHeight: 720, groundY: 689, footY: 776 };

function strip(heights, layerHeight = 360, baseline = 0.52, amplitude = 0.47) {
  const step = 4, width = 8192;
  const ridgeYs = Float32Array.from({ length: width / step + 1 }, (_, i) => {
    const u = i / (width / step);
    const h = typeof heights === 'function' ? heights(u) : heights;
    return layerHeight * (baseline - amplitude * h);
  });
  return { width, height: layerHeight, ridge: { step, ridgeYs, source: 'terrain' } };
}

test('a broad high middle scan is assigned a lower fixed supporting fit', () => {
  const far = strip((u) => 0.5 + 0.42 * Math.sin(u * 31), 400, .44, .405);
  const wall = strip(0.88);
  const near = strip((u) => 0.45 + .2 * Math.sin(u * 50), 330, .66, .358);
  const fit = fitRidgeComposition({ strips: { L2: far, L3: wall, L4: near }, stage });
  assert.ok(fit.scales.L3 < 0.8, `wall should support the far skyline: ${fit.scales.L3}`);
  assert.ok(fit.scales.L2 >= fit.scales.L3, 'far ridge must retain its role');
  assert.ok(fit.metrics.midAreaP90 <= .21, `wall occupied ${fit.metrics.midAreaP90}`);
});

test('an interesting middle scan retains more height than the broad wall', () => {
  const far = strip((u) => 0.5 + 0.42 * Math.sin(u * 31), 400, .44, .405);
  const wall = strip(0.88);
  const peaks = strip((u) => 0.18 + 0.72 * Math.max(0, Math.sin(u * 48)) ** 8);
  const wallFit = fitRidgeComposition({ strips: { L2: far, L3: wall }, stage });
  const peakFit = fitRidgeComposition({ strips: { L2: far, L3: peaks }, stage });
  assert.ok(peakFit.scales.L3 > wallFit.scales.L3 + .05);
});

test('a broad far scan gives back body area while a broken dancing skyline stays tall', () => {
  const wall = strip((u) => .79 + .02 * Math.sin(u * 9), 400);
  const peaks = strip((u) => .20 + .74 * Math.max(0, Math.sin(u * 45)) ** 8, 400);
  const wallFit = fitRidgeComposition({ strips: { L2: wall }, stage });
  const peakFit = fitRidgeComposition({ strips: { L2: peaks }, stage });
  assert.ok(wallFit.scales.L2 < .9, `broad L2 kept scale ${wallFit.scales.L2}`);
  assert.ok(peakFit.scales.L2 > wallFit.scales.L2 + .1);
  assert.ok(wallFit.metrics.farAreaP90 < .28);
});

test('a brief supporting wall cannot hide the far ridge between good stations', () => {
  const far = strip(.5, 400);
  const mid = strip(.88);
  const fit = fitRidgeComposition({ strips: { L2: far, L3: mid }, stage,
    heightAt: (key, songP, scales) => (key === 'L2' ? 360 : songP < .09 ? 350 : 200) * scales[key],
  });
  assert.ok(fit.metrics.samples.every(s => s.L2.fraction >= .55),
    'a percentile must not conceal a short fully obscured stretch');
});

test('visibility fitting lowers the actual near blocker instead of an already quiet middle ridge', () => {
  const fit = fitRidgeComposition({ strips: { L2: strip(.5, 400), L3: strip(.5), L4: strip(.88) }, stage,
    heightAt: (key, songP, scales) => (key === 'L2' ? 360 : key === 'L3' ? 150 : songP < .09 ? 350 : 200) * scales[key],
  });
  assert.ok(fit.metrics.samples.every(s => s.L2.fraction >= .55));
  assert.equal(fit.scales.L3, 1);
  assert.ok(fit.scales.L4 < 1);
});

test('visibility fitting continues with another blocker when the dominant layer reaches its minimum', () => {
  const piece = (height) => ({ width: 100, height: 100,
    ridge: { step: 1, source: 'terrain',
      ridgeYs: Float32Array.from({ length: 101 }, (_, i) => height(i)) } });
  const fit = fitRidgeComposition({
    strips: { L2: piece(() => 0), L3: piece(i => i < 30 ? 0 : 100),
      L4: piece(i => i >= 30 && i < 55 ? 0 : 100) },
    stage: { width: 100, height: 1000, viewLeft: 0, viewWidth: 100,
      viewHeight: 1000, footY: 300, groundY: 200 },
    heightAt: (key, songP, scales) => ({ L2: 100, L3: 400, L4: 200 }[key]) * scales[key],
  });
  assert.equal(fit.scales.L3, .35);
  assert.ok(fit.scales.L4 < 1, 'an adjustable secondary blocker still needs to yield');
  assert.ok(fit.metrics.farVisibleMin >= .55);
});

test('projected source motion preserves sample order and shares one foot anchored scale', () => {
  const shape = strip((u) => u, 360, .52, .47);
  const a = projectStripCrest(shape, 0, 180, stage, 8);
  const b = projectStripCrest(shape, 1200, 180, stage, 8);
  assert.ok(b[0].y < a[0].y, 'scroll moves through the actual rising source');
  const tall = projectStripCrest(shape, 0, 300, stage, 8);
  for (let i = 0; i < a.length; i++) {
    const aRise = stage.footY - a[i].y;
    const tallRise = stage.footY - tall[i].y;
    assert.ok(Math.abs(tallRise / aRise - 300 / 180) < 1e-4);
  }
});

test('visibility uses actual x coverage and distinguishes side geometry', () => {
  const hero = [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
  const partial = [{ x: 0, y: 80 }, { x: 50, y: 80 }];
  const sideA = compositionMetrics({ horizon: hero, ridges: { L3: partial }, width: 100 });
  const sideB = compositionMetrics({ horizon: hero, ridges: { L3: [{ x: 0, y: 120 }, { x: 100, y: 120 }] }, width: 100 });
  assert.ok(sideA.horizon.fraction > 0 && sideA.horizon.fraction < 1);
  assert.equal(sideB.horizon.fraction, 1);
});

test('composition body area ends at the fixed rendered ground, excluding overscan', () => {
  const manager = Object.create(BiomeManager.prototype);
  const points = [{ x: 64, y: 500 }, { x: 1344, y: 500 }];
  manager.h = 720;
  manager.groundY = 625;
  manager._landscapeGeometry = { horizon: points, massif: [], sides: {}, metrics: {} };
  manager.stripsFor = () => ({ L2: {} });
  manager._crestPoints = () => ({ pts: points });
  const profile = { name: 'fixture' };
  manager._recordLandscapeGeometry({ width: 1408, height: 848 }, { L2: 0 }, profile, profile);
  assert.equal(manager._landscapeGeometry.metrics.from.area.L2, 125 / 720,
    'the 64px shake reserve is not visible mountain body');
  // Pullback scales scenery while the rendered ground stays fixed.
  for (const p of points) p.y = 64 + (p.y - 64) * 1000 / 720;
  manager._recordLandscapeGeometry({ width: 1906, height: 1128 }, { L2: 0 }, profile, profile);
  assert.ok(Math.abs(manager._landscapeGeometry.metrics.from.area.L2 - 125 / 720) < 1e-10);
});

test('quiet and live horizon points use the same real crest and horizontal travel', () => {
  const crest = { heights: Float32Array.from([.3, .8, .5, 1, .3]), stepM: 100, windowM: 300, travelM: 100 };
  const quiet = horizonEqPoints({ width: 400, height: 200, crest, songP: 0, bands: new Float32Array(7), tSec: 0 });
  const loud = horizonEqPoints({ width: 400, height: 200, crest, songP: 0, bands: Float32Array.from({ length: 7 }, () => 1), tSec: 0 });
  const later = horizonEqPoints({ width: 400, height: 200, crest, songP: 1, bands: new Float32Array(7), tSec: 0 });
  assert.ok(loud[20].y < quiet[20].y);
  assert.notEqual(later[20].y, quiet[20].y);
});

test('a broad real massif yields less body area while a broken summit keeps its height', () => {
  const wall = { heights: Float32Array.from({ length: 80 }, (_, i) => i < 9 || i > 70 ? .3 : .85) };
  const peaks = { heights: Float32Array.from({ length: 80 }, (_, i) => .3 + .7 * Math.max(0, Math.sin(i * .78))) };
  assert.ok(massifShapeScale(wall) < .8);
  assert.ok(massifShapeScale(peaks) > .95);
});

test('the first massif frame has a finite constructor fit before any range draws', () => {
  const manager = new BiomeManager({
    conductor: { barGrid: [], onBar: () => () => {}, on: () => () => {} },
    durationMs: 1000, canvasWidth: 1280, canvasHeight: 720, groundY: 625,
    songSeed: 1, worldId: 'range',
  });
  const geometry = manager._massifGeometry({ width: 1280, height: 720 }, 0,
    Float32Array.from({ length: 7 }, () => .3));
  assert.ok(Number.isFinite(manager._massifShapeScale));
  assert.ok(geometry.ridgePts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  manager.dispose();
});

test('the fixed composition fit is alpine-only and preview keeps the source inspection height', () => {
  const manager = Object.create(BiomeManager.prototype);
  const shape = strip(.88);
  manager._zoomedGroundY = () => 625;
  manager._growthMul = () => 1;
  manager._compositionFor = () => ({ scales: { L3: .5 } });
  manager._heightStrips = { L3: shape };
  const canvas = { width: 1280, height: 720 };
  const natural = mountainStripDrawHeight(shape.height, 1, 720, 625);
  manager.world = { kind: 'city' };
  assert.equal(manager._rangeDh(canvas, shape, 'L3', 1, false), natural);
  manager.world = { kind: 'alpine' };
  assert.equal(manager._rangeDh(canvas, shape, 'L3', 1, false), Math.min(natural, 720 * .42) * .5);
  assert.equal(manager._rangeDh(canvas, shape, 'L3', 1, true), natural);
});
