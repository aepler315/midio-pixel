// Range's scenic copy receives physical camera depth in metres. Each cell
// samples the same integer screen lattice, independent of time and camera
// movement. Broad distance blends connect the nested 1, 2 and 4 pixel grids.
// Alpha remains the original partition coverage; only nearly opaque colour
// on a matching receiver may borrow a coarser sample.
export const PIXEL_DEPTH_GLSL = /* glsl */`
  uniform sampler2D uPixelDepth;
  uniform float uPixelDepthEnabled;
  uniform vec2 uPixelDepthSize;
  uniform vec2 uPixelCameraRange;

  float pixelDepthMetres(float depth) {
    float n = uPixelCameraRange.x, f = uPixelCameraRange.y;
    return (n * f) / (f - depth * (f - n));
  }

  vec3 pixelCellColor(vec4 original, vec2 uv, float metres, float cell) {
    // All grids use the origin texel of each cell, so every 4px sample is
    // also a 2px sample. The half texel selects its unambiguous centre.
    vec2 cellUv = (floor(floor(uv * uPixelDepthSize) / cell) * cell + 0.5) / uPixelDepthSize;
    vec4 coarse = texture(uColor, cellUv);
    float sampledDepth = texture(uPixelDepth, cellUv).r;
    float relativeDepth = abs(pixelDepthMetres(sampledDepth) - metres) / max(metres, 1.0);
    float trust = (1.0 - smoothstep(0.03, 0.08, relativeDepth))
      * smoothstep(0.98, 1.0, min(original.a, coarse.a));
    if (sampledDepth >= 1.0) trust = 0.0;
    // The source is premultiplied. Preserve that relation even at the very
    // small alpha differences allowed by the smooth opacity guard.
    return mix(original.rgb, coarse.rgb * (original.a / max(coarse.a, 0.0001)), trust);
  }

  vec4 pixelDepthColor(vec4 original, vec2 uv) {
    // An exact bypass matters for Original comparisons and unrelated
    // ownership/ground copies. Missing depth never becomes invented depth.
    if (uPixelDepthEnabled < 0.5 || original.a <= 0.98) return original;
    float depth = texture(uPixelDepth, uv).r;
    if (depth >= 1.0) return original;
    float metres = pixelDepthMetres(depth);
    float two = 1.0 - smoothstep(4000.0, 12000.0, metres);
    if (two <= 0.0) return original;
    float four = 1.0 - smoothstep(600.0, 2200.0, metres);
    vec3 color2 = pixelCellColor(original, uv, metres, 2.0);
    vec3 color4 = four > 0.0 ? pixelCellColor(original, uv, metres, 4.0) : color2;
    return vec4(mix(original.rgb, mix(color2, color4, four), two), original.a);
  }
`;
