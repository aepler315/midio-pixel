// Whether the drawn ground hides a point from an eye: a height march along
// the sight line. Shared by everything that must stand where the rail can
// see it (the cast's paths, the lake samples a view frames).
import { terrainHeightAt } from './TerrainMesh.js';

export const SIGHT_STEPS = 32;

/** Whether ground (with a tree's clearance) leaves `p` visible from `eye`.
 *  The clearance tapers to nothing at the sample itself. */
export function seenFrom(data, eye, p) {
  const len = Math.hypot(p[0] - eye[0], p[2] - eye[2]);
  for (let i = 1; i < SIGHT_STEPS; i++) {
    const t = i / SIGHT_STEPS, x = eye[0] + (p[0] - eye[0]) * t, z = eye[2] + (p[2] - eye[2]) * t;
    const clearance = 25 * Math.min(1, ((1 - t) * len) / 600);
    if (terrainHeightAt(data, x, z) + clearance > eye[1] + (p[1] - eye[1]) * t + 0.5) return false;
  }
  return true;
}
