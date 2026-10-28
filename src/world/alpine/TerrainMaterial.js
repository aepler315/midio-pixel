import { cloudUniforms, CLOUD_OCCLUSION_GLSL } from './CloudOcclusion.js';
import { CINEMATIC_LIGHTING_GLSL } from './CinematicLighting.js';
import { hexToLinear, RULE_DEFAULTS, validateWaterRules } from './MaterialPackage.js';
import { GUST_FRONTS, GUST_IDLE_SEC, GUST_SWEEP_SEC } from './Gust.js';
import { RangeAssetError } from './RangeAssets.js';
import { MIRROR_LIFT } from './WaterMirror.js';
import { ACTOR_GLSL, WAKE_GLSL, actorUniforms } from './ActorsGL.js';
import { STORM_GLSL } from './RangeStorm.js';
import { MATERIAL_DETAIL_DOMAIN_GLSL } from './MaterialDetailDomain.js';
import { moranTerrainFragment } from './TerrainShadingExperiment.js';
export { materialDetailPosition } from './MaterialDetailDomain.js';
// Range v2 production terrain material (GLSL3 via the local Three.js
// bundle). Task 8 ships the neutral-material pilot: real geometry, the
// surface texture's full-grid normals, the frame's resolved celestial light
// and sky ambient, the shared musical deformation, and one aerial
// perspective applied exactly once. Material packs (Task 9) extend the
// albedo/detail terms here rather than drawing a second terrain.

// GLSL twin of RangeFrame.sceneDeformation -- keep the two in step.
import { MIST_GLSL, MIST_SAMPLES } from './RangeAtmosphere.js';
import { DEFORM_GLSL, GROUND_LIFT_GLSL } from './TerrainDeform.js';
import { FOREST_HASH_GLSL, FOREST_TRAITS_GLSL } from './ForestCover.js';
import { CROWN_GLSL } from './ForestProfile.js';
import { HORIZON_GLSL } from './TerrainOcclusion.js';
import { TERRAIN_LIGHTING_GLSL } from './TerrainLighting.js';

/** Poisson cover of vertical crowns; vectors are unit world directions. */
export function expectedForestCover({ forest, radius, crownHeight, normal, toEye }) {
  const elevation = Math.asin(Math.max(0, Math.min(1, toEye[1])));
  const silhouette = Math.PI * radius * radius * Math.sin(elevation) + radius * crownHeight * Math.cos(elevation);
  const incidence = Math.abs(normal.reduce((sum, x, i) => sum + x * toEye[i], 0));
  return 1 - Math.exp(-Math.max(0, forest) / 169 * Math.max(0, normal[1]) * silhouette / Math.max(incidence, .05));
}

export function meanForestTraits({ below, slopeDeg, scale = RULE_DEFAULTS.treeScale, cap = Infinity }) {
  const vigor = Math.min(1, Math.max(.35, below / 400)) * (1 - .3 * Math.max(0, slopeDeg - 25) / 25);
  const weights = below > 900 ? [.5, .2, 0, .3] : below > 300 ? [.2, .45, .35, 0] : [0, .3, .7, 0];
  const sizes = [[14, 26, .28, .49], [18, 32, .36, .08], [12, 24, .25, .015], [18, 30, .40, .08]];
  const clippedMean = (a, b) => b <= cap ? (a + b) / 2 : a >= cap ? cap : ((cap * cap - a * a) / 2 + cap * (b - cap)) / (b - a);
  let height = 0, radius = 0, crownHeight = 0;
  sizes.forEach(([lo, hi, ratio, base], i) => {
    const h = vigor < .55 ? clippedMean(2 * scale, 6 * scale) : clippedMean(lo * vigor * scale, hi * vigor * scale);
    height += weights[i] * h;
    radius += weights[i] * h * (vigor < .55 ? .85 : ratio) * .5;
    crownHeight += weights[i] * h * (1 - base);
  });
  return { height, radius, crownHeight };
}

export const FAR_FOREST_GLSL = /* glsl */`
  float clippedTreeMean(float a, float b, float cap) {
    return b <= cap ? .5 * (a + b) : a >= cap ? cap : (.5 * (cap * cap - a * a) + cap * (b - cap)) / (b - a);
  }
  vec2 meanForestCrown(float below, float slope, float scale, float cap) {
    float vigor = min(1.0, max(.35, below / 400.0)) * (1.0 - .3 * max(0.0, slope - 25.0) / 25.0);
    vec4 weights = below > 900.0 ? vec4(.5,.2,0.,.3) : below > 300.0 ? vec4(.2,.45,.35,0.) : vec4(0.,.3,.7,0.);
    vec4 heights = vec4(clippedTreeMean(14. * vigor * scale, 26. * vigor * scale, cap),
      clippedTreeMean(18. * vigor * scale, 32. * vigor * scale, cap),
      clippedTreeMean(12. * vigor * scale, 24. * vigor * scale, cap),
      clippedTreeMean(18. * vigor * scale, 30. * vigor * scale, cap));
    vec4 ratio = vec4(.28,.36,.25,.40);
    if (vigor < .55) { heights = vec4(clippedTreeMean(2. * scale, 6. * scale, cap)); ratio = vec4(.85); }
    return vec2(.5 * dot(weights * heights, ratio), dot(weights * heights, vec4(.51,.92,.985,.92)));
  }
  float expectedForestCover(float forest, vec2 crown, vec3 n, vec3 w) {
    float e = asin(clamp(w.y, 0.0, 1.0));
    float S = 3.14159265 * crown.x * crown.x * sin(e) + crown.x * crown.y * cos(e);
    return 1.0 - exp(-forest / 169.0 * max(n.y, 0.0) * S / max(abs(dot(w,n)), .05));
  }
  float farForestMix(float dist, vec2 ring) {
    return ring.y > ring.x ? smoothstep(ring.x, ring.y, dist) : 1.0;
  }
  vec3 forestUnderstory(vec3 crown, vec3 ground) {
    return crown * (.45 + .1 * clamp(ground, vec3(0.0), vec3(1.0)));
  }
`;

const forestSmooth = (a,b,x) => { const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t); };
/** Pixel widths in crown coordinates and the full primary-axis walk extent. */
export function farDotFootprint({toEye,normal,dx,dy,heightCap=32,treeScale=1}) {
  const horizontal=Math.hypot(toEye[0],toEye[2]);
  if(horizontal<.00001)return {footprint:Infinity,heightFoot:Infinity,reach:Infinity,halfAlong:0};
  const direction=[toEye[0]/horizontal,toEye[2]/horizontal],right=[direction[1],-direction[0]];
  const projected=v=>Math.abs(dx[0]*v[0]+dx[1]*v[1])+Math.abs(dy[0]*v[0]+dy[1]*v[1]);
  const along=projected(direction),rise=toEye[1]/horizontal+(normal[0]*direction[0]+normal[2]*direction[1])/Math.max(normal[1],.05);
  const major=Math.max(...direction.map(Math.abs)),minor=Math.min(...direction.map(Math.abs));
  const bound=Math.min(heightCap,32*treeScale),sideHalf=Math.max(.5*projected(right),.001);
  const radius=.5*1.045*Math.max(bound*.44,Math.min(bound,6*treeScale));
  const sideCells=Math.ceil(((radius+sideHalf+.05+4.55*minor)/major-1.95)/13);
  return {footprint:projected(right),heightFoot:along*Math.max(rise,0),
    reach:sideCells>3?Infinity:(bound/Math.max(rise,.00001)+along)*major+2*(radius+sideHalf)*minor,halfAlong:along*.5};
}
/** Reference for projected frequency, bounded reach, quality and handoff. */
export function farDotWeight({ distance, footprint, heightFoot=0, heightCap=32, reach, kmax, quality, ring }) {
  if(quality>=3)return 0;
  return (1-forestSmooth(3.25,7.8,footprint))*(1-forestSmooth(.35*heightCap,.8*heightCap,heightFoot))
    *(1-forestSmooth((kmax-1.5)*13,(kmax-1)*13,reach))*(1-forestSmooth(13000,15000,distance))
    *(ring[1]>ring[0]?forestSmooth(ring[0],ring[1],distance):forestSmooth(1000,1500,distance));
}
export function farTreeProjection({ point,root,height,toEye,normal }) {
  const horizontal=Math.hypot(toEye[0],toEye[2]), dx=toEye[0]/horizontal,dz=toEye[2]/horizontal;
  const along=(root[0]-point[0])*dx+(root[2]-point[2])*dz;
  const rise=toEye[1]/horizontal+(normal[0]*dx+normal[2]*dz)/normal[1];
  return {along,side:-(root[0]-point[0])*dz+(root[2]-point[2])*dx,
    height:rise*along,reach:height/Math.max(rise,.00001)};
}

