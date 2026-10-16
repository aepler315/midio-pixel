import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ring from '../tools/lib/forest-ring-tone.mjs';
import * as THREE from '../src/vendor/range/three-range.module.js';

test('ring classification maps padded scenic pixels through the final camera transform', () => {
  assert.equal(typeof ring.outputToScenicPixel, 'function');
  const W=1920,H=1080,m=64, angle=.08, scale=.7;
  for (const roll of [0,angle]) {
    const a=scale*Math.cos(roll),b=scale*Math.sin(roll),c=-b,d=a;
    const vp={logicalWidth:W+2*m,logicalHeight:H+2*m,backingWidth:1434,backingHeight:846,
      transform:[a,b,c,d,25-a*m-c*m,-13-b*m-d*m]};
    for(const [sx,sy] of [[.35,.42],[.65,.42]]) {
      const lx=sx*vp.logicalWidth,ly=sy*vp.logicalHeight;
      const x=a*lx+c*ly+vp.transform[4],y=b*lx+d*ly+vp.transform[5];
      const actual=ring.outputToScenicPixel(vp,x,y);
      assert.deepEqual(actual,[Math.floor(sx*vp.backingWidth),Math.floor(sy*vp.backingHeight)]);
    }
  }
});

test('known ground points on both sides of the rail retain classification after overscan and roll', () => {
  const vp={logicalWidth:1408,logicalHeight:848,backingWidth:2112,backingHeight:1272};
  const camera=new THREE.PerspectiveCamera(36,vp.logicalWidth/vp.logicalHeight,1,100000);
  camera.position.set(0,1000,0);camera.lookAt(0,0,8000);camera.updateMatrixWorld();
  const points=[{world:new THREE.Vector3(-300,0,7900),label:'inside'},
    {world:new THREE.Vector3(300,0,8300),label:'outside'}];
  for(const roll of [0,.08]) for(const [shakeX,shakeY] of [[0,0],[25,-13]]) {
    const a=1.5*Math.cos(roll),b=1.5*Math.sin(roll),c=-b,d=a;
    vp.transform=[a,b,c,d,-96+shakeX,-96+shakeY];
    const sourceLabels=new Map();
    for(const p of points) {
      const distance=p.world.distanceTo(camera.position);
      assert.equal(distance<8000?'inside':'outside',p.label);
      const ndc=p.world.clone().project(camera);
      const sx=(ndc.x+1)/2*vp.backingWidth,sy=(1-ndc.y)/2*vp.backingHeight;
      sourceLabels.set([Math.floor(sx),Math.floor(sy)].join(','),p.label);
      const lx=(ndc.x+1)/2*vp.logicalWidth,ly=(1-ndc.y)/2*vp.logicalHeight;
      const output=[a*lx+c*ly+vp.transform[4],b*lx+d*ly+vp.transform[5]];
      const mapped=ring.outputToScenicPixel(vp,...output);
      assert.equal(sourceLabels.get(mapped.join(',')),p.label);
    }
  }
});
