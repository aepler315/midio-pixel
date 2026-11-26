import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/range/three-range.module.js';
import { terrainProjectionPhase, applyPartitionPixelOffset } from '../src/world/alpine/TerrainProjectionPhase.js';

const viewport = { logicalWidth: 1440, logicalHeight: 900, overscanPx: 30 };
const close = (x,y) => assert.ok(Math.abs(x-y)<1e-10, `${x} vs ${y}`);
const screen = (v,camera) => {
  const { x,y,z }=v.clone().project(camera);
  return [(1+x)/2,(1-y)/2,z];
};

test('an off-axis design-cell phase cancels exactly at all depths, including crop and composed transforms', () => {
  const camera=new THREE.PerspectiveCamera(39, 1.6, 20, 150000);
  camera.position.set(24,120,-10); camera.lookAt(50,85,-3600); camera.updateMatrixWorld();
  const focus=[66,112,-2800], reference={ eyeStartM:[25,120,-8], targetStartM:focus }, width=480, height=300;
  const points=[focus,[-40,90,-800],[0,200,-9000],[150,147,-23000]].map(p=>new THREE.Vector3(...p));
  for (const crop of [false,true]) {
    if (crop) camera.setViewOffset(1440,900,180,81,1010,631);
    camera.updateProjectionMatrix();
    const before=points.map(p=>screen(p,camera));
    const phase=terrainProjectionPhase(camera,reference,width,height,viewport);
    assert.ok(phase && Math.abs(phase.x*width)<=.5 && Math.abs(phase.y*height)<=.5);
    applyPartitionPixelOffset(camera,phase);
    for (const [i,p] of points.entries()) {
      const [x,y,z]=screen(p,camera);
      close(before[i][0],x+phase.x); close(before[i][1],y+phase.y); close(before[i][2],z);
      // The inverse projector follows the same ray that wrote the depth.
      const ray=new THREE.Vector3(2*x-1,1-2*y,z).unproject(camera);
      assert.ok(ray.distanceTo(p)<1e-6);
    }
    camera.updateProjectionMatrix();
    assert.deepEqual(terrainProjectionPhase(camera,reference,width,height,viewport),phase,'seeks and captures repeat the phase');
  }
});

test('translations and near authored targets never pull the horizon phase; camera rotations retain subcell movement', () => {
  const camera=new THREE.PerspectiveCamera(50,1.6,20,150000);
  const reference={ eyeStartM:[0,0,0],targetStartM:[4,0,-200] },w=480,h=300;
  for (const crop of [false,true]) {
    if (crop) camera.setViewOffset(1440,900,170,41,1010,631);
    camera.rotation.set(0,0,0);camera.updateMatrixWorld();
    const initial=terrainProjectionPhase(camera,reference,w,h,viewport);
    for (const x of [-1800,4.25,3220]) {
      camera.position.set(x,87,1660);camera.updateMatrixWorld();
      assert.deepEqual(terrainProjectionPhase(camera,reference,w,h,viewport),initial);
    }
    camera.rotation.y=.25/(w*.5*camera.projectionMatrix.elements[0]);camera.updateMatrixWorld();
    const rotated=terrainProjectionPhase(camera,reference,w,h,viewport);
    const diff=(rotated.x-initial.x)*w;
    assert.ok(Math.abs(Math.abs(diff-Math.round(diff))-.25)<.002);
    assert.equal(rotated.y,initial.y);
  }
  assert.equal(terrainProjectionPhase(camera,reference,w,h,{...viewport,overscanPx:1}),null);
  assert.equal(terrainProjectionPhase(camera,reference,0,h,viewport),null);
});
