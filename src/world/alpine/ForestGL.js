import { CROWN_GLSL } from './ForestProfile.js';
export { CROWN_GLSL, crownHalfWidth } from './ForestProfile.js';
// Range v2 forest instances on the GPU (Task 10): near conifers as small
// instanced meshes, the middle distance as instanced camera-facing
// silhouettes, and beyond that the canopy texture inside the terrain
// shader. Roots move with the shared musical deformation (DEFORM_GLSL);
// wind is a pure function of heard time and each tree's id, so pause holds
// and seeks reconstruct. Each kick also sends a gust front across the
// frame: crowns bend and catch light as it passes (gustAt). Light, sky
// fill and aerial perspective match the terrain so trees sit in the same
// air.
import { STORM_GLSL } from './RangeStorm.js';
import { DEFORM_GLSL, gustUniforms } from './TerrainMaterial.js';
import { GUST_FRONTS, GUST_SWEEP_SEC } from './Gust.js';

import { MIST_GLSL } from './RangeAtmosphere.js';
import { ACTOR_GLSL, actorUniforms } from './ActorsGL.js';
import { buildConiferAsset, familyFor, variantFor, FOREST_FAMILIES, FOREST_VARIANTS } from './ForestSpeciesAssets.js';

const GUST_ATTACK_SEC = 0.7;
const GUST_DECAY_SEC = 2.4;
/** Crown lean at a full gust, as a fraction of tree height. */
const GUST_LEAN = 0.08;
/** Crown brightening at a full gust: needles turning their pale sides up. */
const GUST_SHEEN = 0.05;
const GUST_SHEEN_DECAY_SEC = 1.0;
/** Crown lean away from Broshi as he passes, as a fraction of height. */
const PARTING_LEAN = 0.2;

export const TREE_COMMON = /* glsl */`
  ${DEFORM_GLSL}
  uniform float uTime;
  // Gust fronts in flight: seconds since each front's kick, its strength,
  // and its way across the frame (+1 left to right, -1 right to left).
  uniform float uGustAge[${GUST_FRONTS}];
  uniform float uGustAmp[${GUST_FRONTS}];
  uniform float uGustDir[${GUST_FRONTS}];
  uniform float uForestKeep;
  uniform vec3 uCameraPos;
  // Broshi passing: xz, radius (m), amount. Crowns lean away and show
  // their pale sides, as in a gust.
  uniform vec4 uParting;
  in vec3 iPos;
  in vec2 iSize;   // height, width (metres)
  in vec2 iVar;    // variant, id 0..1
  out vec3 vWorld;
  out vec2 vLocal;  // x across (-.5...5), y up (0..1)
  out float vVar;
  out float vId;
  out float vGust;
  vec3 rootOf() { vec3 r = iPos; r.y += deformAt(iPos); return r; }
  bool hiddenByGlacier() {
    vec3 ice = glacierAt(iPos);
    return ice.x > 0.5 || iVar.y > ice.z;
  }
  // A gust front's envelope where it has reached: a quick rise, then a
  // settle over decay seconds (the shape of ridgeKickEnv).
  float gustEnv(float age, float decay) {
    if (age < 0.0) return 0.0;
    return age < ${GUST_ATTACK_SEC.toFixed(3)} ? age / ${GUST_ATTACK_SEC.toFixed(3)} : exp(-(age - ${GUST_ATTACK_SEC.toFixed(3)}) / decay);
  }
  // How the passing fronts press on this tree: x the signed lean (slow
  // settle, along each front's way), y the sheen (only the front itself,
  // so it reads as a moving band). A front sweeps across the frame in
  // GUST_SWEEP_SEC, so where a tree stands on screen, not how far away it
  // is, decides when it arrives.
  vec2 gustAt() {
    vec4 c = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
    float sx = clamp(c.x / max(c.w, 1e-3), -1.2, 1.2);
    float lean = 0.0, sheen = 0.0;
    for (int i = 0; i < ${GUST_FRONTS}; i++) {
      float age = uGustAge[i] - ((sx * uGustDir[i]) * 0.5 + 0.5) * ${GUST_SWEEP_SEC.toFixed(3)} - iVar.y * 0.06;
      lean += uGustDir[i] * gustEnv(age, ${GUST_DECAY_SEC.toFixed(3)}) * uGustAmp[i];
      sheen = max(sheen, gustEnv(age, ${GUST_SHEEN_DECAY_SEC.toFixed(3)}) * uGustAmp[i]);
    }
    return vec2(clamp(lean, -1.0, 1.0), sheen);
  }
  vec2 windAt(float y01) {
    float ph = iVar.y * 6.2831;
    float s = sin(uTime * 0.65 + ph) * 0.6 + sin(uTime * 1.45 + ph * 1.7) * 0.25;
    vec2 sway = vec2(s, s * 0.4) * 0.012;
    // The gust leans crowns the way the front travels (camera right in xz).
    vec2 gust = gustAt();
    vec2 away = iPos.xz - uParting.xy;
    float dAway = length(away);
    float part = uParting.w * (1.0 - smoothstep(uParting.z * 0.3, uParting.z, dAway));
    vGust = max(gust.y, part * 0.8);
    vec2 lean = normalize(vec2(viewMatrix[0][0], viewMatrix[2][0]) + 1e-5) * gust.x * ${GUST_LEAN.toFixed(3)};
    lean += away / max(dAway, 1.0) * part * ${PARTING_LEAN.toFixed(3)};
    return (sway + lean) * iSize.x * y01 * y01;
  }
`;

