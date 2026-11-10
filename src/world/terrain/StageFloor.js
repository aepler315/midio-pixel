// The floor of a song range stage (song range composition): a level lake,
// and land rising from its shore at a constant gradient. It is the only
// invented ground on a stage. Shared by the offline compositor
// (tools/lib/stage-compose.mjs) and the runtime assembler (StageAssembly.js)
// so both evaluate exactly the same function at any point. Pure.
//
// Land height uses the exact Euclidean distance to the lake ellipse, so its
// gradient is exactly the template slope everywhere: land is never level,
// which matters because the baker turns any level patch into water.

/** Whether (x, z) lies in the lake ellipse { centerM, radiiM }. */
export function inStageLake(lake, x, z) {
  const [cx, cz] = lake.centerM, [rx, rz] = lake.radiiM;
  return ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 <= 1;
}

/** Distance from (x, z) to the ellipse { centerM, radiiM }; 0 inside. Exact
 *  to well under a millimetre: bisection on the closest-point parameter. */
export function distanceToLake(lake, x, z) {
  const [cx, cz] = lake.centerM, [a, b] = lake.radiiM;
  const px = Math.abs(x - cx), pz = Math.abs(z - cz);
  if ((px / a) ** 2 + (pz / b) ** 2 <= 1) return 0;
  // Closest point q = (a^2 px / (t + a^2), b^2 pz / (t + b^2)) with
  // f(t) = (a px / (t + a^2))^2 + (b pz / (t + b^2))^2 - 1 = 0, t > 0.
  const a2 = a * a, b2 = b * b;
  let lo = 0, hi = Math.max(a, b) * Math.hypot(px, pz) + Math.max(a2, b2);
  for (let k = 0; k < 80; k++) {
    const t = 0.5 * (lo + hi);
    const f = (a * px / (t + a2)) ** 2 + (b * pz / (t + b2)) ** 2 - 1;
    if (f > 0) lo = t; else hi = t;
  }
  const t = 0.5 * (lo + hi);
  return Math.hypot(px - a2 * px / (t + a2), pz - b2 * pz / (t + b2));
}

/** Floor height at (x, z) for a template { lake: { levelM, centerM, radiiM },
 *  floor: { shoreRiseM, slope } }. */
export function stageFloorHeight(template, x, z) {
  const d = distanceToLake(template.lake, x, z);
  return d === 0 ? template.lake.levelM : template.lake.levelM + template.floor.shoreRiseM + template.floor.slope * d;
}

/** Tile offset [ix, iz] that centres a piece of [w, d] tiles in a slot of
 *  tiles [ix, iz, wide, deep], or null if it does not fit. Shared so offline
 *  composition and runtime assembly place a piece on the same tiles. */
export function slotOrigin(slot, [w, d]) {
  const [ix, iz, sw, sd] = slot.tiles;
  if (w > sw || d > sd) return null;
  return [ix + Math.floor((sw - w) / 2), iz + Math.floor((sd - d) / 2)];
}
