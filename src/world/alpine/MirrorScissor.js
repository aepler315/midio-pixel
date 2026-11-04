// The lake mirror only needs the texels the water samples.
//
// The planar mirror (RangeScene._prepareMirror) renders the whole view again,
// reflected, at twice the scene grid, with the full terrain material. It is
// read in exactly one place: lake fragments (TerrainMaterial, `uMirror`),
// at uMirrorMatrix * vRenderedWorld plus a bounded shiver, through a bilinear
// fetch. Lake fragments only lie on the precomputed water triangles
// (WaterSubset.js). So the mirror can be scissored to where those
// triangles project under the mirror matrix -- with their vertical lift
// (musical deformation, glacier) and the shiver bounded from this frame's
// uniforms -- plus the bilinear footprint. Texels outside are never read,
// so the picture is unchanged.

/** Horizontal size of a water bounding box, metres. */
export const WATER_BOX_M = 384;
/** Mirror texels added around the sampled region: one for the bilinear
 *  footprint, one for rounding. */
export const MIRROR_SCISSOR_MARGIN_PX = 2;
/** Largest |wave| the land dance's decoded cos/sin pair can make. */
export const DANCE_WAVE_BOUND = Math.SQRT2 * 128 / 127.5;
/** Every bound below is multiplied by this before use. */
export const MIRROR_BOUND_SAFETY = 2;

/** Axis-aligned boxes (minX, minY, minZ, maxX, maxY, maxZ per box) holding
 *  every triangle of the index subsets whole, binned on a WATER_BOX_M grid
 *  by each triangle's first vertex. A triangle crossing a cell line grows
 *  its own cell's box over the line: binning vertices alone would leave the
 *  strip between two cells' boxes in neither, and a box the camera culls
 *  could then still own visible water. */
export function waterBoxes(subsets) {
  const cells = new Map();
  for (const sub of subsets) {
    const pos = sub.positions, idx = sub.index;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const f = idx[t] * 3, key = `${Math.floor(pos[f] / WATER_BOX_M)},${Math.floor(pos[f + 2] / WATER_BOX_M)}`;
      let b = cells.get(key);
      if (!b) cells.set(key, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let k = 0; k < 3; k++) {
        const o = idx[t + k] * 3, x = pos[o], y = pos[o + 1], z = pos[o + 2];
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
        if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
      }
    }
  }
  return Float64Array.from([...cells.values()].flat());
}

const abs = v => Math.abs(Number.isFinite(v) ? v : Infinity);

/** Bounds of the vertical lift SCENE_VERT adds to a vertex: the glacier's
 *  ice plus the musical deformation it leaves exposed (TerrainDeform.js,
 *  |deformField| with h, receiver and tour fade all within [0, 1]) and
 *  the land dance (|danceField|: relief and spine within [0, 1], the
 *  decoded wave pair within sqrt(2) * 128 / 127.5). */
export function liftBounds(u) {
  const dance = u.uLandDance?.value;
  const deform = abs(u.uDeformAmp?.value) + abs((u.uDeformKick?.value ?? 0) + (u.uDeformStructural?.value ?? 0))
    + abs(u.uDeformMelodic?.value) + abs(u.uDeformGesture?.value)
    + (dance ? abs(dance.x) + DANCE_WAVE_BOUND * abs(dance.z) : 0);
  const ice = (u.uGlacierEnabled?.value ?? 0) >= 0.5 ? Math.max(0, abs(u.uGlacierMaxThickness?.value)) : 0;
  return { lo: -deform * MIRROR_BOUND_SAFETY - 1, hi: (deform + ice) * MIRROR_BOUND_SAFETY + 1 };
}

/** Bound of |shiver| per texture axis (TerrainMaterial: shiver =
 *  (0.3 * swell.x, swell.y) * shiverGain), from this frame's uniforms. */
export function shiverBounds(u) {
  // paw = max(catsPaw, wake, storm * .75): each term's envelope is <= 1.
  let paw = abs(u.uWakeAmt?.value ?? 0);
  for (const g of u.uWaterGust?.value || []) paw = Math.max(paw, abs(g.y));
  paw = Math.max(paw, abs(u.uStorm?.value?.x ?? 0) * 0.75);
  const music = u.uWaterMusic?.value;
  const gain = abs(u.uMirrorRipple?.value) * 1.6 * (1 + 3 * paw) * (1 + 0.4 * abs(music?.x ?? 0) + 0.35 * abs(music?.y ?? 0));
  // waterSlope: four swells, amplitudes .55 + .35 + .22 + .12; accents .65 each.
  let swell = 1.24;
  for (const a of u.uWaterAccent?.value || []) if (a.y > 0) swell += abs(a.y) * 0.65;
  const s = swell * gain * MIRROR_BOUND_SAFETY;
  return { x: 0.3 * s, y: s };
}

/** True when the main camera cannot see any of the box (all eight corners
 *  outside one clip plane of `vp`, its column-major view-projection). */
function culled(vp, corners) {
  let out = 0b111111;
  for (let c = 0; c < 24 && out; c += 3) {
    const x = corners[c], y = corners[c + 1], z = corners[c + 2];
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14], cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    let o = 0;
    if (cx > cw) o |= 1; if (cx < -cw) o |= 2; if (cy > cw) o |= 4; if (cy < -cw) o |= 8;
    if (cz > cw) o |= 16; if (cz < -cw) o |= 32;
    out &= o;
  }
  return out !== 0;
}

