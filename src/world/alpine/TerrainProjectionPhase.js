// A directional reference at infinity responds to lens pan and camera
// rotation. A pure translation leaves it stationary at every scene depth.
export function terrainProjectionPhase(camera, reference, width, height, viewport) {
  if (!(width >= 2 && height >= 2 && viewport?.overscanPx >=
    .5 * Math.max(viewport.logicalWidth / width, viewport.logicalHeight / height))) return null;
  const p = camera?.projectionMatrix?.elements, world = camera?.matrixWorld?.elements;
  if (!world || !p || p[11] !== -1 || !(p[0] > 0 && p[5] > 0)) return null;
  const horizontal = Math.hypot(world[8],world[10]);
  if (!(horizontal > .05)) return null; // yaw is singular looking straight up or down
  const yaw = Math.atan2(-world[8],world[10]), pitch = Math.atan2(-world[9],horizontal);
  const target = reference?.targetStartM, eye = reference?.eyeStartM;
  let heading = 0, tilt = 0;
  if (target && eye) {
    const dx = target[0]-eye[0], dz = target[2]-eye[2];
    heading = Math.atan2(dx,-dz);
    tilt = Math.atan2(target[1]-eye[1],Math.hypot(dx,dz));
  }
  // Measure yaw on a circle with an integer number of design cells per
  // turn. atan2 keeps the phase continuous across the back of the view
  // (the two values differ by that integer), at every zoom. Near the
  // authored heading its angular density follows the current lens.
  const turnPixels = Math.round(width), halfAngle = (yaw-heading)/2;
  const scale = Math.PI*p[0]*width/turnPixels;
  const pan = turnPixels/Math.PI * Math.atan2(scale*Math.sin(halfAngle),Math.cos(halfAngle));
  const px = .5*width*(1-p[8]) - pan;
  const py = .5*height*(1+p[9] + p[5]*(pitch-tilt));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { x: (px-Math.round(px))/width, y: (py-Math.round(py))/height };
}

export function applyPartitionPixelOffset(camera, offset) {
  // clip.w = -view.z. Alter the two off-axis perspective coefficients to
  // shift every projected point equally, including existing lens crops.
  // Clip z/w stay intact. Canvas y points down and NDC y points up.
  const projection = camera.projectionMatrix;
  projection.elements[8] += 2 * offset.x;
  projection.elements[9] -= 2 * offset.y;
  camera.projectionMatrixInverse.copy(projection).invert();
}
