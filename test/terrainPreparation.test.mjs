import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Mesh from '../src/world/alpine/TerrainMesh.js';
import * as Features from '../src/world/alpine/TerrainFeatures.js';
import * as GL from '../src/world/alpine/TerrainGL.js';
import * as THREE from '../src/vendor/range/three-range.module.js';

function terrain() {
  const cells = 32, samples = cells + 1;
  const heightsM = Float32Array.from({length:samples*samples}, (_,i) => Math.sin(i % samples / 7) * 240 + Math.cos(Math.floor(i / samples) / 9) * 300);
  const flowBytes = Uint8Array.from(heightsM, (_,i) => i % 23 < 5 ? 255 : i % 255);
  return {cells,grid:{width:samples,height:samples,cellSizeM:10,originM:[0,0]},tiles:new Map([['0,0',{ix:0,iz:0,stride:1,samples,heightsM,flowBytes}]])};
}

test('live surface preparation yields and keeps every shoreline, normal and receiver byte', async () => {
  assert.equal(typeof Mesh.buildSurfaceTextureAsync, 'function');
  assert.equal(typeof Mesh.buildReceiverMaskAsync, 'function');
  const data=terrain();
  for (const stride of [1,2,4]) {
    let turns=0;const options={stride,sliceMs:0,yieldTo:async()=>{turns++;}};
    const expected=Mesh.buildSurfaceTexture(data,{stride}), actual=await Mesh.buildSurfaceTextureAsync(data,options);
    assert.deepEqual(actual,expected);assert.ok(turns>1,'the surface must allow frames between rows');
    turns=0;assert.deepEqual(await Mesh.buildReceiverMaskAsync(actual,options),Mesh.buildReceiverMask(expected));
    assert.ok(turns>1,'both receiver sweeps must allow frames');
  }
});

test('live feature extraction yields while preserving reservoir order and no-data rejection', async () => {
  assert.equal(typeof Features.terrainFeatureSegmentsAsync,'function');
  const positions=new Float32Array([0,0,0,100,800,0,100,900,100,0,NaN,100]);
  const indices=Uint32Array.from({length:18000},(_,i)=>[0,1,2,0,2,3][i%6]);
  let turns=0;const options={intervalM:100,maxSegments:24,sliceMs:0,yieldTo:async()=>{turns++;}};
  assert.deepEqual(await Features.terrainFeatureSegmentsAsync(positions,indices,options),Features.terrainFeatureSegments(positions,indices,options));
  assert.ok(turns>2,'large geometry must not monopolize the event loop');
});

test('cancelled preparation stops before another slice or GPU allocation', async () => {
  assert.equal(typeof GL.createSurfaceTextureAsync,'function');
  const controller=new AbortController();let turns=0;
  const options={sliceMs:0,signal:controller.signal,yieldTo:async()=>{turns++;controller.abort();}};
  await assert.rejects(GL.createSurfaceTextureAsync(THREE,terrain(),options),{name:'AbortError'});
  assert.equal(turns,1,'cancel the unpublished preparation immediately');
  let checks=0;
  await assert.rejects(Mesh.buildSurfaceTextureAsync(terrain(),{sliceMs:0,checkCurrent:()=>{if(++checks===3)throw new Error('retired owner');},yieldTo:async()=>{}}),/retired owner/);
});

test('async GPU surface retains the same textures, ownership cost and CPU release behavior', async () => {
  assert.equal(typeof GL.createSurfaceTextureAsync,'function');
  const data=terrain(), expected=GL.createSurfaceTexture(THREE,data),actual=await GL.createSurfaceTextureAsync(THREE,data,{sliceMs:0,yieldTo:async()=>{}});
  try {
    assert.equal(actual.bytes,expected.bytes);
    for (const key of ['texture','receiverTexture']) {
      assert.deepEqual(actual[key].image,expected[key].image);
      for (const p of ['format','type','colorSpace','minFilter','magFilter','generateMipmaps','flipY'])assert.equal(actual[key][p],expected[key][p]);
      actual[key].onUpdate();assert.equal(actual[key].image.data,null);
    }
  } finally {for(const v of [expected,actual]){v.texture.dispose();v.receiverTexture.dispose();}}
});

test('tour geometry finalization yields between bands while preserving every buffer and bounds', async () => {
  assert.equal(typeof GL.createBandGeometriesAsync, 'function');
  const built = { bands: Object.fromEntries(['far', 'mid', 'near'].map((b, i) => [b, {
    positions: new Float32Array([0, 0, 0, 10, i + 1, 0, 0, 0, 10]), indices: new Uint32Array([0, 1, 2]), fringe: new Uint32Array([0, 1, 2]),
  }])), stats: { triangles: 3 } };
  let turns = 0;
  const expected = GL.createBandGeometries(THREE, null, { built });
  const actual = await GL.createBandGeometriesAsync(THREE, null, { built, yieldTo: async () => { turns++; } });
  assert.ok(turns >= 2, 'graphics construction must leave opportunities to deliver frames');
  assert.equal(actual.bytes, expected.bytes);
  for (const b of ['far', 'mid', 'near']) {
    assert.deepEqual(actual.geometries[b].attributes.position.array, expected.geometries[b].attributes.position.array);
    assert.deepEqual(actual.geometries[b].index.array, expected.geometries[b].index.array);
    assert.deepEqual(actual.geometries[b].boundingSphere, expected.geometries[b].boundingSphere);
    actual.geometries[b].dispose(); actual.fringes[b].dispose();
    expected.geometries[b].dispose(); expected.fringes[b].dispose();
  }
});

test('retired staged geometry releases constructed buffers before the next band', async () => {
  assert.equal(typeof GL.createBandGeometriesAsync, 'function');
  const built = { bands: Object.fromEntries(['far', 'mid', 'near'].map(b => [b, {
    positions: new Float32Array(), indices: new Uint32Array(), fringe: new Uint32Array(),
  }])), stats: {} };
  const controller = new AbortController(); let created = 0, disposed = 0;
  class Geometry extends THREE.BufferGeometry {
    constructor() { super(); created++; this.addEventListener('dispose', () => disposed++); }
  }
  await assert.rejects(GL.createBandGeometriesAsync({ ...THREE, BufferGeometry: Geometry }, null, {
    built, signal: controller.signal, yieldTo: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(created, 1);
  assert.equal(disposed, 1);
});
