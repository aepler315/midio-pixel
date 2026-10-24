import { TourGraph, pathPointAt, trimPath } from './TourGraph.js';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function heroTime(section, energyAt = () => section.relEnergy01 || .5) {
  const length=section.endMs-section.startMs;if(length<4000)return null;
  let time=section.startMs+length*.2,value=-Infinity;
  for(let t=section.startMs+length*.2;t<=section.startMs+length*.6;t+=250){const e=energyAt(t);if(e>value){value=e;time=t;}}
  return clamp(time,section.startMs+2000,section.endMs-2000);
}
/** Pure deterministic sequence search. A missed deadline never changes roads. */
export function planTour(data,{sections=[],roles=null,durationMs=0,energyAt=null,graph=new TourGraph(data),startContinuation=null}={}) {
  const energy=t=>clamp(Number(energyAt?.(t)??sections.find(s=>t>=s.startMs&&t<s.endMs)?.relEnergy01??.5),0,1);
  const stations=data.points.filter(p=>p.station&&p.tier!=='scenery'),points=new Map(stations.map(p=>[p.id,p]));
  if(!stations.length)throw new Error('Tour has no stations');
  durationMs=Math.max(0,Number(durationMs)||0);
  const descriptors=sections.map((s,i)=>({...s,...roles?.[i],role:roles?.[i]?.role||s.role||'verse',sectionIndex:i}));
  const events=descriptors.map(s=>({...s,timeMs:heroTime(s,energy)})).filter(s=>s.timeMs!==null&&s.timeMs>(startContinuation?.timeMs??-1));
  const hasOrbits=data.edges.some(e=>e.kind==='orbit');
  const notes=[],missed=[],occurrences=new Map();let states=[];
  const climb = 30, yaw = 25;
  const feasibleLeg = (a, b, seconds) => {
    const turn = Math.abs(((b.station.bestAim.headingDeg - a.station.bestAim.headingDeg + 540) % 360) - 180);
    return Math.abs(b.station.yM - a.station.yM) <= seconds * climb && turn <= seconds * yaw;
  };
  const path=(a,b,incoming=null)=>graph.shortestPath(a.station.nodeId,b.station.nodeId,{geometry:false,incoming});
  const candidates=event=>{
    const compatible=[event.role,...(data.fallback?.[event.role]||[])];
    const pool=stations.filter(p=>compatible.includes(p.role)).map(p=>({p,penalty:p.role===event.role?0:[.35,.6,.8][compatible.indexOf(p.role)-1]||.8}));
    if(!pool.length)return stations.map(p=>({p,penalty:1})).slice(0,24);
    return pool.sort((a,b)=>a.penalty-b.penalty||(a.p.tier==='backup')-(b.p.tier==='backup')||b.p.grandeur-a.p.grandeur||a.p.id.localeCompare(b.p.id)).slice(0,24);
  };
  for(const event of events){
    const occurrence=(occurrences.get(event.role)||0)+1;occurrences.set(event.role,occurrence);
    const ownPrimaries=stations.filter(p=>p.role===event.role&&p.tier==='primary');
    const highest=ownPrimaries.toSorted((a,b)=>b.grandeur-a.grandeur||a.id.localeCompare(b.id))[0];
    const remainingFinal=events.some(e=>e.timeMs>event.timeMs&&e.role===event.role&&e.finalChorus);
    const pool=candidates(event),next=[];
    for(const {p,penalty}of pool){let winner;
      for(const previous of states.length?states:[null]){
        if(previous&&occurrence<=4&&p.role===event.role&&p.tier==='primary'&&previous.used.has(p.id)&&ownPrimaries.some(q=>!previous.used.has(q.id)))continue;
        if(event.finalChorus&&p.id!==highest?.id)continue;
        if(remainingFinal&&p.id===highest?.id&&ownPrimaries.length>=4)continue;
        if(!previous&&hasOrbits&&!graph.canReachOrbit(p.station.nodeId))continue;
        const dt=previous?(event.timeMs-previous.event.timeMs)/1000:Math.max(2,event.timeMs/1000);
        if(previous&&Math.hypot(p.station.posM[0]-previous.p.station.posM[0],p.station.posM[1]-previous.p.station.posM[1])>dt*90)continue;
        const lowerBound=(previous?.cost||0)+penalty+(p.tier==='backup'?.3:-1)+(previous?.used.has(p.id)?3:0)
          -(event.finalChorus?1.5*p.grandeur:0)-(event.role==='drop'?p.grandeur+(p.name==='Grand Teton'?8:0):0);
        if(winner&&lowerBound>=winner.cost)continue;
        const travel=previous?path(previous.p,p,previous.incoming):null;if(previous&&(!travel||!feasibleLeg(previous.p,p,dt)))continue;
        if(travel?.steps.length&&event.timeMs<durationMs-8000&&!(hasOrbits?graph.canReachOrbit(p.station.nodeId,travel.steps.at(-1)):graph.canContinue(p.station.nodeId,travel.steps.at(-1))))continue;
        const agl=300; // Spec tier2 AGL for transition feasibility.
        const omega=travel?travel.lengthM/dt/agl:.05+.17*energy(event.timeMs),target=.05+.17*energy(event.timeMs);
        let cost=(previous?.cost||0)+4*Math.log(Math.max(.001,dt>22?Math.max(omega,target):omega)/target)**2+penalty+(p.tier==='backup'?.3:-1)+(previous?.used.has(p.id)?3:0);
        if(omega>.3||omega<.03&&dt<=22)cost+=50*Math.abs(Math.log(Math.max(.001,omega)/clamp(omega,.03,.3)));
        if(event.finalChorus)cost-=1.5*p.grandeur;if(event.role==='drop'){cost-=p.grandeur;if(p.name==='Grand Teton')cost-=8;}
        if(previous){const oldEdges=new Set(previous.recent.filter(e=>event.timeMs-e.timeMs<60000).flatMap(e=>e.ids));cost+=2*(travel.steps.filter(e=>oldEdges.has(e.edgeId)).length/Math.max(1,travel.steps.length));}
        if(!winner||cost<winner.cost){const used=new Set(previous?.used||[]);used.add(p.id);winner={p,event,cost,used,previous,incoming:travel?.steps.at(-1)||previous?.incoming,recent:[...(previous?.recent||[]),{timeMs:event.timeMs,ids:travel?.steps.map(s=>s.edgeId)||[]}]};}
      }
      if(winner)next.push(winner);
    }
    if(!next.length){notes.push(`Section ${event.sectionIndex}: no legal junction route; passed at range`);missed.push({timeMs:event.timeMs,pointId:(pool[0]?.p||stations[0]).id,sectionIndex:event.sectionIndex,role:event.role,finalChorus:!!event.finalChorus,subHero:false,passedAtRange:true});continue;}
    states=next.sort((a,b)=>a.cost-b.cost||a.p.id.localeCompare(b.p.id));
  }
  const sequence=[];let chosen=states[0];while(chosen){sequence.push(chosen);chosen=chosen.previous;}sequence.reverse();
  const heroes=sequence.map(s=>({timeMs:s.event.timeMs,pointId:s.p.id,sectionIndex:s.event.sectionIndex,role:s.event.role,finalChorus:!!s.event.finalChorus,subHero:false,passedAtRange:false,incoming:s.incoming}));
  // Insert only subheroes that fit between the surrounding main visits.
  for(const section of descriptors){
    if(section.endMs-section.startMs<=22000)continue;
    const count=Math.ceil((section.endMs-section.startMs)/22000)-1;
    for(let i=1;i<=count;i++){
      const timeMs=section.startMs+(section.endMs-section.startMs)*i/(count+1);
      const sorted=[...heroes].sort((a,b)=>a.timeMs-b.timeMs);
      if(sorted.some(h=>Math.abs(h.timeMs-timeMs)<1500))continue;
      const before=sorted.findLast(h=>h.timeMs<timeMs),after=sorted.find(h=>h.timeMs>timeMs);
      const a=points.get((before||after)?.pointId);if(!a)continue;
      const pool=stations.filter(p=>p.id!==a.id&&(p.role===section.role||(data.fallback?.[section.role]||[]).includes(p.role)));
      const choices=pool.map(p=>{const into=path(a,p,before?.incoming);return{p,path:into,out:after&&into?path(p,points.get(after.pointId),into.steps.at(-1)):null};}).filter(c=>c.path&&c.path.lengthM>0
        &&c.path.lengthM<=Math.max(0,timeMs-(before?.timeMs||section.startMs))*.001*90
        &&(!after||c.out&&c.out.lengthM<=(after.timeMs-timeMs)*.001*90&&(!after.incoming||JSON.stringify(c.out.steps.at(-1))===JSON.stringify(after.incoming))));
      choices.sort((a,b)=>(a.p.tier==='backup'?0:1)-(b.p.tier==='backup'?0:1)||a.path.lengthM-b.path.lengthM||a.p.id.localeCompare(b.p.id));
      const choice=choices[0];if(!choice)continue;
      heroes.push({timeMs,pointId:choice.p.id,sectionIndex:section.sectionIndex,role:section.role,subHero:true,passedAtRange:false,incoming:choice.path.steps.at(-1)});
    }
  }
  heroes.sort((a,b)=>a.timeMs-b.timeMs||a.pointId.localeCompare(b.pointId));
  const preview=stations.filter(p=>p.role==='drop').toSorted((a,b)=>b.grandeur-a.grandeur||a.id.localeCompare(b.id))[0]||stations[0];
  const first=heroes[0]?points.get(heroes[0].pointId):preview;
  const startCandidates=stations.filter(p=>['intro','outro'].includes(p.role)&&p.id!==first.id&&Math.hypot(p.station.posM[0]-first.station.posM[0],p.station.posM[1]-first.station.posM[1])<=Math.max(0,heroes[0]?.timeMs||0)*.001*90).map(p=>({p,path:path(p,first)})).filter(c=>c.path);
  startCandidates.sort((a,b)=>Math.abs(a.path.lengthM/(Math.max(1,heroes[0]?.timeMs||durationMs)*.001)-60)-Math.abs(b.path.lengthM/(Math.max(1,heroes[0]?.timeMs||durationMs)*.001)-60)||a.p.id.localeCompare(b.p.id));
  const second=heroes[1]?points.get(heroes[1].pointId):null;
  const feasibleStart=startCandidates.find(c=>{
    if(c.path.lengthM>Math.max(0,heroes[0]?.timeMs||0)*.001*90)return false;
    if(!second)return !hasOrbits||graph.canReachOrbit(first.station.nodeId,c.path.steps.at(-1));
    const onward=path(first,second,c.path.steps.at(-1));
    return onward&&onward.lengthM<=(heroes[1].timeMs-heroes[0].timeMs)*.001*90&&(!heroes[1].incoming||JSON.stringify(onward.steps.at(-1))===JSON.stringify(heroes[1].incoming));
  });
  const start=startContinuation?points.get(startContinuation.pointId):(feasibleStart?.p||first),anchors=[{timeMs:startContinuation?.timeMs||0,pointId:start.id},...heroes.map(h=>({...h,hero:h}))];
  const last=points.get(anchors.at(-1).pointId);
  const endCandidates=stations.filter(p=>p.id!==last.id&&p.role===(heroes.at(-1)?.role||last.role)).map(p=>({p,path:path(last,p)})).filter(c=>c.path&&(hasOrbits?graph.canReachOrbit(c.p.station.nodeId,c.path.steps.at(-1)):graph.canContinue(c.p.station.nodeId,c.path.steps.at(-1)))).sort((a,b)=>a.path.lengthM-b.path.lengthM||a.p.id.localeCompare(b.p.id));
  anchors.push({timeMs:durationMs,pointId:endCandidates[0]?.p.id||last.id});
  const segments=[];let actualStart=startContinuation?.timeMs||0;
  for(let i=1;i<anchors.length;i++){
    const a=points.get(anchors[i-1].pointId);let b=points.get(anchors[i].pointId);const incoming=segments.findLast(s=>s.path.steps.length)?.path.steps.at(-1)||(i===1?startContinuation?.incoming:null),baseTravel=graph.shortestPath(a.station.nodeId,b.station.nodeId,{incoming});
    let travel=baseTravel;
    if(travel?.steps.length&&hasOrbits&&!graph.canReachOrbit(b.station.nodeId,travel.steps.at(-1)))travel=null;
    if(!travel){
      anchors[i].passedAtRange=true;if(anchors[i].hero)anchors[i].hero.passedAtRange=true;
      notes.push(`${b.name||b.id}: no legal outgoing turn; visit deferred`);
      anchors.splice(i,1);i--;continue;
    }
    // The first leg starts on the committed road: prepend it (and drop the
    // junction fillet, which has no earlier segment to trim). Applied again
    // if a hero substitution below replaces this leg.
    const continueFrom=route=>{
      const prefix=trimPath(startContinuation.samples,0,route.startFillet?.trimM||0);
      const length=prefix.reduce((n,p,k)=>n+(k?Math.hypot(p[0]-prefix[k-1][0],p[1]-prefix[k-1][1]):0),0);
      return{...route,lengthM:length+route.lengthM,samples:[...prefix,...route.samples.slice(1)],startFillet:null};
    };
    if(i===1&&startContinuation)travel=continueFrom(travel);
    if(anchors[i].hero&&travel.lengthM>Math.max(0,anchors[i].timeMs-actualStart)*.001*90){
      const limit=Math.max(0,anchors[i].timeMs-actualStart)*.001*90;
      const pool=stations.filter(p=>p.id!==a.id&&(p.role===anchors[i].role||(data.fallback?.[anchors[i].role]||[]).includes(p.role)))
        .map(p=>({p,route:graph.shortestPath(a.station.nodeId,p.station.nodeId,{incoming,geometry:false})}))
        .filter(c=>c.route&&c.route.lengthM<=limit&&(hasOrbits?graph.canReachOrbit(c.p.station.nodeId,c.route.steps.at(-1)):graph.canContinue(c.p.station.nodeId,c.route.steps.at(-1)))).sort((x,y)=>(x.p.role!==anchors[i].role)-(y.p.role!==anchors[i].role)||(x.p.tier==='backup')-(y.p.tier==='backup')||x.route.lengthM-y.route.lengthM||x.p.id.localeCompare(y.p.id));
      if(pool.length){
        b=pool[0].p;travel=graph.shortestPath(a.station.nodeId,b.station.nodeId,{incoming});
        if(i===1&&startContinuation)travel=continueFrom(travel);
        anchors[i].pointId=b.id;anchors[i].hero.pointId=b.id;
        notes.push(`Section ${anchors[i].sectionIndex}: substituted reachable ${b.tier} ${b.name||b.id}`);
      }else{
        anchors[i].hero.passedAtRange=true;
        notes.push(`${b.name||b.id}: visit passed at range to preserve following hero deadlines`);
        anchors.splice(i,1);i--;continue;
      }
    }
    if(travel.startFillet?.trimM){
      const previous=segments.findLast(s=>s.path.lengthM>0);
      const trimmed=trimPath(previous.path.samples,0,travel.startFillet.trimM);
      trimmed[trimmed.length-1]=[...travel.samples[0]];
      previous.path={...previous.path,samples:trimmed,lengthM:trimmed.reduce((n,p,k)=>n+(k?Math.hypot(p[0]-trimmed[k-1][0],p[1]-trimmed[k-1][1]):0),0)};
      previous.meanSpeed=previous.path.lengthM/Math.max(.001,(previous.endMs-previous.startMs)/1000);
      if(travel.startFillet.trimM>150){anchors[i-1].passedAtRange=true;if(anchors[i-1].hero)anchors[i-1].hero.passedAtRange=true;}
      notes.push(`${a.name||a.id}: route follows the junction fillet (${travel.startFillet.trimM.toFixed(1)}m trim)`);
    }
    const startMs=actualStart,requested=anchors[i].timeMs;
    const agl=300; // The route feasibility tier, not a constant station height.
    const maxSpeed=Math.min(320,.3*agl),endMs=Math.max(requested,startMs+(travel.lengthM/maxSpeed)*1000);
    if(endMs>requested+1&&anchors[i].sectionIndex!==undefined){anchors[i].passedAtRange=true;if(anchors[i].hero)anchors[i].hero.passedAtRange=true;notes.push(`${b.name||b.id}: deadline infeasible, passed at range`);}
    const steps=Math.max(1,Math.ceil((endMs-startMs)/100)),integral=new Float32Array(steps+1);let sum=0;
    for(let k=1;k<=steps;k++){const t=startMs+(endMs-startMs)*(k-.5)/steps;let local=0;for(let q=-4;q<=4;q++)local+=energy(t+q*500);sum+=.6+.8*local/9;integral[k]=sum;}
    for(let k=1;k<=steps;k++)integral[k]/=sum;
    segments.push({startMs,endMs,pointId:b.id,role:anchors[i].role||b.role,path:travel,integral,meanSpeed:travel.lengthM/Math.max(.001,(endMs-startMs)/1000)});actualStart=endMs;
  }
  // Match the velocity at every shared anchor with a monotone Hermite
  // distance curve. The energy integral supplies the interior shape.
  for(let i=0;i<segments.length;i++){
    const segment=segments[i],L=segment.path.lengthM,T=(segment.endMs-segment.startMs)/1000;
    const mean=L/Math.max(.001,T),left=segments[i-1]?.meanSpeed??mean,right=segments[i+1]?.meanSpeed??mean;
    const v0=i===0&&startContinuation?Math.min(1.5*mean,startContinuation.speedMps):Math.min(1.5*Math.min(mean,left),(mean+left)/2),v1=Math.min(1.5*Math.min(mean,right),(mean+right)/2);
    segment.startSpeed=v0;segment.endSpeed=v1;
    if(!L)continue;
    const original=segment.integral,n=original.length-1;
    const old0=(original[1]-original[0])*n/T*L,old1=(original[n]-original[n-1])*n/T*L;
    let previous=0,valid=true;
    for(let k=1;k<n;k++){
      const u=k/n,h10=u*(1-u)*(1-u),h11=u*u*(u-1);
      const value=original[k]+(h10*(v0-old0)+h11*(v1-old1))*T/L;
      if(value<previous||value>1){valid=false;break;}previous=value;
    }
    for(let k=0;k<=n;k++){
      const u=k/n,h10=u*(1-u)*(1-u),h11=u*u*(u-1);
      segment.integral[k]=valid?original[k]+(h10*(v0-old0)+h11*(v1-old1))*T/L
        :(-2*u*u*u+3*u*u)+(h10*v0+h11*v1)*T/L;
    }
  }
  const stops=descriptors.flatMap(s=>s.stops||[]);
  const rawRouteAt=timeMs=>{
    const t=clamp(Number(timeMs)||0,0,durationMs),segment=segments.find(s=>t<=s.endMs)||segments.at(-1);
    if(!segment)return{posM:[...preview.station.posM],floorY:0,ceilY:4700,speedMps:0,pointId:preview.id,role:preview.role};
    const u=clamp((t-segment.startMs)/Math.max(1,segment.endMs-segment.startMs),0,1),at=u*(segment.integral.length-1),lo=Math.floor(at),hi=Math.min(lo+1,segment.integral.length-1),fraction=segment.integral[lo]+(segment.integral[hi]-segment.integral[lo])*(at-lo);
    const p=pathPointAt(segment.path.samples,segment.path.lengthM*fraction),ahead=pathPointAt(segment.path.samples,Math.min(segment.path.lengthM,segment.path.lengthM*fraction+10));
    return{posM:p.slice(0,2),floorY:p[2],ceilY:p[3],speedMps:segment.path.lengthM*(segment.integral[hi]-segment.integral[lo])*(segment.integral.length-1)/Math.max(.001,(segment.endMs-segment.startMs)/1000),stop:stops.some(s=>t>=s.startMs&&t<=s.endMs),headingDeg:Math.atan2(ahead[0]-p[0],-(ahead[1]-p[1]))*180/Math.PI,pointId:segment.pointId,role:segment.role};
  };
  // A single acceleration envelope removes discontinuities at section
  // boundaries. Arc length remains on the same joined road sequence.
  const allSamples=[];
  for(const segment of segments)if(segment.path.lengthM>0)allSamples.push(...(allSamples.length?segment.path.samples.slice(1):segment.path.samples));
  const firstSpeedIndex=Math.ceil((startContinuation?.timeMs||0)/100);
  const n=Math.ceil(durationMs/100)+1,speeds=new Float64Array(n),distances=new Float64Array(n),acceleration=11.8*.1;
  for(let i=0;i<n;i++){
    const t=Math.min(durationMs,i*100),route=rawRouteAt(t),stop=stops.find(s=>t>=s.startMs-500&&t<=s.endMs+500);
    let speed=clamp(route.speedMps,30,data.tunables?.maxSpeedMps||90);
    if(stop){const amount=clamp(Math.min((t-stop.startMs+500)/500,(stop.endMs+500-t)/500),0,1);speed=speed*(1-amount)+9*amount;}
    speeds[i]=i<=firstSpeedIndex&&startContinuation?startContinuation.speedMps:speed;
  }
  for(let pass=0;pass<2;pass++){
    for(let i=firstSpeedIndex+1;i<n;i++)speeds[i]=clamp(speeds[i],speeds[i-1]-acceleration,speeds[i-1]+acceleration);
    for(let i=n-2;i>firstSpeedIndex;i--)speeds[i]=clamp(speeds[i],speeds[i+1]-acceleration,speeds[i+1]+acceleration);
  }
  for(let i=firstSpeedIndex+1;i<n;i++)distances[i]=distances[i-1]+(speeds[i-1]+speeds[i])*.05;
    const requiredDistance=distances.at(-1)+100;

  let routeLength=segments.reduce((n,s)=>n+s.path.lengthM,0),lastPoint=points.get(segments.at(-1)?.pointId)||first,lastNode=lastPoint.station.nodeId;
  for(let lap=0;routeLength<requiredDistance&&lap<100;lap++){
    const incoming=segments.findLast(s=>s.path.steps.length)?.path.steps.at(-1);
    const entry=graph.orbitRoute(lastNode,incoming);
    let extra=entry?.path;
    if(extra?.lengthM===0)extra=graph.follow(entry.step,incoming);
    if(!extra){
      if(!hasOrbits){
        const step=(graph.adj.get(lastNode)||[]).find(step=>graph.follow(step,incoming));
        extra=step?graph.follow(step,incoming):null;
      }
      if(!extra)throw new Error('Tour ending has no legal moving continuation');
    }
    const finalStep=extra.steps.at(-1),edge=data.edges.find(e=>e.id===finalStep.edgeId);
    lastNode=finalStep.reverse?edge.a:edge.b;
    lastPoint=stations.find(p=>p.station.nodeId===lastNode)||lastPoint;
    const previous=segments.findLast(s=>s.path.lengthM>0);
    if(previous&&extra.startFillet?.trimM){
      previous.path={...previous.path,samples:trimPath(previous.path.samples,0,extra.startFillet.trimM)};
      previous.path.samples[previous.path.samples.length-1]=[...extra.samples[0]];
      previous.path.lengthM=previous.path.samples.reduce((n,p,i)=>n+(i?Math.hypot(p[0]-previous.path.samples[i-1][0],p[1]-previous.path.samples[i-1][1]):0),0);
    }
    segments.push({startMs:durationMs,endMs:durationMs,pointId:lastPoint.id,role:descriptors.at(-1)?.role||lastPoint.role,path:extra,integral:new Float32Array([0,1]),meanSpeed:90});
    routeLength=segments.reduce((n,s)=>n+s.path.lengthM,0);
    notes.push(`Orbit filler: ${extra.steps.map(s=>s.edgeId).join(', ')}`);
  }
  allSamples.length=0;for(const segment of segments)if(segment.path.lengthM>0)allSamples.push(...(allSamples.length?segment.path.samples.slice(1):segment.path.samples));
  const lengths=segments.map(s=>s.path.lengthM);let total=0;const ends=lengths.map(L=>total+=L);
  for(const h of heroes){const i=Math.min(n-1,Math.round(h.timeMs/100)),point=points.get(h.pointId);if(allSamples.length){const p=pathPointAt(allSamples,distances[i]);if(Math.hypot(p[0]-point.station.posM[0],p[1]-point.station.posM[1])>150)h.passedAtRange=true;}}
  const routeAt=timeMs=>{
    if(!allSamples.length)return rawRouteAt(timeMs);
    const time=clamp(Number(timeMs)||0,0,durationMs),at=time/100,i=Math.min(n-2,Math.floor(at)),u=clamp(at-i,0,1),s=distances[i]+(distances[i+1]-distances[i])*u;
    const point=pathPointAt(allSamples,Math.min(s,total)),ahead=pathPointAt(allSamples,Math.min(s+10,total)),segment=segments[ends.findIndex(end=>end>=s)]||segments.at(-1);
    return{posM:point.slice(0,2),floorY:point[2],ceilY:point[3],speedMps:s>=total?0:speeds[i]+(speeds[i+1]-speeds[i])*u,headingDeg:Math.atan2(ahead[0]-point[0],-(ahead[1]-point[1]))*180/Math.PI,pointId:segment.pointId,role:segment.role,stop:stops.some(stop=>time>=stop.startMs&&time<=stop.endMs)};
  };
  heroes.push(...missed);heroes.sort((a,b)=>a.timeMs-b.timeMs||a.pointId.localeCompare(b.pointId));
  return{durationMs,heroes,segments,notes,previewPointId:preview.id,stops,routeAt,speedProfile:{speeds,distances,samples:allSamples}};
}
