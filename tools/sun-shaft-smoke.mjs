// Production RangeScene receiver pixel regression. Run with an output directory
// and WAV fixture; PLAYWRIGHT_CHROMIUM_PATH selects the installed browser.
// Camera, music, travel and geometry are frozen while celestial state changes.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { openSong, captureFrame } from "./range-scene-smoke.mjs";
import { seedBrowserConstruction } from "./lib/landscape-browser.mjs";
const out = path.resolve(process.argv[2] || "work/sun-shaft"), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), report = { sources: {} };
const wav = process.argv[3];
if (!wav) throw new Error("Usage: node tools/sun-shaft-smoke.mjs OUTPUT_DIRECTORY WAV_FILE");
await fs.mkdir(out, { recursive: true });
const url = process.env.RANGE_LIGHTING_URL || "http://127.0.0.1:8194";
for (const file of ["RangeScene", "TerrainMaterial", "ForestGL", "RangePresentation", "RangeQuality", "SunShaftGL"]) {
  const name = `src/world/alpine/${file}.js`, local = await fs.readFile(path.join(root, name)), served = Buffer.from(await (await fetch(url + "/" + name)).arrayBuffer());
  assert.ok(local.equals(served));
  report.sources[name] = createHash("sha256").update(local).digest("hex");
}
const browser = await chromium.launch({ ...process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}, args: process.env.PLAYWRIGHT_CHROMIUM_PATH ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const wrapper = { async newContext(options) {
    const c = await browser.newContext(options);
    await c.addInitScript(seedBrowserConstruction, 315);
    await c.addInitScript(() => {
      const install = () => {
        if (!document.body) return false;
        const input = document.createElement("input");
        input.hidden = true;
        input.id = "seedInput";
        input.value = "0xADDE5713";
        document.body.prepend(input);
        return true;
      };
      if (!install()) {
        const observer = new MutationObserver(() => {
          if (install()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    });
    return c;
  } };
  const opened = await openSong(wrapper, { url, wav: path.resolve(wav), width: 1280, height: 720, dpr: 1, params: { rangeRenderer: "v2", rangeView: "teton-jackson-lake", seed: "2917029651" } });
  await captureFrame(opened.page, 250);
  await captureFrame(opened.page, 2e4);
  const evidence = await opened.page.evaluate(async () => {
    const app = window.__SMW, pres = app.sim.biomes.rangePresentation, scene = pres.scene, base = pres.frame, p = scene.prepared.get(pres.viewId), T = scene.THREE;
    scene.renderer.debug.checkShaderErrors=true;
    const { resolveCelestialState } = await import("/src/world/CelestialState.js");
    const originalDepth = p.depthScene, originalFar = p.scenes.far, originalUniforms=scene._setUniforms;
    let hiddenKind=null;
    scene._setUniforms=function(pr,frame){
      originalUniforms.call(this,pr,frame);
      if(pr===p && hiddenKind)for(const tree of pr.forest.depth)
        if(hiddenKind==='all'||(tree.material.vertexShader.includes('vNormal')?'mesh':'billboard')===hiddenKind)tree.visible=false;
    };
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),3));
    const mat = new T.ShaderMaterial({ glslVersion:T.GLSL3, colorWrite:false,
      uniforms:{mode:{value:0},depthZ:{value:0}},
      vertexShader:`out vec2 vTestUv;uniform float depthZ; void main(){vTestUv=position.xy*.5+.5;gl_Position=vec4(position.xy,depthZ,1.);}`,
      fragmentShader:`precision highp float; in vec2 vTestUv; uniform int mode; out vec4 color;
        void main(){if(mode==3)discard;bool slit=mod(vTestUv.x*12.,1.)<.24;
          if(mode>0 && (vTestUv.y>.72 || slit) && !(mode==2 && vTestUv.x>.43 && vTestUv.x<.57 && vTestUv.y<.7)) discard;
          color=vec4(0.);}` });
    const depthScene=new T.Scene(), occluder=new T.Mesh(geo,mat);occluder.frustumCulled=false;depthScene.add(occluder);
    p.depthScene=depthScene; p.scenes.far=new T.Scene();
    let id=base.frameId+10000;
    const imgs={}, metrics={}, pixelSets={};
    // Source aperture edges are measured in the same logical pixels as the
    // actual celestial painter, independently of the target backing aspect.
    const apertureEdges=[];
    const edgeMat=new T.ShaderMaterial({glslVersion:T.GLSL3,colorWrite:false,
      uniforms:{uLogical:{value:new T.Vector2()},uSun:{value:new T.Vector2()},uOpen:{value:0}},
      vertexShader:`out vec2 vEdgeUv;void main(){vEdgeUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}`,
      fragmentShader:`precision highp float;in vec2 vEdgeUv;uniform vec2 uLogical;uniform vec2 uSun;uniform int uOpen;out vec4 color;
        void main(){vec2 px=(vEdgeUv-uSun)*uLogical;
          if(uOpen==0){if(length(px)>28.)discard;}
          else {if(length(px)>60.||length(px-vec2(25.5,0.))<2.5)discard;}
          color=vec4(0.);}`});
    const edgeMesh=new T.Mesh(geo,edgeMat);edgeMesh.frustumCulled=false;
    const edgeScene=new T.Scene();edgeScene.add(edgeMesh);
    for(const [name,LW,LH,BW,BH]of [['landscape',1405,845,1405,845],['portrait',845,1405,845,1405],['nonuniform',1405,845,2810,422]]){
      scene.resize({widthPx:BW,heightPx:BH});p.depthScene=edgeScene;
      const state=resolveCelestialState({timeMs:21000,cycleMs:100000,viewport:{width:LW,height:LH}});
      edgeMat.uniforms.uLogical.value.set(LW,LH);edgeMat.uniforms.uSun.value.set(state.sun.xFrac,1-state.sun.yFrac);
      const row={name,logical:[LW,LH],backing:[BW,BH],paintedRadius:state.sun.radiusFrac*LW};
      for(const [label,open]of [['closedDisc',0],['edgeOpening',1]]){
        edgeMat.uniforms.uOpen.value=open;
        const frame={...base,frameId:++id,qualityLevel:0,scenicViewport:{...base.scenicViewport,logicalWidth:LW,logicalHeight:LH,backingWidth:BW,backingHeight:BH},
          light:{...base.light,state,celestial:{...state.sun,body:'sun',intensity:state.sun.directGain}}};
        scene.prepareShafts(frame,[pres.viewId]);
        const source=scene.renderPartition(frame,'far',pres.viewId);
        const c=document.createElement('canvas');c.width=BW;c.height=BH;const ctx=c.getContext('2d');ctx.drawImage(source,0,0);
        const data=ctx.getImageData(0,0,BW,BH).data;let lit=0,max=0;
        for(let i=3;i<data.length;i+=4){if(data[i])lit++;max=Math.max(max,data[i]);}
        row[label]={lit,max};row.apertureLogicalPixels=scene.shafts.uniforms.uRadius.value.toArray().map((v,i)=>v*(i?LH:LW));
        ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#101826';ctx.fillRect(0,0,BW,BH);
        imgs[`aperture-${name}-${label}`]=c.toDataURL('image/png').split(',')[1];
      }
      apertureEdges.push(row);
    }
    edgeMat.dispose();p.depthScene=depthScene;
    scene.resize({widthPx:base.scenicViewport.backingWidth,heightPx:base.scenicViewport.backingHeight});
    function draw(label,mode,phase=.21,{enable=true,whole=false}={}){
      mat.uniforms.mode.value=mode;
      const state=resolveCelestialState({timeMs:phase*100000,cycleMs:100000,viewport:{width:base.scenicViewport.logicalWidth,height:base.scenicViewport.logicalHeight}});
      const b=state[state.activeBody]||state.sun;
      const light={...base.light,state,celestial:{...b,body:state.activeBody,intensity:state.activeBody?b.directGain:0}};
      const frame={...base,frameId:++id,qualityLevel:0,light};
      const admitted=enable ? scene.prepareShafts?.(frame,[pres.viewId]) : (scene.releaseShafts?.(),false);
      const trace={};const rr=scene.renderer.render;
      scene.renderer.render=function(sc,cam){
        const result=rr.call(this,sc,cam);
        if(sc===depthScene){trace.called=true;trace.depthWrite=mat.depthWrite;trace.visible=occluder.visible;trace.info={...this.info.render};
          const gl=this.getContext();trace.depthEnabled=gl.isEnabled(gl.DEPTH_TEST);trace.depthMask=gl.getParameter(gl.DEPTH_WRITEMASK);
          trace.fbo=gl.checkFramebufferStatus(gl.FRAMEBUFFER);trace.error=gl.getError();
        }return result;
      };
      const source=scene.renderPartition(frame,'far',pres.viewId);scene.renderer.render=rr;
      const c=document.createElement('canvas');c.width=source.width;c.height=source.height;
      const ctx=c.getContext('2d');ctx.drawImage(source,0,0);
      if(whole)for(const pass of ['mid','near'])ctx.drawImage(scene.renderPartition(frame,pass,pres.viewId),0,0);
      const data=ctx.getImageData(0,0,c.width,c.height).data;pixelSets[label]=data;
      let lit=0,blocked=0,max=0,energy=0;
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
        const i=(y*c.width+x)*4,a=data[i+3];
        if(a){lit++;energy+=a;max=Math.max(max,a);if((x+.5)/c.width>.43&&(x+.5)/c.width<.57&&(y+.5)/c.height>.3)blocked++;}
      }
      imgs[label]=c.toDataURL('image/png').split(',')[1];
      // Opaque review copy at the actual opacity: alpha-ignoring image viewers
      // otherwise show the straight RGB of dim transparent shafts as white.
      ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#101826';ctx.fillRect(0,0,c.width,c.height);
      imgs[label+'-over-slate']=c.toDataURL('image/png').split(',')[1];
      let quarterMax=0, depthRange=null;
      if(scene.shafts){const buf=scene.shafts.buffers.A, q=new Uint8Array(buf.width*buf.height*4);
        scene.renderer.readRenderTargetPixels(buf,0,0,buf.width,buf.height,q);quarterMax=Math.max(...new Set(q));
        const m=scene.shafts.scatter.clone();m.uniforms=scene.shafts.uniforms;
        m.fragmentShader=`precision highp float;uniform sampler2D uDepth;in vec2 vUv;out vec4 outColor;void main(){outColor=vec4(vec3(texture(uDepth,vUv).r),1.);}`;
        scene.shafts.mesh.material=m;scene.renderer.setRenderTarget(buf);scene.renderer.render(scene.shafts.scene,scene.shafts.camera);
        scene.renderer.readRenderTargetPixels(buf,0,0,buf.width,buf.height,q);
        let min=255,max=0;for(let i=0;i<q.length;i+=4){min=Math.min(min,q[i]);max=Math.max(max,q[i]);}depthRange={min,max};m.dispose();scene.renderer.setRenderTarget(null);
      }
      metrics[label]={lit,blocked,max,energy,admitted,quarterMax,depthRange,source:light.celestial,trace};return frame;
    }
    draw('closed',0);mat.uniforms.depthZ.value=.999;draw('closed-distant',0);mat.uniforms.depthZ.value=0;draw('all-open',3);draw('openings',1);draw('near-blocker',2);
    draw('moon',1,.71);draw('dusk-gap',1,.45);draw('dawn-gap',1,.96);
    // Production approved view, retaining its actual terrain and all matching
    // wind/deformation/silhouette depth twins. First isolate the air pixels,
    // then compare full scenic partitions at identical material quality.
    p.depthScene=originalDepth;
    const dayFrame=draw('actual-air',1);
    p.scenes.far=originalFar;
    draw('actual-on',1,.21,{whole:true});draw('actual-off',1,.21,{enable:false,whole:true});
    const actualDelta={changed:0,max:0,energy:0,maxPremultiplied:0};
    for(let i=0;i<pixelSets['actual-on'].length;i+=4){
      let d=0;for(let j=0;j<4;j++)d=Math.max(d,Math.abs(pixelSets['actual-on'][i+j]-pixelSets['actual-off'][i+j]));
      if(d){actualDelta.changed++;actualDelta.energy+=d;actualDelta.max=Math.max(actualDelta.max,d);}
      for(let j=0;j<3;j++)actualDelta.maxPremultiplied=Math.max(actualDelta.maxPremultiplied,
        Math.abs(pixelSets['actual-on'][i+j]*pixelSets['actual-on'][i+3]/255-pixelSets['actual-off'][i+j]*pixelSets['actual-off'][i+3]/255));
    }
    p.scenes.far=new T.Scene();
    const trees=p.forest.depth;
    hiddenKind='all';draw('actual-without-forest',1);hiddenKind=null;for(const o of trees)o.visible=true;
    let forestChanged=0;for(let i=0;i<pixelSets['actual-air'].length;i+=4)
      if(pixelSets['actual-air'][i+3]!==pixelSets['actual-without-forest'][i+3])forestChanged++;
    // Also retain a forest-only depth diagnostic, using the production twins,
    // not a substitute alpha mask, to expose their apertures against air.
    const forestScene=new T.Scene();for(const o of trees)forestScene.add(o.clone());
    p.depthScene=forestScene;draw('actual-forest-apertures',1);
    for(const kind of ['mesh','billboard']){
      const isolated=new T.Scene();for(const o of trees)
        if((o.material.vertexShader.includes('vNormal')?'mesh':'billboard')===kind)isolated.add(o.clone());
      p.depthScene=isolated;draw('forest-'+kind,1);
    }
    p.depthScene=originalDepth;p.scenes.far=originalFar;
    const representation={};
    p.scenes.far=new T.Scene();
    for(const kind of ['mesh','billboard']){
      hiddenKind=kind;draw('without-'+kind,1);hiddenKind=null;for(const o of trees)o.visible=true;
      let changed=0;for(let i=0;i<pixelSets['actual-air'].length;i+=4)
        if(pixelSets['actual-air'][i+3]!==pixelSets['without-'+kind][i+3])changed++;
      representation[kind]=changed;
    }
    const getPixels=(source,label)=>{
      const c=document.createElement('canvas');c.width=source.width;c.height=source.height;
      const ctx=c.getContext('2d');ctx.drawImage(source,0,0);
      if(label)imgs[label]=c.toDataURL('image/png').split(',')[1];
      return ctx.getImageData(0,0,c.width,c.height).data;
    };
    const energy=(data)=>{let e=0;for(let i=3;i<data.length;i+=4)e+=data[i];return e;};
    // Actual RangePresentation travel compositor, distinct A/B depth scenes,
    // near-band columns and incoming arrival fade. No replacement compositor.
    const oldDepthBands=p.depthScenes,oldScenes=p.scenes;
    const empty=new T.Scene(), closedMat=mat.clone();closedMat.uniforms={mode:{value:0},depthZ:{value:0}};
    const closedMesh=new T.Mesh(geo,closedMat);closedMesh.frustumCulled=false;
    const closedScene=new T.Scene();closedScene.add(closedMesh);
    const nearMat=mat.clone();nearMat.fragmentShader=`precision highp float;in vec2 vTestUv;out vec4 color;
      void main(){if(vTestUv.x<.43||vTestUv.x>.57||vTestUv.y>.7)discard;color=vec4(0.);}`;
    const nearMesh=new T.Mesh(geo,nearMat);nearMesh.frustumCulled=false;
    const nearScene=new T.Scene();nearScene.add(nearMesh);
    mat.uniforms.mode.value=1;p.depthScene=depthScene;p.depthScenes={far:depthScene,mid:empty,near:nearScene};
    p.scenes={far:empty,mid:empty,near:empty};
    const bId='fixture-closed-side';scene.prepared.set(bId,{...p,view:{...p.view,id:bId},depthScene:closedScene,depthScenes:{far:closedScene,mid:empty,near:empty}});
    scene.ensureSide('B');pres._ensureScratch(base.scenicViewport);
    const travelFrame={...dayFrame,frameId:++id};scene.prepareShafts(travelFrame,[pres.viewId,bId]);
    const bundle={bytes:scene.residency.entries.get('range:sun-shafts')?.bytes,sides:Object.keys(scene.shafts.buffers),sizes:Object.values(scene.shafts.buffers).map(b=>[b.width,b.height])};
    const clipped=getPixels(scene.renderPartition(travelFrame,'far',pres.viewId,{side:'A',bandColumns:{near:[.5,1]}}),'clipped-near');
    const covered=getPixels(scene.renderPartition({...travelFrame,frameId:++id},'far',pres.viewId,{side:'A',bandColumns:{near:[0,1]}}),'full-near');
    let clippedOpen=0,coveredWash=0;const W=scene.size.width,H=scene.size.height;
    for(let y=Math.ceil(H*.32);y<H*.9;y++)for(let x=Math.ceil(W*.431);x<W*.435;x++){
      const i=(y*W+x)*4;clippedOpen+=clipped[i+3]>0?1:0;coveredWash+=covered[i+3]>0?1:0;
    }
    const oldPres={frame:pres.frame,incomingViewId:pres.incomingViewId,seamP:pres.seamP,incomingFade:pres.incomingFade,arrival:pres.arrival};
    Object.assign(pres,{frame:travelFrame,incomingViewId:bId,seamP:.5,arrival:1});
    const travel={bundle,clippedOpen,coveredWash,frames:{}};
    for(const fade of [0,.5,1]){
      pres.incomingFade=fade;pres.frame={...travelFrame,frameId:++id};
      const c=document.createElement('canvas');c.width=W;c.height=H;
      pres.drawPartition(c.getContext('2d'),'far',{width:W,height:H});
      const data=getPixels(c,'travel-'+fade);travel.frames[fade]={energy:energy(data)};
    }
    const mid=getPixels(scene.renderPartition({...travelFrame,frameId:++id},'mid',pres.viewId));
    const near=getPixels(scene.renderPartition({...travelFrame,frameId:++id},'near',pres.viewId));
    travel.midEnergy=energy(mid);travel.nearEnergy=energy(near);
    Object.assign(pres,oldPres);scene.prepared.delete(bId);scene.releaseSide('B');pres._releaseScratch();
    travel.released=scene.shafts===null && scene.sideTargets.B===null;
    p.depthScene=originalDepth;p.depthScenes=oldDepthBands;p.scenes=oldScenes;p.scenes.far=originalFar;
    // Budget denial on the real scene leaves its base entries and material key.
    scene.releaseShafts();const ledger=scene.residency,budget=ledger.budgetBytes,keys=[...ledger.entries.keys()],keyBefore=p.uniforms.uLightColor.value.toArray();
    ledger.budgetBytes=ledger.usedBytes;
    const denied=!scene.prepareShafts({...dayFrame,frameId:++id},[pres.viewId]);
    const denial={denied,keysPreserved:keys.every(k=>ledger.has(k)),optionalAbsent:!scene.shafts,keyUnchanged:keyBefore.every((v,i)=>v===p.uniforms.uLightColor.value.toArray()[i])};
    ledger.budgetBytes=budget;
    scene.prepareShafts(dayFrame,[pres.viewId]);
    scene.prepareShafts({...dayFrame,qualityLevel:3},[pres.viewId]);
    denial.qualityShed=!scene.shafts;
    scene.prepareShafts(dayFrame,[pres.viewId]);
    scene.renderPartition({...dayFrame,frameId:++id},'far',pres.viewId);
    const oldDepth=scene.target.depthTexture;let depthDisposals=0;oldDepth.addEventListener('dispose',()=>depthDisposals++);
    scene.resize({widthPx:1024,heightPx:768});
    const resized={released:!scene.shafts,depthDisposals};
    scene.prepareShafts(dayFrame,[pres.viewId]);
    resized.size=[scene.shafts.buffers.A.width,scene.shafts.buffers.A.height];
    scene.renderPartition({...dayFrame,frameId:++id},'far',pres.viewId);
    scene.resize({widthPx:W,heightPx:H});scene.prepareShafts(dayFrame,[pres.viewId]);
    geo.dispose();mat.dispose();closedMat.dispose();nearMat.dispose();scene._setUniforms=originalUniforms;
    const gl=scene.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {imgs,metrics,apertureEdges,actualDelta,forestChanged,representation,travel,denial,resized,dayFrame:{timeMs:dayFrame.timeMs,source:dayFrame.light.celestial},forestCounts:p.forest.counts,seed:app.sim.songSeed,active:pres.active,view:pres.viewId,renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),glError:gl.getError(),residency:scene.residency.snapshot()};
  });
  for(const [name,png] of Object.entries(evidence.imgs)) await fs.writeFile(path.join(out,name+'.png'),Buffer.from(png,'base64'));
  delete evidence.imgs;report.evidence=evidence;
  const lifecycle=await opened.page.evaluate(async()=>{
    const pres=window.__SMW.sim.biomes.rangePresentation,scene=pres.scene,canvas=scene.canvas;
    const ext=scene.renderer.getContext().getExtension('WEBGL_lose_context');
    const before={epoch:scene.contextEpoch,optional:!!scene.shafts};
    const gl=scene.renderer.getContext();window.__shaftTrace=[];window.__shaftOriginals={};
    for(const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','useProgram','bindFramebuffer','framebufferTexture2D','texImage2D','deleteTexture','deleteBuffer','deleteProgram','deleteFramebuffer','deleteRenderbuffer','deleteVertexArray','bindTexture']){
      const original=gl[name];window.__shaftOriginals[name]=original;gl[name]=function(...args){
        const pre=this.getError();const value=original.apply(this,args);const error=this.getError();
        if(pre||error)window.__shaftTrace.push({name,pre,error});return value;
      };
    }
    await new Promise(resolve=>{canvas.addEventListener('webglcontextlost',resolve,{once:true});ext.loseContext();});
    const lost={epoch:scene.contextEpoch,optional:!!scene.shafts,entry:scene.residency.has('range:sun-shafts'),depth:!!scene.target?.depthTexture};
    await new Promise(resolve=>setTimeout(resolve,100));
    await new Promise(resolve=>{canvas.addEventListener('webglcontextrestored',resolve,{once:true});ext.restoreContext();});
    return {before,lost,restoredEpoch:scene.contextEpoch,initialError:gl.getError()};
  });
  await captureFrame(opened.page,20000); // first frame recreates the essential ground target
  const recovered=await captureFrame(opened.page,20000);
  lifecycle.recovered=await opened.page.evaluate(()=>{
    const pres=window.__SMW.sim.biomes.rangePresentation,scene=pres.scene;
    const gl=scene.renderer.getContext();for(const [name,original]of Object.entries(window.__shaftOriginals))gl[name]=original;
    return {trace:window.__shaftTrace,active:pres.active,optional:!!scene.shafts,depth:!!scene.target?.depthTexture,view:pres.viewId,glError:scene.renderer.getContext().getError(),residency:scene.residency.snapshot()};
  });
  await fs.writeFile(path.join(out,'recovered.png'),Buffer.from(recovered.png,'base64'));
  report.lifecycle=lifecycle;report.errors=opened.errors;
  assert.ok(lifecycle.before.optional);assert.equal(lifecycle.lost.optional,false);assert.equal(lifecycle.lost.entry,false);assert.equal(lifecycle.lost.depth,false);
  assert.ok(lifecycle.recovered.active && lifecycle.recovered.optional && lifecycle.recovered.depth);
  assert.equal(lifecycle.initialError,0);assert.deepEqual(lifecycle.recovered.trace.filter(x=>x.error===1282||x.pre===1282),[]);assert.equal(lifecycle.recovered.glError,0);assert.equal(lifecycle.recovered.residency.overcommits,0);
  assert.ok(evidence.active);
  for(const row of evidence.apertureEdges){
    assert.equal(row.closedDisc.lit,0,row.name+' cannot sample sky outside the occluded painted disc');
    assert.ok(row.edgeOpening.lit>0,row.name+' must admit the narrow visible disc-edge opening');
  }
  assert.ok(evidence.actualDelta.changed>0,'actual approved view must visibly change');
  assert.ok(evidence.forestChanged>0,'actual forest depth must change the scattering pattern');
  assert.ok(evidence.metrics['actual-forest-apertures'].lit>0,'actual forest apertures transmit solar scattering');
  for(const kind of ['mesh','billboard'])assert.ok(evidence.metrics['forest-'+kind].lit>0,kind+' production depth controls the aperture pattern');
  assert.ok(evidence.travel.clippedOpen>0);assert.equal(evidence.travel.coveredWash,0);
  assert.ok(evidence.travel.frames[0].energy>evidence.travel.frames[.5].energy);
  assert.ok(evidence.travel.frames[.5].energy>evidence.travel.frames[1].energy);
  assert.equal(evidence.travel.midEnergy,0);assert.equal(evidence.travel.nearEnergy,0);assert.ok(evidence.travel.released);
  assert.ok(Object.values(evidence.denial).every(Boolean));
  assert.ok(evidence.resized.released);assert.equal(evidence.resized.depthDisposals,1);
  assert.deepEqual(evidence.resized.size,[256,192]);
  assert.equal(evidence.metrics.closed.lit,0,'fully closed occluder has exact zero light');
  assert.equal(evidence.metrics['closed-distant'].lit,0,'closed distant occluder hides the source');
  assert.equal(evidence.metrics['all-open'].lit,0,'unoccluded sky cannot manufacture a decorative fan');
  assert.ok(evidence.metrics.openings.lit>100,'openings must produce actual occluded solar scattering');
  assert.equal(evidence.metrics['near-blocker'].blocked,0,'opaque foreground receives exact zero wash');
  for(const state of ['moon','dusk-gap','dawn-gap'])assert.equal(evidence.metrics[state].lit,0,state+' has no solar effect');
  assert.equal(evidence.glError,0);assert.equal(evidence.residency.overcommits,0);
  assert.deepEqual(opened.errors,[]);
  report.disposal=await opened.page.evaluate(()=>{
    const scene=window.__SMW.sim.biomes.rangePresentation.scene;
    scene.dispose();const owners=scene.residency.snapshot().byOwner;
    return {optional:!!scene.shafts,prepared:scene.prepared.size,shafts:owners['range-shafts']||null,targets:owners['range-targets']||null};
  });
  assert.deepEqual(report.disposal,{optional:false,prepared:0,shafts:null,targets:null});
  console.log(JSON.stringify({actualDelta:evidence.actualDelta,forestChanged:evidence.forestChanged,travel:evidence.travel,denial:evidence.denial,resized:evidence.resized,renderer:evidence.renderer,lifecycle,disposal:report.disposal}));
} catch(e){report.error=String(e.stack);console.error(report.error);process.exitCode=1;}
finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
