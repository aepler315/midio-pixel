// Cave geometry from noise: sample a scalar field on a grid, then extract
// the iso-contours (the walls between "rock" and "open air") as closed
// polygons via marching squares. Pure math -- no canvas, no world state --
// so cavern layouts are fully deterministic and unit-testable.
import { valueNoise3 } from '../utils/fields.js';
import { clamp01 } from '../utils/math.js';

/** Solid-rock noise grid for one cave slice, with a forced-solid ring around
 * the border. That ring guarantees every contour we extract is fully
 * enclosed (a boundary edge can never cross the threshold, so a contour can
 * never run off the sampled window) -- every cavern wall is a closed loop,
 * never a stray line exiting the frame. */
export function sampleCaveGrid(cols, rows, originX, seedZ, { noiseScale = 0.08, ringWidth = 1 } = {}) {
  const grid = new Float32Array(cols * rows);
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const onRing = ix < ringWidth || ix >= cols - ringWidth || iy < ringWidth || iy >= rows - ringWidth;
      grid[iy * cols + ix] = onRing ? 1 : valueNoise3((originX + ix) * noiseScale, (iy) * noiseScale, seedZ);
    }
  }
  return grid;
}

/** Extract closed contour polygons (walls between solid/open) from a grid.
 * Returns [{ points: [{x,y}, ...] }] in grid coordinates (fractional --
 * scale by cell size in the caller). Every returned contour is closed. */
export function extractContours(grid, cols, rows, threshold = 0.5) {
  const at = (x, y) => grid[y * cols + x];
  const lerpPoint = (ax, ay, av, bx, by, bv) => {
    const denom = bv - av;
    const t = Math.abs(denom) < 1e-9 ? 0.5 : clamp01((threshold - av) / denom);
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
  };

  // Shared edge-point cache: the same grid edge, approached from either of
  // its two adjacent cells, always resolves to the SAME point object. That
  // makes chaining segments into polygons a matter of object-identity
  // matching afterward -- no epsilon/fuzzy-distance matching required.
  const horzEdge = Array.from({ length: rows }, () => new Array(cols - 1).fill(null));
  const vertEdge = Array.from({ length: rows - 1 }, () => new Array(cols).fill(null));

  const getHorz = (ix, iy) => {
    if (!horzEdge[iy][ix]) horzEdge[iy][ix] = lerpPoint(ix, iy, at(ix, iy), ix + 1, iy, at(ix + 1, iy));
    return horzEdge[iy][ix];
  };
  const getVert = (ix, iy) => {
    if (!vertEdge[iy][ix]) vertEdge[iy][ix] = lerpPoint(ix, iy, at(ix, iy), ix, iy + 1, at(ix, iy + 1));
    return vertEdge[iy][ix];
  };

  const segments = [];
  for (let iy = 0; iy < rows - 1; iy++) {
    for (let ix = 0; ix < cols - 1; ix++) {
      const tl = at(ix, iy), tr = at(ix + 1, iy), br = at(ix + 1, iy + 1), bl = at(ix, iy + 1);
      const c = (tl > threshold ? 8 : 0) | (tr > threshold ? 4 : 0) | (br > threshold ? 2 : 0) | (bl > threshold ? 1 : 0);
      if (c === 0 || c === 15) continue;

      // Edge accessors for this cell: T(op)/R(ight)/B(ottom)/L(eft).
      const T = () => getHorz(ix, iy);
      const R = () => getVert(ix + 1, iy);
      const B = () => getHorz(ix, iy + 1);
      const L = () => getVert(ix, iy);
      const push = (e1, e2) => segments.push([e1(), e2()]);
      const center = (tl + tr + br + bl) / 4;

      switch (c) {
        case 1: push(L, B); break;
        case 2: push(B, R); break;
        case 3: push(L, R); break;
        case 4: push(T, R); break;
        case 5: // ambiguous diagonal (tl+br solid): resolve via center value
          if (center > threshold) { push(T, R); push(L, B); } else { push(L, T); push(B, R); }
          break;
        case 6: push(T, B); break;
        case 7: push(L, T); break;
        case 8: push(T, L); break;
        case 9: push(T, B); break;
        case 10: // ambiguous diagonal (tr+bl solid): resolve via center value
          if (center > threshold) { push(L, T); push(B, R); } else { push(T, R); push(L, B); }
          break;
        case 11: push(T, R); break;
        case 12: push(L, R); break;
        case 13: push(B, R); break;
        case 14: push(L, B); break;
        default: break;
      }
    }
  }

  return traceContours(segments);
}

/** Chain undirected segments (sharing point objects at matching ends) into
 * closed polygon loops. Every point produced by extractContours has degree
 * exactly 2 (each crossing edge is walked by both of its adjacent cells),
 * so this always resolves into simple, non-branching closed cycles. */
function traceContours(segments) {
  const adjacency = new Map();
  const addAdj = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push(b);
  };
  for (const [a, b] of segments) { addAdj(a, b); addAdj(b, a); }

  const visited = new Set();
  const contours = [];
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const points = [start];
    visited.add(start);
    let prev = null;
    let curr = start;
    while (true) {
      const neighbors = adjacency.get(curr);
      const next = neighbors[0] === prev ? neighbors[1] : neighbors[0];
      if (next === undefined || next === start) break;
      points.push(next);
      visited.add(next);
      prev = curr;
      curr = next;
    }
    if (points.length >= 3) contours.push({ points });
  }
  return contours;
}

/** Shoelace area (signed; magnitude is the true area, sign gives winding). */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function polygonCentroid(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

/** Shrink a polygon toward its centroid by `fraction` (0 = unchanged, 1 =
 * collapsed to a point) -- a cheap, good-enough inset for nested "topo map"
 * echo lines on cave walls. Not a true offset polygon (won't stay strictly
 * inside extremely concave shapes), which is fine for a decorative pass. */
export function insetContour(points, fraction) {
  const c = polygonCentroid(points);
  return points.map((p) => ({
    x: c.x + (p.x - c.x) * (1 - fraction),
    y: c.y + (p.y - c.y) * (1 - fraction),
  }));
}
