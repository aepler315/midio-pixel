// Wireframe rest-pose meshes for the three characters. Each mesh is a flat
// {vertices:[{x,y}], edges:[[i,j],...]} in local space; vertex 0 is always
// the hub (the anchor modal vibration displaces the rim around).
//
// Design language: angular, asymmetric spectral glyphs -- irregular shard
// silhouettes with sparse internal bracing, nothing round, nothing cute.
// The characters are made of the same geometry the world runs on: sharp
// facets that catch the deformation-driven glow, sigils rather than
// mascots. MeshDrawer.js applies per-frame pose transforms and computes
// geometry-driven edge color from these rest shapes.

/** A wheel: one center vertex, n rim vertices, spokes + rim edges. */
export function radialMesh(rx, ry, n, cx = 0, cy = 0, startAngle = 0) {
  const vertices = [{ x: cx, y: cy }];
  const edges = [];
  for (let i = 0; i < n; i++) {
    const ang = startAngle + (i / n) * Math.PI * 2;
    vertices.push({ x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry });
    edges.push([0, i + 1]);
  }
  for (let i = 0; i < n; i++) edges.push([i + 1, ((i + 1) % n) + 1]);
  return { vertices, edges };
}

/**
 * An irregular shard: hub + hand-authored rim, closed by a rim ring,
 * anchored by sparse spokes, with optional cross-braces (rim indices)
 * as internal fracture lines. The irregularity IS the character.
 */
export function shardMesh(hub, rim, { spokeEvery = 2, braces = [] } = {}) {
  const vertices = [{ ...hub }, ...rim.map((v) => ({ ...v }))];
  const edges = [];
  const n = rim.length;
  for (let i = 0; i < n; i++) edges.push([i + 1, ((i + 1) % n) + 1]);
  for (let i = 0; i < n; i += spokeEvery) edges.push([0, i + 1]);
  for (const [a, b] of braces) edges.push([a + 1, b + 1]);
  return { vertices, edges };
}

/** A hexagram (two interlocked triangles) about (cx,cy), plus a single
 *  vertical axis spoke pair -- the trio's shared sigil core. Midasus's own
 *  full-size glyph; Midio and Broshi carry a small one at their eye/socket
 *  in place of the old bare triangle, so all three read as the same kind
 *  of instrument. */
export function hexagramMesh(r, cx = 0, cy = 0) {
  const tri = (offsetDeg) => [0, 1, 2].map((i) => {
    const a = ((offsetDeg + i * 120) * Math.PI) / 180;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  const [a0, a1, a2] = tri(-90);
  const [b0, b1, b2] = tri(90);
  return {
    vertices: [{ x: cx, y: cy }, a0, a1, a2, b0, b1, b2],
    edges: [
      [1, 2], [2, 3], [3, 1], // upward triangle
      [4, 5], [5, 6], [6, 4], // downward triangle
      [0, 1], [0, 4],         // vertical axis
    ],
  };
}

/** Merge several local meshes into one, offsetting edge indices. Returns
 * the merged mesh plus the vertex-index offset each input mesh landed at,
 * so callers can still address "my mesh's vertex 3" after merging. */
export function mergeMeshes(meshes) {
  const vertices = [];
  const edges = [];
  const offsets = [];
  for (const m of meshes) {
    offsets.push(vertices.length);
    for (const v of m.vertices) vertices.push({ x: v.x, y: v.y });
    for (const [i, j] of m.edges) edges.push([i + offsets[offsets.length - 1], j + offsets[offsets.length - 1]]);
  }
  return { mesh: { vertices, edges }, offsets };
}

// --- Small hexagram stars (the loading show's sparks). ---
export const BABY_STAR_R = 3.6;
export const BABY_STAR_MESH = hexagramMesh(BABY_STAR_R);
