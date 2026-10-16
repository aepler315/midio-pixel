import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { decodeTour } from '../src/world/terrain/TourPackage.js';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { buildTourTimeline, replanTour, tourContinuation } from '../src/world/terrain/TourTimeline.js';
const root = new URL('../src/assets/range/v2/tour/', import.meta.url);
const data = decodeTour(JSON.parse(await fs.readFile(new URL('teton-range-tour.tour.json', root))), gunzipSync(await fs.readFile(new URL('teton-range-tour.tour.bin.gz', root))));
const section = (role, durationMs) => [{ role, startMs: 0, endMs: durationMs, relEnergy01: .5 }];
test('published routes keep moving from the opening through long single sections', () => {
  for (const [role, durationMs] of [['verse',240000],['chorus',240000],['chorus',600000],['outro',240000],['outro',50000]]) {
    const plan = planTour(data, { sections: section(role,durationMs), durationMs });
    const length = plan.segments.reduce((n,s)=>n+s.path.lengthM,0);
    assert.ok(length > plan.speedProfile.distances.at(-1), `${role}: route exhausted`);
    for (let t=100;t<=durationMs;t+=100) assert.ok(plan.routeAt(t).speedMps>=29.9, `${role}: stopped at ${t}`);
  }
});
test('published refinement keeps its prefix and continues moving after a climb slowdown', () => {
  const durationMs=240000, old=buildTourTimeline(data,planTour(data,{sections:section('verse',durationMs),durationMs}));
  const continuation=tourContinuation(old,data,140000);assert.ok(continuation);
  const plan=planTour(data,{sections:section('chorus',durationMs),durationMs,startContinuation:continuation});
  const next=replanTour(old,data,plan,140000),cut=continuation.timeMs;
  for(let t=0;t<=cut;t+=100) assert.deepEqual(next.poseAt(t),old.poseAt(t));
  const a=next.poseAt(cut),b=next.poseAt(cut+100),c=next.poseAt(durationMs);
  const speed=Math.hypot(b.eyeM[0]-a.eyeM[0],b.eyeM[2]-a.eyeM[2])*10;
  assert.ok(Math.abs(speed-continuation.speedMps)<=1.3, `velocity discontinuity ${speed} / ${continuation.speedMps}`);
  assert.ok(Math.hypot(c.eyeM[0]-a.eyeM[0],c.eyeM[2]-a.eyeM[2])>500,'refinement froze the remainder');
});

test('unreachable section proposals remain explicitly marked passed at range',()=>{
 const roles=['intro','verse','pre-chorus','chorus','verse','pre-chorus','chorus','bridge','solo','chorus','drop','interlude','outro'];
 const durationMs=360000,sections=roles.map((role,i)=>({role,startMs:i*durationMs/13,endMs:(i+1)*durationMs/13,relEnergy01:.5}));
 const plan=planTour(data,{sections,durationMs});
 assert.equal(plan.heroes.filter(h=>!h.subHero).length,roles.length);
 for(const h of plan.heroes)assert.ok(data.points.some(p=>p.id===h.pointId));
});
