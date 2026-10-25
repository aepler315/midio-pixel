import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RangeScene} from '../src/world/alpine/RangeScene.js';
import {ActorsGL,actorUniforms,SITE_LIGHTS_MAX,threadShown,THREAD_FRONT,THREAD_PUSH_PX} from '../src/world/alpine/ActorsGL.js';
import {ACTOR_IDS,ACTOR_MOTES} from '../src/world/alpine/RangeActors.js';
import {castWork,pathPosition} from '../src/world/alpine/CastJobs.js';
import * as THREE from '../src/vendor/range/three-range.module.js';
import {emitterVisibility} from '../src/world/alpine/RangeAtmosphere.js';
import {sceneUniforms} from '../src/world/alpine/TerrainMaterial.js';
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

test('the cast sink into the cloud sea with the ground under them; their light is cut per receiver, not here',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,2200,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 // Lamplighters on the valley floor at 1000 m, Midasus threading two cairns.
 const plan={job:'lamplighters',cairns:[[-800,1000,-5000],[0,1000,-5200],[800,1000,-5000]],buoys:[]};
 const work=castWork(plan);
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 // Two cairns kindled 200 ms ago: the motes are still flying into them.
 const times=work.marks.map((m,k)=>k<2?19800:k===work.threads[0].mark?19900:Infinity);
 const state={p:0.55,offsets:{broshi:0,midasus:0},shelter01:0,payoff01:0,fuse01:0,camps:0,climax:false};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:state},schedule:{kindleTimes:()=>times,views:{v:{camps:[]}}}};
 const draw=mistNow=>{p.mistNow=mistNow;RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel:0,light:{night01:1}});
  return {seen:ACTOR_IDS.map(id=>actors.uniforms[id].uSeen.value),fly:ACTOR_IDS.map(id=>actors.uniforms[id].uSeenFly.value),
   companions:actors.companions.midasus.map(c=>c.uSeen.value),light:shared.uActorColor.value.map(c=>c.clone())};};
 const clear=draw(undefined);
 assert.deepEqual(clear.seen,[1,1,1],'no fog state: fully seen (tests, first frame)');
 assert.deepEqual(clear.companions,[1,1,1]);
 const fog={density:1.5e-3,baseM:990,heightM:240,tSec:3,steps:6,fill:1,atm:1};
 // The sea's top above the floor: everyone on it is gone.
 const sunk=draw({...fog,topM:1700});
 for(const v of [...sunk.seen,...sunk.companions])assert.ok(v<1e-6,`sunk lantern seen at ${v}`);
 assert.ok(actors.uniforms.broshi.uFly.value>0,'a kindling is under way');
 assert.ok(sunk.fly.every(v=>v<1e-6),'the light being kindled is under the sea too');
 sunk.light.forEach((c,k)=>assert.ok(c.distanceTo(clear.light[k])<1e-9,'the light itself is cut per receiver in the terrain shaders'));
 // The top below them: only the valley mist along the ray remains.
 const above=draw({...fog,topM:900,fill:0.6});
 const eye=camera.position.toArray();
 ACTOR_IDS.forEach((id,k)=>{
  const pos=shared.uActorPos.value[k].toArray();
  assert.ok(Math.abs(above.seen[k]-emitterVisibility(eye,pos,{...fog,topM:900,fill:0.6}))<1e-12,id);
  assert.ok(above.seen[k]>0.05&&above.seen[k]<1,`${id} seen through the mist at ${above.seen[k]}`);
 });
 // Companions are fogged where each one trails, the kindled light at the cairn.
 const flyTo=actors.uniforms.broshi.uFlyTarget.value.toArray();
 assert.ok(Math.abs(above.fly[1]-emitterVisibility(eye,flyTo,{...fog,topM:900,fill:0.6}))<1e-12);
 actors.dispose();
});

