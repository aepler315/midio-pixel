import {test} from 'node:test';
import assert from 'node:assert/strict';
import {giantAmounts} from '../src/world/alpine/LandscapeGiants.js';
import {RangeScene} from '../src/world/alpine/RangeScene.js';
import {ActorsGL,actorUniforms} from '../src/world/alpine/ActorsGL.js';
import {ACTOR_IDS,ACTOR_MOTES} from '../src/world/alpine/RangeActors.js';
import * as THREE from '../src/vendor/range/three-range.module.js';
test('musical cast peaks never spawn giant landscape silhouettes',()=>{
 const frame={actors:{presence:1,midio:{peak:1},broshi:{peak:1},midasus:{peak:1}},narrative:{materials:1},qualityLevel:0};
 assert.deepEqual(giantAmounts(frame),[0,0,0]);
 assert.equal(RangeScene.prototype.renderSkyGiants.call({prepared:new Map()},frame,'view'),null);
});
test('all three cast members keep their lanterns, motes and companions without giant resources',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const cast=new ActorsGL(THREE,shared);
 assert.deepEqual(Object.keys(cast.groups),ACTOR_IDS);
 for(const id of ACTOR_IDS){assert.ok(cast.groups[id].children.length>=2);assert.equal(cast.groups[id].children[0].geometry.instanceCount,ACTOR_MOTES);}
 assert.equal(cast.companions.midasus.length,3);
 assert.equal(!!cast.reflection,false);assert.equal(!!cast.clouds,false);assert.equal(!!cast.mask,false);
 cast.dispose();
});
test('local swarms still gather at musical peaks at full and reduced quality',()=>{
 const shared={...actorUniforms(THREE),uCameraPos:{value:new THREE.Vector3()},uAirDensity:{value:0},uAirHeightFalloff:{value:0}};
 const actors=new ActorsGL(THREE,shared), camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const route={kind:'air',points:[[0,1000,-5000],[100,1000,-5000]],lengths:[100],total:100};
 const p={actors,uniforms:shared,actorRoutes:Object.fromEntries(ACTOR_IDS.map(id=>[id,route])),data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{peak:1,glow:1,travel:1}]))};
 for(const qualityLevel of [0,6]){
  RangeScene.prototype._setActors.call(scene,p,{actors:cast,timeMs:20000,qualityLevel,light:{night01:1}});
  for(const id of ACTOR_IDS){assert.equal(actors.groups[id].visible,true);assert.equal(actors.uniforms[id].uCohere.value,1);
   actors.groups[id].traverse(object=>assert.equal(object.layers.mask,1<<3,'cast lights draw after forest depth'));
  }
 }
 actors.dispose();
});

test('off-axis terrain zoom preserves the prescribed cast size in screen pixels',()=>{
 const shared=actorUniforms(THREE), actors=new ActorsGL(THREE,shared);
 const camera=new THREE.PerspectiveCamera(35,16/9,1,100000);
 camera.position.set(0,1000,0);camera.lookAt(0,1000,-10000);camera.updateMatrixWorld();
 const route={kind:'air',points:[[0,1000,-5000],[100,1000,-5000]],lengths:[100],total:100};
 const p={actors,uniforms:shared,actorRoutes:Object.fromEntries(ACTOR_IDS.map(id=>[id,route])),data:null,scenes:{far:new THREE.Scene()}};
 const scene={THREE,camera,_tileAt:()=>null};
 const cast={presence:1,...Object.fromEntries(ACTOR_IDS.map(id=>[id,{peak:1,glow:1,travel:1}]))};
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
