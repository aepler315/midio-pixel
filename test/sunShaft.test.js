import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { rangeQuality } from '../src/world/alpine/RangeQuality.js';
import * as THREE from 'three';
import { resolveCelestialState } from '../src/world/CelestialState.js';
import { SunShaftGL, shaftSize } from '../src/world/alpine/SunShaftGL.js';
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

test('quality, celestial gaps and context loss shed the optional bundle and invalidate cached depth',()=>{
  const s=scene();
  for(const fr of [{...day,qualityLevel:3},{...day,light:{celestial:{body:'moon',visibility:1,intensity:.25}}},
    {...day,light:{celestial:{body:null,visibility:0,intensity:0}}}]){
    assert.ok(s.prepareShafts(day,['a']));s.depthCache.A.frame=99;
    assert.equal(s.prepareShafts(fr,['a']),false);assert.equal(s.shafts,null);
    assert.equal(s.depthCache.A.frame,-1);assert.equal(s.residency.usedBytes,5000);
  }
  assert.ok(s.prepareShafts(day,['a']));s.contextLost=true;
  assert.equal(s.prepareShafts(day,['a']),false);assert.equal(s.shafts,null);
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
