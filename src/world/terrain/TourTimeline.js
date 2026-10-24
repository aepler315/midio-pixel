import { projectPoint } from './SceneTravel.js';
import { trimPath } from './TourGraph.js';
import { tourClearanceAt, tourClearanceAlong } from './TourPackage.js';
import { tourYawBudget } from './TourMotion.js';
const DEG=Math.PI/180,clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const diff=(a,b)=>((a-b+540)%360)-180;
const fovY=hfov=>2*Math.atan(Math.tan(hfov*DEG/2)/(16/9))/DEG;
const mix=(a,b,t)=>a+(b-a)*t;
const vector=(heading,pitch)=>[Math.sin(heading*DEG)*Math.cos(pitch*DEG),Math.sin(pitch*DEG),-Math.cos(heading*DEG)*Math.cos(pitch*DEG)];
const fieldNeighbours=new WeakMap();
function fieldAt(data,pos) {
  let neighbours=fieldNeighbours.get(data);
  if(!neighbours){
    neighbours=new Map();
    for(const edge of data.field.edges)for(let i=1;i<edge.sampleIds.length;i++){
      const a=edge.sampleIds[i-1],b=edge.sampleIds[i];
      if(!neighbours.has(a))neighbours.set(a,new Set());if(!neighbours.has(b))neighbours.set(b,new Set());
      neighbours.get(a).add(b);neighbours.get(b).add(a);
    }
    fieldNeighbours.set(data,neighbours);
  }
  let best=Infinity,index=0;
  for(let i=0;i<data.field.samples.length;i++){const s=data.field.samples[i],d=(s.posM[0]-pos[0])**2+(s.posM[1]-pos[1])**2;if(d<best){best=d;index=i;}}
  const a=data.field.samples[index];let chosen=null,distance=Infinity,fraction=0;
  for(const neighbour of neighbours.get(index)||[]){
    const b=data.field.samples[neighbour],dx=b.posM[0]-a.posM[0],dz=b.posM[1]-a.posM[1],length=dx*dx+dz*dz;
    if(!length)continue;const t=clamp(((pos[0]-a.posM[0])*dx+(pos[1]-a.posM[1])*dz)/length,0,1);
    const error=(a.posM[0]+dx*t-pos[0])**2+(a.posM[1]+dz*t-pos[1])**2;
    if(t>0&&error<distance){chosen=b;distance=error;fraction=t;}
  }
  if(!chosen)return a;
  const blend=(x,y)=>Float32Array.from(x,(v,i)=>mix(v,y[i],fraction));
  return{posM:pos,floorY:mix(a.floorY,chosen.floorY,fraction),ceilY:mix(a.ceilY,chosen.ceilY,fraction),tiers:a.tiers.map((tier,i)=>{
    const next=chosen.tiers[Math.min(i,chosen.tiers.length-1)];
    return{...tier,yM:mix(tier.yM,next.yM,fraction),score:blend(tier.score,next.score),pitch:blend(tier.pitch,next.pitch),fovIdx:fraction<.5?tier.fovIdx:next.fovIdx};
  })};
}
function aimAt(sample,y,heading){
  const tier=sample.tiers.reduce((best,t)=>Math.abs(t.yM-y)<Math.abs(best.yM-y)?t:best,sample.tiers[0]);
  const h=((heading%360)+360)%360,at=h/5,lo=Math.floor(at)%72,hi=(lo+1)%72;
  const pitchAt=h/10,pLo=Math.floor(pitchAt)%36,pHi=(pLo+1)%36;
  const quality=mix(tier.score[lo],tier.score[hi],at-Math.floor(at))/255;
  const fovIndex=(tier.fovIdx[lo>>2]>>(2*(lo&3)))&3;
  return {quality,pitch:mix(tier.pitch[pLo],tier.pitch[pHi],pitchAt-Math.floor(pitchAt)),hfov:[40,55,70][Math.min(2,fovIndex)],tier:sample.tiers.indexOf(tier)};
}
/** Altitude corridor. Steps up to `lastFrozen` join committed keyframes:
 *  they keep the poses already published and are never re-validated
 *  against the climb limit. */
