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
import { THREAD_SEGMENTS, THREAD_SEGMENTS_MAX } from './CastJobs.js';
import { MIST_GLSL, EMITTER_GLSL, MIST_SAMPLES } from './RangeAtmosphere.js';
import { DEFORM_GLSL, GROUND_LIFT_GLSL, deformUniforms } from './TerrainDeform.js';
import { CAST_RASTER_GLSL, THREAD_HALF_PX } from './CastRaster.js';

export const ACTOR_COUNT = 3;
/** Small lights that follow an actor along its route. */
export const ACTOR_COMPANIONS = Object.freeze({ midasus: 3 });
/** Motes that carry a kindling from the lantern into the light. */
export const ACTOR_FLY_MOTES = 12;
/** Placed lights (per view, over every band) and threads. */
export const SITE_LIGHTS_MAX = 48;
export const SURVEY_THREADS_MAX = 12;
/** The looks are sized in pixels of a 720 px stage. */
const STAGE_PX = 720;
/** Core radius of a lantern and of a placed light (fractions of radius). */
const LANTERN_CORE = 0.0439, SITE_CORE = 0.0745;
/** A mote's dot (fraction of its radius). */
const MOTE_DOT = 0.245;

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
 *  multiplied by albedo by the caller), and its glint on water. Include
 *  after MIST_GLSL: a lantern sunk under the cloud sea lights nothing that
 *  stands above its top (RangeAtmosphere seaLightReach). */
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
      // Ground under the sea is already fogged where it is shaded; only
      // light climbing out of the cloud to a receiver above it is cut.
      if (uMistFill > 0.0) fall *= 1.0 - uMistFill * max(mistSubmersion(uActorPos[i].y) - mistSubmersion(p.y), 0.0);
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

// The mist and cloud sea the terrain fades into, seen at a light's true
// position (RangeAtmosphere emitterSeen): what drowns the ground under it
// drowns the light too. Lanterns and motes take it from the CPU twin.
const FOG = /* glsl */`
  uniform vec4 uNarrative;
  ${MIST_GLSL}
  ${EMITTER_GLSL}
`;

// The drawn ground's lift under a light (the land swell, the glacier): the
// CPU places the cast on the source heights, the shaders lift it with the
// mesh so a swelling summit never swallows it (TerrainDeform.js).
const LIFT = /* glsl */`
  ${DEFORM_GLSL}
  ${GROUND_LIFT_GLSL}
`;

