// Compiled terrain experiment: GPU objects for a decoded pack
// (CompiledTerrain.js). One indexed mesh per chunk, frustum-culled against
// swell-padded bounds, drawn into the existing band scenes and depth
// pre-pass. The material is deliberately light: the baked albedo and
// occlusion from the pack's atlas (one texel per column for columns, filtered
// between lattice vertices for the control), a wrap-diffuse key with the
// production GGX lobe (wet ground glints under rain), storm shadow and
// clearing, the cast's light, the sky hemisphere, exposure, tonemap, the
// cinematic grade, the narrative fades, valley mist without its bank
// ray-march, distance air and the rain veil, all from the scene's live
// uniforms. Not reproduced: the baked horizon shadow, cloud shadows, rock and
// snow detail normals, far-forest dots and silhouette ink.
// `THREE` is the local bundle (src/vendor/range), passed in.
import { DEFORM_GLSL, GROUND_LIFT_GLSL } from './TerrainDeform.js';
import { MIST_GLSL, MIST_OCTAVE_MEAN } from './RangeAtmosphere.js';
import { ACTOR_GLSL } from './ActorsGL.js';
import { TERRAIN_LIGHTING_GLSL } from './TerrainLighting.js';
import { STORM_GLSL } from './RangeStorm.js';
import { CINEMATIC_LIGHTING_GLSL } from './CinematicLighting.js';
import { DEPTH_FRAG } from './TerrainMaterial.js';
import { BANDS } from './TerrainMesh.js';
import { LAND_MAX_DISPLACEMENT_M } from './LandMotionLimits.js';
import { COMPILED_Y_UNIT_M, COMPILED_ATLAS_SCALE, compiledBandPlan, compiledReceiverMask } from './CompiledTerrain.js';

/** Same displacement as SCENE_VERT (glacier + land swell, evaluated at the
 *  source position), so forest roots and the cast stay on the drawn land.
 *  Shared verbatim by the colour, depth and ownership passes. */