export const FAR_TREE_DOTS_GLSL = /* glsl */`
  #ifndef FAR_FOREST_KMAX
    #define FAR_FOREST_KMAX 8
  #endif
  ${FOREST_HASH_GLSL}
  ${FOREST_TRAITS_GLSL}
  ${CROWN_GLSL}
  // Exact marginal of the projected screen-pixel box: uniform when one
  // derivative vanishes, trapezoidal/triangular when both contribute.
  float farFootprintCDF(float x,float a,float b) {
    float large=max(a,b),small=min(a,b),extent=large+small;
    if(extent<.000001)return step(0.,x);
    if(x<=-extent)return 0.;if(x>=extent)return 1.;
    if(small<.000001)return clamp(.5+x/(2.*large),0.,1.);
    float shoulder=large-small;
    if(x < -shoulder)return (x+extent)*(x+extent)/(8.*a*b);
    if(x > shoulder)return 1.-(extent-x)*(extent-x)/(8.*a*b);
    return .5+x/(2.*large);
  }
  float farCrownRadius(float bound) {
    // Full authored width: capped low-vigor stems can be wider than mature trees.
    return .5*1.045*max(bound*.44,min(bound,6.*uFarForest.z));
  }
  float farSideCells(vec2 direction,float sideFoot,float radius) {
    float major=max(abs(direction.x),abs(direction.y)),minor=min(abs(direction.x),abs(direction.y));
    return max(1.,ceil(((radius+sideFoot+.05+4.55*minor)/max(major,.00001)-1.95)/13.));
  }
  vec4 farDotFootprint(vec3 w,vec3 n,float cap,vec2 dx,vec2 dy) {
    float horizontal=length(w.xz);vec2 direction=w.xz/max(horizontal,.00001),right=vec2(direction.y,-direction.x);
    float rise=w.y/max(horizontal,.00001)+dot(n.xz,direction)/max(n.y,.05);
    float along=abs(dot(dx,direction))+abs(dot(dy,direction));
    float side=abs(dot(dx,right))+abs(dot(dy,right));
    float bound=min(cap,32.*uFarForest.z),major=max(abs(direction.x),abs(direction.y)),minor=min(abs(direction.x),abs(direction.y));
    float reach=(bound/max(rise,.00001)+along)*major+2.*(farCrownRadius(bound)+max(.5*side,.001))*minor;
    if(farSideCells(direction,.5*side,farCrownRadius(bound))>3.)reach=1e9;
    return vec4(side,along*max(rise,0.),reach,rise);
  }
  float farDotWeight(float dist,vec4 footprint,float bound) {
    if(mod(uFarForest.w,8.)>=3. || footprint.w<=0.)return 0.;
    float handoff=uFarForest.y>uFarForest.x?smoothstep(uFarForest.x,uFarForest.y,dist):smoothstep(1000.,1500.,dist);
    return handoff*(1.-smoothstep(3.25,7.8,footprint.x))
      *(1.-smoothstep(.35*bound,.8*bound,footprint.y))*(1.-smoothstep(13000.,15000.,dist))
      *(1.-smoothstep((float(FAR_FOREST_KMAX)-1.5)*13.,(float(FAR_FOREST_KMAX)-1.)*13.,footprint.z));
  }
  // The first slab may be almost empty: reserve it before counting full cells.
  // Expand sideways for the pixel and crown; rectangle culling precedes hashing.
  // Root heights use the local tangent plane; ridge silhouettes remain terrain-only.
  vec4 farTreeDots(vec3 P,vec3 w,vec3 n,vec3 sourceNormal,float slope,float cap,
    vec2 dx,vec2 dy,vec3 palette,out vec3 crownNormal) {
    crownNormal=vec3(0.,1.,0.);
    float horizontal=length(w.xz);
    if(horizontal<.00001)return vec4(0.);
    vec2 direction=w.xz/horizontal, right=vec2(direction.y,-direction.x);
    vec2 grad=-n.xz/max(n.y,.05), sourceGrad=-sourceNormal.xz/max(sourceNormal.y,.05);
    float rise=w.y/horizontal-dot(grad,direction);
    float bound=min(cap,32.*uFarForest.z), reach=bound/max(rise,.00001);
    vec4 footprint=farDotFootprint(w,n,cap,dx,dy);
    float weight=farDotWeight(length(cameraPosition-vRenderedWorld),footprint,bound);
    if(weight<=0. || horizontal<.00001)return vec4(0.);
    bool majorX=abs(direction.x)>=abs(direction.y);
    float major=majorX?direction.x:direction.y, origin=majorX?P.x:P.z;
    float alongFoot=abs(dot(dx,direction))+abs(dot(dy,direction)),halfAlong=.5*alongFoot;
    // Lateral crown/pixel span also projects onto the primary lattice axis.
    // Include it at both ends (footprint.z), including the near-edge prefix.
    float crossAlong=(farCrownRadius(bound)+max(.5*footprint.x,.001))
      *min(abs(direction.x),abs(direction.y))/max(abs(major),.00001);
    vec2 start=P.xz-direction*(halfAlong+crossAlong);
    int first=int(floor((majorX?start.x:start.y)/13.)), stepCell=major>=0.?1:-1;
    int K=int(clamp(ceil(footprint.z/13.)+1.,1.,float(FAR_FOREST_KMAX)));
    float sideFoot=max(.5*footprint.x,.001),heightFoot=max(.5*footprint.y,.001);
    vec2 sideBox=.5*vec2(abs(dot(dx,right)),abs(dot(dy,right)));
    vec2 heightBox=.5*rise*vec2(abs(dot(dx,direction)),abs(dot(dy,direction)));
    float rootExtent=4.55*(abs(direction.x)+abs(direction.y));
    float radius=farCrownRadius(bound);int sideCells=int(farSideCells(direction,sideFoot,radius));
    vec3 colour=vec3(0.), normals=vec3(0.);float covered=0.;
    for(int j=0;j<FAR_FOREST_KMAX;j++) {
      if(j>=K)break;
      int primary=first+j*stepCell;
      float travel=((float(primary)+.5)*13.-origin)/major;
      vec2 centre=P.xz+direction*travel;
      int secondary=int(floor((majorX?centre.y:centre.x)/13.));
      for(int sideCell=-3;sideCell<=3;sideCell++) {
        if(abs(sideCell)>sideCells)continue;
        ivec2 cell=majorX?ivec2(primary,secondary+sideCell):ivec2(secondary+sideCell,primary);
        vec2 candidate=(vec2(cell)+.5)*13.-P.xz;
        float candidateAlong=dot(candidate,direction);
        if(abs(dot(candidate,right))-rootExtent>radius+sideFoot+.05
          || candidateAlong+rootExtent < -halfAlong || candidateAlong-rootExtent > reach+halfAlong)continue;
        uint accept=hash2u(cell.x,cell.y,uForestSeed);
        if(forestU01(accept)>rForestDensity)continue;
        // Jitter must precede the root's height and vigor calculation.
        vec2 root=(vec2(cell)+.15+.7*vec2(forestU01(hash2u(cell.x,cell.y,uForestSeed+1u)),
          forestU01(hash2u(cell.x,cell.y,uForestSeed+2u))))*13.;
        vec2 delta=root-P.xz;float y=vWorld.y+dot(sourceGrad,delta);
        ivec2 stand=ivec2(floor(root/90.));
        float edge=rTreeline+(forestU01(hash2u(stand.x,stand.y,uForestSeed+9u))-.5)*220.;
        float floorY=rForestFloor+(forestU01(hash2u(stand.x,stand.y,uForestSeed+10u))-.5)*200.;
        if(y>edge || y<floorY || slope>rForestMaxSlope+(forestU01(hash2u(cell.x,cell.y,uForestSeed+3u))-.5)*6.)continue;
        vec2 uv=(root-uGridOrigin)/uGridExtent*(1.-uTexel)+.5*uTexel;
        // Match placement's conservative shore rule rather than interpolating
        // wet and dry bytes into an accepted root. Surface resolution is retained.
        ivec2 dimensions=textureSize(uSurface,0), corner=ivec2(floor(uv*vec2(dimensions)-.5));
        float wet=0.;
        for(int zi=0;zi<2;zi++)for(int xi=0;xi<2;xi++)
          wet=max(wet,texelFetch(uSurface,clamp(corner+ivec2(xi,zi),ivec2(0),dimensions-1),0).a);
        if(wet>254.5/255.)continue;
        ForestTraits t=forestTreeTraits(cell,uForestSeed,y,slope,rTreeline,uFarForest.z,cap);
        float along=dot(delta,direction), height=rise*along, v=height/max(t.height,.001);
        float x=-dot(delta,right),dv=2.*heightFoot/max(t.height,.001),scale=t.width/crownRatio(t.species);
        float lo=max(0.,height-heightFoot),hi=min(t.height,height+heightFoot);
        if(hi<=lo)continue;
        float cov=0.,heightMoment=0.;vec2 widths=vec2(0.);
        // Integrate the intersected crown, including pixels centred outside
        // its tip/base. Each bin has exact projected-box mass in height.
        for(int sampleIndex=0;sampleIndex<3;sampleIndex++) {
          float h0=mix(lo,hi,float(sampleIndex)/3.),h1=mix(lo,hi,float(sampleIndex+1)/3.);
          float sampleV=.5*(h0+h1)/max(t.height,.001);
          float left=crownHalfWidthFiltered(t.species,sampleV,t.id,-1.,dv)*scale;
          float rightEdge=crownHalfWidthFiltered(t.species,sampleV,t.id,1.,dv)*scale;
          float bole=min(.008,.18/max(t.width,.001))*t.width
            *(1.-smoothstep(crownBase(t.species,t.id),crownBase(t.species,t.id)+.035,sampleV));
          left=max(left,bole);rightEdge=max(rightEdge,bole);
          float mass=farFootprintCDF(h1-height,heightBox.x,heightBox.y)-farFootprintCDF(h0-height,heightBox.x,heightBox.y);
          float sampleCov=(farFootprintCDF(rightEdge-x,sideBox.x,sideBox.y)-farFootprintCDF(-left-x,sideBox.x,sideBox.y))*mass;
          cov+=sampleCov;heightMoment+=sampleCov*sampleV;widths+=sampleCov*vec2(left,rightEdge);
        }
        cov=clamp(cov,0.,1.);if(cov<=0.)continue;
        v=heightMoment/cov;widths/=cov;
        float left=widths.x,rightEdge=widths.y,flank=clamp(x/max(x<0.?left:rightEdge,.001),-1.,1.);
        float resolved=smoothstep(4.,8.,(left+rightEdge)/sideFoot);
        float core=mix(.5,1.-abs(flank),resolved);flank*=resolved;
        vec3 toward=vec3(direction.x,0.,direction.y), lateral=vec3(right.x,0.,right.y);
        vec3 normal=normalize(toward*.6*sqrt(max(0.,1.-flank*flank))+lateral*.6*flank+vec3(0.,.5,0.));
        vec3 tint=t.species<.5?vec3(1.04,1.02,.94):t.species<1.5?vec3(.95,1.01,1.06)
          :t.species<2.5?vec3(.94,.94,.98):vec3(.98,1.01,.96);
        vec3 tree=palette*(.8+.4*fract(t.species*.37+t.id*3.1))*tint
          *mix(.65,1.,smoothstep(.1,.85,v))*mix(1.,.78,core)*(1.+.12*smoothstep(.55,.95,v));
        colour=colour*(1.-cov)+tree*cov;normals=normals*(1.-cov)+normal*cov;
        covered=1.-(1.-covered)*(1.-cov);
      }
    }
    if(covered>0.){colour/=covered;crownNormal=normalize(normals);}
    return vec4(colour,covered);
  }
`;

