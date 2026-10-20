import test from 'node:test';
import assert from 'node:assert/strict';
import * as windows from '../src/world/alpine/TerrainWindow.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';

const pose = { eyeM: [2000, 1000, 12000], targetM: [2000, 1000, 0], fovYDeg: 40 };
const tour = { durationMs: 16000, poseAt: () => pose };
function terrain() {
  const tiles = new Map();
  for (let x = 0; x < 6; x++) tiles.set(`${x}`, { id: `${x}`, ix: x, iz: 0, stride: 1,
    band: 'far', minY: 1000, maxY: 1008, flowBytes: new Uint8Array(4),
    errorsM: { 1: 0, 2: 1, 4: 2, 8: 7, 16: 80, 32: 300, 64: 900 } });
  return { cells: 64, grid: { originM: [-2000, -640], cellSizeM: 20 }, tiles,
    byIndex: new Map([...tiles.values()].map(t => [`${t.ix},${t.iz}`, t])),
    manifest: { boundsM: { min: [-2000, 0, -640], max: [5680, 10000, 640] } } };
}

test('Classic terrain discards more unresolved interior triangles than Detailed within native pixel error', () => {
  const data = terrain(), base = windows.planTerrainWindow(data, tour, 0);
  const classic = windows.planTerrainWindow(data, tour, 0, { pixelHeightPx: 180 });
  const detailed = windows.planTerrainWindow(data, tour, 0, { pixelHeightPx: 360 });
  assert.ok(classic.triangles < base.triangles, 'pixel planning must actually remove unresolved geometry');
  assert.ok(detailed.triangles >= classic.triangles);
  assert.ok(detailed.triangles <= base.triangles, 'Detailed can retain grids already too coarse to simplify further');
  assert.ok(classic.pixelCoarsenedTiles > 0);
  assert.ok(classic.maxErrorPx <= .25 + 1e-6, 'reported error is in final native pixels');
  assert.ok(detailed.pixelCoarsenedMaxErrorPx <= .25 + 1e-6);
  assert.equal(classic.detailHeightPx, 180);
  assert.deepEqual(classic.visible, base.visible, 'pixel size never narrows geographic coverage');
  assert.deepEqual(classic.poses, base.poses, 'the camera and its coverage are unchanged');
});

test('near roots on a far-band terrain tile retain their reference ground and seam ring', () => {
  const data = terrain(), route = { durationMs: 8000, poseAt: () => ({ ...pose, eyeM: [0, 1000, 0] }) };
  const base = windows.planTerrainWindow(data, route, 0);
  const pixel = windows.planTerrainWindow(data, route, 0, { pixelHeightPx: 180 });
  for (const id of ['0', '1', '2']) assert.equal(pixel.strides.get(id), base.strides.get(id));
  assert.ok(pixel.pixelProtectedTiles >= 3, 'near roots are located from the route, independently of terrain bands');
});

test('pixel coarsening retains summit, shoreline, near terrain and their seam neighbours', () => {
  const data = terrain();
  data.tiles.get('0').flowBytes[0] = 255;
  data.tiles.get('5').band = 'near';
  assert.equal(typeof windows.terrainPixelProtection, 'function');
  const protectedIds = windows.terrainPixelProtection(data, ['3']);
  for (const id of ['0', '1', '2', '3', '4', '5']) assert.ok(protectedIds.includes(id), id);
  const base = windows.planTerrainWindow(data, tour, 0, { protectedTileIds: ['3'] });
  const pixel = windows.planTerrainWindow(data, tour, 0, {
    protectedTileIds: ['3'], pixelHeightPx: 180, pixelProtectedTileIds: protectedIds,
  });
  assert.deepEqual(pixel.strides, base.strides, 'protected geometry keeps the existing measured grids');
});

test('grid changes invalidate prepared terrain even when scenic coverage is unchanged', () => {
  const viewport = { nominalWidth: 1280, nominalHeight: 720, overscanPx: 64 };
  const p = { windowCache: { invalidate() {} }, windowOptions: {}, rawAhead: new Map() };
  const scene = Object.assign(Object.create(RangeScene.prototype), { pixelated: true, pixelHeightPx: 180 });
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  const first = p.coverageRevision;
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  assert.equal(p.coverageRevision, first, 'ordinary frames reuse the plan');
  scene.pixelHeightPx = 360;
  scene._updateTourCoverage(p, { scenicViewport: viewport });
  assert.ok(p.coverageRevision > first, 'Detailed must not adopt a Classic worker result');
  assert.equal(p.windowOptions.pixelHeightPx, 360);
});

test('native detail includes musical land curvature on an otherwise almost planar ridge', () => {
  const tile = { id: 'wave', ix: 0, iz: 0, stride: 1, minY: 2000, maxY: 2005.5,
    errorsM: { 1: 0, 2: 0, 4: 0, 8: 0, 16: 0, 32: 0, 64: 5.5 } };
  const data = { cells: 64, grid: { originM: [0, 0], cellSizeM: 20 }, tiles: new Map([['wave', tile]]),
    byIndex: new Map([['0,0', tile]]), manifest: { boundsM: { min: [0, -1000, 0], max: [1280, 2005.5, 1280] } } };
  const route = { durationMs: 8000, poseAt: () => ({ eyeM: [640, 2000, 8000], targetM: [640, 2000, 0], fovYDeg: 40 }) };
  const pixel = windows.planTerrainWindow(data, route, 0, { pixelHeightPx: 180 });
  assert.ok(pixel.strides.get('wave') < 64, 'a permitted 144m land swell makes the coarse cell differ by more than a native pixel');
});