function envelopes(frames,locks,climb,lastFrozen=-1){
  const lo=Float64Array.from(frames,f=>f.floorY+5.02),hi=Float64Array.from(frames,f=>f.ceilY-.02);
  for(const [i,y]of locks){if(y<lo[i]||y>hi[i])return null;lo[i]=hi[i]=y;}
  for(let i=1;i<lo.length;i++){if(i<=lastFrozen)continue;const step=climb*(frames[i].timeMs-frames[i-1].timeMs)/1000;lo[i]=Math.max(lo[i],lo[i-1]-step);hi[i]=Math.min(hi[i],hi[i-1]+step);if(lo[i]>hi[i]+.001)return null;}
  for(let i=lo.length-2;i>=0;i--){if(i+1<=lastFrozen)continue;const step=climb*(frames[i+1].timeMs-frames[i].timeMs)/1000;lo[i]=Math.max(lo[i],lo[i+1]-step);hi[i]=Math.min(hi[i],hi[i+1]+step);if(lo[i]>hi[i]+.001)return null;}
  return{lo,hi};
}
const smooth=(values,seconds,dt)=>{
  const result=Float64Array.from(values),alpha=1-Math.exp(-dt/seconds);
  for(let i=1;i<result.length;i++)result[i]=mix(result[i-1],result[i],alpha);
  for(let i=result.length-2;i>=0;i--)result[i]=mix(result[i+1],result[i],alpha);
  return result;
};
// The published frames of each built result, for the pass that runs once on
// the chosen route after station rebuilds and quality retries.
const compositionFrames=new WeakMap();
/** Joint continuous altitude/aim beam DP: tiers are targets, never jumps. */
export function buildTourTimeline(data,plan,options={}){
  const tour=buildTimeline(data,plan,options),composition=compositionFrames.get(tour);
  if(composition){compositionFrames.delete(tour);refineHeroFraming(tour,data,composition,options);}
  // Refinements inherit the setting the tour was planned with.
  tour.upgradeIntended=!!options.upgradeIntended;
  return tour;
}
function buildTimeline(data,plan,{previous=null,frozenThroughMs=-1,routeScale=1,qualityRetry=true}={}){
  const durationMs=plan.durationMs,points=new Map(data.points.map(p=>[p.id,p])),notes=[...plan.notes],heroes=plan.heroes.map(h=>({...h}));
  const preview=points.get(plan.previewPointId),climb=30;
  if(!durationMs){const p=preview.station,a=p.bestAim,eyeM=[p.posM[0],p.yM,p.posM[1]],v=vector(a.headingDeg,a.pitchDeg),pose={eyeM,targetM:eyeM.map((x,i)=>x+v[i]*12000),fovYDeg:fovY(a.hfovDeg),tour:true};return{durationMs:0,heroes:[],notes,meanQualityRatio:1,poseAt:()=>structuredClone(pose)};}
  const count=Math.ceil(durationMs/100)+1;let frames,bounds,locks,scale=1;
  const lastFrozen=previous?Math.min(count-1,frozenThroughMs>=durationMs?count-1:Math.floor(frozenThroughMs/100)):-1;
  const routeTimeOriginMs=previous?frozenThroughMs:0,routeSlowTauSec=previous?10:0;
  const routeClock=(time,factor)=>{
    const elapsed=Math.max(0,(time-routeTimeOriginMs)/1000);
    const tail=routeSlowTauSec?(1-1/factor)*routeSlowTauSec*(1-Math.exp(-elapsed/routeSlowTauSec)):0;
    return routeTimeOriginMs+1000*(elapsed/factor+tail);
  };
  const clockRate=(time,factor)=>1/factor+(routeSlowTauSec?(1-1/factor)*Math.exp(-Math.max(0,time-routeTimeOriginMs)/1000/routeSlowTauSec):0);
  for(const factor of [routeScale,...[1.25,1.5,2,3,4,6,10].filter(f=>f>routeScale)]){
    frames=Array.from({length:count},(_,i)=>{
      const time=Math.min(durationMs,i*100),route=plan.routeAt(routeClock(time,factor));
      if(previous&&time<=frozenThroughMs){const p=previous.poseAt(time);route.posM=[p.eyeM[0],p.eyeM[2]];}
      route.speedMps*=clockRate(time,factor);
      const band=data.clearance?tourClearanceAt(data.clearance,...route.posM):route;
      if(route.speedMps>=15&&(!previous||time>frozenThroughMs)){
        const floor=band.floorY,ground=floor-125;
        band.floorY=Math.max(floor,floor+route.speedMps/.3-30);
        band.ceilY=Math.min(band.ceilY,Math.max(band.floorY+150,ground+route.speedMps/.03));
      }
      return{...route,...band,timeMs:Math.min(durationMs,i*100),sample:fieldAt(data,route.posM)};
    });
    if(data.clearance)for(let i=1;i<frames.length;i++){
      const band=tourClearanceAlong(data.clearance,frames[i-1].posM,frames[i].posM);
      for(const f of [frames[i-1],frames[i]]){f.floorY=Math.max(f.floorY,band.floorY);f.ceilY=Math.min(f.ceilY,band.ceilY);}
    }
    locks=new Map();if(previous)for(let i=0;i<count&&frames[i].timeMs<=frozenThroughMs;i++)locks.set(i,previous.poseAt(frames[i].timeMs).eyeM[1]);bounds=envelopes(frames,locks,climb,lastFrozen);
    if(bounds&&factor===1)for(const h of heroes.filter(h=>!h.passedAtRange)){
      const station=points.get(h.pointId).station,proposed=new Map(locks);
      for(let i=Math.max(lastFrozen+1,0,Math.ceil((h.timeMs-1500)/100));i<=Math.min(count-1,Math.floor((h.timeMs+1500)/100));i++)proposed.set(i,station.yM);
      const constrained=envelopes(frames,proposed,climb,lastFrozen);
      if(constrained){locks=proposed;bounds=constrained;}
      else{h.passedAtRange=true;notes.push(`${h.pointId}: exact-height lock cannot fit the climb corridor`);}
    }
    if(bounds){scale=factor;break;}
  }
  if(!bounds)throw new Error('Tour route has no rate-limited altitude corridor');
  if(scale!==1){notes.push(`Route slowed by ${scale} for clearance or view quality; hero deadlines passed at range`);for(const h of heroes)h.passedAtRange=true;}
  const dpTimes=[];let begin=0;if(previous){for(let t=0;t<=frozenThroughMs&&t<durationMs;t+=100)dpTimes.push(t);begin=frozenThroughMs+250;}for(let t=begin;t<durationMs;t+=250)dpTimes.push(t);dpTimes.push(durationMs);
  const yawBetween=tourYawBudget(frames);
  const refreshLocks=()=>{
    locks=new Map();if(previous)for(let i=0;i<count&&frames[i].timeMs<=frozenThroughMs;i++)locks.set(i,previous.poseAt(frames[i].timeMs).eyeM[1]);
    if(scale===1)for(const h of heroes.filter(h=>!h.passedAtRange)){
      const station=points.get(h.pointId).station;
      for(let i=Math.max(lastFrozen+1,0,Math.ceil((h.timeMs-1500)/100));i<=Math.min(count-1,Math.floor((h.timeMs+1500)/100));i++)locks.set(i,station.yM);
    }
    bounds=envelopes(frames,locks,climb,lastFrozen);
    if(!bounds)throw new Error('Tour route has no rate-limited altitude corridor');
  };
  // Exact windows have priority in chronological order. A later overlapping
  // or too-close aim must not evict an earlier feasible shot when the beam
  // reaches their shared window. Keep compatible repeated shots locked.
  let priorLock=null;
  for(const hero of [...heroes].sort((a,b)=>a.timeMs-b.timeMs)){
    if(hero.passedAtRange)continue;
    const station=points.get(hero.pointId).station;
    if(priorLock){
      const priorStation=points.get(priorLock.pointId).station;
      if(Math.abs(diff(station.bestAim.headingDeg,priorStation.bestAim.headingDeg))>yawBetween(priorLock.timeMs+1500,hero.timeMs-1500)+.01){
        hero.passedAtRange=true;notes.push(`${hero.pointId}: aim lock unreachable under yaw limit`);continue;
      }
    }
    priorLock=hero;
  }
  refreshLocks();
  let beam=[],lastTime;
  // At most one authored lock is released per retry. Re-run the DP locally
  // so an unreachable future deadline cannot cause unbounded recursion or
  // silently invalidate the route, clearance, or committed prefix.
  for(let attempt=0;attempt<=heroes.length;attempt++){
  beam=[];lastTime=0;let blockedHero=null;
  for(let step=0;step<dpTimes.length;step++){
    const time=dpTimes[step],frame=frames[Math.min(count-1,Math.round(time/100))],point=points.get(frame.pointId)||preview;
    const lock=heroes.find(h=>!h.passedAtRange&&Math.abs(h.timeMs-time)<=1500);
    let station=lock?points.get(lock.pointId).station:null;
    if(previous&&time<=frozenThroughMs){
      const p=previous.poseAt(time),v=p.targetM.map((n,k)=>n-p.eyeM[k]),headingDeg=Math.atan2(v[0],-v[2])/DEG,pitchDeg=Math.atan2(v[1],Math.hypot(v[0],v[2]))/DEG;
      station={yM:p.eyeM[1],bestAim:{headingDeg,pitchDeg,hfovDeg:2*Math.atan(Math.tan(p.fovYDeg*DEG/2)*(16/9))/DEG,score:1}};
    }
    const nextHero=heroes.find(h=>!h.passedAtRange&&h.timeMs+1500>=time),nextStation=nextHero?points.get(nextHero.pointId).station:null;
    const activeHeading=Math.atan2(point.localM[0]-frame.posM[0],-(point.localM[2]-frame.posM[1]))/DEG;
    // Committed keyframes keep the rates they were planned with; the limits
    // apply from the first uncommitted step.
    const committed=previous&&time<=frozenThroughMs;
    const dt=step?(time-lastTime)/1000:0,limit=committed?Infinity:yawBetween(lastTime,time),rise=committed?Infinity:climb*dt;
    const states=new Map();
    const predecessors=beam.length?beam:[null];
    for(const prev of predecessors){
      const targets=station?[station.yM]:frame.sample.tiers.map(t=>t.yM);
      const boundLo=Math.min(count-2,Math.floor(time/100)),boundHi=boundLo+1,fraction=clamp((time-frames[boundLo].timeMs)/(frames[boundHi].timeMs-frames[boundLo].timeMs),0,1);
      const minimum=mix(bounds.lo[boundLo],bounds.lo[boundHi],fraction),maximum=mix(bounds.hi[boundLo],bounds.hi[boundHi],fraction);
      for(const targetY of targets){
        const y=clamp(targetY,Math.max(minimum,prev?prev.y-rise:minimum),Math.min(maximum,prev?prev.y+rise:maximum));
        if(prev&&Math.abs(y-prev.y)>rise+.001)continue;
        const ranked=Array.from({length:72},(_,k)=>({heading:k*5,quality:aimAt(frame.sample,y,k*5).quality})).sort((a,b)=>b.quality-a.quality||a.heading-b.heading).slice(0,4).map(a=>a.heading);
        const aims=station?[station.bestAim.headingDeg]:[...ranked,prev?.heading,activeHeading,frame.headingDeg,nextStation?.bestAim.headingDeg].filter(Number.isFinite);
        for(const targetHeading of aims){
          const heading=prev?prev.heading+clamp(diff(targetHeading,prev.heading),-limit,limit):targetHeading;
          if(station&&Math.abs(diff(heading,station.bestAim.headingDeg))>.01)continue;
          if(nextStation&&Math.abs(diff(nextStation.bestAim.headingDeg,heading))>yawBetween(time,nextHero.timeMs-1500)+.01)continue;
          const aim=station?{quality:station.bestAim.score,pitch:station.bestAim.pitchDeg,hfov:station.bestAim.hfovDeg,tier:0}:aimAt(frame.sample,y,heading);
          const activeHero=heroes.find(h=>h.pointId===frame.pointId&&h.timeMs+3000>=time);
          const pull=activeHero?clamp(time<=activeHero.timeMs?1-(activeHero.timeMs-time)/4000:1-(time-activeHero.timeMs)/3000,0,1):0;
          const bias=pull*Math.max(0,1-Math.abs(diff(heading,activeHeading))/(aim.hfov*.4));
          const desired=frame.role==='breakdown'?100:frame.role==='solo'?225:['intro','outro'].includes(frame.role)?800:Math.max(120,point.localM[1]-frame.floorY);
          const cost=(prev?.cost||0)+(data.tunables?.viewQualityWeight??1)*aim.quality*4+.15*bias-((y-frame.floorY-desired)/250)**2-(prev?.002*diff(heading,prev.heading)**2:0)-(prev?.00002*(y-prev.y)**2:0);
          const key=`${Math.round(y*2)}:${Math.round(heading*4)}`;
          const state={y,heading,aim,cost,previous:prev,time};if(!states.has(key)||states.get(key).cost<cost)states.set(key,state);
        }
      }
    }
    if(!states.size){
      blockedHero=lock||nextHero;
      if(blockedHero)break;
      throw new Error('Tour timeline has no feasible aim state');
    }
    const diverse=new Map();
    for(const state of states.values()){
      const key=`${Math.round(state.y/60)}:${Math.round(state.heading/15)}`;
      if(!diverse.has(key)||diverse.get(key).cost<state.cost)diverse.set(key,state);
    }
    beam=[...diverse.values()].sort((a,b)=>b.cost-a.cost||a.heading-b.heading||a.y-b.y).slice(0,data.tunables?.timelineBeamWidth||60);lastTime=time;
  }
  if(!blockedHero)break;
  blockedHero.passedAtRange=true;notes.push(`${blockedHero.pointId}: aim lock unreachable under yaw limit`);
  // Releasing an aim also releases only its own future altitude lock. Build
  // the remaining locks again to retain overlaps and every committed pose.
  refreshLocks();
  }
  const chosen=[];let state=beam[0];while(state){chosen.push(state);state=state.previous;}chosen.reverse();
  const rawY=new Float64Array(count),headings=new Float64Array(count),pitches=new Float64Array(count),fovs=new Float64Array(count);let at=0;
  for(let i=0;i<count;i++){
    const t=frames[i].timeMs;while(at+1<chosen.length-1&&chosen[at+1].time<t)at++;
    const a=chosen[at],b=chosen[Math.min(at+1,chosen.length-1)],u=clamp((t-a.time)/Math.max(1,b.time-a.time),0,1);
    rawY[i]=mix(a.y,b.y,u);headings[i]=mix(a.heading,b.heading,u);pitches[i]=mix(a.aim.pitch,b.aim.pitch,u);fovs[i]=mix(a.aim.hfov,b.aim.hfov,u);
  }
  const y=smooth(rawY,1.2,.1),heading=smooth(headings,data.tunables?.aimSmoothSec??.6,.1),pitch=smooth(pitches,.6,.1),hfov=smooth(fovs,1,.1);
  const eye=new Float32Array(count*3),target=new Float32Array(count*3),fov=new Float32Array(count),meta=new Uint16Array(count*4);let qualitySum=0,maxSum=0;
  for(let i=0;i<count;i++){
    if(previous&&frames[i].timeMs<=frozenThroughMs){
      for(const [key,array,size]of [['eye',eye,3],['target',target,3],['fov',fov,1],['meta',meta,4]])array.set(previous[key].subarray(i*size,(i+1)*size),i*size);
      y[i]=previous.eye[i*3+1];const v=previous.target.subarray(i*3,i*3+3).map((n,k)=>n-previous.eye[i*3+k]);heading[i]=Math.atan2(v[0],-v[2])/DEG;continue;
    }
    const frame=frames[i],lock=heroes.find(h=>!h.passedAtRange&&Math.abs(h.timeMs-frame.timeMs)<=1500),s=lock?points.get(lock.pointId).station:null;
    const dt=i?(frame.timeMs-frames[i-1].timeMs)/1000:0;
    const lo=Math.max(bounds.lo[i],i?y[i-1]-climb*dt:bounds.lo[i]),hi=Math.min(bounds.hi[i],i?y[i-1]+climb*dt:bounds.hi[i]);y[i]=s?s.yM:clamp(y[i],lo,hi);
    const rate=i?yawBetween(frames[i-1].timeMs,frame.timeMs):0;
    const nextLock=heroes.find(h=>!h.passedAtRange&&h.timeMs+1500>=frame.timeMs);
    const futureHeading=nextLock?points.get(nextLock.pointId).station.bestAim.headingDeg:null;
    if(i){
      const previousHeading=heading[i-1];
      let low=previousHeading-rate,high=previousHeading+rate;
      if(futureHeading!==null){
        const unwrapped=previousHeading+diff(futureHeading,previousHeading);
        const reach=yawBetween(frame.timeMs,nextLock.timeMs-1500);
        low=Math.max(low,unwrapped-reach);high=Math.min(high,unwrapped+reach);
      }
      heading[i]=clamp(previousHeading+diff(s?s.bestAim.headingDeg:heading[i],previousHeading),low,high);
    }else if(futureHeading!==null){
      const reach=yawBetween(frame.timeMs,nextLock.timeMs-1500),centre=heading[i]+diff(futureHeading,heading[i]);
      heading[i]=clamp(s?s.bestAim.headingDeg:heading[i],centre-reach,centre+reach);
    }
    if(s){pitch[i]=s.bestAim.pitchDeg;hfov[i]=s.bestAim.hfovDeg;}
    if(frame.stop&&i&&frames[i-1].stop){heading[i]=heading[i-1];pitch[i]=pitch[i-1];hfov[i]=hfov[i-1];}
    const e=[frame.posM[0],y[i],frame.posM[1]],v=vector(heading[i],pitch[i]);eye.set(e,i*3);target.set(e.map((x,k)=>x+v[k]*12000),i*3);fov[i]=fovY(hfov[i]);
    const aim=aimAt(frame.sample,y[i],heading[i]);qualitySum+=aim.quality;maxSum+=Math.max(...frame.sample.tiers.flatMap(t=>[...t.score]))/255;
    meta.set([aim.tier,data.points.findIndex(p=>p.id===frame.pointId),Math.max(0,data.roles.indexOf(frame.role)),lock?1:0],i*4);
  }
  const result = restoreTourTimeline({durationMs,eye,target,fov,meta,heroes,notes,meanQualityRatio:qualitySum/Math.max(.001,maxSum),data,plan,routeSegments:plan.segments,routeSpeedProfile:plan.speedProfile,scale,routeTimeOriginMs,routeSlowTauSec});
  const shots = composeDistantHeroes(result, data, frames, lastFrozen);
  compositionFrames.set(result, { frames, lastFrozen, shots });
  result.heroFraming = measureHeroFraming(result, data);
  result.heroCoverage = summarizeHeroCoverage(result.heroFraming);
  const missedStations = new Set(result.heroFraming.filter(h => h.stationVisit && h.framedFraction < .8).map(h => h.pointId));
  if (missedStations.size) {
    // A waypoint can be reachable while its authored subject cannot be
    // framed from the safe eye corridor. Release that exact shot's locks
    // and genuinely solve a distant view instead of claiming a visit.
    const nextHeroes = heroes.map(h => missedStations.has(h.pointId) ? { ...h, passedAtRange: true } : h);
    return buildTimeline(data, { ...plan, heroes: nextHeroes,
      notes: [...notes, ...[...missedStations].map(id => `${id}: station subject cannot fit the safe viewing window; compose at range`)] },
    { previous, frozenThroughMs, routeScale, qualityRetry });
  }
  if (qualityRetry && result.meanQualityRatio < .8) {
    let best = result;
    // A fast route can force the eye far above the useful view tiers even
    // when the climb envelope is valid. Try bounded slower itineraries;
    // preserve heard time and every committed pose, then re-compose views.
    for (const factor of [1.25, 1.5, 2]) {
      if (factor <= result.scale) continue;
      const candidate = buildTimeline(data, plan, { previous, frozenThroughMs,
        routeScale: factor, qualityRetry: false });
      if (candidate.meanQualityRatio > best.meanQualityRatio) best = candidate;
      if (best.meanQualityRatio >= .8) break;
    }
    return best;
  }
  return result;
}
/** Projection coverage is distinct from a station visit, terrain clearance
 * and pixel-level visibility. Browser evidence checks occlusion separately. */
