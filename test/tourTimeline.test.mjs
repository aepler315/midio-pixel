import {test} from 'node:test';import assert from 'node:assert/strict';
import{tourFixture}from'./fixtures/tour-fixture.mjs';import{planTour}from'../src/world/terrain/TourPlanner.js';import{buildTourTimeline,replanTour}from'../src/world/terrain/TourTimeline.js';
const sections=[{startMs:0,endMs:30000,role:'drop',relEnergy01:.8},{startMs:30000,endMs:100000,role:'outro',relEnergy01:.3}];
const heading=p=>Math.atan2(p.targetM[0]-p.eyeM[0],-(p.targetM[2]-p.eyeM[2]))*180/Math.PI;
const delta=(a,b)=>((a-b+540)%360)-180;
test('timeline is finite, safe between frames, rate limited, random-access deterministic and locks feasible heroes',()=>{
 const d=tourFixture(),plan=planTour(d,{sections,durationMs:100000}),tour=buildTourTimeline(d,plan);
 let previous;for(let t=0;t<=100000;t+=50){const p=tour.poseAt(t);assert.ok([...p.eyeM,...p.targetM,p.fovYDeg].every(Number.isFinite));assert.ok(p.eyeM[1]>=105&&p.eyeM[1]<=2000);
 if(previous){assert.ok(Math.abs(p.eyeM[1]-previous.eyeM[1])<=30*.05+.01);assert.ok(Math.abs(delta(heading(p),heading(previous)))<=25*.05+.02);}previous=p;
 assert.deepEqual(tour.poseAt(t),p);}
 for(const h of tour.heroes.filter(h=>!h.passedAtRange)){const point=d.points.find(p=>p.id===h.pointId),pose=tour.poseAt(h.timeMs);assert.ok(Math.abs(delta(heading(pose),point.station.bestAim.headingDeg))<3);assert.ok(Math.abs(pose.eyeM[1]-point.station.yM)<.1);}
 assert.ok(tour.meanQualityRatio>=.8);
});
test('preview is stable, reduced motion obeys half climb limits, replan freezes every committed keyframe',()=>{
 const d=tourFixture(),preview=buildTourTimeline(d,planTour(d,{durationMs:0}));assert.deepEqual(preview.poseAt(0),preview.poseAt(99999));
 const plan=planTour(d,{sections,durationMs:100000}),tour=buildTourTimeline(d,plan,{reducedMotion:true});let prev=tour.poseAt(0);
 for(let t=100;t<=100000;t+=100){const p=tour.poseAt(t);assert.ok(Math.abs(p.eyeM[1]-prev.eyeM[1])<=15*.1+.01);assert.ok(Math.abs(delta(heading(p),heading(prev)))<=12*.1+.02);prev=p;}
 const replanned=replanTour(tour,d,plan,10000);for(let t=0;t<=13000;t+=100)assert.deepEqual(replanned.poseAt(t),tour.poseAt(t));
});

test('changed sections continue from the committed road without a position jump',async()=>{
 const {tourContinuation}=await import('../src/world/terrain/TourTimeline.js');
 const d=tourFixture(),oldPlan=planTour(d,{sections,durationMs:100000}),old=buildTourTimeline(d,oldPlan);
 const continuation=tourContinuation(old,d,10000);assert.ok(continuation);
 const changed=[{startMs:0,endMs:30000,role:'verse',relEnergy01:.5},{startMs:30000,endMs:100000,role:'chorus',relEnergy01:.8}];
 const plan=planTour(d,{sections:changed,durationMs:100000,startContinuation:continuation});
 assert.deepEqual(plan.routeAt(13000).posM.map(Math.round),[old.poseAt(13000).eyeM[0],old.poseAt(13000).eyeM[2]].map(Math.round));
 const next=replanTour(old,d,plan,10000);
 for(let t=0;t<=13000;t+=100)assert.deepEqual(next.poseAt(t),old.poseAt(t));
 const a=next.poseAt(13000),b=next.poseAt(13100);assert.ok(Math.hypot(b.eyeM[0]-a.eyeM[0],b.eyeM[2]-a.eyeM[2])<15);
 assert.ok(Math.abs(b.eyeM[1]-a.eyeM[1])<=3.01);assert.ok(Math.abs(delta(heading(b),heading(a)))<=2.51);
});

