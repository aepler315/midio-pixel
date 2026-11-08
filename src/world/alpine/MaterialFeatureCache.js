import { MATERIAL_HASH_GLSL } from './MaterialDetailDomain.js';

const MAX_SIZE = 256;
const BUILD_BYTES = 1024;
// Keep each cell and its +1 corner exactly representable in shader floats.
const MAX_CELL = 2 ** 24 - 2;
const validCell = value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_CELL;

/** Cached features are live by default; reference/off/invalid values opt out. */
export function materialFeatureMode(search = '') {
  const value = new URLSearchParams(search).get('materialFeatures');
  return value == null || value === 'warp' ? 'warp' : 'reference';
}

/** Four corner hashes per integer noise cell, covering both warped domains. */
export function planMaterialFeatureCache(grid, { maxSize = MAX_SIZE } = {}) {
  const denied = reason => ({ eligible: false, reason, width: 0, height: 0, originCell: [0, 0], bytes: 0, buildBytes: 0 });
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > MAX_SIZE) return denied('invalid-size');
  if (!grid || !Array.isArray(grid.originM) || grid.originM.length !== 2 || !grid.originM.every(Number.isFinite)
    || !Number.isInteger(grid.width) || grid.width < 2 || !Number.isInteger(grid.height) || grid.height < 2
    || !Number.isFinite(grid.cellSizeM) || grid.cellSizeM <= 0) return denied('invalid-grid');
  const end = [grid.originM[0] + (grid.width - 1) * grid.cellSizeM,
    grid.originM[1] + (grid.height - 1) * grid.cellSizeM];
  if (!end.every(Number.isFinite)) return denied('invalid-grid');
  const originCell = [Math.floor(grid.originM[0] / 600) - 1, Math.floor(grid.originM[1] / 600 - 19.7) - 1];
  const lastCell = [Math.floor(end[0] / 600 + 37.2) + 1, Math.floor(end[1] / 600) + 1];
  const width = lastCell[0] - originCell[0] + 1, height = lastCell[1] - originCell[1] + 1;
  if (!originCell.every(validCell) || !lastCell.every(validCell) || width < 1 || height < 1) return denied('invalid-grid');
  const eligible = width <= maxSize && height <= maxSize;
  return { eligible, ...(eligible ? {} : { reason: 'size-cap' }), width, height, originCell,
    bytes: width * height * 4, buildBytes: BUILD_BYTES };
}

// The terrain already declares tSoil, sSoil and sCanopy. The pilot reuses
// these unused slots for the cache and its exact integer origin, avoiding
// a second origin calculation after world coordinates round to float32.
export const MATERIAL_FEATURE_GLSL = /* glsl */`
  float materialFeatureBlend(float cached, float reference, float edge) {
    return mix(reference, cached, smoothstep(0.0, 1.0, edge));
  }
  float materialFeatureNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    ivec2 origin = ivec2(sSoil, sCanopy);
    ivec2 at = ivec2(i) - origin, size = textureSize(tSoil, 0);
    if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, size))) return vnoise12(p);
    vec4 corners = texelFetch(tSoil, at, 0);
    f = f * f * (3.0 - 2.0 * f);
    float cached = mix(mix(corners.r, corners.g, f.x), mix(corners.b, corners.a, f.x), f.y);
    // The outer cell rejoins procedural noise continuously. Plan padding
    // keeps source terrain at least one cell in, with no procedural hashes.
    vec2 low = p - vec2(origin), high = vec2(origin + size) - p;
    float edge = min(min(low.x, low.y), min(high.x, high.y));
    if (edge < 1.0) return materialFeatureBlend(cached, vnoise12(p), edge);
    return cached;
  }
  vec3 cachedMaterialDetailPosition(vec3 p) {
    vec2 q = p.xz / 600.0;
    vec2 shift = vec2(materialFeatureNoise(q), materialFeatureNoise(q + vec2(37.2, -19.7))) - 0.5;
    return p + vec3(shift.x, 0.0, shift.y) * 300.0;
  }
`;

export const MATERIAL_FEATURE_BAKE_VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const MATERIAL_FEATURE_BAKE_FRAG = /* glsl */`
  precision highp float;
  uniform vec2 uFeatureOrigin;
  out vec4 outColor;
  ${MATERIAL_HASH_GLSL}
  void main() {
    vec2 cell = floor(gl_FragCoord.xy) + uFeatureOrigin;
    outColor = vec4(hash12(cell), hash12(cell + vec2(1.0, 0.0)),
      hash12(cell + vec2(0.0, 1.0)), hash12(cell + vec2(1.0, 1.0)));
  }
`;