export const COMPILED_VERT = /* glsl */`
  invariant gl_Position;
  ${DEFORM_GLSL}
  in vec4 compiledNormal;
  in vec2 compiledAtlas;
  out vec3 vRenderedWorld;
  out vec3 vNormal;
  centroid out vec2 vAtlas;
  void main() {
    vec3 source = (modelMatrix * vec4(position.x, position.y * ${COMPILED_Y_UNIT_M.toFixed(3)}, position.z, 1.0)).xyz;
    vec3 ice = glacierAt(source);
    vec3 p = source;
    p.y += ice.x + deformAt(source) * (1.0 - ice.y);
    vRenderedWorld = p;
    vNormal = compiledNormal.xyz;
    vAtlas = compiledAtlas * ${(1 / COMPILED_ATLAS_SCALE).toFixed(4)};
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

// Mist banks averaged out, as SCENE_FRAG's ray-march converges to on long
// rays (every octave at its mean): smoothstep(.35, .75, MIST_OCTAVE_MEAN).
const MIST_BANK_MEAN = (() => { const t = Math.min(1, Math.max(0, (MIST_OCTAVE_MEAN - .35) / .4)); return t * t * (3 - 2 * t); })();

export const COMPILED_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uSkyZenith;
  uniform vec3 uSkyHorizon;
  uniform vec3 uAirColor;
  uniform float uAirDensity;
  uniform float uAirHeightFalloff;
  uniform vec3 uCameraPos;
  uniform float uAmbientScale;
  uniform float uMoonAmbientScale;
  uniform float uExposure;
  uniform float uTime;
  uniform vec4 uStorm;
  uniform vec4 uNarrative;
  uniform float uClipBelow;
  uniform float uWaterOnly;
  uniform float uDiag;
  uniform sampler2D uCompiledAtlas;
  uniform vec2 uCompiledAtlasSize;
  ${DEFORM_GLSL}
  ${GROUND_LIFT_GLSL}
  ${MIST_GLSL}
  ${ACTOR_GLSL}
  ${TERRAIN_LIGHTING_GLSL}
  ${STORM_GLSL}
  ${CINEMATIC_LIGHTING_GLSL}
  in vec3 vRenderedWorld;
  in vec3 vNormal;
  centroid in vec2 vAtlas;
  out vec4 outColor;
  vec3 srgbToLinearExact(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
  vec3 linearToSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
  vec3 tonemap(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  void main() {
    if (vRenderedWorld.y < uClipBelow) discard;
    // The packs carry no terrain water: the water-only pass draws nothing.
    if (uWaterOnly > 0.5) discard;
    vec3 n = normalize(vNormal);
    #ifdef COMPILED_COLUMNS
    // The owning column's texel: a side sits on its column's edge, so step
    // half a texel back inside along the face normal.
    ivec2 cell = clamp(ivec2(floor(vAtlas - 0.5 * n.xz)), ivec2(0), ivec2(uCompiledAtlasSize) - 1);
    vec4 texel = texelFetch(uCompiledAtlas, cell, 0);
    #else
    vec4 texel = texture(uCompiledAtlas, (vAtlas + 0.5) / uCompiledAtlasSize);
    #endif
    float ao = texel.a;
    bool cinematic = uCinematic.x > .5;
    // SCENE_FRAG's lighting with sunVis and cloud transmission at 1 (no
    // baked horizon, no cloud shadows) and the face normal as nShade.
    float wrap = cinematic ? uCinematic.w : 0.18;
    float keyOn = step(1e-10, dot(uLightColor, uLightColor));
    float key = max((dot(n, uLightDir) + wrap) / (1.0 + wrap), 0.0) * keyOn;
    vec3 albedo = srgbToLinearExact(texel.rgb) * (1.0 - uStorm.w * .18);
    // Rain wets the ground: production's roughness drop and GGX lobe.
    float rough = mix(0.9, 0.36, uStorm.w);
    float dist = length(vRenderedWorld - uCameraPos);
    vec3 V = (uCameraPos - vRenderedWorld) / max(dist, 1e-3);
    vec2 spec = terrainSpecular(n, V, uLightDir, rough, materialF0(0.0, 0.0));
    key *= 1.0 - spec.y;
    float opening = stormOpening(vRenderedWorld);
    float receiverShadow = stormShadow(opening);
    vec3 hemi = mix(uSkyHorizon * 0.55, uSkyZenith, 0.5 + 0.5 * n.y) * stormAmbient(uAmbientScale, uMoonAmbientScale, opening);
    if (cinematic) hemi = cinematicFill(hemi, key);
    hemi = receiverFill(hemi, uReceiverFillMin);
    vec3 keyColor = cinematic ? cinematicKey(uLightColor) : uLightColor;
    vec3 lit = albedo * (hemi * ao + keyColor * key * mix(0.85, 1.0, ao) * receiverShadow);
    lit += albedo * actorLight(vRenderedWorld, n) * receiverShadow;
    lit += albedo * uLightColor * key * uStorm.z * opening * .85;
    float keyGain = (1.0 - uStorm.z * (1.0 - opening) * .5) + uStorm.z * opening * .85;
    lit += uLightColor * spec.x * keyOn * keyGain * (1.0 - .75 * uStorm.y);
    float heightTerm = exp(-max(0.0, vRenderedWorld.y - uCameraPos.y * 0.25) * uAirHeightFalloff);
    float air = 1.0 - exp(-dist * uAirDensity * (0.35 + 0.65 * heightTerm));
    vec3 neutral = vec3(.42) * (.45 + .55 * key);
    vec3 physical = mix(neutral, tonemap(lit * uExposure), uNarrative.z);
    if (cinematic) physical = cinematicGrade(physical);
    vec3 color = mix(uSkyHorizon, physical, uNarrative.x);
    // Valley mist: the production layer integral, banks at their mean.
    vec3 ray = vRenderedWorld - uCameraPos;
    float mist = uMistDensity > 0.0
      ? (1.0 - exp(-uMistDensity * dist * mistMeanLayer(uCameraPos.y, vRenderedWorld.y) * ${MIST_BANK_MEAN.toFixed(4)})) * uNarrative.y : 0.0;
    vec3 mistColor = mistColorAt(uCameraPos, vRenderedWorld), airColor = uAirColor;
    if (cinematic) {
      mist = cinematicMistAmount(mist, dist, uMistFill);
      air = cinematicAirAmount(dist, heightTerm, uAirDensity);
      mistColor = cinematicMistColor(mistColor, uSkyZenith, dist);
      airColor = cinematicMistColor(airColor, uSkyZenith, dist);
    }
    mistColor = min(mistColor + uLightColor * 0.07 * mistPhase(ray / max(dist, 1e-3), uLightDir) * (1.0 - uStorm.x), vec3(0.9));
    color = mix(color, mistColor, mist);
    color = mix(color, airColor, clamp(air, 0.0, 0.96) * uNarrative.y);
    color = mix(color, rainColor(), rainVeil(vRenderedWorld, dist) * 0.8 * uNarrative.y);
    outColor = vec4(linearToSrgb(color), 1.0);
    if (uDiag > 0.5) outColor = vec4(1.0, 0.0, 1.0, 1.0);
  }
`;

