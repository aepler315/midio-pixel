// The cast drawn in the Range's 3D scene (RangeActors.js decides where and
// how bright). Each actor is a lantern -- a small core and halo billboard
// at its real position -- and a swarm of motes that wander around it and
// gather into its outline at its musical peaks. Both are drawn inside the
// terrain's band passes, so the land in front hides them, the air dims
// them, and the lake mirror (which renders the same band scenes) reflects
// them. Their light reaches the ground, trees and water through the
// shared uniforms below (ACTOR_GLSL).
import { giantUniforms, GIANT_GLSL } from './LandscapeGiants.js';
import { ACTOR_IDS, ACTOR_MOTES, ACTOR_OUTLINES } from './RangeActors.js';

export const ACTOR_COUNT = 3;
/** Small lights that follow an actor along its route. */
export const ACTOR_COMPANIONS = Object.freeze({ midasus: 3 });

/** Shared light, wake and parting uniforms (merged into the terrain's). */
export function actorUniforms(THREE) {
  return {
    ...giantUniforms(THREE),
    uActorPos: { value: Array.from({ length: ACTOR_COUNT }, () => new THREE.Vector3()) },
    uActorColor: { value: Array.from({ length: ACTOR_COUNT }, () => new THREE.Vector3()) },
    uActorRadius: { value: [140, 110, 700] },
    // Midio's wake on the water: head xz, tail xz (where he was moments ago).
    uWake: { value: new THREE.Vector4() }, uWakeAmt: { value: 0 },
    // Broshi parting the trees: xz, radius (m), amount.
    uParting: { value: new THREE.Vector4(0, 0, 1, 0) },
  };
}

/** Light from the actors at `p` on a surface facing `n` (linear radiance,
 *  multiplied by albedo by the caller), and its glint on water. */
export const ACTOR_GLSL = /* glsl */`
  ${GIANT_GLSL}
  uniform vec3 uActorPos[${ACTOR_COUNT}];
  uniform vec3 uActorColor[${ACTOR_COUNT}];
  uniform float uActorRadius[${ACTOR_COUNT}];
  vec3 actorLight(vec3 p, vec3 n) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${ACTOR_COUNT}; i++) {
      if (dot(uActorColor[i], uActorColor[i]) < 1e-8) continue;
      vec3 d = uActorPos[i] - p;
      float r = length(d), R = uActorRadius[i];
      float fall = (1.0 - smoothstep(R * 2.5, R * 4.5, r)) / (1.0 + r * r / (R * R));
      float facing = max(dot(n, d / max(r, 1e-3)) * 0.75 + 0.25, 0.0);
      sum += uActorColor[i] * fall * facing;
    }
    return sum;
  }
  // A light low over still water lays a path of glints toward the viewer.
  vec3 actorGlint(vec3 p, vec3 V, vec3 n) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${ACTOR_COUNT}; i++) {
      if (dot(uActorColor[i], uActorColor[i]) < 1e-8) continue;
      vec3 d = uActorPos[i] - p;
      float r = length(d), R = min(uActorRadius[i] * 14.0, 2500.0);
      vec3 H = normalize(d / max(r, 1e-3) + V);
      sum += uActorColor[i] * pow(max(dot(H, n), 0.0), 160.0) * (1.0 - smoothstep(R * 0.5, R, r));
    }
    return sum;
  }
`;

/** Midio's wake: two arms opening behind him, and a stir at his head. */
export const WAKE_GLSL = /* glsl */`
  uniform vec4 uWake;
  uniform float uWakeAmt;
  float wakeAt(vec2 xz) {
    if (uWakeAmt <= 0.0) return 0.0;
    vec2 a = uWake.xy, ab = uWake.zw - uWake.xy;
    float l2 = max(dot(ab, ab), 1.0);
    float s = clamp(dot(xz - a, ab) / l2, 0.0, 1.0);
    float d = length(xz - (a + ab * s));
    float w = 5.0 + 0.35 * sqrt(l2) * s;
    float arms = smoothstep(w * 0.45, w * 0.8, d) * (1.0 - smoothstep(w * 0.8, w * 1.2, d));
    float head = 1.0 - smoothstep(0.0, 14.0, length(xz - a));
    return uWakeAmt * max(arms * (1.0 - s), head * 0.6);
  }
`;

const AIR = /* glsl */`
  uniform vec3 uCameraPos;
  uniform float uAirDensity;
  uniform float uAirHeightFalloff;
  float airAt(vec3 p) {
    float heightTerm = exp(-max(0.0, p.y - uCameraPos.y * 0.25) * uAirHeightFalloff);
    return 1.0 - exp(-length(p - uCameraPos) * uAirDensity * (0.35 + 0.65 * heightTerm));
  }
`;