// The shared musical deformation lives in TerrainDeform.js so the cast
// (ActorsGL, which this module imports) can ride it too.
export { DEFORM_GLSL };

export const SCENE_VERT = /* glsl */`
  invariant gl_Position;
  ${DEFORM_GLSL}
  out vec2 vUv;
  out vec3 vWorld;
  out vec3 vRenderedWorld;
  out float vViewDepth;
  #ifdef RIVER_SURFACE
  in vec3 river;
  in vec2 riverDirection;
  in vec3 terrainA;
  in vec3 terrainB;
  in vec3 terrainC;
  out vec3 vRiver;
  out vec2 vRiverDirection;
  vec3 riverTerrainWeights(vec2 p) {
    vec2 ab = terrainB.xz - terrainA.xz, ac = terrainC.xz - terrainA.xz;
    vec2 q = p - terrainA.xz;
    float area = ab.x * ac.y - ab.y * ac.x;
    float b = (q.x * ac.y - q.y * ac.x) / area;
    float c = (ab.x * q.y - ab.y * q.x) / area;
    return vec3(1.0 - b - c, b, c);
  }
  float riverTerrainShift(vec3 p) {
    vec3 ice = glacierAt(p);
    return ice.x + deformAt(p) * (1.0 - ice.y);
  }
  #endif
  void main() {
    vec3 p = position;
    vec3 ice = glacierAt(position);
    #ifdef RIVER_SURFACE
    // The drawn ground interpolates deformation of its original triangle
    // vertices. Evaluating the field again at clipped interior vertices
    // would let the creek sink below that plane during a musical swell.
    p.y += dot(riverTerrainWeights(position.xz), vec3(riverTerrainShift(terrainA),
      riverTerrainShift(terrainB), riverTerrainShift(terrainC)));
    #else
    p.y += ice.x + deformAt(position) * (1.0 - ice.y);
    #endif
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = vec3(world.x, position.y, world.z); // source height for masks
    vRenderedWorld = world.xyz;
    vUv = (position.xz - uGridOrigin) / uGridExtent;
    vec4 view = viewMatrix * world;
    vViewDepth = -view.z;
    #ifdef RIVER_SURFACE
    vRiver = river;
    vRiverDirection = riverDirection;
    #endif
    gl_Position = projectionMatrix * view;
  }
`;

/** Share of the diffuse key a slope keeps below its baked horizon (air
 *  scatter and bounce from lit relief, which the bake does not model). The
 *  specular lobe gets none: no glints in shadow. */
export const SHADOW_RESIDUAL = 0.5;

/** Reflectance at normal incidence the lake keeps (artistic; physical water
 *  is ~0.02). Restrained but shore-holding from a high camera; was 0.3. A
 *  compile-time constant: the terrain shader is at the mobile uniform budget. */
export const WATER_REFLECT_FLOOR = 0.2;
const WATER_MUSIC_ACCENTS = 4;

