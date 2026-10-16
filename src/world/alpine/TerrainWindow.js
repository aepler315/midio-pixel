import {cameraBasis} from '../terrain/SceneTravel.js';
import {STRIDES} from './TerrainPackage.js';
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
/** The coarsest stored-error-safe grid over an eight-second route window. */
export function planTerrainWindow(data,tour,index,{budget='desktop',heightPx=1080,aspect=16/9,bias=1,pixelLimit=budget==='mobile'?2:1}={}){
  const startMs=index*8000,endMs=Math.min(tour.durationMs,startMs+8000),poses=[];
  for(let t=startMs;t<=endMs;t+=500){const pose=tour.poseAt(t);poses.push({...pose,basis:cameraBasis(pose)});}
  if(!poses.length){const p=tour.poseAt(startMs);poses.push({...p,basis:cameraBasis(p)});}
  const strides=new Map(),visible=new Set();let triangles=0,maxErrorPx=0;
  for(const tile of data.tiles.values()){
    const size=data.cells*data.grid.cellSizeM,x=data.grid.originM[0]+tile.ix*size,z=data.grid.originM[1]+tile.iz*size;
    const center=[x+size/2,(tile.minY+tile.maxY)/2,z+size/2],half=[size/2,(tile.maxY-tile.minY)/2,size/2];
    let pixelPerMetre=0;
    for(const p of poses){
      const relative=center.map((v,k)=>v-p.eyeM[k]),b=p.basis;
      const extent=v=>half.reduce((n,h,k)=>n+h*Math.abs(v[k]),0),depth=dot(relative,b.forward),depthRadius=extent(b.forward);
      if(depth+depthRadius<=1)continue;
      const tanV=Math.tan(p.fovYDeg*Math.PI/360)*1.2,tanH=tanV*aspect;
      if(Math.abs(dot(relative,b.right))>Math.max(0,depth)*tanH+extent(b.right)+depthRadius*tanH
        ||Math.abs(dot(relative,b.up))>Math.max(0,depth)*tanV+extent(b.up)+depthRadius*tanV)continue;
      visible.add(tile.id);
      const minimumDepth=Math.max(1,depth-depthRadius),focal=heightPx/(2*Math.tan(p.fovYDeg*Math.PI/360));
      pixelPerMetre=Math.max(pixelPerMetre,focal/minimumDepth);
    }
    let stride=data.cells;
    if(pixelPerMetre){stride=tile.stride;for(const s of STRIDES){if(s<tile.stride||s>data.cells)continue;const error=tile.errorsM?.[s];if(Number.isFinite(error)&&error*pixelPerMetre<=pixelLimit)stride=s;}}
    stride=Math.min(data.cells,Math.max(tile.stride,stride*bias));strides.set(tile.id,stride);
    triangles+=2*(data.cells/stride)**2;
    if(pixelPerMetre)maxErrorPx=Math.max(maxErrorPx,(tile.errorsM?.[stride]||0)*pixelPerMetre);
  }
  const cap=budget==='mobile'?1000000:1500000;
  if(bias===1&&triangles>cap){
    if(pixelLimit>=8)throw new Error(`Tour window ${index} exceeds triangle cap (${triangles})`);
    const reduced=planTerrainWindow(data,tour,index,{budget,heightPx,aspect,bias,pixelLimit:pixelLimit*2});
    return{...reduced,detailNote:`Triangle cap required ${reduced.pixelLimit}px detail (requested ${budget==='mobile'?2:1}px)`};
  }
  return{index,startMs,endMs,strides,visible,triangles,maxErrorPx,pixelLimit,coarse:bias>1};
}
/** Mesh ownership is bounded independently of asynchronous build completion. */
export class TourWindowCache{
  constructor({build,windowMs=8000}={}){this.build=build;this.windowMs=windowMs;this.resident=new Map();this.pending=new Map();this.generation=0;this.current=0;this.closed=false;}
  async request(index,{replace=false}={}){
    if(this.closed||index<0)return null;if(this.resident.has(index)&&!replace)return this.resident.get(index);if(this.pending.has(index))return this.pending.get(index);
    const generation=this.generation,job=Promise.resolve(this.build(index)).then(mesh=>{
      if(this.closed||generation!==this.generation||Math.abs(index-this.current)>1){mesh?.dispose?.();return null;}
      this.resident.get(index)?.dispose?.();this.resident.set(index,mesh);
      if(mesh?.adopt?.()===false){this.resident.delete(index);mesh.dispose?.();return null;}
      this.prune();return mesh;
    }).finally(()=>this.pending.delete(index));this.pending.set(index,job);return job;
  }
  async at(timeMs){this.current=Math.max(0,Math.floor(timeMs/this.windowMs));this.prune();return this.request(this.current);}
  prune(){for(const [index,mesh]of this.resident)if(Math.abs(index-this.current)>1){mesh?.dispose?.();this.resident.delete(index);}}
  dispose(){if(this.closed)return;this.closed=true;this.generation++;for(const mesh of this.resident.values())mesh?.dispose?.();this.resident.clear();}
}