export function measureHeroFraming(tour, data) {
  const points = new Map(data.points.map(p => [p.id, p]));
  return tour.heroes.map(hero => {
    const station = points.get(hero.pointId)?.station;
    const intendedPointId = (!hero.passedAtRange && station?.bestAim?.subjectId) || hero.pointId;
    const point = points.get(hero.framingPointId || intendedPointId), intended = points.get(intendedPointId);
    const windowStartMs = Math.max(0, hero.timeMs - 1500), windowEndMs = Math.min(tour.durationMs, hero.timeMs + 1500);
    const times = [];
    for (let t = windowStartMs; t < windowEndMs; t += 250) times.push(t);
    times.push(windowEndMs);
    let framed = 0, intendedFramed = 0, stationDistanceM = Infinity;
    for (const t of times) {
      const pose = tour.poseAt(t), forward = pose.targetM.map((v, i) => v - pose.eyeM[i]);
      const covered = subject => {
        const projected = subject ? projectPoint(pose, 16 / 9, subject.localM) : null;
        const front = subject && subject.localM.reduce((v, x, i) => v + (x - pose.eyeM[i]) * forward[i], 0) > 0;
        return front && projected && Math.abs(projected.x) <= .8 && Math.abs(projected.y) <= .8;
      };
      if (covered(point)) framed++;
      if (covered(intended)) intendedFramed++;
      if (station) stationDistanceM = Math.min(stationDistanceM, Math.hypot(pose.eyeM[0] - station.posM[0], pose.eyeM[2] - station.posM[1]));
    }
    const framedFraction = framed / times.length, stationVisit = !hero.passedAtRange && stationDistanceM <= 150;
    return { pointId: hero.pointId, intendedPointId: intended?.id ?? null, framedPointId: point?.id ?? null,
      intendedFramedFraction: intendedFramed / times.length, alternative: !!point && point.id !== intendedPointId,
      role: hero.role ?? null, finalChorus: !!hero.finalChorus, subHero: !!hero.subHero,
      timeMs: hero.timeMs, windowStartMs, windowEndMs, sampleCount: times.length,
      reason: hero.framingReason || (framedFraction >= .8 ? 'projected-subject-covered' : 'no-legal-projected-shot'),
      framedFraction, stationVisit, stationReached: stationDistanceM <= 150, stationDistanceM,
      outcome: framedFraction < .8 ? 'missed' : stationVisit ? 'station' : 'distant' };
  });
}
/** Projection diagnostics, not terrain visibility or artistic acceptance. */
export function summarizeHeroCoverage(framing) {
  return {
    projectionOnly: true, total: framing.length,
    intended: framing.filter(h => h.intendedFramedFraction >= .8).length,
    alternative: framing.filter(h => h.alternative && h.framedFraction >= .8).length,
    station: framing.filter(h => h.outcome === 'station').length,
    distant: framing.filter(h => h.outcome === 'distant').length,
    missed: framing.filter(h => h.outcome === 'missed').length,
    endings: framing.filter(h => h.finalChorus || h.role === 'outro').map(h => ({ ...h })),
  };
}
/** poseAt slerps target directions, so a frame that also changes pitch does
 * not turn uniformly. Peak sub-frame heading rate relative to its mean. */