export const SCENE_FRAG = /* glsl */`
  ${CLOUD_OCCLUSION_GLSL}
  precision highp float;
  uniform sampler2D uSurface;
  ${DEFORM_GLSL}
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uSkyZenith;
  uniform vec3 uSkyHorizon;
  uniform vec3 uAirColor;
  uniform float uAirDensity;
  uniform float uAirHeightFalloff;
  uniform vec3 uCameraPos;
  uniform float uDiag;
  uniform vec4 uStorm; // squall, cloud lightning, clearing, wet receivers
  uniform float uAmbientScale;
  uniform float uMoonAmbientScale;
  uniform int uDebugMask;
  uniform float uExposure;
  uniform vec4 uNarrative; // relief, atmospheric depth, materials, feature materials
  uniform float uNarrativeInk;
  // Material pack (MaterialPackage.js): data textures and scales.
  uniform sampler2D tRock;      uniform float sRock;
  uniform sampler2D tRockNear;  uniform float sRockNear;
  uniform sampler2D tCanopy;    uniform float sCanopy;
  uniform sampler2D tSnow;      uniform float sSnow;
  uniform sampler2D tSoil;      uniform float sSoil;
  uniform float uHasMaterial;
  // Palette (linear) and rules.
  uniform vec3 pRockLit; uniform vec3 pRockShade; uniform vec3 pRockWarm; uniform vec3 pSoil; uniform vec3 pMeadow;
  uniform vec3 pForestNear; uniform vec3 pForestFar; uniform vec3 pMoss; uniform vec3 pSnow; uniform vec3 pSnowShade;
  uniform vec3 pWater; uniform vec3 pWaterDeep; uniform vec3 pLichen;
  uniform float rSnowline; uniform float rSnowFull; uniform float rSnowMaxSlope; uniform float rTreeline;
  uniform float rForestMaxSlope; uniform float rForestDensity; uniform float rMoss; uniform float rStrata;
  uniform float rForestFloor;
  uniform vec4 uFarForest; // handoff start/end, tree scale, rung + 8 for tour cap
  uniform uint uForestSeed;
  uniform float rWaterSkyMix; uniform float rWaterGlintGain;
  uniform float uTime;
  // Lake mirror (WaterMirror.js): the ground seen from the camera reflected
  // about the water level, projected by uMirrorMatrix; uMirrorAmount 0 when
  // there is none. While that image is drawn, ground below uClipBelow is cut.
  uniform sampler2D uMirror;
  uniform mat4 uMirrorMatrix;
  uniform float uMirrorAmount;
  uniform float uMirrorLevel;
  uniform float uMirrorRipple;
  uniform float uClipBelow;
  // An optional full-resolution pass draws only water from the same geometry.
  uniform float uWaterOnly;
  uniform vec2 uViewportPx;
  // The 2D backdrop (sky, aurora, distant ranges) as the stage shows it,
  // and the camera's view-projection to find where a reflected ray meets it.
  uniform sampler2D uBackdrop;
  uniform float uBackdropAmount;
  uniform mat4 uViewProj;
  // Gust fronts (the forest's): on the water they are cat's paws, rough
  // patches that cross the frame with each front and break the mirror.
  // Water reads the same six gusts as the forest, packed per front.
  uniform vec3 uWaterGust[${GUST_FRONTS}];
  // Low pressure, kick, high percussion/melody and phrase lift. The four
  // accent slots hold heard-time age, strength, stable seed and voice.
  uniform vec4 uWaterMusic;
  uniform vec4 uWaterAccent[${WATER_MUSIC_ACCENTS}];
  // Valley mist and cloud sea first: the lanterns' light reads its top, at
  // the lifted ground the lanterns are drawn on.
  ${MIST_GLSL}
  ${GROUND_LIFT_GLSL}
  // The cast's lanterns (ActorsGL.js): their light, glints and Midio's wake.
  ${ACTOR_GLSL}
  ${WAKE_GLSL}
  in vec2 vUv;
  in vec3 vWorld;
  in vec3 vRenderedWorld;
  in float vViewDepth;
  #ifdef RIVER_SURFACE
  in vec3 vRiver;
  in vec2 vRiverDirection;
  #endif
  out vec4 outColor;
  vec3 linearToSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
  // Filmic shoulder (Narkowicz ACES fit): snow and moonlit rock compress
  // instead of clipping; the dark blue-hour body keeps its separation.
  vec3 tonemap(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  ${STORM_GLSL}
  ${FAR_FOREST_GLSL}
  ${FAR_TREE_DOTS_GLSL}
  ${HORIZON_GLSL}
  ${TERRAIN_LIGHTING_GLSL}
  ${CINEMATIC_LIGHTING_GLSL}
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  // Smooth value noise: a per-cell hash alone steps at every cell edge,
  // which a threshold (snow line, tree line) turns into a visible grid.
  float vnoise12(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  ${MATERIAL_DETAIL_DOMAIN_GLSL}
  // Triplanar sample of a data texture (RG normal, B, A height) around the
  // geometric normal; returns the world-space normal offset in .xyz via
  // whiteout blending and the blended B/A in .ba of the second output.
  struct Tri { vec3 dn; float b; float h; };
  // rib < 1 stretches side projections vertically: cliff faces get
  // fluting and gully ribs rather than isotropic blotches.
  Tri triplanarRib(sampler2D t, vec3 p, vec3 n, float scale, float rot, float rib) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= (w.x + w.y + w.z);
    float c = cos(rot), s = sin(rot);
    mat2 R = mat2(c, -s, s, c);
    vec4 tx = texture(t, R * (vec2(p.z, p.y * rib) / scale));
    vec4 ty = texture(t, R * (p.xz / scale));
    vec4 tz = texture(t, R * (vec2(p.x, p.y * rib) / scale));
    vec2 nx = tx.rg * 2.0 - 1.0, ny = ty.rg * 2.0 - 1.0, nz = tz.rg * 2.0 - 1.0;
    // Tangent offsets swizzled into world axes per projection.
    vec3 dn = w.x * vec3(0.0, nx.y, nx.x) + w.y * vec3(ny.x, 0.0, ny.y) + w.z * vec3(nz.x, nz.y, 0.0);
    Tri r;
    r.dn = dn;
    r.b = w.x * tx.b + w.y * ty.b + w.z * tz.b;
    r.h = w.x * tx.a + w.y * ty.a + w.z * tz.a;
    return r;
  }
  Tri triplanar(sampler2D t, vec3 p, vec3 n, float scale, float rot) { return triplanarRib(t, p, n, scale, rot, 1.0); }
  #ifdef PIXEL_MATERIAL_SKIP
  // Evaluate the same projected UVs and their gradients in every lane
  // before skipping invisible detail. Implicit derivatives inside that
  // divergent branch would change mip/aniso filtering along its boundary.
  Tri triplanarWhen(sampler2D t, vec3 p, vec3 n, float scale, float rot, bool visible) {
    float c = cos(rot), s = sin(rot);
    mat2 R = mat2(c, -s, s, c);
    vec2 uvX = R * (vec2(p.z, p.y) / scale);
    vec2 uvY = R * (p.xz / scale);
    vec2 uvZ = R * (vec2(p.x, p.y) / scale);
    vec2 dxX = dFdx(uvX), dyX = dFdy(uvX);
    vec2 dxY = dFdx(uvY), dyY = dFdy(uvY);
    vec2 dxZ = dFdx(uvZ), dyZ = dFdy(uvZ);
    if (!visible) return Tri(vec3(0.0), 0.0, 0.5);
    vec4 tx = textureGrad(t, uvX, dxX, dyX);
    vec4 ty = textureGrad(t, uvY, dxY, dyY);
    vec4 tz = textureGrad(t, uvZ, dxZ, dyZ);
    vec3 w = pow(abs(n), vec3(4.0));
    w /= (w.x + w.y + w.z);
    vec2 nx = tx.rg * 2.0 - 1.0, ny = ty.rg * 2.0 - 1.0, nz = tz.rg * 2.0 - 1.0;
    vec3 dn = w.x * vec3(0.0, nx.y, nx.x) + w.y * vec3(ny.x, 0.0, ny.y) + w.z * vec3(nz.x, nz.y, 0.0);
    Tri r;
    r.dn = dn;
    r.b = w.x * tx.b + w.y * ty.b + w.z * tz.b;
    r.h = w.x * tx.a + w.y * ty.a + w.z * tz.a;
    return r;
  }
  #endif
  vec3 srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
  // How rough the water is here from the passing gust fronts: each front
  // reaches a screen column when the forest's does, rises fast and settles
  // over ~1.5 s, in drifting patches rather than a solid band.
  float catsPaw(vec2 xz) {
    float sx = clamp(gl_FragCoord.x / max(uViewportPx.x, 1.0) * 2.0 - 1.0, -1.2, 1.2);
    float paw = 0.0;
    for (int i = 0; i < ${GUST_FRONTS}; i++) {
      float age = uWaterGust[i].x - ((sx * uWaterGust[i].z) * 0.5 + 0.5) * ${GUST_SWEEP_SEC.toFixed(3)};
      float env = age < 0.0 ? 0.0 : (age < 0.35 ? age / 0.35 : exp(-(age - 0.35) / 1.5));
      paw = max(paw, env * uWaterGust[i].y);
    }
    float patches = smoothstep(0.38, 0.72, vnoise12(xz / 160.0 + vec2(uTime * 0.05, -uTime * 0.03)));
    return paw * patches;
  }
  // Lake surface slope: a few directional swells at unrelated wavelengths,
  // anchored to the land (world xz) and advancing with heard time at deep
  // water speeds. Each fades before its own period falls below a pixel, so
  // distant water calms instead of aliasing into screen-row stripes.
  vec2 waterSlope(vec2 xz, float t) {
    vec2 slope = vec2(0.0);
    const vec4 W[4] = vec4[4](vec4(.92, .39, 7.0, .55), vec4(-.45, .89, 16.0, .35), vec4(.71, -.70, 41.0, .22), vec4(-.97, -.24, 97.0, .12));
    for (int i = 0; i < 4; i++) {
      vec2 dir = W[i].xy;
      float k = 6.2831853 / W[i].z;
      float omega = sqrt(9.81 * k) * .5;
      float phase = dot(dir, xz) * k + t * omega + float(i) * 1.7;
      float fade = 1.0 - smoothstep(.35, 1.2, fwidth(phase));
      slope += dir * W[i].w * cos(phase) * fade;
    }
    return slope;
  }
  float waterAccentEnvelope(float age) {
    if (age < 0.0 || age >= 4.0) return 0.0;
    return smoothstep(0.0, 0.08, age) * exp(-age * 1.65) * (1.0 - smoothstep(3.0, 4.0, age));
  }
  float waterAccentPhase(float distanceM, float age, float wavelength, float seed) {
    return (distanceM - age * 70.0) * 6.2831853 / wavelength + seed * 6.2831853;
  }
  // Each attack launches a short train of ripples across the lake, in a
  // seeded world direction. The phase is evaluated from the event's age,
  // never integrated, so the mirror, capture and a seek share one surface.
  vec2 waterAccentSlope(vec2 xz) {
    vec2 slope = vec2(0.0);
    for (int i = 0; i < ${WATER_MUSIC_ACCENTS}; i++) {
      vec4 a = uWaterAccent[i];
      if (a.y <= 0.0) continue;
      float angle = a.z * 6.2831853;
      vec2 direction = vec2(cos(angle), sin(angle));
      float wavelength = a.w < 0.5 ? 140.0 : (a.w < 1.5 ? 48.0 : 86.0);
      float phase = waterAccentPhase(dot(xz, direction), a.x, wavelength, a.z);
      float resolved = 1.0 - smoothstep(.35, 1.2, fwidth(phase));
      float envelope = waterAccentEnvelope(a.x) * a.y;
      slope += direction * cos(phase) * envelope * resolved * (a.w < .5 ? .65 : .35);
    }
    return slope;
  }
  float waterMusicRoughness(float paw, float low, float kick) {
    return (0.03 + 0.06 * paw) * (1.0 + 0.9 * low + 0.7 * kick);
  }
  float waterMusicGlint(float cosine, float activity, float keyEnergy) {
    if (keyEnergy < 1e-10 || activity <= 0.0) return 0.0;
    return pow(max(cosine, 0.0), 80.0) * activity * 0.14;
  }
  float waterGlint(float cosine, float gain, float keyEnergy) {
    if (keyEnergy < 1e-10 || gain <= 0.0) return 0.0;
    return pow(max(cosine, 0.0), 600.0) * gain;
  }

  // Along-channel distance increases downstream. Velocity is the reach's
  // sourced or estimated metres per second, independent of the music.
  float riverTravel(float distanceM, float speedMps, float timeSec) {
    return distanceM - max(0.0, speedMps) * timeSec;
  }
  float riverCurrentTone(float phase, float resolved) {
    return 1.0 + .1 * cos(phase) * resolved;
  }
  #ifdef RIVER_SURFACE
  vec2 riverSlope(float t) {
    float along = riverTravel(vRiver.x, vRiver.z, t);
    vec2 direction = normalize(vRiverDirection);
    vec2 across = vec2(-direction.y, direction.x);
    float phase = along * 2.617994 + .3 * sin(vRiver.y * 3.0);
    float slowPhase = along * .897598 + vRiver.y * 1.7;
    float fineFade = 1.0 - smoothstep(.35, 1.2, fwidth(phase));
    float broadFade = 1.0 - smoothstep(.35, 1.2, fwidth(slowPhase));
    return direction * (.16 * cos(phase) * fineFade + .08 * cos(slowPhase) * broadFade)
      + across * .045 * sin(slowPhase + vRiver.y * 2.0) * broadFade;
  }
  #endif

  // Interpolate membership, not drainage magnitude. Blending 255 (lake)
  // with a dry flow byte before thresholding erodes almost the whole cell
  // and turns hydro shorelines into right-angled stair steps.
  float waterMaskCoverage(float a, float b, float c, float d, float x, float y) {
    float top = mix(step(254.5, a), step(254.5, b), x);
    float bottom = mix(step(254.5, c), step(254.5, d), x);
    return mix(top, bottom, y);
  }
  float waterCoverageAt(vec2 uv) {
    ivec2 size = textureSize(uSurface, 0);
    vec2 samplePos = uv * vec2(size) - .5;
    ivec2 corner = ivec2(floor(samplePos));
    vec2 f = fract(samplePos);
    float a = texelFetch(uSurface, clamp(corner, ivec2(0), size - 1), 0).a * 255.;
    float b = texelFetch(uSurface, clamp(corner + ivec2(1, 0), ivec2(0), size - 1), 0).a * 255.;
    float c = texelFetch(uSurface, clamp(corner + ivec2(0, 1), ivec2(0), size - 1), 0).a * 255.;
    float d = texelFetch(uSurface, clamp(corner + ivec2(1, 1), ivec2(0), size - 1), 0).a * 255.;
    return waterMaskCoverage(a, b, c, d, f.x, f.y);
  }
  void main() {
    if (vRenderedWorld.y < uClipBelow) discard;
    vec2 uv = vUv * (1.0 - uTexel) + 0.5 * uTexel;
    vec4 s = texture(uSurface, uv);
    vec2 nxz = s.rg * 2.0 - 1.0;
    vec3 n = normalize(vec3(nxz.x, sqrt(max(0.0, 1.0 - dot(nxz, nxz))), nxz.y));
    vec3 sourceNormal = n;
    vec3 ice = glacierAt(vWorld);
    vec3 g = deformGrad(vWorld);
    float invY = 1.0 / max(0.2, 1.0 + g.y);
    n = normalize(vec3(n.x - g.x * n.y * invY, n.y * invY, n.z - g.z * n.y * invY));
    vec3 iceNormal = normalize(cross(dFdx(vRenderedWorld), dFdy(vRenderedWorld)));
    if (iceNormal.y < 0.0) iceNormal = -iceNormal;
    n = normalize(mix(n, iceNormal, ice.y));
    vec3 geologicalNormal = n; // Ink must not inherit material normal-map detail.
    float dist = length(vRenderedWorld - uCameraPos);
    float slopeDeg = degrees(acos(clamp(n.y, 0.0, 1.0)));
    float curv = (s.b - 0.5) * 2.0;            // + concave gully, - convex ridge
    float flow = s.a * 255.0;
    float waterCoverage = waterCoverageAt(uv);
    #ifdef MAPPED_WATER_ONLY
    // A flat DEM patch is not evidence of water in a dry canyon. Only
    // explicitly mapped channel geometry can be wet under this policy.
    waterCoverage = 0.0;
    #endif
    #ifdef RIVER_SURFACE
    waterCoverage = 1.0;
    #endif
    bool water = waterCoverage > .5 && ice.y < 0.01;
    if (uWaterOnly > 0.5 && !water) discard;
    float flowN = clamp(flow / 254.0, 0.0, 1.0);
    float h = vWorld.y;
    vec3 albedo;
    vec3 nShade = n;
    float rough = 0.85;
    float snow01 = 0.0;
    float farCrownWeight = 0.0;
    vec3 farCrownNormal = vec3(0.0, 1.0, 0.0);
    if (uHasMaterial < 0.5) {
      albedo = mix(vec3(0.34), vec3(0.24), clamp(curv * 3.0, 0.0, 1.0));
      if (water) albedo = vec3(0.10, 0.13, 0.16);
    } else {
      // Macro rock detail everywhere: vary tile phase continuously so the
      // two rotated scales do not stamp a recurring pattern on broad faces.
      vec3 detailPosition = materialDetailPosition(vWorld);
      // The near CC0 scan fades in only where a texel can still be resolved.
      Tri macro = triplanarRib(tRock, detailPosition, n, sRock, 0.0, 0.35);
      Tri macro2 = triplanarRib(tRock, detailPosition, n, sRock * 0.37, 1.1, 0.5);
      float nearFade = 1.0 - smoothstep(600.0, 2200.0, dist);
      // Skipped where it cannot contribute (nearFade 0): three fetches saved
      // on every distant pixel, the result identical.
      Tri near = Tri(vec3(0.0), 0.0, 0.5);
      #ifdef PIXEL_MATERIAL_SKIP
      near = triplanarWhen(tRockNear, vWorld, n, sRockNear, 0.4, !water && nearFade > 0.0);
      #else
      if (nearFade > 0.0) near = triplanar(tRockNear, vWorld, n, sRockNear, 0.4);
      #endif
      float detailFade = 1.0 - smoothstep(9000.0, 30000.0, dist);
      vec3 dn = (macro.dn * 1.3 + macro2.dn * 0.8 * (1.0 - smoothstep(2500.0, 9000.0, dist))) * detailFade + near.dn * 0.7 * nearFade;
      float rh = mix(macro.h, macro2.h, 0.35);
      float breakup = vnoise12(vWorld.xz / 23.0) * 0.15 + rh;
      // Masks from the real surface.
      // Rock: cliffs (by slope, broken up by the rock's own relief and
      // pushed out of gullies), sharp convex crests, and bare ground above
      // the treeline. At 10-20 m DEM spacing, 35-45 degree slopes are still
      // mostly forested in wet mountain country, so the cliff band starts
      // near 47 degrees.
      float treeLine = rTreeline + (breakup - 0.5) * 220.0 + curv * 140.0;
      float alpine = smoothstep(treeLine - 50.0, treeLine + 350.0, h);
      // Edges kept ordered: a pack whose forest stops below 30 degrees
      // (tundra) would otherwise invert smoothstep and mark flats as rock.
      float cliff0 = max(40.0, rForestMaxSlope - 6.0);
      float rockMask = smoothstep(cliff0, max(cliff0 + 8.0, rForestMaxSlope + 10.0), slopeDeg + (rh - 0.5) * 16.0 - curv * 12.0);
      rockMask = max(rockMask, smoothstep(0.45, 0.9, -curv) * smoothstep(30.0, 44.0, slopeDeg) * 0.7);
      // Above the treeline, bare rock where it is steep or sharply convex;
      // gentle alpine ground stays meadow/tundra mat (a flat valley of
      // "rock" tiles its detail texture into a visible grid).
      rockMask = max(rockMask, alpine * smoothstep(20.0, 38.0, slopeDeg + (rh - 0.5) * 18.0 - curv * 10.0));
      float forest = (1.0 - smoothstep(treeLine - 90.0, treeLine + 60.0, h))
        * (1.0 - smoothstep(rForestMaxSlope - 6.0, rForestMaxSlope + 4.0, slopeDeg))
        * smoothstep(rForestFloor - 60.0, rForestFloor + 60.0, h + (breakup - 0.5) * 200.0)
        * rForestDensity * ice.z;
      float snowLine = rSnowline + (breakup - 0.5) * 260.0 - curv * 180.0;
      float snow = smoothstep(snowLine, max(snowLine + 1.0, snowLine + (rSnowFull - rSnowline)), h);
      snow *= 1.0 - smoothstep(rSnowMaxSlope - 10.0, rSnowMaxSlope + 6.0, slopeDeg - max(curv, 0.0) * 25.0);
      // Ground between: meadow on gentle open slopes, soil/scree steeper,
      // moss along wet drainage.
      vec3 ground = mix(pMeadow, pSoil, smoothstep(18.0, 34.0, slopeDeg));
      // Drainage moss only where water actually runs: on filled flats the
      // D8 flow routing is an artefact of straight diagonal channels.
      ground = mix(ground, pMoss, rMoss * smoothstep(0.35, 0.75, flowN) * smoothstep(1.5, 5.0, slopeDeg) * (1.0 - rockMask));
      vec3 rockCol = mix(pRockShade, pRockLit, clamp(rh * 1.2 - 0.1 + curv * -0.25, 0.0, 1.0));
      rockCol = mix(rockCol, pRockWarm, rStrata * smoothstep(0.55, 0.9, macro2.h));
      rockCol = mix(rockCol, pLichen, 0.25 * (1.0 - rockMask) );
      // Water streaks: drainage darkens steep rock below where it gathers.
      rockCol *= 1.0 - 0.45 * smoothstep(0.25, 0.6, flowN) * smoothstep(35.0, 55.0, slopeDeg);
      // Rib shadows from the stretched detail height.
      rockCol *= 0.7 + 0.6 * macro.h;
      vec3 forestRay = normalize(cameraPosition - vRenderedWorld);
      float forestDist = length(cameraPosition - vRenderedWorld);
      vec3 forestCol = mix(pForestNear, pForestFar, smoothstep(1500.0, 12000.0, forestDist));
      #ifdef FOREST_DEBUG
        forestCol = vec3(0.0, 1.0, 0.0);
      #endif
      // Forest gaps are shaded understory, with a restrained ground tint.
      // Keep the existing forest mask: open slopes, treeline and ice stay open.
      vec3 understory = forestUnderstory(forestCol, ground);
      // cameraPosition is supplied by Three for the actual draw camera,
      // including the lake reflection. The habitat mask remains unchanged.
      float forestCap=uFarForest.w>=8.?35.:1e9;
      vec2 meanCrown = meanForestCrown(treeLine - h, slopeDeg, uFarForest.z, forestCap);
      float cover = expectedForestCover(forest, meanCrown, n, forestRay)
        * farForestMix(forestDist, uFarForest.xy);
      float habitat = rForestDensity > 0.0 ? clamp(forest / rForestDensity, 0.0, 1.0) : 0.0;
      // Soil and rock share the shaded floor: rock cannot overwrite it later.
      vec3 openGround = mix(ground, rockCol, rockMask);
      // Average the profile's base occlusion and tip lift from shadeTree.
      vec3 crownLit = forestCol * .78;
      vec2 pixelDx=dFdx(vWorld.xz), pixelDy=dFdy(vWorld.xz);
      vec4 dotFootprint=farDotFootprint(forestRay,n,forestCap,pixelDx,pixelDy);
      float dots=water?0.:farDotWeight(forestDist,dotFootprint,min(forestCap,32.*uFarForest.z));
      vec3 dotNormal=vec3(0.,1.,0.);float dotCrownWeight=0.;
      if(dots>0. && forest>0.) {
        vec4 painted=farTreeDots(vRenderedWorld,forestRay,n,sourceNormal,degrees(acos(clamp(sourceNormal.y,0.,1.))),forestCap,pixelDx,pixelDy,forestCol,dotNormal);
        // Blend covered contributions: empty painted gaps cannot dim the
        // remaining mean crown colour or turn its normal toward the sky.
        float meanWeight=cover*(1.-dots), paintedWeight=painted.a*dots;
        cover=meanWeight+paintedWeight;
        crownLit=(crownLit*meanWeight+painted.rgb*paintedWeight)/max(cover,.000001);
        dotCrownWeight=paintedWeight/max(cover,.000001);
      }
      albedo = mix(openGround, mix(understory, crownLit, cover), habitat);
      float crowns = cover * habitat;
      farCrownWeight = water ? 0.0 : crowns * (1.0 - snow) * (1.0 - ice.y);
      vec3 towardEyeHorizontal = vec3(forestRay.x, 0.0, forestRay.z);
      towardEyeHorizontal /= max(length(towardEyeHorizontal), .00001);
      farCrownNormal = normalize(mix(normalize(towardEyeHorizontal * .6 + vec3(0.0, .5, 0.0)),dotNormal,dotCrownWeight));
      // Two snow scales at unrelated sizes and angles: a single 60 m tile
      // repeats visibly as a grid across a wide snowy flat.
      #ifdef PIXEL_MATERIAL_SKIP
      Tri sn = triplanarWhen(tSnow, detailPosition, n, sSnow, 0.7, !water && snow > 0.0);
      Tri sn2 = triplanarWhen(tSnow, detailPosition, n, sSnow * 3.7, 2.1, !water && snow > 0.0);
      #else
      Tri sn = triplanar(tSnow, detailPosition, n, sSnow, 0.7);
      Tri sn2 = triplanar(tSnow, detailPosition, n, sSnow * 3.7, 2.1);
      #endif
      sn.h = mix(sn.h, sn2.h, 0.5);
      sn.dn = mix(sn.dn, sn2.dn, 0.5);
      vec3 snowCol = mix(pSnowShade, pSnow, 0.7 + 0.3 * sn.h);
      albedo = mix(albedo, snowCol, snow);
      // Detail normal: rock gets the full detail, forest the crowns, snow
      // its own ripples.
      vec3 detail = dn * mix(0.15, 1.0, rockMask) * (1.0 - crowns);
      detail = mix(detail, sn.dn * 0.4, snow);
      if (uCinematic.x > .5) {
        // At a broad pixel footprint, geological faces carry the shape.
        float footprint = max(length(dFdx(detailPosition)), length(dFdy(detailPosition)));
        detail *= mix(1.0, .68, smoothstep(6.0, 40.0, footprint));
      }
      nShade = normalize(n + detail);
      nShade = normalize(mix(nShade, farCrownNormal, farCrownWeight));
      rough = mix(mix(0.9, macro.b, rockMask), 0.6, snow);
      snow01 = snow;
      if (water) {
        float depthMix = smoothstep(.5, .98, waterCoverage);
        albedo = mix(pWater, pWaterDeep, depthMix);
        nShade = vec3(0.0, 1.0, 0.0);
        rough = mix(.28, .12, depthMix);
      }
      if (uDebugMask == 1) { outColor = vec4(rockMask, crowns, snow, 1.0); if (water) outColor = vec4(0.0, 0.6, 1.0, 1.0); return; }
      if (uDebugMask == 2) { outColor = vec4(vec3(slopeDeg / 90.0), 1.0); return; }
    }
    // Ice detail is fixed to the lobe. Longitudinal debris bands curve
    // gently, while transverse crevasses open across the flow. Neither
    // feature swims with the camera or expands on every drum hit.
    if (ice.y > 0.0) {
      vec2 axis = normalize(uGlacierEnd - uGlacierStart);
      vec2 rel = vWorld.xz - uGlacierStart;
      float along = dot(rel, axis), across = dot(rel, vec2(-axis.y, axis.x));
      float crackPhase = along / 105.0 + 0.75 * sin(across / 230.0) + 1.6 * vnoise12(vWorld.xz / 260.0);
      float crackEdge = abs(fract(crackPhase) - 0.5);
      float aa = max(0.008, fwidth(crackPhase));
      float crack = 1.0 - smoothstep(0.018, 0.018 + aa, crackEdge);
      // Once many fissures fall inside a pixel, preserve their mean area
      // instead of broadening each dark line into a distant zebra stripe.
      crack = mix(crack, 0.04, smoothstep(0.15, 0.5, aa));
      crack *= smoothstep(0.2, 0.55, vnoise12(vec2(across / 310.0, along / 650.0)));
      float debris = pow(0.5 + 0.5 * sin(across / 145.0 + sin(along / 1350.0)), 18.0);
      float grain = vnoise12(vWorld.xz / 55.0);
      vec3 iceColor = mix(vec3(0.42, 0.66, 0.78), vec3(0.84, 0.93, 0.98), grain * 0.5 + 0.5);
      iceColor = mix(iceColor, vec3(0.025, 0.09, 0.14), crack * 0.8);
      iceColor = mix(iceColor, vec3(0.10, 0.12, 0.12), debris * 0.38);
      albedo = mix(albedo, iceColor, ice.y);
      nShade = normalize(mix(nShade, iceNormal, ice.y));
      rough = mix(rough, 0.3, ice.y);
    } else if (uGlacierEnabled > 0.5 && ice.z < 1.0 && !water) {
      // Newly exposed ground stays dark and wet before its canopy returns.
      albedo = mix(albedo * 0.58, albedo, ice.z);
    }
    // Wet receivers are the same surfaces at a lower roughness: their
    // shine is the specular lobe below sharpening, not a separate layer.
    if (!water) { albedo *= 1.0 - uStorm.w * .18; rough = mix(rough, max(.22, rough * .4), uStorm.w); }
    // Canopy is matte; sub-pixel normal variation widens the lobe so the
    // detail normals cannot sparkle at distance (specular anti-aliasing).
    rough = terrainRoughness(mix(rough, .95, farCrownWeight), nShade);
    // Direct light reaches a point only above its baked horizon (broad
    // geographic relief; TerrainOcclusion.js). Sky fill is not shadowed.
    float sunVis = sunHorizonVisibility(vUv, uLightDir);
    // Light: the celestial as a soft wrap-diffuse key, sky hemisphere fill,
    // occlusion from curvature and drainage (gullies sit in shade).
    float wrap = mix(0.18, 0.3, farCrownWeight);
    // A shadowed slope still receives the key's light scattered by the air
    // and bounced off the lit relief around it (warm, directional), not only
    // the cold sky fill: keep a residual share so relief reads in shadow.
    float key = max((dot(nShade, uLightDir) + wrap) / (1.0 + wrap), 0.0) * mix(${SHADOW_RESIDUAL.toFixed(2)}, 1.0, sunVis);
    if (uCinematic.x > .5 && !water) {
      wrap = mix(uCinematic.w, uCinematic.w + .10, farCrownWeight);
      key = max((dot(nShade, uLightDir) + wrap) / (1.0 + wrap), 0.0) * mix(uCinematic.z, 1.0, sunVis);
    }
    // The opening relief shares the physical key. A dormant direction
    // must not change even its neutral surface shading during a gap.
    float keyOn = step(1e-10, dot(uLightColor, uLightColor));
    key *= keyOn;
    vec3 Vs = normalize(uCameraPos - vRenderedWorld);
    // Dielectric response: Fresnel-weighted GGX for the key, and the
    // energy it reflects is no longer also diffused.
    vec2 spec = terrainSpecular(nShade, Vs, uLightDir, rough, materialF0(snow01, ice.y));
    key *= 1.0 - spec.y;
    float ao = clamp(1.0 - max(curv, 0.0) * 0.55 - flowN * 0.12, 0.35, 1.0);
    // Sky radiance: the displayed sky colours are radiance, and a surface
    // integrates the hemisphere, hence the scale.
    float opening = stormOpening(vRenderedWorld);
    float receiverShadow = water ? 1.0 : stormShadow(opening);
    float ambientScale = water ? uAmbientScale : stormAmbient(uAmbientScale, uMoonAmbientScale, opening);
    vec3 hemi = mix(uSkyHorizon * 0.55, uSkyZenith, 0.5 + 0.5 * nShade.y) * ambientScale;
    if (uCinematic.x > .5 && !water) hemi = cinematicFill(hemi, key);
    if (!water) hemi = receiverFill(hemi, uReceiverFillMin);
    // Water keeps the open sky's key under fair-weather cloud shadows.
    float moonTransmission = water && uCloudMode > 0.5 ? 1.0 : celestialCloudTransmission(vRenderedWorld, uLightDir);
    vec3 lit = albedo * (hemi * ao + uLightColor * moonTransmission * key * mix(0.85, 1.0, ao) * receiverShadow);
    if (uCinematic.x > .5 && !water) {
      lit = albedo * (hemi * ao + cinematicKey(uLightColor) * moonTransmission * key * mix(0.85, 1.0, ao) * receiverShadow);
    }
    // The cast's lanterns light the ground around them.
    lit += albedo * actorLight(vRenderedWorld, nShade) * receiverShadow;
    // Broken cloud transmits the real solar key in broad moving swathes
    // across wet receivers; world coordinates keep them fixed to the land.
    // Between the swathes the last of the cloud still shades the land, and
    // wet rock and grass shine back toward the sun.
    lit += albedo*uLightColor*moonTransmission*key*uStorm.z*opening*.85;
    // The key's reflection, through the same cloud, storm opening and
    // horizon as its diffuse light; rain on the lens (squall) mutes it.
    float specLight = 0.0;
    if (!water) {
      float keyGain = (1.0 - uStorm.z * (1.0 - opening) * .5) + uStorm.z * opening * .85;
      // A canopy is a volume of needles, not a facet: its crowns shadow
      // their own glancing reflection, so it keeps only a trace.
      specLight = spec.x * sunVis * keyOn * moonTransmission * keyGain * (1.0 - .75 * uStorm.y) * (1.0 - .9 * farCrownWeight);
      lit += uLightColor * specLight;
    }
    if (uDebugMask == 3) { outColor = vec4(albedo * 4.0, 1.0); return; }
    if (uDebugMask == 4) { outColor = vec4(hemi * ao * 0.5, 1.0); return; }
    if (uDebugMask == 5) { outColor = vec4(vec3(key), 1.0); return; }
    if (uDebugMask == 6) { outColor = vec4(vec3(rough), 1.0); return; }
    if (uDebugMask == 7) { outColor = vec4(linearToSrgb(tonemap(uLightColor * specLight * uExposure)), 1.0); return; }
    if (uDebugMask == 8) { outColor = vec4(vec3(sunVis), 1.0); return; }
    vec3 V = normalize(uCameraPos - vRenderedWorld);
    float waterFres = 0.0, paw = 0.0, wake = 0.0;
    vec2 waterSwell = vec2(0.0);
    vec3 waterN = vec3(0.0, 1.0, 0.0);
    if (water && uHasMaterial > 0.5) {
      // Midio's wake roughens the water as a cat's paw does.
      wake = wakeAt(vWorld.xz);
      // Rain stipples the whole lake while the squall is over it.
      paw = max(max(catsPaw(vWorld.xz), wake), uStorm.x * 0.75);
      waterSwell = waterSlope(vWorld.xz, uTime);
      #ifdef RIVER_SURFACE
      waterSwell = riverSlope(uTime);
      #endif
      waterSwell += waterAccentSlope(vWorld.xz);
      vec2 ripple = waterSwell * waterMusicRoughness(paw, uWaterMusic.x, uWaterMusic.y);
      vec3 waterNormal = normalize(vec3(ripple.x, 1.0, ripple.y));
      waterN = waterNormal;
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(vec3(0.0, 1.0, 0.0), V), 0.0), 5.0);
      // Rough water reflects less, so a cat's paw reads as a darker patch.
      fres *= 1.0 - 0.35 * paw;
      waterFres = fres;
      vec3 halfVector = uLightDir + V;
      vec3 H = halfVector / max(length(halfVector), 1e-10);
      float glint = waterGlint(dot(H, waterNormal), rWaterGlintGain, dot(uLightColor, uLightColor));
      glint += waterMusicGlint(dot(H, waterNormal), uWaterMusic.z, dot(uLightColor, uLightColor)) * min(1.0, rWaterGlintGain);
      // The lake mirrors the sky above the far shore, not only its pale
      // horizon band: an all-horizon mirror turned broad lakes into a
      // flat white sheet that outshone the mountains.
      vec3 skyReflect = mix(uSkyZenith, uSkyHorizon, 0.3) * 0.5;
      // With the backdrop to reflect, the sky arrives with the mirror below.
      float skyHere = fres * (1.0 - uBackdropAmount * uMirrorAmount);
      #ifdef RIVER_SURFACE
      // Descending reaches have no single planar lake reflection.
      skyHere = fres;
      #endif
      lit = mix(lit, skyReflect * rWaterSkyMix, skyHere) + uLightColor * glint * moonTransmission;
      // Treble catches the resolved crests, especially in disturbed water.
      // It borrows the available light rather than emitting a white wash.
      float crest = smoothstep(.55, 1.05, length(waterSwell));
      lit += (uSkyHorizon * .12 + uLightColor * .025 * moonTransmission)
        * crest * uWaterMusic.z * (.25 + .75 * paw);
      #ifdef RIVER_SURFACE
      // Gentle advected surface variation remains readable under ambient
      // light. Filtered-out ripples retain their mean rather than flashing.
      float currentPhase = riverTravel(vRiver.x, vRiver.z, uTime) * .897598 + .25 * sin(vRiver.y * 4.0);
      lit *= riverCurrentTone(currentPhase, 1.0 - smoothstep(.35, 1.2, fwidth(currentPhase)));
      #endif
    }
    // Aerial perspective, applied once here and nowhere else.
    float heightTerm = exp(-max(0.0, vRenderedWorld.y - uCameraPos.y * 0.25) * uAirHeightFalloff);
    float air = 1.0 - exp(-dist * uAirDensity * (0.35 + 0.65 * heightTerm));
    // Air is the displayed sky colour; bring it into the exposed domain so
    // distant terrain converges on the sky the 2D painter draws behind it.
    // Valley mist first (it sits in the near and middle air), then the
    // distance air over everything, mist included.
    vec3 neutral = vec3(.42) * (.45 + .55 * key);
    vec3 physical = mix(neutral, tonemap(lit * uExposure), uNarrative.z);
    if (uCinematic.x > .5) physical = cinematicGrade(physical);
    if (water || ice.y > .01) physical = mix(neutral, physical, uNarrative.w);
    vec3 color = mix(uSkyHorizon, physical, uNarrative.x);
    float mist = mistAmount(uCameraPos, vRenderedWorld) * uNarrative.y;
    if (uCinematic.x > .5) {
      mist = cinematicMistAmount(mist, dist, uMistFill);
      air = cinematicAirAmount(dist, heightTerm, uAirDensity);
    }
    vec3 mistColor = mistColorAt(uCameraPos, vRenderedWorld);
    vec3 airColor = uAirColor;
    if (uCinematic.x > .5) {
      mistColor = cinematicMistColor(mistColor, uSkyZenith, dist);
      airColor = cinematicMistColor(airColor, uSkyZenith, dist);
    }
    // Mist glows toward the key light (forward scatter), through the same
    // cloud as the key; the squall's deck swallows it. Mist only, not air.
    mistColor = min(mistColor + uLightColor * 0.07 * mistPhase(normalize(vRenderedWorld - uCameraPos), uLightDir)
      * (1.0 - uStorm.x) * moonTransmission, vec3(0.9));
    color = mix(color, mistColor, mist);
    // Under a cloud sea the lake's mirror and glints are hidden with it.
    float clear = 1.0 - mist * uMistFill;
    color = mix(color, airColor, clamp(air, 0.0, 0.96) * uNarrative.y);
    color = mix(color, rainColor(), rainVeil(vRenderedWorld, dist) * 0.8 * uNarrative.y);
    // The lake mirrors the ground above it. The mirror image already holds
    // the air along its own (longer) path, so it replaces the water's colour
    // by the water's reflectance, as the sky reflection did in lit. Groove
    // and kicks shiver it in horizontal bands; a cat's paw breaks it up.
    #ifndef RIVER_SURFACE
    if (water && uMirrorAmount > 0.0) {
      // The reflection wavers with the surface itself: the same world-fixed
      // swells (not screen rows) displace it, more in a cat's paw, and less
      // with distance as the waves shrink on screen. Groove and kicks still
      // set the amount (uMirrorRipple).
      vec2 shiver = vec2(0.3 * waterSwell.x, waterSwell.y) * uMirrorRipple * 1.6 * (1.0 + 3.0 * paw)
        * (1.0 + .4 * uWaterMusic.x + .35 * uWaterMusic.y)
        * mix(1.0, .35, smoothstep(600.0, 7000.0, dist));
      // The backdrop, met by the view ray reflected off flat water (it is far
      // enough away to treat as the sky), then the ground mirrored over it.
      // Seen from high above a lake, the true reflection of distant ranges
      // lies beyond its far shore; magical naturalism lowers the reflected
      // ray (MIRROR_LIFT, as the mirror camera does) so the water holds them.
      vec3 ray = normalize(vRenderedWorld - uCameraPos);
      vec3 up = vec3(ray.x, abs(ray.y) * ${MIRROR_LIFT.toFixed(3)}, ray.z);
      vec4 bc = uViewProj * vec4(uCameraPos + normalize(up) * 60000.0, 1.0);
      vec3 mirrored = srgbToLinear(texture(uBackdrop, clamp(bc.xy / bc.w * 0.5 + 0.5 + shiver, vec2(0.001), vec2(0.999))).rgb);
      float have = uBackdropAmount;
      vec4 mc = uMirrorMatrix * vec4(vRenderedWorld, 1.0);
      if (mc.w > 0.0 && abs(vWorld.y - uMirrorLevel) < 3.0) {
        vec4 m = texture(uMirror, clamp(mc.xy / mc.w + shiver, vec2(0.001), vec2(0.999)));
        if (m.a > 0.004) mirrored = mix(mirrored, srgbToLinear(m.rgb / m.a), have > 0.0 ? m.a : 1.0);
        have = max(have, m.a);
      }
      // Stiller and glossier than physical water: a lake seen from high
      // above still holds its shores (magical naturalism, like the lift).
      // The floor keeps a believable shore relationship from a high camera
      // (physical water would show almost none); a cat's paw roughens it.
      float reflectance = clamp(${WATER_REFLECT_FLOOR.toFixed(3)} + ${(1 - WATER_REFLECT_FLOOR).toFixed(3)} * waterFres, 0.0, 0.88) * (1.0 - 0.4 * paw);
      // A phrase opens a little more mirror between passing crests; the
      // shoreline coverage, depth and real reflected image stay unchanged.
      reflectance = min(.88, reflectance + (.035 * uWaterMusic.x + .025 * uWaterMusic.w)
        * smoothstep(.2, .8, abs(waterSwell.y)));
      color = mix(color, mirrored * 0.9, reflectance * smoothstep(.5, .9, waterCoverage) * have * clear * uNarrative.z * uNarrative.w);
    }
    #endif
    if (water) {
      // Lanterns over the water lay a path of glints; Midio's wake catches
      // his light. Over the mirror, through the air.
      vec3 glow = actorGlint(vRenderedWorld, V, waterN) * 0.6 + uActorColor[0] * wake * 0.12;
      // Rain on the lake breaks the path up, so it fades with the squall.
      color += glow * clear * uNarrative.z * (1.0 - 0.85 * clamp(air, 0.0, 1.0)) * (1.0 - 0.75 * uStorm.x);
    }
    // A narrow physical silhouette supplies the main opening ink. Sparse
    // source-space hints are drawn separately against this same depth.
    float facing = abs(dot(geologicalNormal, V));
    float aa = max(.008, fwidth(facing));
    float edge = 1.0 - smoothstep(.02 - aa, .02 + aa, facing);
    color = mix(color, vec3(0.0), edge * uNarrativeInk);
    outColor = vec4(linearToSrgb(color), 1.0);
    if (uDiag > 0.5) outColor = vec4(1.0, 0.0, 1.0, 1.0);
  }
`;

