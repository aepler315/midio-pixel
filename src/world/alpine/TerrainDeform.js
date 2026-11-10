// The terrain's shared musical deformation (land swell, kicks, gestures,
// melodic ripple), the glacier and the song-long rise (LandRise.js), as the
// mesh draws them. Everything that stands on the drawn ground reads it: the
// terrain (SCENE_VERT) and the forest, so neither sinks into the land as it
// swells or floats over it as it rises.
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