function slerpTurnPeak(h0, p0, h1, p1) {
  const a = vector(h0, p0), b = vector(h1, p1), turn = Math.abs(diff(h1, h0));
  const angle = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
  if (angle < 1e-9 || turn < 1e-9) return 1;
  let previous = h0, peak = 0;
  for (let k = 1; k <= 32; k++) {
    const sa = Math.sin((1 - k / 32) * angle) / Math.sin(angle), sb = Math.sin(k / 32 * angle) / Math.sin(angle);
    const h = Math.atan2(a[0] * sa + b[0] * sb, -(a[2] * sa + b[2] * sb)) / DEG;
    peak = Math.max(peak, Math.abs(diff(h, previous)) * 32); previous = h;
  }
  return Math.max(1, peak / turn);
}
/** Composition state on one published route: current aim, quality budget
 * and the shared yaw capacity. */
function compositionState(tour, data, frames, lastFrozen) {
  const count = tour.fov.length, headings = new Float64Array(count), pitches = new Float64Array(count);
  const quality = new Float64Array(count), maximum = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const v = [0, 1, 2].map(k => tour.target[i * 3 + k] - tour.eye[i * 3 + k]);
    headings[i] = Math.atan2(v[0], -v[2]) / DEG;
    pitches[i] = Math.atan2(v[1], Math.hypot(v[0], v[2])) / DEG;
    quality[i] = aimAt(frames[i].sample, tour.eye[i * 3 + 1], headings[i]).quality;
    maximum[i] = Math.max(...frames[i].sample.tiers.flatMap(t => [...t.score])) / 255;
  }
  return { tour, data, frames, lastFrozen, count, headings, pitches, quality,
    points: new Map(data.points.map(p => [p.id, p])),
    sum: quality.reduce((a, b) => a + b, 0), max: maximum.reduce((a, b) => a + b, 0),
    capacityBetween: tourYawBudget(frames) };
}
const ease = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
/** The intended subject first; a shot passed at range may also try the
 * `limit` same-role points nearest its current bearing. */