export const DEPTH_FRAG = /* glsl */`
  precision highp float;
  uniform float uClipBelow;
  in vec3 vRenderedWorld;
  out vec4 outColor;
  void main() { if (vRenderedWorld.y < uClipBelow) discard; outColor = vec4(0.0); }
`;

export const FEATURE_FRAG = /* glsl */`
  precision highp float;
  uniform float uNarrativeInk;
  out vec4 outColor;
  void main() { if (uNarrativeInk < .005) discard; outColor = vec4(0.0, 0.0, 0.0, uNarrativeInk); }
`;

/** The forest's gust-front slots, all idle. */
export function gustUniforms() {
  return { uGustAge: { value: new Array(GUST_FRONTS).fill(GUST_IDLE_SEC) },
    uGustAmp: { value: new Array(GUST_FRONTS).fill(0) }, uGustDir: { value: new Array(GUST_FRONTS).fill(1) } };
}

/** Preserve the forest gust values in the terrain fragment's packed array. */
export function syncGustUniforms(u) {
  for (let i = 0; i < GUST_FRONTS; i++) {
    u.uWaterGust.value[i].set(u.uGustAge.value[i], u.uGustAmp.value[i], u.uGustDir.value[i]);
  }
}

/** The current frozen effects frame owns all water response. Clearing every
 * slot also removes a prior view's attacks on silence, seeks or score loss. */
