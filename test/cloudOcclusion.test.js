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

const field=await import('../src/world/alpine/RangeCloudField.js');
const sunUp=[.3,Math.sqrt(1-.3*.3-.2*.2),.2];
test('fair-weather shadow casters sit exactly where the sky paints the same bank',()=>{
 const out=new Float32Array(16*field.CLOUD_CASTER_STRIDE);
 const eyeM=[1200,2400,-3000], timeSec=37.25, seed=315;
 const count=field.cloudShadowCasters({eyeM,timeSec,seed,lightDir:sunUp,out});
 assert.ok(count>0 && count<=16);
 const cell={};
 // The middle sub-disc of a bank is the bank's own world centre.
 const centres=[];for(let i=1;i<count;i+=3)centres.push([...out.slice(i*6,i*6+3)]);
 const camera={tourPose:{eyeM,targetM:[eyeM[0]+sunUp[0]*1e5,eyeM[1]+sunUp[1]*1e5,eyeM[2]+sunUp[2]*1e5],fovYDeg:170,aspect:1.7}};
 const banks=field.cloudBanks({camera,width:1280,height:720,timeSec,seed});
 let matched=0;
 for(const b of banks){
  const [,ix,iz]=b.id.split(':').map(Number);
  field.cloudCell(ix,iz,seed,false,timeSec*10,timeSec*3,cell);
  assert.deepEqual(b.world,[cell.x,cell.y,cell.z],'banks and casters share one placement');
  if(centres.some(c=>Math.abs(c[0]-cell.x)<1e-2*Math.abs(cell.x)+.5&&Math.abs(c[2]-cell.z)<1e-2*Math.abs(cell.z)+.5))matched++;
 }
 assert.ok(matched>0,'a painted bank casts one of the selected shadows');
});
test('cloud shadow casters are a pure function of heard time',()=>{
 const run=t=>{const out=new Float32Array(96);const n=field.cloudShadowCasters({eyeM:[0,1000,0],timeSec:t,seed:7,lightDir:sunUp,out});return [n,[...out]];};
 assert.deepEqual(run(61.5),run(61.5));
 assert.notDeepEqual(run(61.5)[1],run(1.5)[1],'the banks drift on the wind');
 assert.equal(field.cloudShadowCasters({eyeM:[0,0,0],lightDir:[0,-1,0],out:new Float32Array(96)}),0,'no light from below');
});
test('a travelling eye never pops a whole cloud shadow in or out',()=>{
 // Summed shadow (opacity x footprint area, km^2) per heard frame while
 // the eye crosses ~190 km of tour: banks swap in and out of the selection
 // many times, but only ever through a 0-opacity rank.
 const out=new Float32Array(16*field.CLOUD_CASTER_STRIDE);
 let prev=null,worst=0,peak=0;
 for(let f=0;f<6000;f++){
  const n=field.cloudShadowCasters({eyeM:[f*30,2000,-f*12],timeSec:10+f/60,seed:315,lightDir:sunUp,out});
  assert.equal(n%3,0,'whole banks only');
  let sum=0;for(let i=0;i<n;i++)sum+=out[i*6+5]*out[i*6+3]*out[i*6+4]/1e6;
  if(prev!==null)worst=Math.max(worst,Math.abs(sum-prev));prev=sum;peak=Math.max(peak,sum);
 }
 assert.ok(peak>0);
 assert.ok(worst<.01*peak,`per-frame change ${worst} of peak ${peak}`);
});
const shadowScene=async()=>{
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const THREE=await import('../src/vendor/range/three-range.module.js');
 const camera=new THREE.PerspectiveCamera(40,16/9,20,150000);camera.position.set(500,2200,800);camera.lookAt(0,1500,-8000);camera.updateMatrixWorld();
 const uniforms={...cloud.cloudUniforms(THREE),uLightDir:{value:new THREE.Vector3(...sunUp)}};
 const set=frame=>RangeScene.prototype._setCloudUniforms.call({camera,skyClouds:null},{uniforms},frame);
 const snap=()=>JSON.stringify([uniforms.uCloudCount.value,uniforms.uCloudMode.value,uniforms.uCloudStrength.value,
  uniforms.uCloudCenterRadius.value.slice(0,16).map(v=>v.toArray()),uniforms.uCloudShape.value.slice(0,8).map(v=>v.toArray()),
  uniforms.uCloudRight.value.toArray(),uniforms.uCloudUp.value.toArray(),uniforms.uCloudForward.value.toArray()]);
 return {uniforms,set,snap,THREE};
};
const sunFrame=(timeMs,extra={})=>({timeMs,seed:315,qualityLevel:0,storm:{amount:0},light:{celestial:{body:'sun',visibility:1,intensity:1}},...extra});
test('the sun casts fair-weather cloud shadows on the default sky path (mode 1)',async()=>{
 const {uniforms,set}=await shadowScene();
 set(sunFrame(42000));
 assert.equal(uniforms.uCloudMode.value,1);
 assert.ok(uniforms.uCloudCount.value>0&&uniforms.uCloudCount.value<=16);
 assert.ok(Math.abs(uniforms.uCloudStrength.value-.4)<1e-12);
 set(sunFrame(42000,{storm:{amount:.5}}));
 assert.ok(Math.abs(uniforms.uCloudStrength.value-.2)<1e-12,'the squall deck takes over from fair-weather shadows');
 set(sunFrame(42000,{light:{celestial:{body:'sun',visibility:.5,intensity:1}}}));
 assert.ok(Math.abs(uniforms.uCloudStrength.value-.2)<1e-12);
});
test('a seek lands on the same cloud shadows as continuous play',async()=>{
 const a=await shadowScene(),b=await shadowScene();
 for(let t=0;t<=90000;t+=1500)a.set(sunFrame(t));
 b.set(sunFrame(5000));b.set(sunFrame(90000));
 assert.equal(a.snap(),b.snap());
});
test('no cloud shadows below the horizon, at q4, or with a painted legacy sky',async()=>{
 const {uniforms,set}=await shadowScene();
 set(sunFrame(42000,{qualityLevel:4}));
 assert.equal(uniforms.uCloudCount.value,0);assert.equal(uniforms.uCloudMode.value,0);
 set(sunFrame(42000,{qualityLevel:3}));assert.ok(uniforms.uCloudCount.value>0);
 uniforms.uLightDir.value.set(.9,.03,.43);
 set(sunFrame(42000));
 assert.equal(uniforms.uCloudCount.value,0);assert.equal(uniforms.uCloudStrength.value,0);
});
test('a q3 to q4 shed fades the cloud shadows out over heard time, and recovery fades them back',async()=>{
 const {uniforms}=await shadowScene();
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const camera=new (await import('../src/vendor/range/three-range.module.js')).PerspectiveCamera(40,16/9,20,150000);
 camera.position.set(500,2200,800);camera.lookAt(0,1500,-8000);camera.updateMatrixWorld();
 const p={uniforms};const set=frame=>RangeScene.prototype._setCloudUniforms.call({camera,skyClouds:null},p,frame);
 set(sunFrame(42000,{qualityLevel:3}));assert.ok(Math.abs(uniforms.uCloudStrength.value-.4)<1e-12);
 let last=.4,t=42000;
 for(let i=0;i<30;i++){
  set(sunFrame(t+=1000/60,{qualityLevel:4}));
  const s=uniforms.uCloudStrength.value;
  assert.ok(s>0&&s<last,`fading at ${t}: ${s}`);assert.equal(uniforms.uCloudMode.value,1);last=s;
 }
 set(sunFrame(t,{qualityLevel:4}));assert.equal(uniforms.uCloudStrength.value,last,'a paused frame holds');
 for(let i=0;i<120&&uniforms.uCloudCount.value;i++)set(sunFrame(t+=1000/60,{qualityLevel:4}));
 assert.equal(uniforms.uCloudCount.value,0,'count 0 at q4 once the fade ends');assert.equal(uniforms.uCloudMode.value,0);
 set(sunFrame(t+=1000/60,{qualityLevel:3}));
 const s=uniforms.uCloudStrength.value;assert.ok(s>0&&s<.05,`recovery fades in (${s})`);
 set(sunFrame(t+60000,{qualityLevel:3}));assert.ok(Math.abs(uniforms.uCloudStrength.value-.4)<1e-12,'a seek snaps');
});
test('the GLSL keeps the legacy moon path as mode 0 and caps world shadows',()=>{
 const glsl=cloud.CLOUD_OCCLUSION_GLSL;
 assert.match(glsl,/float celestialCloudTransmission\(vec3 p, vec3 dir\)\s*\{\s*if \(uCloudMode < 0\.5\) return moonCloudTransmission\(p, dir\);/);
 assert.match(glsl,/if \(dir\.y < 0\.05 \|\| uCloudCount <= 0\) return 1\.0;/);
 assert.match(glsl,/min\(uCloudStrength, 0\.40\)/);
 assert.match(glsl,/smoothstep\(0\.05, 0\.15, dir\.y\)/);
 assert.equal(glsl.match(/cloudBreakupNoise\(/g).length,2,'one breakup noise per fragment');
});
