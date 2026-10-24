import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bakeTerrain } from '../tools/lib/terrain-bake.mjs';
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

// Observe real backing allocations without retaining those backing arrays or
// changing their contents/prototypes. Fixtures are built before interception.
async function surfaceAllocations(run) {
  const originals = { Float32Array: globalThis.Float32Array, Uint8Array: globalThis.Uint8Array }, allocations = [];
  for (const [kind, Type] of Object.entries(originals)) globalThis[kind] = new Proxy(Type, {
    construct(target, args) {
      const array = Reflect.construct(target, args);
      allocations.push({ kind, bytes: array.byteLength });
      return array;
    },
  });
  try { return { result: await run(), allocations }; }
  finally { Object.assign(globalThis, originals); }
}

test('surface preparation eliminates the separate flow backing and reserves its actual nine-byte peak', async () => {
  const data = terrain();
  for (const stride of [1, 2, 4]) {
    const pixels = ((data.grid.width - 1) / stride + 1) ** 2;
    const { result: surface, allocations } = await surfaceAllocations(() => Mesh.buildSurfaceTexture(data, { stride }));
    assert.equal(allocations.reduce((n, a) => n + a.bytes, 0), pixels * 9, 'the real surface builder must allocate one fewer whole-grid byte backing');
    assert.equal(allocations.filter(a => a.kind === 'Uint8Array' && a.bytes === pixels).length, 1, 'only sample spacing needs a one-byte working lane');
    assert.equal(Mesh.SURFACE_BUILD_BYTES_PER_PIXEL * pixels, pixels * 9);
    const receiver = await surfaceAllocations(() => Mesh.buildReceiverMask(surface));
    assert.deepEqual(receiver.allocations, [{ kind: 'Uint8Array', bytes: pixels }]);
    assert.equal(surface.data.byteLength + receiver.result.data.byteLength, pixels * 5, 'receiver construction retains only RGBA plus its mask');
  }
});

test('surface cancellation never allocates GPU textures or resumes retired preparation', async () => {
  const data = terrain(), controller = new AbortController(); let uploads = 0, turns = 0;
  class Texture extends THREE.DataTexture { constructor(...args) { super(...args); uploads++; } }
  const checked = await surfaceAllocations(async () => {
    await assert.rejects(GL.createSurfaceTextureAsync({ ...THREE, DataTexture: Texture }, data, {
      sliceMs: 0, signal: controller.signal, yieldTo: async () => { turns++; controller.abort(); },
    }), { name: 'AbortError' });
  });
  assert.equal(turns, 1);
  assert.equal(uploads, 0);
  assert.ok(checked.allocations.reduce((n, a) => n + a.bytes, 0) <= data.grid.width * data.grid.height * 9, 'cancelled work stays within the same backing bound');
  const alreadyAborted = await surfaceAllocations(async () => {
    await assert.rejects(Mesh.buildSurfaceTextureAsync(data, { signal: controller.signal }), { name: 'AbortError' });
  });
  assert.deepEqual(alreadyAborted.allocations, []);
});

async function decodedSurfaceFixture() {
  const width = 65, height = 65, cellSizeM = 10, originM = [0, 0];
  const heightsM = new Float32Array(width * height), valid = new Uint8Array(width * height).fill(1);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    heightsM[j * width + i] = i < 25 ? 1000 : 1000 + 0.05 * i + 10 * Math.sin(i / 6) * Math.cos(j / 8) + 0.3 * Math.sin(i * 2 + j);
    if (i >= 48 && i <= 52 && j >= 30 && j <= 35) { valid[j * width + i] = 0; heightsM[j * width + i] = NaN; }
  }
  const grid = { width, height, cellSizeM, originM, heightsM, valid,
    horizontalCrs: 'synthetic', verticalReference: 'synthetic', sourceResolutionM: 10, outputSpacingM: 10 };
  const camera = { eyeStartM: [320, 1600, 1600], eyeEndM: [320, 1600, 1600], targetStartM: [320, 1000, 320], targetEndM: [320, 1000, 320], fovYDeg: 60 };
  const baked = await bakeTerrain(grid, { id: 'surface-fixture', camera }, { tileCells: 16, keepHidden: true });
  return Mesh.decodeTerrain(baked.manifest, baked.decoded);
}

// Recorded from the e07 original surface builder before the allocation change.
const surfaceGolden = [
  [1, 'afcdfae93fb917f50e4004ff502f9cc4b3207f3f1f70b4f39f5d34bcc9aeffc6', '9330859f8ce9bcd6589278681c0720541c5ec85a4fa743f59662d000968df5c5'],
  [2, '804573a63000d64e23d0117029b30a462f1e16eadceee33739e36bb6bc17c184', 'e437bf5569a7b5ba3f6f43eaf0b8ead5ad159d9f369f2e699cffee41be74d4ca'],
  [4, '20f8a57d464aca6f98392e572c18e61ff89b1caf9e8efa941e719ede595474a8', 'a254441026837219dfc6ee54d40450ff5f9cd957f0d0abff11fa965c6b8a322b'],
];
test('decoded shoreline, no-data and mixed-LOD surfaces preserve original bytes in synchronous and sliced builds', async () => {
  const data = await decodedSurfaceFixture(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.ok(new Set([...data.tiles.values()].map(t => t.stride)).size > 1);
  assert.ok([...data.tiles.values()].some(t => t.heightsM.some(h => !Number.isFinite(h))));
  assert.ok([...data.tiles.values()].some(t => t.flowBytes.includes(255)));
  for (const [stride, surfaceSha, receiverSha] of surfaceGolden) {
    const surface = Mesh.buildSurfaceTexture(data, { stride });
    assert.equal(hash(surface.data), surfaceSha);
    assert.equal(hash(Mesh.buildReceiverMask(surface).data), receiverSha);
    const sliced = await Mesh.buildSurfaceTextureAsync(data, { stride, sliceMs: 0, yieldTo: async () => {} });
    assert.deepEqual(sliced, surface);
    assert.equal(hash((await Mesh.buildReceiverMaskAsync(sliced, { sliceMs: 0, yieldTo: async () => {} })).data), receiverSha);
  }
});