test('site lights and threads read the terrain fog by reference, and fall back to clear air',()=>{
 const shared=sceneUniforms(THREE,{});
 const actors=new ActorsGL(THREE,shared);
 for(const u of [actors.sites.uniforms,...Object.values(actors.threads.uniformsByBand)]){
  for(const k of ['uMistDensity','uMistTop','uMistFill','uMistDrift','uMistSteps','uNarrative','uCameraPos'])assert.equal(u[k],shared[k],k);
 }
 assert.match(actors.sites.material.vertexShader,/vSeen = aState\.x > 0\.0 \? emitterSeen\(at\)/,'fogged at the light itself, not its pushed halo');
 assert.match(actors.threads.meshes.far.material.vertexShader,/emitterSeen\(/);
 assert.match(actors.groups.midio.children[1].material.fragmentShader,/\* uSeen;/);
 assert.match(actors.groups.midio.children[0].material.vertexShader,/vSeen = mix\(uSeen, uSeenFly, fly\)/);
 actors.dispose();
 const bare=new ActorsGL(THREE,actorUniforms(THREE));
 assert.equal(bare.sites.uniforms.uMistDensity.value,0,'clear air without terrain uniforms');
 assert.equal(bare.threads.uniformsByBand.near.uMistFill.value,0);
 bare.dispose();
});

test('threads go up with their drape, each in the nearest band it lies over',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const plan={job:'lamplighters',cairns:[[-800,1000,-5000],[0,1000,-5200],[800,1000,-5000]],buoys:[]};
 const work=castWork(plan);
 // A ridge under the first thread's middle: its drape climbs over it.
 work.threads[0].points=work.threads[0].points.map((q,j,a)=>[q[0],q[1]+120*Math.sin(Math.PI*j/(a.length-1)),q[2]]);
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:{},scenes:{far:new THREE.Scene()}};
 // Ground east of x = 0 belongs to the near band.
 const scene={THREE,camera,_tileAt:(d,x)=>({band:x>1?'near':'far'}),_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 const times=work.marks.map(()=>0);
 const state={p:1,offsets:{broshi:0,midasus:0},shelter01:0,payoff01:0,fuse01:0,camps:0,climax:false};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:state},schedule:{kindleTimes:()=>times,views:{v:{camps:[]}}}};
 RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel:0,light:{night01:1}});
 const far=actors.threads.meshes.far.geometry, near=actors.threads.meshes.near.geometry;
 const n0=work.threads[0].points.length-1;
 assert.equal(far.drawRange.count,n0*6,'only the western thread stays far');
 assert.equal(near.drawRange.count,(work.threads[1].points.length-1+work.threads[2].points.length-1)*6,'the closing thread crosses near ground');
 for(let j=0;j<n0;j++){
  const q=work.threads[0].points[j], pos=far.attributes.position;
  assert.deepEqual([pos.getX(2*j),pos.getY(2*j),pos.getZ(2*j)].map(v=>+v.toFixed(3)),q.map(v=>+v.toFixed(3)),`drape point ${j}`);
  assert.equal(far.attributes.aThread.getY(2*j),Math.fround(j/n0),'revealed by index fraction, as Midasus flies it');
 }
 actors.dispose();
});

test('Midasus glides to a thread that starts elsewhere instead of jumping there',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const plan={job:'lamplighters',cairns:[[-900,1000,-5000],[-300,1000,-5200],[300,1000,-5200],[900,1000,-5000]],buoys:[]};
 const work=castWork(plan);
 work.threads.splice(1,1); // the second cairn's thread had no ground to lie on
 const [a,b]=work.threads;
 const times=work.marks.map((m,k)=>k<4?0:k===a.mark?10000:k===b.mark?20000:Infinity);
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 const state={p:0.6,offsets:{broshi:0,midasus:0},shelter01:0,payoff01:0,fuse01:0,camps:0,climax:false};
 const at=t=>{RangeScene.prototype._setActors.call(scene,p,{actors:{presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:state},schedule:{kindleTimes:()=>times,views:{v:{camps:[]}}}},timeMs:t,qualityLevel:0,light:{night01:1}});
  return shared.uActorPos.value[2].clone();};
 const end=new THREE.Vector3(...a.b), start=new THREE.Vector3(...b.a);
 assert.ok(at(18000).distanceTo(end)<1e-6,'waits at the end of her last thread');
 assert.ok(at(19250).distanceTo(end.clone().lerp(start,0.5))<1e-6,'halfway over 750 ms before the next starts');
 assert.ok(at(20000).distanceTo(start)<1e-6,'there as it starts');
 let last=at(18500);
 for(let t=18550;t<=20000;t+=50){const q=at(t);assert.ok(q.distanceTo(last)<start.distanceTo(end)/10,`no jump at ${t}`);last=q;}
 actors.dispose();
});

