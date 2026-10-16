import { SECTION_ROLES } from '../../src/world/terrain/SectionRoles.js';
export function tourFixture() {
 const count=SECTION_ROLES.length*7,radius=6000,nodes=[],points=[],edges=[],samples=[],fieldEdges=[],stations=[];
 for(let i=0;i<count;i++){
  const a=i/count*2*Math.PI,posM=[Math.sin(a)*radius,-Math.cos(a)*radius],role=SECTION_ROLES[Math.floor(i/7)];
  nodes.push({id:`n${i}`,posM,pointId:`p${i}`});
  const bestAim={headingDeg:270,pitchDeg:5,hfovDeg:55,score:1};
  points.push({id:`p${i}`,name:role==='drop'&&i%7===0?'Grand Teton':`point ${i}`,role,tier:i%7<4?'primary':'backup',localM:[posM[0],1000,posM[1]],grandeur:.5+(i%7)/14,
   station:{nodeId:`n${i}`,posM,yM:700,bestAim,passHeadingDeg:a*180/Math.PI+90}});
  samples.push({posM,floorY:100,ceilY:2000,tiers:[100,220,400,700,1100].map(yM=>({yM,score:new Uint8Array(72).fill(255),pitch:new Int8Array(36).fill(5),fovIdx:new Uint8Array(18).fill(85),subjectId:new Uint16Array(72).fill(65535)}))});
  stations.push({pointId:`p${i}`,sampleId:i});
 }
 for(let i=0;i<count;i++){
  const a=i/count*2*Math.PI,b=(i+1)/count*2*Math.PI;
  const road=[...Array(21)].map((_,j)=>{const t=a+(b-a)*j/20;return[Math.sin(t)*radius,-Math.cos(t)*radius,100,2000]});
  edges.push({id:`e${i}`,a:`n${i}`,b:`n${(i+1)%count}`,kind:'road',spine:true,lengthM:(b-a)*radius,samples:road});
  fieldEdges.push({edgeId:`e${i}`,sampleIds:[i,(i+1)%count],distancesM:[0,(b-a)*radius]});
 }
 return {id:'fixture',nodes,edges,points,roles:SECTION_ROLES,fallback:{chorus:['drop'],outro:['intro'],verse:['interlude']},field:{samples,edges:fieldEdges,stations,subjectStepDeg:5},tunables:{turnRadiusM:400,omegaMin:.03,omegaMax:.3,dwellMaxSec:22}};
}