export function syncWaterMusicUniforms(u, effects) {
  const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  u.uWaterMusic.value.set(.7 * unit(effects?.bass) + .3 * unit(effects?.energy), unit(effects?.kick),
    .65 * unit(effects?.treble) + .75 * unit(effects?.snare) + .2 * unit(effects?.melody), unit(effects?.lift));
  const accents = Array.isArray(effects?.accents) ? effects.accents.slice(0, 64).filter(a => a && Number.isFinite(a.ageSec)
    && a.ageSec >= 0 && a.ageSec < 4 && unit(a.strength) > 0 && ['kick', 'snare', 'melody'].includes(a.kind))
    .sort((a, b) => a.ageSec - b.ageSec) : [];
  for (let i = 0; i < WATER_MUSIC_ACCENTS; i++) {
    const a = accents[i];
    u.uWaterAccent.value[i].set(a?.ageSec ?? 4, unit(a?.strength), unit(a?.seed), a?.kind === 'melody' ? 2 : a?.kind === 'snare' ? 1 : 0);
  }
}

/** Shared uniforms for the production terrain (values set per frame). */
export function sceneUniforms(THREE, base) {
  return {
    ...base,
    ...actorUniforms(THREE),
    ...cloudUniforms(THREE),
    uGlacierEnabled: { value: 0 }, uGlacierStart: { value: new THREE.Vector2() }, uGlacierEnd: { value: new THREE.Vector2(0, -100) },
    uGlacierWidth: { value: 1 }, uGlacierSurface: { value: new THREE.Vector2() }, uGlacierMaxThickness: { value: 0 }, uGlacierRetreat: { value: 0 },
    uDeformAmp: { value: 0 }, uDeformKick: { value: 0 }, uDeformK: { value: 0 },
    uTourEnabled: { value: 0 }, uTourEye: { value: new THREE.Vector3() },
    uDeformGesture: { value: 0 }, uDeformMelodic: { value: 0 }, uDeformStructural: { value: 0 },
    uMelodyK: { value: 0 }, uMelodyDir: { value: new THREE.Vector2(1, 0) }, uMelodyPhase: { value: 0 },
    uDeformDir: { value: new THREE.Vector2(0.8, -0.6) }, uDeformPhase: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightColor: { value: new THREE.Color(1, 1, 1) },
    uSolarTransmission: { value: 0 },
    uSkyZenith: { value: new THREE.Color(0.1, 0.12, 0.2) },
    uSkyHorizon: { value: new THREE.Color(0.3, 0.35, 0.45) },
    uAirColor: { value: new THREE.Color(0.35, 0.4, 0.5) },
    uAirDensity: { value: 1 / 60000 },
    uAirHeightFalloff: { value: 1 / 2500 },
    // Valley mist (RangeAtmosphere): off until the scene sets it per frame.
    uMistDensity: { value: 0 }, uMistBase: { value: 0 }, uMistHeight: { value: 220 }, uMistTime: { value: 0 },
    uMistSteps: { value: MIST_SAMPLES }, uMistTop: { value: 1e9 }, uMistFill: { value: 0 },
    uMistDrift: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
    uMistColor: { value: new THREE.Color(0.4, 0.43, 0.48) },
    uCameraPos: { value: new THREE.Vector3() },
    uDiag: { value: 0 },
    uHasMaterial: { value: 0 },
    uStorm: { value: new THREE.Vector4() }, uRainShift: { value: 0 }, uRainSeed: { value: 0 },
    uAmbientScale: { value: 2.5 },
    uMoonAmbientScale: { value: 0 },
    uReceiverFillMin: { value: 0 },
    uDebugMask: { value: 0 },
    // Baked horizon (TerrainOcclusion.js): off until a view's bake lands.
    uHorizon: { value: null }, uHorizonSize: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    // Gust fronts in flight: age (s), strength, and way across the frame.
    ...gustUniforms(),
    uWaterGust: { value: Array.from({ length: GUST_FRONTS }, () => new THREE.Vector3(GUST_IDLE_SEC, 0, 1)) },
    uWaterMusic: { value: new THREE.Vector4() },
    uWaterAccent: { value: Array.from({ length: WATER_MUSIC_ACCENTS }, () => new THREE.Vector4(4, 0, 0, 0)) },
    uForestKeep: { value: 1 },
    uFarForest: { value: new THREE.Vector4(0, 0, RULE_DEFAULTS.treeScale, 0) },
    uForestSeed: { value: 0 },
    uCinematic: { value: new THREE.Vector4(0, 1, .5, .18) },
    uCinematicAir: { value: new THREE.Vector4(1, 1, 0, 0) },
    uExposure: { value: 2.0 },
    uNarrative: { value: new THREE.Vector4(1, 1, 1, 1) },
    uNarrativeInk: { value: 0 },
    // Lake mirror (WaterMirror.js), off until the scene draws one.
    uMirror: { value: null }, uMirrorMatrix: { value: new THREE.Matrix4() }, uMirrorAmount: { value: 0 },
    uMirrorLevel: { value: 0 }, uMirrorRipple: { value: 0 }, uClipBelow: { value: -1e9 }, uWaterOnly: { value: 0 },
    uViewportPx: { value: new THREE.Vector2(1, 1) },
    uBackdrop: { value: null }, uBackdropAmount: { value: 0 }, uViewProj: { value: new THREE.Matrix4() },
    tRock: { value: null }, sRock: { value: 150 }, tRockNear: { value: null }, sRockNear: { value: 6 },
    tCanopy: { value: null }, sCanopy: { value: 70 }, tSnow: { value: null }, sSnow: { value: 60 },
    tSoil: { value: null }, sSoil: { value: 3 },
    pRockLit: { value: new THREE.Color() }, pRockShade: { value: new THREE.Color() }, pRockWarm: { value: new THREE.Color() },
    pSoil: { value: new THREE.Color() }, pMeadow: { value: new THREE.Color() }, pForestNear: { value: new THREE.Color() },
    pForestFar: { value: new THREE.Color() }, pMoss: { value: new THREE.Color() }, pSnow: { value: new THREE.Color() },
    pSnowShade: { value: new THREE.Color() }, pWater: { value: new THREE.Color() }, pWaterDeep: { value: new THREE.Color() },
    pLichen: { value: new THREE.Color() },
    rSnowline: { value: 2000 }, rSnowFull: { value: 2400 }, rSnowMaxSlope: { value: 50 }, rTreeline: { value: 1700 },
    rForestMaxSlope: { value: 38 }, rForestDensity: { value: 0.8 }, rMoss: { value: 0.5 }, rStrata: { value: 0.2 },
    rForestFloor: { value: RULE_DEFAULTS.forestFloorM },
    rWaterSkyMix: { value: RULE_DEFAULTS.waterSkyMix }, rWaterGlintGain: { value: RULE_DEFAULTS.waterGlintGain },
  };
}