const MESH_VERT = /* glsl */`
  invariant gl_Position;
  ${TREE_COMMON}
  in vec4 aBranch;
  out vec4 vBranch;
  out vec3 vNormal;
  out float vOcc;
  void main() {
    // Hidden trees avoid all profile, wind and gust work in both passes.
    if (iVar.y > uForestKeep || hiddenByGlacier()) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
    }
    vec3 root = rootOf();
    float base = crownBase(iVar.x, iVar.y);
    float y01 = aBranch.w > .5 ? base + (1.0 - base) * position.y : position.y;
    // One rotation per tree keeps the authored spacing between sprays;
    // each branch then swings a little on its own.
    float angle = 6.283185 * fract(sin(iVar.y * 127.1) * 43758.5453)
      + (fract(sin(iVar.y * 91.7 + aBranch.x * 311.7) * 43758.5453) - .5) * .7 * aBranch.w;
    vec2 radial = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * position.xz;
    float jitter = mix(.85, 1.15, fract(sin(iVar.y * 269.5 + aBranch.x * 183.3) * 43758.5453));
    float side = radial.x < 0.0 ? -1.0 : 1.0;
    float radius = crownHalfWidth(iVar.x, y01, iVar.y, side) / crownRatio(iVar.x) * iSize.y * jitter;
    vec2 xz = radial * (aBranch.w > .5 ? radius : (.12 + .14 * iVar.y) * (1.0 - .94 * y01));
    vec2 w = windAt(y01);
    vec3 p = root + vec3(xz.x + w.x, y01 * iSize.x, xz.y + w.y);
    vWorld = p;
    vLocal = vec2(position.x, y01);
    vVar = iVar.x; vId = iVar.y;
    vec2 nr = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * normal.xz;
    vNormal = normalize(vec3(nr.x, aBranch.w > .5 ? normal.y : .005, nr.y));
    vBranch = aBranch;
    // Crown self-occlusion: foliage near the stem and low in the crown sits
    // inside the canopy and sees less sky and sun than the outer sprays.
    float outer = smoothstep(.05, .85, length(position.xz));
    vOcc = aBranch.w > .5 ? mix(.5, 1.0, outer) * mix(.82, 1.0, smoothstep(.1, .9, position.y)) : .75;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const BOARD_VERT = /* glsl */`
  invariant gl_Position;
  ${TREE_COMMON}
  out vec3 vRight;
  out vec3 vToCam;
  out vec2 vSize;
  uniform vec2 uViewportPx;
  void main() {
    if (iVar.y > uForestKeep || hiddenByGlacier()) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
    }
    vec3 root = rootOf();
    vec3 toCam = uCameraPos - root;
    toCam.y = 0.0;
    toCam = normalize(toCam);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    float y01 = position.y;
    vec2 w = windAt(y01);
    vec3 centre = root + vec3(w.x, position.y * iSize.x, w.y);
    vec4 clip = projectionMatrix * viewMatrix * vec4(centre, 1.0);
    float widthPx = iSize.y * projectionMatrix[1][1] * .5 * uViewportPx.y / max(clip.w, .001);
    // Reserve a pixel on each side for the silhouette footprint filter.
    // Its tent kernel preserves crown area as narrow trees cross pixels.
    float grow = max(2.0, widthPx + 2.0) / max(widthPx, .001);
    vec3 p = centre + right * position.x * iSize.y * grow;
    vWorld = p;
    vLocal = vec2(position.x * grow, position.y);
    vSize = iSize;
    vVar = iVar.x; vId = iVar.y;
    vRight = right; vToCam = toCam;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const SHADE = /* glsl */`
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uSkyZenith;
  uniform vec3 uSkyHorizon;
  uniform vec3 uAirColor;
  uniform float uAirDensity;
  uniform float uAirHeightFalloff;
  uniform float uAmbientScale;
  uniform float uSolarTransmission;
  uniform float uExposure;
  uniform vec3 pForestNear;
  uniform vec3 pForestFar;
  uniform float uDiag;
  uniform vec4 uNarrative;
  uniform vec4 uStorm;
  uniform mat4 uViewProj;
  uniform float uTime;
  in float vGust;
  ${ACTOR_GLSL}
  ${MIST_GLSL}
  ${STORM_GLSL}
  vec3 tonemap(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  // Crown self-occlusion of the fragment being shaded (1 = open).
  float gTreeOcc = 1.0;
  vec4 shadeTree(vec3 n, vec3 world, float core) {
    float dist = length(world - uCameraPos);
    vec3 base = mix(pForestNear, pForestFar, smoothstep(1500.0, 12000.0, dist));
    base *= 0.8 + 0.4 * fract(vVar * 0.37 + vId * 3.1) ;
    #if defined(BOARD_CROWN) || defined(MESH_CROWN)
      vec3 tint = vVar < .5 ? vec3(1.04, 1.02, .94) : vVar < 1.5 ? vec3(.95, 1.01, 1.06) : vVar < 2.5 ? vec3(.94, .94, .98) : vec3(.98, 1.01, .96);
      base *= tint * mix(.65, 1.0, smoothstep(.1, .85, vLocal.y)) * mix(1.0, .78, core);
    #else
      base *= mix(0.55, 1.0, core);
    #endif
    // Tips catch the sky: crowns read against the forest behind them.
    #if defined(BOARD_CROWN) || defined(MESH_CROWN)
      base *= 1.0 + .12 * smoothstep(.55, .95, vLocal.y);
    #else
      base *= 1.0 + 0.5 * smoothstep(0.55, 0.95, vLocal.y);
    #endif
    float wrap = 0.3;
    float key = max((dot(n, uLightDir) + wrap) / (1.0 + wrap), 0.0);
    vec3 hemi = mix(uSkyHorizon * 0.55, uSkyZenith, 0.5 + 0.5 * n.y) * uAmbientScale;
    vec3 lit = base * (hemi * (0.55 + 0.45 * core) * gTreeOcc + uLightColor * key * mix(.6, 1.0, gTreeOcc));
    lit += base * actorLight(world, n);
    float giantShade = broshiShadow(world);
    lit *= 1.0 - giantShade * .78;
    // As the storm breaks, the same sunlit swathes as the ground beneath.
    float opening = stormOpening(world);
    lit *= 1.0 - uStorm.z * (1.0 - opening) * 0.5;
    lit += base * uLightColor * key * uStorm.z * opening * 0.85;
    // Thin crown edges transmit a solar backlight. Both real conifers and
    // alpha-tested silhouettes use their own normal/core with this shared
    // response; key radiance already contains visibility exactly once.
    vec3 toViewer = normalize(uCameraPos - world);
    float backlight = pow(max(dot(-uLightDir, toViewer), 0.0), 2.0);
    float backface = max(-dot(n, uLightDir), 0.0);
    float crown = smoothstep(0.15, 0.8, vLocal.y);
    float thin = mix(0.35, 1.0, 1.0 - core);
    lit += base * uLightColor * (uSolarTransmission * backlight * backface * crown * thin);
    // A passing gust turns the crowns' pale sides up to the sky and key
    // light. Added rather than scaled, so it reads at night too.
    lit += (uSkyHorizon * uAmbientScale * 0.5 + uLightColor * 0.5) * (${GUST_SHEEN.toFixed(3)} * vGust * crown);
    float heightTerm = exp(-max(0.0, world.y - uCameraPos.y * 0.25) * uAirHeightFalloff);
    float air = 1.0 - exp(-dist * uAirDensity * (0.35 + 0.65 * heightTerm));
    vec3 color = mix(tonemap(lit * uExposure), mistColorAt(uCameraPos, world), mistAmount(uCameraPos, world));
    color = mix(color, uAirColor, clamp(air, 0.0, 0.96));
    color = mix(color, rainColor(), rainVeil(world, dist) * 0.8);
    if (uDiag > 0.5) return vec4(1.0, 0.0, 1.0, 1.0);
    color = mix(uSkyHorizon, color, uNarrative.z);
    // As on the ground: his shadow dims the haze in front of the trees too.
    color *= 1.0 - giantShade * (.5 + .3 * clamp(air, 0.0, 1.0));
    return vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
  }
`;

