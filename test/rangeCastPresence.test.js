import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RangeScene} from '../src/world/alpine/RangeScene.js';
import {ActorsGL,actorUniforms,SITE_LIGHTS_MAX} from '../src/world/alpine/ActorsGL.js';
import {ACTOR_IDS,ACTOR_MOTES} from '../src/world/alpine/RangeActors.js';
import {castWork,pathPosition} from '../src/world/alpine/CastJobs.js';
import * as THREE from '../src/vendor/range/three-range.module.js';
test('the cast spawns no giant landscape silhouettes',()=>{
 const shared=actorUniforms(THREE);
 for(const name of ['uGiantPeak','uGiantMask','uGiantCenter','uSkyGiantCenter','uMidioCloud'])assert.equal(name in shared,false,name);
 assert.equal(RangeScene.prototype.renderSkyGiants.call({prepared:new Map()},{},'view'),null);
});
test('all three cast members keep their lanterns, motes and companions, and a view its lights',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const cast=new ActorsGL(THREE,shared);
 assert.deepEqual(Object.keys(cast.groups),ACTOR_IDS);
 for(const id of ACTOR_IDS){assert.ok(cast.groups[id].children.length>=2);assert.equal(cast.groups[id].children[0].geometry.instanceCount,ACTOR_MOTES);}
 assert.equal(cast.companions.midasus.length,3);
 assert.ok(cast.sites&&cast.threads,'site lights and survey threads');
 assert.equal(!!cast.reflection,false);assert.equal(!!cast.clouds,false);assert.equal(!!cast.mask,false);
 cast.dispose();
});
test('tour lanterns wander their routes at full and reduced quality',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const route={kind:'air',points:[[0,1000,-5000],[100,1000,-5000]],lengths:[100],total:100};
 const p={view:{id:'tour',tour:true},actors,uniforms:shared,actorRoutes:Object.fromEntries(ACTOR_IDS.map(id=>[id,route])),data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:1,travel:1}]))};
 for(const qualityLevel of [0,6]){
  RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel,light:{night01:1}});
  for(const id of ACTOR_IDS){assert.equal(actors.groups[id].visible,true);assert.equal(actors.uniforms[id].uFly.value,0);
   actors.groups[id].traverse(object=>assert.equal(object.layers.mask,1<<3,'cast lights draw after forest depth'));
  }
 }
 actors.dispose();
});

test('an ascent puts the team on its path and lights the fixed lines Broshi has passed',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const plan={job:'ascent',points:[[0,1000,-5000],[0,1500,-6000]],us:[0,1],waterU:0,landing:[0,1000,-5000],shoreStart:null};
 const work=castWork(plan);
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 // Broshi (0.05 behind the lead at 0.6) has passed the lights up to 0.55.
 const times=work.marks.map(m=>m.p<=0.55?0:Infinity);
 const schedule={kindleTimes:()=>times,views:{v:{camps:[{atMs:0,p:0.3}]}}};
 const state={p:0.6,offsets:{broshi:0.05,midasus:0.1},shelter01:0,payoff01:0,fuse01:0,camps:1,climax:true};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:state},schedule};
 RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel:0,light:{night01:1}});
 const at=k=>shared.uActorPos.value[k];
 const lead=pathPosition(plan,0.6,{hoverM:2});
 assert.ok(at(0).distanceTo(new THREE.Vector3(...lead))<1e-6,'Midio leads at the job progress');
 assert.ok(at(1).y<at(0).y,'Broshi follows below him');
 // Midasus scouts ahead (0.1 past the lead), six feet over the ground.
 assert.ok(at(2).distanceTo(new THREE.Vector3(...pathPosition(plan,0.7,{hoverM:1.83})))<1e-6,'Midasus scouts ahead, six feet up');
 const state01=actors.sites.meshes.far.geometry.attributes.aState;
 const lit=work.lights.filter((_,k)=>state01.getX(k)>0).length;
 assert.equal(lit,work.lights.filter(l=>l.u<=0.55).length);
 assert.ok(lit>0&&lit<work.lights.length);
 assert.equal(state01.getX(work.lights.length),1,'the camp light stands');
 assert.equal(actors.sites.meshes.far.geometry.instanceCount,work.lights.length+1);
 // A shot tour over the view keeps the job and every light it has left.
 p.cameraTour={};
 RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel:0,light:{night01:1}});
 assert.equal(work.lights.filter((_,k)=>state01.getX(k)>0).length,lit);
 assert.ok(at(0).distanceTo(new THREE.Vector3(...lead))<1e-6);
 actors.dispose();
});

