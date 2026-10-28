// GPU column probe for the Landscape crest line (docs/pixel-presentation.md,
// "Crest line"). After each scenic band renders, one fragment per column
// walks that column of the band's own target (where alpha marks the band as
// frontmost terrain) and records its first covered row, the world elevation
// there (depth unprojected through the camera, mapped by uHeightRange) and
// the land colour just below it. After the water pass it records the first
// four water/land transitions per column, whether each is a real shore
// (continuous depth across it) and how near it is. Everything lands in one
// small target (width x PROBE_ROWS, RGBA8) that is read back once a frame:
// no grid-sized readback is needed for the line itself.
//
// Row layout: far 0-1, mid 2-3, near 4-5 (crest, colour), water 6-9 (edge
// info), 10-13 (water colour at each edge).

export const PROBE_BAND_ROWS = Object.freeze({ far: 0, mid: 2, near: 4 });
export const PROBE_WATER_ROW = 6;
export const PROBE_WATER_SLOTS = 4;
export const PROBE_ROWS = 14;

const PROBE_VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const PROBE_FRAG = /* glsl */`
  precision highp float;
  precision highp int;
  uniform sampler2D uColor;
  uniform highp sampler2D uDepth;
  uniform int uHeight;
  uniform int uMode;   // 0 crest, 1 crest colour, 2 water edge, 3 water colour
  uniform int uSlot;
  uniform int uUseDepth;
  uniform mat4 uInvViewProj;
  uniform vec2 uHeightRange;
  uniform vec3 uCameraPos;
  out vec4 outColor;
  ivec2 texel(int x, int y) { return ivec2(x, uHeight - 1 - y); }
  bool covered(int x, int y) { return texelFetch(uColor, texel(x, y), 0).a >= 0.5; }
  vec3 worldAt(int x, int y) {
    vec2 size = vec2(textureSize(uColor, 0));
    ivec2 t = texel(x, y);
    vec2 ndc = (vec2(t) + 0.5) / size * 2.0 - 1.0;
    float d = texelFetch(uDepth, t, 0).r;
    vec4 p = uInvViewProj * vec4(ndc, d * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  float depthAt(int x, int y) { return texelFetch(uDepth, texel(x, y), 0).r; }
  vec4 encodeRow(int row, float flags, float b, float a) {
    float v = float(row + 1);
    float hi = floor(v / 256.0);
    return vec4((v - hi * 256.0) / 255.0, (hi + flags) / 255.0, b, a);
  }
  void main() {
    int x = int(gl_FragCoord.x);
    int found = -1, kind = 0, count = 0;
    bool prev = false;
    for (int y = 0; y < 4096; y++) {
      if (y >= uHeight) break;
      bool c = covered(x, y);
      if (c != prev) {
        if (uMode < 2) { if (c) { found = y; kind = 1; break; } }
        else { if (count == uSlot) { found = y; kind = c ? 1 : 2; break; } count++; }
      }
      prev = c;
    }
    if (found < 0) { outColor = vec4(0.0); return; }
    if (uMode == 0) {
      float elev = 0.0, flag = 0.5;
      if (uUseDepth == 1 && depthAt(x, found) < 1.0) {
        vec3 w = worldAt(x, found);
        elev = clamp((w.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x), 0.0, 1.0);
        flag = 1.0;
      }
      outColor = encodeRow(found, 0.0, elev, flag);
    } else if (uMode == 1) {
      vec4 c = texelFetch(uColor, texel(x, min(found + 1, uHeight - 1)), 0);
      outColor = vec4(c.rgb / max(c.a, 1.0 / 255.0), 1.0);
    } else {
      int waterRow = kind == 1 ? found : found - 1;
      int landRow = kind == 1 ? found - 1 : found;
      if (uMode == 3) {
        vec4 c = texelFetch(uColor, texel(x, waterRow), 0);
        outColor = vec4(c.rgb / max(c.a, 1.0 / 255.0), 1.0);
        return;
      }
      float shore = 0.0, nearness = 0.0;
      if (uUseDepth == 1 && landRow >= 0 && landRow < uHeight && depthAt(x, landRow) < 1.0 && depthAt(x, waterRow) < 1.0) {
        float dw = length(worldAt(x, waterRow) - uCameraPos), dl = length(worldAt(x, landRow) - uCameraPos);
        shore = abs(dw - dl) / max(1.0, min(dw, dl)) < 0.35 ? 1.0 : 0.0;
        nearness = clamp(1.0 - log(max(dw, 600.0) / 600.0) / log(20000.0 / 600.0), 0.0, 1.0);
      }
      outColor = encodeRow(found, float(kind - 1) * 32.0 + shore * 64.0, nearness, 1.0);
    }
  }
`;

