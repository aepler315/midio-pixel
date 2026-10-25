// The terrain's shared musical deformation (land swell, kicks, gestures,
// melodic ripple) and the glacier, as the mesh draws them. Everything that
// stands on the drawn ground reads it: the terrain (SCENE_VERT), the forest
// roots and the cast, so none of them sinks into the land as it swells.
import { LAND_TOUR_FADE_END_M } from './LandMotionLimits.js';
import { GLACIER_GLSL } from './GlacierField.js';

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
  uniform float uTourEnabled;
  uniform vec3 uTourEye;
  float deformField(float h, float along, float across) {
    return h * h * (uDeformAmp * sin(along * uDeformK - uDeformPhase)
      + uDeformKick + uDeformStructural + uDeformMelodic * sin(across * uMelodyK - uMelodyPhase)
      + h * h * uDeformGesture);
  }
  float deformAt(vec3 p) {
    vec2 uv = (p.xz - uGridOrigin) / uGridExtent;
    float receiver = texture(uReceiver, uv * (1.0 - uTexel) + 0.5 * uTexel).r;
    float h = clamp((p.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x), 0.0, 1.0);
    float tourFade = mix(1.0, smoothstep(1500.0, ${LAND_TOUR_FADE_END_M.toFixed(1)}, distance(p, uTourEye)), uTourEnabled);
    return receiver * tourFade * deformField(h, dot(p.xz, uDeformDir), dot(p.xz, uMelodyDir));
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
 *  glacier's ice and the deformation it leaves exposed. */
export const GROUND_LIFT_GLSL = /* glsl */`
  float groundLift(vec3 p) {
    vec3 ice = glacierAt(p);
    return ice.x + deformAt(p) * (1.0 - ice.y);
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
    uTourEnabled: ref('uTourEnabled', () => 0), uTourEye: ref('uTourEye', () => new THREE.Vector3()),
    uGlacierEnabled: ref('uGlacierEnabled', () => 0), uGlacierStart: ref('uGlacierStart', () => new THREE.Vector2()),
    uGlacierEnd: ref('uGlacierEnd', () => new THREE.Vector2(0, -100)), uGlacierWidth: ref('uGlacierWidth', () => 1),
    uGlacierSurface: ref('uGlacierSurface', () => new THREE.Vector2()), uGlacierMaxThickness: ref('uGlacierMaxThickness', () => 0),
    uGlacierRetreat: ref('uGlacierRetreat', () => 0),
  };
}