test('a view with more camps than free slots keeps its most recent camps lit',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const plan={job:'ascent',points:[[0,1000,-5000],[0,1500,-6000]],us:[0,1],waterU:0,landing:[0,1000,-5000],shoreStart:null};
 const work=castWork(plan);
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 const camps=Array.from({length:20},(_,j)=>({atMs:j*1000,p:j/20}));
 const schedule={kindleTimes:()=>work.marks.map(()=>0),views:{v:{camps}}};
 const draw=made=>{
  const state={p:1,offsets:{broshi:0,midasus:0},shelter01:0,payoff01:0,fuse01:0,camps:made,climax:false};
  RangeScene.prototype._setActors.call(scene,p,{actors:{presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:state},schedule},timeMs:30000,qualityLevel:0,light:{night01:1}});
  const g=actors.sites.meshes.far.geometry;
  return {n:g.instanceCount,lit:Array.from({length:g.instanceCount-work.lights.length},(_,j)=>g.attributes.aState.getX(work.lights.length+j)),
   first:new THREE.Vector3(g.attributes.aPos.getX(work.lights.length),g.attributes.aPos.getY(work.lights.length),g.attributes.aPos.getZ(work.lights.length))};
 };
 const early=draw(5);
 assert.equal(early.n,SITE_LIGHTS_MAX);
 assert.deepEqual(early.lit.slice(0,6),[1,1,1,1,1,0]);
 const late=draw(20);
 assert.equal(late.n,SITE_LIGHTS_MAX);
 assert.ok(late.lit.every(x=>x===1),'every camp in the window stands');
 // The window starts at the fifth camp: the most recent 16 of 20.
 assert.ok(late.first.distanceTo(new THREE.Vector3(...pathPosition(plan,camps[4].p,{hoverM:3})))<1e-3);
 actors.dispose();
});

test('lamplighters walk their sites, and Midasus threads the cairns both lit',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const plan={job:'lamplighters',cairns:[[-800,1000,-5000],[0,1000,-5200],[800,1000,-5000]],buoys:[]};
 const work=castWork(plan);
 assert.equal(work.threads.length,3,'two neighbours and the closing thread');
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 // The first two cairns lit at 10 s, their thread at 19 s; nothing else yet.
 const times=work.marks.map((m,k)=>k<2?10000:k===work.threads[0].mark?19000:Infinity);
 const state={p:0.55,offsets:{broshi:0,midasus:0},shelter01:0,payoff01:0,fuse01:0,camps:0,climax:false};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:state},schedule:{kindleTimes:()=>times,views:{v:{camps:[]}}}};
 RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel:0,light:{night01:1}});
 const u=actors.threads.uniformsByBand.far;
 assert.ok(u.uReveal.value[0]>0.6&&u.uReveal.value[0]<0.7,'drawn over 1.5 s');
 assert.equal(u.uReveal.value[1],0);assert.equal(u.uReveal.value[2],0);
 // Midasus is at the drawing front, Midio's motes are settling into his cairn.
 const front=work.threads[0].a.map((v,c)=>v+(work.threads[0].b[c]-v)*(1000/1500));
 assert.ok(shared.uActorPos.value[2].distanceTo(new THREE.Vector3(...front))<1e-6);
 const state01=actors.sites.meshes.far.geometry.attributes.aState;
 assert.deepEqual([0,1,2].map(k=>state01.getX(k)),[1,1,0]);
 actors.dispose();
});

test('off-axis terrain zoom preserves the prescribed cast size in screen pixels',()=>{
 const shared=actorUniforms(THREE), actors=new ActorsGL(THREE,shared);
 const camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const route={kind:'air',points:[[0,1000,-5000],[100,1000,-5000]],lengths:[100],total:100};
 const p={view:{id:'tour',tour:true},actors,uniforms:shared,actorRoutes:Object.fromEntries(ACTOR_IDS.map(id=>[id,route])),data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:1,travel:1}]))};
 const sizes=()=>{
  RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel:0,light:{night01:1}});
  return ACTOR_IDS.map(id=>{
   const u=actors.uniforms[id], center=u.uCenter.value.clone();
   const edge=center.clone().addScaledVector(u.uUp.value,u.uMpp.value);
   return edge.project(camera).y-center.project(camera).y;
  });
 };
 try {
  const before=sizes();camera.setViewOffset(1280,720,512,144,512,288);
  sizes().forEach((size,i)=>assert.ok(Math.abs(size-before[i])<1e-9,'lanterns and motes keep their authored pixel scale'));
 } finally {actors.dispose();}
});