export function createCompiledMaterial(THREE, uniforms, representation) {
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: COMPILED_VERT, fragmentShader: COMPILED_FRAG, uniforms });
  if (representation === 'columns') m.defines.COMPILED_COLUMNS = 1;
  m.depthFunc = THREE.LessEqualDepth;
  m.depthWrite = false;
  m.userData.compiledTerrain = representation;
  return m;
}

/** Depth-only twin: the identical (invariant) vertex transform. */
export function createCompiledDepthMaterial(THREE, uniforms) {
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: COMPILED_VERT, fragmentShader: DEPTH_FRAG, uniforms });
  m.colorWrite = false;
  return m;
}

/** Full-grid R8 receiver texture (the swell's water pinning); its CPU copy
 *  is dropped after upload, as the production surface's is. */
export function createCompiledReceiver(THREE, pack) {
  const mask = compiledReceiverMask(pack);
  const tex = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.onUpdate = () => { tex.image = { data: null, width: mask.width, height: mask.height }; tex.onUpdate = null; };
  return { texture: tex, bytes: mask.data.byteLength };
}

/** The pack's material atlas (sRGB8 albedo + AO8). Columns read single
 *  texels; the control filters between its vertex texels. No mips: tiles
 *  sit side by side. The CPU copy is dropped after upload. */
export function createCompiledAtlas(THREE, pack) {
  const { width, height, texels } = pack.atlas;
  const tex = new THREE.DataTexture(texels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = pack.manifest.representation === 'columns' ? THREE.NearestFilter : THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.onUpdate = () => { tex.image = { data: null, width, height }; tex.onUpdate = null; };
  return { texture: tex, bytes: texels.byteLength };
}

/** terrainUniforms (TerrainGL.js) for a pack: the receiver over the source
 *  grid and the production package's height range, so the swell matches. */
export function compiledTerrainUniforms(THREE, pack, receiver, atlas) {
  const g = pack.manifest.source.grid;
  const [lo, hi] = pack.manifest.deform.heightRangeM;
  return {
    uSurface: { value: null },
    uReceiver: { value: receiver.texture },
    uTexel: { value: new THREE.Vector2(1 / g.width, 1 / g.height) },
    uGridOrigin: { value: new THREE.Vector2(g.originM[0], g.originM[1]) },
    uGridExtent: { value: new THREE.Vector2((g.width - 1) * g.cellSizeM, (g.height - 1) * g.cellSizeM) },
    uHeightRange: { value: new THREE.Vector2(lo, hi) },
    uCompiledAtlas: { value: atlas.texture },
    uCompiledAtlasSize: { value: new THREE.Vector2(pack.atlas.width, pack.atlas.height) },
  };
}

/** Default draw batching: chunks of one band within a 4 x 4 tile block
 *  (5.12 km) merge into one mesh, culled as a whole. */
export const COMPILED_GROUP_TILES = 4;

/**
 * One draw's geometry from `chunks` (same band): positions rebased to the
 * first chunk's origin (Int16 x/z metres, y decimetres above the group's
 * base), indices offset (Uint32 past 65535 vertices). Bounds are the union
 * of the chunks', padded by the largest land swell, in metres around that
 * origin. Returns { geometry, originM, yBaseM, bytes }.
 */
export function mergeChunkGeometry(THREE, chunks, padM = LAND_MAX_DISPLACEMENT_M) {
  const [gx0, gz0] = chunks[0].originM;
  const yBase = Math.min(...chunks.map(c => c.yBaseM));
  let V = 0, I = 0;
  for (const c of chunks) { V += c.vertexCount; I += c.indexCount; }
  const positions = new Int16Array(V * 3), normals = new Int8Array(V * 4), atlas = new Uint16Array(V * 2);
  const indices = V > 65535 ? new Uint32Array(I) : new Uint16Array(I);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let v = 0, i = 0;
  for (const c of chunks) {
    const dx = c.originM[0] - gx0, dz = c.originM[1] - gz0, dy = Math.round((c.yBaseM - yBase) / COMPILED_Y_UNIT_M);
    for (let k = 0; k < c.vertexCount; k++) {
      const x = c.positions[k * 3] + dx, y = c.positions[k * 3 + 1] + dy, z = c.positions[k * 3 + 2] + dz;
      if (x < -32768 || x > 32767 || y < -32768 || y > 32767 || z < -32768 || z > 32767) throw new Error(`group from ${chunks[0].id} exceeds Int16 positions`);
      positions[(v + k) * 3] = x; positions[(v + k) * 3 + 1] = y; positions[(v + k) * 3 + 2] = z;
    }
    normals.set(c.normals, v * 4);
    atlas.set(c.atlas, v * 2);
    for (let k = 0; k < c.indexCount; k++) indices[i + k] = c.indices[k] + v;
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], c.boundsM.min[a]); max[a] = Math.max(max[a], c.boundsM.max[a]); }
    v += c.vertexCount; i += c.indexCount;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('compiledNormal', new THREE.BufferAttribute(normals, 4, true));
  g.setAttribute('compiledAtlas', new THREE.BufferAttribute(atlas, 2));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  const lo = [min[0] - gx0, min[1] - yBase - padM, min[2] - gz0], hi = [max[0] - gx0, max[1] - yBase + padM, max[2] - gz0];
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2),
    Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  return { geometry: g, originM: [gx0, gz0], yBaseM: yBase, bytes: positions.byteLength + normals.byteLength + atlas.byteLength + indices.byteLength };
}

