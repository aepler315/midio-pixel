import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { rangeQuality } from '../src/world/alpine/RangeQuality.js';
import * as THREE from 'three';
import { resolveCelestialState } from '../src/world/CelestialState.js';
import { SunShaftGL, shaftSize, shaftSource, shaftGain } from '../src/world/alpine/SunShaftGL.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

test('the first expensive quality rung sheds solar scattering independently of pool illumination', () => {
  assert.equal(rangeQuality(2).sunShafts, true);
  assert.equal(rangeQuality(3).sunShafts, false);
  assert.equal(rangeQuality(3).poolReflections, true);
});
const day = {qualityLevel:0,light:{celestial:{body:'sun',visibility:1,intensity:1.6,xFrac:.5,yFrac:.12}}};
function scene({budget=10000000, width=1280,height=720,sides=1}={}) {
  const s=Object.create(RangeScene.prototype);
  Object.assign(s,{THREE,residency:new GraphicsResidency({budgetBytes:budget}),size:{width,height},contextEpoch:0,
    target:new THREE.WebGLRenderTarget(width,height),sideTargets:{B:sides===2?new THREE.WebGLRenderTarget(width,height):null},
    depthCache:{A:{frame:5},B:{frame:5}},prepared:new Map(),materials:new Map()});
  for(const key of ['range:render-target','range:ground-target','range:travel-scratch','view-a','view-b']){
    s.residency.commit(s.residency.reserve({key,bytes:1000,owner:'essential'}),{});
  }
  return s;
}

test('quarter-size allocation caps the long edge in landscape and portrait',()=>{
  assert.deepEqual(shaftSize(1280,720),{width:320,height:180});
  assert.deepEqual(shaftSize(4096,2160),{width:512,height:270});
  assert.deepEqual(shaftSize(2160,4096),{width:270,height:512});
});

test('all A/B optional attachments are reserved before construction and protect essential entries',()=>{
  const s=scene({sides:2});let builds=0;
  s.THREE={...THREE,WebGLRenderTarget:class extends THREE.WebGLRenderTarget{
    constructor(...args){
      assert.equal(s.residency.pendingBytes,460836,'two 320x180 RGBA targets plus triangle');
      super(...args);builds++;
    }
  }};
  assert.ok(s.prepareShafts(day,['a','b']));
  assert.equal(builds,2);
  assert.ok(s.target.depthTexture?.isDepthTexture);
  assert.ok(s.sideTargets.B.depthTexture?.isDepthTexture);
  assert.equal(s.residency.usedBytes,465836);
  assert.ok(s.prepareShafts(day,['a','b']));assert.equal(builds,2,'same bundle reused');
  s.releaseShafts();assert.equal(s.residency.usedBytes,5000);
  assert.equal(s.target.depthTexture,null);assert.equal(s.sideTargets.B.depthTexture,null);
  s.releaseShafts();assert.equal(s.residency.usedBytes,5000);
});

test('a denied A/B bundle cannot sacrifice base views, targets or travel scratch',()=>{
  const s=scene({sides:2,budget:465835});
  assert.equal(s.prepareShafts(day,['a','b']),false);
  assert.equal(s.residency.usedBytes,5000);assert.equal(s.residency.entries.size,5);
  assert.equal(s.target.depthTexture,null);assert.equal(s.sideTargets.B.depthTexture,null);
  assert.equal(s.residency.snapshot().overcommits,0);
});

test('a quality shed fades the shafts out over heard time, then releases the optional bundle',()=>{
  const s=scene();
  const at=(timeMs,extra={})=>({...day,timeMs,...extra});
  assert.ok(s.prepareShafts(at(1000),['a']));assert.equal(s.shaftPresence,1);
  const bundle=s.shafts;
  let presence=1;
  for(let t=1000+1000/60;t<1000+1490;t+=1000/60){
    assert.ok(s.prepareShafts(at(t,{qualityLevel:3}),['a']),`the bundle survives the fade at ${t}`);
    assert.equal(s.shafts,bundle);
    assert.ok(s.shaftPresence<presence&&s.shaftPresence>0);presence=s.shaftPresence;
    assert.ok(Math.abs(s._shaftSource(at(t,{qualityLevel:3})).stormGain-presence)<1e-12,'scaled, not cut');
  }
  s.depthCache.A.frame=99;
  for(let t=2500;t<2700&&s.shafts;t+=1000/60)s.prepareShafts(at(t,{qualityLevel:3}),['a']);
  assert.equal(s.shafts,null,'released once the fade reaches 0');assert.equal(s.shaftPresence,0);
  assert.equal(s.depthCache.A.frame,-1);assert.equal(s.residency.usedBytes,5000);
  assert.equal(s._shaftSource(at(2700,{qualityLevel:3})),null);
  // Recovery fades back in from zero.
  const last=s.shaftEaseAtMs;
  assert.ok(s.prepareShafts(at(last+1000/60),['a']));assert.ok(s.shaftPresence>0&&s.shaftPresence<.1);
});