const LANTERN_VERT = /* glsl */`
  ${AIR}
  uniform vec3 uCenter;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uMpp;
  uniform float uHaloPx;
  out vec2 vQ;
  out float vAir;
  void main() {
    vQ = position.xy * 2.0;
    vec3 p = uCenter + (uRight * position.x + uUp * position.y) * 2.0 * uHaloPx * uMpp;
    vAir = airAt(uCenter);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

// Display-domain output, premultiplied: added over the land, and over the
// empty sky as a glow the partition copy lays on what is behind.
const LANTERN_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uPresence;
  in vec2 vQ;
  in float vAir;
  out vec4 outColor;
  void main() {
    float r = length(vQ);
    if (r > 1.0) discard;
    float core = exp(-r * r * 260.0);
    float halo = exp(-r * 4.5) * (1.0 - r) * (0.25 + 0.75 * uGlow);
    vec3 c = (vec3(1.0) * core * 0.9 + uColor * (core * 0.6 + halo * 0.55)) * uPresence * (1.0 - 0.85 * vAir);
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

const MOTE_VERT = /* glsl */`
  ${AIR}
  uniform vec3 uCenter;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uMpp;
  uniform float uTime;
  uniform float uCohere;
  uniform float uWanderPx;
  uniform float uShapePx;
  uniform float uShapeLift;
  in vec2 aTarget;
  in vec4 aSeed;
  out vec2 vQ;
  out float vBright;
  out float vAir;
  void main() {
    // Each mote arrives at its own moment, so the figure assembles.
    float c = smoothstep(aSeed.x * 0.4, aSeed.x * 0.4 + 0.6, uCohere);
    float t = uTime * (0.25 + aSeed.y * 0.5);
    vec2 wander = vec2(sin(t + aSeed.z * 6.2832) + 0.5 * sin(t * 2.3 + aSeed.w * 9.0),
                       cos(t * 0.8 + aSeed.y * 6.2832) + 0.4 * sin(t * 1.7 + aSeed.z * 5.0))
      * uWanderPx * (0.35 + 0.65 * aSeed.w);
    vec2 target = (aTarget + vec2(0.0, uShapeLift)) * uShapePx;
    vec2 o = mix(wander, target, c);
    float size = mix(2.2, 2.8, c);
    vQ = position.xy * 2.0;
    vec3 p = uCenter + (uRight * (o.x + position.x * size * 2.0) + uUp * (o.y + position.y * size * 2.0)) * uMpp;
    vBright = mix(0.45, 1.0, c) * (0.75 + 0.25 * sin(uTime * 3.0 + aSeed.z * 40.0));
    vAir = airAt(uCenter);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const MOTE_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uPresence;
  in vec2 vQ;
  in float vBright;
  in float vAir;
  out vec4 outColor;
  void main() {
    float r = length(vQ);
    if (r > 1.0) discard;
    float dot1 = exp(-r * r * 5.0) * (1.0 - r);
    vec3 c = mix(uColor, vec3(1.0), 0.35) * dot1 * vBright * uPresence * (1.0 - 0.85 * vAir);
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

function seeded(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Lanterns and swarms for one prepared view. */
export class ActorsGL {
  constructor(THREE, shared) {
    this.THREE = THREE;
    this.groups = {};
    this.uniforms = {};
    this.companions = {};
    this._geometries = [];
    this._materials = [];
    const blend = {
      transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    };
    // A unit quad (the Range runtime bundles no PlaneGeometry).
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    quad.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this._geometries.push(quad);
    ACTOR_IDS.forEach((id, k) => {
      const u = {
        uCameraPos: shared.uCameraPos, uAirDensity: shared.uAirDensity, uAirHeightFalloff: shared.uAirHeightFalloff,
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
        uMpp: { value: 1 }, uHaloPx: { value: 30 }, uColor: { value: new THREE.Color() },
        uGlow: { value: 0 }, uPresence: { value: 0 }, uCohere: { value: 0 },
        uWanderPx: { value: 24 }, uShapePx: { value: 60 }, uShapeLift: { value: 0 },
      };
      const lantern = new THREE.Mesh(quad, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u,
        vertexShader: LANTERN_VERT, fragmentShader: LANTERN_FRAG, ...blend }));
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.attributes.position);
      const target = new Float32Array(ACTOR_MOTES * 2), seed = new Float32Array(ACTOR_MOTES * 4);
      ACTOR_OUTLINES[id].forEach(([x, y], i) => {
        target[i * 2] = x; target[i * 2 + 1] = y;
        for (let j = 0; j < 4; j++) seed[i * 4 + j] = seeded(k * 1000 + i * 4 + j);
      });
      g.setAttribute('aTarget', new THREE.InstancedBufferAttribute(target, 2));
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
      g.instanceCount = ACTOR_MOTES;
      this._geometries.push(g);
      const motes = new THREE.Mesh(g, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u,
        vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, ...blend }));
      for (const m of [lantern, motes]) { m.frustumCulled = false; m.renderOrder = 3; this._materials.push(m.material); }
      const group = new THREE.Group();
      group.add(motes, lantern);
      // Midasus's three baby stars: tiny lanterns trailing her.
      this.companions[id] = Array.from({ length: ACTOR_COMPANIONS[id] || 0 }, () => {
        const cu = { ...u, uCenter: { value: new THREE.Vector3() }, uMpp: { value: 1 }, uHaloPx: { value: 9 }, uGlow: { value: 0 } };
        const m = new THREE.Mesh(quad, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: cu,
          vertexShader: LANTERN_VERT, fragmentShader: LANTERN_FRAG, ...blend }));
        m.frustumCulled = false; m.renderOrder = 3;
        this._materials.push(m.material);
        group.add(m);
        return cu;
      });
      group.visible = false;
      this.groups[id] = group;
      this.uniforms[id] = u;
    });
  }

  /** Bytes of the instance buffers (residency accounting). */
  static bytes() { return ACTOR_IDS.length * ACTOR_MOTES * 6 * 4 + 180; }

  dispose() {
    for (const g of Object.values(this.groups)) g.removeFromParent();
    for (const m of this._materials) m.dispose();
    for (const g of this._geometries) g.dispose();
  }
}
