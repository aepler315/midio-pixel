import {test} from'node:test';import assert from'node:assert/strict';import{planTerrainWindow,TourWindowCache}from'../src/world/alpine/TerrainWindow.js';
const fixture=()=>({grid:{originM:[-1280,-1280],cellSizeM:20,width:129,height:129},cells:64,tiles:new Map([...Array(4)].map((_,i)=>[`t${i}`,{id:`t${i}`,ix:i%2,iz:Math.floor(i/2),stride:1,minY:0,maxY:100,errorsM:{1:0,2:1,4:3,8:10,16:30,32:100,64:300}}]))});
const poseAt=t=>({eyeM:[0,500,5000-t/10],targetM:[0,50,0],fovYDeg:40});
const buildFixture=()=>{
 const data=fixture();data.byIndex=new Map();
 for(const tile of data.tiles.values()){
  Object.assign(tile,{visible:true,samples:65,band:'far',heightsM:new Float32Array(65*65),flowBytes:new Uint8Array(65*65),validMask:new Uint8Array(65*65).fill(1)});
  data.byIndex.set(`${tile.ix},${tile.iz}`,tile);
 }
 return{data,rules:{treelineM:3000},windowOptions:{},view:{id:'test',tour:{poseAt,durationMs:60000}}};
};
test('route windows union widened frustums and select coarsest measured safe strides',()=>{
 const p=planTerrainWindow(fixture(),{poseAt,durationMs:30000},0,{heightPx:1080});
 assert.equal(p.strides.size,4);assert.ok(p.triangles<=1500000);assert.ok(p.maxErrorPx<=1+.0001);
 const mobile=planTerrainWindow(fixture(),{poseAt,durationMs:30000},0,{budget:'mobile',heightPx:720});assert.ok(mobile.triangles<=p.triangles);
 const coarse=planTerrainWindow(fixture(),{poseAt,durationMs:30000},0,{bias:2});assert.ok(coarse.triangles<=p.triangles);
});
test('window cache bounds resident meshes, disposes replaced/stale results and handles far seeks',async()=>{
 const disposed=[],cache=new TourWindowCache({build:async index=>({index,dispose(){disposed.push(index)}})});
 await cache.at(0);await cache.at(8000);await cache.at(16000);await cache.at(240000);assert.ok(cache.resident.size<=3);
 assert.ok(cache.resident.has(30));cache.dispose();assert.equal(cache.resident.size,0);assert.ok(disposed.length>=3);
 let resolve;const stale=new TourWindowCache({build:()=>new Promise(r=>resolve=r)}),job=stale.at(0);stale.dispose();resolve({dispose(){disposed.push('late')}});await job;assert.ok(disposed.includes('late'));
});

test('refinement allocates new ownership while keeping the active window and rejects stale worker results',async()=>{
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const {GraphicsResidency}=await import('../src/render/GraphicsResidency.js');
 const THREE=await import('../src/vendor/range/three-range.module.js');
 const residency=new GraphicsResidency({budgetBytes:100*1024**2});
 const oldKey='range:tour-window:test:0',reservation=residency.reserve({key:oldKey,bytes:100,owner:'test'});
 let retired=false;residency.commit(reservation,{},()=>retired=true);
 const built={bands:Object.fromEntries(['far','mid','near'].map(b=>[b,{positions:new Float32Array(),indices:new Uint32Array(),fringe:new Uint32Array()}])),stats:{}};
 const raw={built,placed:{mesh:new Float32Array(),billboard:new Float32Array(),stride:8,count:0},plan:{}};
 const p={...buildFixture(),windowIndex:0,windowCache:{generation:1,closed:false,resident:new Map()},windowWorker:{build:async()=>raw},activeWindow:{key:oldKey},uniforms:{},generation:0};
 const scene=Object.assign(Object.create(RangeScene.prototype),{THREE,residency,prepared:new Map([['test',p]])});
 const next=await RangeScene.prototype._buildTourWindow.call(scene,p,0);
 assert.notEqual(next.key,oldKey);assert.equal(retired,false);assert.ok(residency.has(next.key));next.dispose();
 let finish;p.windowWorker.build=()=>new Promise(r=>finish=r);
 const stale=RangeScene.prototype._buildTourWindow.call(scene,p,0);p.windowCache.generation++;finish(raw);
 await assert.rejects(stale,/generation ended/);assert.equal(residency.has(oldKey),true);
 residency.release(oldKey);assert.equal(retired,true);
});

