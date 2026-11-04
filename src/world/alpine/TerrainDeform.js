// The terrain's shared musical deformation (land swell, kicks, gestures,
// melodic ripple), the glacier and the song-long rise (LandRise.js), as the
// mesh draws them. Everything that stands on the drawn ground reads it: the
// terrain (SCENE_VERT), the forest and the cast, so none of them sinks into
// the land as it swells or floats over it as it rises.
import { LAND_TOUR_FADE_END_M } from './LandMotionLimits.js';
import { GLACIER_GLSL } from './GlacierField.js';
import { LAND_RISE_GLSL } from './LandRise.js';

export const DEFORM_GLSL = /* glsl */`
  ${GLACIER_GLSL}
  uniform vec2 uHeightRange;
  uniform vec2 uGridOrigin;
  uniform vec2 uGridExtent;
  uniform vec2 uTexel;
  uniform sampler2D uReceiver;
  uniform float uDeformAmp;
  uniform float uDeformKick;
  uniform float uDeformGesture;
  uniform float uDeformMelodic;
  uniform float uDeformStructural;
  uniform float uDeformK;
  uniform vec2 uDeformDir;
  uniform float uDeformPhase;
  uniform float uMelodyK;
  uniform vec2 uMelodyDir;
  uniform float uMelodyPhase;
  // xyz: the drawing camera's eye (the mirror keeps the main one); w: 1
  // while a tour fades the music near it. One vector for both, as the
  // terrain fragment shader is at the mobile uniform budget.
  uniform vec4 uTourEye;
  ${LAND_RISE_GLSL}
  // Land dance along the ridge/drainage hierarchy (TerrainHierarchy.js):
  // x spine lift (m), y spine order gate (0..1), z downstream wave (m),
  // w wave phase (rad). All zero: no fetch, the field above is unchanged.
  uniform sampler2D uLandHierarchy;
  uniform vec4 uLandDance;
  float danceField(vec2 uv) {
    if (uLandDance.x == 0.0 && uLandDance.z == 0.0) return 0.0;
    vec2 n = vec2(textureSize(uLandHierarchy, 0));
    vec4 hz = texture(uLandHierarchy, uv * (n - 1.0) / n + 0.5 / n);
    float spine = smoothstep(uLandDance.y - 0.2, uLandDance.y, hz.g);
    vec2 cs = (hz.ba * 255.0 - 127.5) / 127.5;
    float wave = cs.y * cos(uLandDance.w) + cs.x * sin(uLandDance.w);
    return hz.r * (uLandDance.x * spine * (0.35 + 0.65 * hz.r) + uLandDance.z * wave);
  }
  float deformField(float h, float along, float across) {
    return h * h * (uDeformAmp * sin(along * uDeformK - uDeformPhase)
      + uDeformKick + uDeformStructural + uDeformMelodic * sin(across * uMelodyK - uMelodyPhase)
      + h * h * uDeformGesture);
  }
  float deformAt(vec3 p) {
    vec2 uv = (p.xz - uGridOrigin) / uGridExtent;
    float receiver = texture(uReceiver, uv * (1.0 - uTexel) + 0.5 * uTexel).r;
    float h = clamp((p.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x), 0.0, 1.0);
    float tourFade = mix(1.0, smoothstep(1500.0, ${LAND_TOUR_FADE_END_M.toFixed(1)}, distance(p, uTourEye.xyz)), uTourEye.w);
    float base = receiver * tourFade * deformField(h, dot(p.xz, uDeformDir), dot(p.xz, uMelodyDir));
    return base + receiver * tourFade * danceField(uv);
  }
  // Full field derivatives include the receiver shoulder and height lift.
  // The inverse Jacobian carries terrain normals through the same field.
  vec3 deformGrad(vec3 p) {
    float e = 1.0;
    return vec3(deformAt(p + vec3(e, 0.0, 0.0)) - deformAt(p - vec3(e, 0.0, 0.0)),
      deformAt(p + vec3(0.0, e, 0.0)) - deformAt(p - vec3(0.0, e, 0.0)),
      deformAt(p + vec3(0.0, 0.0, e)) - deformAt(p - vec3(0.0, 0.0, e))) / (2.0 * e);
  }
`;

/** Lift of the drawn ground at p, as SCENE_VERT applies it to the mesh: the
 *  glacier's ice and the deformation it leaves exposed (landLift), then the
 *  rise at the lifted point. */
export const GROUND_LIFT_GLSL = /* glsl */`
  float landLift(vec3 p) {
    vec3 ice = glacierAt(p);
    return ice.x + deformAt(p) * (1.0 - ice.y);
  }
  float groundLift(vec3 p) {
    float lift = landLift(p);
    return lift + riseLift(vec3(p.x, p.y + lift, p.z));
  }
`;

/** DEFORM_GLSL's uniforms from `shared` (the terrain's), by reference, with
 *  still stand-ins where it lacks them (no lift). */
export function deformUniforms(THREE, shared = {}) {
  const ref = (key, make) => shared[key] || { value: make() };
  return {
    uHeightRange: ref('uHeightRange', () => new THREE.Vector2(0, 1)), uGridOrigin: ref('uGridOrigin', () => new THREE.Vector2()),
    uGridExtent: ref('uGridExtent', () => new THREE.Vector2(1, 1)), uTexel: ref('uTexel', () => new THREE.Vector2(1, 1)),
    uReceiver: ref('uReceiver', () => null),
    uDeformAmp: ref('uDeformAmp', () => 0), uDeformKick: ref('uDeformKick', () => 0), uDeformGesture: ref('uDeformGesture', () => 0),
    uDeformMelodic: ref('uDeformMelodic', () => 0), uDeformStructural: ref('uDeformStructural', () => 0),
    uDeformK: ref('uDeformK', () => 0), uDeformDir: ref('uDeformDir', () => new THREE.Vector2(1, 0)), uDeformPhase: ref('uDeformPhase', () => 0),
    uMelodyK: ref('uMelodyK', () => 0), uMelodyDir: ref('uMelodyDir', () => new THREE.Vector2(1, 0)), uMelodyPhase: ref('uMelodyPhase', () => 0),
    uLandHierarchy: ref('uLandHierarchy', () => null), uLandDance: ref('uLandDance', () => new THREE.Vector4()),
    uTourEye: ref('uTourEye', () => new THREE.Vector4()), uLandRise: ref('uLandRise', () => 0),
    uGlacierEnabled: ref('uGlacierEnabled', () => 0), uGlacierStart: ref('uGlacierStart', () => new THREE.Vector2()),
    uGlacierEnd: ref('uGlacierEnd', () => new THREE.Vector2(0, -100)), uGlacierWidth: ref('uGlacierWidth', () => 1),
    uGlacierSurface: ref('uGlacierSurface', () => new THREE.Vector2()), uGlacierMaxThickness: ref('uGlacierMaxThickness', () => 0),
    uGlacierRetreat: ref('uGlacierRetreat', () => 0),
  };
}
