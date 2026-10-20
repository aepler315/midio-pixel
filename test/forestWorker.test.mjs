import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('terrain worker client and runtime survive case-insensitive staging', async () => {
  const directory = new URL('../src/world/alpine/', import.meta.url);
  const names = await fs.readdir(directory);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length,
    'a Windows checkout must retain every distinct terrain module');
  const client = await fs.readFile(new URL('TerrainWindowWorkerClient.js', directory), 'utf8');
  assert.match(client, /new URL\('\.\/terrainWindowWorker\.js',\s*import\.meta\.url\)/);
  assert.ok(names.includes('terrainWindowWorker.js'));
});

test('tour worker transfers all three forest lanes exactly once and count includes detail', async () => {
  const source = await fs.readFile(new URL('../src/world/alpine/terrainWindowWorker.js', import.meta.url), 'utf8');
  const placed = { meshDetail: new Float32Array(8), mesh: new Float32Array(16), billboard: new Float32Array(24), stride: 8, count: 6 };
  const built = { bands: { near: { positions: new Float32Array(9), indices: new Uint16Array(3), fringe: new Float32Array(9) } } };
  let result;
  const self = { postMessage(message, transfer) { result = { message, transfer }; } };
  vm.runInNewContext(source.replace(/import[^;]+;/g, ''), { self, placeForest: () => placed,
    planTerrainWindow: () => ({ strides: new Map(), visible: new Set() }), buildTerrainGeometry: () => built,
    restoreTourTimeline: x => x });
  self.onmessage({ data: { kind: 'init', tour: {}, data: {}, view: {}, rules: {}, seed: 315 } });
  self.onmessage({ data: { id: 3, index: 0, options: {} } });
  assert.equal(result.message.placed.count, 6);
  assert.equal(result.message.error, undefined);
  for (const a of Object.values(placed).filter(ArrayBuffer.isView)) assert.equal(result.transfer.filter(b => b === a.buffer).length, 1);
  assert.equal(new Set(result.transfer).size, result.transfer.length);
});
