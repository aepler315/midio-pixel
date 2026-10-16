import{planTerrainWindow}from'./TerrainWindow.js';import{buildTerrainGeometry}from'./TerrainMesh.js';import{placeForest}from'./ForestCover.js';import{restoreTourTimeline}from'../terrain/TourTimeline.js';
let data,tour,view,rules,seed;
self.onmessage=e=>{
 const msg=e.data;
 if(msg.kind==='tour'){tour=restoreTourTimeline(msg.tour);return;}
 if(msg.kind==='init'){({data,view,rules,seed}=msg);tour=restoreTourTimeline(msg.tour);return;}
 try{
  const plan=planTerrainWindow(data,tour,msg.index,msg.options),built=buildTerrainGeometry(data,{strides:plan.strides,budget:msg.options.budget});
  const placed=placeForest(data,{...view,tour,tourWindowStartMs:msg.index*8000},rules,{seed});
  const transfer=[];for(const b of Object.values(built.bands))for(const a of [b.positions,b.indices,b.fringe])if(a)transfer.push(a.buffer);
  transfer.push(placed.meshDetail.buffer,placed.mesh.buffer,placed.billboard.buffer);
  self.postMessage({id:msg.id,plan:{...plan,strides:[...plan.strides],visible:[...plan.visible]},built,placed},transfer);
 }catch(error){self.postMessage({id:msg.id,error:error.message});}
};