test('the cast ride the drawn ground as it swells, from their true positions',()=>{
 const shared=sceneUniforms(THREE,{uReceiver:{value:null},uHeightRange:{value:new THREE.Vector2(0,3000)},uGridOrigin:{value:new THREE.Vector2()}});
 const actors=new ActorsGL(THREE,shared);
 const lantern=actors.groups.midio.children[1].material, motes=actors.groups.midio.children[0].material;
 for(const m of [lantern,motes,actors.sites.material,actors.threads.meshes.mid.material,...actors.groups.midasus.children.slice(2).map(c=>c.material)]){
  assert.match(m.vertexShader,/float groundLift\(vec3 p\)/);
  for(const k of ['uDeformAmp','uDeformKick','uReceiver','uGridOrigin','uGlacierEnabled','uTourEye'])assert.equal(m.uniforms[k],shared[k],k);
 }
 assert.match(lantern.vertexShader,/uCenter \+ vec3\(0\.0, groundLift\(uAnchor\), 0\.0\)/,'lifted at the light, not at its camera-ward centre');
 assert.match(motes.vertexShader,/target\.y \+= groundLift\(uFlyTarget\)/,'a kindled light is lifted too');
 assert.match(actors.sites.material.vertexShader,/at\.y \+= groundLift\(aPos\)/);
 assert.match(actors.threads.meshes.near.material.vertexShader,/vec3 seat\(vec3 p\) \{ return p \+ vec3\(0\.0, groundLift\(p\), 0\.0\); \}/);
 assert.match(actors.threads.meshes.near.material.vertexShader,/vec3 here = seat\(position\)/);
 // Threads lean 1.5 native pixels toward the eye, sized by the target's height.
 assert.ok(actors.threads.meshes.near.material.vertexShader.includes(`${THREAD_PUSH_PX.toFixed(2)} * mpp`));
 assert.equal(actors.threads.uniformsByBand.far.uTanHalf,actors.sites.uniforms.uTanHalf,'one view upload serves sites and threads');
 assert.equal(actors.threads.uniformsByBand.far.uViewportPx,shared.uViewportPx);
 // The scene hands each lantern and companion its true position.
 const camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const route={kind:'air',points:[[0,1000,-5000],[100,1000,-5000]],lengths:[100],total:100};
 const p={view:{id:'tour',tour:true},actors,uniforms:shared,actorRoutes:Object.fromEntries(ACTOR_IDS.map(id=>[id,route])),data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 RangeScene.prototype._setActors.call(scene,p,{actors:{presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:1,travel:1}]))},timeMs:20000,qualityLevel:0,light:{night01:1}});
 ACTOR_IDS.forEach((id,k)=>{
  const u=actors.uniforms[id];
  assert.ok(u.uAnchor.value.distanceTo(shared.uActorPos.value[k])<1e-9,`${id} anchored at its light`);
  assert.ok(u.uCenter.value.distanceTo(u.uAnchor.value)>1,'its halo still draws toward the eye');
 });
 for(const c of actors.companions.midasus)assert.ok(c.uAnchor.value.distanceTo(c.uCenter.value)>0.1&&c.uAnchor.value.length()>0);
 actors.dispose();
});

test('a thread is drawn up to Midasus, smoothly, from nothing to all of it',()=>{
 for(let s=0;s<=1;s+=1/64){assert.equal(threadShown(s,0),0,`nothing at reveal 0 (s ${s})`);assert.equal(threadShown(s,1),1,`all of it at reveal 1 (s ${s})`);}
 for(const r of [0.1,0.37,0.5,0.9]){
  assert.equal(threadShown(r-THREAD_FRONT,r),1,'lit behind her');
  assert.equal(threadShown(r+THREAD_FRONT,r),0,'dark ahead of her');
  assert.ok(threadShown(r-THREAD_FRONT/2,r)>=0.5&&threadShown(r+THREAD_FRONT/2,r)<=0.5,'half-bright within half a head of her');
  // The front glides: a 1% step of reveal changes any point by about a third at most.
  for(let s=0;s<=1;s+=0.005)assert.ok(Math.abs(threadShown(s,r+0.01)-threadShown(s,r))<=0.01*(1+THREAD_FRONT)/THREAD_FRONT+1e-9);
 }
 const shared=sceneUniforms(THREE,{});
 const actors=new ActorsGL(THREE,shared);
 const frag=actors.threads.meshes.far.material.fragmentShader;
 assert.ok(frag.includes(`(vReveal * ${(1+THREAD_FRONT).toFixed(3)} - vS) / ${THREAD_FRONT.toFixed(3)}`),'per fragment, the same front');
 actors.dispose();
});

