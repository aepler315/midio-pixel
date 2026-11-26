// Area-average the centre of a world-space material cell over a fragment's
// footprint. A fully resolved cell holds its sampled pigment. Its moving edge
// transfers coverage continuously to the next sample. Once a footprint spans
// a cell the offset is zero, so grazing views keep ordinary texture filtering.
export const TERRAIN_SURFACE_PIXELS_GLSL = /* glsl */`
  vec2 terrainCellOffset(vec2 p, vec2 footprint, float cellM) {
    vec2 f = fract(p / cellM);
    vec2 width = clamp(footprint / cellM, vec2(.0001), vec2(1.));
    vec2 left = max(.5 - f / width, vec2(0.));
    vec2 right = max(.5 - (1. - f) / width, vec2(0.));
    return (.5 - f - left + right) * cellM;
  }

  vec2 terrainPixelOffset(vec2 p, vec2 dx, vec2 dy, float rasterScale) {
    vec2 footprint = abs(dx) + abs(dy);
    // World metres per native pixel. Blend between two fixed physical grids
    // so a pan or change in perspective never drags a grid through the land.
    float area = abs(dx.x * dy.y - dx.y * dy.x);
    float lod = clamp(log2(max(1., 2.4 * rasterScale * sqrt(area))), 0., 6.);
    float cellM = exp2(floor(lod));
    return mix(terrainCellOffset(p, footprint, cellM),
      terrainCellOffset(p, footprint, 2. * cellM), smoothstep(0., 1., fract(lod)));
  }
`;
