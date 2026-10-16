import { trimPath } from './TourGraph.js';
import { tourClearanceAt, tourClearanceAlong } from './TourPackage.js';
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
 *  they were planned under the previous preference and are never
 *  re-validated against a new (reduced-motion) climb limit. */
function envelopes(frames,locks,climb,lastFrozen=-1){
  const lo=Float64Array.from(frames,f=>f.floorY+5.02),hi=Float64Array.from(frames,f=>f.ceilY-.02),step=climb*.1;
  for(const [i,y]of locks){if(y<lo[i]||y>hi[i])return null;lo[i]=hi[i]=y;}
  for(let i=1;i<lo.length;i++){if(i<=lastFrozen)continue;lo[i]=Math.max(lo[i],lo[i-1]-step);hi[i]=Math.min(hi[i],hi[i-1]+step);if(lo[i]>hi[i]+.001)return null;}
  for(let i=lo.length-2;i>=0;i--){if(i+1<=lastFrozen)continue;lo[i]=Math.max(lo[i],lo[i+1]-step);hi[i]=Math.min(hi[i],hi[i+1]+step);if(lo[i]>hi[i]+.001)return null;}
  return{lo,hi};
}
const smooth=(values,seconds,dt)=>{
  const result=Float64Array.from(values),alpha=1-Math.exp(-dt/seconds);
  for(let i=1;i<result.length;i++)result[i]=mix(result[i-1],result[i],alpha);
  for(let i=result.length-2;i>=0;i--)result[i]=mix(result[i+1],result[i],alpha);
  return result;
};
/** Joint continuous altitude/aim beam DP: tiers are targets, never jumps. */
export function buildTourTimeline(data,plan,{reducedMotion=plan.reducedMotion||false,previous=null,frozenThroughMs=-1}={}){
  const durationMs=plan.durationMs,points=new Map(data.points.map(p=>[p.id,p])),notes=[...plan.notes],heroes=plan.heroes.map(h=>({...h}));
  const preview=points.get(plan.previewPointId),climb=reducedMotion?15:30,yaw=reducedMotion?12:25;
  if(!durationMs){const p=preview.station,a=p.bestAim,eyeM=[p.posM[0],p.yM,p.posM[1]],v=vector(a.headingDeg,a.pitchDeg),pose={eyeM,targetM:eyeM.map((x,i)=>x+v[i]*12000),fovYDeg:fovY(a.hfovDeg),tour:true};return{durationMs:0,heroes:[],notes,meanQualityRatio:1,poseAt:()=>structuredClone(pose),reducedMotion};}
  const count=Math.ceil(durationMs/100)+1;let frames,bounds,locks,scale=1;
  const lastFrozen=previous?Math.min(count-1,Math.floor(frozenThroughMs/100)):-1;
  const routeTimeOriginMs=previous?frozenThroughMs:0,routeSlowTauSec=previous?10:0;
  const routeClock=(time,factor)=>{
    const elapsed=Math.max(0,(time-routeTimeOriginMs)/1000);
    const tail=routeSlowTauSec?(1-1/factor)*routeSlowTauSec*(1-Math.exp(-elapsed/routeSlowTauSec)):0;
    return routeTimeOriginMs+1000*(elapsed/factor+tail);
  };
  const clockRate=(time,factor)=>1/factor+(routeSlowTauSec?(1-1/factor)*Math.exp(-Math.max(0,time-routeTimeOriginMs)/1000/routeSlowTauSec):0);
  for(const factor of [1,1.25,1.5,2,3,4,6,10]){
    frames=Array.from({length:count},(_,i)=>{
      const time=Math.min(durationMs,i*100),route=plan.routeAt(routeClock(time,factor));
      if(previous&&i*100<=frozenThroughMs){const p=previous.poseAt(i*100);route.posM=[p.eyeM[0],p.eyeM[2]];}
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
    locks=new Map();if(previous)for(let i=0;i<count&&i*100<=frozenThroughMs;i++)locks.set(i,previous.poseAt(i*100).eyeM[1]);bounds=envelopes(frames,locks,climb,lastFrozen);
    if(bounds&&factor===1)for(const h of heroes.filter(h=>!h.passedAtRange)){
      const station=points.get(h.pointId).station,proposed=new Map(locks);
      for(let i=Math.max(0,Math.ceil((h.timeMs-1500)/100));i<=Math.min(count-1,Math.floor((h.timeMs+1500)/100));i++)proposed.set(i,station.yM);
      const constrained=envelopes(frames,proposed,climb,lastFrozen);
      if(constrained){locks=proposed;bounds=constrained;}
      else{h.passedAtRange=true;notes.push(`${h.pointId}: exact-height lock cannot fit the climb corridor`);}
    }
    if(bounds){scale=factor;break;}
  }
  if(!bounds)throw new Error('Tour route has no rate-limited altitude corridor');
  if(scale!==1){notes.push(`Route slowed by ${scale} for climb clearance; hero deadlines passed at range`);for(const h of heroes)h.passedAtRange=true;}
  const dpTimes=[];let begin=0;if(previous){for(let t=0;t<=frozenThroughMs&&t<durationMs;t+=100)dpTimes.push(t);begin=frozenThroughMs+250;}for(let t=begin;t<durationMs;t+=250)dpTimes.push(t);dpTimes.push(durationMs);
  let beam=[],lastTime=0;
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
    // of the current preference start at the first uncommitted step.
    const committed=previous&&time<=frozenThroughMs;
    const dt=step?(time-lastTime)/1000:0,limit=committed?Infinity:(frame.role==='outro'||frame.role==='breakdown'?Math.min(12,yaw):yaw)*dt,rise=committed?Infinity:climb*dt;
    const states=new Map();
    const predecessors=beam.length?beam:[null];
    for(const prev of predecessors){
      const targets=station?[station.yM]:frame.sample.tiers.map(t=>t.yM);
      const frameAt=Math.min(count-1,time/100),boundLo=Math.floor(frameAt),boundHi=Math.min(count-1,boundLo+1),fraction=frameAt-boundLo;
      const minimum=mix(bounds.lo[boundLo],bounds.lo[boundHi],fraction),maximum=mix(bounds.hi[boundLo],bounds.hi[boundHi],fraction);
      for(const targetY of targets){
        const y=clamp(targetY,Math.max(minimum,prev?prev.y-rise:minimum),Math.min(maximum,prev?prev.y+rise:maximum));
        if(prev&&Math.abs(y-prev.y)>rise+.001)continue;
        const ranked=Array.from({length:72},(_,k)=>({heading:k*5,quality:aimAt(frame.sample,y,k*5).quality})).sort((a,b)=>b.quality-a.quality||a.heading-b.heading).slice(0,4).map(a=>a.heading);
        const aims=station?[station.bestAim.headingDeg]:[...ranked,prev?.heading,activeHeading,frame.headingDeg,nextStation?.bestAim.headingDeg].filter(Number.isFinite);
        for(const targetHeading of aims){
          const heading=prev?prev.heading+clamp(diff(targetHeading,prev.heading),-limit,limit):targetHeading;
          if(station&&Math.abs(diff(heading,station.bestAim.headingDeg))>.01)continue;
          if(nextStation&&Math.abs(diff(nextStation.bestAim.headingDeg,heading))>yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01)continue;
          const aim=station?{quality:station.bestAim.score,pitch:station.bestAim.pitchDeg,hfov:station.bestAim.hfovDeg,tier:0}:aimAt(frame.sample,y,heading);
          const activeHero=heroes.find(h=>h.pointId===frame.pointId&&h.timeMs+3000>=time);
          const pull=activeHero?clamp(time<=activeHero.timeMs?1-(activeHero.timeMs-time)/4000:1-(time-activeHero.timeMs)/3000,0,1):0;
          const bias=pull*Math.max(0,1-Math.abs(diff(heading,activeHeading))/(aim.hfov*.4));
          const desired=frame.role==='breakdown'?100:frame.role==='solo'?225:['intro','outro'].includes(frame.role)?800:Math.max(120,point.localM[1]-frame.floorY);
          const cost=(prev?.cost||0)+(data.tunables?.viewQualityWeight??1)*aim.quality*(1+.6*bias)-((y-frame.floorY-desired)/250)**2-(prev?.002*diff(heading,prev.heading)**2:0)-(prev?.00002*(y-prev.y)**2:0);
          const key=`${Math.round(y*2)}:${Math.round(heading*4)}`;
          const state={y,heading,aim,cost,previous:prev,time};if(!states.has(key)||states.get(key).cost<cost)states.set(key,state);
        }
      }
    }
    if(!states.size){
      if(lock){lock.passedAtRange=true;notes.push(`${lock.pointId}: aim lock unreachable under yaw limit`);return buildTourTimeline(data,{...plan,heroes,notes},{reducedMotion,previous,frozenThroughMs});}
      throw new Error('Tour timeline has no feasible aim state');
    }
    const diverse=new Map();
    for(const state of states.values()){
      const key=`${Math.round(state.y/60)}:${Math.round(state.heading/15)}`;
      if(!diverse.has(key)||diverse.get(key).cost<state.cost)diverse.set(key,state);
    }
    beam=[...diverse.values()].sort((a,b)=>b.cost-a.cost||a.heading-b.heading||a.y-b.y).slice(0,data.tunables?.timelineBeamWidth||60);lastTime=time;
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
    if(previous&&i*100<=frozenThroughMs){
      for(const [key,array,size]of [['eye',eye,3],['target',target,3],['fov',fov,1],['meta',meta,4]])array.set(previous[key].subarray(i*size,(i+1)*size),i*size);
      y[i]=previous.eye[i*3+1];const v=previous.target.subarray(i*3,i*3+3).map((n,k)=>n-previous.eye[i*3+k]);heading[i]=Math.atan2(v[0],-v[2])/DEG;continue;
    }
    const frame=frames[i],lock=heroes.find(h=>!h.passedAtRange&&Math.abs(h.timeMs-frame.timeMs)<=1500),s=lock?points.get(lock.pointId).station:null;
    const lo=Math.max(bounds.lo[i],i?y[i-1]-climb*.1:bounds.lo[i]),hi=Math.min(bounds.hi[i],i?y[i-1]+climb*.1:bounds.hi[i]);y[i]=s?s.yM:clamp(y[i],lo,hi);
    const rate=(frame.role==='outro'||frame.role==='breakdown'?Math.min(12,yaw):yaw)*.1;
    const nextLock=heroes.find(h=>!h.passedAtRange&&h.timeMs+1500>=frame.timeMs);
    const futureHeading=nextLock?points.get(nextLock.pointId).station.bestAim.headingDeg:null;
    if(i){
      const previousHeading=heading[i-1];
      let low=previousHeading-rate,high=previousHeading+rate;
      if(futureHeading!==null){
        const unwrapped=previousHeading+diff(futureHeading,previousHeading);
        const reach=Math.max(0,nextLock.timeMs-1500-frame.timeMs)*.001*(frame.role==='outro'||frame.role==='breakdown'?Math.min(12,yaw):yaw);
        low=Math.max(low,unwrapped-reach);high=Math.min(high,unwrapped+reach);
      }
      heading[i]=clamp(previousHeading+diff(s?s.bestAim.headingDeg:heading[i],previousHeading),low,high);
    }
    if(s){pitch[i]=s.bestAim.pitchDeg;hfov[i]=s.bestAim.hfovDeg;}
    if(frame.stop&&i&&frames[i-1].stop){heading[i]=heading[i-1];pitch[i]=pitch[i-1];hfov[i]=hfov[i-1];}
    const e=[frame.posM[0],y[i],frame.posM[1]],v=vector(heading[i],pitch[i]);eye.set(e,i*3);target.set(e.map((x,k)=>x+v[k]*12000),i*3);fov[i]=fovY(hfov[i]);
    const aim=aimAt(frame.sample,y[i],heading[i]);qualitySum+=aim.quality;maxSum+=Math.max(...frame.sample.tiers.flatMap(t=>[...t.score]))/255;
    meta.set([aim.tier,data.points.findIndex(p=>p.id===frame.pointId),Math.max(0,data.roles.indexOf(frame.role)),lock?1:0],i*4);
  }
  return restoreTourTimeline({durationMs,eye,target,fov,meta,heroes,notes,reducedMotion,meanQualityRatio:qualitySum/Math.max(.001,maxSum),data,plan,routeSegments:plan.segments,routeSpeedProfile:plan.speedProfile,scale,routeTimeOriginMs,routeSlowTauSec});
}
export function restoreTourTimeline(tour){
  if(tour.previewPose){tour.poseAt=()=>structuredClone(tour.previewPose);return tour;}
  const {eye,target,fov,durationMs}=tour,count=fov.length;
  tour.poseAt=timeMs=>{
    const t=clamp(Number(timeMs)||0,0,durationMs)/100,i=Math.min(count-2,Math.floor(t)),u=clamp(t-i,0,1),eyeM=[],a=[],b=[];
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
/** Rebuild the uncommitted tail. `reducedMotion` is the CURRENT preference
 *  (default: the previous tour's): it sets the limits after the committed
 *  horizon, while every pose through that horizon stays exactly as it was. */
export function replanTour(previous,data,plan,committedThroughMs,{reducedMotion=previous.reducedMotion}={}){
  restoreTourTimeline(previous);
  const freeze=Math.min(previous.durationMs,Math.ceil((committedThroughMs+3000)/100)*100);
  const next=buildTourTimeline(data,plan,{reducedMotion:!!reducedMotion,previous,frozenThroughMs:freeze});
  return next;
}