const MESH_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uCameraPos;
  in vec3 vWorld; in vec2 vLocal; in float vVar; in float vId; in vec3 vNormal; in vec4 vBranch; in float vOcc;
  out vec4 outColor;
  ${SHADE}
  MESH_COVERAGE
  void main() {
    gTreeOcc = vOcc;
    float cov = meshCoverage();
    // Every quad lane contributes before coverage can terminate a fragment.
    float phase = vBranch.y * 6.283185 * 8.0 + vBranch.x * 11.0 + vId * 31.0;
    float detail = 1.0 - smoothstep(.25, .5, fwidth(phase) / 6.283185);
    #ifdef FOREST_CORE
      if (cov < 254.5 / 255.0) discard;
      cov = 1.0;
    #elif defined(FOREST_BLEND)
      if (cov < 1.0 / 255.0) discard;
      // Solid interiors were already depth-tested and drawn in layer zero.
      if (cov >= 254.5 / 255.0) discard;
    #else
      if (cov < .5) discard;
      cov = 1.0;
    #endif
    vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    n = normalize(n + .08 * detail * sin(phase) * vec3(1.0, .3, -.7) * vBranch.w);
    float core = mix(.75, .9 - .4 * vBranch.z, vBranch.w);
    vec3 color = shadeTree(n, vWorld, core).rgb;
    #ifdef FOREST_DEBUG
      color = vec3(1.0, 0.0, 0.0);
    #endif
    outColor = vec4(color * cov, cov);
  }