function shotCandidates(state, hero, limit = 6) {
  const { tour, data, count, headings, points } = state;
  const center = Math.min(count - 1, Math.round(hero.timeMs / 100)), eye = [...tour.eye.subarray(center * 3, center * 3 + 3)];
  const stationSubject = !hero.passedAtRange && points.get(hero.pointId)?.station?.bestAim?.subjectId;
  const intended = points.get(stationSubject || hero.pointId);
  const candidates = [intended, ...(hero.passedAtRange ? data.points.filter(p => p.id !== hero.pointId && p.role === intended?.role)
    .sort((a, b) => {
      const angle = p => Math.abs(diff(Math.atan2(p.localM[0] - eye[0], -(p.localM[2] - eye[2])) / DEG, headings[center]));
      return angle(a) - angle(b) || a.id.localeCompare(b.id);
    }).slice(0, limit) : [])].filter(Boolean);
  return { intended, candidates };
}
/** Start after accepted shots, preserving their pitch as well as heading.
 * A shot may use the remaining approach, never their windows. */
function shotBounds(state, hero, accepted) {
  const { tour, frames, count, lastFrozen } = state;
  const priorShots = [...accepted].filter(at => at < hero.timeMs);
  const priorEnd = priorShots.length ? Math.max(...priorShots) + 1500 : -100;
  const start = Math.max(lastFrozen + 1, 0, Math.floor((hero.timeMs - 10000) / 100), Math.floor(priorEnd / 100) + 1);
  const futureShots = [...accepted].filter(at => at > hero.timeMs);
  const futureStart = futureShots.length ? Math.min(...futureShots) - 1500 : Infinity;
  const end = Math.min(count - 1, Math.ceil((hero.timeMs + 7000) / 100), Math.floor(futureStart / 100));
  const protectedFrame = i => [...accepted].some(at => i >= Math.floor(Math.max(0, at - 1500) / 100)
    && i <= Math.min(count - 1, Math.ceil(Math.min(tour.durationMs, at + 1500) / 100)));
  if (!frames[start] || frames[start].timeMs >= hero.timeMs - 1500) return null;
  return { start, end, protectedFrame };
}
/** Try one subject without writing anything. The eased ramp is rejected
 * where its step exceeds the yaw budget unless `chase` limits it to that
 * budget instead; a chase must still rejoin the route before `end`. */