function sizedScene(){
  const s=Object.create(RangeScene.prototype);
  Object.assign(s,{THREE,residency:new GraphicsResidency({budgetBytes:512*1024*1024}),budget:'desktop',contextEpoch:0,
    renderer:{setPixelRatio(){},setSize(){}},size:{width:0,height:0},target:null,sideTargets:{B:null},
    ownership:{A:null,B:null},mirrors:{A:null,B:null},depthCache:{A:{frame:-1},B:{frame:-1}},prepared:new Map(),materials:new Map(),
    edge:{capability:4,override:null,samples:0,reason:'not-sized'}});
  return s;
}

test('a same-size MSAA reallocation at the shed rung keeps the shaft fade (resize before prepareShafts)',()=>{
  const s=sizedScene();const size={widthPx:640,heightPx:360};
  s.resize({...size,quality:1});assert.equal(s.target.samples,4);
  assert.ok(s.prepareShafts({...day,qualityLevel:1,timeMs:1000},['a']));assert.equal(s.shaftPresence,1);
  // q1 -> q2: 4 -> 2 samples, shafts still allowed: presence stays 1.
  s.resize({...size,quality:2});assert.equal(s.target.samples,2);
  assert.ok(s.prepareShafts({...day,qualityLevel:2,timeMs:1016},['a']));assert.equal(s.shaftPresence,1,'no dip on a sample change');
  // q2 -> q3: 2 -> 0 samples, the shed the fade exists for.
  s.resize({...size,quality:3});assert.equal(s.target.samples,0);
  assert.ok(s.prepareShafts({...day,qualityLevel:3,timeMs:1032},['a']));
  assert.ok(s.shaftPresence>0&&s.shaftPresence<1,`fading, not cut (${s.shaftPresence})`);
  // A real size change still ends the fade.
  s.resize({widthPx:800,heightPx:450,quality:3});assert.equal(s.shaftPresence,0);
});

test('allocating and freeing the travel side leaves the shaft fade untouched',()=>{
  const s=sizedScene();const size={widthPx:640,heightPx:360};
  s.resize({...size,quality:2});
  assert.ok(s.prepareShafts({...day,qualityLevel:2,timeMs:1000},['a']));
  s.prepareShafts({...day,qualityLevel:3,timeMs:1300},['a']);
  const held=s.shaftPresence;assert.ok(held>0&&held<1);
  assert.ok(s.ensureSide('B'));assert.equal(s.shaftPresence,held);assert.equal(s.shafts,null,'rebuilt against both sides');
  assert.ok(s.prepareShafts({...day,qualityLevel:3,timeMs:1300},['a','b']));assert.equal(s.shaftPresence,held);
  s.releaseSide('B');assert.equal(s.shaftPresence,held);
});

test('celestial gaps and context loss still shed the optional bundle at once',()=>{
  const s=scene();let t=1000;
  for(const fr of [{...day,light:{celestial:{body:'moon',visibility:1,intensity:.25}}},
    {...day,light:{celestial:{body:null,visibility:0,intensity:0}}}]){
    assert.ok(s.prepareShafts({...day,timeMs:t+=16},['a']));s.depthCache.A.frame=99;
    assert.equal(s.prepareShafts({...fr,timeMs:t+=16},['a']),false);assert.equal(s.shafts,null);assert.equal(s.shaftPresence,0);
    assert.equal(s.depthCache.A.frame,-1);assert.equal(s.residency.usedBytes,5000);
  }
  assert.ok(s.prepareShafts({...day,timeMs:5000},['a']));s.contextLost=true;
  assert.equal(s.prepareShafts({...day,timeMs:5016},['a']),false);assert.equal(s.shafts,null);
});

test('a paused frame holds the shaft fade and a seek snaps it',()=>{
  const s=scene();
  assert.ok(s.prepareShafts({...day,timeMs:1000},['a']));
  s.prepareShafts({...day,qualityLevel:3,timeMs:1300},['a']);
  const held=s.shaftPresence;assert.ok(held>0&&held<1);
  for(let i=0;i<5;i++)s.prepareShafts({...day,qualityLevel:3,timeMs:1300},['a','b']);
  assert.equal(s.shaftPresence,held,'pause and the B view hold');
  assert.equal(s.prepareShafts({...day,qualityLevel:3,timeMs:60000},['a']),false,'a seek snaps');
  assert.equal(s.shafts,null);
  assert.ok(s.prepareShafts({...day,timeMs:1000},['a']));assert.equal(s.shaftPresence,1,'a seek back snaps in');
});

