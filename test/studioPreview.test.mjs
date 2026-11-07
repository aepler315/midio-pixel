import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { TerrainPreview, decodeTerrariumRgba, decodeTerrainRecord, terrainPlan, resampleTerrain } from '../src/studio/TerrainPreview.js';
import { defaultCamera } from '../src/studio/CameraEditor.js';
import { renderScoutPreview, sampleScoutHeight } from '../src/studio/ScoutRender.js';

test('Terrarium decodes signed elevations and fractional metres without color rescaling', () => {
  const tile = decodeTerrariumRgba({ width: 2, height: 2, data: new Uint8ClampedArray([
    128, 0, 0, 255, 127, 255, 128, 255,
    151, 41, 64, 255, 128, 0, 0, 0,
  ]) });
  assert.deepEqual([...tile.heightsM].slice(0, 3), [0, -0.5, 5929.25]);
  assert.ok(Number.isNaN(tile.heightsM[3]), 'transparent data remains missing terrain');
});

test('all available catalog cameras have a bounded real-terrain request including polar views', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../src/assets/view-discovery/catalog.json', import.meta.url)));
  const available = catalog.candidates.filter(candidate => candidate.camera);
  assert.equal(available.length, 641);
  for (const candidate of available) {
    const plan = terrainPlan(candidate);
    const { lon, lat } = candidate.camera.eye;
    assert.ok(plan.tiles.length > 0 && plan.tiles.length <= 16, candidate.id);
    assert.ok(lon > plan.west && lon < plan.east && lat > plan.south && lat < plan.north, candidate.id);
    assert.ok(plan.width * plan.height <= 256 * 256, candidate.id);
    assert.ok((plan.east - lon) * 111320 * Math.cos(lat * Math.PI / 180) >= 39999, candidate.id);
  }
  assert.throws(() => terrainPlan(catalog.candidates.find(candidate => !candidate.camera)), /camera/i);
});

test('resampling preserves a real decoded tile elevation and leaves missing source data missing', () => {
  const plan = { west: -1, east: 1, south: -1, north: 1, zoom: 0, width: 3, height: 3 };
  const heightsM = new Float32Array(256 * 256).fill(1234.5);
  const grid = resampleTerrain(plan, new Map([['0/0', { width: 256, height: 256, heightsM }]]));
  assert.ok([...grid.heightsM].every(value => value === 1234.5));
  assert.equal(sampleScoutHeight(grid, 0, 0), 1234.5);
  assert.ok(Number.isNaN(sampleScoutHeight(grid, 2, 0)));
  const missing = resampleTerrain(plan, new Map());
  assert.ok([...missing.heightsM].every(Number.isNaN));
});

test('bundled terrain restores signed metres, missing data and strict dimensions', async () => {
  const bytes = Buffer.alloc(8);
  [5929, -15, -32768, 1250].forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  const record = { schema: 'midio.studio-terrain', version: 1, encoding: 'gzip-int16-le', width: 2, height: 2,
    west: -1, east: 1, south: -1, north: 1, cellM: 1000, zoom: 9, source: 'AWS Terrarium', noDataValue: -32768,
    data: gzipSync(bytes).toString('base64') };
  const grid = await decodeTerrainRecord(record);
  assert.equal(grid.heightsM[0], 5929);
  assert.equal(grid.heightsM[1], -15);
  assert.ok(Number.isNaN(grid.heightsM[2]));
  assert.equal(grid.heightsM[3], 1250);
  assert.equal(grid.centerLon, 0);
  await assert.rejects(decodeTerrainRecord({ ...record, height: 3 }), /truncated/);
  await assert.rejects(decodeTerrainRecord({ ...record, data: gzipSync(Buffer.alloc(20)).toString('base64') }), /declared grid size/);
});

test('the browser renderer changes perspective while stopping rays at real terrain boundaries', () => {
  const width = 33, height = 33;
  const heightsM = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    heightsM[y * width + x] = x < 16 ? 1200 : 100;
  }
  const grid = { width, height, heightsM, west: -0.1, east: 0.1, south: -0.1, north: 0.1 };
  const camera = { eye: { lon: 0, lat: -0.05, aboveGroundM: 300 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 };
  const north = renderScoutPreview(grid, camera, { width: 64, height: 36, maxDistanceM: 36000 });
  const west = renderScoutPreview(grid, { ...camera, headingDeg: 270 }, { width: 64, height: 36, maxDistanceM: 36000 });
  assert.notDeepEqual(north.rgba, west.rgba);
  assert.ok(north.coverage < 0.6);
  assert.match(north.warning, /boundary/i);
  assert.ok(north.rgba.every((value, index) => index % 4 !== 3 || value === 255));
});

