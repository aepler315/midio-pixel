// Start npm run dev first; tests actual GPU transmission for distinct camera/lake rays.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH} : {}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/Shader Error|program not valid/.test(m.text()))errors.push(m.text());});
 await page.goto(process.argv[2] || 'http://127.0.0.1:8080');
 const samples=await page.evaluate(async()=>{
  const THREE=await import('/src/vendor/range/three-range.module.js');
  const {cloudUniforms,CLOUD_OCCLUSION_GLSL}=await import('/src/world/alpine/CloudOcclusion.js');
  const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(4,4);
  const u={...cloudUniforms(THREE),uReceiver:{value:new THREE.Vector3()},uDir:{value:new THREE.Vector3(0,Math.SQRT1_2,Math.SQRT1_2)}};
  u.uMoonClouds.value=1;
  for(const center of u.uCloudCenterRadius.value)center.set(1e6,1e6,1e6,1);
  for(const shape of u.uCloudShape.value)shape.set(1,0,1,0);
  u.uCloudRight.value.set(1,0,0);u.uCloudUp.value.set(0,1,0);u.uCloudForward.value.set(0,0,1);
  const material=new THREE.ShaderMaterial({uniforms:u,vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:CLOUD_OCCLUSION_GLSL+'\nuniform vec3 uReceiver,uDir;void main(){gl_FragColor=vec4(vec3(moonCloudTransmission(uReceiver,uDir)),1.);}'});
  const scene=new THREE.Scene(),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array([-1,-1,0,1,-1,0,1,1,0,-1,-1,0,1,1,0,-1,1,0]),3));const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;scene.add(mesh);
  const camera=new THREE.PerspectiveCamera(),target=new THREE.WebGLRenderTarget(4,4),pixels=new Uint8Array(4*4*4),samples=[];
  for(const index of [0,1,62,63]) {
   u.uCloudCount.value=index+1;u.uCloudCenterRadius.value[index].set(0,10,10,4);
   const shape=u.uCloudShape.value[Math.floor(index/2)],component=(index%2)*2;
   shape.setComponent(component,2).setComponent(component+1,.9);
   for(const [name,receiver] of [['camera',[0,0,0]],['lake',[0,-10,0]],['behind',[0,0,20]]]){
   u.uReceiver.value.set(...receiver);renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,4,4,pixels);samples.push({index,name,receiver,transmissionByte:pixels[0]});
  }
   u.uCloudCenterRadius.value[index].set(1e6,1e6,1e6,1);
   shape.setComponent(component,1).setComponent(component+1,0);
  }
  target.dispose();geometry.dispose();material.dispose();renderer.dispose();return samples;
 });
 assert.equal(samples.length,12);
 for(let i=0;i<samples.length;i+=3){assert.ok(samples[i].transmissionByte<40);assert.equal(samples[i+1].transmissionByte,255);assert.equal(samples[i+2].transmissionByte,255);}
 assert.deepEqual(errors,[]);
 await fs.mkdir((await import('node:path')).dirname(process.argv[3] || '.smoke/cloud-gpu.json'),{recursive:true});
 await fs.writeFile(process.argv[3] || '.smoke/cloud-gpu.json',JSON.stringify({browser:browser.version(),samples,errors},null,2)+'\n');console.log(JSON.stringify(samples));
}finally{await browser.close();}