/** Small synchronous GPU bake. The caller admits both costs before entry. */
export function bakeMaterialFeatureCache(THREE, renderer, plan) {
  if (!plan?.eligible || !Number.isInteger(plan.width) || !Number.isInteger(plan.height)
    || plan.width < 1 || plan.height < 1 || plan.width > MAX_SIZE || plan.height > MAX_SIZE
    || plan.bytes !== plan.width * plan.height * 4 || plan.buildBytes !== BUILD_BYTES
    || !Array.isArray(plan.originCell) || plan.originCell.length !== 2 || !plan.originCell.every(validCell)
    || !validCell(plan.originCell[0] + plan.width - 1) || !validCell(plan.originCell[1] + plan.height - 1)) {
    throw new Error('Invalid material feature cache plan');
  }
  const previous = { target: renderer.getRenderTarget(), viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear,
    cubeFace: renderer.getActiveCubeFace?.() || 0, mipLevel: renderer.getActiveMipmapLevel?.() || 0 };
  const gl = renderer.getContext();
  const currentViewport = renderer.getCurrentViewport?.(new THREE.Vector4());
  const currentScissor = gl.getParameter?.(gl.SCISSOR_BOX);
  const currentScissorTest = gl.getParameter?.(gl.SCISSOR_TEST);
  // A public setter after the target bind overrides its own rectangle/test
  // without updating the target object. Preserve each override separately.
  const viewportOverride = previous.target?.viewport && currentViewport && !currentViewport.equals(previous.target.viewport);
  const scissorOverride = previous.target?.scissor && currentScissor?.length === 4
    && !new THREE.Vector4().fromArray(currentScissor).equals(previous.target.scissor);
  const scissorTestOverride = previous.target && typeof currentScissorTest === 'boolean'
    && currentScissorTest !== previous.target.scissorTest;
  let target, geometry, material, complete = false;
  try {
    target = new THREE.WebGLRenderTarget(plan.width, plan.height, { format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    target.texture.colorSpace = THREE.NoColorSpace;
    target.texture.generateMipmaps = false;
    target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
    target.texture.flipY = false;
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: MATERIAL_FEATURE_BAKE_VERT,
      fragmentShader: MATERIAL_FEATURE_BAKE_FRAG, uniforms: { uFeatureOrigin: { value: new THREE.Vector2(...plan.originCell) } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
    const scene = new THREE.Scene(), mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    if (gl.isContextLost?.()) throw new Error('GPU context lost during material feature bake');
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, plan.width, plan.height);
    renderer.setScissorTest(false);
    renderer.compile(scene, camera);
    for (const program of renderer.properties.get(material).programs.values()) {
      if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
        throw new Error(`Material feature bake shader failed: ${gl.getProgramInfoLog(program.program) || 'link rejected'}`);
      }
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Material feature bake framebuffer incomplete');
    renderer.render(scene, camera);
    if (gl.isContextLost?.()) throw new Error('GPU context lost during material feature bake');
    target.texture.userData.materialFeatures = { version: 1, mode: 'warp', originCell: [...plan.originCell],
      width: plan.width, height: plan.height };
    complete = true;
    let disposed = false;
    return { texture: target.texture, target, bytes: plan.bytes, plan,
      dispose() { if (!disposed) { disposed = true; target.dispose(); } } };
  } finally {
    try {
      // These setters restore global definitions. Binding the old target
      // last restores its own viewport/scissor, which can differ from them.
      renderer.setViewport(previous.viewport);
      renderer.setScissor(previous.scissor);
      renderer.setScissorTest(previous.scissorTest);
      renderer.setRenderTarget(previous.target, previous.cubeFace, previous.mipLevel);
      if (viewportOverride) renderer.setViewport(previous.viewport);
      if (scissorOverride) renderer.setScissor(previous.scissor);
      if (scissorTestOverride) renderer.setScissorTest(previous.scissorTest);
      renderer.autoClear = previous.autoClear;
    } finally {
      geometry?.dispose(); material?.dispose();
      if (!complete) target?.dispose();
    }
  }
}
