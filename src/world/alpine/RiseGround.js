import { terrainHeightAt } from './TerrainMesh.js';
import { LAND_RISE_GLSL } from './LandRise.js';
import { BUILD_OCEAN_GLSL } from './BuildOcean.js';

// A transient backdrop for ground the camera's partial DEM never shipped.
// Fine terrain always draws over it, after its depth has been cleared. This
// is inferred scenery during the climb, never replacement source geometry.
export const RISE_GROUND_SIDE = 129;

/** CPU attributes + GPU buffers, and the bounded construction scratch.
 * Reserved with the prepared view BEFORE building either geometry. */
export function riseGroundBytes() {
  const n = RISE_GROUND_SIDE, vertices = n * n;
  const buffers = vertices * 12 + (n - 1) ** 2 * 6 * 2 + 4 * 12 + 6 * 2;
  return buffers * 2 + vertices * 13;
}

/** Keep sampled source heights fixed. A deterministic nearest-source fill
 * followed by bounded relaxation supplies only the unshipped samples. */
export function buildRiseGround(data, { side = RISE_GROUND_SIDE } = {}) {
  if (!Number.isInteger(side) || side < 2 || side > RISE_GROUND_SIDE) throw new Error('rise ground grid exceeds its admitted bound');
  const g = data.grid, count = side * side;
  const height = new Float32Array(count), known = new Uint8Array(count), queue = new Uint32Array(count);
  const width = (g.width - 1) * g.cellSizeM, depth = (g.height - 1) * g.cellSizeM;
  let tail = 0;
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const i = z * side + x;
    const h = terrainHeightAt(data, g.originM[0] + width * x / (side - 1), g.originM[1] + depth * z / (side - 1));
    if (Number.isFinite(h)) { height[i] = h; known[i] = 1; queue[tail++] = i; }
  }
  const knownSamples = tail;
  // Queue membership is represented by finite height: unknowns start NaN.
  for (let i = 0; i < count; i++) if (!known[i]) height[i] = NaN;
  if (!tail) height.fill(data.manifest?.boundsM?.min?.[1] ?? 0);
  const visit = (j, h) => {
    if (!Number.isFinite(height[j])) { height[j] = h; queue[tail++] = j; }
  };
  for (let head = 0; head < tail; head++) {
    const i = queue[head], x = i % side, z = Math.floor(i / side), h = height[i];
    if (x) visit(i - 1, h);
    if (x + 1 < side) visit(i + 1, h);
    if (z) visit(i - side, h);
    if (z + 1 < side) visit(i + side, h);
  }
  const next = new Float32Array(count);
  for (let pass = 0; pass < 32; pass++) {
    for (let i = 0; i < count; i++) {
      if (known[i]) { next[i] = height[i]; continue; }
      const x = i % side, z = Math.floor(i / side);
      next[i] = (height[i] * 4 + height[x ? i - 1 : i] + height[x + 1 < side ? i + 1 : i]
        + height[z ? i - side : i] + height[z + 1 < side ? i + side : i]) / 8;
    }
    height.set(next);
  }
  const positions = new Float32Array(count * 3), indices = new Uint16Array((side - 1) ** 2 * 6);
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
    const i = z * side + x;
    positions[i * 3] = g.originM[0] + width * x / (side - 1);
    positions[i * 3 + 1] = height[i];
    positions[i * 3 + 2] = g.originM[1] + depth * z / (side - 1);
  }
  let at = 0;
  for (let z = 0; z + 1 < side; z++) for (let x = 0; x + 1 < side; x++) {
    const a = z * side + x, b = a + 1, c = a + side, d = c + 1;
    indices[at++] = a; indices[at++] = c; indices[at++] = d;
    indices[at++] = a; indices[at++] = d; indices[at++] = b;
  }
  return { positions, indices, knownSamples };
}

