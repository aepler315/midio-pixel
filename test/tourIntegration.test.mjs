import{test}from'node:test';import assert from'node:assert/strict';import{scenePoseAt,pathStations}from'../src/world/terrain/SceneTravel.js';import{resolveRangeMode}from'../src/world/alpine/RangePresentation.js';import{applyCameraMoves}from'../src/world/alpine/RangeCamera.js';
test('tour mode resolves query and persistence without changing ordinary Range',()=>{
 assert.equal(resolveRangeMode('?rangeTour=tetons').tour,'tetons');assert.equal(resolveRangeMode('',{getItem:()=> 'tetons'}).tour,'tetons');assert.equal(resolveRangeMode('?rangeTour=off',{getItem:()=> 'tetons'}).tour,null);assert.equal(resolveRangeMode('',{getItem:()=>{throw Error('blocked')}}).tour,null);
});
test('scene provider uses heard time, samples review paths, and disables extra camera moves',()=>{
 const tour={durationMs:10000,poseAt:t=>({eyeM:[t,100,0],targetM:[t,100,-1000],fovYDeg:35,tour:true})},view={tour};
 assert.deepEqual(scenePoseAt(view,{timeMs:1234}),tour.poseAt(1234));assert.equal(pathStations(view,3)[2].eyeM[0],10000);
 const pose=tour.poseAt(2000);assert.equal(applyCameraMoves(pose,{dolly:.5,yaw:.4},{zoom:2}),pose);
});

test('tour sky uses world directions across rear-facing turns', async () => {
 const {tourSkyDirection,projectSkyDirection,tourCloudBanks}=await import('../src/world/alpine/RangeSkyComposition.js');
 const pose={eyeM:[0,100,0],targetM:[0,100,-1000],fovYDeg:50};
 assert.equal(projectSkyDirection(pose,[0,0,1],16/9).visible,false);
 assert.equal(projectSkyDirection(pose,[0,0,-1],16/9).xFrac,.5);
 assert.ok(tourSkyDirection(90,0)[0]>.999);
 const a=tourCloudBanks({pose,width:1280,height:720,seed:12});
 const b=tourCloudBanks({pose:{...pose,targetM:[170,100,985]},width:1280,height:720,seed:12});
 assert.ok(a.length>0&&b.length>0);assert.notDeepEqual(a.map(c=>c.id),b.map(c=>c.id));
});

test('leaving tour mode cannot reuse a cancelled residency generation',async()=>{
 const {RangePresentation}=await import('../src/world/alpine/RangePresentation.js');
 const {GraphicsResidency}=await import('../src/render/GraphicsResidency.js');
 const residency=new GraphicsResidency({budgetBytes:10000000});
 const presentation=new RangePresentation({mode:'v2',residency});
 presentation.generation=4;residency.cancelGeneration(2);
 presentation.setSong({generation:2});
 assert.ok(residency.reserve({key:'ordinary-after-tour',bytes:10,owner:'test',generation:presentation.generation}));
 presentation.dispose();
});

// A3: the presentation replans when the motion preference changes, not only
// when sections do; the newest request wins and late replies are dropped.
test('a live reduced-motion change replans the tour; obsolete worker replies never land',async()=>{
 const {RangePresentation}=await import('../src/world/alpine/RangePresentation.js');
 const workers=[];const Prior=globalThis.Worker;
 globalThis.Worker=class{constructor(){this.terminated=false;workers.push(this);}postMessage(m){this.message=m;}terminate(){this.terminated=true;}};
 try{
  const p=new RangePresentation({mode:'v2'});
  const sections=[{startMs:0,endMs:60000}];
  const mgr={sections,reducedMotion:false,tSec:5,durationMs:60000,currentBlend:{}};
  const replaced=[];
  Object.assign(p,{runtimeState:'ready',tourMode:'tetons',tourData:{},_tourSections:sections,_tourMotion:false,
   tour:{reducedMotion:false,notes:[]},forced:{view:{id:'teton-range-tour'}},
   scene:{isReady:()=>false,replaceTour:v=>replaced.push(v.tour),dispose(){}},frameInputs:{sim:{biomes:mgr}}});
  const frame=()=>{try{p._beginScenic();}catch{/* the rest of the frame is not under test */}};
  frame();
  assert.equal(workers.length,0,'unchanged sections and preference: no replan');
  mgr.reducedMotion=true;frame();
  assert.equal(workers.length,1);
  assert.deepEqual([workers[0].message.reducedMotion,workers[0].message.committedThroughMs],[true,5000]);
  frame();
  assert.equal(workers.length,1,'one replan per change, not per frame');
  mgr.reducedMotion=false;mgr.tSec=6;frame();
  assert.equal(workers.length,2,'a rapid toggle replans again');
  assert.equal(workers[0].terminated,true,'the obsolete worker is stopped');
  const tourFrom=(reducedMotion)=>({durationMs:0,heroes:[],notes:[],reducedMotion,previewPose:{eyeM:[0,0,0],targetM:[0,0,-1],fovYDeg:35}});
  workers[0].onmessage?.({data:{tour:tourFrom(true)}});
  workers[1].onmessage({data:{tour:tourFrom(false)}});
  await p._replanPromise;
  assert.equal(p.tour.reducedMotion,false,'the newest preference is applied');
  assert.equal(replaced.length,1,'only the current reply replaces the tour');
  p.dispose();
 }finally{globalThis.Worker=Prior;}
});