const ROLE_UNIFORM = { rockDetail: ['tRock', 'sRock'], rockNear: ['tRockNear', 'sRockNear'], canopy: ['tCanopy', 'sCanopy'],
  snow: ['tSnow', 'sSnow'], soil: ['tSoil', 'sSoil'] };
const PALETTE_UNIFORM = { rockLit: 'pRockLit', rockShade: 'pRockShade', rockWarm: 'pRockWarm', soil: 'pSoil', meadow: 'pMeadow',
  forestNear: 'pForestNear', forestFar: 'pForestFar', moss: 'pMoss', snow: 'pSnow', snowShade: 'pSnowShade',
  water: 'pWater', waterDeep: 'pWaterDeep', lichen: 'pLichen' };
const RULE_UNIFORM = { snowlineM: 'rSnowline', snowFullM: 'rSnowFull', snowMaxSlopeDeg: 'rSnowMaxSlope', treelineM: 'rTreeline',
  forestMaxSlopeDeg: 'rForestMaxSlope', forestDensity: 'rForestDensity', moss: 'rMoss', strata: 'rStrata',
  forestFloorM: 'rForestFloor', waterSkyMix: 'rWaterSkyMix', waterGlintGain: 'rWaterGlintGain' };

/** Set a THREE.Color to the linear value of an sRGB hex, exactly once.
 *  (Color.set(hex) already linearises under colour management; chaining
 *  convertSRGBToLinear() on top darkened everything about tenfold.) */
