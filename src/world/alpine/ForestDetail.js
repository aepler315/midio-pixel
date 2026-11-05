import { FOREST_MAX_LEAN } from './ForestWind.js';
import { risenSphere } from './LandRise.js';

// Small crowns keep their authored placements and lighter mesh; only the
// branch complexity changes. A broad, stateless pixel interval reconstructs
// identically after a seek and gives each reflection its own target size.
export function forestDetailWeight(footprintPx) {
  if (!Number.isFinite(footprintPx)) return 1;
  const t = Math.max(0, Math.min(1, (footprintPx - 32) / 32));
  return t * t * (3 - 2 * t);
}

/** Conservative apparent diameter of the largest potentially visible tree
 * in a species/variant batch. No tree is removed or moved by this test.
 * Camera-space spheres include authored crown extent, maximum shared
 * wind/gust/parting lean and a bound on the musical root deformation.
 * `deformation.rise` (riseFromUniforms) moves and grows each sphere to
 * hold what the song's rise draws of it (risenSphere), continuously: it is
 * the unrisen sphere once the range stands complete, so no detail pops. */
export function forestBatchFootprintPx(geometry, camera, width, height, deformation = {}) {
  if (!camera?.isPerspectiveCamera || !(width > 0) || !(height > 0)) return Infinity;
  const p = camera.projectionMatrix.elements, v = camera.matrixWorldInverse.elements;
  const positions = geometry.attributes.iPos, sizes = geometry.attributes.iSize;
  const focalX = Math.abs(p[0]) * width * .5, focalY = Math.abs(p[5]) * height * .5;
  const left = Math.hypot(p[0], p[8] - 1), right = Math.hypot(p[0], p[8] + 1);
  const bottom = Math.hypot(p[5], p[9] - 1), top = Math.hypot(p[5], p[9] + 1);
  let largest = 0;
  const rise = deformation.rise?.sink > 0 ? deformation.rise : null;
  // Only the instances drawn: a view on its rail draws a batch's leading
  // trees (RailDraw.js), and the rest must not size them.
  const drawn = Math.min(positions.count, geometry.instanceCount ?? Infinity);
  for (let i = 0; i < drawn; i++) {
    const x = positions.getX(i), rootY = positions.getY(i), z = positions.getZ(i);
    const h = sizes.getX(i), w = sizes.getY(i);
    const height01 = Math.max(0, Math.min(1, (rootY - (deformation.heightMin ?? 0)) / Math.max(1, deformation.heightSpan ?? 1)));
    const h2 = height01 * height01;
    const rootLift = h2 * ((deformation.amplitudeM || 0) + h2 * (deformation.gestureM || 0));
    let y = rootY + h * .5, radius = Math.hypot(h * .5, w * .75 + h * FOREST_MAX_LEAN) + rootLift;
    if (rise) ({ y, radius } = risenSphere(x, y, z, radius, rise));
    const cx = v[0] * x + v[4] * y + v[8] * z + v[12];
    const cy = v[1] * x + v[5] * y + v[9] * z + v[13];
    const cz = v[2] * x + v[6] * y + v[10] * z + v[14], depth = -cz;
    if (depth + radius < camera.near || depth - radius > camera.far) continue;
    const clipX = p[0] * cx + p[8] * cz, clipY = p[5] * cy + p[9] * cz;
    if (clipX + depth < -radius * left || depth - clipX < -radius * right
      || clipY + depth < -radius * bottom || depth - clipY < -radius * top) continue;
    // The off-axis term bounds perspective growth across the sphere too;
    // using centre distance alone underestimates edge-of-frame crowns.
    const centreDepth = Math.max(camera.near, depth), nearestDepth = Math.max(camera.near, depth - radius);
    const diameterX = 2 * radius * focalX * (1 + Math.abs(cx) / centreDepth) / nearestDepth;
    const diameterY = 2 * radius * focalY * (1 + Math.abs(cy) / centreDepth) / nearestDepth;
    // A clipped bound contributes only its remaining sliver. Without a
    // continuous shoulder, its disappearance would instantly change all
    // the other trees in the same batch even though none of them moved.
    const edge = Math.max(0, Math.min(1,
      (clipX + depth + radius * left) / (radius * left),
      (depth - clipX + radius * right) / (radius * right),
      (clipY + depth + radius * bottom) / (radius * bottom),
      (depth - clipY + radius * top) / (radius * top),
      (depth + radius - camera.near) / radius));
    largest = Math.max(largest, Math.max(diameterX, diameterY) * edge);
  }
  return largest;
}