/** Decode one probe texel: its row (−1 when the column had none), whether
 *  the depth-derived value in blue is valid, and for water edges the kind
 *  (1: water below the edge, 2: water above) and whether it is a shore. */
export function probeRow(data, offset) {
  if (!data[offset + 3]) return { row: -1, kind: 0, shore: false, depth: false, value: 0 };
  const hi = data[offset + 1];
  return { row: data[offset] + (hi & 31) * 256 - 1, kind: hi & 32 ? 2 : 1, shore: !!(hi & 64),
    depth: data[offset + 3] > 200, value: data[offset + 2] / 255 };
}

export class CrestProbe {
  constructor(THREE, renderer) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.target = null;
    this.width = 0;
    this.height = 0;
    this.data = null;
    this.frameId = -1;
    this.rows = 0; // bitmask of probe rows written this frame
    this.useDepth = true;
    this.readMs = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: PROBE_VERT, fragmentShader: PROBE_FRAG,
      uniforms: { uColor: { value: null }, uDepth: { value: null }, uHeight: { value: 1 }, uMode: { value: 0 }, uSlot: { value: 0 },
        uUseDepth: { value: 0 }, uInvViewProj: { value: new THREE.Matrix4() }, uHeightRange: { value: new THREE.Vector2(0, 1) },
        uCameraPos: { value: new THREE.Vector3() } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Start a frame: rows written by an earlier frame are no longer valid. */
  begin(frameId, width, height) {
    this.height = height;
    if (this.frameId === frameId && this.width === width) return true;
    this.frameId = frameId;
    this.rows = 0;
    if (!this.target || this.width !== width) {
      this.target?.dispose();
      const THREE = this.THREE;
      this.target = new THREE.WebGLRenderTarget(width, PROBE_ROWS, { depthBuffer: false, stencilBuffer: false,
        type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.width = width;
      this.data = new Uint8Array(width * PROBE_ROWS * 4);
    }
    return true;
  }

  _pass(source, camera, heightRange, row, mode, slot = 0) {
    const r = this.renderer, u = this.material.uniforms;
    const depth = this.useDepth && source.depthTexture ? source.depthTexture : null;
    u.uColor.value = source.texture; u.uDepth.value = depth; u.uUseDepth.value = depth ? 1 : 0;
    u.uHeight.value = source.height; u.uMode.value = mode; u.uSlot.value = slot;
    if (depth) {
      u.uInvViewProj.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
      u.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
      if (heightRange) u.uHeightRange.value.copy(heightRange);
    }
    this.target.viewport.set(0, row, this.width, 1);
    this.target.scissor.set(0, row, this.width, 1);
    this.target.scissorTest = true;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    this.rows |= 1 << row;
  }

  /** Probe a band's crest from the band target just rendered. */
  band(source, camera, heightRange, pass) {
    const row = PROBE_BAND_ROWS[pass];
    if (row === undefined || !this.target || source.width !== this.width) return false;
    this._pass(source, camera, heightRange, row, 0);
    this._pass(source, camera, heightRange, row + 1, 1);
    return true;
  }

  /** Probe the water/land transitions of the native water pass. */
  water(source, camera) {
    if (!this.target || source.width !== this.width) return false;
    for (let s = 0; s < PROBE_WATER_SLOTS; s++) {
      this._pass(source, camera, null, PROBE_WATER_ROW + s, 2, s);
      this._pass(source, camera, null, PROBE_WATER_ROW + PROBE_WATER_SLOTS + s, 3, s);
    }
    return true;
  }

  /** One synchronous readback of this frame's probe rows. */
  read(frameId) {
    if (!this.target || this.frameId !== frameId || !this.rows) return null;
    const t0 = performance.now();
    try { this.renderer.readRenderTargetPixels(this.target, 0, 0, this.width, PROBE_ROWS, this.data); }
    catch { return null; }
    this.readMs = performance.now() - t0;
    return { width: this.width, height: this.height, data: this.data, rows: this.rows, readMs: this.readMs };
  }

  dispose() {
    this.target?.dispose(); this.target = null;
    this.mesh.geometry.dispose(); this.material.dispose();
    this.data = null; this.width = 0;
  }
}