`;

const SILHOUETTE = /* glsl */`
  ${CROWN_GLSL}
  // Integral of the unit-radius triangular screen-space footprint.
  float footprintCDF(float x) {
    float t = clamp(x, -1.0, 1.0);
    return t < 0.0 ? .5 * (t + 1.0) * (t + 1.0) : 1.0 - .5 * (1.0 - t) * (1.0 - t);
  }
  float treeCoverage(vec2 l, out float core, out float side) {
    float dv = fwidth(l.y), fw = max(fwidth(l.x), .000001);
    // Preserve placed dimensions here; elevation/proportion traits are Phase 2.
    float scale = 1.0 / crownRatio(vVar);
    float left = crownHalfWidthFiltered(vVar, l.y, vId, -1.0, dv) * scale;
    float right = crownHalfWidthFiltered(vVar, l.y, vId, 1.0, dv) * scale;
    // A physical bole, especially below the lodgepole's high crown.
    float bole = (.12 + .14 * vId) / max(vSize.y, .001)
      * (1.0 - smoothstep(crownBase(vVar, vId), crownBase(vVar, vId) + .035, l.y));
    left = max(left, bole); right = max(right, bole);
    float hw = l.x < 0.0 ? left : right;
    // Integrate edges at every width: resolving a crown's lighting does not
    // stop its outline from crossing pixel boundaries.
    float filtered = footprintCDF((right - l.x) / fw) - footprintCDF((-left - l.x) / fw);
    float widthPx = (left + right) / fw;
    // Keep mean lighting while the cross-section is only a few pixels wide.
    float resolved = smoothstep(4.0, 8.0, widthPx);
    // An unresolved pixel sees the crown's mean, not a flashing flank normal.
    core = mix(.5, clamp(1.0 - abs(l.x) / max(hw, .001), 0.0, 1.0), resolved);
    side = clamp(l.x / max(hw, .001), -1.0, 1.0) * resolved;
    return filtered;
  }
