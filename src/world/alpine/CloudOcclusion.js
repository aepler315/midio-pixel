import { cameraBasis } from '../terrain/SceneTravel.js';
export const MAX_CLOUD_PUFFS = 64;
// Painted clouds are translucent puffs at a modeled 12 km depth. Their
// receiver rays differ: hiding the moon from the eye does not necessarily
// shade a lake below that eye. This is a lightweight billboard cloud layer,
// not a volumetric weather simulation.
const DEPTH_M = 12000;
const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
export function cloudPuffs(banks, { width, height, pose, light = null, allowPoint = null, alpha = 1, lensScale = 1 }) {
  if (!pose || !(width > 0 && height > 0)) return [];
  const {forward,right,up} = cameraBasis(pose);
  const mpp = 2 * DEPTH_M * Math.tan(pose.fovYDeg * Math.PI / 360) / height;
  const view = pose.view?.enabled ? pose.view : null;
  const scaleX = view ? view.width / view.fullWidth : 1, scaleY = view ? view.height / view.fullHeight : 1;
  const offsetX = view ? ((view.offsetX + view.width / 2) / view.fullWidth - .5) * width : 0;
  const offsetY = view ? ((view.offsetY + view.height / 2) / view.fullHeight - .5) * height : 0;
  const result = [];
  for (const b of banks) {
    const lx = light ? Math.sign(light.x - b.x) : 0, ly = light ? (light.y < b.y ? -1 : 1) : -1;
    for (let i=0;i<b.puffs && result.length<MAX_CLOUD_PUFFS;i++) {
      const t = b.puffs === 1 ? .5 : i/(b.puffs-1);
      const x = b.x-b.w/2+t*b.w, y = b.y+Math.sin(t*9+(b.phaseWidth ?? b.w))*b.h*.25;
      if (allowPoint && !allowPoint(x,y)) continue;
      const rx = b.h*(1.3+.9*Math.sin(t*Math.PI)), ry = b.h*(.55+.35*Math.sin(t*Math.PI));
      // Same dark-body offset and radial opacity as drawRangeClouds.
      const sx = (x-lx*rx*.06-width/2)/lensScale * scaleX + offsetX, sy = (y-ly*ry*.06-height/2)/lensScale * scaleY + offsetY;
      const centerM = pose.eyeM.map((v,k)=>v+forward[k]*DEPTH_M+right[k]*sx*mpp-up[k]*sy*mpp);
      result.push({centerM,radiusXM:rx*mpp/lensScale*scaleX,radiusYM:ry*mpp/lensScale*scaleY,opacity:Math.max(0,Math.min(1,b.alpha*alpha))});
    }
  }
  return result;
}
export function cloudTransmission(receiver, direction, puffs, basis) {
  const denominator = dot(direction,basis.forward);
  if (!(denominator > 1e-6)) return 1;
  let transmission = 1;
  for (const p of puffs) {
    const distance = dot(p.centerM.map((v,k)=>v-receiver[k]),basis.forward)/denominator;
    if (!(distance > 0)) continue;
    const delta = receiver.map((v,k)=>v+direction[k]*distance-p.centerM[k]);
    const radius = Math.hypot(dot(delta,basis.right)/p.radiusXM,dot(delta,basis.up)/p.radiusYM);
    transmission *= 1-p.opacity*Math.max(0,1-radius);
  }
  return transmission;
}
export function cloudUniforms(THREE) {
  return {uCloudCount:{value:0},uMoonClouds:{value:0},
    uCloudCenterRadius:{value:Array.from({length:MAX_CLOUD_PUFFS},()=>new THREE.Vector4())},
    uCloudShape:{value:Array.from({length:MAX_CLOUD_PUFFS / 2},()=>new THREE.Vector4())},
    uCloudRight:{value:new THREE.Vector3()},uCloudUp:{value:new THREE.Vector3()},uCloudForward:{value:new THREE.Vector3()}};
}
export const CLOUD_OCCLUSION_GLSL = /* glsl */`
  uniform int uCloudCount;
  uniform float uMoonClouds;
  uniform vec4 uCloudCenterRadius[${MAX_CLOUD_PUFFS}];
  // Two (vertical radius, opacity) pairs per vector; retain all 64 puffs.
  uniform vec4 uCloudShape[${MAX_CLOUD_PUFFS / 2}];
  uniform vec3 uCloudRight, uCloudUp, uCloudForward;
  float moonCloudTransmission(vec3 receiver, vec3 direction) {
    float denominator=dot(direction,uCloudForward);
    if(uMoonClouds<.5 || denominator<=.000001)return 1.0;
    float transmission=1.0;
    for(int i=0;i<${MAX_CLOUD_PUFFS};i++) {
      if(i>=uCloudCount)break;
      vec4 puff=uCloudCenterRadius[i];
      vec4 pair=uCloudShape[i / 2];
      vec2 shape=(i % 2 == 0) ? pair.xy : pair.zw;
      float distanceM=dot(puff.xyz-receiver,uCloudForward)/denominator;
      if(distanceM<=0.0)continue;
      vec3 d=receiver+direction*distanceM-puff.xyz;
      float radius=length(vec2(dot(d,uCloudRight)/puff.w,dot(d,uCloudUp)/shape.x));
      transmission*=1.0-shape.y*max(0.0,1.0-radius);
    }
    return transmission;
  }
`;
