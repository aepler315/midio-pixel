import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/world/alpine/TerrainMaterial.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import * as T from '../src/vendor/range/three-range.module.js';
import { hashSeed } from '../src/utils/math.js';

test('far-dot fallback rejects unresolved lattice, grazing reach and shed quality', () => {
  assert.equal(typeof M.farDotWeight, 'function');
  const a={distance:9000,footprint:2,reach:20,kmax:4,quality:0,ring:[6500,7800]};
  assert.equal(M.farDotWeight(a),1);
  assert.equal(M.farDotWeight({...a,footprint:7.8}),0);
  assert.equal(M.farDotWeight({...a,reach:39}),0);
  assert.equal(M.farDotWeight({...a,reach:52}),0);
  assert.equal(M.farDotWeight({...a,kmax:2,reach:26}),0);
  assert.equal(M.farDotWeight({...a,quality:3}),0);
  assert.equal(M.farDotWeight({...a,distance:6500}),0);
  assert.equal(M.farDotWeight({...a,ring:[0,0],distance:500}),0);
  assert.equal(M.farDotWeight({...a,ring:[0,0],distance:1500}),1);
  assert.ok(M.farDotWeight({...a,footprint:5})>0);
});

test('far dots resolve lateral crowns despite an elongated ground footprint', () => {
  assert.equal(typeof M.farDotFootprint,'function');
  const footprint=M.farDotFootprint({toEye:[0,1,2],normal:[0,1,0],dx:[2,0],dy:[0,20],heightCap:32});
  assert.deepEqual(footprint,{footprint:2,heightFoot:10,reach:84,halfAlong:10});
  const a={...footprint,heightCap:32,distance:9000,kmax:8,quality:0,ring:[6500,7800]};
  assert.ok(M.farDotWeight(a)>0,'a long ground footprint can resolve the projected crown');
  assert.equal(M.farDotWeight({...a,heightFoot:26}),0);
  assert.equal(M.farDotWeight({...a,reach:91}),0);
  assert.equal(M.farDotWeight({...a,distance:15000}),0);
});

test('far-tree ray projection hides the ground only toward the eye within the crown', () => {
  assert.equal(typeof M.farTreeProjection,'function');
  const a={point:[0,0,0],root:[10,0,0],height:20,toEye:[1,1,0],normal:[0,1,0]};
  assert.deepEqual(M.farTreeProjection(a),{along:10,side:0,height:10,reach:20});
  assert.equal(M.farTreeProjection({...a,root:[-10,0,0]}).height,-10);
  // Ground rises toward the eye: the ray reaches the treetop twice as far out.
  const slope=M.farTreeProjection({...a,root:[10,5,2],normal:[-.5,1,0]});
  assert.equal(slope.height,5);assert.equal(slope.reach,40);assert.equal(Math.abs(slope.side),2);
});

test('far terrain uses the placement seed and packs rung with tour cap without more vectors', () => {
  for(const quality of [0,2,3,6]) for(const tour of [null,{}]) {
    const p={uniforms:M.sceneUniforms(T,{}),view:{id:'teton-jackson-lake',terrainSourceId:'tetons',tour},forest:{counts:{billboard:1}},rules:{treeScale:.5}};
    RangeScene.prototype._setFarForest.call({},p,{qualityLevel:quality});
    assert.equal(p.uniforms.uForestSeed?.value,hashSeed('tetons')>>>0);
    assert.deepEqual(p.uniforms.uFarForest.value.toArray(),[6500,7800,.5,quality+(tour?8:0)]);
  }
  assert.equal(M.createSceneMaterial(T,M.sceneUniforms(T,{}),{budget:'mobile'}).defines.FAR_FOREST_KMAX,4);
  assert.equal(M.createSceneMaterial(T,M.sceneUniforms(T,{}),{budget:'desktop'}).defines.FAR_FOREST_KMAX,8);
});


test('diagonal walk includes both lateral crown endpoints in its primary budget', () => {
  const d=Math.SQRT1_2,radius=.5*1.045*24;
  const q=M.farDotFootprint({toEye:[d,1,d],normal:[0,1,0],dx:[d*.01,-d*.01],dy:[d*.01,d*.01],heightCap:35,treeScale:4});
  assert.ok(Math.abs(q.reach-((35+.01)*d+2*(radius+.005)*d))<1e-10);
  assert.ok(q.reach>35*d,'lateral crowns extend both primary endpoints');
});
