import {test} from 'node:test';
import assert from 'node:assert/strict';
const cloud=await import('../src/world/alpine/CloudOcclusion.js').catch(()=>({}));
const basis={right:[1,0,0],up:[0,1,0],forward:[0,0,1]};
const direction=[0,Math.SQRT1_2,Math.SQRT1_2];
test('a foreground cloud can cover the camera moon while leaving the lake illuminated',()=>{
 assert.equal(typeof cloud.cloudTransmission,'function');
 const puffs=[{centerM:[0,10,10],radiusXM:4,radiusYM:2,opacity:.9}];
 assert.ok(cloud.cloudTransmission([0,0,0],direction,puffs,basis)<.2);
 assert.equal(cloud.cloudTransmission([0,-10,0],direction,puffs,basis),1);
});
test('clouds in the moon-to-water path dim its direct light continuously',()=>{
 assert.equal(typeof cloud.cloudTransmission,'function');
 const puff={centerM:[0,10,10],radiusXM:20,radiusYM:30,opacity:.9};
 const a=cloud.cloudTransmission([0,-10,0],direction,[puff],basis);
 const b=cloud.cloudTransmission([.1,-10,0],direction,[puff],basis);
 assert.ok(a<.5&&a>0);assert.ok(Math.abs(a-b)<.01);
 assert.equal(cloud.cloudTransmission([0,0,20],direction,[puff],basis),1,'cloud behind the receiver cannot shade it');
});
test('cloud puff geometry matches painted ellipses and honors excluded sky corridors',()=>{
 assert.equal(typeof cloud.cloudPuffs,'function');
 const banks=[{x:640,y:150,w:100,h:20,alpha:.4,puffs:1}];
 const options={width:1280,height:720,pose:{eyeM:[0,0,0],targetM:[0,0,100],fovYDeg:40},light:{x:640,y:0}};
 const puffs=cloud.cloudPuffs(banks,options);assert.equal(puffs.length,1);
 assert.ok(puffs[0].centerM.every(Number.isFinite));
 assert.deepEqual(cloud.cloudPuffs(banks,{...options,allowPoint:()=>false}),[]);
});
test('rendered cloud puffs reach receiver uniforms only for moonlight and clear on absent clouds',async()=>{
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const THREE=await import('../src/vendor/range/three-range.module.js');
 assert.equal(typeof RangeScene.prototype._setCloudUniforms,'function');
 const camera=new THREE.PerspectiveCamera(40,1280/720,.1,100000);camera.lookAt(0,0,100);camera.updateMatrixWorld();
 const scene={camera,skyClouds:{banks:[{x:640,y:150,w:100,h:20,alpha:.4,puffs:1}],options:{width:1280,height:720}}};
 const p={uniforms:cloud.cloudUniforms(THREE)};
 RangeScene.prototype._setCloudUniforms.call(scene,p,{light:{celestial:{body:'moon'}}});
 assert.equal(p.uniforms.uMoonClouds.value,1);assert.equal(p.uniforms.uCloudCount.value,1);
 RangeScene.prototype._setCloudUniforms.call(scene,p,{light:{celestial:{body:'sun'}}});
 assert.equal(p.uniforms.uMoonClouds.value,0);
 scene.skyClouds=null;
 RangeScene.prototype._setCloudUniforms.call(scene,p,{light:{celestial:{body:'moon'}}});
 assert.equal(p.uniforms.uCloudCount.value,0);
});

test('painted cloud centers and radii retain their screen positions under off-axis zoom', async () => {
 const THREE=await import('three');
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const camera=new THREE.PerspectiveCamera(35,1280/720,20,150000);
 camera.position.set(100,1500,20000);camera.lookAt(0,2000,0);camera.updateMatrixWorld();
 const scene={camera,skyClouds:{banks:[{x:640,y:150,w:100,h:20,alpha:.4,puffs:1}],options:{width:1280,height:720}}};
 const p={uniforms:cloud.cloudUniforms(THREE)}, frame={light:{celestial:{body:'moon'}}};
 const projected=()=>{
  RangeScene.prototype._setCloudUniforms.call(scene,p,frame);
  const center=new THREE.Vector3(...p.uniforms.uCloudCenterRadius.value[0].toArray().slice(0,3));
  const edge=center.clone().addScaledVector(p.uniforms.uCloudRight.value,p.uniforms.uCloudCenterRadius.value[0].w);
  return [center.project(camera),edge.project(camera)];
 };
 const before=projected();
 camera.setViewOffset(1280,720,512,144,512,288);
 const after=projected();
 for(let i=0;i<before.length;i++) assert.ok(Math.abs(before[i].x-after[i].x)<1e-9 && Math.abs(before[i].y-after[i].y)<1e-9,'cloud shadow geometry must match the painted puff');
});
