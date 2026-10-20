// Range lake mirror: the terrain seen from a camera reflected about the
// view's water level, rendered once per frame at reduced size and sampled
// by the water in the terrain shader through a projection matrix (the same
// trick as three's Reflector, without its oblique near plane: fragments
// below the water are clipped in the shaders instead).

/** The mirror image is drawn at this fraction of the partition size. */
export const MIRROR_SCALE = 0.5;
/** Ground within this many metres above the water is clipped from the
 *  mirror image (the shore strip and the water itself). */
export const MIRROR_CLIP_M = 0.5;
/** Water within this many metres of the mirror plane uses it; other lakes
 *  (another level, a river reach) keep the sky reflection. */
export const MIRROR_LEVEL_TOLERANCE_M = 3;
/** Reflections are drawn as if the viewer stood this fraction of its true
 *  height above the water (the reflected ray's elevation, as a tangent, is
 *  scaled by it). From a rail hundreds of metres above a lake a physical
 *  reflection is nearly all sky; a lower eye fills the water with its
 *  shores and the ranges beyond. Applied to the mirror camera and to the
 *  backdrop lookup alike, so both agree on each reflected ray. */
export const MIRROR_LIFT = 0.45;
/** A view mirrors only when this many sampled water samples near its level
 *  stand on tiles visible from the rail. */
export const MIRROR_MIN_SAMPLES = 40;

export function mirrorSize(width, height, scale = MIRROR_SCALE) {
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

/** The level a view's lake mirrors at, or null when no visible water lies
 *  near `levelM` (only rivers, or lakes the rail never sees). Samples every
 *  `stride`th water sample, as waterLevel does. */
export function mirrorLevelFor(data, levelM, { stride = 7 } = {}) {
  if (!Number.isFinite(levelM)) return null;
  let n = 0;
  for (const t of data.tiles.values()) {
    if (!t.visible || !t.flowBytes) continue;
    for (let i = 0; i < t.flowBytes.length; i += stride) {
      if (t.flowBytes[i] === 255 && Math.abs(t.heightsM[i] - levelM) < MIRROR_LEVEL_TOLERANCE_M && ++n >= MIRROR_MIN_SAMPLES) return levelM;
    }
  }
  return null;
}

/**
 * Pose `out` (a PerspectiveCamera) as `camera` reflected about the plane
 * y = levelM: position and forward/up directions mirrored, same projection.
 * The result is a proper camera, so its image of a point X is the real
 * camera's image of X's reflection with x negated; projecting the water
 * point through it (mirrorTextureMatrix) finds the reflected ground.
 * `lift` < 1 moves the mirror eye that fraction of the way toward the
 * plane (see MIRROR_LIFT); the water still projects into the same frame.
 */
export function mirrorCameraFor(THREE, camera, levelM, out, lift = 1) {
  camera.updateMatrixWorld();
  const q = camera.getWorldQuaternion(new THREE.Quaternion());
  const pos = camera.getWorldPosition(new THREE.Vector3());
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  fwd.y = -fwd.y; up.y = -up.y;
  out.position.set(pos.x, levelM - lift * (pos.y - levelM), pos.z);
  out.up.copy(up);
  out.lookAt(out.position.clone().add(fwd));
  out.near = camera.near;
  out.far = camera.far;
  out.projectionMatrix.copy(camera.projectionMatrix);
  // Reflection reverses the camera's horizontal basis. Reflect an off-axis
  // crop too, or one side of the visible lake samples beyond the mirror.
  out.projectionMatrix.elements[8] *= -1;
  out.projectionMatrixInverse.copy(out.projectionMatrix).invert();
  out.updateMatrixWorld();
  out.matrixWorldInverse.copy(out.matrixWorld).invert();
  return out;
}

/** World point -> mirror image uv (in .xy / .w). */
export function mirrorTextureMatrix(THREE, mirrorCamera, out = new THREE.Matrix4()) {
  out.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  out.multiply(mirrorCamera.projectionMatrix);
  out.multiply(mirrorCamera.matrixWorldInverse);
  return out;
}
