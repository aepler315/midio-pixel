// A cloud deck that follows the camera: the valley-filling cloud sea of an
// inversion (peaks rising out of it) or a storm's overcast. It is a curved
// disc on the Earth at the deck altitude, textured with world-locked 3D
// noise so it does not slide as the camera moves, lit by the same sun and
// sky as the terrain.
import * as THREE from 'three';
import { NOISE, ATMOS, LOGDEPTH_VS } from './glsl.js';
import { EARTH_RADIUS } from '../core/geo.js';

const RADIUS = 90000;

const VS = /* glsl */ `
uniform vec3 uCenterRel, uEast, uNorth, uUp;
uniform float uRadiusEarth;
varying vec3 vRel;
varying float vEdge;
varying float vW;
${LOGDEPTH_VS}
void main() {
  vec2 q = position.xy;
  float drop = dot(q, q) / (2.0 * uRadiusEarth);
  vec3 wp = uCenterRel + uEast * q.x + uNorth * q.y - uUp * drop;
  vRel = wp;
  vEdge = length(q) / ${RADIUS.toFixed(1)};
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vW = gl_Position.w;
  applyLogDepth();
}
`;

const FS = /* glsl */ `
precision highp float;
${NOISE}
${ATMOS}
uniform float uCloudOn, uCloudTop, uCoverage, uDark;
uniform vec3 uSkyHorizon;
uniform float uTime;
varying vec3 vRel;
varying float vEdge;
varying float vW;
uniform float uLogDepthFC;

float fbm(vec3 p) { return fbm3(p); }

void main() {
  // Per-fragment log depth: the deck's big triangles wrap around (and
  // behind) the camera, where per-vertex log depth clips to garbage.
  gl_FragDepth = log2(max(1e-6, 1.0 + vW)) * uLogDepthFC * 0.5;
  vec3 pKm = uCamKm + vRel * 0.001;
  vec3 drift = vec3(uTime * 0.004, uTime * 0.002, 0.0);
  float d = fbm(pKm * 0.55 + drift);
  float detail = fbm(pKm * 2.7 - drift * 2.0);
  float dens = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.25, d * 0.8 + detail * 0.35);
  float alpha = dens * uCloudOn * (1.0 - smoothstep(0.75, 1.0, vEdge));
  if (alpha < 0.003) discard;
  vec3 up = normalize(pKm);
  float hKm = uCloudTop * 0.001;
  vec3 sunT = lightTransmittance(hKm, dot(up, uSunDir));
  vec3 moonT = lightTransmittance(hKm, dot(up, uMoonDir));
  // Thicker parts self-shade; thin edges catch light from behind (silver lining).
  float thick = clamp(d * 1.3 - 0.2, 0.0, 1.0);
  vec3 V = normalize(-vRel);
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 8.0);
  vec3 sun = uSunPower * sunT * max(dot(up, uSunDir) + 0.15, 0.0) * (0.75 - 0.35 * thick + fwd * (1.0 - thick) * 2.0);
  vec3 col = vec3(0.92) / PI * (sun + uMoonPower * moonT * 0.6 + uSkyIrr * (0.9 - 0.3 * thick));
  col *= 1.0 - uDark * (0.55 + 0.3 * thick);
  // Seen from below, a deck shows its shaded underside (as the terrain does).
  if ((length(uCamKm) - RP) * 1000.0 < uCloudTop) col = deckUnderside(up) * (0.9 + 0.2 * thick);
  vec3 T, L;
  aerial(uCamKm, pKm, -V, T, L);
  col = col * T + L;
  gl_FragColor = vec4(col, alpha);
}
`;

export class Clouds {
  constructor(globals) {
    // Polar grid, denser near the centre.
    const rings = 48, segs = 96, pos = [0, 0, 0], idx = [];
    for (let r = 1; r <= rings; r++) {
      const rad = RADIUS * (r / rings) ** 2;
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        pos.push(Math.cos(a) * rad, Math.sin(a) * rad, 0);
      }
    }
    for (let s = 0; s < segs; s++) idx.push(0, 1 + s, 1 + ((s + 1) % segs));
    for (let r = 1; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = 1 + (r - 1) * segs + s, b = 1 + (r - 1) * segs + ((s + 1) % segs);
        const c = a + segs, d = b + segs;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(idx);
    this.uniforms = {
      ...globals,
      uCenterRel: { value: new THREE.Vector3() }, uEast: { value: new THREE.Vector3() },
      uNorth: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() },
      uRadiusEarth: { value: EARTH_RADIUS }, uCoverage: { value: 0.6 }, uDark: { value: 0 },
      // The deck has its own strength/height: an overcast must not fog the ground below it.
      uCloudOn: { value: 0 }, uCloudTop: { value: 2000 },
    };
    this.mesh = new THREE.Mesh(geom, new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  /** Place the deck under/over the camera. cam: ECEF [x,y,z]; enu: basis at the camera. */
  update(cam, enu, deckH) {
    const r = EARTH_RADIUS + deckH;
    const u = enu.up;
    this.uniforms.uCenterRel.value.set(u[0] * r - cam[0], u[1] * r - cam[1], u[2] * r - cam[2]);
    this.uniforms.uEast.value.set(...enu.east);
    this.uniforms.uNorth.value.set(...enu.north);
    this.uniforms.uUp.value.set(...u);
    this.uniforms.uCloudTop.value = deckH;
    this.mesh.visible = this.uniforms.uCloudOn.value > 0.002;
  }
}
