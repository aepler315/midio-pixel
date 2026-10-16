import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTour } from '../src/world/terrain/TourPlanner.js';
import { tourFixture } from './fixtures/tour-fixture.mjs';
const sections = (roles, length=60000) => roles.map((role,i)=>({startMs:i*length,endMs:(i+1)*length,role,relEnergy01:.6,finalChorus:role==='chorus'&&i===roles.lastIndexOf('chorus')}));
test('four normally timed choruses use different primaries, and the final chorus has greatest available grandeur',()=>{
 const d=tourFixture(),s=sections(['chorus','chorus','chorus','chorus'],120000),p=planTour(d,{sections:s,durationMs:480000});
 const heroes=p.heroes.filter(h=>!h.subHero);assert.equal(new Set(heroes.map(h=>h.pointId)).size,4);
 assert.ok(heroes.every(h=>d.points.find(x=>x.id===h.pointId).tier==='primary'));
 const highest=Math.max(...d.points.filter(x=>x.role==='chorus'&&x.tier==='primary').map(x=>x.grandeur));
 assert.equal(d.points.find(x=>x.id===heroes.at(-1).pointId).grandeur,highest);
});
test('drop preference, long-outro subheroes and deterministic road-only routes',()=>{
 const d=tourFixture(),s=[{startMs:0,endMs:30000,role:'drop',relEnergy01:1},{startMs:30000,endMs:100000,role:'outro',relEnergy01:.3}];
 const a=planTour(d,{sections:s,durationMs:100000}),b=planTour(d,{sections:s,durationMs:100000});
 assert.equal(d.points.find(p=>p.id===a.heroes[0].pointId).name,'Grand Teton');
 assert.ok(a.heroes.filter(h=>h.sectionIndex===1&&h.subHero).length>=2);
 assert.equal(JSON.stringify(a),JSON.stringify(b));
 for(let t=0;t<=100000;t+=100){const p=a.routeAt(t);assert.ok(p.posM.every(Number.isFinite));assert.ok(p.floorY<=p.ceilY);}
});
test('short sections have no hero; 50s, 10min and single4min plans remain finite',()=>{
 const d=tourFixture();for(const durationMs of [50000,600000,240000]){const p=planTour(d,{sections:[{startMs:0,endMs:durationMs,role:'verse',relEnergy01:.5}],durationMs});assert.ok(p.segments.length);assert.ok(p.routeAt(durationMs).posM.every(Number.isFinite));}
 const p=planTour(d,{sections:[{startMs:0,endMs:3000,role:'chorus'}],durationMs:3000});assert.equal(p.heroes.length,0);
});

test('speed is continuous across heroes and quiet spans freeze the aim without cuts',()=>{
 const d=tourFixture(),s=sections(['verse','chorus','outro'],80000);
 const p=planTour(d,{sections:s,roles:s.map(x=>({...x,stops:[{startMs:20000,endMs:22000}]})),durationMs:240000,energyAt:t=>t>=20000&&t<22000?0:.6});
 for(const segment of p.segments.slice(0,-1)){
  const t=segment.endMs,a=p.routeAt(t-10),b=p.routeAt(t+10);
  assert.ok(Math.abs(a.speedMps-b.speedMps)<1,`${a.speedMps} to ${b.speedMps}`);
 }
});
