// Numerical reference for the shader's fixed, continuous texture-domain warp.
// It changes material coordinates only, never DEM positions or the surface texture.
const fract = x => x - Math.floor(x);
function hash(x, y) {
  const p = [fract(x * .1031), fract(y * .1031), fract(x * .1031)];
  const d = p.reduce((n, v, i) => n + v * (p[(i + 1) % 3] + 33.33), 0);
  return fract((p[0] + p[1] + 2 * d) * (p[2] + d));
}
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fract(x), fy = fract(y), u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
export function materialDetailPosition(p) {
  const x = p[0] / 600, z = p[2] / 600;
  return [p[0] + (noise(x, z) - .5) * 300, p[1],
    p[2] + (noise(x + 37.2, z - 19.7) - .5) * 300];
}

// The existing two rotated scales still supply fine relief. A slow warp
// shifts their tile phases without cell seams, frame-dependent noise, extra
// texture fetches, or discontinuities in implicit mip derivatives.
export const MATERIAL_DETAIL_DOMAIN_GLSL = /* glsl */`
  vec3 materialDetailPosition(vec3 p) {
    vec2 q = p.xz / 600.0;
    vec2 shift = vec2(vnoise12(q), vnoise12(q + vec2(37.2, -19.7))) - 0.5;
    return p + vec3(shift.x, 0.0, shift.y) * 300.0;
  }
`;