`;

const BOARD_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uCameraPos;
  in vec3 vWorld; in vec2 vLocal; in float vVar; in float vId; in vec3 vRight; in vec3 vToCam; in vec2 vSize;
  out vec4 outColor;
  ${SHADE}
  ${SILHOUETTE}
  void main() {
    float core, side;
    float cov = treeCoverage(vLocal, core, side);
    #ifdef FOREST_BLEND
      if (cov < 1.0 / 255.0) discard;
    #else
      if (cov < .5) discard;
      cov = 1.0;
    #endif
    float tilt = vVar < .5 ? .25 : vVar < 1.5 ? .4 : vVar < 2.5 ? .25 : .5;
    vec3 n = normalize(vRight * side + vec3(0.0, tilt, 0.0) + vToCam * sqrt(max(0.0, 1.0 - side * side)));
    vec3 color = shadeTree(n, vWorld, core).rgb;
    #ifdef FOREST_DEBUG
      color = vec3(0.0, 0.0, 1.0);
    #endif
    outColor = vec4(color * cov, cov);
  }
`;

const BOARD_DEPTH_FRAG = /* glsl */`
  precision highp float;
  in vec3 vWorld; in vec2 vLocal; in float vVar; in float vId; in vec3 vRight; in vec3 vToCam; in vec2 vSize;
  out vec4 outColor;
  ${SILHOUETTE}
  void main() { float core, side; if (treeCoverage(vLocal, core, side) < .5) discard; outColor = vec4(0.0); }
`;
const MESH_DEPTH_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uCameraPos;
  in vec3 vWorld; in vec3 vNormal; in vec4 vBranch; in float vId;
  out vec4 outColor;
  MESH_COVERAGE
  void main() {
    #ifdef FOREST_CORE
      if (meshCoverage() < 254.5 / 255.0) discard;
    #else
      if (meshCoverage() < .5) discard;
    #endif
    outColor = vec4(0.0);
  }
`;

// Both twins use exactly the same normal and branch-coordinate coverage.
const MESH_COVERAGE = /* glsl */`
  float meshCoverage() {
    vec3 n = normalize(vNormal), eye = normalize(uCameraPos - vWorld);
    float facing = dot(n, eye);
    // The trunk's silhouette fades where it turns edge-on. Foliage sprays
    // are thin cards: their outline is the ragged contour below instead.
    float edge = mix(clamp(abs(facing) / max(fwidth(facing), .000001), 0.0, 1.0), 1.0, vBranch.w);
    float phase = vBranch.y * 6.283185 * 12.0 + vBranch.x * 13.0 + vId * 23.0;
    float detail = 1.0 - smoothstep(.25, .5, fwidth(phase) / 6.283185);
    // Needle tufts: an irregular serrated edge (two incommensurate
    // periods), deeper on the sprays than on the trunk.
    float tuft = (.5 + .5 * sin(phase)) * (.55 + .45 * sin(phase * .37 + vBranch.x * 29.0 + vId * 7.0));
    float cut = 1.0 - mix(.14, .26, vBranch.w) * detail * tuft;
    float fringe = clamp(.5 + (cut - vBranch.z) / max(fwidth(vBranch.z), .000001), 0.0, 1.0);
    return edge * mix(1.0, fringe, vBranch.w);
  }