test('the far pass and renderDirectShaft scatter the same faded light',()=>{
  const s=scene();
  assert.ok(s.prepareShafts({...day,timeMs:1000},['a']));
  const frame={...day,qualityLevel:3,timeMs:1500};s.prepareShafts(frame,['a']);
  const seen=[];
  s.shafts={...s.shafts,buffers:{A:{}},targets:{A:{}},render:(r,side,source)=>{seen.push(source.stormGain);return true;},
    compositeToScreen:(r,side,source)=>seen.push(source.stormGain)};
  s.renderer={setRenderTarget(){},setClearColor(){},clear(){},render(){}};s.canvas={};s._setCanvasSize=()=>{};
  s.renderDirectShaft(frame,640,360);
  const p={view:{},uniforms:{uNarrativeInk:{value:0},uBackdropAmount:{value:0},uDiag:{value:0}},forest:{counts:{}},depthScene:'d',scenes:{far:'far'}};
  Object.assign(s,{camera:new THREE.PerspectiveCamera(),depthCache:{A:{frame:-1}},prepared:new Map([['a',p]]),stats:{depthPasses:0},
    _copy:{mesh:{material:{uniforms:{uColor:{}}}},scene:'copy'},_setCamera(){},_setUniforms(){},_prepareMirror(){},_setCanvasSize(){},_copyTexture(){}});
  s.renderPartition(frame,'far','a');
  assert.equal(seen.length,3);assert.ok(seen[0]>0&&seen[0]<1);
  assert.ok(seen.every(v=>v===seen[0]),'display and capture agree');
});

test('essential allocation may evict shafts and its callback clears attachment and cache ownership',()=>{
  const s=scene({budget:240000});assert.ok(s.prepareShafts(day,['a']));
  s.residency.pin(['range:render-target','range:ground-target','range:travel-scratch','view-a','view-b']);
  assert.ok(s.residency.reserve({key:'essential-next',bytes:100000,owner:'essential'}));
  assert.equal(s.shafts,null);assert.equal(s.target.depthTexture,null);assert.equal(s.depthCache.A.frame,-1);
});

test('retiring an active view releases the shared optional bundle',()=>{
  const s=scene();s._disposePrepared=()=>{};
  assert.ok(s.prepareShafts(day,['a']));s._retire('a',{});
  assert.equal(s.shafts,null);assert.equal(s.residency.usedBytes,5000);
});

test('context invalidation drops every base target while the old GL handles are lost',()=>{
  const s=scene();s.groundTarget=new THREE.WebGLRenderTarget(320,180);
  s._copy={mesh:{geometry:new THREE.BufferGeometry(),material:new THREE.ShaderMaterial()}};
  assert.ok(s.prepareShafts(day,['a']));
  s._invalidateContext();
  assert.equal(s.groundTarget,null);
  assert.equal(s.target,null);assert.equal(s.shafts,null);
  assert.equal(s.residency.has('range:ground-target'),false);
});

for (const [name, width, height, backingWidth, backingHeight] of [
  ['landscape', 1405, 845, 1405, 845],
  ['portrait', 845, 1405, 845, 1405],
  ['nonuniform export', 1405, 845, 2810, 422],
]) test(`solar aperture matches the actual painted 26px disc in ${name}`, () => {
  const state = resolveCelestialState({timeMs:21000,cycleMs:100000,viewport:{width,height}});
  const source = {...state.sun, body:state.activeBody, intensity:state.sun.directGain};
  const target = new THREE.WebGLRenderTarget(backingWidth, backingHeight);
  const effect = new SunShaftGL(THREE, {A:target});
  // Only the external GPU draw is omitted; the production effect computes
  // its real uniforms from the actual resolver and renderer viewport contract.
  const renderer = {setRenderTarget() {}, render() {}};
  effect.render(renderer, 'A', source, new THREE.PerspectiveCamera(), {logicalWidth:width,logicalHeight:height,backingWidth,backingHeight});
  assert.ok(Math.abs(source.radiusFrac * width - 26) < 1e-12, 'actual painter restores the resolved 26px radius');
  assert.ok(Math.abs(effect.uniforms.uRadius.value.x * width - 26) < 1e-12, 'horizontal aperture reaches the visible disc edge');
  assert.ok(Math.abs(effect.uniforms.uRadius.value.y * height - 26) < 1e-12, 'vertical aperture reaches the visible disc edge');
  effect.dispose();target.dispose();
});

test('the score lifts the shafts but never opens the squall deck', () => {
  const light = { celestial: { body: 'sun', visibility: 1, intensity: 1.6, xFrac: .5, yFrac: .2 } };
  const quiet = shaftSource({ light, storm: { amount: 0 } });
  assert.equal(quiet.musicGain, 1);
  assert.equal(shaftGain(quiet), .55, 'silence keeps today\'s gain');
  const lifted = shaftSource({ light, storm: { amount: 0 }, effects: { lift: 1, bass: 1, energy: 1 } });
  assert.equal(lifted.musicGain, 1.4);
  assert.ok(Math.abs(shaftGain(lifted) - .77) < 1e-12);
  assert.equal(shaftSource({ light, storm: { amount: 1 }, effects: { lift: 1, bass: 1 } }), null, 'still none under a full storm');
  const breaking = shaftSource({ light, storm: { amount: 0, break01: 1 }, effects: { lift: 1 } });
  assert.equal(shaftGain(breaking), .55 * 3.8, 'a storm break keeps its established scatter');
  assert.ok(shaftGain({ ...quiet, stormGain: 1.5, musicGain: 1.4 }) <= .9, 'music never pushes the scatter past .9');
});
