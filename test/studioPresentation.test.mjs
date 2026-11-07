import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
function surface(width=800,height=450) {
  const canvas={width,height,draws:[]};
  const ctx={canvas,setTransform(){},fillRect(){},drawImage(...args){canvas.draws.push(args);},getImageData(){return {width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4)};},putImageData(){}};
  canvas.getContext=()=>ctx; canvas.ownerDocument={createElement:()=>surface(0,0)}; return canvas;
}
test('personal exploration view uses the normal stage and completed capture, then restores automatic scenery',()=>{
  let ordinary=0, updates=0;
  const canvas=surface(), frame=surface(320,180);
  const renderer=createPresentingRenderer({canvas,presentation:{pixelated:true,grid:{width:320,height:180},paletteId:'none',scaling:'fit'},rendererFactory:()=>({draw(){ordinary++;},dispose(){}})});
  assert.equal(typeof renderer.setStudioSource,'function');
  renderer.setStudioSource({canvas:frame,ready:true,update(sim){updates++;assert.equal(sim.heardTimeMs,1000);}});
  assert.equal(renderer.draw({heardTimeMs:1000},0).presented,true);
  assert.equal(ordinary,0); assert.equal(updates,1);
  assert.equal(renderer.diagnostics.terrainStudio,true);
  const captured=renderer.getCaptureSource();
  assert.ok(captured); assert.equal(captured.canvas,canvas);
  assert.equal(canvas.draws.at(-1)[0],frame);
  renderer.setStudioSource(null);
  renderer.draw({},0);
  assert.equal(ordinary,1); assert.equal(renderer.diagnostics.terrainStudio,false);
  renderer.dispose();
});
test('a pending personal view retains ordinary rendering until its first complete frame',()=>{
  let ordinary=0;
  const renderer=createPresentingRenderer({canvas:surface(),presentation:{pixelated:true,grid:{width:320,height:180},paletteId:'none',scaling:'fit'},rendererFactory:()=>({draw(){ordinary++;},dispose(){}})});
  assert.equal(typeof renderer.setStudioSource,'function');
  renderer.setStudioSource({canvas:surface(320,180),ready:false,update(){}});
  renderer.draw({},0); assert.equal(ordinary,1); renderer.dispose();
});
test('a failed personal frame can recover on seek and exports request exact rendering',()=>{
  let ready=false, syncRequested=false;
  const renderer=createPresentingRenderer({canvas:surface(),presentation:{pixelated:true,grid:{width:320,height:180},paletteId:'none',scaling:'fit'},rendererFactory:()=>({draw(){},dispose(){}})});
  renderer.setStudioSource({canvas:surface(320,180),get ready(){return ready;},update(sim,options){syncRequested=options.synchronous;ready=true;}});
  renderer.studioSynchronous=true;
  assert.equal(renderer.draw({heardTimeMs:1000},0).presented,true);
  assert.equal(syncRequested,true);
  assert.equal(renderer.diagnostics.terrainStudio,true);
  renderer.dispose();
});
test('exact personal captures fail instead of substituting automatic terrain after an uncovered move',()=>{
  let ordinary=0;
  const renderer=createPresentingRenderer({canvas:surface(),presentation:{pixelated:true,grid:{width:320,height:180},paletteId:'none',scaling:'fit'},rendererFactory:()=>({draw(){ordinary++;},dispose(){}})});
  renderer.setStudioSource({canvas:surface(320,180),ready:false,update(){}});
  renderer.studioSynchronous=true;
  const frame=renderer.draw({},0);
  assert.equal(frame.presented,false); assert.equal(frame.reason,'terrain-studio-unavailable'); assert.equal(ordinary,0);
  renderer.dispose();
});
test('a ready personal view does not wait for an authored GPU scene that it bypasses',async()=>{
  const {readFile}=await import('node:fs/promises');
  const vm=await import('node:vm');
  const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  const declaration=main.match(/const waitForLandscape = [\s\S]*?;/)?.[0];
  assert.ok(declaration);
  const context={exportMode:false,experience:'landscape',rangePresentation:{enabled:true},getWorld:()=>({kind:'alpine'}),timelineData:{},lastWorldId:null,DEFAULT_WORLD_ID:'range'};
  const wait=studioPlayback=>vm.runInNewContext(`${declaration}\nwaitForLandscape`,{...context,studioPlayback});
  assert.equal(wait(null),true); assert.equal(wait({ready:false}),true); assert.equal(wait({ready:true}),false);
});