function placedMesh(THREE, group, material) {
  const mesh = new THREE.Mesh(group.geometry, material);
  mesh.position.set(group.originM[0], group.yBaseM, group.originM[1]);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = true;
  return mesh;
}

/** Chunks keyed by world-aligned blocks of `tiles` x `tiles` chunks, in
 *  pack order. */
function blocks(chunks, tiles) {
  const out = new Map();
  for (const c of chunks) {
    if (!c.indexCount) continue;
    const key = `${Math.floor(c.ix / tiles)},${Math.floor(c.iz / tiles)}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(c);
  }
  return [...out.values()];
}

export function buildCompiledScenes(THREE, pack, { material, depthMaterial, groupTiles = COMPILED_GROUP_TILES }) {
  const plan = compiledBandPlan(pack);
  const scenes = {}, depthScenes = {}, depthBandMeshes = {};
  const depthScene = new THREE.Scene();
  const fringeMeshes = [], fringeTravel = [];
  const geometries = [];
  let gpuBytes = 0, draws = 0;
  const build = (chunks) => {
    const group = mergeChunkGeometry(THREE, chunks);
    geometries.push(group.geometry);
    gpuBytes += group.bytes;
    return group;
  };
  for (const band of BANDS) {
    scenes[band] = new THREE.Scene();
    depthScenes[band] = new THREE.Scene();
    depthBandMeshes[band] = [];
    for (const chunks of blocks(plan.own[band], groupTiles)) {
      const group = build(chunks);
      scenes[band].add(placedMesh(THREE, group, material));
      const d = placedMesh(THREE, group, depthMaterial);
      depthScene.add(d);
      depthBandMeshes[band].push(d);
      depthScenes[band].add(placedMesh(THREE, group, depthMaterial));
      draws++;
    }
  }
  // Seam fill: a nearer band's chunks touching a farther band also draw in
  // the pass just farther (TerrainMesh.planBands; RangeScene.prepare).
  for (let b = 1; b < BANDS.length; b++) {
    const travel = new THREE.Scene();
    for (const chunks of blocks(plan.fringe[BANDS[b]], groupTiles)) {
      const group = build(chunks);
      const fm = placedMesh(THREE, group, material);
      scenes[BANDS[b - 1]].add(fm);
      fringeMeshes.push(fm);
      travel.add(placedMesh(THREE, group, material));
    }
    if (travel.children.length) fringeTravel.push({ band: BANDS[b], pass: BANDS[b - 1], scene: travel });
  }
  return {
    scenes, depthScene, depthScenes, depthBandMeshes, fringeMeshes, fringeTravel, gpuBytes, groupTiles,
    geometryCount: geometries.length, bandDraws: draws,
    dispose: () => { for (const g of geometries) g.dispose(); },
  };
}