const VERT = /* glsl */`
  ${LAND_RISE_GLSL}
  out vec3 vWorld;
  void main() {
    vec4 p = modelMatrix * vec4(position, 1.0);
    p.y += riseLift(p.xyz);
    vWorld = p.xyz;
    gl_Position = projectionMatrix * viewMatrix * p;
  }
`;
const SHADE = /* glsl */`
  uniform vec3 pSoil, pMeadow, pWater, uLightDir, uLightColor, uSkyHorizon, uAirColor;
  uniform float uAirDensity, uClipBelow, uAmbientScale, uExposure, uRiseGroundOpacity;
  uniform vec4 uNarrative;
  uniform vec2 uLandRise;
  ${BUILD_OCEAN_GLSL}
  vec3 srgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - .055, step(vec3(.0031308), c));
  }
  vec4 shadeGround(vec3 p, vec3 n) {
    // Missing source coverage stays on the common construction sea. A
    // separately lit coarse fill otherwise exposes beige triangle patches.
    return vec4(openingOceanDisplay(p, cameraPosition, pWater, uSkyHorizon, uAirColor, uAirDensity), uRiseGroundOpacity);
  }
  vec4 shadeOcean(vec3 p) {
    return vec4(openingOceanDisplay(p, cameraPosition, pWater, uSkyHorizon, uAirColor, uAirDensity), uRiseGroundOpacity);
  }
`;
const FRAG = /* glsl */`
  precision highp float;
  ${SHADE}
  in vec3 vWorld;
  out vec4 outColor;
  void main() {
    if (vWorld.y < uClipBelow) discard;
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    outColor = shadeGround(vWorld, n);
  }
`;
// Analytic infinite ground reaches the true horizon, independent of the
// terrain camera's far clipping plane. It writes no depth of its own.
const PLANE_VERT = /* glsl */`
  out vec2 vNdc;
  void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;
const PLANE_FRAG = /* glsl */`
  precision highp float;
  ${SHADE}
  uniform mat4 uPlaneRays;
  in vec2 vNdc;
  out vec4 outColor;
  void main() {
    if (uLandRise.y < uClipBelow) discard;
    vec4 world = uPlaneRays * vec4(vNdc, 1.0, 1.0);
    vec3 ray = world.xyz / world.w - cameraPosition;
    if (abs(ray.y) < 1e-8) discard;
    float t = (uLandRise.y - cameraPosition.y) / ray.y;
    if (t <= 0.0) discard;
    outColor = shadeOcean(cameraPosition + ray * t);
  }
`;

/** Construct only after riseGroundBytes() is admitted with the view. */
export class RiseGround {
  constructor(THREE, data, uniforms) {
    this.uniforms = uniforms;
    try {
      const supportUniforms = { ...uniforms, uRiseGroundOpacity: { value: 0 } };
      const built = buildRiseGround(data);
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
      this.geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
      this.material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: supportUniforms,
        vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
        depthWrite: true, depthTest: true, depthFunc: THREE.LessEqualDepth, transparent: true });
      this.scene = new THREE.Scene();
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.frustumCulled = false; mesh.renderOrder = 1;
      const plane = this.planeGeometry = new THREE.BufferGeometry();
      this.planeMaterial = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3,
        uniforms: { ...supportUniforms, uPlaneRays: { value: new THREE.Matrix4() } },
        vertexShader: PLANE_VERT, fragmentShader: PLANE_FRAG, depthWrite: false, depthTest: false, transparent: true });
      this.plane = new THREE.Mesh(plane, this.planeMaterial);
      plane.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      plane.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
      this.plane.frustumCulled = false;
      this.scene.add(this.plane, mesh);
      this.knownSamples = built.knownSamples;
    } catch (error) { this.dispose(); throw error; }
  }

  get active() { return !this.disposed && this.uniforms.uLandRise.value.x > 0; }

  setFrame({ rise01 = 1, baseM = 0 }) {
    const sink = Number.isFinite(rise01) ? 1 - Math.max(0, Math.min(1, rise01)) : 0;
    this.uniforms.uLandRise.value.set(sink, sink > 0 ? baseM : 0);
  }

  prepare(camera) {
    // Missing terrain may extend beyond the final source silhouette. Fade
    // it smoothly away before completion, independently of that occlusion.
    const u = Math.max(0, Math.min(1, this.uniforms.uLandRise.value.x / .08));
    this.material.uniforms.uRiseGroundOpacity.value = u * u * (3 - 2 * u);
    camera.updateMatrixWorld();
    this.planeMaterial.uniforms.uPlaneRays.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    this.plane.position.set(camera.position.x, this.uniforms.uLandRise.value.y, camera.position.z);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry?.dispose();
    this.planeGeometry?.dispose();
    this.material?.dispose();
    this.planeMaterial?.dispose();
    this.scene?.clear();
  }
}
