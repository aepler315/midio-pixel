// The cast drawn in the Range's 3D scene (RangeActors.js decides where and
// how bright). Each actor is a lantern -- a small core and halo billboard
// at its real position -- and a swarm of motes that wander around it. When
// an actor kindles a light, a few of its motes leave the lantern and settle
// into it. The lights the cast leave in a view (SiteLights) and Midasus's
// survey threads (SurveyThreads) are emissive only: they light nothing.
// Everything is drawn inside the terrain's band passes, so the land in
// front hides it, the air dims it, and the lake mirror (which renders the
// same band scenes) reflects it. Only the three lanterns light the ground,
// trees and water, through the shared uniforms below (ACTOR_GLSL).
import { ACTOR_IDS, ACTOR_MOTES } from './RangeActors.js';
import { BANDS } from './TerrainMesh.js';

export const ACTOR_COUNT = 3;
/** Small lights that follow an actor along its route. */
export const ACTOR_COMPANIONS = Object.freeze({ midasus: 3 });
/** Motes that carry a kindling from the lantern into the light. */
export const ACTOR_FLY_MOTES = 12;
/** Placed lights (per view, over every band) and threads. */
export const SITE_LIGHTS_MAX = 48;
export const SURVEY_THREADS_MAX = 12;
const THREAD_SEGMENTS = 16;

