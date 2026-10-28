import {test} from 'node:test';
import assert from 'node:assert/strict';
const lens=await import('../src/render/CameraLens.js').catch(()=>({}));
const trusted={provenance:'detected',confidence:.8};
const sections=[{startMs:0,endMs:20000,role:'verse',relEnergy01:.3,meanEnergy:.3,...trusted},{startMs:20000,endMs:40000,role:'chorus',relEnergy01:.9,meanEnergy:.65,...trusted},{startMs:22000,endMs:30000,role:'drop',relEnergy01:1,meanEnergy:.75,...trusted},{startMs:40000,endMs:60000,role:'verse',relEnergy01:.35,meanEnergy:.3,...trusted}];
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
test('preview holds a neutral lens',()=>{
 assert.equal(typeof lens.cameraLensAt,'function');
 assert.equal(lens.cameraLensAt({sections,timeMs:20000,durationMs:60000,preview:true}).halfAngleScale,1);
 const preview=lens.cameraLensAt({sections,timeMs:20000,durationMs:60000,preview:true});
 assert.equal(preview.zoomPulse,0);
 assert.equal(preview.cueIndex,-1);
 assert.equal(lens.lensFromCues(lens.compileLensCues(sections,60000),20000,true),lens.NEUTRAL_LENS);
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

// --- Trust gate (decorative, zero-confidence and repeated boundaries) ---
const verse={startMs:0,role:'verse',relEnergy01:.3,meanEnergy:.3,...trusted};
const chorusAt=(startMs,extra={})=>({startMs,role:'chorus',relEnergy01:.9,meanEnergy:.7,...trusted,...extra});
const pulseAt=(list,t=20000)=>lens.cameraLensAt({sections:list,timeMs:t,durationMs:60000}).zoomPulse;
test('decorative and zero-confidence boundaries never punch the lens',()=>{
 assert.ok(pulseAt([verse,chorusAt(20000)])>.9,'a detected chorus lift punches');
 assert.equal(pulseAt([verse,chorusAt(20000,{provenance:'decorative'})]),0);
 assert.equal(pulseAt([verse,chorusAt(20000,{confidence:0})]),0);
 assert.equal(pulseAt([verse,chorusAt(20000,{provenance:'authored',confidence:0})]),0);
});
test('a returning chorus with no step in level is a continuation, not a cue',()=>{
 const list=[verse,chorusAt(10000),chorusAt(20000)];
 assert.ok(pulseAt(list,10000)>.9);
 assert.equal(pulseAt(list),0,'chorus to chorus at the same level');
 const lifted=[verse,chorusAt(10000,{meanEnergy:.5}),chorusAt(20000,{meanEnergy:.8})];
 assert.ok(pulseAt(lifted)>0,'a real level step into the same part still counts');
 const decorativeSplit=[verse,chorusAt(10000),chorusAt(15000,{provenance:'decorative'}),chorusAt(20000)];
 assert.equal(pulseAt(decorativeSplit),0,'the prior is the full list, decorative cuts included');
});
test('an inferred boundary punches at reduced strength, even without self-similarity confidence',()=>{
 const full=pulseAt([verse,chorusAt(20000)]);
 const inferred=pulseAt([verse,chorusAt(20000,{provenance:'inferred',confidence:.3})]);
 const unscored=pulseAt([verse,chorusAt(20000,{provenance:'inferred',confidence:0})]);
 assert.ok(inferred>0&&Math.abs(inferred-full/2)<1e-9,`${inferred} vs ${full}`);
 assert.equal(unscored,inferred);
 assert.equal(lens.lensTrust({provenance:'inferred',confidence:0}),.5);
 assert.equal(lens.lensTrust({provenance:'decorative'}),0);
});
test('cues carry their index and the lens is the same in any sampling order',()=>{
 const song=[verse,chorusAt(20000),{...verse,startMs:40000},chorusAt(60000,{meanEnergy:.75,relEnergy01:1}),{...verse,startMs:90000}];
 const cues=lens.compileLensCues(song,120000);
 assert.deepEqual(cues.map(c=>[c.timeMs,c.index]),[[20000,0],[60000,1]]);
 assert.ok(Object.isFrozen(cues)&&cues.every(Object.isFrozen));
 const times=[];for(let t=0;t<120000;t+=137)times.push(t);
 const forward=times.map(t=>lens.cameraLensAt({sections:song,timeMs:t,durationMs:120000}));
 const reversed=[...times].reverse().map(t=>lens.cameraLensAt({sections:song.map(s=>({...s})),timeMs:t,durationMs:120000})).reverse();
 assert.deepEqual(reversed,forward);
 for(let i=0;i<times.length;i++)assert.deepEqual(lens.lensFromCues(cues,times[i]),forward[i]);
 assert.equal(lens.cameraLensAt({sections:song,timeMs:60100,durationMs:120000}).cueIndex,1);
 assert.equal(lens.cameraLensAt({sections:song,timeMs:30000,durationMs:120000}),lens.NEUTRAL_LENS,'idle reuses the frozen neutral');
});
test('the Trio simulation lens follows the score, and is neutral in previews',async()=>{
 const {Simulation}=await import('../src/sim/Simulation.js');
 const song=[verse,chorusAt(20000,{endMs:40000}),{...verse,startMs:40000,endMs:120000}];
 const biomes={sections:song,energyCurves:{globalEnergyNorm:()=>.3},durationMs:120000,tSec:20,conductor:{timeline:[]}};
 const at=(timeMs,extra={})=>Simulation.prototype._lensAt.call({experience:'trio',biomes:{...biomes,...extra}},timeMs);
 assert.deepEqual(at(20000),lens.cameraLensAt({sections:song,timeMs:20000,durationMs:120000}));
 assert.ok(at(20000).zoomPulse>.9);
 assert.equal(at(20000,{terrainPreview:true}).zoomPulse,0);
 assert.equal(at(20000,{terrainPreview:true}).cueIndex,-1);
 assert.equal(at(20000,{energyCurves:null,terrainPreview:true}).zoomPulse,0,'the sections-only fallback honours previews too');
 assert.ok(at(20000,{energyCurves:null}).zoomPulse>.9);
});
