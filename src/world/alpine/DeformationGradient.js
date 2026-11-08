import { LAND_TOUR_FADE_END_M } from './LandMotionLimits.js';

/** Factored stencil is live by default; explicit reference/invalid values opt out. */
export function deformationGradientMode(search = '') {
  const value = new URLSearchParams(search).get('deformGradient');
  return value == null || value === 'factored' ? 'factored' : 'reference';
}

// The same one-metre central stencil as deformGrad. Only common
// subexpressions move: geography has no y dependence, nor do the two waves.
// No pointwise derivative substitutes for a clamp, fade or texture shoulder.
export const FACTORED_DEFORM_GRAD_GLSL = /* glsl */`
  float deformGradientFade(vec3 p) {
    if (uTourEye.w == 0.0) return 1.0;
    return mix(1.0, smoothstep(1500.0, ${LAND_TOUR_FADE_END_M.toFixed(1)}, distance(p, uTourEye.xyz)), uTourEye.w);
  }
  float deformGradientAt(vec3 p, float h2) {
    vec2 uv = (p.xz - uGridOrigin) / uGridExtent;
    float receiver = texture(uReceiver, uv * (1.0 - uTexel) + 0.5 * uTexel).r;
    float tourFade = deformGradientFade(p);
    float field = h2 * (uDeformAmp * sin(dot(p.xz, uDeformDir) * uDeformK - uDeformPhase)
      + uDeformKick + uDeformStructural + uDeformMelodic * sin(dot(p.xz, uMelodyDir) * uMelodyK - uMelodyPhase)
      + h2 * uDeformGesture);
    float base = receiver * tourFade * field;
    return base + receiver * tourFade * danceField(uv);
  }
  // Scalar form kept separate so its executable GLSL can be checked against
  // deformField at the two original heights, including their clamp edges.
  float deformGradientY(float hPlus, float hMinus, float harmonic, float gesture, float receiver, float dance, float fadePlus, float fadeMinus) {
    float plus2 = hPlus * hPlus;
    float minus2 = hMinus * hMinus;
    float plusField = plus2 * (harmonic + plus2 * gesture);
    float minusField = minus2 * (harmonic + minus2 * gesture);
    float plus = receiver * fadePlus * plusField + receiver * fadePlus * dance;
    float minus = receiver * fadeMinus * minusField + receiver * fadeMinus * dance;
    return (plus - minus) * 0.5;
  }
  vec3 deformGradFactored(vec3 p) {
    float span = max(1.0, uHeightRange.y - uHeightRange.x);
    float h = clamp((p.y - uHeightRange.x) / span, 0.0, 1.0);
    float h2 = h * h;
    float dx = deformGradientAt(p + vec3(1.0, 0.0, 0.0), h2)
      - deformGradientAt(p - vec3(1.0, 0.0, 0.0), h2);
    float dz = deformGradientAt(p + vec3(0.0, 0.0, 1.0), h2)
      - deformGradientAt(p - vec3(0.0, 0.0, 1.0), h2);
    vec2 uv = (p.xz - uGridOrigin) / uGridExtent;
    float receiver = texture(uReceiver, uv * (1.0 - uTexel) + 0.5 * uTexel).r;
    float harmonic = uDeformAmp * sin(dot(p.xz, uDeformDir) * uDeformK - uDeformPhase)
      + uDeformKick + uDeformStructural + uDeformMelodic * sin(dot(p.xz, uMelodyDir) * uMelodyK - uMelodyPhase);
    // Without the tour fade the same hierarchy term cancels from y+/-.
    // Avoid its centre fetch; x/z still sample their original four points.
    float dance = 0.0;
    if (uTourEye.w != 0.0) dance = danceField(uv);
    float hPlus = clamp((p.y + 1.0 - uHeightRange.x) / span, 0.0, 1.0);
    float hMinus = clamp((p.y - 1.0 - uHeightRange.x) / span, 0.0, 1.0);
    float fadePlus = deformGradientFade(p + vec3(0.0, 1.0, 0.0));
    float fadeMinus = deformGradientFade(p - vec3(0.0, 1.0, 0.0));
    float dy = deformGradientY(hPlus, hMinus, harmonic, uDeformGesture, receiver, dance, fadePlus, fadeMinus);
    return vec3(dx * 0.5, dy, dz * 0.5);
  }
`;
