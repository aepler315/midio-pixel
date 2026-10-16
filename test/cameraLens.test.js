import {test} from 'node:test';
import assert from 'node:assert/strict';
const lens=await import('../src/render/CameraLens.js').catch(()=>({}));
const sections=[{startMs:0,endMs:20000,role:'verse',relEnergy01:.3},{startMs:20000,endMs:40000,role:'chorus',relEnergy01:.9},{startMs:22000,endMs:30000,role:'drop',relEnergy01:1},{startMs:40000,endMs:60000,role:'verse',relEnergy01:.35}];
test('lens accents select meaningful musical turns and leave quiet transitions alone',()=>{
 assert.equal(typeof lens.cameraLensAt,'function');
 const at=t=>lens.cameraLensAt({sections,timeMs:t,durationMs:60000});
 assert.equal(at(10000).halfAngleScale,1);
 assert.ok(at(20000).halfAngleScale<.95);
 assert.equal(at(23000).halfAngleScale,1,'nearby cue must not retrigger');
 assert.equal(at(40000).halfAngleScale,1,'quiet verse is not a punch');
});
test('lens accent has anticipation, a hold, smooth recovery and random-access parity',()=>{
 assert.equal(typeof lens.cameraLensAt,'function');
 const at=t=>lens.cameraLensAt({sections,timeMs:t,durationMs:60000});
 assert.ok(at(19800).halfAngleScale<1);
 assert.deepEqual(at(20100),at(20300));
 assert.ok(at(21000).halfAngleScale>at(20300).halfAngleScale);
 assert.equal(at(23000).halfAngleScale,1);
 assert.deepEqual(at(21000),at(21000));
 for(let t=19500;t<23000;t+=16)assert.ok(Math.abs(at(t+16).halfAngleScale-at(t).halfAngleScale)<.035);
});
test('FOV effect narrows the lens without moving the eye or exposing unbaked coverage',()=>{
 assert.equal(typeof lens.applyLensFov,'function');
 for(const fov of [15,35,60,110])assert.ok(lens.applyLensFov(fov,{halfAngleScale:.82})<=fov);
 assert.ok(lens.applyLensFov(35,{halfAngleScale:.82})<31);
 assert.equal(lens.applyLensFov(35,{halfAngleScale:1}),35);
 assert.ok(Number.isFinite(lens.applyLensFov(35,{halfAngleScale:NaN})));
});
test('preview and reduced motion hold a neutral lens',()=>{
 assert.equal(typeof lens.cameraLensAt,'function');
 for(const flag of ['preview','reducedMotion'])assert.equal(lens.cameraLensAt({sections,timeMs:20000,durationMs:60000,[flag]:true}).halfAngleScale,1);
});
test('Range rendering shares the lens across projection and pose without dollying',async()=>{
 const {RangeScene}=await import('../src/world/alpine/RangeScene.js');
 const scene={prepared:new Map(),_ensureTourWindow(){},_movedPoses:new WeakMap()};
 const view={id:'lens',camera:{eyeStartM:[0,1500,0],eyeEndM:[0,1500,0],targetStartM:[0,700,-20000],targetEndM:[0,700,-20000],fovYDeg:35}};
 const frame={timeMs:20000,progress01:.5,scenicViewport:{logicalWidth:1280,logicalHeight:720},cameraEffects:{halfAngleScale:.82},cameraMove:null,userCamera:null};
 const result=RangeScene.prototype.movedPose.call(scene,view,frame);
 assert.ok(result.proj.fovYDeg<31);
 assert.equal(result.pose.fovYDeg,result.rail.fovYDeg);
 assert.deepEqual(result.pose.eyeM,[0,1500,0]);
 assert.equal(result.rail.fovYDeg,lens.applyLensFov(35,frame.cameraEffects));
});