export function setLinearFromHex(color, hex) {
  const [r, g, b] = hexToLinear(hex);
  color.r = r; color.g = g; color.b = b;
  return color;
}

/** GPU data textures for a loaded pack: one Texture per unique image. */
export function createMaterialTextures(THREE, pack, { anisotropy = 4 } = {}) {
  const bySha = new Map();
  const roles = {};
  for (const [role, t] of Object.entries(pack.manifest.textures)) {
    let tex = bySha.get(t.sha256);
    if (!tex) {
      tex = new THREE.Texture(pack.images.get(t.sha256));
      tex.colorSpace = THREE.NoColorSpace; // data, not colour
      tex.premultiplyAlpha = false;
      tex.flipY = false;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = anisotropy;
      tex.needsUpdate = true;
      bySha.set(t.sha256, tex);
    }
    roles[role] = { texture: tex, metersPerTile: t.metersPerTile };
  }
  return { roles, textures: [...bySha.values()], dispose: () => { for (const t of bySha.values()) t.dispose(); } };
}

/** Bind a pack (textures, palette, rules; `ruleOverrides` from the view). */
export function applyMaterial(uniforms, pack, textures, ruleOverrides = {}) {
  const rules = { ...pack.manifest.rules, ...ruleOverrides };
  const check = validateWaterRules(rules);
  if (!check.ok) throw new RangeAssetError('manifest', `material rules rejected: ${check.errors.join('; ')}`);
  for (const [role, [tu, su]] of Object.entries(ROLE_UNIFORM)) {
    const r = textures.roles[role];
    if (!r) continue;
    uniforms[tu].value = r.texture;
    uniforms[su].value = r.metersPerTile;
  }
  for (const [k, u] of Object.entries(PALETTE_UNIFORM)) setLinearFromHex(uniforms[u].value, pack.manifest.palette[k]);
  for (const [k, u] of Object.entries(RULE_UNIFORM)) uniforms[u].value = rules[k] ?? RULE_DEFAULTS[k];
  uniforms.uHasMaterial.value = 1;
}

export function createSceneMaterial(THREE, uniforms, { forestDebug = false, budget = 'desktop', terrainShading = 'off', pixelated = false, riverSurface = false, mappedWaterOnly = false } = {}) {
  const experimental = terrainShading === 'moran';
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SCENE_VERT,
    fragmentShader: experimental ? moranTerrainFragment(SCENE_FRAG) : SCENE_FRAG, uniforms });
  if (experimental) m.userData.terrainShading = 'moran';
  m.defines.FAR_FOREST_KMAX = budget === 'mobile' ? 4 : 8;
  if (pixelated) m.defines.PIXEL_MATERIAL_SKIP = 1;
  if (forestDebug) m.defines.FOREST_DEBUG = 1;
  if (riverSurface) m.defines.RIVER_SURFACE = 1;
  if (mappedWaterOnly) m.defines.MAPPED_WATER_ONLY = 1;
  return m;
}

/** Depth-only twin: identical vertex transform (invariant), no colour. */
export function createDepthMaterial(THREE, uniforms, { riverSurface = false } = {}) {
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SCENE_VERT, fragmentShader: DEPTH_FRAG, uniforms });
  if (riverSurface) m.defines.RIVER_SURFACE = 1;
  m.colorWrite = false;
  return m;
}
