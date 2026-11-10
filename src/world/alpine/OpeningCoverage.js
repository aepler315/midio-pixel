// Small source/placement geography, independent of render resolution. RG is
// signed distance to rail/tour source edges; BA is the corresponding forest
// instance footprint. It never classifies water or replaces source elevation.
import { terrainHeightAt } from './TerrainMesh.js';
import { forestDistances } from './ForestCover.js';
import { finishPreparation, prepareInSlices } from './PreparationSteps.js';

export const OPENING_COVERAGE_SIDE = 129;
const unit = x => Math.max(0, Math.min(1, x));
const ease = x => { const u = unit(x); return u * u * (3 - 2 * u); };
const smooth = (a, b, x) => ease((x - a) / (b - a));
// Includes CPU/GPU bytes and bounded temporary exposed-edge lists.
export const openingCoverageBytes = data => OPENING_COVERAGE_SIDE ** 2 * 8 + (data?.tiles?.size || 0) * 256;

function boundaries(data, rail) {
  const drawn = t => !!t?.visible && (!rail || t.rail !== false);
  const edges = new Float64Array(data.tiles.size * 16);
  const size = data.cells * data.grid.cellSizeM, origin = data.grid.originM;
  let count = 0;
  const push = (...p) => { edges.set(p, count); count += 4; };
  for (const t of data.tiles.values()) {
    if (!drawn(t)) continue;
    const x = origin[0] + t.ix * size, z = origin[1] + t.iz * size;
    if (!drawn(data.byIndex.get(`${t.ix - 1},${t.iz}`))) push(x, z, x, z + size);
    if (!drawn(data.byIndex.get(`${t.ix + 1},${t.iz}`))) push(x + size, z, x + size, z + size);
    if (!drawn(data.byIndex.get(`${t.ix},${t.iz - 1}`))) push(x, z, x + size, z);
    if (!drawn(data.byIndex.get(`${t.ix},${t.iz + 1}`))) push(x, z + size, x + size, z + size);
  }
  return { edges, count, drawn };
}
function signedDistance(edge, x, z, inside, limit) {
  let d2 = limit * limit;
  for (let i = 0; i < edge.count; i += 4) {
    const a = edge.edges, x0 = a[i], z0 = a[i + 1], dx = a[i + 2] - x0, dz = a[i + 3] - z0;
    const t = unit(((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz));
    d2 = Math.min(d2, (x - x0 - t * dx) ** 2 + (z - z0 - t * dz) ** 2);
  }
  return (inside ? 1 : -1) * Math.sqrt(d2);
}
function* coverageSteps(data, view) {
  const g = data.grid, extentM = [(g.width - 1) * g.cellSizeM, (g.height - 1) * g.cellSizeM];
  const cell = Math.max(...extentM) / (OPENING_COVERAGE_SIDE - 1);
  const width = Math.max(2, Math.round(extentM[0] / cell) + 1), height = Math.max(2, Math.round(extentM[1] / cell) + 1);
  const packed = new Uint8Array(width * height * 4);
  const edges = [boundaries(data, true), boundaries(data, false)], paths = forestDistances(view);
  const fadeM = Math.max(250, cell * 2), tileM = data.cells * g.cellSizeM;
  // A composed stage ships every tile: its grid edge is open lake, not a
  // missing source, so the build overview fades none of it.
  const complete = !!view?.songRange;
  for (let iz = 0; iz < height; iz++) {
    const z = g.originM[1] + extentM[1] * iz / (height - 1);
    for (let ix = 0; ix < width; ix++) {
      const x = g.originM[0] + extentM[0] * ix / (width - 1), y = terrainHeightAt(data, x, z);
      const tile = data.byIndex.get(`${Math.floor((x - g.originM[0]) / tileM)},${Math.floor((z - g.originM[1]) / tileM)}`);
      const o = (iz * width + ix) * 4;
      for (let mode = 0; mode < 2; mode++) {
        const inside = Number.isFinite(y) && edges[mode].drawn(tile);
        packed[o + mode] = complete ? 255 : Math.round(255 * unit(.5 + .5 * signedDistance(edges[mode], x, z, inside, fadeM) / fadeM));
      }
      if (Number.isFinite(y)) {
        const p = [x, y, z], rail = paths.rail(p), tour = paths.footprint ? paths.footprint(p, rail) : rail;
        packed[o + 2] = Math.round(255 * (1 - smooth(6500, 8000, rail)));
        packed[o + 3] = Math.round(255 * (1 - smooth(6500, 8000, tour)));
      }
    }
    yield;
  }
  return { width, height, originM: [...g.originM], extentM, data: packed };
}
export const buildOpeningCoverage = (data, view) => finishPreparation(coverageSteps(data, view));
export const buildOpeningCoverageAsync = (data, view, options = {}) => prepareInSlices(coverageSteps(data, view), options);

export function sampleOpeningCoverage(field, x, z, tour = false) {
  const u = (x - field.originM[0]) / field.extentM[0], v = (z - field.originM[1]) / field.extentM[1];
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return { source: 0, forest: 0 };
  const fx = u * (field.width - 1), fz = v * (field.height - 1);
  const ix = Math.min(field.width - 2, Math.floor(fx)), iz = Math.min(field.height - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const lane = c => {
    const at = (dx, dz) => field.data[((iz + dz) * field.width + ix + dx) * 4 + c] / 255;
    return at(0, 0) * (1 - tx) * (1 - tz) + at(1, 0) * tx * (1 - tz) + at(0, 1) * (1 - tx) * tz + at(1, 1) * tx * tz;
  };
  return { source: smooth(128 / 255, 1, lane(tour ? 1 : 0)), forest: lane(tour ? 3 : 2) };
}
export function forestHandoff(distance, available = 1) {
  const instances = unit(available) * (1 - smooth(6500, 7800, distance));
  return { instances, canopy: 1 - instances };
}
export function createOpeningCoverage(THREE, field) {
  const texture = new THREE.DataTexture(field.data, field.width, field.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
  let disposed = false;
  return { texture, field, bytes: field.data.byteLength * 2, dispose() { if (!disposed) { disposed = true; texture.dispose(); } } };
}

export const OPENING_COVERAGE_GLSL = /* glsl */`
  uniform sampler2D uOpeningCoverage;
  vec4 openingCoverageAt(vec2 uv) {
    vec2 n = vec2(textureSize(uOpeningCoverage, 0));
    // Three's unbound sampler is a one-pixel texture. Standalone/compiled
    // consumers and admitted streaming tours retain their original coverage.
    if (n.x <= 1.0 || n.y <= 1.0) return vec4(1.0);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
    return texture(uOpeningCoverage, uv * (n - 1.0) / n + .5 / n);
  }
  float forestPlacementCoverage(vec2 uv, float tour) {
    vec4 f = openingCoverageAt(uv);
    return mix(f.b, f.a, tour);
  }
  float openingSourceCoverage(vec2 uv, float tour) {
    vec4 f = openingCoverageAt(uv);
    return smoothstep(${(128 / 255).toFixed(9)}, 1.0, mix(f.r, f.g, tour));
  }
  float forestCoverageWeight(vec2 uv, float tour, float rise) {
    vec4 f = openingCoverageAt(uv);
    float source = smoothstep(${(128 / 255).toFixed(9)}, 1.0, mix(f.r, f.g, tour));
    return mix(f.b, f.a, tour) * mix(source, 1.0, smoothstep(.5, .7, rise));
  }
`;
