let shareSerial = 0;
/** Source lanes may share a backing; charge each backing once. */
export function terrainLaneBytes(data, { unsharedOnly = false } = {}) {
 const buffers = new Set();
 for (const tile of data.tiles.values()) for (const key of ['heightsM', 'flowBytes', 'validMask']) {
  const a = tile[key];
  if (a && !(unsharedOnly && typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer)) buffers.add(a.buffer);
 }
 return [...buffers].reduce((sum, b) => sum + b.byteLength, 0);
}
/** Reserve the old/new lane overlap before the first SAB allocation. The
 * decoded owner keeps the surviving lane charge; this is conversion only. */
export async function shareTerrainLanes(data, { residency = null, protect = [], signal = null, isCurrent = () => true } = {}) {
 if (typeof SharedArrayBuffer === 'undefined') return false;
 const checkOwner = () => {
  if (signal?.aborted || !isCurrent()) throw new DOMException('Terrain lane conversion cancelled after owner retirement', 'AbortError');
 };
 checkOwner();
 const bytes = terrainLaneBytes(data, { unsharedOnly: true });
 const reservation = residency?.reserve({ key: `range:share-lanes:${++shareSerial}`, bytes,
  owner: 'range-lane-conversion', generation: 0, evictable: false, protect });
 if (residency && !reservation) throw Object.assign(new Error('No budget room to share terrain lanes'), { reason: 'budget' });
 try {
  let count = 0;
  const sharedBackings = new Map();
  for (const tile of data.tiles.values()) {
   checkOwner();
   for (const key of ['heightsM', 'flowBytes', 'validMask']) {
    const a = tile[key]; if (!a || a.buffer instanceof SharedArrayBuffer) continue;
    let backing = sharedBackings.get(a.buffer);
    if (!backing) {
      backing = new SharedArrayBuffer(a.buffer.byteLength);
      new Uint8Array(backing).set(new Uint8Array(a.buffer));
      sharedBackings.set(a.buffer, backing);
    }
    tile[key] = new a.constructor(backing, a.byteOffset, a.length);
   }
   if (++count % 32 === 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
    checkOwner();
   }
  }
  return true;
 } finally { residency?.releaseReservation(reservation); }
}
export class TerrainWindowWorker{
 constructor({data,tour,view,rules,seed=0}){
  this.worker=new Worker(new URL('./terrainWindowWorker.js',import.meta.url),{type:'module'});this.jobs=new Map();this.serial=0;this.closed=false;
  this.worker.onmessage=e=>{const job=this.jobs.get(e.data.id);if(!job)return;this.jobs.delete(e.data.id);if(e.data.error)job.reject(new Error(e.data.error));else job.resolve(e.data);};
  this.worker.onerror=e=>{this.dispose(new Error(e.message));};
  const frames={durationMs:tour.durationMs,eye:tour.eye,target:tour.target,fov:tour.fov,meta:tour.meta,previewPose:tour.durationMs?null:tour.poseAt(0)};
  const plainView={...view};delete plainView.tour;
  try { this.worker.postMessage({kind:'init',data,tour:frames,view:plainView,rules,seed}); }
  catch (error) { this.dispose(error); throw error; }
 }
 setTour(tour){this.worker.postMessage({kind:'tour',tour:{durationMs:tour.durationMs,eye:tour.eye,target:tour.target,fov:tour.fov,meta:tour.meta}});}
 build(index,options){
  if(this.closed)return Promise.reject(new DOMException('Window worker closed','AbortError'));
  const id=++this.serial;
  return new Promise((resolve,reject)=>{
   this.jobs.set(id,{resolve,reject});
   try { this.worker.postMessage({id,index,options}); }
   catch(error){this.jobs.delete(id);reject(error);}
  });
 }
 dispose(error = new DOMException('Window generation cancelled','AbortError')){
  if(this.closed)return;this.closed=true;this.worker.terminate();
  for(const job of this.jobs.values())job.reject(error);this.jobs.clear();
 }
}