function attemptShot(state, hero, point, { start, end, protectedFrame, chase = false, base = null }) {
  const { tour, data, frames, lastFrozen, count, headings, pitches, quality, capacityBetween } = state;
  // The ramp eases away from `base` (default: the current aim) outside
  // protected windows. Continuity and the rejoin use the current aim.
  const baseOf = (i, current, other) => base && !protectedFrame(i) ? other[i] : current[i];
  const hs = [], ps = [], qs = [];
  let delta = 0;
  for (let i = start; i <= end; i++) {
    const t = frames[i].timeMs;
    const envelope = ease((t - frames[start].timeMs) / Math.max(1, hero.timeMs - 1500 - frames[start].timeMs))
      * (1 - ease((t - hero.timeMs - 1500) / Math.max(1, frames[end].timeMs - hero.timeMs - 1500)));
    const dx = point.localM[0] - tour.eye[i * 3], dy = point.localM[1] - tour.eye[i * 3 + 1], dz = point.localM[2] - tour.eye[i * 3 + 2];
    const weight = start === 0 && lastFrozen < 0 && !hero.passedAtRange && hero.timeMs <= 10000 && t < hero.timeMs - 1500 ? 1 : envelope;
    const baseHeading = baseOf(i, headings, base?.headings), basePitch = baseOf(i, pitches, base?.pitches);
    const eased = baseHeading + diff(Math.atan2(dx, -dz) / DEG, baseHeading) * weight;
    const p = mix(basePitch, clamp(Math.atan2(dy, Math.hypot(dx, dz)) / DEG, -25, 35), weight);
    const previousHeading = i > start ? hs.at(-1) : headings[Math.max(0, i - 1)];
    const previousPitch = i > start ? ps.at(-1) : pitches[Math.max(0, i - 1)];
    const capacity = i ? capacityBetween(frames[i - 1].timeMs, t) : 0;
    let h = eased;
    if (i && Math.abs(diff(eased, previousHeading)) > capacity + .001) {
      if (!chase) return null;
      // poseAt slerps directions, so a frame that also pitches turns unevenly.
      const turn = Math.sign(diff(eased, previousHeading)) * capacity;
      h = previousHeading + turn / slerpTurnPeak(previousHeading, previousPitch, previousHeading + turn, p);
    }
    if (i && frames[i].stop && frames[i - 1].stop && Math.abs(p - previousPitch) > .001
      || protectedFrame(i) && (Math.abs(diff(h, headings[i])) > .00001 || Math.abs(p - pitches[i]) > .00001)) return null;
    const q = aimAt(frames[i].sample, tour.eye[i * 3 + 1], h).quality;
    delta += q - quality[i]; hs.push(h); ps.push(p); qs.push(q);
  }
  // The song's final frame has no successor, so only a ramp that ends
  // earlier must return to the unchanged route.
  if (chase && end < count - 1 && Math.abs(diff(hs.at(-1), headings[end])) > .00001) return null;
  if ((state.sum + delta) / Math.max(.001, state.max) < Math.min(.8, state.sum / Math.max(.001, state.max)) - 1e-6) return null;
  const target = tour.target.slice();
  for (let i = start; i <= end; i++) {
    if (protectedFrame(i)) continue;
    const v = vector(hs[i - start], ps[i - start]);
    for (let axis = 0; axis < 3; axis++) target[i * 3 + axis] = tour.eye[i * 3 + axis] + v[axis] * 12000;
  }
  const candidate = restoreTourTimeline({ ...tour, target });
  if (measureHeroFraming({ ...candidate, heroes: [{ ...hero, framingPointId: point.id }] }, data)[0].framedFraction < .8) return null;
  return { start, end, hs, ps, qs, delta, target };
}
function commitShot(state, hero, point, shot, accepted, reason, note) {
  // The aim each first-pass shot replaced, for a later intended upgrade.
  state.shots?.set(hero.timeMs, { start: shot.start, end: shot.end,
    headings: state.headings.slice(shot.start, shot.end + 1), pitches: state.pitches.slice(shot.start, shot.end + 1) });
  for (let i = shot.start; i <= shot.end; i++) {
    const k = i - shot.start;
    state.headings[i] = shot.hs[k]; state.pitches[i] = shot.ps[k]; state.quality[i] = shot.qs[k];
  }
  state.tour.target.set(shot.target);
  state.sum += shot.delta; hero.framingPointId = point.id; accepted.add(hero.timeMs);
  hero.framingReason = reason;
  if (note) state.tour.notes.push(note);
}
/** Compose a distant subject only when the entire shot fits the already
 * safe route, yaw limits and quality budget. Never retime roads or lift
 * the eye to rescue a failed close visit. Alternatives are explicit. */