const LANTERN_VERT = /* glsl */`
  ${AIR}
  ${LIFT}
  uniform vec3 uCenter;
  uniform vec3 uAnchor; // the light itself (uCenter is drawn toward the eye)
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uMpp;
  uniform float uHaloPx;
  uniform vec2 uViewportPx;
  out vec2 vPx; // from the lantern's centre, in target pixels
  out float vR; // its radius, in target pixels
  out float vAir;
  ${CAST_RASTER_GLSL}
  void main() {
    // Target pixels per stage pixel, and a quad wide enough for the
    // filtered glow however small the lantern is on the grid.
    float k = uViewportPx.y / ${STAGE_PX.toFixed(1)};
    vR = uHaloPx * k;
    float extent = spriteExtent(vR);
    vPx = position.xy * 2.0 * extent;
    vec3 center = uCenter + vec3(0.0, groundLift(uAnchor), 0.0);
    vec3 p = center + (uRight * position.x + uUp * position.y) * 2.0 * extent * uMpp / k;
    vAir = airAt(center);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

// Display-domain output, premultiplied: added over the land, and over the
// empty sky as a glow the partition copy lays on what is behind. Filtered
// over each pixel (CastRaster.js), so it keeps its brightness wherever it
// falls on the grid.
const LANTERN_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uPresence;
  uniform float uSeen;
  in vec2 vPx;
  in float vR;
  in float vAir;
  out vec4 outColor;
  ${CAST_RASTER_GLSL}
  void main() {
    float core = spot(vPx, ${LANTERN_CORE.toFixed(4)} * vR);
    float halo = spriteHalo(vPx, vR) * (0.25 + 0.75 * uGlow);
    vec3 c = (vec3(1.0) * core * 0.9 + uColor * (core * 0.6 + halo * 0.55)) * uPresence * (1.0 - 0.85 * vAir) * uSeen;
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

const MOTE_VERT = /* glsl */`
  ${AIR}
  ${LIFT}
  uniform vec3 uCenter;
  uniform vec3 uAnchor;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uMpp;
  uniform float uTime;
  uniform float uWanderPx;
  // A kindling: the first ${ACTOR_FLY_MOTES} motes fly from the lantern into
  // the light at uFlyTarget (world) as uFly runs 0..1, and fade there.
  uniform vec3 uFlyTarget;
  uniform float uFly;
  // How much of the fog lets the lantern and the light it kindles be seen.
  uniform float uSeen;
  uniform float uSeenFly;
  uniform vec2 uViewportPx;
  in vec4 aSeed;
  out vec2 vPx;
  out float vR;
  out float vBright;
  out float vAir;
  out float vSeen;
  ${CAST_RASTER_GLSL}
  void main() {
    float t = uTime * (0.25 + aSeed.y * 0.5);
    vec2 wander = vec2(sin(t + aSeed.z * 6.2832) + 0.5 * sin(t * 2.3 + aSeed.w * 9.0),
                       cos(t * 0.8 + aSeed.y * 6.2832) + 0.4 * sin(t * 1.7 + aSeed.z * 5.0))
      * uWanderPx * (0.35 + 0.65 * aSeed.w);
    vec3 base = uCenter + vec3(0.0, groundLift(uAnchor), 0.0) + (uRight * wander.x + uUp * wander.y) * uMpp;
    float fly = 0.0;
    vec3 target = uFlyTarget;
    if (gl_InstanceID < ${ACTOR_FLY_MOTES} && uFly > 0.0 && uFly < 1.0) {
      // Each mote leaves at its own moment, so they stream into the light.
      fly = smoothstep(aSeed.x * 0.35, aSeed.x * 0.35 + 0.65, uFly);
      target.y += groundLift(uFlyTarget);
    }
    vec3 c = mix(base, target, fly);
    float mpp = mix(uMpp, uMpp * length(uFlyTarget - uCameraPos) / max(length(uCenter - uCameraPos), 1.0), fly);
    float k = uViewportPx.y / ${STAGE_PX.toFixed(1)};
    vR = 2.2 * k;
    float extent = spriteExtent(vR);
    vPx = position.xy * 2.0 * extent;
    vec3 p = c + (uRight * position.x + uUp * position.y) * 2.0 * extent * mpp / k;
    vBright = (0.45 + 0.4 * fly * (1.0 - fly) * 4.0) * (0.75 + 0.25 * sin(uTime * 3.0 + aSeed.z * 40.0)) * (1.0 - smoothstep(0.85, 1.0, fly));
    vAir = airAt(c);
    vSeen = mix(uSeen, uSeenFly, fly);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const MOTE_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uPresence;
  in vec2 vPx;
  in float vR;
  in float vBright;
  in float vAir;
  in float vSeen;
  out vec4 outColor;
  ${CAST_RASTER_GLSL}
  void main() {
    // Far below a pixel on the grid: drawn at the filter's width with its
    // own energy, so a mote glides between pixels instead of popping.
    float dot1 = spot(vPx, ${MOTE_DOT.toFixed(3)} * vR);
    vec3 c = mix(uColor, vec3(1.0), 0.35) * dot1 * vBright * uPresence * (1.0 - 0.85 * vAir) * vSeen;
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

// Placed lights: a steady point with a soft halo. Two-tone sites (camps)
// ring their core in a second hue. Sized in stage pixels at their depth.
const SITE_VERT = /* glsl */`
  ${AIR}
  ${FOG}
  ${LIFT}
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uPxPerTan;
  uniform float uTanHalf;
  uniform vec2 uViewportPx;
  in vec3 aPos;
  in vec3 aColor;
  in vec4 aLook;
  in vec2 aState;
  out vec2 vPx;
  out float vR;
  out vec3 vColor;
  out vec3 vRing;
  out float vLit;
  out float vAir;
  out float vTwo;
  out float vSeen;
  ${CAST_RASTER_GLSL}
  void main() {
    vLit = aState.x * (1.0 + aState.y * 1.5);
    vColor = aColor;
    vRing = aLook.yzw;
    vTwo = dot(aLook.yzw, aLook.yzw) > 0.0 ? 1.0 : 0.0;
    vec3 at = aPos;
    if (aState.x > 0.0) at.y += groundLift(aPos);
    float dist = max(1.0, length(at - uCameraPos));
    // Metres per stage pixel at this depth, and a nudge toward the camera
    // so the ground it stands on does not cut its halo.
    float mpp = 2.0 * dist * uTanHalf / uPxPerTan;
    float px = aLook.x * (1.0 + aState.y * 0.8);
    float push = min(dist * 0.25, 3.0 * px * mpp);
    vec3 c = at + normalize(uCameraPos - at) * push;
    float k = uViewportPx.y / uPxPerTan;
    vR = px * k;
    float extent = spriteExtent(vR);
    vPx = position.xy * 2.0 * extent;
    vec3 p = c + (uRight * position.x + uUp * position.y) * 2.0 * extent / k * mpp * (dist - push) / dist;
    vAir = airAt(at);
    // Fog at the light itself, not at the halo's camera-ward centre.
    vSeen = aState.x > 0.0 ? emitterSeen(at) : 0.0;
    gl_Position = aState.x > 0.0 ? projectionMatrix * viewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const SITE_FRAG = /* glsl */`
  precision highp float;
  uniform float uGain;
  in vec2 vPx;
  in float vR;
  in vec3 vColor;
  in vec3 vRing;
  in float vLit;
  in float vAir;
  in float vTwo;
  in float vSeen;
  out vec4 outColor;
  ${CAST_RASTER_GLSL}
  void main() {
    float r = length(vPx) / vR;
    float core = spot(vPx, ${SITE_CORE.toFixed(4)} * vR);
    float halo = spriteHalo(vPx, vR);
    vec3 ring = mix(vColor, vRing, vTwo * smoothstep(0.08, 0.22, r));
    vec3 c = (vec3(1.0) * core * 0.7 + vColor * core * 0.5 + ring * halo * 0.6) * vLit * uGain * (1.0 - 0.85 * vAir) * vSeen;
    outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
  }
`;

/** Native pixels a thread is drawn toward the eye: the coarser mesh between
 *  its drape points and the depth buffer's step never cut it. */
export const THREAD_PUSH_PX = 1.5;
/** Length of the drawing front's soft head (fraction of the thread). */
export const THREAD_FRONT = 0.03;

/** How much of a thread shows at index fraction `s` with reveal `reveal`:
 *  nothing at 0, the whole thread at 1, and between them a front that
 *  glides with Midasus (within half a head of her) instead of stepping a
 *  segment at a time. The JS twin of THREAD_FRAG's front. */
export function threadShown(s, reveal) {
  return Math.min(1, Math.max(0, (reveal * (1 + THREAD_FRONT) - s) / THREAD_FRONT));
}

// A survey thread: a faint line in Midasus's hue, drawn from one end to
// the other as she flies it. A ribbon THREAD_HALF_PX either side of its
// centre in target pixels, mitred at every drape point so neighbouring
// segments share edges (added light, so an overlap would bead the line),
// with the filtered profile across it (CastRaster ribbonCoverage).
const THREAD_VERT = /* glsl */`
  ${AIR}
  ${FOG}
  ${LIFT}
  uniform float uReveal[${SURVEY_THREADS_MAX}];
  uniform float uBright[${SURVEY_THREADS_MAX}];
  uniform float uFlare[${SURVEY_THREADS_MAX}];
  uniform float uTanHalf;
  uniform vec2 uViewportPx;
  in vec3 aPrev;
  in vec3 aNext;
  in float aSide;
  in vec2 aThread;
  out float vS;
  out float vReveal;
  out float vBright;
  out float vFlare;
  out float vAir;
  // Distance across the ribbon (px) times w, and w: their ratio interpolates
  // linearly on screen (GLSL ES 3.00 has no noperspective).
  out float vAcrossW;
  out float vW;
  // On the drawn ground (lifted with the mesh).
  vec3 seat(vec3 p) { return p + vec3(0.0, groundLift(p), 0.0); }
  // ...then a little toward the eye, so the coarser mesh between drape
  // points and the depth step never cut it.
  vec4 toClip(vec3 q) {
    float dist = max(1.0, length(q - uCameraPos));
    float mpp = 2.0 * dist * uTanHalf / max(uViewportPx.y, 1.0);
    q += normalize(uCameraPos - q) * min(dist * 0.25, ${THREAD_PUSH_PX.toFixed(2)} * mpp);
    return projectionMatrix * viewMatrix * vec4(q, 1.0);
  }
  vec2 toPx(vec4 c) { return c.xy / c.w * 0.5 * uViewportPx; }
  void main() {
    int k = int(aThread.x + 0.5);
    vec3 here = seat(position);
    vec4 c = toClip(here);
    vec4 cp = toClip(seat(aPrev)), cn = toClip(seat(aNext));
    if (cp.w <= 0.0) cp = c;
    if (cn.w <= 0.0) cn = c;
    vec2 s = toPx(c), dA = s - toPx(cp), dB = toPx(cn) - s;
    // An end takes its one segment's heading.
    if (dot(dA, dA) < 1e-8) dA = dB;
    if (dot(dB, dB) < 1e-8) dB = dA;
    if (dot(dA, dA) < 1e-8) { dA = vec2(1.0, 0.0); dB = dA; }
    vec2 nA = normalize(vec2(-dA.y, dA.x)), nB = normalize(vec2(-dB.y, dB.x));
    vec2 m = nA + nB;
    m = dot(m, m) < 1e-6 ? nA : normalize(m);
    // The mitre's corner lies THREAD_HALF_PX from both segments' centre
    // lines; a hairpin's is clamped (a slight overlap there).
    float across = aSide * ${THREAD_HALF_PX.toFixed(3)};
    c.xy += m * across / max(dot(m, nA), 0.5) / (0.5 * uViewportPx) * c.w;
    vAcrossW = across * c.w;
    vW = c.w;
    vS = aThread.y;
    vReveal = uReveal[k];
    vFlare = uFlare[k];
    vBright = uReveal[k] > 0.0 ? uBright[k] * emitterSeen(here) : 0.0;
    vAir = airAt(here);
    gl_Position = c;
  }
`;

const THREAD_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uGain;
  in float vS;
  in float vReveal;
  in float vBright;
  in float vFlare;
  in float vAir;
  in float vAcrossW;
  in float vW;
  out vec4 outColor;
  ${CAST_RASTER_GLSL}
  void main() {
    float shown = clamp((vReveal * ${(1 + THREAD_FRONT).toFixed(3)} - vS) / ${THREAD_FRONT.toFixed(3)}, 0.0, 1.0) * vBright;
    if (shown <= 0.0) discard;
    // A brightness that runs along the line (the fixed line's fuse).
    float f = (vS - vFlare) / 0.06;
    float flare = 1.0 + 1.5 * exp(-f * f);
    vec3 c = uColor * shown * ribbonCoverage(vAcrossW / vW) * flare * uGain * (1.0 - 0.85 * vAir);
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

/** The terrain's air, mist, cloud-sea, narrative, viewport and ground-lift
 *  uniforms the cast shaders read, by reference (so one upload per frame
 *  reaches every cast material), with clear-air, still-ground stand-ins
 *  where `shared` lacks them. */
function sharedSky(THREE, shared = {}) {
  const ref = (key, make) => shared[key] || { value: make() };
  return {
    ...deformUniforms(THREE, shared),
    uViewportPx: ref('uViewportPx', () => new THREE.Vector2(1280, 720)),
    uCameraPos: ref('uCameraPos', () => new THREE.Vector3()), uAirDensity: ref('uAirDensity', () => 0),
    uAirHeightFalloff: ref('uAirHeightFalloff', () => 0),
    uMistDensity: ref('uMistDensity', () => 0), uMistSteps: ref('uMistSteps', () => MIST_SAMPLES),
    uMistBase: ref('uMistBase', () => 0), uMistHeight: ref('uMistHeight', () => 220), uMistTime: ref('uMistTime', () => 0),
    uMistDrift: ref('uMistDrift', () => [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()]),
    uMistColor: ref('uMistColor', () => new THREE.Color()), uMistTop: ref('uMistTop', () => 1e9), uMistFill: ref('uMistFill', () => 0),
    uNarrative: ref('uNarrative', () => new THREE.Vector4(1, 1, 1, 1)),
  };
}

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
      ...sharedSky(THREE, shared),
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
 * Midasus's survey threads in one view (and, with `max` 1, an ascent's
 * fixed line): ribbons draped between site pairs, one set per band.
 * `setThreads(list)` lays them out ({ points, band } -- up to
 * THREAD_SEGMENTS_MAX + 1 points -- or a straight { a, b });
 * `setState(k, reveal, bright, flareAt)`, where reveal and flareAt run along
 * the points' index fraction, the way Midasus flies them.
 */
export class SurveyThreads {
  /** `shared.uTanHalf`: the frame's vertical half-angle tangent (the site
   *  lights' own, so one upload serves both). */
  constructor(THREE, shared, { max = SURVEY_THREADS_MAX } = {}) {
    this.THREE = THREE;
    this.max = max;
    this.meshes = {};
    this._bands = [];
    this.uniformsByBand = {};
    const sky = sharedSky(THREE, shared);
    const tanHalf = shared.uTanHalf || { value: 0.3 };
    // Every drape point is two vertices, one either side of the ribbon.
    const verts = max * (THREAD_SEGMENTS_MAX + 1) * 2;
    for (const band of BANDS) {
      const u = {
        ...sky, uTanHalf: tanHalf,
        uReveal: { value: new Array(SURVEY_THREADS_MAX).fill(0) }, uBright: { value: new Array(SURVEY_THREADS_MAX).fill(0) },
        uFlare: { value: new Array(SURVEY_THREADS_MAX).fill(-10) },
        uColor: { value: new THREE.Color() }, uGain: { value: 1 },
      };
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
      g.setAttribute('aPrev', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
      g.setAttribute('aNext', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
      g.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(verts), 1));
      g.setAttribute('aThread', new THREE.BufferAttribute(new Float32Array(verts * 2), 2));
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(max * THREAD_SEGMENTS_MAX * 6), 1));
      g.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: u,
        vertexShader: THREAD_VERT, fragmentShader: THREAD_FRAG, ...blendFor(THREE) }));
      mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.layers.set(3);
      this.meshes[band] = mesh;
      this.uniformsByBand[band] = u;
    }
  }

  static bytes(max = SURVEY_THREADS_MAX) {
    return BANDS.length * max * ((THREAD_SEGMENTS_MAX + 1) * 2 * (3 + 3 + 3 + 1 + 2) * 4 + THREAD_SEGMENTS_MAX * 6 * 2);
  }

  setThreads(list) {
    const counts = Object.fromEntries(BANDS.map((b) => [b, 0]));
    const used = Object.fromEntries(BANDS.map((b) => [b, 0])); // vertices
    const drawn = Object.fromEntries(BANDS.map((b) => [b, 0])); // indices
    this._bands = list.slice(0, this.max).map((thread) => {
      const band = BANDS.includes(thread.band) ? thread.band : 'far';
      const k = counts[band]++;
      const g = this.meshes[band].geometry, a = g.attributes, index = g.index;
      // Each thread keeps its own drape (castWork sizes it to the mesh).
      const pts = thread.points?.length >= 2 ? thread.points : null;
      const n = pts ? Math.min(THREAD_SEGMENTS_MAX, pts.length - 1) : THREAD_SEGMENTS;
      const at = (j) => pts ? pts[Math.round((Math.max(0, Math.min(n, j)) / n) * (pts.length - 1))]
        : [0, 1, 2].map((c) => thread.a[c] + (thread.b[c] - thread.a[c]) * (Math.max(0, Math.min(n, j)) / n));
      const v0 = used[band];
      for (let j = 0; j <= n; j++) {
        for (const side of [0, 1]) {
          const v = v0 + j * 2 + side;
          a.position.setXYZ(v, ...at(j)); a.aPrev.setXYZ(v, ...at(j - 1)); a.aNext.setXYZ(v, ...at(j + 1));
          a.aSide.setX(v, side ? 1 : -1);
          a.aThread.setXY(v, k, j / n);
        }
        if (j === n) break;
        // Two triangles per segment over its four corners.
        const l0 = v0 + j * 2, i = drawn[band] + j * 6;
        index.setX(i, l0); index.setX(i + 1, l0 + 1); index.setX(i + 2, l0 + 2);
        index.setX(i + 3, l0 + 1); index.setX(i + 4, l0 + 3); index.setX(i + 5, l0 + 2);
      }
      used[band] += (n + 1) * 2;
      drawn[band] += n * 6;
      return { band, k };
    });
    for (const band of BANDS) {
      const g = this.meshes[band].geometry;
      g.setDrawRange(0, drawn[band]);
      for (const attr of Object.values(g.attributes)) attr.needsUpdate = true;
      g.index.needsUpdate = true;
      this.meshes[band].visible = counts[band] > 0;
    }
  }

  setState(k, reveal, bright, flareAt = -10) {
    const slot = this._bands[k];
    if (!slot) return;
    const u = this.uniformsByBand[slot.band];
    u.uReveal.value[slot.k] = reveal;
    u.uBright.value[slot.k] = bright;
    u.uFlare.value[slot.k] = flareAt;
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
    const sky = sharedSky(THREE, shared);
    this._geometries.push(quad);
    ACTOR_IDS.forEach((id, k) => {
      const u = {
        ...sky,
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() }, uAnchor: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
        uMpp: { value: 1 }, uHaloPx: { value: 30 }, uColor: { value: new THREE.Color() },
        uGlow: { value: 0 }, uPresence: { value: 0 }, uWanderPx: { value: 24 },
        uFlyTarget: { value: new THREE.Vector3() }, uFly: { value: 0 },
        // Seen through the fog at the lantern, and at the light it kindles
        // (RangeAtmosphere emitterVisibility, set per frame by the scene).
        uSeen: { value: 1 }, uSeenFly: { value: 1 },
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
        // Each trails at its own height, so each is fogged on its own.
        const cu = { ...u, uCenter: { value: new THREE.Vector3() }, uAnchor: { value: new THREE.Vector3() },
          uMpp: { value: 1 }, uHaloPx: { value: 9 }, uGlow: { value: 0 }, uSeen: { value: 1 } };
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
    this.threads = new SurveyThreads(THREE, { ...shared, uTanHalf: this.sites.uniforms.uTanHalf });
    // An ascent's fixed line: one rope from the landing up to the lights
    // Broshi has fixed, the lights themselves its beads.
    this.rope = new SurveyThreads(THREE, { ...shared, uTanHalf: this.sites.uniforms.uTanHalf }, { max: 1 });
  }

  /** Bytes of the instance buffers (residency accounting). */
  static bytes() { return ACTOR_IDS.length * ACTOR_MOTES * 4 * 4 + 180 + SiteLights.bytes() + SurveyThreads.bytes() + SurveyThreads.bytes(1); }

  dispose() {
    for (const g of Object.values(this.groups)) g.removeFromParent();
    for (const m of this._materials) m.dispose();
    for (const g of this._geometries) g.dispose();
    this.sites.dispose();
    this.threads.dispose();
    this.rope.dispose();
  }
}
