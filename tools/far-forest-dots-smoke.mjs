// Exercise the production ray/lattice painter, not a substitute shader.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { treeTraits } from '../src/world/alpine/ForestCover.js';
import { crownHalfWidth } from '../src/world/alpine/ForestProfile.js';
const [url='http://127.0.0.1:8094',out='.smoke/far-dots']=process.argv.slice(2);
await fs.mkdir(out,{recursive:false});
const errors=[],browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let report={passed:false};
try {
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route(url+'/',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));await page.goto(url);
  const partialSlab=[];
  for(let ix=-1000;ix<1000;ix++){
    const t=treeTraits(ix,3,315,1500,0,{treelineM:2700,treeScale:1},{tour:{}});
    const z=t.z-.95*t.height;
    if(z>=0&&z<13&&t.height>29)partialSlab.push([t.x,z]);
  }
  assert.ok(partialSlab.length>=4);
  const trait=treeTraits(0,0,315,1500,0,{treelineM:2700,treeScale:1},{tour:{}}),v=.533;
  const ratio=[.30,.38,.265,.425][trait.species];
  const left=crownHalfWidth(trait.species,v,trait.id,-1)*trait.width/ratio,right=crownHalfWidth(trait.species,v,trait.id,1)*trait.width/ratio;
  assert.ok(right-left>.1,'asymmetric fixture must distinguish profile sides');
  const sideFixture={root:[trait.x,trait.z],height:trait.height*v,fullHeight:trait.height,x:(left+right)/2};
  const wideTrait=treeTraits(-914,0,315,1500,0,{treelineM:1700,treeScale:4},{tour:{}});
  const wideHalf=crownHalfWidth(wideTrait.species,.08,wideTrait.id,1)*wideTrait.width/[.30,.38,.265,.425][wideTrait.species];
  const wideFixture={ix:-914,x:wideTrait.x+wideHalf*.98,z:wideTrait.z-.08*wideTrait.height};
  report=await page.evaluate(async ({partialSlab,sideFixture,wideFixture})=>{
    const T=await import('/src/vendor/range/three-range.module.js');
    const {FAR_TREE_DOTS_GLSL,SCENE_FRAG}=await import('/src/world/alpine/TerrainMaterial.js');
    if(!FAR_TREE_DOTS_GLSL)throw new Error('Phase 5 lattice painter missing');
    const renderer=new T.WebGLRenderer({antialias:false});renderer.setSize(64,64);renderer.outputColorSpace=T.LinearSRGBColorSpace;
    const target=new T.WebGLRenderTarget(64,64),pixels=new Uint8Array(64*64*4),scene=new T.Scene(),camera=new T.PerspectiveCamera(50,1,1,100000);
    camera.position.set(0,11500,10000);camera.updateMatrixWorld();
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    const surface=new T.DataTexture(new Uint8Array([128,128,128,0]),1,1);surface.needsUpdate=true;
    const uniforms={uFarForest:{value:new T.Vector4(6500,7800,1,8)},uForestSeed:{value:315},
      rForestDensity:{value:1},rForestFloor:{value:0},rTreeline:{value:2700},rForestMaxSlope:{value:36},
      uSurface:{value:surface},uGridOrigin:{value:new T.Vector2(-10000,-10000)},uGridExtent:{value:new T.Vector2(20000,20000)},uTexel:{value:new T.Vector2(1,1)},
      offset:{value:new T.Vector2()},footprint:{value:1},rise:{value:1},diagonal:{value:0}};
    const mat=new T.ShaderMaterial({glslVersion:T.GLSL3,uniforms,depthTest:false,
      vertexShader:'out vec3 vWorld;out vec3 vRenderedWorld;void main(){vWorld=vec3(0.,1500.,0.);vRenderedWorld=vWorld;gl_Position=vec4(position,1.);}',
      fragmentShader:`precision highp float; precision highp int; in vec3 vWorld;in vec3 vRenderedWorld;out vec4 outColor;
        uniform vec4 uFarForest;uniform uint uForestSeed;uniform float rForestDensity,rForestFloor,rTreeline,rForestMaxSlope;
        uniform sampler2D uSurface;uniform vec2 uGridOrigin,uGridExtent,uTexel,offset;uniform float footprint,rise;uniform int diagonal;
        ${FAR_TREE_DOTS_GLSL}
        void main(){vec3 P=vec3(gl_FragCoord.x+offset.x,1500.,gl_FragCoord.y+offset.y);vec3 normal;
          vec4 q=farTreeDots(P,normalize(vec3(0.,rise,1.)),vec3(0.,1.,0.),vec3(0.,1.,0.),0.,35.,vec2(footprint,diagonal==1?footprint:0.),vec2(diagonal==1?-footprint:0.,footprint),vec3(.2),normal);
          outColor=vec4(q.a,q.a,q.a,1.);}`});
    const mesh=new T.Mesh(geo,mat);mesh.frustumCulled=false;scene.add(mesh);
    const draw=()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,64,64,pixels);return Array.from(pixels);};
    const base=draw(),repeat=draw(),sweep=[],partialCoverage=[];
    uniforms.footprint.value=.1;
    for(const p of partialSlab){uniforms.offset.value.set(p[0]-32.5,p[1]-32.5);const bytes=draw();partialCoverage.push(bytes[(32*64+32)*4]);}
    uniforms.offset.value.set(0,0);uniforms.footprint.value=1;
    uniforms.footprint.value=.1;const fine=draw();uniforms.footprint.value=1;
    for(let step=0;step<=16;step++){uniforms.offset.value.set(step/16,0);const bytes=draw();sweep.push(bytes.filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0));}
    uniforms.offset.value.set(0,0);uniforms.rForestDensity.value=0;const empty=draw();uniforms.rForestDensity.value=1;
    uniforms.uFarForest.value.w=11;const shed=draw();uniforms.uFarForest.value.w=8;
    uniforms.footprint.value=8;const unresolved=draw();uniforms.footprint.value=1;
    uniforms.rise.value=.01;const grazing=draw();uniforms.rise.value=1;
    uniforms.uFarForest.value.x=15000;uniforms.uFarForest.value.y=16000;const near=draw();
    uniforms.uFarForest.value.set(0,0,1,8);const noInstances=draw();
    uniforms.uFarForest.value.set(6500,7800,.3,8);mat.defines.FAR_FOREST_KMAX=4;mat.needsUpdate=true;
    const mobile=draw();
    uniforms.footprint.value=8;const mobileUnresolved=draw();
    uniforms.uFarForest.value.set(6500,7800,1,8);uniforms.footprint.value=1;mat.defines.FAR_FOREST_KMAX=8;mat.needsUpdate=true;
    camera.position.y=16500;camera.updateMatrixWorld();const beyond15km=draw();
    camera.position.y=11500;camera.updateMatrixWorld();
    const shoreBytes=new Uint8Array([128,128,128,255,128,128,128,0,128,128,128,0,128,128,128,0]);
    const shoreTexture=new T.DataTexture(shoreBytes,2,2);shoreTexture.magFilter=shoreTexture.minFilter=T.LinearFilter;shoreTexture.needsUpdate=true;
    uniforms.uSurface.value=shoreTexture;uniforms.uTexel.value.set(.5,.5);const shoreline=draw();
    uniforms.uSurface.value=surface;uniforms.uTexel.value.set(1,1);
    // Execute the actual production handoff statements with an uncovered
    // painted sample. A half blend must keep the reference colour/normal.
    const start=SCENE_FRAG.indexOf('      if(dots>0. && forest>0.)');
    const finish=SCENE_FRAG.indexOf('      // Two snow scales',start);
    const block=SCENE_FRAG.slice(start,finish).replace(/vec4 painted=farTreeDots\([^;]+;/,'vec4 painted=vec4(0.);');
    const blend=new T.ShaderMaterial({glslVersion:T.GLSL3,depthTest:false,uniforms:{mode:{value:0}},
      vertexShader:'void main(){gl_Position=vec4(position,1.);}',fragmentShader:`precision highp float;uniform int mode;out vec4 outColor;
        void main(){float dots=.5,forest=1.,cover=.8,habitat=1.,snow=0.;bool water=false;
          vec3 crownLit=vec3(.4,.6,.8),dotNormal=vec3(0.,1.,0.),albedo,openGround=vec3(0.),understory=vec3(0.),ice=vec3(0.);
          float farCrownWeight,dotCrownWeight=0.;vec3 farCrownNormal;vec3 forestRay=normalize(vec3(1.,.5,0.));
          ${block}
          outColor=mode==0?vec4(albedo,cover):vec4(farCrownNormal*.5+.5,1.);}`});
    mesh.material=blend;const blendColour=draw().slice((32*64+32)*4,(32*64+32)*4+4);
    blend.uniforms.mode.value=1;const blendNormal=draw().slice((32*64+32)*4,(32*64+32)*4+3);
    blend.dispose();shoreTexture.dispose();mesh.material=mat;
    // Isolate eligibility to cell0; execute the unchanged production ray,
    // lateral coordinate and asymmetric profile on both physical sides.
    const isolated=mat.clone();isolated.uniforms=uniforms;
    isolated.fragmentShader=mat.fragmentShader.replace('if(forestU01(accept)>rForestDensity)continue;','if(any(notEqual(cell,ivec2(0))))continue;');
    mesh.material=isolated;uniforms.footprint.value=.01;const sideCoverage=[];
    for(const side of [-1,1]){uniforms.offset.value.set(sideFixture.root[0]+side*sideFixture.x-32.5,sideFixture.root[1]-sideFixture.height-32.5);
      sideCoverage.push(draw()[(32*64+32)*4]);}
    isolated.dispose();uniforms.offset.value.set(0,0);uniforms.footprint.value=1;mesh.material=mat;
    // A pixel whose centre is above a tip still intersects the crown when
    // its vertical footprint is broad. Centre-only profiles lose that mass.
    const broad=mat.clone();broad.uniforms=uniforms;broad.defines.FAR_FOREST_KMAX=8;
    broad.fragmentShader=mat.fragmentShader.replace('if(forestU01(accept)>rForestDensity)continue;','if(any(notEqual(cell,ivec2(0))))continue;')
      .replace('vec2(diagonal==1?-footprint:0.,footprint)','vec2(0.,16.)');
    mesh.material=broad;uniforms.footprint.value=.1;
    uniforms.offset.value.set(sideFixture.root[0]-32.5,sideFixture.root[1]-1.2*sideFixture.fullHeight-32.5);
    const broadVerticalCoverage=draw()[(32*64+32)*4];
    const centred=broad.clone();centred.uniforms=uniforms;
    centred.fragmentShader=broad.fragmentShader.replace('float sampleV=.5*(h0+h1)/max(t.height,.001);','float sampleV=clamp(v,0.,1.);');
    mesh.material=centred;const broadCentreNegative=draw()[(32*64+32)*4];centred.dispose();mesh.material=broad;
    broad.fragmentShader=broad.fragmentShader.replace('vec2(0.,16.)','vec2(0.,20.)');broad.needsUpdate=true;
    uniforms.offset.value.set(sideFixture.root[0]-32.5,13.2-32.5);
    const behindPixelCoverage=draw()[(32*64+32)*4];
    const unextended=broad.clone();unextended.uniforms=uniforms;
    unextended.fragmentShader=broad.fragmentShader.replace('vec2 start=P.xz-direction*(halfAlong+crossAlong);','vec2 start=P.xz;');
    mesh.material=unextended;const behindPixelNegative=draw()[(32*64+32)*4];unextended.dispose();
    broad.dispose();mesh.material=mat;uniforms.footprint.value=1;uniforms.offset.value.set(0,0);
    const wide=mat.clone();wide.uniforms=uniforms;
    wide.fragmentShader=mat.fragmentShader.replace('if(forestU01(accept)>rForestDensity)continue;',`if(any(notEqual(cell,ivec2(${wideFixture.ix},0))))continue;`);
    mesh.material=wide;uniforms.uFarForest.value.z=4;uniforms.rTreeline.value=1700;uniforms.footprint.value=.01;
    uniforms.offset.value.set(wideFixture.x-32.5,wideFixture.z-32.5);
    const wideCrownCoverage=draw()[(32*64+32)*4];
    const narrow=wide.clone();narrow.uniforms=uniforms;
    narrow.fragmentShader=wide.fragmentShader.replace('return .5*1.045*max(bound*.44,min(bound,6.*uFarForest.z));','return bound*.425*.5;');
    mesh.material=narrow;const wideRadiusNegative=draw()[(32*64+32)*4];narrow.dispose();
    wide.dispose();mesh.material=mat;uniforms.uFarForest.value.z=1;uniforms.rTreeline.value=2700;
    uniforms.offset.value.set(0,0);uniforms.footprint.value=1;
    // A diagonal ray must visit the primary slab reached by the lateral
    // crown flank, including a wide low-vigor stem at the walk's near edge.
    const diagonalCrown=mat.clone();diagonalCrown.uniforms=uniforms;
    diagonalCrown.fragmentShader=mat.fragmentShader
      .replace('if(forestU01(accept)>rForestDensity)continue;','if(any(notEqual(cell,ivec2(-982,0))))continue;')
      .replace('normalize(vec3(0.,rise,1.))','normalize(vec3(.7071067812,1.,.7071067812))')
      .replace('vec2(footprint,diagonal==1?footprint:0.)','vec2(.007071067812,-.007071067812)')
      .replace('vec2(diagonal==1?-footprint:0.,footprint)','vec2(.007071067812,.007071067812)');
    mesh.material=diagonalCrown;uniforms.uFarForest.value.z=4;uniforms.rTreeline.value=1700;
    uniforms.offset.value.set(-12752.065449362455-32.5,-.7783278881586821-32.5);
    const diagonalCrownCoverage=draw()[(32*64+32)*4];
    const missingLateral=diagonalCrown.clone();missingLateral.uniforms=uniforms;
    missingLateral.fragmentShader=diagonalCrown.fragmentShader
      .replace('direction*(halfAlong+crossAlong)','direction*halfAlong');
    mesh.material=missingLateral;const diagonalCrownNegative=draw()[(32*64+32)*4];missingLateral.dispose();
    diagonalCrown.dispose();mesh.material=mat;uniforms.uFarForest.value.z=1;uniforms.rTreeline.value=2700;
    uniforms.offset.value.set(0,0);uniforms.footprint.value=1;
    // A subpixel strip translated across adjacent pixels must retain area.
    // The adapter exercises the current production CDF before/after its
    // projected-box overload; it is not a substitute painter.
    const area=mat.clone();area.uniforms=uniforms;
    const cdf=FAR_TREE_DOTS_GLSL.includes('float farFootprintCDF(float x,float a,float b)')
      ? 'farFootprintCDF(.1-x,.5,0.)-farFootprintCDF(-.1-x,.5,0.)'
      : 'farFootprintCDF((.1-x)/.5)-farFootprintCDF((-.1-x)/.5)';
    area.fragmentShader=mat.fragmentShader.slice(0,mat.fragmentShader.lastIndexOf('        void main(){'))
      +`void main(){float x=gl_FragCoord.x-32.5+offset.x;float c=${cdf};outColor=vec4(c,c,c,1.);}`;
    mesh.material=area;const areaSweep=[];
    for(let step=0;step<=16;step++){uniforms.offset.value.x=step/16;areaSweep.push(draw().filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0));}
    area.dispose();mesh.material=mat;uniforms.offset.value.set(0,0);
    uniforms.diagonal.value=1;uniforms.footprint.value=4;const rotatedUnresolved=draw();
    const aliased=mat.clone();aliased.uniforms=uniforms;
    aliased.fragmentShader=mat.fragmentShader.replace('float side=abs(dot(dx,right))+abs(dot(dy,right));','float side=max(abs(dot(dx,right)),abs(dot(dy,right)));');
    mesh.material=aliased;const rotatedNegative=draw();aliased.dispose();mesh.material=mat;
    const images={base,repeat,empty,shed,unresolved,grazing,near,noInstances,mobile,mobileUnresolved,shoreline,rotatedUnresolved,rotatedNegative,beyond15km};
    const sums=Object.fromEntries(Object.entries(images).map(([name,bytes])=>[name,bytes.filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0)]));
    const hitPixels=base.filter((v,i)=>i%4===0&&v>0).length;
    const parity=base.every((v,i)=>v===repeat[i]);
    const variation=(Math.max(...sweep)-Math.min(...sweep))/(sweep.reduce((a,b)=>a+b,0)/sweep.length);
    const preview=document.createElement('canvas');preview.width=64;preview.height=64;preview.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(base),64,64),0,0);
    const png=preview.toDataURL().split(',')[1];
    mat.dispose();geo.dispose();surface.dispose();target.dispose();renderer.dispose();return {sums,hitPixels,parity,sweep,variation,png,base,fine,partialCoverage,blendColour,blendNormal,sideCoverage,broadVerticalCoverage,broadCentreNegative,behindPixelCoverage,behindPixelNegative,wideCrownCoverage,wideRadiusNegative,diagonalCrownCoverage,diagonalCrownNegative,areaSweep};
  },{partialSlab,sideFixture,wideFixture});
  assert.deepEqual(errors,[]);assert.equal(report.parity,true);
  // Independent exhaustive reference: visit every possible root, with no
  // primary-axis/K traversal. Smooth profiles are bounded by the unfiltered
  // outline plus the footprint; a missed whole crown cannot pass this check.
  let missed=0;
  for(let pz=0;pz<64;pz++)for(let px=0;px<64;px++) {
    const P=[px+.5,pz+.5]; let guaranteed=0;
    for(let iz=Math.floor(P[1]/13);iz<=Math.floor((P[1]+35)/13);iz++)for(let ix=Math.floor(P[0]/13)-1;ix<=Math.floor(P[0]/13)+1;ix++) {
      const t=treeTraits(ix,iz,315,1500,0,{treelineM:2700,treeScale:1},{tour:{}});
      const height=t.z-P[1],v=height/t.height,x=P[0]-t.x;
      if(v<=0||v>=1)continue;
      const ratio=[.30,.38,.265,.425][t.species], half=crownHalfWidth(t.species,v,t.id,x<0?-1:1)*t.width/ratio;
      // Allow the full detail envelope to disappear under filtering (.87 to 1,
      // ±4.5% raggedness). A point at least a pixel inside remains fully covered.
      if(Math.abs(x)<half*.75-.1 && height>.1 && height<t.height-.1)guaranteed=1;
    }
    if(guaranteed&&report.fine[(pz*64+px)*4]<250)missed++;
  }
  report.missedInteriors=missed;delete report.base;delete report.fine;
  report.areaVariation=(Math.max(...report.areaSweep)-Math.min(...report.areaSweep))/(report.areaSweep.reduce((a,b)=>a+b,0)/report.areaSweep.length);
  assert.ok(report.areaVariation<.025,`subpixel strip loses area across pixels: ${report.areaVariation}`);
  assert.ok(report.wideCrownCoverage>=250,`mature-only culling loses a scaled low-vigor crown: ${report.wideCrownCoverage}`);
  assert.ok(report.diagonalCrownCoverage>=250,`diagonal primary bound loses wide flank: ${report.diagonalCrownCoverage}`);
  assert.equal(report.diagonalCrownNegative,0,'omitted lateral primary prefix must reproduce skipped diagonal crown');
  assert.equal(report.wideRadiusNegative,0,'mature-only bound must reproduce a culled wide crown');
  assert.ok(report.broadVerticalCoverage>8,`broad pixel loses a crown above its centre: ${report.broadVerticalCoverage}`);
  assert.equal(report.broadCentreNegative,0,'centre-only negative control must lose the intersected tip');
  assert.ok(report.behindPixelCoverage>0,'pixel footprint reaches the cell behind its centre');
  assert.equal(report.behindPixelNegative,0,'unextended walk must reproduce omitted near pixel coverage');
  assert.equal(missed,0,'bounded walk misses crowns wholly inside its supported reach');
  assert.ok(report.partialCoverage.every(c=>c>=250),`partial first slab misses known crown tips: ${report.partialCoverage}`);
  const defects=[];
  if(report.sums.shoreline!==0)defects.push(`shoreline roots accepted: ${report.sums.shoreline}`);
  if(report.blendColour.some((v,i)=>Math.abs(v-[41,61,82,102][i])>1))defects.push(`handoff dark cross term: ${report.blendColour}`);
  const expectedNormal=[.6,.5,0],normalLength=Math.hypot(...expectedNormal);
  if(report.blendNormal.some((v,i)=>Math.abs(v-(expectedNormal[i]/normalLength*.5+.5)*255)>1))defects.push(`uncovered painter tilts crown normal: ${report.blendNormal}`);
  if(report.sideCoverage[0]!==0||report.sideCoverage[1]!==255)defects.push(`asymmetric outline mirrored: ${report.sideCoverage}`);
  assert.deepEqual(defects,[]);
  report.blendColour.forEach((v,i)=>assert.ok(Math.abs(v-[41,61,82,102][i])<=1,`empty painted sample darkens handoff: ${report.blendColour}`));
  const normal=[.6,.5,0],len=Math.hypot(...normal);report.blendNormal.forEach((v,i)=>assert.ok(Math.abs(v-(normal[i]/len*.5+.5)*255)<=1,'uncovered painted sample changes mean crown normal'));
  assert.ok(report.hitPixels>100&&report.hitPixels<3500,'resolved crowns must form individual strokes and gaps');
  for(const name of ['empty','shed','unresolved','grazing','near','mobileUnresolved','rotatedUnresolved','beyond15km'])assert.equal(report.sums[name],0,`${name} must return to cover only`);
  assert.equal(report.sums.noInstances,report.sums.base,'no-instance far painter remains available');
  assert.ok(report.sums.rotatedNegative>0,'rotated-footprint negative control must expose aliased detail');
  assert.ok(report.sums.mobile>0,'mobile Kmax4 shader must render supported resolved crowns');
  assert.ok(report.variation<.04,`subpixel coverage variation ${report.variation}`);
  await fs.writeFile(path.join(out,'coverage.png'),Buffer.from(report.png,'base64'));delete report.png;
  report.passed=true;console.log(JSON.stringify(report));
} finally {delete report.png;await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...report,errors},null,2));await browser.close();}