`;

// Current catalog: 557,808 typed bytes, largest asset 92,952 bytes.
// Allow 8 MiB for JS numeric-array growth, typed conversion and position /
// normal / branch copies while assets are built. This is an accounting
// allowance, not a measurement of a JavaScript engine or driver heap.
export const FOREST_ASSET_BUILD_BYTES = 8 * 1024 ** 2;
export const forestGroupingBytes = count => count * 16 + 64 * 1024;

/** A near conifer asset (ForestSpeciesAssets.js) as indexed geometry; the
 *  vertex shader maps its coordinates to each tree's species and size. */
export function coniferGeometry(THREE, { lod = 1, family = 1, variant = 0 } = {}) {
  const a = buildConiferAsset({ family, variant, lod });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(a.normal, 3));
  geo.setAttribute('aBranch', new THREE.Float32BufferAttribute(a.branch, 4));
  geo.setIndex(new THREE.BufferAttribute(a.index, 1));
  geo.userData.asset = a.stats;
  return geo;
}

export function billboardGeometry(THREE) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  return geo;
}

/** A second representation of an instanced batch: the same per-instance
 *  attributes (no extra bytes, same trees) over another base asset. */
function reinstanced(THREE, base, source) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  for (const [k, v] of Object.entries(base.attributes)) geo.setAttribute(k, v);
  for (const k of ['iPos', 'iSize', 'iVar']) geo.setAttribute(k, source.attributes[k]);
  geo.instanceCount = source.instanceCount;
  return geo;
}

/** Instanced geometry for a subset of placed trees. */
function instanced(THREE, base, instances, stride, indices) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  for (const [k, v] of Object.entries(base.attributes)) geo.setAttribute(k, v);
  const n = indices.length;
  const p = new Float32Array(n * 3), s = new Float32Array(n * 2), v = new Float32Array(n * 2);
  indices.forEach((i, k) => {
    const o = i * stride;
    p[k * 3] = instances[o]; p[k * 3 + 1] = instances[o + 1]; p[k * 3 + 2] = instances[o + 2];
    s[k * 2] = instances[o + 3]; s[k * 2 + 1] = instances[o + 4];
    v[k * 2] = instances[o + 5]; v[k * 2 + 1] = instances[o + 6];
  });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(p, 3));
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(s, 2));
  geo.setAttribute('iVar', new THREE.InstancedBufferAttribute(v, 2));
  geo.instanceCount = n;
  return { geo, bytes: p.byteLength + s.byteLength + v.byteLength };
}

/**
 * Forest objects per band. `uniforms` are the terrain's (shared light,
 * air, deformation, palette); forest adds uTime (heard seconds, for wind),
 * uGustAge/uGustAmp/uGustDir (the kicks' gust fronts)
 * and uForestKeep (the quality rung's stable fraction, applied per id in
 * the vertex shader, so a rung change never rebuilds the forest).
 * Returns { byBand: { far: [...Mesh], mid, near }, depth: [...Mesh],
 * depthByBand: { far, mid, near } (depth meshes per band), bytes, counts, dispose }.
 */
export function createForest(THREE, placed, uniforms, { partitioned = true, forestDebug = false } = {}) {
  const u = { ...uniforms, uTime: uniforms.uTime || { value: 0 }, uForestKeep: uniforms.uForestKeep || { value: 1 },
    uStorm: uniforms.uStorm || { value: new THREE.Vector4() }, uRainShift: uniforms.uRainShift || { value: 0 },
    uViewProj: uniforms.uViewProj || { value: new THREE.Matrix4() },
    uViewportPx: uniforms.uViewportPx || { value: new THREE.Vector2(1, 1) },
    ...(uniforms.uGustAge ? {} : gustUniforms()), ...(uniforms.uActorPos ? {} : actorUniforms(THREE)) };
  const mat = (vert, frag, depth = false) => {
    const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms: u });
    if (forestDebug && !depth) m.defines.FOREST_DEBUG = 1;
    if (depth) m.colorWrite = false;
    else if (partitioned) { m.depthFunc = THREE.LessEqualDepth; m.depthWrite = false; }
    return m;
  };
  const materials = {
    mesh: mat(`${CROWN_GLSL}\n${MESH_VERT}`, MESH_FRAG.replace('MESH_COVERAGE', MESH_COVERAGE)),
    meshDepth: mat(`${CROWN_GLSL}\n${MESH_VERT}`, MESH_DEPTH_FRAG.replace('MESH_COVERAGE', MESH_COVERAGE), true),
    meshCore: mat(`${CROWN_GLSL}\n${MESH_VERT}`, MESH_FRAG.replace('MESH_COVERAGE', MESH_COVERAGE)),
    meshCoreDepth: mat(`${CROWN_GLSL}\n${MESH_VERT}`, MESH_DEPTH_FRAG.replace('MESH_COVERAGE', MESH_COVERAGE), true),
    board: mat(BOARD_VERT, BOARD_FRAG), boardDepth: mat(BOARD_VERT, BOARD_DEPTH_FRAG, true),
  };
  materials.board.defines.BOARD_CROWN = 1;
  materials.mesh.defines.MESH_CROWN = 1;
  materials.meshCore.defines.MESH_CROWN = 1;
  materials.meshCore.defines.FOREST_CORE = 1; materials.meshCoreDepth.defines.FOREST_CORE = 1;
  if (partitioned) {
    for (const m of [materials.mesh, materials.board]) {
      m.defines.FOREST_BLEND = 1;
      m.transparent = true; m.premultipliedAlpha = true; m.blending = THREE.CustomBlending;
      m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
      m.blendSrc = m.blendSrcAlpha = THREE.OneFactor;
      m.blendDst = m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
  }
  for (const m of Object.values(materials)) m.side = THREE.DoubleSide;
  // Base assets are built only for the (lod, family, variant) batches a
  // forest actually uses, and shared by every instance batch of that kind.
  const bases = new Map();
  const assetFor = (lod, family, variant) => {
    const key = `${lod}:${family}:${variant}`;
    if (!bases.has(key)) bases.set(key, coniferGeometry(THREE, { lod, family, variant }));
    return bases.get(key);
  };
  const baseBoard = billboardGeometry(THREE);
  const byBand = { far: [], mid: [], near: [] }, depth = [], depthByBand = { far: [], mid: [], near: [] }, geos = [];
  const bandName = ['far', 'mid', 'near'];
  let bytes = 0;
  const counts = { meshDetail: 0, mesh: 0, billboard: 0 };
  const batches = { meshDetail: 0, mesh: 0, billboard: 0 };
  // nearLod: 'detail' / 'lite' tags the detail ring's two representations
  // (setNearDetail shows one); null for everything else.
  const addBatch = (kind, base, data, idx, b, colorMat, depthMat, { from = null, nearLod = null } = {}) => {
    let geo;
    if (from) geo = reinstanced(THREE, base, from);
    else {
      const built = instanced(THREE, base, data, placed.stride, idx);
      geo = built.geo;
      bytes += built.bytes;
      counts[kind] += idx.length;
      batches[kind]++;
    }
    geos.push(geo);
    const tag = (mesh) => { if (nearLod) { mesh.userData.nearLod = nearLod; mesh.visible = nearLod === 'detail'; } return mesh; };
    if (partitioned && kind !== 'billboard') {
      // Instanced objects cannot sort individual trees. Restore their solid
      // interiors before soft edges, including self-occluding branch skirts.
      const core = tag(new THREE.Mesh(geo, materials.meshCore)); core.frustumCulled = false;
      const coreDepth = tag(new THREE.Mesh(geo, materials.meshCoreDepth)); coreDepth.frustumCulled = false;
      const bandDepth = tag(new THREE.Mesh(geo, materials.meshCoreDepth)); bandDepth.frustumCulled = false;
      byBand[bandName[b]].push(core); depth.push(coreDepth); depthByBand[bandName[b]].push(bandDepth);
    }
    const m = tag(new THREE.Mesh(geo, colorMat)); m.frustumCulled = false;
    if (partitioned) { m.renderOrder = 1; m.layers.set(1); }
    const d = tag(new THREE.Mesh(geo, depthMat)); d.frustumCulled = false;
    if (partitioned) d.layers.set(2);
    byBand[bandName[b]].push(m);
    depth.push(d);
    // A second depth mesh (same geometry and material) for the band's own
    // depth scene: a mesh has one parent scene.
    const db = tag(new THREE.Mesh(geo, depthMat)); db.frustumCulled = false;
    if (partitioned) db.layers.set(2);
    depthByBand[bandName[b]].push(db);
    return geo;
  };
  for (const [kind, data, lod, colorMat, depthMat] of [
    ['meshDetail', placed.meshDetail || new Float32Array(), 0, materials.mesh, materials.meshDepth],
    ['mesh', placed.mesh, 1, materials.mesh, materials.meshDepth],
    ['billboard', placed.billboard, null, materials.board, materials.boardDepth],
  ]) {
    const n = data.length / placed.stride;
    for (let b = 0; b < 3; b++) {
      if (lod == null) {
        const idx = [];
        for (let i = 0; i < n; i++) if (data[i * placed.stride + 7] === b) idx.push(i);
        if (idx.length) addBatch(kind, baseBoard, data, idx, b, colorMat, depthMat);
        continue;
      }
      // One instanced batch per species family and variant: the tree's id
      // picks its variant, its species the family (never per-frame).
      const groups = Array.from({ length: FOREST_FAMILIES * FOREST_VARIANTS }, () => []);
      for (let i = 0; i < n; i++) {
        const o = i * placed.stride;
        if (data[o + 7] !== b) continue;
        groups[familyFor(data[o + 5]) * FOREST_VARIANTS + variantFor(data[o + 6])].push(i);
      }
      groups.forEach((idx, g) => {
        if (!idx.length) return;
        const family = Math.floor(g / FOREST_VARIANTS), variant = g % FOREST_VARIANTS;
        if (lod !== 0) { addBatch(kind, assetFor(lod, family, variant), data, idx, b, colorMat, depthMat); return; }
        const geo = addBatch(kind, assetFor(0, family, variant), data, idx, b, colorMat, depthMat, { nearLod: 'detail' });
        addBatch(kind, assetFor(1, family, variant), data, idx, b, colorMat, depthMat, { from: geo, nearLod: 'lite' });
      });
    }
  }
  const assets = [...bases.values()].map(g => g.userData.asset);
  const every = [...Object.values(byBand).flat(), ...depth, ...Object.values(depthByBand).flat()];
  const forest = {
    byBand, depth, depthByBand, bytes, counts, batches, assets, uniforms: u, nearDetail: true, shown: true,
    /** Whether trees draw at all (`shown`) and which detail-ring
     *  representation does (`nearDetail`: full assets, else the lighter
     *  ones). Every forest mesh's visibility is decided here, so the two
     *  representations never draw together. */
    applyVisibility({ shown = forest.shown, nearDetail = forest.nearDetail } = {}) {
      forest.shown = !!shown; forest.nearDetail = !!nearDetail;
      for (const m of every) m.visible = forest.shown && (!m.userData.nearLod || (m.userData.nearLod === 'detail') === forest.nearDetail);
    },
    setNearDetail(detail) { forest.applyVisibility({ nearDetail: detail }); },
    dispose: () => { for (const g of geos) g.dispose(); for (const g of bases.values()) g.dispose(); baseBoard.dispose(); for (const m of Object.values(materials)) m.dispose(); },
  };
  return forest;
}