test('the second-ahead build waits for the next window, admits its own plan, and cannot evict current or next',async()=>{
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const {GraphicsResidency}=await import('../src/render/GraphicsResidency.js');
 const MiB=1024**2,residency=new GraphicsResidency({budgetBytes:100*MiB});
 const live=(key,bytes)=>{const r=residency.reserve({key,bytes,owner:'range-tour-window'});residency.commit(r,{},()=>{});return{key,coarse:false};};
 const active=live('range:tour-window:test:1:0',30*MiB),requests=[],builds=[];
 const p={...buildFixture(),generation:0,gpuKey:'g',cpuKey:'c',workerKey:'w',activeWindow:active,windowIndex:0,
  windowCache:{closed:false,resident:new Map([[0,active]]),pending:new Map(),request(index){requests.push(index);return new Promise(()=>{});},prune(){}},
  windowWorker:{build(index){builds.push(index);return new Promise(()=>{});}},windowOptions:{}};
 const scene=Object.assign(Object.create(RangeScene.prototype),{residency,_swapTourWindow(){}});
 // Window 1 is still building: no CPU ownership is taken ahead of it.
 RangeScene.prototype._ensureTourWindow.call(scene,p,1000);
 assert.deepEqual(requests,[1]);assert.deepEqual(builds,[]);assert.equal(residency.snapshot().byOwner['range-tour-window-cpu'],undefined);
 // Once window 1 is resident, window 2 admits its own peak rather than copying the preceding window's size.
 p.lastWindowBytes=40*MiB;const next=live('range:tour-window:test:1:1',30*MiB);p.windowCache.resident.set(1,next);
 RangeScene.prototype._ensureTourWindow.call(scene,p,1000);
 assert.deepEqual(builds,[2]);const ahead=p.rawAhead.get(2);
 assert.ok(ahead.bytes>0);assert.notEqual(ahead.bytes,p.lastWindowBytes);
 assert.equal(residency.snapshot().byOwner['range-tour-window'].pending,ahead.bytes);
 assert.equal(residency.entries.get(ahead.key).evictable,false,'executing work remains protected');
 assert.ok(residency.has(next.key)&&residency.has(active.key),'the active and next windows survive the reservation');
});

test('a missing next window keeps the neighbouring full window and its trees, never a treeless stand-in',async()=>{
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const full={key:'range:tour-window:test:1:0',index:0,coarse:false},requests=[],swaps=[];
 const p={view:{id:'test',tour:{durationMs:60000}},generation:0,gpuKey:'g',cpuKey:'c',workerKey:'w',activeWindow:full,windowIndex:0,
  windowCache:{closed:false,resident:new Map([[0,full]]),pending:new Map(),request(index,opts){requests.push([index,!!opts?.replace]);return new Promise(()=>{});},prune(){}},
  windowWorker:{build(){return new Promise(()=>{});}},windowOptions:{}};
 const scene={residency:null,_swapTourWindow(_,w){swaps.push(w);},_tourWindowResource:RangeScene.prototype._tourWindowResource};
 // 9 s is inside window 1, which has not arrived: window 0 stays on screen and window 1 is requested.
 RangeScene.prototype._ensureTourWindow.call(scene,p,9000);
 assert.deepEqual(swaps,[full]);assert.ok(requests.some(([i])=>i===1),'the arriving window is requested');
 assert.equal(p.windowCache.resident.has(1),false,'no coarse stand-in is published for window 1');
});

test('budget-denied window preparation backs off across playback frames and resets with coverage', async () => {
  let clock = 1000, builds = 0;
  const denied = Object.assign(new Error('No room to build terrain window'), { reason: 'budget' });
  const cache = new TourWindowCache({ now: () => clock, build: async () => { builds++; throw denied; } });
  await assert.rejects(cache.request(1), /No room/);
  for (let frame = 0; frame < 12; frame++) {
    clock += 16;
    await cache.request(1);
  }
  assert.equal(builds, 1, 'playback must not repeat planning/admission on every frame while denied');
  clock = 1250;
  await assert.rejects(cache.request(1), /No room/);
  assert.equal(builds, 2, 'asynchronous preparation must keep retrying');
  cache.invalidate();
  await assert.rejects(cache.request(1), /No room/);
  assert.equal(builds, 3, 'new coverage must not inherit an obsolete retry delay');
  cache.dispose();
});

test('an obsolete budget denial cannot delay preparation for replacement coverage', async () => {
  const rejectors = [];
  const cache = new TourWindowCache({ build: () => new Promise((_, reject) => rejectors.push(reject)) });
  const old = cache.request(0);
  cache.invalidate();
  const next = cache.request(0);
  rejectors[0](Object.assign(new Error('old budget'), { reason: 'budget' }));
  await assert.rejects(old, /old budget/);
  assert.equal(cache.retryAt.size, 0);
  rejectors[1](new Error('new attempt ended'));
  await assert.rejects(next, /new attempt/);
  cache.dispose();
});