/** Shared light, wake and parting uniforms (merged into the terrain's). */
export function actorUniforms(THREE) {
  return {
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
  uniform float uWanderPx;
  // A kindling: the first ${ACTOR_FLY_MOTES} motes fly from the lantern into
  // the light at uFlyTarget (world) as uFly runs 0..1, and fade there.
  uniform vec3 uFlyTarget;
  uniform float uFly;
  in vec4 aSeed;
  out vec2 vQ;
  out float vBright;
  out float vAir;
  void main() {
    float t = uTime * (0.25 + aSeed.y * 0.5);
    vec2 wander = vec2(sin(t + aSeed.z * 6.2832) + 0.5 * sin(t * 2.3 + aSeed.w * 9.0),
                       cos(t * 0.8 + aSeed.y * 6.2832) + 0.4 * sin(t * 1.7 + aSeed.z * 5.0))
      * uWanderPx * (0.35 + 0.65 * aSeed.w);
    vec3 base = uCenter + (uRight * wander.x + uUp * wander.y) * uMpp;
    float fly = 0.0;
    if (gl_InstanceID < ${ACTOR_FLY_MOTES} && uFly > 0.0 && uFly < 1.0) {
      // Each mote leaves at its own moment, so they stream into the light.
      fly = smoothstep(aSeed.x * 0.35, aSeed.x * 0.35 + 0.65, uFly);
    }
    vec3 c = mix(base, uFlyTarget, fly);
    float mpp = mix(uMpp, uMpp * length(uFlyTarget - uCameraPos) / max(length(uCenter - uCameraPos), 1.0), fly);
    vQ = position.xy * 2.0;
    vec3 p = c + (uRight * position.x + uUp * position.y) * 2.2 * 2.0 * mpp;
    vBright = (0.45 + 0.4 * fly * (1.0 - fly) * 4.0) * (0.75 + 0.25 * sin(uTime * 3.0 + aSeed.z * 40.0)) * (1.0 - smoothstep(0.85, 1.0, fly));
    vAir = airAt(c);
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

// Placed lights: a steady point with a soft halo. Two-tone sites (camps)
// ring their core in a second hue. Sized in stage pixels at their depth.
const SITE_VERT = /* glsl */`
  ${AIR}
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uPxPerTan;
  uniform float uTanHalf;
  in vec3 aPos;
  in vec3 aColor;
  in vec4 aLook;
  in vec2 aState;
  out vec2 vQ;
  out vec3 vColor;
  out vec3 vRing;
  out float vLit;
  out float vAir;
  out float vTwo;
  void main() {
    vQ = position.xy * 2.0;
    vLit = aState.x * (1.0 + aState.y * 1.5);
    vColor = aColor;
    vRing = aLook.yzw;
    vTwo = dot(aLook.yzw, aLook.yzw) > 0.0 ? 1.0 : 0.0;
    float dist = max(1.0, length(aPos - uCameraPos));
    // Metres per stage pixel at this depth, and a nudge toward the camera
    // so the ground it stands on does not cut its halo.
    float mpp = 2.0 * dist * uTanHalf / uPxPerTan;
    float px = aLook.x * (1.0 + aState.y * 0.8);
    float push = min(dist * 0.25, 3.0 * px * mpp);
    vec3 c = aPos + normalize(uCameraPos - aPos) * push;
    vec3 p = c + (uRight * position.x + uUp * position.y) * 2.0 * px * mpp * (dist - push) / dist;
    vAir = airAt(aPos);
    gl_Position = aState.x > 0.0 ? projectionMatrix * viewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const SITE_FRAG = /* glsl */`
  precision highp float;
  uniform float uGain;
  in vec2 vQ;
  in vec3 vColor;
  in vec3 vRing;
  in float vLit;
  in float vAir;
  in float vTwo;
  out vec4 outColor;
  void main() {
    float r = length(vQ);
    if (r > 1.0) discard;
    float core = exp(-r * r * 90.0);
    float halo = exp(-r * 5.0) * (1.0 - r);
    vec3 ring = mix(vColor, vRing, vTwo * smoothstep(0.08, 0.22, r));
    vec3 c = (vec3(1.0) * core * 0.7 + vColor * core * 0.5 + ring * halo * 0.6) * vLit * uGain * (1.0 - 0.85 * vAir);
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

// A survey thread: a faint line in Midasus's hue, drawn from one end to
// the other as she flies it.
const THREAD_VERT = /* glsl */`
  ${AIR}
  uniform float uReveal[${SURVEY_THREADS_MAX}];
  uniform float uBright[${SURVEY_THREADS_MAX}];
  in vec2 aThread;
  out float vShow;
  out float vAir;
  void main() {
    int k = int(aThread.x + 0.5);
    vShow = aThread.y <= uReveal[k] + 1e-4 ? uBright[k] : 0.0;
    vAir = airAt(position);
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const THREAD_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uGain;
  in float vShow;
  in float vAir;
  out vec4 outColor;
  void main() {
    if (vShow <= 0.0) discard;
    vec3 c = uColor * vShow * uGain * (1.0 - 0.85 * vAir);
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

function seeded(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const blendFor = (THREE) => ({
  transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
});

// A unit quad (the Range runtime bundles no PlaneGeometry).
function unitQuad(THREE) {
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  quad.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  return quad;
}

/**
 * The lights the cast leave in one view: one instanced billboard set per
 * band (each band's pass hides and hazes its own), SITE_LIGHTS_MAX over
 * all. `setSites(list)` lays them out ({ pos, band, color, ring, sizePx });
 * `setState(i, lit, flare)` updates one by its index in that list.
 */
export class SiteLights {
  constructor(THREE, shared) {
    this.THREE = THREE;
    this.uniforms = {
      uCameraPos: shared.uCameraPos, uAirDensity: shared.uAirDensity, uAirHeightFalloff: shared.uAirHeightFalloff,
      uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
      uTanHalf: { value: 0.3 }, uPxPerTan: { value: 720 }, uGain: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.uniforms,
      vertexShader: SITE_VERT, fragmentShader: SITE_FRAG, ...blendFor(THREE) });
    this._quad = unitQuad(THREE);
    this.meshes = {};
    this._slots = [];
    for (const band of BANDS) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = this._quad.index;
      g.setAttribute('position', this._quad.attributes.position);
      const attr = (size) => new THREE.InstancedBufferAttribute(new Float32Array(SITE_LIGHTS_MAX * size), size).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aPos', attr(3));
      g.setAttribute('aColor', attr(3));
      g.setAttribute('aLook', attr(4));
      g.setAttribute('aState', attr(2));
      g.instanceCount = 0;
      const mesh = new THREE.Mesh(g, this.material);
      mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.layers.set(3);
      this.meshes[band] = mesh;
    }
  }

  static bytes() { return BANDS.length * SITE_LIGHTS_MAX * (3 + 3 + 4 + 2) * 4; }

  setSites(list) {
    const counts = Object.fromEntries(BANDS.map((b) => [b, 0]));
    this._slots = list.slice(0, SITE_LIGHTS_MAX).map((site) => {
      const band = BANDS.includes(site.band) ? site.band : 'far';
      const i = counts[band]++;
      const g = this.meshes[band].geometry;
      g.attributes.aPos.setXYZ(i, ...site.pos);
      g.attributes.aColor.setXYZ(i, site.color.r, site.color.g, site.color.b);
      g.attributes.aLook.setXYZW(i, site.sizePx, site.ring?.r ?? 0, site.ring?.g ?? 0, site.ring?.b ?? 0);
      g.attributes.aState.setXY(i, 0, 0);
      return { band, i };
    });
    for (const band of BANDS) {
      const g = this.meshes[band].geometry;
      g.instanceCount = counts[band];
      for (const a of ['aPos', 'aColor', 'aLook', 'aState']) g.attributes[a].needsUpdate = true;
      this.meshes[band].visible = counts[band] > 0;
    }
  }

  setState(k, lit, flare = 0) {
    const slot = this._slots[k];
    if (!slot) return;
    const a = this.meshes[slot.band].geometry.attributes.aState;
    if (a.getX(slot.i) === lit && a.getY(slot.i) === flare) return;
    a.setXY(slot.i, lit, flare);
    a.needsUpdate = true;
  }

  dispose() {
    for (const m of Object.values(this.meshes)) { m.removeFromParent(); m.geometry.dispose(); }
    this._quad.dispose();
    this.material.dispose();
  }
}

/**
 * Midasus's survey threads in one view: line strips between raised site
 * pairs, one set per band (by the thread's midpoint). `setThreads(list)`
 * lays them out ({ a, b, band }); `setState(k, reveal, bright)`.
 */
export class SurveyThreads {
  constructor(THREE, shared) {
    this.THREE = THREE;
    this.meshes = {};
    this._bands = [];
    this.uniformsByBand = {};
    for (const band of BANDS) {
      const u = {
        uCameraPos: shared.uCameraPos, uAirDensity: shared.uAirDensity, uAirHeightFalloff: shared.uAirHeightFalloff,
        uReveal: { value: new Array(SURVEY_THREADS_MAX).fill(0) }, uBright: { value: new Array(SURVEY_THREADS_MAX).fill(0) },
        uColor: { value: new THREE.Color() }, uGain: { value: 1 },
      };
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SURVEY_THREADS_MAX * THREAD_SEGMENTS * 2 * 3), 3));
      g.setAttribute('aThread', new THREE.BufferAttribute(new Float32Array(SURVEY_THREADS_MAX * THREAD_SEGMENTS * 2 * 2), 2));
      g.setDrawRange(0, 0);
      const mesh = new THREE.LineSegments(g, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u,
        vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG, ...blendFor(THREE) }));
      mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.layers.set(3);
      this.meshes[band] = mesh;
      this.uniformsByBand[band] = u;
    }
  }

  static bytes() { return BANDS.length * SURVEY_THREADS_MAX * THREAD_SEGMENTS * 2 * (3 + 2) * 4; }

  setThreads(list) {
    const counts = Object.fromEntries(BANDS.map((b) => [b, 0]));
    this._bands = list.slice(0, SURVEY_THREADS_MAX).map((thread) => {
      const band = BANDS.includes(thread.band) ? thread.band : 'far';
      const k = counts[band]++;
      const g = this.meshes[band].geometry, pos = g.attributes.position, tag = g.attributes.aThread;
      // A shallow sag between its ends.
      const at = (s) => [0, 1, 2].map((c) => thread.a[c] + (thread.b[c] - thread.a[c]) * s)
        .map((v, c) => (c === 1 ? v - 0.04 * Math.hypot(thread.b[0] - thread.a[0], thread.b[2] - thread.a[2]) * 4 * s * (1 - s) : v));
      for (let j = 0; j < THREAD_SEGMENTS; j++) {
        const v = (k * THREAD_SEGMENTS + j) * 2;
        const s0 = j / THREAD_SEGMENTS, s1 = (j + 1) / THREAD_SEGMENTS;
        pos.setXYZ(v, ...at(s0)); pos.setXYZ(v + 1, ...at(s1));
        tag.setXY(v, k, s0); tag.setXY(v + 1, k, s1);
      }
      return { band, k };
    });
    for (const band of BANDS) {
      const g = this.meshes[band].geometry;
      g.setDrawRange(0, counts[band] * THREAD_SEGMENTS * 2);
      g.attributes.position.needsUpdate = true; g.attributes.aThread.needsUpdate = true;
      this.meshes[band].visible = counts[band] > 0;
    }
  }

  setState(k, reveal, bright) {
    const slot = this._bands[k];
    if (!slot) return;
    const u = this.uniformsByBand[slot.band];
    u.uReveal.value[slot.k] = reveal;
    u.uBright.value[slot.k] = bright;
  }

  setLook(color, gain) {
    for (const u of Object.values(this.uniformsByBand)) { u.uColor.value.copy(color); u.uGain.value = gain; }
  }

  dispose() {
    for (const m of Object.values(this.meshes)) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); }
  }
}

/** Lanterns and swarms for one prepared view, and the lights its job leaves. */
export class ActorsGL {
  constructor(THREE, shared) {
    this.THREE = THREE;
    this.groups = {};
    this.uniforms = {};
    this.companions = {};
    this._geometries = [];
    this._materials = [];
    const blend = blendFor(THREE);
    const quad = unitQuad(THREE);
    this._geometries.push(quad);
    ACTOR_IDS.forEach((id, k) => {
      const u = {
        uCameraPos: shared.uCameraPos, uAirDensity: shared.uAirDensity, uAirHeightFalloff: shared.uAirHeightFalloff,
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
        uMpp: { value: 1 }, uHaloPx: { value: 30 }, uColor: { value: new THREE.Color() },
        uGlow: { value: 0 }, uPresence: { value: 0 }, uWanderPx: { value: 24 },
        uFlyTarget: { value: new THREE.Vector3() }, uFly: { value: 0 },
      };
      const lantern = new THREE.Mesh(quad, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u,
        vertexShader: LANTERN_VERT, fragmentShader: LANTERN_FRAG, ...blend }));
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.attributes.position);
      const seed = new Float32Array(ACTOR_MOTES * 4);
      for (let i = 0; i < ACTOR_MOTES; i++) for (let j = 0; j < 4; j++) seed[i * 4 + j] = seeded(k * 1000 + i * 4 + j);
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
    this.sites = new SiteLights(THREE, shared);
    this.threads = new SurveyThreads(THREE, shared);
  }

  /** Bytes of the instance buffers (residency accounting). */
  static bytes() { return ACTOR_IDS.length * ACTOR_MOTES * 4 * 4 + 180 + SiteLights.bytes() + SurveyThreads.bytes(); }

  dispose() {
    for (const g of Object.values(this.groups)) g.removeFromParent();
    for (const m of this._materials) m.dispose();
    for (const g of this._geometries) g.dispose();
    this.sites.dispose();
    this.threads.dispose();
  }
}
