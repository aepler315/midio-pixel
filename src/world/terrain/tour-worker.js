import{planTour}from'./TourPlanner.js';import{buildTourTimeline,replanTour,tourContinuation}from'./TourTimeline.js';
self.onmessage=e=>{
 try{
  const {data,sections,roles,durationMs,energy,reducedMotion,previous,committedThroughMs}=e.data;
  const energyAt=t=>energy[Math.min(energy.length-1,Math.max(0,Math.round(t/250)))];
  const startContinuation=previous?tourContinuation(previous,data,committedThroughMs):null;
  if(previous&&!startContinuation){self.postMessage({tour:{...previous,notes:[...(previous.notes||[]),'Refinement deferred: no safe road continuation before the end']}});return;}
  const plan=planTour(data,{sections,roles,durationMs,energyAt,reducedMotion,startContinuation});
  const result=previous?replanTour(previous,data,plan,committedThroughMs,{reducedMotion}):buildTourTimeline(data,plan,{reducedMotion});
  const tour={durationMs:result.durationMs,eye:result.eye,target:result.target,fov:result.fov,meta:result.meta,heroes:result.heroes,notes:result.notes,reducedMotion:result.reducedMotion,meanQualityRatio:result.meanQualityRatio,heroFraming:result.heroFraming,routeSegments:result.routeSegments,routeSpeedProfile:result.routeSpeedProfile,scale:result.scale,routeTimeOriginMs:result.routeTimeOriginMs,routeSlowTauSec:result.routeSlowTauSec};
  const transfer=[tour.eye,tour.target,tour.fov,tour.meta].filter(Boolean).map(a=>a.buffer);
  // Preview has no keyframe arrays: serialize its one fixed pose instead.
  if(!durationMs)tour.previewPose=result.poseAt(0);
  self.postMessage({tour},transfer);
 }catch(error){self.postMessage({error:error.message});}
};
