import { tourClearanceAt } from './TourPackage.js';
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a, b) => { const d = dist(a, b); return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
class Heap {
  values = [];
  push(value) { const a=this.values; let i=a.length;a.push(value);while(i){const p=(i-1)>>1;if(a[p].cost<=value.cost)break;a[i]=a[p];i=p;}a[i]=value; }
  pop(){const a=this.values,v=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].cost<a[c].cost)c++;if(a[c].cost>=last.cost)break;a[i]=a[c];i=c;}a[i]=last;}return v;}
}
export function pathPointAt(samples, distanceM) {
  let left=Math.max(0,distanceM);
  for(let i=1;i<samples.length;i++){const d=dist(samples[i-1],samples[i]);if(left<=d){const t=d?left/d:0;return samples[i-1].map((v,k)=>v+(samples[i][k]-v)*t);}left-=d;}
  return [...samples.at(-1)];
}
const lengthOf = samples => samples.reduce((n,p,i)=>n+(i?dist(samples[i-1],p):0),0);
export function trimPath(samples, start, end) {
  const length=lengthOf(samples),result=[pathPointAt(samples,start)];let at=0;
  for(let i=1;i<samples.length;i++){at+=dist(samples[i-1],samples[i]);if(at>start&&at<length-end)result.push([...samples[i]]);}
  result.push(pathPointAt(samples,length-end));return result;
}
/** Oriented-edge Dijkstra prevents an illegal turn from winning by distance. */
export class TourGraph {
  constructor(data,{radiusM=data.tunables?.turnRadiusM||400}={}) {
    this.data=data;this.radiusM=radiusM;this.nodes=new Map(data.nodes.map(n=>[n.id,n]));this.adj=new Map(data.nodes.map(n=>[n.id,[]]));this.cache=new Map();this.trees=new Map();this.joins=new Map(Object.entries(data.junctions||{}));this.oriented=new Map();this.orbitReach=new Map();
    for(const e of [...data.edges].sort((a,b)=>a.id.localeCompare(b.id))){
      this.adj.get(e.a).push({edge:e,from:e.a,to:e.b,reverse:false,samples:e.samples});
      this.adj.get(e.b).push({edge:e,from:e.b,to:e.a,reverse:true,samples:[...e.samples].reverse()});
    }
    this.orbitSteps=[...this.adj.values()].flat().filter(step=>step.edge.kind==='orbit');
    for(const steps of this.adj.values())for(const step of steps)this.oriented.set(`${step.edge.id}:${step.reverse}:${step.to}`,step);
  }
  join(a,b) {
    const key=`${a.edge.id}:${a.reverse}:${b.edge.id}:${b.reverse}`;
    if(this.joins.has(key))return this.joins.get(key);
    const result=this._join(a,b);this.joins.set(key,result);return result;
  }
  _join(a,b) {
    const first=a.samples,last=b.samples,node=first.at(-1),u=unit(pathPointAt(first,Math.max(0,a.edge.lengthM-100)),node),v=unit(last[0],pathPointAt(last,Math.min(100,b.edge.lengthM)));
    const angle=Math.acos(Math.max(-1,Math.min(1,u[0]*v[0]+u[1]*v[1])));
    if(angle<.01)return {trimM:0,lengthM:0,samples:[],radiusM:this.radiusM};
    if(angle>2*Math.PI/3+1e-6)return null;
    const trimM=this.radiusM*Math.tan(angle/2);
    if(trimM>Math.min(a.edge.lengthM,b.edge.lengthM)*.45)return null;
    const sign=Math.sign(u[0]*v[1]-u[1]*v[0]),start=[node[0]-u[0]*trimM,node[1]-u[1]*trimM];
    const center=[start[0]-u[1]*this.radiusM*sign,start[1]+u[0]*this.radiusM*sign];
    const az=Math.atan2(start[1]-center[1],start[0]-center[0]),samples=[],count=Math.ceil(angle*this.radiusM/25);
    for(let i=0;i<=count;i++){
      const t=az+angle*sign*i/count,x=center[0]+this.radiusM*Math.cos(t),z=center[1]+this.radiusM*Math.sin(t);
      const band=this.data.clearance?tourClearanceAt(this.data.clearance,x,z):{floorY:Math.max(node[2],last[0][2]),ceilY:Math.min(node[3],last[0][3])};
      if(!Number.isFinite(band.floorY)||band.ceilY-band.floorY<150)return null;
      samples.push([x,z,band.floorY,band.ceilY]);
    }
    const actualStart=pathPointAt(first,a.edge.lengthM-trimM),actualEnd=pathPointAt(last,trimM);
    if(dist(actualStart,samples[0])>1||dist(actualEnd,samples.at(-1))>1){
      // Roads can already curve near a node. Fit their actual trimmed
      // positions and tangents rather than connecting an idealized circle
      // to mismatched endpoints (which creates a sharp corner).
      for(const factor of [1,1.2,1.5,2,3]){
        const cut=trimM*factor;if(cut>Math.min(a.edge.lengthM,b.edge.lengthM)*.45)break;
        const p=pathPointAt(first,a.edge.lengthM-cut),q=pathPointAt(last,cut);
        const u=unit(pathPointAt(first,a.edge.lengthM-cut-10),p),v=unit(q,pathPointAt(last,cut+10)),theta=Math.acos(Math.max(-1,Math.min(1,u[0]*v[0]+u[1]*v[1])));
        const magnitude=dist(p,q)/(Math.cos(theta/4)**2),curve=[],steps=Math.max(8,Math.ceil(dist(p,q)/10));let safe=true;
        for(let k=0;k<=steps;k++){
          const t=k/steps,h00=2*t*t*t-3*t*t+1,h10=t*t*t-2*t*t+t,h01=-2*t*t*t+3*t*t,h11=t*t*t-t*t;
          const x=h00*p[0]+h10*u[0]*magnitude+h01*q[0]+h11*v[0]*magnitude,z=h00*p[1]+h10*u[1]*magnitude+h01*q[1]+h11*v[1]*magnitude;
          const band=this.data.clearance?tourClearanceAt(this.data.clearance,x,z):{floorY:Math.max(p[2],q[2]),ceilY:Math.min(p[3],q[3])};
          if(!Number.isFinite(band.floorY)||band.ceilY-band.floorY<150){safe=false;break;}curve.push([x,z,band.floorY,band.ceilY]);
        }
        if(!safe)continue;
        let minimumRadius=Infinity;
        for(let k=1;k<curve.length-1;k++){
          const p=curve[k-1],q=curve[k],r=curve[k+1],area=Math.abs((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]));
          if(area>1e-6)minimumRadius=Math.min(minimumRadius,dist(p,q)*dist(q,r)*dist(p,r)/(2*area));
        }
        if(minimumRadius>=this.radiusM)return{trimM:cut,lengthM:lengthOf(curve),samples:curve,radiusM:minimumRadius};
      }
      return null;
    }
    return {trimM,lengthM:angle*this.radiusM,samples,radiusM:this.radiusM};
  }
  orbitRoute(node,incoming=null,{geometry=true}={}) {
    let best=null;
    for(const step of this.orbitSteps){
      if(step.edge.kind!=='orbit'||!this.join(step,step))continue;
      const path=this.shortestPath(node,step.from,{incoming,geometry,outgoing:step});
      if(path&&!geometry)return{path,step};
      if(path&&(!best||path.lengthM<best.path.lengthM))best={path,step};
    }
    return best;
  }
  canReachOrbit(node,incoming=null) {
    const key=`${node}:${incoming?.edgeId||''}:${incoming?.reverse||false}`;
    if(!this.orbitReach.has(key))this.orbitReach.set(key,!!this.orbitRoute(node,incoming,{geometry:false}));
    return this.orbitReach.get(key);
  }
  canContinue(node,incoming) {
    const previous=incoming?this.oriented.get(`${incoming.edgeId}:${incoming.reverse}:${node}`):null;
    return(this.adj.get(node)||[]).some(step=>!previous||this.join(previous,step));
  }
  follow(step,incoming=null) {
    const previous=incoming?this.oriented.get(`${incoming.edgeId}:${incoming.reverse}:${step.from}`):null;
    const startFillet=previous?this.join(previous,step):null;if(previous&&!startFillet)return null;
    const road=trimPath(step.samples,startFillet?.trimM||0,0),samples=startFillet?.samples.length?[...startFillet.samples,...road.slice(1)]:road;
    return{lengthM:lengthOf(samples),samples,steps:[{edgeId:step.edge.id,reverse:step.reverse}],fillets:[],startFillet};
  }
  shortestPath(from,to,{geometry=true,incoming=null,outgoing=null}={}) {
    const incomingStep=incoming ? this.oriented.get(`${incoming.edgeId}:${incoming.reverse}:${from}`) : null;
    const treeKey=`${from}:${incoming?.edgeId||""}:${incoming?.reverse||false}`;
    const key=`${treeKey}:${to}:${geometry}:${outgoing?.edge.id||""}:${outgoing?.reverse||false}`;if(this.cache.has(key))return this.cache.get(key);
    if(!this.nodes.has(from)||!this.nodes.has(to))return null;
    if(from===to&&(!outgoing||!incomingStep||this.join(incomingStep,outgoing))){const n=this.nodes.get(from),band=this.data.clearance?tourClearanceAt(this.data.clearance,...n.posM):{floorY:0,ceilY:4700};return{lengthM:0,steps:[],fillets:[],samples:[[...n.posM,band.floorY,band.ceilY]]};}
    let tree=this.trees.get(treeKey);
    if(!tree){
    const heap=new Heap(),best=new Map(),previous=new Map(),found=new Map(),arrivals=new Map();heap.push({node:from,step:incomingStep,key:'start',cost:0});best.set('start',0);
    while(heap.values.length){const state=heap.pop();if(state.cost!==best.get(state.key))continue;if(!found.has(state.node))found.set(state.node,state);if(!arrivals.has(state.node))arrivals.set(state.node,[]);arrivals.get(state.node).push(state);
      for(const step of this.adj.get(state.node)){
        const fillet=state.step?this.join(state.step,step):{trimM:0,lengthM:0,samples:[]};if(!fillet)continue;
        const cost=state.cost+step.edge.lengthM+fillet.lengthM-2*fillet.trimM,nextKey=`${step.edge.id}:${step.reverse?1:0}`;
        if(cost>=(best.get(nextKey)??Infinity)-1e-8)continue;
        best.set(nextKey,cost);previous.set(nextKey,{state,fillet});heap.push({node:step.to,step,key:nextKey,cost});
      }
    }
    tree={found,previous,arrivals};this.trees.set(treeKey,tree);
    }
    const found=outgoing?(tree.arrivals.get(to)||[]).find(s=>!s.step||this.join(s.step,outgoing)):tree.found.get(to),previous=tree.previous;
    if(!found){this.cache.set(key,null);return null;}
    const steps=[],fillets=[];let state=found;
    let startFillet=null;
    while(state.key!=='start'){steps.push(state.step);const p=previous.get(state.key);if(p.state.key!=='start')fillets.push(p.fillet);else if(incomingStep)startFillet=p.fillet;state=p.state;}
    steps.reverse();fillets.reverse();const samples=startFillet?.samples.length ? [...startFillet.samples] : [];
    if(!geometry){const path={lengthM:found.cost,steps:steps.map(s=>({edgeId:s.edge.id,reverse:s.reverse})),samples:null};this.cache.set(key,path);return path;}
    for(let i=0;i<steps.length;i++){
      const segment=trimPath(steps[i].samples,i?fillets[i-1].trimM:(startFillet?.trimM||0),i<fillets.length?fillets[i].trimM:0);
      samples.push(...(samples.length?segment.slice(1):segment));if(i<fillets.length)samples.push(...fillets[i].samples.slice(1));
    }
    const path={lengthM:lengthOf(samples),steps:steps.map(s=>({edgeId:s.edge.id,reverse:s.reverse})),fillets,startFillet,samples};
    this.cache.set(key,path);return path;
  }
}