function composeDistantHeroes(tour, data, frames, lastFrozen) {
  const state = compositionState(tour, data, frames, lastFrozen);
  state.shots = new Map();
  // Existing coverage is a constraint even when its hero occurs later in
  // the song. Trying an earlier repair must not erase that intended shot.
  const accepted = new Set(measureHeroFraming(tour, data).filter(h => h.framedFraction >= .8).map(h => h.timeMs));
  for (const hero of [...tour.heroes].sort((a, b) => a.timeMs - b.timeMs)) {
    const existing = measureHeroFraming({ ...tour, heroes: [hero] }, data)[0];
    if (existing.framedFraction >= .8) { accepted.add(hero.timeMs); hero.framingReason = 'retained-projected-shot'; continue; }
    const { intended, candidates } = shotCandidates(state, hero);
    const bounds = shotBounds(state, hero, accepted);
    if (!bounds) { hero.framingReason = 'no-uncommitted-approach'; continue; }
    hero.framingReason = 'no-legal-projected-shot';
    for (const point of candidates) {
      const shot = attemptShot(state, hero, point, bounds);
      if (!shot) continue;
      commitShot(state, hero, point, shot, accepted,
        point.id === intended?.id ? 'composed-intended-subject' : 'composed-distant-alternative',
        point.id !== hero.pointId ? `${hero.pointId}: composed distant alternative ${point.name || point.id}` : null);
      break;
    }
  }
  tour.meanQualityRatio = state.sum / Math.max(.001, state.max);
  return state.shots;
}
/** A second pass over the route the first pass settled on. It never
 * changes a hero that pass covered: their windows stay exactly as they
 * are. A subject already in frame is recorded before anything moves; the
 * remaining misses then chase their eased ramp at the shared yaw capacity,
 * in song order. `upgradeIntended` also lets a hero framed by an alternative
 * try its intended subject. That replaces an accepted subject, so it is
 * off by default. */
function refineHeroFraming(tour, data, { frames, lastFrozen, shots }, { upgradeIntended = false } = {}) {
  const state = compositionState(tour, data, frames, lastFrozen), startSum = state.sum;
  // An upgrade eases from the aim its first-pass shot replaced, not from the
  // ramp toward the alternative.
  const replacedAim = hero => {
    const shot = shots.get(hero.timeMs);
    if (!shot) return null;
    const headings = state.headings.slice(), pitches = state.pitches.slice();
    headings.set(shot.headings, shot.start); pitches.set(shot.pitches, shot.start);
    return { headings, pitches };
  };
  const measure = hero => measureHeroFraming({ ...tour, heroes: [hero] }, data)[0];
  const heroes = [...tour.heroes].sort((a, b) => a.timeMs - b.timeMs);
  const accepted = new Set(heroes.filter(hero => measure(hero).framedFraction >= .8).map(hero => hero.timeMs));
  let changed = false;
  // Record first, so no chase can turn away from an unrecorded subject.
  for (const hero of heroes) {
    if (accepted.has(hero.timeMs)) continue;
    const inFrame = shotCandidates(state, hero, Infinity).candidates
      .find(point => measure({ ...hero, framingPointId: point.id }).framedFraction >= .8);
    if (!inFrame) continue;
    hero.framingPointId = inFrame.id; hero.framingReason = 'retained-in-frame-subject';
    accepted.add(hero.timeMs); changed = true;
  }
  for (const hero of heroes) {
    const current = measure(hero), { intended, candidates } = shotCandidates(state, hero);
    if (current.framedFraction >= .8) {
      if (!upgradeIntended || !current.alternative || !intended) continue;
      // Release only this hero's own window; every other one stays fixed.
      const bounds = shotBounds(state, hero, new Set([...accepted].filter(at => at !== hero.timeMs)));
      const shot = bounds && attemptShot(state, hero, intended, { ...bounds, chase: true, base: replacedAim(hero) });
      if (!shot) continue;
      commitShot(state, hero, intended, shot, accepted, 'rate-limited-intended-upgrade',
        `${hero.pointId}: intended subject replaces accepted alternative ${current.framedPointId}`);
      changed = true;
      continue;
    }
    const bounds = shotBounds(state, hero, accepted);
    if (!bounds) continue;
    for (const point of candidates) {
      const shot = attemptShot(state, hero, point, { ...bounds, chase: true });
      if (!shot) continue;
      commitShot(state, hero, point, shot, accepted,
        point.id === intended?.id ? 'rate-limited-intended-subject' : 'rate-limited-distant-alternative',
        point.id !== hero.pointId ? `${hero.pointId}: rate-limited distant alternative ${point.name || point.id}` : null);
      changed = true;
      break;
    }
  }
  if (!changed) return;
  tour.meanQualityRatio += (state.sum - startSum) / Math.max(.001, state.max);
  tour.heroFraming = measureHeroFraming(tour, data);
  tour.heroCoverage = summarizeHeroCoverage(tour.heroFraming);
}