test('threads are mitred ribbons: every drape point a pair of vertices, segments sharing edges',()=>{
 const actors=new ActorsGL(THREE,sceneUniforms(THREE,{}));
 const pts=[[0,0,0],[100,10,0],[200,0,50],[300,5,50]];
 actors.threads.setThreads([{points:pts,band:'mid'},{a:[0,0,0],b:[50,0,0],band:'mid'}]);
 const g=actors.threads.meshes.mid.geometry, a=g.attributes, n=pts.length-1;
 assert.equal(actors.threads.meshes.mid.isMesh,true,'triangles, not 1-px GL lines');
 for(let j=0;j<=n;j++)for(const side of [0,1]){
  const v=2*j+side;
  assert.deepEqual([a.position.getX(v),a.position.getY(v),a.position.getZ(v)],pts[j]);
  assert.deepEqual([a.aPrev.getX(v),a.aPrev.getY(v),a.aPrev.getZ(v)],pts[Math.max(0,j-1)],'its heading in');
  assert.deepEqual([a.aNext.getX(v),a.aNext.getY(v),a.aNext.getZ(v)],pts[Math.min(n,j+1)],'and out (an end repeats itself)');
  assert.equal(a.aSide.getX(v),side?1:-1);
 }
 // Two triangles per segment over its four corners; the next segment starts
 // on the same pair of vertices, so no overlap beads the line.
 const idx=Array.from({length:6},(_,i)=>g.index.getX(i));
 assert.deepEqual(idx,[0,1,2,1,3,2]);
 assert.deepEqual(Array.from({length:6},(_,i)=>g.index.getX(6+i)),[2,3,4,3,5,4]);
 // A straight {a, b} thread follows, at the old 16 segments.
 assert.equal(g.drawRange.count,(n+16)*6);
 assert.equal(g.index.getX(n*6),(n+1)*2);
 const vert=actors.threads.meshes.mid.material.vertexShader;
 assert.match(vert,/c\.xy \+= m \* across \/ max\(dot\(m, nA\), 0\.5\)/,'mitred in target pixels');
 assert.match(actors.threads.meshes.mid.material.fragmentShader,/ribbonCoverage\(vAcrossW \/ vW\)/,'the filtered profile across it');
 actors.dispose();
});

test('lanterns, motes and placed lights are filtered over each pixel, never cut to a sub-pixel dot',()=>{
 const actors=new ActorsGL(THREE,sceneUniforms(THREE,{}));
 const [motes,lantern]=actors.groups.midio.children.map(c=>c.material);
 for(const m of [motes,lantern,actors.sites.material])assert.doesNotMatch(m.fragmentShader,/discard/,'the quad holds the whole filtered light');
 assert.match(lantern.fragmentShader,/spot\(vPx, 0\.0439 \* vR\)/);
 assert.match(lantern.vertexShader,/float extent = spriteExtent\(vR\)/);
 assert.match(motes.fragmentShader,/spot\(vPx, 0\.245 \* vR\)/);
 assert.match(actors.sites.material.fragmentShader,/spot\(vPx, 0\.0745 \* vR\)/);
 assert.match(actors.sites.material.fragmentShader,/spriteHalo\(vPx, vR\)/);
 for(const m of [motes,lantern,actors.sites.material,actors.threads.meshes.far.material])assert.equal(m.uniforms.uViewportPx.value.isVector2,true);
 actors.dispose();
});

test('an ascent strings its fixed line up to the light Broshi is fixing, and the fuse runs along it',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const plan={job:'ascent',points:[[0,1000,-5000],[0,1500,-6000]],us:[0,1],waterU:0,landing:[0,1000,-5000],shoreStart:null};
 const work=castWork(plan);
 assert.equal(work.rope.length,65);
 assert.ok(new THREE.Vector3(...work.rope[0]).distanceTo(new THREE.Vector3(...pathPosition(plan,0,{hoverM:1.5})))<1e-9);
 const p={view:{id:'v'},actors,uniforms:shared,actorRoutes:{},castPlan:plan,castWork:work,data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null,_castJob:RangeScene.prototype._castJob,_setCastLights:RangeScene.prototype._setCastLights};
 // Lights 0..9 lit long ago, light 10 coming up for 400 of its 800 ms.
 const times=work.marks.map((m,k)=>k<10?0:k===10?19600:Infinity);
 const state={p:0.6,offsets:{broshi:0.05,midasus:0.1},shelter01:0,payoff01:0,fuse01:0,camps:0,climax:false};
 const draw=(st)=>RangeScene.prototype._setActors.call(scene,p,{actors:{presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{glow:0.5,travel:1}])),jobs:{v:st},schedule:{kindleTimes:()=>times,views:{v:{camps:[]}}}},timeMs:20000,qualityLevel:0,light:{night01:1}});
 draw(state);
 const u=actors.rope.uniformsByBand.far;
 assert.equal(actors.rope.meshes.far.visible,true);
 assert.ok(Math.abs(u.uReveal.value[0]-(10.5/33))<1e-9,`front ${u.uReveal.value[0]}: halfway from light 9 to light 10`);
 assert.equal(u.uFlare.value[0],-10,'no fuse');
 draw({...state,fuse01:0.4,climax:true});
 assert.equal(u.uFlare.value[0],0.4,'the fuse runs along the rope');
 actors.dispose();
});