// A3: a live reduced-motion change replans only the uncommitted tail.
import{tourContinuation}from'../src/world/terrain/TourTimeline.js';
const replanWith=(old,d,committed,reducedMotion)=>{
 const continuation=tourContinuation(old,d,committed);
 const plan=planTour(d,{sections,durationMs:100000,reducedMotion,startContinuation:continuation});
 return replanTour(old,d,plan,committed,{reducedMotion});
};
const horizon=committed=>Math.ceil((committed+3000)/100)*100;
const checkTail=(tour,from,{climb,yaw})=>{let prev=tour.poseAt(from);for(let t=from+100;t<=100000;t+=100){const p=tour.poseAt(t);
 assert.ok(Math.abs(p.eyeM[1]-prev.eyeM[1])<=climb*.1+.01,`climb at ${t}`);assert.ok(Math.abs(delta(heading(p),heading(prev)))<=yaw*.1+.02,`yaw at ${t}`);prev=p;}};
test('enabling reduced motion mid-tour keeps the committed prefix, even a climb above the new limit, and limits the tail',()=>{
 const d=tourFixture(),old=buildTourTimeline(d,planTour(d,{sections,durationMs:100000}));
 const committed=10000,end=horizon(committed);
 // The fixture's committed prefix climbs at 30 m/s around 12.6 s: above the reduced 15 m/s limit.
 let fastest=0;for(let t=100;t<=end;t+=100)fastest=Math.max(fastest,Math.abs(old.poseAt(t).eyeM[1]-old.poseAt(t-100).eyeM[1])*10);
 assert.ok(fastest>15,`fixture commits a fast climb (${fastest} m/s)`);
 const next=replanWith(old,d,committed,true);
 assert.equal(next.reducedMotion,true,'the future uses the new preference');
 for(let t=0;t<=end;t+=100)assert.deepEqual(next.poseAt(t),old.poseAt(t),`committed pose at ${t}`);
 checkTail(next,end,{climb:15,yaw:12});
 const a=next.poseAt(end),b=next.poseAt(end+100);
 assert.ok(Math.hypot(b.eyeM[0]-a.eyeM[0],b.eyeM[2]-a.eyeM[2])<15,'no position jump at the handoff');
 assert.ok(Math.abs(b.fovYDeg-a.fovYDeg)<1,'fov continuous at the handoff');
});
test('disabling reduced motion mid-tour restores the normal limits after the committed horizon',()=>{
 const d=tourFixture(),old=buildTourTimeline(d,planTour(d,{sections,durationMs:100000,reducedMotion:true}),{reducedMotion:true});
 const committed=20000,end=horizon(committed),next=replanWith(old,d,committed,false);
 assert.equal(next.reducedMotion,false);
 for(let t=0;t<=end;t+=100)assert.deepEqual(next.poseAt(t),old.poseAt(t));
 checkTail(next,end,{climb:30,yaw:25});
});
test('rapid toggles: each replan freezes the latest committed horizon and the final preference wins',()=>{
 const d=tourFixture();let tour=buildTourTimeline(d,planTour(d,{sections,durationMs:100000}));
 for(const [committed,motion] of [[5000,true],[5400,false],[6000,true]]){
  const before=tour,next=replanWith(before,d,committed,motion);
  for(let t=0;t<=horizon(committed);t+=100)assert.deepEqual(next.poseAt(t),before.poseAt(t));
  tour=next;
 }
 assert.equal(tour.reducedMotion,true);
 checkTail(tour,horizon(6000),{climb:15,yaw:12});
 assert.equal(replanTour(tour,d,planTour(d,{sections,durationMs:100000,startContinuation:tourContinuation(tour,d,7000)}),7000).reducedMotion,true,'no fifth argument keeps the previous preference');
});
test('no safe road continuation: the worker keeps the plan with the deferred-refinement note',async()=>{
 const d=tourFixture(),old=buildTourTimeline(d,planTour(d,{sections,durationMs:100000}));
 assert.equal(tourContinuation(old,d,50000),null);
 const posted=[];const prior=globalThis.self;globalThis.self={postMessage:m=>posted.push(m)};
 try{
  await import('../src/world/terrain/tour-worker.js');
  globalThis.self.onmessage({data:{data:d,sections,roles:[],durationMs:100000,energy:new Float32Array(401).fill(.5),reducedMotion:true,previous:old,committedThroughMs:50000}});
 }finally{const handler=globalThis.self;globalThis.self=prior;void handler;}
 assert.equal(posted.length,1);
 assert.equal(posted[0].tour.eye,old.eye,'the committed tour is kept, never jumped');
 assert.match(posted[0].tour.notes.at(-1),/Refinement deferred/);
});
