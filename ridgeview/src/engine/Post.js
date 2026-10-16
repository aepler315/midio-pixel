// Final composite: exposure + filmic tone curve, per-style finishing (ink
// outlines from depth, hologram glow and scanlines, 8-bit pixels with
// ordered dither), speed blur during flights, and the animated wipe that
// reveals a new look over a snapshot of the old one.
import * as THREE from 'three';

const VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FS = /* glsl */ `
precision highp float;
uniform sampler2D uScene, uDepth, uSnap;
uniform vec2 uRes;
uniform float uExposure, uTime, uSpeed, uFlash, uTrans, uPixel, uVignette, uSat, uContrast, uPrecip;
uniform int uStyle, uTransKind, uHasSnap;
uniform vec3 uTint;
varying vec2 vUv;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 aces(vec3 x) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = i * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

vec3 sceneAt(vec2 uv) {
  vec3 c = texture(uScene, uv).rgb;
  if (uSpeed > 0.001) {
    vec2 dir = (uv - 0.5);
    float n = hash12(uv * uRes + uTime);
    for (int i = 1; i < 8; i++) c += texture(uScene, uv - dir * uSpeed * 0.035 * (float(i) + n)).rgb;
    c /= 8.0;
  }
  return c;
}

vec3 grade(vec3 hdr) {
  vec3 c = aces(hdr * uExposure);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c = (c - 0.5) * uContrast + 0.5;
  c *= uTint;
  return clamp(c, 0.0, 1.0);
}

float depthAt(vec2 uv) { return texture(uDepth, uv).r; }

vec3 styled(vec2 uv) {
  if (uStyle == 5) {
    // 8-bit: chunky pixels, a small palette, ordered dither.
    vec2 cell = vec2(uPixel) / uRes;
    vec2 puv = (floor(uv / cell) + 0.5) * cell;
    vec3 c = toSRGB(grade(sceneAt(puv)));
    vec2 p = floor(uv * uRes / uPixel);
    int bx = int(mod(p.x, 4.0)), by = int(mod(p.y, 4.0));
    const float B[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    float t = (B[by * 4 + bx] + 0.5) / 16.0 - 0.5;
    const float LV = 5.0;
    c = floor(c * (LV - 1.0) + 0.5 + t) / (LV - 1.0);
    return clamp(c, 0.0, 1.0);
  }
  vec3 c = grade(sceneAt(uv));
  if (uStyle == 1 || uStyle == 2) {
    // Outlines where depth jumps (ridge silhouettes against what lies behind).
    vec2 px = 1.0 / uRes;
    float d0 = depthAt(uv);
    float e = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0) * px * 1.2;
      e = max(e, abs(depthAt(uv + o) - d0));
    }
    float line = smoothstep(0.002, 0.008, e) * (d0 < 0.9999 ? 1.0 : 0.6);
    vec3 inkC = uStyle == 2 ? vec3(0.08, 0.07, 0.06) : vec3(0.42, 0.28, 0.17);
    c = mix(c, inkC, line * (uStyle == 2 ? 0.95 : 0.6));
    float g = hash12(floor(uv * uRes * 0.5)) * 0.06 - 0.03;
    c += g * (uStyle == 2 ? 1.0 : 0.5);
  } else if (uStyle == 4) {
    // Hologram: chromatic split, bloom-ish glow, scanlines, flicker.
    vec2 off = (uv - 0.5) * 0.004;
    c.r = grade(sceneAt(uv + off)).r;
    c.b = grade(sceneAt(uv - off)).b;
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 0.5236;
      vec2 o = vec2(cos(a), sin(a)) * (6.0 + 6.0 * float(i % 2)) / uRes;
      glow += max(grade(sceneAt(uv + o)) - 0.25, 0.0);
    }
    c += glow / 12.0 * 0.6;
    float scan = 0.85 + 0.15 * sin(uv.y * uRes.y * 1.6 + uTime * 8.0);
    c *= scan * (0.97 + 0.03 * sin(uTime * 37.0));
  }
  return c;
}

// Falling snow: three layers of flakes at different depths, drifting.
float flakes(vec2 uv) {
  float s = 0.0;
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  for (int i = 0; i < 3; i++) {
    float k = float(i);
    float scale = 14.0 + k * 16.0;
    vec2 p = uv * asp * scale + vec2(sin(uTime * 0.7 + k) * 0.6 + uTime * (0.25 + k * 0.1), uTime * (1.6 + k * 0.9));
    vec2 cell = floor(p), f = fract(p) - 0.5;
    float h = hash12(cell + k * 17.0);
    vec2 o = vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5;
    float r = length(f - o * 0.6);
    s += step(0.55, h) * smoothstep(0.09 - k * 0.02, 0.0, r) * (0.9 - k * 0.25);
  }
  return s;
}

void main() {
  vec3 c = styled(vUv);
  if (uPrecip > 0.001 && uStyle == 0) c = mix(c, vec3(0.85, 0.88, 0.92), clamp(flakes(vUv), 0.0, 1.0) * 0.75 * uPrecip);
  if (uStyle != 1 && uStyle != 2) {
    float v = smoothstep(1.25, 0.35, length((vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0)));
    c *= mix(1.0, v, uVignette);
    c += (hash12(vUv * uRes + fract(uTime) * 91.0) - 0.5) * 0.012;
  }
  c += uFlash;
  if (uStyle != 5) c = toSRGB(clamp(c, 0.0, 1.0));
  if (uHasSnap == 1 && uTrans >= 0.0 && uTrans < 1.0) {
    vec3 old = texture(uSnap, vUv).rgb;
    float f;
    vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    if (uTransKind == 1) f = length(q) / 0.95;                     // ripple out from the centre
    else if (uTransKind == 2) f = 1.0 - vUv.y;                      // curtain from the top
    else f = (vUv.x * 0.8 + (1.0 - vUv.y) * 0.45) / 1.25;           // diagonal sweep
    float p = uTrans * 1.25 - 0.1;
    float w = 0.08;
    float m = smoothstep(p, p - w, f);
    float edge = exp(-pow((f - (p - w * 0.5)) / (w * 0.35), 2.0));
    vec3 glow = uTransKind == 2 ? vec3(0.9, 0.95, 1.0) : vec3(1.0, 0.85, 0.6);
    c = mix(old, c, m) + glow * edge * 0.55 * (1.0 - uTrans);
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class Post {
  constructor() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.uniforms = {
      uScene: { value: null }, uDepth: { value: null }, uSnap: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) }, uExposure: { value: 1 }, uTime: { value: 0 }, uSpeed: { value: 0 },
      uFlash: { value: 0 }, uTrans: { value: -1 }, uTransKind: { value: 0 }, uHasSnap: { value: 0 }, uPixel: { value: 4 },
      uVignette: { value: 0.6 }, uSat: { value: 1 }, uPrecip: { value: 0 }, uContrast: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
      uStyle: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.snap = null;
  }

  render(renderer, sceneTarget, outTarget = null) {
    this.uniforms.uScene.value = sceneTarget.texture;
    this.uniforms.uDepth.value = sceneTarget.depthTexture;
    renderer.setRenderTarget(outTarget);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);
  }

  /** Freeze the current picture so the next look can wipe over it. */
  capture(renderer, sceneTarget, w, h) {
    if (!this.snap || this.snap.width !== w || this.snap.height !== h) {
      this.snap?.dispose();
      this.snap = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      this.uniforms.uSnap.value = this.snap.texture;
    }
    const hadSnap = this.uniforms.uHasSnap.value;
    this.uniforms.uHasSnap.value = 0;
    this.render(renderer, sceneTarget, this.snap);
    this.uniforms.uHasSnap.value = hadSnap;
  }
}
