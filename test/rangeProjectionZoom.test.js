import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyCameraMoves, RangeUserCamera } from '../src/world/alpine/RangeCamera.js';
import { RangeScene } from '../src/world/alpine/RangeScene.js';
import { cameraBasis } from '../src/world/terrain/SceneTravel.js';
import { mirrorCameraFor } from '../src/world/alpine/WaterMirror.js';
import { viewportState } from '../src/world/alpine/RangeFrame.js';

const pose = { eyeM: [0, 1500, 20000], targetM: [0, 2500, 0], fovYDeg: 35 };
const tanY = Math.tan(pose.fovYDeg * Math.PI / 360), tanX = tanY * 16 / 9;

test('projection zoom retains the geographic eye and target above an occlusion-pruned terrain package', () => {
  const user = { fx: .72, rx: -.12, uy: .05 };
  const out = applyCameraMoves(pose, null, user, { zoomMode: 'projection', cone: { tanX, tanY } });
  assert.deepEqual(out.eyeM, pose.eyeM);
  assert.deepEqual(out.targetM, pose.targetM);
  assert.equal(out.userScale, 1);
  assert.deepEqual(out.viewOffset, user);
});

function fixture() {
  const view = { id: 'test', camera: { eyeStartM: pose.eyeM, eyeEndM: pose.eyeM, targetStartM: pose.targetM, targetEndM: pose.targetM, fovYDeg: pose.fovYDeg } };
  const scene = Object.assign(Object.create(RangeScene.prototype), { camera: new THREE.PerspectiveCamera(), _movedPoses: new WeakMap(),
    prepared: new Map(), _ensureTourWindow() {} });
  const frame = userCamera => ({ frameId: 1, timeMs: 250000, progress01: .85, userCamera, cameraMove: null,
    scenicViewport: viewportState({ logicalWidth: 1280, logicalHeight: 720, backingWidth: 640, backingHeight: 360 }) });
  return { view, scene, frame };
}

test('production camera zoom keeps the point under the pointer fixed without exposing outside the authored frustum', () => {
  const { view, scene, frame } = fixture();
  scene._setCamera(view, frame(null));
  const baseline = scene.camera.clone();
  const user = new RangeUserCamera({ now: () => 0 });
  user.noteFrame({ tanX, tanY }); user.zoomAt(2, .4, -.3);
  const { forward, right, up } = cameraBasis(pose);
  const point = new THREE.Vector3(...pose.eyeM.map((v, i) => v + 60000 * (forward[i] + .4 * tanX * right[i] - .3 * tanY * up[i])));
  const before = point.clone().project(baseline);
  scene._setCamera(view, frame(user.target));
  const after = point.clone().project(scene.camera);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.deepEqual(scene.camera.position.toArray(), baseline.position.toArray());
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const originalNdc = new THREE.Vector3(x, y, .5).unproject(scene.camera).project(baseline);
    assert.ok(Math.abs(originalNdc.x) <= 1 + 1e-9 && Math.abs(originalNdc.y) <= 1 + 1e-9);
  }
});

test('resetting zoom clears the previous off-axis crop and restores the exact projection', () => {
  const { view, scene, frame } = fixture();
  scene._setCamera(view, frame(null));
  const initial = scene.camera.projectionMatrix.toArray();
  scene._setCamera(view, frame({ fx: .6, rx: .08, uy: -.04 }));
  assert.equal(scene.camera.view?.enabled, true);
  scene._setCamera(view, frame({ fx: 0, rx: 0, uy: 0 }));
  assert.equal(scene.camera.view?.enabled ?? false, false);
  assert.deepEqual(scene.camera.projectionMatrix.toArray(), initial);
});


test('padded high-DPR and native-grid viewports keep pointer anchoring and the crop within the original frame', () => {
  for (const backingWidth of [320, 2464]) for (const [x, y] of [[-.95, -.95], [.95, .95]]) {
    const {view,scene,frame}=fixture();
    const vp=viewportState({logicalWidth:1408,logicalHeight:848,backingWidth,backingHeight:Math.round(backingWidth*848/1408),overscanPx:64,nominalWidth:1280,nominalHeight:720});
    const input=userCamera=>({...frame(userCamera),scenicViewport:vp});
    scene._setCamera(view,input(null));
    const baseline=scene.camera.clone();
    const visibleY=Math.tan(baseline.fov*Math.PI/360)*720/848, visibleX=visibleY*1280/720;
    const user=new RangeUserCamera({now:()=>0});
    user.noteFrame({tanX:visibleX,tanY:visibleY});user.zoomAt(3.5,x,y);
    const {forward,right,up}=cameraBasis(pose);
    const point=new THREE.Vector3(...pose.eyeM.map((v,i)=>v+60000*(forward[i]+x*visibleX*right[i]+y*visibleY*up[i])));
    const before=point.clone().project(baseline);
    scene._setCamera(view,input(user.target));
    const after=point.clone().project(scene.camera);
    assert.ok(Math.abs(before.x-after.x)<1e-9 && Math.abs(before.y-after.y)<1e-9);
    for(const cx of [-1,1]) for(const cy of [-1,1]) {
      const original=new THREE.Vector3(cx,cy,.5).unproject(scene.camera).project(baseline);
      assert.ok(Math.abs(original.x)<=1+1e-9 && Math.abs(original.y)<=1+1e-9);
    }
    const mirror=new THREE.PerspectiveCamera();
    mirrorCameraFor(THREE,scene.camera,100,mirror);
    const projection=scene.camera.projectionMatrix.clone();projection.elements[8]*=-1;
    assert.deepEqual(mirror.projectionMatrix.toArray(),projection.toArray());
    assert.deepEqual(mirror.projectionMatrixInverse.toArray(),projection.clone().invert().toArray());
  }
});
