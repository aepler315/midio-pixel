// Scalar execution of the production water contour shader. Vector address
// arithmetic is expanded below; branch structure, fetches and cubic math
// come from SCENE_FRAG. This is not a WebGL compiler or GPU benchmark.
import assert from 'node:assert/strict';
import { SCENE_FRAG } from '../../src/world/alpine/TerrainMaterial.js';

function body(name) {
  const start = SCENE_FRAG.indexOf(`float ${name}(`);
  assert.ok(start >= 0, `${name} reaches the production shader`);
  let at = SCENE_FRAG.indexOf('{', start) + 1, end = at, depth = 1;
  while (depth && end < SCENE_FRAG.length) {
    if (SCENE_FRAG[end] === '{') depth++;
    if (SCENE_FRAG[end] === '}') depth--;
    end++;
  }
  return SCENE_FRAG.slice(at, end - 1);
}

const cubic = new Function('a', 'b', 'c', 'd', 't', body('waterCubic'));
const shader = body('waterCoverageAt')
  .replace(/ivec2 size = textureSize\(uSurface, 0\);/, '')
  .replace(/vec2 samplePos = uv \* vec2\(size\) - \.5;/, '')
  .replace(/ivec2 corner = ivec2\(floor\(samplePos\)\);/, 'const corner = [Math.floor(tx), Math.floor(ty)];')
  .replace(/vec2 f = fract\(samplePos\);/, 'const f = [tx - Math.floor(tx), ty - Math.floor(ty)];')
  .replace(/corner \+ ivec2\((-?\d+), (-?\d+)\)/g, '[corner[0] + $1, corner[1] + $2]')
  .replace(/f\.x/g, 'f[0]').replace(/f\.y/g, 'f[1]')
  .replace(/\bfloat (?=\w)/g, 'const ');
const sampleShader = new Function('tx', 'ty', 'size', 'waterWetTexel', 'waterCubic', 'clamp', shader);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function contourCoverage(rgba, width, height, tx, ty) {
  let reads = 0;
  const wet = ([x, y]) => {
    reads++;
    return rgba[(clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4 + 3] === 255 ? 1 : 0;
  };
  return { coverage: sampleShader(tx, ty, [width, height], wet, cubic, clamp), reads };
}

export function contourField(width, height, fill) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba[(y * width + x) * 4 + 3] = fill(x, y);
  return { rgba, width, height };
}
