// Full-screen sky: single-scattering atmosphere seen from anywhere (valley
// floor to orbit), sun and moon disks, stars and the Milky Way at night,
// and the stylized skies of the non-photographic looks.
import * as THREE from 'three';
import { NOISE, ATMOS } from './glsl.js';

const VS = /* glsl */ `
varying vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

const FS = /* glsl */ `
precision highp float;
${NOISE}
${ATMOS}
uniform mat4 uInvViewProj;
uniform int uStyle;
uniform float uTime, uStars, uHighClouds;
uniform vec3 uSkyOrigin; // camera position in the mirrored pass (else 0)
varying vec2 vNdc;

float starField(vec3 d) {
  vec3 p = d * 420.0;
  vec3 c = floor(p);
  float h = hash13(c);
  if (h < 0.9965) return 0.0;
  vec3 f = fract(p) - 0.5 - (vec3(hash13(c + 1.7), hash13(c + 3.1), hash13(c + 5.3)) - 0.5) * 0.6;
  float r = length(f);
  float mag = pow((h - 0.9965) / 0.0035, 6.0);
  float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h * 9.0) + h * 70.0);
  return smoothstep(0.12, 0.0, r) * (0.15 + 2.5 * mag) * tw;
}

void main() {
  vec4 p = uInvViewProj * vec4(vNdc, -1.0, 1.0); // near plane: the far plane cancels to w~0 in float32
  vec3 d = normalize(p.xyz / p.w - uSkyOrigin);
  vec3 trans;
  vec3 col = skyRadiance(uCamKm, d, trans);
  vec2 hitP = raySphere(uCamKm, d, RP);
  bool ground = hitP.x > 0.0;
  if (!ground) {
    // Sun: limb-darkened disk, seen through the atmosphere.
    float cs = dot(d, uSunDir);
    float sunR = 0.00467;
    float ang = acos(clamp(cs, -1.0, 1.0));
    if (ang < sunR) {
      float mu = sqrt(max(0.0, 1.0 - (ang / sunR) * (ang / sunR)));
      col += trans * uSunPower * 3000.0 * (0.4 + 0.6 * mu);
    }
    // Moon: lit by the sun, with a faint earthshine.
    float cm = dot(d, uMoonDir);
    float moonR = 0.0047 * 1.4;
    float am = acos(clamp(cm, -1.0, 1.0));
    if (am < moonR) {
      vec3 right = normalize(cross(uMoonDir, vec3(0.0, 0.0, 1.0)));
      vec3 upv = cross(right, uMoonDir);
      vec2 q = vec2(dot(d - uMoonDir, right), dot(d - uMoonDir, upv)) / moonR;
      vec3 nrm = normalize(q.x * right + q.y * upv - sqrt(max(0.0, 1.0 - dot(q, q))) * uMoonDir);
      float lit = max(dot(-nrm, -uSunDir), 0.0) * 0.9 + 0.03;
      float maria = 0.8 + 0.2 * vnoise(q * 3.0 + 7.0, 64.0);
      col += trans * lit * maria * 1.2 * smoothstep(1.0, 0.96, length(q));
    }
    // High cloud (altocumulus / cirrus) at ~8 km, lit by sunlight that has
    // crossed the atmosphere to that height: it catches colour before
    // sunrise and after sunset, and glows around a sun behind it.
    if (uHighClouds > 0.001) {
      vec2 tc = raySphere(uCamKm, d, RP + 8.0);
      float t = tc.x > 0.0 ? tc.x : tc.y;
      if (t > 0.0 && t < 420.0) {
        vec3 p = uCamKm + d * t;
        vec3 drift = vec3(uTime * 0.003, uTime * 0.001, 0.0);
        float big = fbm3(p * 0.045 + drift);
        float streak = fbm3(vec3(p.xy * 0.18, p.z * 0.05) + drift * 3.0);
        float puff = fbm3(p * 0.6 + drift * 6.0);
        float dens = smoothstep(1.0 - uHighClouds * 0.85, 1.15 - uHighClouds * 0.6, big * 0.75 + streak * 0.35 + puff * 0.18);
        float fade = smoothstep(420.0, 180.0, t);
        vec3 upc = normalize(p);
        vec3 sunT = lightTransmittance(8.0, dot(upc, uSunDir));
        vec3 moonT = lightTransmittance(8.0, dot(upc, uMoonDir));
        float fwd = phaseM(dot(d, uSunDir), 0.6) * 4.0 + 0.35;
        vec3 lit = (sunT * uSunPower * fwd + moonT * uMoonPower * 0.5) * 0.06 + uSkyIrr * 0.12;
        float a = dens * fade * 0.85;
        // The cloud sits high: most of the air (and its glow) is in front of it.
        col = mix(col, lit * trans + col * 0.4, a);
      }
    }
    // Stars and a hint of the Milky Way when the sky is dark.
    float dark = clamp(1.0 - dot(col, vec3(0.3, 0.5, 0.2)) * 30.0, 0.0, 1.0) * uStars;
    if (dark > 0.0) {
      vec3 gal = normalize(vec3(-0.0548, -0.8734, -0.4838));
      float band = exp(-pow(dot(d, gal) / 0.18, 2.0));
      float mw = band * (0.5 + 0.5 * vnoise(vec2(atan(d.y, d.x), d.z) * 12.0, 1000.0)) * 0.012;
      col += trans * dark * (starField(d) * 0.06 + mw * vec3(0.8, 0.85, 1.0));
    }
  }
  if (uStyle == 1 || uStyle == 2) {
    // Paper sky with a faint wash toward the horizon.
    float up = dot(d, normalize(uCamKm));
    vec3 paper = vec3(0.93, 0.90, 0.82);
    col = mix(paper * 0.88, paper * 0.95, smoothstep(-0.05, 0.4, up));
    if (uStyle == 1) col = mix(col, vec3(0.80, 0.88, 0.92) * 0.9, 0.25 * smoothstep(0.0, 0.6, up));
  } else if (uStyle == 4) {
    float up = dot(d, normalize(uCamKm));
    float hz = exp(-abs(up) * 18.0);
    col = vec3(0.0, 0.01, 0.025) + vec3(0.1, 0.8, 1.0) * hz * 0.25 + starField(d) * 0.02 * vec3(0.4, 0.9, 1.0);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  constructor(globals) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.uniforms = {
      ...globals,
      uInvViewProj: { value: new THREE.Matrix4() },
      uStars: { value: 1 },
      uHighClouds: { value: 0 },
      uSkyOrigin: { value: new THREE.Vector3() },
    };
    this.mesh = new THREE.Mesh(geom, new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms, depthTest: false, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  update(camera) {
    this.uniforms.uInvViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  }
}
