// Range v2: GPU objects for a decoded terrain package, shared by the
// production scene (RangeScene.js) and the diagnostic review viewer
// (src/dev/range-scene-review.html), so both draw the same mesh through the
// same camera. `THREE` is the local bundle (src/vendor/range), passed in so
// this module stays importable (and testable) without a GPU.
import { buildTerrainGeometry, buildSurfaceTexture, buildReceiverMask, BANDS } from './TerrainMesh.js';

export const REVIEW_MODES = Object.freeze({ neutral: 0, silhouette: 1, depth: 2, normals: 3, edges: 4 });

const VERT = /* glsl */`
  uniform vec2 uGridOrigin;
  uniform vec2 uGridExtent;
  out vec2 vUv;
  out vec3 vWorld;
  out float vViewDepth;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    // Texel centres: sample (i, j) of the grid sits at uv (i + .5) / N.
    vUv = (world.xz - uGridOrigin) / uGridExtent;
    vec4 view = viewMatrix * world;
    vViewDepth = -view.z;
    gl_Position = projectionMatrix * view;
  }
`;

const FRAG_REVIEW = /* glsl */`
  precision highp float;
  uniform sampler2D uSurface;
  uniform vec2 uTexel;
  uniform int uMode;
  uniform vec3 uSunDir;
  uniform float uMaxDepth;
  uniform vec2 uHeightRange;
  in vec2 vUv;
  in vec3 vWorld;
  in float vViewDepth;
  out vec4 outColor;
  vec3 surfaceNormal(vec4 s) {
    vec2 nxz = s.rg * 2.0 - 1.0;
    return normalize(vec3(nxz.x, sqrt(max(0.0, 1.0 - dot(nxz, nxz))), nxz.y));
  }
  void main() {
    vec2 uv = vUv * (1.0 - uTexel) + 0.5 * uTexel;
    vec4 s = texture(uSurface, uv);
    if (uMode == 1) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    if (uMode == 2) {
      float d = 1.0 - log(max(vViewDepth, 1.0)) / log(uMaxDepth);
      outColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
      return;
    }
    vec3 n = surfaceNormal(s);
    if (uMode == 3) { outColor = vec4(n * 0.5 + 0.5, 1.0); return; }
    if (uMode == 4) {
      // Crop-edge check: terrain within ~3 texels of the package boundary
      // is red, so a skyline made by the crop rather than the land shows.
      vec2 e = min(vUv, 1.0 - vUv) / uTexel;
      float edge = step(min(e.x, e.y), 3.0);
      outColor = vec4(mix(vec3(0.2), vec3(1.0, 0.1, 0.1), edge), 1.0);
      return;
    }
    // Neutral: grey albedo, one sun, sky ambient, a faint height tint so
    // large form reads; water flat blue-grey. No textures, fog or snow.
    float lambert = max(dot(n, normalize(uSunDir)), 0.0);
    float amb = 0.28 + 0.12 * n.y;
    float h = clamp((vWorld.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x), 0.0, 1.0);
    vec3 albedo = mix(vec3(0.46, 0.47, 0.45), vec3(0.62, 0.62, 0.64), h);
    if (s.a > 0.995) albedo = vec3(0.30, 0.36, 0.42);
    vec3 c = albedo * (amb + 0.85 * lambert);
    outColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
  }
`;

/** Upload the grid-resolution surface texture (normals/curvature/flow). */
export function createSurfaceTexture(THREE, data, options = {}) {
  const surface = buildSurfaceTexture(data, options);
  const receiver = buildReceiverMask(surface);
  const receiverTexture = new THREE.DataTexture(receiver.data, surface.width, surface.height, THREE.RedFormat, THREE.UnsignedByteType);
  receiverTexture.colorSpace = THREE.NoColorSpace;
  receiverTexture.wrapS = receiverTexture.wrapT = THREE.ClampToEdgeWrapping;
  receiverTexture.magFilter = receiverTexture.minFilter = THREE.LinearFilter;
  receiverTexture.generateMipmaps = false;
  receiverTexture.flipY = false;
  receiverTexture.needsUpdate = true;
  receiverTexture.onUpdate = () => {
    receiverTexture.image = { data: null, width: surface.width, height: surface.height };
    receiverTexture.onUpdate = null;
  };
  const tex = new THREE.DataTexture(surface.data, surface.width, surface.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Row 0 of the grid is north (smallest Z) and uv.y grows with Z.
  tex.flipY = false;
  tex.needsUpdate = true;
  // Once on the GPU the CPU copy (4 B/px, ~19 MB for a 2241^2 view) is dead
  // weight: nothing re-uploads it (a restored context rebuilds the whole
  // view from its terrain data), so drop it after the first upload.
  tex.onUpdate = () => {
    tex.image = { data: null, width: surface.width, height: surface.height };
    tex.onUpdate = null;
  };
  return { texture: tex, receiverTexture, width: surface.width, height: surface.height, bytes: Math.round(surface.data.byteLength * 4 / 3) + receiver.data.byteLength };
}

/** Uniforms every terrain material shares. */
export function terrainUniforms(THREE, data, surface) {
  const g = data.grid;
  return {
    uSurface: { value: surface.texture },
    uReceiver: { value: surface.receiverTexture },
    uTexel: { value: new THREE.Vector2(1 / surface.width, 1 / surface.height) },
    // Extent between the first and last sample centres.
    uGridOrigin: { value: new THREE.Vector2(g.originM[0], g.originM[1]) },
    uGridExtent: { value: new THREE.Vector2((g.width - 1) * g.cellSizeM, (g.height - 1) * g.cellSizeM) },
    uHeightRange: { value: new THREE.Vector2(data.manifest.boundsM.min[1], data.manifest.boundsM.max[1]) },
  };
}

/** One BufferGeometry per depth band. */
export function createBandGeometries(THREE, data, options = {}) {
  const built = options.built || buildTerrainGeometry(data, options);
  const geometries = {}, fringes = {};
  let bytes = 0;
  for (const band of BANDS) {
    const b = built.bands[band];
    const geo = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(b.positions, 3);
    geo.setAttribute('position', position);
    geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geo.computeBoundingSphere();
    geometries[band] = geo;
    bytes += b.positions.byteLength + b.indices.byteLength;
    // The band's tiles that border a farther band, sharing its vertices.
    if (b.fringe?.length) {
      const f = new THREE.BufferGeometry();
      f.setAttribute('position', position);
      f.setIndex(new THREE.BufferAttribute(b.fringe, 1));
      f.boundingSphere = geo.boundingSphere;
      fringes[band] = f;
      bytes += b.fringe.byteLength;
    }
  }
  return { geometries, fringes, stats: built.stats, bytes };
}

/** The review material (neutral / silhouette / depth / normals). */
export function createReviewMaterial(THREE, uniforms) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG_REVIEW,
    uniforms: {
      ...uniforms,
      uMode: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.62, 0.55) },
      uMaxDepth: { value: 40000 },
    },
  });
}

export const TERRAIN_VERTEX_SHADER = VERT;
