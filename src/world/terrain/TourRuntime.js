import { sectionRoles } from './SectionRoles.js';
import { restoreTourTimeline } from './TourTimeline.js';
/** CPU planning runs away from rendering; cancelled generations cannot publish. */
export function prepareTourTimeline(data,mgr,{signal=null,previous=null,committedThroughMs=0}={}){
  const sections=mgr?.sections||[],durationMs=mgr?.durationMs||0,energy=new Float32Array(Math.ceil(durationMs/250)+1);
  for(let i=0;i<energy.length;i++)energy[i]=mgr?.energyCurves?.globalEnergy?.(i*.25)??.5;
  const roles=sectionRoles({sections,durationMs,energyCurves:mgr?.energyCurves,conductorSchedule:mgr?.conductorSchedule || [],noteEvents:mgr?.conductor?.timeline||[]});
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./tour-worker.js',import.meta.url),{type:'module'});
    const abort=()=>{worker.terminate();reject(new DOMException('Tour planning aborted','AbortError'));};
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    const finish=()=>{signal?.removeEventListener('abort',abort);worker.terminate();};
    worker.onmessage=e=>{finish();if(e.data.error)reject(new Error(e.data.error));else resolve(restoreTourTimeline(e.data.tour));};
    worker.onerror=e=>{finish();reject(new Error(e.message||'Tour worker failed'));};
    const frozen=previous?.eye?{eye:previous.eye,target:previous.target,fov:previous.fov,meta:previous.meta,reducedMotion:previous.reducedMotion,durationMs:previous.durationMs,heroes:previous.heroes,notes:previous.notes,meanQualityRatio:previous.meanQualityRatio,routeSegments:previous.routeSegments,routeSpeedProfile:previous.routeSpeedProfile,scale:previous.scale,routeTimeOriginMs:previous.routeTimeOriginMs,routeSlowTauSec:previous.routeSlowTauSec}:null;
    worker.postMessage({data,sections,roles,durationMs,energy,reducedMotion:!!mgr?.reducedMotion,previous:frozen,committedThroughMs});
  });
}