test('switching live candidates while materials load paints only the current terrain and disposal stops edits', async () => {
  const original = { fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame, ImageData: globalThis.ImageData };
  const pending = new Map(), paints = [], statuses = [], analyses = [];
  globalThis.fetch = url => new Promise(resolve => pending.set(String(url), resolve));
  globalThis.requestAnimationFrame = callback => setImmediate(callback);
  globalThis.cancelAnimationFrame = clearImmediate;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const canvas = { getContext: () => ({ putImageData: data => paints.push(data) }) };
  const preview = new TerrainPreview({ canvas, onStatus: value => statuses.push(value), onAnalysis: value => analyses.push(value) });
  const candidate = id => ({ id, biome: 'CONIFER', camera: { eye: { lon: 0, lat: 0, aboveGroundM: 300 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 }, provenance: { style: { materialId: id } } });
  const grid = value => ({ width: 33, height: 33, heightsM: new Float32Array(33 * 33).fill(value), west: -0.5, east: 0.5,
    south: -0.5, north: 0.5, centerLon: 0, centerLat: 0, cellM: 3000, tileCount: 4, zoom: 8 });
  try {
    assert.equal(pending.size, 0, 'constructing a preview performs no network requests');
    const abandoned = preview.useGrid(candidate('wet-conifer'), grid(100)).then(() => 'painted stale view', error => error.name);
    const currentGrid = grid(700);
    const current = preview.useGrid(candidate('dry-conifer'), currentGrid);
    const finishMaterial = id => {
      const material = JSON.parse(fs.readFileSync(new URL(`../src/assets/range/v2/materials/${id}.json`, import.meta.url)));
      const key = [...pending.keys()].find(value => value.endsWith(`/${id}.json`));
      pending.get(key)({ ok: true, json: async () => material });
    };
    finishMaterial('dry-conifer');
    await current;
    finishMaterial('wet-conifer');
    assert.equal(await abandoned, 'AbortError');
    assert.equal(preview.grid, currentGrid);
    assert.equal(preview.ready, true);
    assert.equal(paints.length, 1);
    assert.equal(analyses.at(-1).groundM, 700);
    assert.equal(statuses.at(-1), 'Live terrain ready');
    preview.setCamera({ lon: 1, lat: 0, aboveGroundM: 300, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 });
    await preview.useGrid(candidate('dry-conifer'), grid(900));
    await new Promise(resolve => setTimeout(resolve, 240));
    assert.equal(preview.ready, true, 'a position edit from the previous view cannot restart a later selection');
    assert.equal(analyses.at(-1).groundM, 900);
    const paintedBeforeDisposal = paints.length;
    preview.dispose();
    preview.setProgress(0.75);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(paints.length, paintedBeforeDisposal);
    assert.equal(preview.grid, null);
    assert.equal(preview.ready, false);
  } finally {
    preview.dispose();
    Object.assign(globalThis, original);
  }
});

test('exact capture paints the requested camera and rejects an older worker frame before normal rendering resumes', async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame, ImageData: globalThis.ImageData };
  const paints = [], workers = [];
  globalThis.Worker = class {
    constructor() { this.requests = []; workers.push(this); }
    postMessage(message) { if (message.type === 'render') this.requests.push(message); }
    terminate() {}
  };
  globalThis.fetch = async url => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(url))) });
  globalThis.requestAnimationFrame = callback => setImmediate(callback);
  globalThis.cancelAnimationFrame = clearImmediate;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const candidate = { id: 'capture', biome: 'CONIFER', camera: { eye: { lon: 0, lat: -0.05, aboveGroundM: 300 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 }, provenance: { style: { materialId: 'icefield' } } };
  const heightsM = new Float32Array(33 * 33);
  for (let y = 0; y < 33; y++) for (let x = 0; x < 33; x++) heightsM[y * 33 + x] = x < 16 ? 1200 : 100;
  const grid = { width: 33, height: 33, heightsM, west: -0.5, east: 0.5, south: -0.5, north: 0.5 };
  const preview = new TerrainPreview({ canvas: { getContext: () => ({ putImageData: data => paints.push(data) }) } });
  const untilRequest = async count => {
    for (let attempt = 0; attempt < 20 && workers[0].requests.length < count; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(workers[0].requests.length >= count);
    return workers[0].requests[count - 1];
  };
  try {
    const loading = preview.useGrid(candidate, grid);
    const old = await untilRequest(1);
    const oldPixels = renderScoutPreview(grid, old.camera, old.options);
    preview.setCamera({ ...defaultCamera(candidate), headingDeg: 90 });
    assert.equal(preview.renderExact(0.75), true);
    await loading;
    assert.notDeepEqual(paints[0].data, oldPixels.rgba);
    workers[0].onmessage({ data: { id: old.id, epoch: old.epoch, result: oldPixels, renderMs: 1 } });
    assert.equal(paints.length, 1, 'a late interactive frame cannot overwrite the captured camera');
    preview.setProgress(0.8);
    const next = await untilRequest(2);
    workers[0].onmessage({ data: { id: next.id, epoch: next.epoch, result: renderScoutPreview(grid, next.camera, next.options), renderMs: 1 } });
    assert.equal(paints.length, 2);
    assert.equal(preview.ready, true);
  } finally { preview.dispose(); Object.assign(globalThis, original); }
});