/**
 * The mirror target rectangle { x, y, width, height } (GL pixels, bottom-left
 * origin) holding every texel a lake fragment can read, or null when it
 * cannot be bounded (then the whole target is drawn). `matrix` is the
 * column-major uMirrorMatrix and `viewProj` the main camera's; boxes the
 * main camera cannot see hold no drawn fragment.
 */
export function mirrorScissor(boxes, matrix, viewProj, lift, shiver, width, height) {
  if (![shiver.x, shiver.y].every(Number.isFinite)) return null;
  // The fetch clamps to [0.001, 0.999].
  return projectedRect(boxes, matrix, viewProj, lift, shiver, width, height, t => Math.min(0.999, Math.max(0.001, t)));
}

/** Pixels added around the main view's water rectangle (rounding). */
export const WATER_SCISSOR_MARGIN_PX = 2;

/**
 * The rectangle of a `width` x `height` target (GL pixels, bottom-left
 * origin) holding every fragment the main camera (`viewProj`, column-major)
 * can draw from triangles inside the water boxes, lifted by `lift`; null
 * when that cannot be bounded. The lake layer's own pass draws only those
 * triangles (WaterSubset.js), so it can be scissored to this rectangle.
 */
export function waterScissor(boxes, viewProj, lift, width, height) {
  if (!viewProj) return null;
  // World point -> [0, 1] across the target, as the rasterizer maps NDC.
  const v = viewProj, screen = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    screen[c * 4] = 0.5 * v[c * 4] + 0.5 * v[c * 4 + 3];
    screen[c * 4 + 1] = 0.5 * v[c * 4 + 1] + 0.5 * v[c * 4 + 3];
    screen[c * 4 + 2] = v[c * 4 + 2];
    screen[c * 4 + 3] = v[c * 4 + 3];
  }
  return projectedRect(boxes, screen, viewProj, lift, { x: 0, y: 0 }, width, height, t => t, WATER_SCISSOR_MARGIN_PX);
}

// The pixel rectangle of every box (lifted) projected through `matrix`
// (to [0, 1] uv over w), padded by `pad` in uv and `margin` pixels, with uv
// passed through `clamp` first. Boxes `viewProj` culls hold no fragment.
function projectedRect(boxes, matrix, viewProj, lift, pad, width, height, clamp, margin = MIRROR_SCISSOR_MARGIN_PX) {
  if (!boxes?.length || !(width > 0 && height > 0)) return null;
  if (![lift.lo, lift.hi].every(Number.isFinite)) return null;
  const m = matrix, corners = new Float64Array(24);
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let b = 0; b < boxes.length; b += 6) {
    for (let c = 0; c < 8; c++) {
      corners[c * 3] = boxes[b + (c & 1 ? 3 : 0)];
      corners[c * 3 + 1] = c & 2 ? boxes[b + 4] + lift.hi : boxes[b + 1] + lift.lo;
      corners[c * 3 + 2] = boxes[b + (c & 4 ? 5 : 2)];
    }
    if (viewProj && culled(viewProj, corners)) continue;
    // Over a box the numerators and w are linear, so their corner extremes
    // bound them exactly; u = nu / w then lies within these intervals.
    let nu0 = Infinity, nu1 = -Infinity, nv0 = Infinity, nv1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (let c = 0; c < 24; c += 3) {
      const x = corners[c], y = corners[c + 1], z = corners[c + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const nu = m[0] * x + m[4] * y + m[8] * z + m[12], nv = m[1] * x + m[5] * y + m[9] * z + m[13];
      if (w < w0) w0 = w; if (w > w1) w1 = w;
      if (nu < nu0) nu0 = nu; if (nu > nu1) nu1 = nu; if (nv < nv0) nv0 = nv; if (nv > nv1) nv1 = nv;
    }
    // Points behind the camera (w <= 0) are never drawn and never read it.
    if (!(w1 > 0)) continue;
    if (w0 > 1e-9) {
      for (let c = 0; c < 24; c += 3) {
        const x = corners[c], y = corners[c + 1], z = corners[c + 2];
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        const u = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, v = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
    } else {
      // The box reaches the camera plane: w runs over (0, w1], so each
      // quotient is unbounded on any side its numerator can take.
      u0 = Math.min(u0, nu0 < 0 ? -Infinity : nu0 / w1); u1 = Math.max(u1, nu1 > 0 ? Infinity : nu1 / w1);
      v0 = Math.min(v0, nv0 < 0 ? -Infinity : nv0 / w1); v1 = Math.max(v1, nv1 > 0 ? Infinity : nv1 / w1);
    }
  }
  if (u0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  u0 = clamp(u0 - pad.x); u1 = clamp(u1 + pad.x); v0 = clamp(v0 - pad.y); v1 = clamp(v1 + pad.y);
  const x0 = Math.max(0, Math.floor(u0 * width) - margin), x1 = Math.min(width, Math.ceil(u1 * width) + margin);
  const y0 = Math.max(0, Math.floor(v0 * height) - margin), y1 = Math.min(height, Math.ceil(v1 * height) + margin);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