export function restoreTourTimeline(tour){
  if(tour.previewPose){tour.poseAt=()=>structuredClone(tour.previewPose);return tour;}
  const {eye,target,fov,durationMs}=tour,count=fov.length;
  tour.poseAt=timeMs=>{
    const time=clamp(Number(timeMs)||0,0,durationMs),i=Math.min(count-2,Math.floor(time/100));
    const u=clamp((time-i*100)/Math.max(1,Math.min(durationMs,(i+1)*100)-i*100),0,1),eyeM=[],a=[],b=[];
    for(let k=0;k<3;k++){eyeM[k]=mix(eye[i*3+k],eye[(i+1)*3+k],u);a[k]=target[i*3+k]-eye[i*3+k];b[k]=target[(i+1)*3+k]-eye[(i+1)*3+k];}
    const da=Math.hypot(...a),db=Math.hypot(...b),dot=clamp(a.reduce((n,x,k)=>n+x*b[k]/(da*db),0),-1,1),angle=Math.acos(dot);
    const sa=angle<1e-5?1-u:Math.sin((1-u)*angle)/Math.sin(angle),sb=angle<1e-5?u:Math.sin(u*angle)/Math.sin(angle),d=mix(da,db,u);
    const targetM=eyeM.map((x,k)=>x+(a[k]/da*sa+b[k]/db*sb)*d);
    return{eyeM,targetM,fovYDeg:mix(fov[i],fov[i+1],u),tour:true,meta:[...tour.meta.subarray(i*4,i*4+4)]};
  };
  return tour;
}
/** Continue on the current road to its next node before choosing new roads. */
export function tourContinuation(previous,data,committedThroughMs){
  restoreTourTimeline(previous);
  const timeMs=Math.min(previous.durationMs,Math.ceil((committedThroughMs+3000)/100)*100);
  const profile=previous.routeSpeedProfile||previous.plan?.speedProfile,segments=previous.routeSegments||previous.plan?.segments||[];
  let segment,distance;
  if(profile){
    const factor=previous.scale||1,origin=previous.routeTimeOriginMs||0,tau=previous.routeSlowTauSec||0,elapsed=Math.max(0,(timeMs-origin)/1000);
    const clock=origin+1000*(elapsed/factor+(tau?(1-1/factor)*tau*(1-Math.exp(-elapsed/tau)):0));
    const at=clock/100,i=Math.min(profile.distances.length-1,Math.floor(at)),j=Math.min(i+1,profile.distances.length-1);
    const s=profile.distances[i]+(profile.distances[j]-profile.distances[i])*(at-i);let end=0;
    segment=segments.find(segment=>{const begin=end;end+=segment.path.lengthM;if(s>=begin&&s<end){distance=s-begin;return true;}return false;});
  }else{
    segment=segments.find(s=>timeMs>=s.startMs&&timeMs<s.endMs);
    if(segment){const u=clamp((timeMs-segment.startMs)/(segment.endMs-segment.startMs),0,1),at=u*(segment.integral.length-1),i=Math.floor(at),j=Math.min(i+1,segment.integral.length-1);distance=segment.path.lengthM*mix(segment.integral[i],segment.integral[j],at-i);}
  }
  if(!segment)return null;
  const samples=trimPath(segment.path.samples,distance,0);const pose=previous.poseAt(timeMs);samples[0]=[pose.eyeM[0],pose.eyeM[2],samples[0][2],samples[0][3]];const incoming=segment.path.steps.at(-1),edge=data.edges.find(e=>e.id===incoming?.edgeId);
  if(!edge)return null;
  const road=incoming.reverse?[...edge.samples].reverse():edge.samples;
  const end=samples.at(-1);let closest=0,best=Infinity;
  for(let k=0;k<road.length;k++){const d=Math.hypot(road[k][0]-end[0],road[k][1]-end[1]);if(d<best){best=d;closest=k;}}
  samples.push(...road.slice(closest+1));
  if(samples.length<2||distance>segment.path.lengthM-800)return null;
  const a=previous.poseAt(timeMs-100),b=previous.poseAt(timeMs);
  return{timeMs,pointId:segment.pointId,incoming,samples,speedMps:Math.hypot(b.eyeM[0]-a.eyeM[0],b.eyeM[2]-a.eyeM[2])*10};
}
/** Rebuild the uncommitted tail. The rate limits apply after the committed
 *  horizon, while every pose through that horizon stays exactly as it was. */
export function replanTour(previous,data,plan,committedThroughMs,{upgradeIntended=!!previous.upgradeIntended}={}){
  restoreTourTimeline(previous);
  const freeze=Math.min(previous.durationMs,Math.ceil((committedThroughMs+3000)/100)*100);
  const next=buildTourTimeline(data,plan,{upgradeIntended:!!upgradeIntended,previous,frozenThroughMs:freeze});
  return next;
}
